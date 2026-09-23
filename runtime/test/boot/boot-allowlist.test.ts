// SPEC-M3B §4 boot wiring (signed allowlist updates: kv re-apply before the first pulse, daemon step 11,
// single cfg swap across engine / keyring K3 / EndpointManager, opt-out) and the boot auto-registration
// (tee + cfg.registration ⇒ registry.isRegistered → registerInstance through the normal deps).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, type Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { boot, ensureRegistered, type BootLogger, type BootOverrides, type Runtime, type TimerApi } from "../../src/boot.js";
import { frozenConfigHash } from "../../src/config/schema.js";
import { agentRegistryAbi } from "../../src/exec/abi.js";
import { MockChainClient, type ReadContractRequest } from "../../src/exec/chain.js";
import { CANARY_SYSTEM } from "../../src/llm/canaries.js";
import { adoptedVersion, KV_ALLOWLIST_ADOPTED, KV_ALLOWLIST_VERSION } from "../../src/llm/allowlistUpdate.js";
import { MockLlm, MockX402Transport } from "../../src/llm/mock.js";
import type { LlmRequest } from "../../src/llm/types.js";
import { kvGet, kvSet, listActions } from "../../src/memory/db.js";
import { evaluate } from "../../src/policy/engine.js";
import type { ProposedAction } from "../../src/policy/types.js";
import { MockNautilusServer } from "../attestation/mockNautilus.js";
import { DAY, mkLedger, mkState, NOW } from "../policy/helpers.js";
import { canaryAnswer } from "../pulse/harness.js";
import { PLATFORM_ALLOWLIST_SIGNER, rawEntry, rawPayload, ROGUE_KEY, ScriptedAllowlistSource, signedDoc } from "../llm/allowlistSigning.js";

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
  const d = mkdtempSync(join(tmpdir(), "al-bootal-"));
  dirs.push(d);
  return d;
}

class FakeTimers implements TimerApi {
  pending = new Map<number, { fn: () => void; ms: number }>();
  private n = 0;
  set(fn: () => void, ms: number): unknown {
    this.pending.set(++this.n, { fn, ms });
    return this.n;
  }
  clear(h: unknown): void {
    this.pending.delete(h as number);
  }
}

interface CaptureLogger extends BootLogger {
  infos: string[];
  warns: string[];
  errors: string[];
}
function capture(): CaptureLogger {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  return { infos, warns, errors, info: (m) => infos.push(m), warn: (m) => warns.push(m), error: (m) => errors.push(m) };
}

interface ConfigOpts {
  platform?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
}
/** Fixture (legacy single file) + extras. Returns the path and the frozen hash of its { platform, agent }. */
function config(dir: string, o: ConfigOpts = {}): { path: string; frozenHash: string } {
  const j = JSON.parse(readFileSync(FIXTURE, "utf8")) as { platform: Record<string, unknown>; agent: Record<string, unknown>; runtime: Record<string, unknown> };
  Object.assign(j.platform, o.platform ?? {});
  Object.assign(j.agent, o.agent ?? {});
  Object.assign(j.runtime, o.runtime ?? {});
  const path = join(dir, "al.config.json");
  writeFileSync(path, JSON.stringify(j));
  return { path, frozenHash: frozenConfigHash({ platform: j.platform, agent: j.agent }) };
}

/** Opted-in allowlist config (signer frozen in platform; adopt flag absent ⇒ DEFAULT true). */
function allowlistConfig(dir: string, o: ConfigOpts = {}): string {
  return config(dir, { ...o, platform: { allowlistUpdateSigner: PLATFORM_ALLOWLIST_SIGNER, ...(o.platform ?? {}) } }).path;
}

// New entries whose models match the fixture agent's refs (primary m-main, fallback m-alt).
const NEW_1 = rawEntry("new-1", "op-one", { model: "m-main", payTo: "0xee00000a00000000000000000000000000000000" });
const NEW_2 = rawEntry("new-2", "op-two", { model: "m-alt", payTo: "0xee00000b00000000000000000000000000000000" });
const NEW_3 = rawEntry("new-3", "op-three", { model: "m-other", payTo: "0xee00000c00000000000000000000000000000000" });
const V1 = () => rawPayload(1, Number(NOW - DAY), [NEW_1, NEW_2, NEW_3]);

