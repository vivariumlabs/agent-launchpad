// SPEC-M3D boot wiring: daemon step 12 (Turbo self-top-up; runtime.arweave + runtime.turboTopUp) and the
// Farcaster module (platform.farcaster + runtime.tee ⇒ fcSink + daemon step 13). Legacy single-file layout.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message as FcMessage } from "@farcaster/core";
import { bytesToHex, keccak256, type Address, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootLogger, type BootOverrides, type Runtime, type TimerApi } from "../../src/boot.js";
import type { TurboPayment } from "../../src/attestation/turbo.js";
import { frozenConfigHash } from "../../src/config/schema.js";
import { MockChainClient } from "../../src/exec/chain.js";
import { execute, type CastSink } from "../../src/exec/execute.js";
import { kvSet, listPosts } from "../../src/memory/db.js";
import { transitionAnnouncement } from "../../src/pulse/scheduler.js";
import { buildCastAddData, fcMessageHash } from "../../src/social/fcMessage.js";
import { KV_FC_FID } from "../../src/social/fcOnboard.js";
import type { HubSubmitter } from "../../src/social/hubClient.js";
import { NOW } from "../policy/helpers.js";
import { MockNautilusServer } from "../attestation/mockNautilus.js";
import { MockTurbo } from "../attestation/mockTurbo.js";

const FIXTURE = join(__dirname, "fixtures", "runtime.config.json");

const dirs: string[] = [];
const runtimes: Runtime[] = [];
const servers: MockNautilusServer[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.stop().catch(() => undefined);
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "al-boot3d-"));
  dirs.push(d);
  return d;
}

class FakeTimers implements TimerApi {
  set(): unknown {
    return 1;
  }
  clear(): void {}
}

function logger(): BootLogger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => void lines.push(`I ${m}`), warn: (m) => void lines.push(`W ${m}`), error: (m) => void lines.push(`E ${m}`) };
}

/** Fixture config + platform/runtime extras (legacy single-file layout). */
function config(dir: string, platform: Record<string, unknown>, runtime: Record<string, unknown>): string {
  const j = JSON.parse(readFileSync(FIXTURE, "utf8")) as { platform: Record<string, unknown>; runtime: Record<string, unknown> };
  Object.assign(j.platform, platform);
  Object.assign(j.runtime, runtime);
  const p = join(dir, "m3d.config.json");
  writeFileSync(p, JSON.stringify(j));
  return p;
}

async function bootIt(dir: string, configPath: string, overrides: Partial<BootOverrides> = {}): Promise<Runtime> {
  mkdirSync(join(dir, "data"), { recursive: true });
  const rt = await boot({
    configPath,
    dbPath: join(dir, "data", "agent.db"),
    snapshotDir: join(dir, "snapshots"),
    clock: () => NOW,
    kmsRetry: { attempts: 2, delayMs: 1 },
    overrides: { chain: new MockChainClient({ reads: () => 0n }), timers: new FakeTimers(), logger: logger(), chatPort: 0, ...overrides },
  });
  runtimes.push(rt);
  return rt;
}

/** Records every call; balance above the default watermark ⇒ idle. */
function payment(balance: bigint): TurboPayment & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async balanceWinc() {
      calls.push("balance");
      return balance;
    },
    async paymentAddress(token: string): Promise<Address | null> {
      calls.push(`info:${token}`);
      return null;
    },
    async submitFundTx(token: string, txId: Hex) {
      calls.push(`fund:${token}:${txId}`);
      return { status: 202, body: null };
    },
  };
}

