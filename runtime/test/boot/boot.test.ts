// SPEC-M2C §3 — composition-root tests. boot() from the fixture config file with
// MockLlm / MockX402Transport / MockChainClient injected via opts.overrides; everything
// else (keyring, memory, ExecDeps, schedulers, tier wiring) is the real boot wiring.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import {
  boot,
  checkInitParamAgentId,
  checkInitParamConfigHash,
  ConfigHashMismatchError,
  InitParamAgentIdMismatchError,
  InitParamConfigHashMismatchError,
  UnboundTeeBootError,
  KV_PULSE_NEXT_AT,
  tierAnnounceKey,
  type BootLogger,
  type BootOverrides,
  type Runtime,
  type TimerApi,
} from "../../src/boot.js";
import { mkdirSync } from "node:fs";
import { SETTLE_TX, x402Server } from "../llm/x402Server.js";
import type { BalanceReader, Holdings } from "../../src/chat/gate.js";
import { configHash, frozenConfigHash, loadSplitConfig, resolveConfig } from "../../src/config/schema.js";
import { frozenHashOfFile, parseArgs, printConfigHashTarget } from "../../src/main.js";
import { MockChainClient, type ReadContractRequest } from "../../src/exec/chain.js";
import { createKeyring } from "../../src/keyring/keyring.js";
import { MockKms } from "../../src/keyring/mockKms.js";
import { CANARY_SYSTEM } from "../../src/llm/canaries.js";
import { MockLlm, MockX402Transport } from "../../src/llm/mock.js";
import type { LlmRequest } from "../../src/llm/types.js";
import { kvGet, listActions, listPosts, openMemory } from "../../src/memory/db.js";
import { LocalDirSink, restoreLatest, writeSnapshot } from "../../src/memory/snapshot.js";
import type { Chain } from "../../src/policy/types.js";
import { transitionAnnouncement } from "../../src/pulse/scheduler.js";
import { dumpAllTables, populateAllTables } from "../memory/fixtures.js";
import { CP, E6, NOW } from "../policy/helpers.js";
import { canaryAnswer } from "../pulse/harness.js";
import { buildTx } from "../../src/exec/build.js";
import { execute } from "../../src/exec/execute.js";
import { NonLocalUrlError } from "../../src/keyring/nautilusKms.js";
import { MockNautilusServer } from "../attestation/mockNautilus.js";

const FIXTURE = join(__dirname, "fixtures", "runtime.config.json");
const FIXTURE_JSON = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  platform: { usdg: Record<Chain, Address>; usdc: Record<Chain, Address>; agentTokenAddress: Address; x402Allowlist: Array<{ id: string; payTo: Address }> };
  runtime: { mockKms: { imageId: string; agentId: string } };
};
const P = FIXTURE_JSON.platform;
/** SPEC-M3 §3b split fixtures: agent.json = the legacy fixture's { platform, agent }; runtime.json = its runtime section. */
const FIXTURE_AGENT = join(__dirname, "fixtures", "agent.json");
const FIXTURE_RUNTIME = join(__dirname, "fixtures", "runtime.json");
/** GOLDEN frozenHash of the fixture's { platform, agent } — changes iff the frozen fixture content changes. */
const FROZEN_HASH = "0xef1aaffb0642dae2e269f0137e0b711b7adb74f294b29e7110c8abb8acfb9895" as Hex;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

class FakeTimers implements TimerApi {
  private seq = 0;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { fn, ms });
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Fires everything currently pending (not timers armed by the callbacks). */
  fireAll(): void {
    const now = [...this.pending.entries()];
    for (const [id, t] of now) {
      this.pending.delete(id);
      t.fn();
    }
  }
}

const quiet: BootLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface Balances {
  treasury: { arbUsdc: bigint; baseUsdc: bigint; rhUsdg: bigint };
  action: { rhUsdg: bigint };
}

function healthyBalances(): Balances {
  return { treasury: { arbUsdc: 200n * E6, baseUsdc: 50n * E6, rhUsdg: 10_000n * E6 }, action: { rhUsdg: 1_000n * E6 } };
}

interface Env {
  rt: Runtime;
  dir: string;
  dbPath: string;
  snapDir: string;
  chain: MockChainClient;
  llm: MockLlm;
  x402: MockX402Transport;
  timers: FakeTimers;
  bal: Balances;
  pulseScript: string[];
  setNow(t: bigint): void;
  advance(s: bigint): void;
}

const dirs: string[] = [];
const runtimes: Runtime[] = [];

afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "al-boot-"));
  dirs.push(d);
  return d;
}

interface BootEnvOpts {
  dir?: string;
  expectedHash?: string;
  bal?: Balances;
  configPath?: string;
  /** SPEC-M3 §3b split layout: configPath = agent.json, this = runtime.json. */
  runtimeConfigPath?: string;
  /** BootOptions.initParamsDir (the only way to relocate init params under runtime.tee). */
  initParamsDir?: string;
  chatReaders?: readonly [BalanceReader, BalanceReader];
  /** Extra boot overrides (merged last). */
  overrides?: Partial<BootOverrides>;
}

async function bootEnv(opts: BootEnvOpts = {}): Promise<Env> {
  const dir = opts.dir ?? tmp();
  const dbPath = join(dir, "memory.sqlite");
  const snapDir = join(dir, "snapshots");
  const bal = opts.bal ?? healthyBalances();
  let now = NOW;
  let own: { treasury: Address; action: Address } | undefined;

  const reads = (chain: Chain, req: ReadContractRequest): unknown => {
    if (req.functionName === "balanceOf") {
      const owner = String(req.args?.[0]).toLowerCase();
      const token = req.address.toLowerCase();
      if (own === undefined) throw new Error("reads before boot");
      const isT = owner === own.treasury.toLowerCase();
      const isA = owner === own.action.toLowerCase();
      if (isT && chain === "arbitrum" && token === P.usdc.arbitrum.toLowerCase()) return bal.treasury.arbUsdc;
      if (isT && chain === "base" && token === P.usdc.base.toLowerCase()) return bal.treasury.baseUsdc;
      if (isT && chain === "rh" && token === P.usdg.rh.toLowerCase()) return bal.treasury.rhUsdg;
      if (isA && chain === "rh" && token === P.usdg.rh.toLowerCase()) return bal.action.rhUsdg;
      return 0n;
    }
    if (req.functionName === "pendingFees" || req.functionName === "quoteAgentToUsdg") return 0n;
    throw new Error(`unexpected read ${req.functionName}`);
  };
  const chain = new MockChainClient({ reads });
  const pulseScript: string[] = [];
  const llm = new MockLlm((req: LlmRequest) => {
    if (req.system === CANARY_SYSTEM) return canaryAnswer(req);
    return pulseScript.shift() ?? JSON.stringify({ diary: "(idle)" });
  });
  const x402 = new MockX402Transport(
    P.x402Allowlist.map((e) => ({ id: e.id, payTo: e.payTo, price: e.id === "ep-a" ? 2_000_000n : 1_000_000n })),
  );
  const timers = new FakeTimers();
  const bootOpts = {
    configPath: opts.configPath ?? FIXTURE,
    ...(opts.runtimeConfigPath !== undefined ? { runtimeConfigPath: opts.runtimeConfigPath } : {}),
    ...(opts.initParamsDir !== undefined ? { initParamsDir: opts.initParamsDir } : {}),
    dbPath,
    snapshotDir: snapDir,
    clock: () => now,
    kmsRetry: { attempts: 2, delayMs: 1 },
    overrides: {
      chain,
      llm,
      x402,
      timers,
      logger: quiet,
      chatPort: 0,
      ...(opts.chatReaders !== undefined ? { chatReaders: opts.chatReaders } : {}),
      ...(opts.overrides ?? {}),
    },
    ...(opts.expectedHash !== undefined ? { expectedHash: opts.expectedHash } : {}),
  };
  const rt = await boot(bootOpts);
  runtimes.push(rt);
  own = rt.keyring.addresses();
  return {
    rt,
    dir,
    dbPath,
    snapDir,
    chain,
    llm,
    x402,
    timers,
    bal,
    pulseScript,
    setNow: (t) => (now = t),
    advance: (s) => (now += s),
  };
}