interface Env {
  rt: Runtime;
  chain: MockChainClient;
  x402: MockX402Transport;
  log: CaptureLogger;
  setNow(t: bigint): void;
}

async function bootAl(
  dir: string,
  configPath: string,
  o: { source?: ScriptedAllowlistSource; chain?: MockChainClient; overrides?: Partial<BootOverrides>; initParamsDir?: string; now?: bigint } = {},
): Promise<Env> {
  let now = o.now ?? NOW;
  const chain = o.chain ?? new MockChainClient({ reads: () => 0n });
  const x402 = new MockX402Transport(
    [NEW_1, NEW_2, NEW_3].map((e) => ({ id: e["id"] as string, payTo: e["payTo"] as Address, price: 1_000_000n })),
  );
  const llm = new MockLlm((req: LlmRequest) => (req.system === CANARY_SYSTEM ? canaryAnswer(req) : JSON.stringify({ diary: "(idle)" })));
  const log = capture();
  mkdirSync(join(dir, "data"), { recursive: true });
  const rt = await boot({
    configPath,
    dbPath: join(dir, "data", "agent.db"),
    snapshotDir: join(dir, "snapshots"),
    clock: () => now,
    kmsRetry: { attempts: 2, delayMs: 1 },
    ...(o.initParamsDir !== undefined ? { initParamsDir: o.initParamsDir } : {}),
    overrides: {
      chain,
      llm,
      x402,
      state: async () => mkState(),
      timers: new FakeTimers(),
      logger: log,
      ...(o.source !== undefined ? { allowlistSource: o.source } : {}),
      ...(o.overrides ?? {}),
    },
  });
  runtimes.push(rt);
  return { rt, chain, x402, log, setNow: (t) => (now = t) };
}

const inf = (endpointId: string): ProposedAction => ({ kind: "inference", category: "pulse", endpointId, maxCostUsd: 100_000n });

// ---------------------------------------------------------------------------