describe("M3D: boot wiring of daemon step 12 (SPEC-M3D §2)", () => {
  it("M3D: runtime.arweave.enabled ⇒ step 12 wired (enabled DEFAULT true); watermark from runtime.turboTopUp", async () => {
    const dir = tmp();
    const p = payment(10n);
    const owner = "0x0000000000000000000000000000000000000001" as Address;
    const rt = await bootIt(dir, config(dir, {}, { arweave: { enabled: true }, turboTopUp: { lowWatermarkWinc: "5" } }), { turboUploader: new MockTurbo(owner), turboPayment: p });
    const r = await rt.daemonTick();
    expect(r.steps.find((s) => s.step === "turboTopUp")).toMatchObject({ status: "skipped" });
    expect(p.calls).toEqual(["balance"]); // 10 ≥ watermark 5 ⇒ idle
  });

  it("M3D: runtime.turboTopUp.enabled=false, arweave disabled, or an uploader without a payment seam ⇒ no step 12", async () => {
    for (const [rtCfg, withPayment] of [
      [{ arweave: { enabled: true }, turboTopUp: { enabled: false } }, true],
      [{ turboTopUp: { enabled: true } }, true],
      [{ arweave: { enabled: true } }, false],
    ] as const) {
      const dir = tmp();
      const p = payment(0n);
      const owner = "0x0000000000000000000000000000000000000001" as Address;
      const rt = await bootIt(dir, config(dir, {}, rtCfg), { turboUploader: new MockTurbo(owner), ...(withPayment ? { turboPayment: p } : {}) });
      const r = await rt.daemonTick();
      expect(r.steps.some((s) => s.step === "turboTopUp")).toBe(false);
      expect(p.calls).toEqual([]);
    }
  });

  it("M3D: runtime.turboTopUp is strict (unknown keys refuse to boot)", async () => {
    const dir = tmp();
    await expect(bootIt(dir, config(dir, {}, { turboTopUp: { amountWie: "1" } }))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SPEC-M3D §3c/§3d — Farcaster module wiring
// ---------------------------------------------------------------------------

const FARCASTER = {
  idGateway: "0x00000000Fc25870C6eD6b6c7E41Fb078b7656f69",
  keyGateway: "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B",
  idRegistry: "0x00000000Fc6c5F01Fc30151999387Bb99A9f489b",
  keyRegistry: "0x00000000fc1237824fb747abde0ff18990e59b7e",
  validator: "0x00000000FC700472606ED4fA22623Acf62c60553",
  hubs: [{ id: "platform-hub", url: "https://hub.example", operator: "platform" }],
};

function recordingHub(): HubSubmitter & { sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  return { sent, submitMessage: async (b) => (sent.push(b), { hubId: "platform-hub", status: 200 }) };
}

/** A tee boot (MockNautilus KMS + attestation, attested init params) with platform.farcaster. */
async function teeBoot(overrides: Partial<BootOverrides>, withFarcaster = true): Promise<Runtime> {
  const s = new MockNautilusServer({ seed: "image-a|agent-1" });
  await s.start();
  servers.push(s);
  const dir = tmp();
  const j = JSON.parse(readFileSync(FIXTURE, "utf8")) as { platform: Record<string, unknown>; agent: unknown; runtime: Record<string, unknown> };
  if (withFarcaster) j.platform.farcaster = FARCASTER;
  delete j.runtime.mockKms;
  Object.assign(j.runtime, { tee: true, kmsUrl: s.baseUrl, attestationUrl: s.attestationUrl, imageId: `0x${"28e981ac".repeat(8)}`, registrationRetrySec: 0 });
  const cfgPath = join(dir, "tee.json");
  writeFileSync(cfgPath, JSON.stringify(j));
  const init = join(dir, "init");
  mkdirSync(init);
  writeFileSync(join(init, "agent-id"), "agent-1");
  writeFileSync(join(init, "config-hash"), frozenConfigHash({ platform: j.platform, agent: j.agent }));
  mkdirSync(join(dir, "data"), { recursive: true });
  const rt = await boot({
    configPath: cfgPath,
    dbPath: join(dir, "data", "agent.db"),
    snapshotDir: join(dir, "snapshots"),
    clock: () => NOW,
    kmsRetry: { attempts: 2, delayMs: 1 },
    initParamsDir: init,
    overrides: { chain: new MockChainClient({ reads: () => 0n }), timers: new FakeTimers(), logger: logger(), chatPort: 0, ...overrides },
  });
  runtimes.push(rt);
  return rt;
}

async function castOnce(rt: Runtime, text: string, fid: bigint) {
  const data = buildCastAddData(text, fid, NOW);
  return execute({ kind: "castPost", contentHash: keccak256(data) }, rt.exec, { messageBytes: data });
}

describe("M3D-fc: boot wiring of the Farcaster module (SPEC-M3D §3c/§3d)", () => {
  it("M3D-fc: platform.farcaster + runtime.tee ⇒ castSink = fcSink (memory mirror first; published only once kv fc.fid exists) and daemon step 13 wired", async () => {
    const hub = recordingHub();
    const rt = await teeBoot({ hubClient: hub });
    await castOnce(rt, "before fid", 7n);
    expect(hub.sent).toHaveLength(0); // no fid ⇒ logged, draft kept locally
    kvSet(rt.db, KV_FC_FID, "7");
    rt.exec.ledger.set({ ...rt.exec.ledger.get(), castPostsToday: 0n });
    const r = await castOnce(rt, "after fid", 7n);
    expect(r.error).toBeUndefined();
    expect(hub.sent).toHaveLength(1);
    expect(listPosts(rt.db)).toHaveLength(2); // mirror rows for both
    const tick = await rt.daemonTick();
    expect(tick.steps.some((st) => st.step === "fcOnboard")).toBe(true);
  });

  it("M3D-fc: tier-announcement cast (rt.announceTierTransition): no fid ⇒ today's UTF-8 bytes, kept locally + logged; kv fc.fid ⇒ CastAdd MessageData, hub-publishable via fcSink", async () => {
    const hub = recordingHub();
    const log = logger();
    const rt = await teeBoot({ hubClient: hub, logger: log });
    const t0 = { from: "Active", to: "Conserving" } as const;
    const c0 = (await rt.announceTierTransition(t0))!.find((x) => x.action.kind === "castPost")!;
    expect(c0.verdict.allow).toBe(true);
    expect(c0.error).toBeUndefined();
    expect(c0.action).toEqual({ kind: "castPost", contentHash: keccak256(new TextEncoder().encode(transitionAnnouncement(t0))) });
    expect(hub.sent).toHaveLength(0);
    expect(log.lines.join("\n")).toMatch(/no fid yet — castPost draft kept locally/);

    kvSet(rt.db, KV_FC_FID, "7");
    rt.exec.ledger.set({ ...rt.exec.ledger.get(), castPostsToday: 0n });
    const t1 = { from: "Conserving", to: "Active" } as const;
    const c1 = (await rt.announceTierTransition(t1))!.find((x) => x.action.kind === "castPost")!;
    const want = buildCastAddData(transitionAnnouncement(t1), 7n, NOW);
    expect(c1.verdict.allow).toBe(true);
    expect(c1.error).toBeUndefined();
    expect(c1.action).toEqual({ kind: "castPost", contentHash: keccak256(want) });
    expect(hub.sent).toHaveLength(1);
    const m = FcMessage.decode(hub.sent[0]!);
    expect(bytesToHex(m.dataBytes!)).toBe(bytesToHex(want));
    expect(bytesToHex(m.hash)).toBe(bytesToHex(fcMessageHash(want)));
    expect(bytesToHex(m.signature) as Hex).toBe(c1.castSignature);
    expect(listPosts(rt.db)).toHaveLength(2); // local mirror rows for both
  });

  it("M3D-fc: overrides.castSink wins over fcSink", async () => {
    const hub = recordingHub();
    const seen: string[] = [];
    const sink: CastSink = { publish: async (a) => void seen.push(a.kind) };
    const rt = await teeBoot({ hubClient: hub, castSink: sink });
    kvSet(rt.db, KV_FC_FID, "7");
    await castOnce(rt, "x", 7n);
    expect(seen).toEqual(["castPost"]);
    expect(hub.sent).toHaveLength(0);
  });

  it("M3D-fc: tee WITHOUT platform.farcaster ⇒ module disabled (memoryCastSink, no step 13)", async () => {
    const hub = recordingHub();
    const rt = await teeBoot({ hubClient: hub }, false);
    kvSet(rt.db, KV_FC_FID, "7");
    await castOnce(rt, "x", 7n);
    expect(hub.sent).toHaveLength(0);
    expect(listPosts(rt.db)).toHaveLength(1);
    expect((await rt.daemonTick()).steps.some((st) => st.step === "fcOnboard")).toBe(false);
  });

  it("M3D-fc: platform.farcaster WITHOUT runtime.tee ⇒ module disabled (memoryCastSink, no step 13)", async () => {
    const dir = tmp();
    const hub = recordingHub();
    const rt = await bootIt(dir, config(dir, { farcaster: FARCASTER }, {}), { hubClient: hub });
    kvSet(rt.db, KV_FC_FID, "7");
    await castOnce(rt, "x", 7n);
    expect(hub.sent).toHaveLength(0);
    expect(listPosts(rt.db)).toHaveLength(1);
    expect((await rt.daemonTick()).steps.some((st) => st.step === "fcOnboard")).toBe(false);
  });

  it("M3D-fc: platform.farcaster requires ≥ 1 hub (frozen schema)", async () => {
    const dir = tmp();
    await expect(bootIt(dir, config(dir, { farcaster: { ...FARCASTER, hubs: [] } }, {}))).rejects.toThrow();
  });
});