async function fixtureMemKey() {
  const kr = await createKeyring(new MockKms(FIXTURE_JSON.runtime.mockKms.imageId, FIXTURE_JSON.runtime.mockKms.agentId), {
    retry: { attempts: 2, delayMs: 1 },
  });
  return kr.memKeyForMemoryModule();
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("boot: full wiring from the fixture config", () => {
  it("manual daemon tick + pulse run end-to-end through the boot-wired deps and land rows in actions", async () => {
    const e = await bootEnv();
    const { rt } = e;
    expect(rt.cfg.treasury).toBe(rt.keyring.addresses().treasury);
    expect(rt.restoredFrom).toBeNull();

    // daemon tick (no LLM): rental + allowance + heartbeat + snapshot + tier init
    const report = await rt.daemonTick();
    expect(report.tier).toBe("Active");
    expect(rt.tier()).toBe("Active");
    const afterTick = listActions(rt.db);
    const hb = afterTick.find((r) => r.kind === "heartbeat");
    expect(hb?.verdict).toBe("allow");
    expect(hb?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(afterTick.length).toBe(report.actions.length);
    expect(report.snapshotId).toBeDefined();
    expect(readdirSync(e.snapDir).length).toBe(1);

    // pulse: canaries + one scripted response (a capped transfer ⇒ deny row, a post ⇒ castPost)
    e.advance(60n); // distinct issuedAt from the daemon heartbeat (K1 single-use)
    e.pulseScript.push(
      JSON.stringify({
        diary: "booted",
        toolCalls: [
          { tool: "wallet.transfer", args: { asset: "USDG", to: CP, amount: (900n * E6).toString() } },
          { tool: "social.post", args: { text: "gm from a freshly booted agent" } },
        ],
      }),
    );
    const cycle = await rt.pulse();
    expect(cycle.result.status).toBe("completed");
    expect(cycle.result.errors).toEqual([]);
    expect(cycle.nextPulseAt).toBe(NOW + 60n + 1_800n);
    const rows = listActions(rt.db).slice(afterTick.length);
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain("inference");
    expect(kinds).toContain("castPost");
    expect(kinds).toContain("heartbeat");
    const deny = rows.find((r) => r.kind === "actionTransfer");
    expect(deny?.verdict).toBe("deny");
    expect(deny?.denyCode).toBe("PER_TX_CAP");
    // every ExecResult logged exactly once (no double logging through memoryExecDeps)
    const engineRows = rows.filter((r) => r.verdict === "allow" || r.verdict === "deny");
    expect(engineRows).toHaveLength(cycle.result.results.length);
    expect(listPosts(rt.db).map((p) => p.content)).toContain("gm from a freshly booted agent");
    expect(e.x402.paid.length).toBeGreaterThan(0);
    expect(e.llm.calls.some((c) => c.system !== CANARY_SYSTEM)).toBe(true);
    // ledger persisted (saveLedger-backed store): the latest row reflects today's inference spend
    expect(rt.exec.ledger.get().inferenceSpent.pulse).toBeGreaterThan(0n);
    // one mutable signing path: every tx from our two EOAs
    const own = rt.keyring.addresses();
    for (const t of e.chain.sent) expect([own.treasury.toLowerCase(), own.action.toLowerCase()]).toContain(t.from.toLowerCase());
  });

  it("start() arms both loops; firing the timers runs daemon + pulse; stop() disarms, writes a FINAL snapshot and closes the db", async () => {
    const e = await bootEnv();
    const { rt, timers } = e;
    await rt.start();
    expect(timers.pending.size).toBe(2);
    expect([...timers.pending.values()].every((t) => t.ms === 0)).toBe(true); // both due now on first boot

    timers.fireAll();
    await rt.idle();
    await new Promise((r) => setTimeout(r, 0)); // loops re-arm after their iteration settles
    const rows = listActions(rt.db);
    expect(rows.filter((r) => r.kind === "heartbeat").length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.kind === "inference")).toBe(true);
    // re-armed: daemon at +6h, pulse at +30m
    const delays = [...timers.pending.values()].map((t) => t.ms).sort((a, b) => a - b);
    expect(delays).toEqual([1_800_000, 21_600_000]);
    expect(kvGet(rt.db, KV_PULSE_NEXT_AT)).toBe((NOW + 1_800n).toString());

    const before = readdirSync(e.snapDir).length; // daemon step-8 snapshot
    e.advance(120n);
    await rt.stop();
    expect(timers.pending.size).toBe(0);
    expect(rt.db.open).toBe(false);
    const files = readdirSync(e.snapDir);
    expect(files.length).toBe(before + 1);
    expect(files).toContain(`snapshot-${NOW + 120n}.bin`);

    // the final snapshot restores to a db holding everything the run wrote
    const restored = await restoreLatest([new LocalDirSink(e.snapDir)], await fixtureMemKey());
    expect(restored?.meta.id).toBe(`snapshot-${NOW + 120n}.bin`);
    expect(listActions(restored!.db)).toHaveLength(rows.length);
    restored!.db.close();
    await expect(rt.daemonTick()).rejects.toThrow(/stopped/);
  });
});

describe("boot: config hash (03 §10 refuse-to-boot)", () => {
  it("expectedHash mismatch ⇒ throws before anything else boots", async () => {
    const wrong = `0x${"00".repeat(32)}`;
    const dir = tmp();
    await expect(bootEnv({ dir, expectedHash: wrong })).rejects.toBeInstanceOf(ConfigHashMismatchError);
    expect(existsSync(join(dir, "memory.sqlite"))).toBe(false); // memory never opened
  });

  it("matching expectedHash (any hex case) boots and exposes the hash", async () => {
    const h = configHash(JSON.parse(readFileSync(FIXTURE, "utf8")));
    const e = await bootEnv({ expectedHash: h.toUpperCase().replace("0X", "0x") });
    expect(e.rt.configHash).toBe(h);
  });

  it("a one-byte config change changes the hash", () => {
    const j = JSON.parse(readFileSync(FIXTURE, "utf8")) as { agent: { persona: string } };
    const h1 = configHash(j);
    j.agent.persona += ".";
    expect(configHash(j)).not.toBe(h1);
  });
});

describe("boot: memory open-or-restore (03 §7)", () => {
  it("corrupt db + snapshot ⇒ corrupt file moved aside, latest snapshot restored", async () => {
    const dir = tmp();
    const dbPath = join(dir, "memory.sqlite");
    const snapDir = join(dir, "snapshots");
    const db = openMemory(dbPath);
    populateAllTables(db);
    const original = dumpAllTables(db);
    await writeSnapshot(db, await fixtureMemKey(), new LocalDirSink(snapDir), NOW - 3_600n, 1);
    const snapDump = dumpAllTables(db); // incl. kv lastSnapshotId (written after serialize)
    db.close();
    writeFileSync(dbPath, Buffer.from("this is definitely not a sqlite database file".repeat(100)));

    const e = await bootEnv({ dir });
    expect(e.rt.restoredFrom).toBe(`snapshot-${NOW - 3_600n}.bin`);
    const restored = dumpAllTables(e.rt.db);
    expect(restored.actions).toEqual(original.actions);
    expect(restored.budgetLedgerJson).toEqual(original.budgetLedgerJson);
    expect({ ...restored, kv: [] }).toEqual({ ...snapDump, kv: [] });
    expect(readdirSync(dir).some((f) => f.startsWith("memory.sqlite.corrupt-"))).toBe(true);
    // the restored db is a real file-backed db at dbPath
    await e.rt.stop();
    const reopened = openMemory(dbPath);
    expect(dumpAllTables(reopened).actions).toEqual(original.actions);
    reopened.close();
  });

  it("missing db + snapshot ⇒ restored", async () => {
    const dir = tmp();
    const db = openMemory(":memory:");
    populateAllTables(db);
    await writeSnapshot(db, await fixtureMemKey(), new LocalDirSink(join(dir, "snapshots")), NOW - 60n, 1);
    const original = dumpAllTables(db);
    db.close();
    const e = await bootEnv({ dir });
    expect(e.rt.restoredFrom).not.toBeNull();
    expect(dumpAllTables(e.rt.db).trades).toEqual(original.trades);
  });

  it("corrupt db and NO snapshot ⇒ refuses to boot (no silent empty ledger)", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "memory.sqlite"), Buffer.from("garbage".repeat(1000)));
    await expect(bootEnv({ dir })).rejects.toThrow(/corrupt and no snapshot/);
  });

  it("existing healthy db is reused as-is (ledger loaded from it)", async () => {
    const dir = tmp();
    const e1 = await bootEnv({ dir });
    await e1.rt.daemonTick();
    const n = listActions(e1.rt.db).length;
    const allowanceAt = e1.rt.exec.ledger.get().lastAllowanceAt;
    await e1.rt.stop();
    const e2 = await bootEnv({ dir });
    expect(e2.rt.restoredFrom).toBeNull();
    expect(listActions(e2.rt.db)).toHaveLength(n);
    expect(allowanceAt).toBeGreaterThan(0n);
    expect(e2.rt.exec.ledger.get().lastAllowanceAt).toBe(allowanceAt);
  });
});