describe("boot: signed allowlist updates (SPEC-M3B §4)", () => {
  it("daemon step 11 adopts a signed update; the swap is effective on the NEXT call everywhere (engine I2, EndpointManager, keyring K3) and is journaled", async () => {
    const dir = tmp();
    const source = new ScriptedAllowlistSource().push(await signedDoc(V1()));
    const e = await bootAl(dir, allowlistConfig(dir), { source });
    const { rt } = e;
    const genesisCfg = rt.cfg;
    expect(rt.endpoints.candidates().map((x) => x.id)).toEqual(["ep-a", "ep-b"]);
    expect(evaluate(inf("new-1"), mkState(), mkLedger(), rt.exec.cfg, NOW)).toMatchObject({ allow: false, code: "ENDPOINT" });
    expect(evaluate(inf("ep-a"), mkState(), mkLedger(), rt.exec.cfg, NOW).allow).toBe(true);

    const report = await rt.daemonTick();
    const step = report.steps.at(-1)!;
    expect(step).toMatchObject({ step: "allowlistUpdate", status: "ran" });
    expect(source.calls).toBe(1);

    // single cfg swap: runtime view, logged exec view, same object
    expect(rt.cfg).not.toBe(genesisCfg);
    expect(rt.exec.cfg).toBe(rt.cfg);
    expect(rt.cfg.x402Allowlist.map((x) => x.id)).toEqual(["new-1", "new-2", "new-3"]);
    expect(rt.cfg.treasury).toBe(genesisCfg.treasury);
    expect(rt.cfg.maxPerCallUsd).toBe(genesisCfg.maxPerCallUsd);
    // I2 next call, both directions
    expect(evaluate(inf("new-1"), mkState(), mkLedger(), rt.exec.cfg, NOW).allow).toBe(true);
    expect(evaluate(inf("ep-a"), mkState(), mkLedger(), rt.exec.cfg, NOW)).toMatchObject({ allow: false, code: "ENDPOINT" });
    // EndpointManager reloaded
    expect(rt.endpoints.candidates().map((x) => x.id)).toEqual(["new-1", "new-2"]);
    // persona-visible: journal draft through execute (J1), logged
    const journal = listActions(rt.db).filter((r) => r.kind === "journalWrite");
    expect(journal).toHaveLength(1);
    expect(journal[0]!.verdict).toBe("allow");
    expect(report.actions.some((a) => a.action.kind === "journalWrite" && a.journalRef !== undefined)).toBe(true);
    expect(adoptedVersion(rt.db)).toBe(1);

    // the next pulse pays the NEW endpoint: selection (reloaded manager) → engine I2 → keyring K3 (payTo from the adopted list)
    e.setNow(NOW + 120n);
    const cycle = await rt.pulse();
    expect(cycle.result.attempts[0]).toMatchObject({ endpointId: "new-1", outcome: "ok" });
    const paid = e.x402.paid.filter((p) => p.endpointId === "new-1");
    expect(paid.length).toBeGreaterThan(0);
    expect(paid[0]!.auth.authorization.to.toLowerCase()).toBe((NEW_1["payTo"] as string).toLowerCase());
    expect(e.x402.quotes).not.toContain("ep-a");
  });

  it("restart: the adopted list is re-applied from kv BEFORE the first pulse (no fetch at boot)", async () => {
    const dir = tmp();
    const cfgPath = allowlistConfig(dir);
    const source = new ScriptedAllowlistSource().push(await signedDoc(V1()));
    const e1 = await bootAl(dir, cfgPath, { source });
    await e1.rt.daemonTick();
    await e1.rt.stop();

    const source2 = new ScriptedAllowlistSource();
    const e2 = await bootAl(dir, cfgPath, { source: source2 });
    expect(source2.calls).toBe(0);
    expect(e2.rt.cfg.x402Allowlist.map((x) => x.id)).toEqual(["new-1", "new-2", "new-3"]);
    expect(e2.rt.exec.cfg).toBe(e2.rt.cfg);
    expect(e2.rt.endpoints.candidates().map((x) => x.id)).toEqual(["new-1", "new-2"]);
    expect(e2.log.infos.join("\n")).toMatch(/re-applied adopted signed allowlist v1/);
    // first pulse already on the adopted list (K3 accepts the adopted payTo)
    const cycle = await e2.rt.pulse();
    expect(cycle.result.attempts[0]).toMatchObject({ endpointId: "new-1", outcome: "ok" });
  });

  it("04§4-SEC: a stored list tampered at rest is not re-applied at boot (genesis list, loud error)", async () => {
    const dir = tmp();
    const cfgPath = allowlistConfig(dir);
    const e1 = await bootAl(dir, cfgPath, { source: new ScriptedAllowlistSource().push(await signedDoc(V1())) });
    await e1.rt.daemonTick();
    const stored = JSON.parse(kvGet(e1.rt.db, KV_ALLOWLIST_ADOPTED)!) as { payload: { entries: Array<Record<string, unknown>> } };
    stored.payload.entries[0]!["payTo"] = "0x000000000000000000000000000000000000dead";
    kvSet(e1.rt.db, KV_ALLOWLIST_ADOPTED, JSON.stringify(stored));
    await e1.rt.stop();

    const e2 = await bootAl(dir, cfgPath, { source: new ScriptedAllowlistSource() });
    expect(e2.rt.cfg.x402Allowlist.map((x) => x.id)).toEqual(["ep-a", "ep-b"]);
    expect(e2.log.errors.join("\n")).toMatch(/FAILED re-verification/);
  });

  it("04§4-SEC: a wrong-signer update is reported as a step error; nothing changes; checked once per interval", async () => {
    const dir = tmp();
    const source = new ScriptedAllowlistSource().push(await signedDoc(V1(), ROGUE_KEY));
    const e = await bootAl(dir, allowlistConfig(dir), { source });
    const before = e.rt.cfg;
    const r = await e.rt.daemonTick();
    expect(r.steps.at(-1)).toMatchObject({ step: "allowlistUpdate", status: "error" });
    expect(e.rt.cfg).toBe(before);
    expect(kvGet(e.rt.db, KV_ALLOWLIST_VERSION)).toBeUndefined();
    e.setNow(NOW + 6n * 3600n);
    expect((await e.rt.daemonTick()).steps.at(-1)).toMatchObject({ step: "allowlistUpdate", status: "skipped" });
    expect(source.calls).toBe(1);
  });

  it("04§4-SEC: adoption journal goes through the normal J1 caps (cap exhausted ⇒ journal denied PACE_CAP, adoption still stands)", async () => {
    const dir = tmp();
    const source = new ScriptedAllowlistSource().push(await signedDoc(V1()));
    const e = await bootAl(dir, allowlistConfig(dir, { platform: { caps: { journalDailyCap: 0 } } }), { source });
    await e.rt.daemonTick();
    const j = listActions(e.rt.db).filter((r) => r.kind === "journalWrite");
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ verdict: "deny", denyCode: "PACE_CAP" });
    expect(e.rt.cfg.x402Allowlist.map((x) => x.id)).toEqual(["new-1", "new-2", "new-3"]);
  });

  it("opted out at genesis (frozen adoptAllowlistUpdates=false): never fetches, no step 11, a stored list is ignored", async () => {
    const dir = tmp();
    const source = new ScriptedAllowlistSource();
    source.fallback = await signedDoc(V1());
    const cfgPath = allowlistConfig(dir, { agent: { adoptAllowlistUpdates: false }, runtime: { allowlistUpdateUrl: "https://platform.example/allowlist.json" } });
    const e = await bootAl(dir, cfgPath, { source });
    expect(e.log.infos.join("\n")).toMatch(/opted out at genesis/);
    for (let i = 0; i < 3; i++) {
      e.setNow(NOW + BigInt(i) * DAY);
      expect((await e.rt.daemonTick()).steps.map((s) => s.step)).not.toContain("allowlistUpdate");
    }
    expect(source.calls).toBe(0);
    // plant a validly-signed "adopted" list: an opted-out agent still ignores it at boot
    kvSet(e.rt.db, KV_ALLOWLIST_ADOPTED, await signedDoc(V1()));
    kvSet(e.rt.db, KV_ALLOWLIST_VERSION, "1");
    await e.rt.stop();
    const e2 = await bootAl(dir, cfgPath, { source });
    expect(e2.rt.cfg.x402Allowlist.map((x) => x.id)).toEqual(["ep-a", "ep-b"]);
    expect(source.calls).toBe(0);
  });

  it("opted in but no frozen signer, or no update URL ⇒ no step 11 (logged); DEFAULT fixture unchanged", async () => {
    const d1 = tmp();
    const noSigner = await bootAl(d1, config(d1, { runtime: { allowlistUpdateUrl: "https://platform.example/allowlist.json" } }).path);
    expect(noSigner.log.warns.join("\n")).toMatch(/no frozen platform.allowlistUpdateSigner/);
    expect((await noSigner.rt.daemonTick()).steps.map((s) => s.step)).not.toContain("allowlistUpdate");
    const d2 = tmp();
    const noUrl = await bootAl(d2, allowlistConfig(d2));
    expect(noUrl.log.infos.join("\n")).toMatch(/allowlistUpdateUrl unset/);
    expect((await noUrl.rt.daemonTick()).steps.map((s) => s.step)).not.toContain("allowlistUpdate");
  });

  it("runtime.allowlistUpdateUrl wires the real fetcher (https only)", async () => {
    const d = tmp();
    await expect(bootAl(d, allowlistConfig(d, { runtime: { allowlistUpdateUrl: "http://platform.example/allowlist.json" } }))).rejects.toThrow(/non-https/);
    const d2 = tmp();
    const ok = await bootAl(d2, allowlistConfig(d2, { runtime: { allowlistUpdateUrl: "https://platform.example/allowlist.json", allowlistUpdateIntervalSec: 3600 } }));
    expect(ok.log.infos.join("\n")).toMatch(/allowlist updates: checking every 3600s/);
  });
});

