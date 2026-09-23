// SPEC-M2C §3 — composition-root tests. boot() from the fixture config file with
// MockLlm / MockX402Transport / MockChainClient injected via opts.overrides; everything
// else (keyring, memory, ExecDeps, schedulers, tier wiring) is the real boot wiring.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { boot, ConfigHashMismatchError, KV_PULSE_NEXT_AT, tierAnnounceKey, type BootLogger, type Runtime, type TimerApi } from "../../src/boot.js";
import type { BalanceReader, Holdings } from "../../src/chat/gate.js";
import { configHash } from "../../src/config/schema.js";
import { parseArgs } from "../../src/main.js";
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

const FIXTURE = join(__dirname, "fixtures", "runtime.config.json");
const FIXTURE_JSON = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  platform: { usdg: Record<Chain, Address>; usdc: Record<Chain, Address>; agentTokenAddress: Address; x402Allowlist: Array<{ id: string; payTo: Address }> };
  runtime: { mockKms: { imageId: string; agentId: string } };
};
const P = FIXTURE_JSON.platform;

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
  chatReaders?: readonly [BalanceReader, BalanceReader];
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