describe("boot: tier-transition announcements fire once per transition (not per detector)", () => {
  const announced = (rt: Runtime) => listPosts(rt.db).filter((p) => p.content === transitionAnnouncement({ from: "Active", to: "Conserving" }));
  const daemonAnnounced = (rt: Runtime) => listPosts(rt.db).filter((p) => p.content.startsWith("Runway update: moving from Active to Conserving"));

  /** Runway = 10 paid days (fixture hosting) + 0 funded ⇒ Conserving. */
  function drain(b: Balances): void {
    b.treasury.arbUsdc = 0n;
    b.treasury.rhUsdg = 0n;
  }

  it("pulse detects first ⇒ pulse announces (journal + cast); the daemon then sees no transition", async () => {
    const e = await bootEnv();
    await e.rt.daemonTick();
    expect(e.rt.tier()).toBe("Active");
    drain(e.bal);
    e.advance(60n);
    const c = await e.rt.pulse();
    expect(c.transition).toEqual({ from: "Active", to: "Conserving" });
    expect(c.announcement?.map((r) => r.action.kind)).toEqual(["journalWrite", "castPost"]);
    expect(c.announcement?.every((r) => r.verdict.allow)).toBe(true);
    e.advance(60n);
    const t = await e.rt.daemonTick();
    expect(t.tier).toBe("Conserving");
    expect(announced(e.rt)).toHaveLength(1);
    expect(daemonAnnounced(e.rt)).toHaveLength(0);
    expect(kvGet(e.rt.db, tierAnnounceKey({ from: "Active", to: "Conserving" }, NOW))).toBe("pulse");
  });

  it("daemon detects first ⇒ daemon announces; the pulse then sees no transition", async () => {
    const e = await bootEnv();
    await e.rt.daemonTick();
    drain(e.bal);
    e.advance(60n);
    const t = await e.rt.daemonTick();
    expect(t.tierAfter).toBe("Conserving");
    e.advance(60n);
    const c = await e.rt.pulse();
    expect(c.transition).toBeNull();
    expect(c.announcement).toBeNull();
    expect(daemonAnnounced(e.rt)).toHaveLength(1);
    expect(announced(e.rt)).toHaveLength(0);
    expect(kvGet(e.rt.db, tierAnnounceKey({ from: "Active", to: "Conserving" }, NOW))).toBe("daemon");
  });

  it("same (from,to) on the same UTC day is announced once; next day it may announce again", async () => {
    const e = await bootEnv();
    const tr = { from: "Active", to: "Conserving" } as const;
    const first = await e.rt.announceTierTransition(tr);
    expect(first).not.toBeNull();
    expect(await e.rt.announceTierTransition(tr)).toBeNull();
    expect(announced(e.rt)).toHaveLength(1);
    e.advance(86_400n);
    expect(await e.rt.announceTierTransition(tr)).not.toBeNull();
    expect(announced(e.rt)).toHaveLength(2);
  });
});