// ---------------------------------------------------------------------------

describe("boot auto-registration (tee + cfg.registration)", () => {
  const IMAGE_ID = `0x${"28e981ac".repeat(8)}`;

  async function nautilus(): Promise<MockNautilusServer> {
    const s = new MockNautilusServer({ seed: "image-a|agent-1" });
    await s.start();
    servers.push(s);
    return s;
  }

  const WINDOW = 7n * DAY;
  interface Inst {
    treasuryEOA: Address;
    actionEOA: Address;
    codeHash: `0x${string}`;
    attestationRef: string;
    lastHeartbeat: bigint;
    generation: number;
  }
  const ZERO_INST: Inst = { treasuryEOA: "0x0000000000000000000000000000000000000000", actionEOA: "0x0000000000000000000000000000000000000000", codeHash: `0x${"00".repeat(32)}`, attestationRef: "", lastHeartbeat: 0n, generation: 0 };

  /**
   * A registry stand-in faithful to AgentRegistry.registerInstance (sol:79-106): instanceOf returns the
   * record; a mined registerInstance at `blockTime` applies genesis (generation 1) or revival (stale &
   * same keys ⇒ generation++, new attestationRef) semantics — or is REVERTED like the contract would.
   */
  function registryChain(opts: { inst?: Inst; readThrows?: boolean; windowThrows?: boolean; blockTime?: bigint } = {}): MockChainClient & { inst: () => Inst; reads: string[] } {
    let inst: Inst = opts.inst ?? { ...ZERO_INST };
    const reads: string[] = [];
    let chain!: MockChainClient;
    let applied = 0;
    const sync = (): void => {
      for (const t of chain.sent.slice(applied)) {
        applied++;
        if (t.outcome !== "success") continue;
        let d;
        try {
          d = decodeFunctionData({ abi: agentRegistryAbi, data: t.data });
        } catch {
          continue;
        }
        if (d.functionName !== "registerInstance") continue;
        const [, treasuryEOA, actionEOA, codeHash, attestationRef] = d.args as readonly [bigint, Address, Address, `0x${string}`, string];
        const ts = opts.blockTime ?? NOW;
        if (inst.lastHeartbeat === 0n) inst = { treasuryEOA, actionEOA, codeHash, attestationRef, lastHeartbeat: ts, generation: 1 };
        else if (ts - inst.lastHeartbeat > WINDOW && inst.treasuryEOA === treasuryEOA && inst.actionEOA === actionEOA && inst.codeHash === codeHash) {
          inst = { ...inst, attestationRef, lastHeartbeat: ts, generation: inst.generation + 1 };
        } else throw new Error("test registry: this registerInstance would REVERT on-chain");
      }
    };
    const respond = (_c: string, req: ReadContractRequest): unknown => {
      reads.push(req.functionName);
      sync();
      if (req.functionName === "instanceOf") {
        if (opts.readThrows === true) throw new Error("rpc down");
        return { ...inst };
      }
      if (req.functionName === "REVIVAL_WINDOW") {
        if (opts.windowThrows === true) throw new Error("window rpc down");
        return WINDOW;
      }
      if (req.functionName === "isRegistered") return inst.lastHeartbeat !== 0n;
      return 0n;
    };
    chain = new MockChainClient({ reads: respond as never });
    return Object.assign(chain, {
      inst: () => {
        sync();
        return inst;
      },
      reads,
    });
  }
  async function teeBoot(dir: string, chain: MockChainClient): Promise<Env> {
    const s = await nautilus();
    const { path, frozenHash } = config(dir, { runtime: { mockKms: undefined, tee: true, kmsUrl: s.baseUrl, attestationUrl: s.attestationUrl, imageId: IMAGE_ID } });
    const j = JSON.parse(readFileSync(path, "utf8")) as { runtime: Record<string, unknown> };
    delete j.runtime["mockKms"];
    writeFileSync(path, JSON.stringify(j));
    const init = join(dir, "init-params");
    mkdirSync(init, { recursive: true });
    writeFileSync(join(init, "agent-id"), "agent-1");
    writeFileSync(join(init, "config-hash"), frozenHash);
    return bootAl(dir, path, { chain, initParamsDir: init });
  }

  function registerTxs(chain: MockChainClient): Array<{ args: readonly unknown[] }> {
    const out: Array<{ args: readonly unknown[] }> = [];
    for (const t of chain.sent) {
      try {
        const d = decodeFunctionData({ abi: agentRegistryAbi, data: t.data });
        if (d.functionName === "registerInstance") out.push({ args: d.args ?? [] });
      } catch {
        // not a registry call
      }
    }
    return out;
  }

  it("tee boot auto-registers exactly once through the normal deps (engine T1 + K2); a second boot skips", async () => {
    const dir = tmp();
    const chain = registryChain();
    const e1 = await teeBoot(dir, chain);
    const regs = registerTxs(chain);
    expect(regs).toHaveLength(1);
    const own = e1.rt.keyring.addresses();
    expect(regs[0]!.args).toEqual([1n, own.treasury, own.action, IMAGE_ID, e1.rt.attestationRef]);
    expect(chain.sent[0]!.to?.toLowerCase()).toBe(e1.rt.cfg.registry.rh.toLowerCase());
    expect(chain.sent[0]!.from).toBe(own.treasury);
    const rows = listActions(e1.rt.db).filter((r) => r.kind === "registerInstance");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe("allow");
    expect(e1.log.infos.join("\n")).toMatch(/registerInstance sent for agent 1/);
    await e1.rt.stop();

    expect(chain.inst()).toMatchObject({ treasuryEOA: own.treasury, generation: 1, lastHeartbeat: NOW });

    const e2 = await teeBoot(dir, chain); // same registry: now registered, heartbeat fresh (0 s ago)
    expect(registerTxs(chain)).toHaveLength(1);
    expect(e2.log.infos.join("\n")).toMatch(/already registered \(generation 1, heartbeat 0s ago ≤ revival window 604800s\) — skipping registerInstance/);
  });

  it("REVIVAL: registered but heartbeat stale > REVIVAL_WINDOW (read from the contract) ⇒ registerInstance with the NEW attestationRef; the registry bumps generation", async () => {
    const dir = tmp();
    // a previous generation of THIS agent (same KMS ⇒ same keys; same image ⇒ same codeHash), last heartbeat 7 d + 1 s ago
    const probe = await nautilus();
    const { createKeyring } = await import("../../src/keyring/keyring.js");
    const { NautilusKms } = await import("../../src/keyring/nautilusKms.js");
    const own = (await createKeyring(new NautilusKms(probe.baseUrl), { retry: { attempts: 1, delayMs: 1 } })).addresses();
    const chain = registryChain({
      inst: { treasuryEOA: own.treasury, actionEOA: own.action, codeHash: IMAGE_ID as `0x${string}`, attestationRef: "old-generation-ref", lastHeartbeat: NOW - WINDOW - 1n, generation: 3 },
    });
    const e = await teeBoot(dir, chain);
    const regs = registerTxs(chain);
    expect(regs).toHaveLength(1);
    // calldata: same pinned keys + codeHash (MismatchedRevivalKeys otherwise), THIS boot's attestationRef
    expect(regs[0]!.args).toEqual([1n, own.treasury, own.action, IMAGE_ID, e.rt.attestationRef]);
    expect(e.rt.attestationRef).not.toBe("old-generation-ref");
    expect(chain.reads).toEqual(expect.arrayContaining(["instanceOf", "REVIVAL_WINDOW"]));
    // registry semantics: generation 3 → 4, attestationRef replaced, heartbeat refreshed
    expect(chain.inst()).toMatchObject({ generation: 4, attestationRef: e.rt.attestationRef, lastHeartbeat: NOW });
    expect(e.log.infos.join("\n")).toMatch(/heartbeat stale \(604801s > revival window 604800s\) — REVIVING \(generation 3 → 4\)/);
    expect(e.log.infos.join("\n")).toMatch(/registerInstance sent for agent 1 \(revival\)/);
    expect(listActions(e.rt.db).filter((r) => r.kind === "registerInstance")).toHaveLength(1);
  });

  it("fresh heartbeat (exactly AT the window edge — the contract requires strictly greater) ⇒ skip, nothing sent", async () => {
    const dir = tmp();
    const probe = await nautilus();
    const { createKeyring } = await import("../../src/keyring/keyring.js");
    const { NautilusKms } = await import("../../src/keyring/nautilusKms.js");
    const own = (await createKeyring(new NautilusKms(probe.baseUrl), { retry: { attempts: 1, delayMs: 1 } })).addresses();
    const chain = registryChain({
      inst: { treasuryEOA: own.treasury, actionEOA: own.action, codeHash: IMAGE_ID as `0x${string}`, attestationRef: "live-ref", lastHeartbeat: NOW - WINDOW, generation: 2 },
    });
    const e = await teeBoot(dir, chain);
    expect(chain.sent).toHaveLength(0);
    expect(chain.inst()).toMatchObject({ generation: 2, attestationRef: "live-ref" });
    expect(e.log.infos.join("\n")).toMatch(/already registered \(generation 2, heartbeat 604800s ago ≤ revival window 604800s\)/);
  });

  it("stale record pinned to DIFFERENT keys/codeHash ⇒ loud warning, nothing sent (would revert MismatchedRevivalKeys)", async () => {
    const dir = tmp();
    const chain = registryChain({
      inst: { treasuryEOA: "0x00000000000000000000000000000000000000aa", actionEOA: "0x00000000000000000000000000000000000000bb", codeHash: `0x${"11".repeat(32)}`, attestationRef: "x", lastHeartbeat: NOW - 30n * DAY, generation: 1 },
    });
    const e = await teeBoot(dir, chain);
    expect(chain.sent).toHaveLength(0);
    expect(e.log.warns.join("\n")).toMatch(/registered to a DIFFERENT instance .* NOT sending/);
  });

  it("REVIVAL_WINDOW read failure on a registered agent ⇒ readFailed, nothing sent", async () => {
    const dir = tmp();
    const chain = registryChain({ inst: { ...ZERO_INST, lastHeartbeat: NOW - 30n * DAY, generation: 1 }, windowThrows: true });
    const e = await teeBoot(dir, chain);
    expect(chain.sent).toHaveLength(0);
    expect(e.log.warns.join("\n")).toMatch(/REVIVAL_WINDOW read FAILED \(window rpc down\)/);
  });

  it("send failure ⇒ boot CONTINUES with a loud warning (heartbeats keep failing visibly)", async () => {
    const dir = tmp();
    const chain = registryChain();
    chain.script(new Error("nonce too low"));
    const e = await teeBoot(dir, chain);
    expect(registerTxs(chain)).toHaveLength(1);
    expect(e.log.warns.join("\n")).toMatch(/!!! registration: registerInstance FAILED for agent 1 \(.*nonce too low.*\) — boot continues UNREGISTERED/);
    await e.rt.start(); // boot not bricked
    expect(listActions(e.rt.db).find((r) => r.kind === "registerInstance")?.error).toMatch(/nonce too low/);
  });

  it("reverted registerInstance ⇒ warning, boot continues", async () => {
    const dir = tmp();
    const chain = registryChain();
    chain.script("reverted");
    const e = await teeBoot(dir, chain);
    expect(e.log.warns.join("\n")).toMatch(/registerInstance FAILED/);
  });

  it("isRegistered read failure ⇒ loud warning, NOTHING sent (no blind registration), boot continues", async () => {
    const dir = tmp();
    const chain = registryChain({ readThrows: true });
    const e = await teeBoot(dir, chain);
    expect(chain.sent).toHaveLength(0);
    expect(e.log.warns.join("\n")).toMatch(/instanceOf\(1\) \/ REVIVAL_WINDOW read FAILED \(rpc down\)/);
  });

  it("tee:false is untouched: no registry read, no registerInstance", async () => {
    const dir = tmp();
    const reads: string[] = [];
    const chain = new MockChainClient({ reads: (_c, req) => (reads.push(req.functionName), 0n) });
    await bootAl(dir, config(dir).path, { chain });
    expect(reads).not.toContain("isRegistered");
    expect(reads).not.toContain("instanceOf");
    expect(chain.sent).toHaveLength(0);
  });

  it("ensureRegistered: a malformed instanceOf read (or a non-positive REVIVAL_WINDOW) is a read failure", async () => {
    const reg = { registry: { rh: "0xf100000100000000000000000000000000000001" } } as never;
    for (const reads of [
      () => 1n,
      () => ({ ...ZERO_INST, lastHeartbeat: 5 }),
      (_c: string, r: ReadContractRequest) => (r.functionName === "instanceOf" ? { ...ZERO_INST, lastHeartbeat: 5n } : 0n),
    ]) {
      const log = capture();
      const chain = new MockChainClient({ reads: reads as never });
      expect(await ensureRegistered(reg, 1, chain, {} as never, log, NOW)).toBe("readFailed");
      expect(chain.sent).toHaveLength(0);
    }
  });
});