describe("boot: chat server wiring (SPEC-M2C §1 via the composition root)", () => {
  function chatConfig(dir: string, extra: Record<string, unknown>): string {
    const j = JSON.parse(readFileSync(FIXTURE, "utf8")) as { platform: Record<string, unknown> };
    Object.assign(j.platform, extra);
    const p = join(dir, "chat.config.json");
    writeFileSync(p, JSON.stringify(j));
    return p;
  }
  const holder: BalanceReader = {
    holdings: async (): Promise<Holdings> => ({ agentBal: 10n, agentSupply: 1_000n, platformBal: 0n, platformSupply: 1n }),
  };

  it("no cfg.chatDomain ⇒ chat disabled", async () => {
    const e = await bootEnv();
    expect(e.rt.chat).toBeNull();
  });

  it("chatDomain ⇒ start() listens, /health answers with the shared tier, stop() closes the socket", async () => {
    const dir = tmp();
    const e = await bootEnv({ dir, configPath: chatConfig(dir, { chatDomain: "agent.test" }), chatReaders: [holder, holder] });
    expect(e.rt.chat).not.toBeNull();
    await e.rt.daemonTick(); // tier store = Active
    await e.rt.start();
    const addr = e.rt.chatAddress();
    expect(addr).not.toBeNull();
    const res = await fetch(`http://127.0.0.1:${addr!.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tier: "Active" });
    const nonce = await e.rt.chat!.handle({ method: "GET", path: "/nonce", headers: {} });
    expect(nonce.status).toBe(200);
    await e.rt.stop();
    expect(e.rt.chatAddress()).toBeNull();
    await expect(fetch(`http://127.0.0.1:${addr!.port}/health`)).rejects.toThrow();
  });

  it("chatDomain without chatRpc and no injected readers ⇒ refuses to boot (gate cannot fail closed)", async () => {
    const dir = tmp();
    await expect(bootEnv({ dir, configPath: chatConfig(dir, { chatDomain: "agent.test" }) })).rejects.toThrow(/chatRpc/);
  });
});

describe("boot: runtime.tee (SPEC-M3 §2) — NautilusKms + attestation → cfg.registration", () => {
  const IMAGE_ID = `0x${"28e981ac".repeat(8)}` as Hex;
  const REGISTRY = parseAbi([
    "function registerInstance(uint256 agentId, address treasuryEOA, address actionEOA, bytes32 codeHash, string attestationRef)",
  ]);
  const servers: MockNautilusServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });
  async function nautilus(opts: ConstructorParameters<typeof MockNautilusServer>[0] = {}): Promise<MockNautilusServer> {
    const s = new MockNautilusServer(opts);
    await s.start();
    servers.push(s);
    return s;
  }
  function teeConfig(dir: string, runtime: Record<string, unknown>): string {
    const j = JSON.parse(readFileSync(FIXTURE, "utf8")) as { runtime: Record<string, unknown> };
    delete j.runtime.mockKms;
    Object.assign(j.runtime, runtime);
    const p = join(dir, "tee.config.json");
    writeFileSync(p, JSON.stringify(j));
    return p;
  }

  it("tee:true ⇒ keys from the Nautilus server, report uploaded, cfg.registration = {codeHash: imageId, attestationRef} and registerInstance-ready", async () => {
    const s = await nautilus({ seed: "image-a|agent-1" });
    const dir = tmp();
    const configPath = teeConfig(dir, { tee: true, kmsUrl: s.baseUrl, attestationUrl: s.attestationUrl, imageId: IMAGE_ID, imageDigest: `sha256:${"ab".repeat(32)}` });
    const e = await bootEnv({ dir, initParamsDir: boundInitDir(dir), configPath });
    const { rt } = e;

    expect(s.derivePaths).toEqual(["treasury", "action", "fc", "mem", "chat"]);
    expect(s.requests.at(-1)).toBe("/attestation/raw");
    expect(rt.attestationRef).toBe(`attestation-${NOW}.json`);
    expect(rt.cfg.registration).toEqual({ codeHash: IMAGE_ID, attestationRef: `attestation-${NOW}.json` });
    // fixture's platform.registration ("mock-attestation") is replaced by the real values
    expect(FIXTURE_JSON.platform).toHaveProperty("registration.attestationRef", "mock-attestation");

    const report = JSON.parse(readFileSync(join(dir, "attestations", rt.attestationRef!), "utf8")) as Record<string, unknown>;
    const own = rt.keyring.addresses();
    expect(report).toMatchObject({
      kind: "agent-launchpad.attestation-report",
      imageId: IMAGE_ID,
      imageDigest: `sha256:${"ab".repeat(32)}`,
      configHash: rt.frozenHash, // the attested config-hash value (SPEC-M3 §3b), not the legacy whole-file hash
      eoas: { treasury: own.treasury.toLowerCase(), action: own.action.toLowerCase() },
      generation: null,
      timestamp: NOW.toString(),
    });
    expect(Buffer.from(report.quote as string, "base64").equals(Buffer.from(s.quote))).toBe(true);
    expect(rt.frozenHash).toBe(FROZEN_HASH);

    const tx = buildTx({ kind: "registerInstance" }, rt.cfg, NOW);
    expect(tx.data).toBe(
      encodeFunctionData({ abi: REGISTRY, functionName: "registerInstance", args: [1n, own.treasury, own.action, IMAGE_ID, `attestation-${NOW}.json`] }),
    );
    // end-to-end: engine → keyring K2 (rebuilds the tx from its ATTACHED cfg) → chain carries the real values
    const r = await execute({ kind: "registerInstance" }, rt.exec);
    expect(r.verdict.allow).toBe(true);
    expect(r.error).toBeUndefined();
    const sent = e.chain.sent.at(-1);
    expect(sent?.to?.toLowerCase()).toBe(rt.cfg.registry.rh.toLowerCase());
    expect(sent?.data).toBe(tx.data);
  });

  it("KMS + attestation server not ready for the first call ⇒ boot retries (withRetry) and succeeds", async () => {
    const s = await nautilus({ failFirstN: 1 });
    const dir = tmp();
    const e = await bootEnv({ dir, initParamsDir: boundInitDir(dir), configPath: teeConfig(dir, { tee: true, kmsUrl: s.baseUrl, attestationUrl: s.attestationUrl, imageId: IMAGE_ID }) });
    expect(s.requests[0]).toBe("/derive/secp256k1?path=treasury");
    expect(s.requests[1]).toBe("/derive/secp256k1?path=treasury");
    expect(e.rt.cfg.registration?.codeHash).toBe(IMAGE_ID);
  });

  it("injected attestationSink is used; its ref becomes attestationRef", async () => {
    const s = await nautilus();
    const dir = tmp();
    const uploaded: string[] = [];
    const rt = await boot({
      configPath: teeConfig(dir, { tee: true, kmsUrl: s.baseUrl, attestationUrl: s.attestationUrl, imageId: IMAGE_ID }),
      initParamsDir: boundInitDir(dir), // SPEC-M3 §3b: tee:true needs the attested config-hash init param
      dbPath: join(dir, "m.sqlite"),
      snapshotDir: join(dir, "snaps"),
      clock: () => NOW,
      kmsRetry: { attempts: 1, delayMs: 1 },
      overrides: {
        chain: new MockChainClient(),
        logger: quiet,
        timers: new FakeTimers(),
        attestationSink: { upload: async (r) => (uploaded.push(r), "ar://txid-123") },
      },
    });
    runtimes.push(rt);
    expect(uploaded).toHaveLength(1);
    expect(rt.cfg.registration).toEqual({ codeHash: IMAGE_ID, attestationRef: "ar://txid-123" });
    expect(existsSync(join(dir, "attestations"))).toBe(false);
  });

  it("tee:true without runtime.imageId ⇒ refuses to boot before contacting the KMS", async () => {
    const s = await nautilus();
    const dir = tmp();
    await expect(bootEnv({ dir, initParamsDir: boundInitDir(dir), configPath: teeConfig(dir, { tee: true, kmsUrl: s.baseUrl, attestationUrl: s.attestationUrl }) })).rejects.toThrow(/imageId/);
    expect(s.requests).toEqual([]);
  });

  it("tee:true with a non-localhost kmsUrl or attestationUrl ⇒ refuses to boot, nothing contacted", async () => {
    const s = await nautilus();
    const dir = tmp();
    await expect(
      bootEnv({ dir, initParamsDir: boundInitDir(dir), configPath: teeConfig(dir, { tee: true, kmsUrl: "http://10.0.0.5:1100", attestationUrl: s.attestationUrl, imageId: IMAGE_ID }) }),
    ).rejects.toBeInstanceOf(NonLocalUrlError);
    await expect(
      bootEnv({ dir, initParamsDir: boundInitDir(dir), configPath: teeConfig(dir, { tee: true, kmsUrl: s.baseUrl, attestationUrl: "http://attest.example.com/attestation/raw", imageId: IMAGE_ID }) }),
    ).rejects.toBeInstanceOf(NonLocalUrlError);
    expect(s.requests).toEqual([]);
    expect(existsSync(join(dir, "memory.sqlite"))).toBe(false);
  });

  it("tee:false (default) regression: MockKms keys, fixture registration untouched, no attestation", async () => {
    const dir = tmp();
    const e = await bootEnv({ dir });
    expect(e.rt.attestationRef).toBeNull();
    expect(e.rt.cfg.registration).toEqual({ codeHash: `0x${"c0de".repeat(16)}`, attestationRef: "mock-attestation" });
    expect(e.rt.keyring.memKeyForMemoryModule()).toBe(await fixtureMemKey());
    expect(existsSync(join(dir, "attestations"))).toBe(false);
  });
});

describe("main: argv parsing (argv only, no env)", () => {
  const H = `0x${"ab".repeat(32)}`;
  it("parses --config / --db / --expected-hash", () => {
    expect(parseArgs(["--config", "c.json"])).toEqual({ configPath: "c.json" });
    expect(parseArgs(["--db", "m.sqlite", "--expected-hash", H, "--config", "c.json"])).toEqual({ configPath: "c.json", dbPath: "m.sqlite", expectedHash: H });
  });
  it("rejects missing --config, unknown flags, missing values and malformed hashes", () => {
    expect(() => parseArgs([])).toThrow(/--config is required/);
    expect(() => parseArgs(["--config", "c.json", "--port", "1"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--config"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--config", "c.json", "--expected-hash", "0x1234"])).toThrow(/32-byte/);
  });
});

// ---------------------------------------------------------------------------
// M3 s1 review fixes: init-param cross-check, LocalDirSink warning, x402 transport wiring
// ---------------------------------------------------------------------------

function runtimeConfig(dir: string, runtime: Record<string, unknown>, name = "rt.config.json"): string {
  const j = JSON.parse(readFileSync(FIXTURE, "utf8")) as { runtime: Record<string, unknown> };
  Object.assign(j.runtime, runtime);
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(j));
  return p;
}

/** An Oyster /init-params stand-in bound to the fixture: agent-id "agent-1" + config-hash = FROZEN_HASH (overridable). */
let initDirSeq = 0;
function boundInitDir(parent: string, files: { agentId?: string | null; configHash?: string | null } = {}): string {
  const d = join(parent, `init-params-${++initDirSeq}`);
  mkdirSync(d, { recursive: true });
  const agentId = files.agentId === undefined ? "agent-1" : files.agentId;
  const hash = files.configHash === undefined ? FROZEN_HASH : files.configHash;
  if (agentId !== null) writeFileSync(join(d, "agent-id"), agentId);
  if (hash !== null) writeFileSync(join(d, "config-hash"), hash);
  return d;
}

function captureLogger(): BootLogger & { warns: string[]; infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  return { warns, infos, info: (m) => infos.push(m), warn: (m) => warns.push(m), error: () => undefined };
}

describe("boot: /init-params/agent-id cross-check (attested agent-id vs config.agent.agentId)", () => {
  function initDir(content?: string): string {
    const d = join(tmp(), "init-params");
    mkdirSync(d, { recursive: true });
    if (content !== undefined) writeFileSync(join(d, "agent-id"), content);
    return d;
  }

  it("matching agent-id (fixture agentId 1 ⇒ \"agent-1\") boots", async () => {
    const dir = tmp();
    const e = await bootEnv({ dir, configPath: runtimeConfig(dir, { initParamsDir: initDir("agent-1") }) });
    expect(e.rt.cfg.agent.agentId).toBe(1);
  });

  it("a single trailing newline is tolerated", async () => {
    const dir = tmp();
    await expect(bootEnv({ dir, configPath: runtimeConfig(dir, { initParamsDir: initDir("agent-1\n") }) })).resolves.toBeDefined();
  });

  it.each([
    ["other agent", "agent-2"],
    ["padded", "agent-01"],
    ["no prefix", "1"],
    ["empty", ""],
    ["trailing space", "agent-1 "],
    ["two newlines", "agent-1\n\n"],
  ])("mismatch (%s) ⇒ refuses to boot BEFORE any KMS derive / db open", async (_n, content) => {
    const dir = tmp();
    let derives = 0;
    const kms = { derive: async (p: string) => (derives++, new MockKms("image-boot", "agent-boot").derive(p)) };
    await expect(
      boot({
        configPath: runtimeConfig(dir, { initParamsDir: initDir(content) }),
        dbPath: join(dir, "m.sqlite"),
        kms,
        clock: () => NOW,
        overrides: { chain: new MockChainClient(), logger: quiet, timers: new FakeTimers() },
      }),
    ).rejects.toBeInstanceOf(InitParamAgentIdMismatchError);
    expect(derives).toBe(0);
    expect(existsSync(join(dir, "m.sqlite"))).toBe(false);
  });

  it("no agent-id file (non-Oyster run) ⇒ boots; default dir is /init-params", async () => {
    const dir = tmp();
    await expect(bootEnv({ dir, configPath: runtimeConfig(dir, { initParamsDir: initDir() }) })).resolves.toBeDefined();
    expect(checkInitParamAgentId(initDir(), 1)).toBe("absent");
    expect(checkInitParamAgentId(initDir("agent-1"), 1)).toBe("match");
    expect(() => checkInitParamAgentId(initDir("agent-7"), 1)).toThrow(/agent-7.*agent-1/);
  });
});

describe("boot: tee:true with the default LocalDirSink ⇒ loud warning", () => {
  const IMAGE_ID = `0x${"28e981ac".repeat(8)}` as Hex;
  const servers: MockNautilusServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });
  function teeRuntime(s: MockNautilusServer): Record<string, unknown> {
    return { tee: true, mockKms: undefined, kmsUrl: s.baseUrl, attestationUrl: s.attestationUrl, imageId: IMAGE_ID };
  }

  it("LocalDirSink ⇒ warns that attestationRef is a LOCAL file (not publishable on-chain)", async () => {
    const s = new MockNautilusServer();
    await s.start();
    servers.push(s);
    const dir = tmp();
    const log = captureLogger();
    await bootEnv({ dir, initParamsDir: boundInitDir(dir), configPath: runtimeConfig(dir, teeRuntime(s)), overrides: { logger: log } });
    expect(log.warns.some((w) => /attestationRef is a LOCAL file — not publishable on-chain; wire Turbo \(s2\)/.test(w))).toBe(true);
  });

  it("an injected (non-local) sink ⇒ no such warning", async () => {
    const s = new MockNautilusServer();
    await s.start();
    servers.push(s);
    const dir = tmp();
    const log = captureLogger();
    await bootEnv({
      dir,
      initParamsDir: boundInitDir(dir),
      configPath: runtimeConfig(dir, teeRuntime(s)),
      overrides: { logger: log, attestationSink: { upload: async () => "ar://tx" } },
    });
    expect(log.warns.some((w) => /LOCAL file/.test(w))).toBe(false);
  });
});

describe("boot: runtime.x402 — real transport wiring (DEFAULT disabled ⇒ mocks)", () => {
  const PAYTO = Object.fromEntries(
    (JSON.parse(readFileSync(FIXTURE, "utf8")) as { platform: { x402Allowlist: Array<{ url: string; payTo: Address }> } }).platform.x402Allowlist.map((e) => [
      e.url,
      e.payTo,
    ]),
  ) as Record<string, Address>;
  const answer = (system: string, user: string): string =>
    system === CANARY_SYSTEM ? canaryAnswer({ messages: [{ role: "user", content: user }] } as LlmRequest) : JSON.stringify({ diary: "(real transport)" });

  it("enabled ⇒ pulse inference goes over HTTP (overrides.http), MockLlm/MockX402 unused, settlement persisted", async () => {
    const dir = tmp();
    const http = x402Server({ payTo: PAYTO, answer, amount: 1n });
    const e = await bootEnv({ dir, configPath: runtimeConfig(dir, { x402: { enabled: true } }), overrides: { http } });
    const cycle = await e.rt.pulse();
    expect(cycle.result.status).toBe("completed");
    expect(cycle.result.errors).toEqual([]);
    expect(e.llm.calls).toHaveLength(0);
    expect(e.x402.quotes).toHaveLength(0);
    expect(http.requests.length).toBeGreaterThanOrEqual(2);
    const inf = listActions(e.rt.db).filter((a) => a.kind === "inference");
    expect(inf.length).toBeGreaterThanOrEqual(1);
    for (const row of inf) {
      expect(row.verdict).toBe("allow");
      expect((JSON.parse(row.json) as { x402Settlement?: { transaction?: string } }).x402Settlement?.transaction).toBe(SETTLE_TX);
    }
  });

  it("disabled (default) ⇒ mocks used, the HttpClient is never touched", async () => {
    const dir = tmp();
    const http = x402Server({ payTo: PAYTO, answer, amount: 1n });
    const e = await bootEnv({ dir, overrides: { http } });
    const cycle = await e.rt.pulse();
    expect(cycle.result.status).toBe("completed");
    expect(http.requests).toHaveLength(0);
    expect(e.llm.calls.length).toBeGreaterThan(0);
  });

  it("enabled without overrides.http ⇒ FetchHttpClient (https only): boots fine; allowInsecureHttp warns", async () => {
    const dir = tmp();
    const log = captureLogger();
    await bootEnv({ dir, configPath: runtimeConfig(dir, { x402: { enabled: true, allowInsecureHttp: true } }), overrides: { logger: log } });
    expect(log.warns.some((w) => /allowInsecureHttp/.test(w))).toBe(true);
    expect(log.infos.some((m) => /real HTTP transport enabled/.test(m))).toBe(true);
  });

  it("schema: x402 is strict (unknown keys rejected)", async () => {
    const dir = tmp();
    await expect(bootEnv({ dir, configPath: runtimeConfig(dir, { x402: { enabled: true, bogus: 1 } }) })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SPEC-M3 §3b — config split: frozen agent.json (hash-bound via the attested config-hash init param)
// + mutable runtime.json (ops, unattested)
// ---------------------------------------------------------------------------

/** Deep copy with every object's keys in REVERSE order (same content, different serialization). */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

type FrozenMutator = (j: { platform: Record<string, unknown>; agent: Record<string, unknown> }) => void;

/** Writes agent.json (+ optional mutation) and runtime.json (fixture runtime section + overrides) into dir. */
function splitFiles(
  dir: string,
  opts: { runtime?: Record<string, unknown>; mutateAgent?: FrozenMutator } = {},
): { agentPath: string; runtimePath: string } {
  const a = JSON.parse(readFileSync(FIXTURE_AGENT, "utf8")) as { platform: Record<string, unknown>; agent: Record<string, unknown> };
  opts.mutateAgent?.(a);
  const r = JSON.parse(readFileSync(FIXTURE_RUNTIME, "utf8")) as Record<string, unknown>;
  for (const [k, v] of Object.entries(opts.runtime ?? {})) {
    if (v === undefined) delete r[k];
    else r[k] = v;
  }
  const agentPath = join(dir, "agent.json");
  const runtimePath = join(dir, "runtime.json");
  writeFileSync(agentPath, JSON.stringify(a, null, 2));
  writeFileSync(runtimePath, JSON.stringify(r, null, 2));
  return { agentPath, runtimePath };
}

describe("SPEC-M3 §3b loadSplitConfig: frozen agent.json + ops runtime.json", () => {
  it("GOLDEN frozenHash of the fixture agent.json; = the legacy fixture's { platform, agent } hash", () => {
    const c = loadSplitConfig({ agentPath: FIXTURE_AGENT, runtimePath: FIXTURE_RUNTIME });
    expect(c.frozenHash).toBe(FROZEN_HASH);
    const legacy = JSON.parse(readFileSync(FIXTURE, "utf8")) as { platform: unknown; agent: unknown };
    expect(frozenConfigHash(legacy)).toBe(FROZEN_HASH);
    expect(configHash(legacy)).not.toBe(FROZEN_HASH); // the legacy whole-file hash also covers `runtime`
    expect(frozenHashOfFile(FIXTURE_AGENT)).toBe(FROZEN_HASH); // main --print-config-hash
  });

  it("frozenHash is stable across key order and whitespace; any content change moves it", () => {
    const dir = tmp();
    const a = JSON.parse(readFileSync(FIXTURE_AGENT, "utf8")) as Record<string, unknown>;
    const reordered = join(dir, "reordered.json");
    writeFileSync(reordered, JSON.stringify(reverseKeys(a)));
    expect(readFileSync(reordered, "utf8")).not.toBe(JSON.stringify(a));
    expect(loadSplitConfig({ agentPath: reordered, runtimePath: FIXTURE_RUNTIME }).frozenHash).toBe(FROZEN_HASH);
    const spaced = join(dir, "spaced.json");
    writeFileSync(spaced, JSON.stringify(a, null, 7) + "\n\n");
    expect(loadSplitConfig({ agentPath: spaced, runtimePath: FIXTURE_RUNTIME }).frozenHash).toBe(FROZEN_HASH);

    const { agentPath } = splitFiles(dir, { mutateAgent: (j) => ((j.agent as { persona: string }).persona += ".") });
    expect(loadSplitConfig({ agentPath, runtimePath: FIXTURE_RUNTIME }).frozenHash).not.toBe(FROZEN_HASH);
  });

  it("runtime.json does not move the frozenHash (ops changes never rotate keys)", () => {
    const dir = tmp();
    const { agentPath, runtimePath } = splitFiles(dir, { runtime: { rpc: { rh: "https://rpc.example" }, chatHost: "0.0.0.0", dbPath: "x.sqlite" } });
    const c = loadSplitConfig({ agentPath, runtimePath });
    expect(c.frozenHash).toBe(FROZEN_HASH);
    expect(c.ops.rpc.rh).toBe("https://rpc.example");
    expect(c.ops.tee).toBe(false); // defaults applied
  });

  it("resolve(ownAddresses) = resolveConfig over the frozen sections (ResolvedConfig shape unchanged)", () => {
    const c = loadSplitConfig({ agentPath: FIXTURE_AGENT, runtimePath: FIXTURE_RUNTIME });
    const own = { treasury: "0x1000000000000000000000000000000000000001", action: "0x2000000000000000000000000000000000000002" } as const;
    const legacy = JSON.parse(readFileSync(FIXTURE, "utf8")) as { platform: unknown; agent: unknown };
    expect(c.resolve(own as never)).toEqual(resolveConfig({ platform: legacy.platform, agent: legacy.agent, ownAddresses: own as never }));
    expect(c.frozen.agent.agentId).toBe(1);
    expect(c.frozen.platform.caps.maxPerCallUsd).toBe(500_000n);
  });

  it("agent.json must be exactly { platform, agent }: an ops/extra key is refused", () => {
    const dir = tmp();
    for (const extra of [{ runtime: {} }, { rpc: {} }, { note: "x" }]) {
      const p = join(dir, "bad-agent.json");
      writeFileSync(p, JSON.stringify({ ...(JSON.parse(readFileSync(FIXTURE_AGENT, "utf8")) as object), ...extra }));
      expect(() => loadSplitConfig({ agentPath: p, runtimePath: FIXTURE_RUNTIME })).toThrow(/exactly \{ platform, agent \}/);
    }
  });

  it("runtime.json is strict ops-only: it cannot smuggle platform/agent/money fields", () => {
    const dir = tmp();
    for (const smuggle of [{ platform: {} }, { agent: {} }, { x402Allowlist: [] }, { maxPerCallUsd: "999999999" }, { usdc: {} }]) {
      const { agentPath, runtimePath } = splitFiles(dir, { runtime: smuggle });
      expect(() => loadSplitConfig({ agentPath, runtimePath }), JSON.stringify(smuggle)).toThrow();
    }
  });

  it("allowlistUpdatePubkey (04 §4 signer) is a FROZEN field: accepted in platform, covered by the hash", () => {
    const dir = tmp();
    const { agentPath, runtimePath } = splitFiles(dir, {
      mutateAgent: (j) => (j.platform["allowlistUpdatePubkey"] = "0xa11ce00000000000000000000000000000000a11"),
    });
    const c = loadSplitConfig({ agentPath, runtimePath });
    expect(c.frozen.platform.allowlistUpdatePubkey).toBe("0xa11ce00000000000000000000000000000000a11");
    expect(c.frozenHash).not.toBe(FROZEN_HASH);
    const bad = splitFiles(tmp(), { mutateAgent: (j) => (j.platform["allowlistUpdatePubkey"] = "0x1234") });
    expect(() => loadSplitConfig(bad)).toThrow();
  });

  it("expectedHash is checked against frozenHash, before validation", () => {
    expect(loadSplitConfig({ agentPath: FIXTURE_AGENT, runtimePath: FIXTURE_RUNTIME, expectedHash: FROZEN_HASH.toUpperCase().replace("0X", "0x") }).frozenHash).toBe(FROZEN_HASH);
    expect(() => loadSplitConfig({ agentPath: FIXTURE_AGENT, runtimePath: FIXTURE_RUNTIME, expectedHash: `0x${"00".repeat(32)}` })).toThrow(ConfigHashMismatchError);
  });
});

describe("SPEC-M3 §3b boot: split layout (--config agent.json --runtime runtime.json)", () => {
  it("boots from the split fixtures; configHash = frozenHash = golden; same keys/cfg as the legacy single file", async () => {
    const split = await bootEnv({ configPath: FIXTURE_AGENT, runtimeConfigPath: FIXTURE_RUNTIME });
    expect(split.rt.configHash).toBe(FROZEN_HASH);
    expect(split.rt.frozenHash).toBe(FROZEN_HASH);
    const legacy = await bootEnv();
    expect(legacy.rt.frozenHash).toBe(FROZEN_HASH);
    expect(legacy.rt.configHash).toBe(configHash(JSON.parse(readFileSync(FIXTURE, "utf8")))); // legacy semantics unchanged
    expect(split.rt.keyring.addresses()).toEqual(legacy.rt.keyring.addresses());
    expect(split.rt.cfg).toEqual(legacy.rt.cfg);
  });

  it("expectedHash in split mode = frozenHash (the legacy whole-file hash is refused)", async () => {
    await expect(bootEnv({ configPath: FIXTURE_AGENT, runtimeConfigPath: FIXTURE_RUNTIME, expectedHash: FROZEN_HASH })).resolves.toBeDefined();
    const whole = configHash(JSON.parse(readFileSync(FIXTURE, "utf8")));
    await expect(bootEnv({ configPath: FIXTURE_AGENT, runtimeConfigPath: FIXTURE_RUNTIME, expectedHash: whole })).rejects.toBeInstanceOf(ConfigHashMismatchError);
  });

  it("relative ops paths resolve against runtime.json's directory", async () => {
    const dir = tmp();
    const opsDir = join(dir, "ops");
    mkdirSync(opsDir);
    const { agentPath } = splitFiles(dir);
    const { runtimePath } = splitFiles(opsDir, { runtime: { dbPath: "state/mem.sqlite", snapshotDir: "snaps" } });
    mkdirSync(join(opsDir, "state"));
    const rt = await boot({ configPath: agentPath, runtimeConfigPath: runtimePath, clock: () => NOW, overrides: { chain: new MockChainClient(), logger: quiet, timers: new FakeTimers() } });
    runtimes.push(rt);
    expect(existsSync(join(opsDir, "state", "mem.sqlite"))).toBe(true);
  });

  it("the legacy single-file layout passed as agent.json (with --runtime) is refused", async () => {
    await expect(bootEnv({ configPath: FIXTURE, runtimeConfigPath: FIXTURE_RUNTIME })).rejects.toThrow(/exactly \{ platform, agent \}/);
  });

  it("tee:false + a present config-hash init param that does NOT match ⇒ refuses (the param is checked whenever present)", async () => {
    const dir = tmp();
    const { agentPath, runtimePath } = splitFiles(dir, { runtime: { initParamsDir: boundInitDir(dir, { configHash: `0x${"11".repeat(32)}` }) } });
    await expect(bootEnv({ dir, configPath: agentPath, runtimeConfigPath: runtimePath })).rejects.toBeInstanceOf(InitParamConfigHashMismatchError);
  });

  it("checkInitParamConfigHash: absent / match / trailing newline ok / exact lowercase only", () => {
    const d = tmp();
    expect(checkInitParamConfigHash(boundInitDir(d, { configHash: null }), FROZEN_HASH)).toBe("absent");
    expect(checkInitParamConfigHash(boundInitDir(d), FROZEN_HASH)).toBe("match");
    expect(checkInitParamConfigHash(boundInitDir(d, { configHash: `${FROZEN_HASH}\n` }), FROZEN_HASH)).toBe("match");
    for (const bad of [FROZEN_HASH.toUpperCase().replace("0X", "0x"), FROZEN_HASH.slice(2), ` ${FROZEN_HASH}`, `${FROZEN_HASH}\n\n`, "", `0x${"00".repeat(32)}`]) {
      expect(() => checkInitParamConfigHash(boundInitDir(d, { configHash: bad }), FROZEN_HASH), JSON.stringify(bad)).toThrow(InitParamConfigHashMismatchError);
    }
  });
});

describe("SPEC-M3 §3b boot: tee:true binds to the attested config-hash (MockNautilus)", () => {
  const IMAGE_ID = `0x${"28e981ac".repeat(8)}` as Hex;
  const servers: MockNautilusServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });
  async function nautilus(): Promise<MockNautilusServer> {
    const s = new MockNautilusServer();
    await s.start();
    servers.push(s);
    return s;
  }
  /** Split files for a tee:true boot + the init-params dir (passed as BootOptions.initParamsDir — never via runtime.json under tee). */
  function teeSplit(dir: string, s: MockNautilusServer, init: { agentId?: string | null; configHash?: string | null }, mutateAgent?: FrozenMutator) {
    const files = splitFiles(dir, {
      runtime: { mockKms: undefined, tee: true, kmsUrl: s.baseUrl, attestationUrl: s.attestationUrl, imageId: IMAGE_ID },
      ...(mutateAgent !== undefined ? { mutateAgent } : {}),
    });
    return { ...files, initParamsDir: boundInitDir(dir, init) };
  }

  it("agent-id + config-hash match ⇒ boots; the attestation report carries the attested frozenHash", async () => {
    const s = await nautilus();
    const dir = tmp();
    const { agentPath, runtimePath, initParamsDir } = teeSplit(dir, s, {});
    const e = await bootEnv({ dir, configPath: agentPath, runtimeConfigPath: runtimePath, initParamsDir });
    expect(e.rt.frozenHash).toBe(FROZEN_HASH);
    expect(s.derivePaths).toEqual(["treasury", "action", "fc", "mem", "chat"]);
    expect(e.rt.cfg.registration?.codeHash).toBe(IMAGE_ID);
    const report = JSON.parse(readFileSync(join(dir, "attestations", e.rt.attestationRef!), "utf8")) as Record<string, unknown>;
    expect(report.configHash).toBe(FROZEN_HASH);
  });

  it("NO config-hash init param ⇒ refuses (no unbound TEE boots) before any KMS / attestation call or db open", async () => {
    const s = await nautilus();
    const dir = tmp();
    const { agentPath, runtimePath, initParamsDir } = teeSplit(dir, s, { configHash: null });
    await expect(bootEnv({ dir, configPath: agentPath, runtimeConfigPath: runtimePath, initParamsDir })).rejects.toBeInstanceOf(UnboundTeeBootError);
    expect(s.requests).toEqual([]);
    expect(existsSync(join(dir, "memory.sqlite"))).toBe(false);
  });

  it("runtime.json (unattested) cannot relocate the init-params dir under tee: a forged config-hash elsewhere is never read", async () => {
    const s = await nautilus();
    const dir = tmp();
    // Attack: modified agent.json + a forged config-hash for it in an operator-chosen dir, named by runtime.json.
    const mutate: FrozenMutator = (j) => ((j.platform["x402Allowlist"] as Array<Record<string, unknown>>)[0]!["payTo"] = "0xbad0000000000000000000000000000000000bad");
    const probe = splitFiles(tmp(), { mutateAgent: mutate });
    const forgedHash = loadSplitConfig(probe).frozenHash;
    const forgedDir = boundInitDir(dir, { configHash: forgedHash });
    const files = splitFiles(dir, {
      runtime: { mockKms: undefined, tee: true, kmsUrl: s.baseUrl, attestationUrl: s.attestationUrl, imageId: IMAGE_ID, initParamsDir: forgedDir },
      mutateAgent: mutate,
    });
    await expect(bootEnv({ dir, configPath: files.agentPath, runtimeConfigPath: files.runtimePath })).rejects.toThrow(/runtime\.tee forbids runtime\.initParamsDir/);
    expect(s.requests).toEqual([]);
    // tee:false still honours runtime.initParamsDir (non-Oyster dev runs)
    const dev = splitFiles(tmp(), { runtime: { initParamsDir: boundInitDir(dir) } });
    await expect(bootEnv({ configPath: dev.agentPath, runtimeConfigPath: dev.runtimePath })).resolves.toBeDefined();
  });

  it("same, in the legacy single-file layout (no bypass through the old CMD)", async () => {
    const s = await nautilus();
    const dir = tmp();
    const cfg = runtimeConfig(dir, { mockKms: undefined, tee: true, kmsUrl: s.baseUrl, attestationUrl: s.attestationUrl, imageId: IMAGE_ID });
    await expect(bootEnv({ dir, initParamsDir: boundInitDir(dir, { configHash: null }), configPath: cfg })).rejects.toBeInstanceOf(UnboundTeeBootError);
    expect(s.requests).toEqual([]);
  });

  it("MODIFIED frozen config (e.g. a redirected payTo) vs the deployed config-hash ⇒ refuses before the KMS", async () => {
    const s = await nautilus();
    const dir = tmp();
    const { agentPath, runtimePath, initParamsDir } = teeSplit(dir, s, {}, (j) => {
      const al = j.platform["x402Allowlist"] as Array<Record<string, unknown>>;
      al[0]!["payTo"] = "0xbad0000000000000000000000000000000000bad";
    });
    await expect(bootEnv({ dir, configPath: agentPath, runtimeConfigPath: runtimePath, initParamsDir })).rejects.toBeInstanceOf(InitParamConfigHashMismatchError);
    expect(s.requests).toEqual([]);
    expect(existsSync(join(dir, "memory.sqlite"))).toBe(false);
  });

  it("config-hash of another config ⇒ refuses; --expected-hash stays an additional check on top", async () => {
    const s = await nautilus();
    const dir = tmp();
    const other = teeSplit(dir, s, { configHash: `0x${"ab".repeat(32)}` });
    await expect(bootEnv({ dir, ...other, configPath: other.agentPath, runtimeConfigPath: other.runtimePath })).rejects.toBeInstanceOf(InitParamConfigHashMismatchError);
    const dir2 = tmp();
    const ok = teeSplit(dir2, s, {});
    await expect(
      bootEnv({ dir: dir2, initParamsDir: ok.initParamsDir, configPath: ok.agentPath, runtimeConfigPath: ok.runtimePath, expectedHash: `0x${"cd".repeat(32)}` }),
    ).rejects.toBeInstanceOf(ConfigHashMismatchError);
    expect(s.requests).toEqual([]);
  });
});

describe("main: --runtime and --print-config-hash", () => {
  it("parses --runtime into runtimeConfigPath", () => {
    expect(parseArgs(["--config", "agent.json", "--runtime", "runtime.json", "--db", "/data/agent.db"])).toEqual({
      configPath: "agent.json",
      runtimeConfigPath: "runtime.json",
      dbPath: "/data/agent.db",
    });
    expect(() => parseArgs(["--config", "a.json", "--runtime"])).toThrow(/requires a value/);
  });
  it("--print-config-hash takes exactly --config <agent.json>", () => {
    expect(printConfigHashTarget(["--config", "a.json"])).toBeNull();
    expect(printConfigHashTarget(["--print-config-hash", "--config", "a.json"])).toBe("a.json");
    expect(() => printConfigHashTarget(["--print-config-hash"])).toThrow(/exactly --config/);
    expect(() => printConfigHashTarget(["--print-config-hash", "--config", "a.json", "--runtime", "r.json"])).toThrow(/exactly --config/);
  });
});
