// SPEC-M3C §11 boot: registration retry loop. Boot step (7) runs ensureRegistered inside
// ensureRegisteredWithRetry: registered | revived | alreadyRegistered | keyMismatch ⇒ stop;
// readFailed | sendFailed ⇒ sleep runtime.registrationRetryDelaySec (DEFAULT 30, last sleep clamped to
// the deadline) and retry until runtime.registrationRetrySec (DEFAULT 900) has elapsed; LOUD warn on
// give-up; never throws. First attempt keeps the §10 waitSec; retries pass 60. Fake clock + sleep ⇒ instant.

import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REGISTRATION_RETRY_DELAY_SEC,
  DEFAULT_REGISTRATION_RETRY_SEC,
  ensureRegisteredWithRetry,
  REGISTRATION_GAS_FLOOR_WEI,
  REGISTRATION_RETRY_GAS_WAIT_SEC,
  type BootLogger,
  type NativeBalanceSource,
  type RegistrationRetryOptions,
} from "../../src/boot.js";
import { RuntimeOpsConfigSchema, type ResolvedConfig } from "../../src/config/schema.js";
import type { ChainClient, FeeFill, ReadContractRequest, SendReceipt, TxRequest } from "../../src/exec/chain.js";
import type { ExecDeps } from "../../src/exec/execute.js";
import type { Chain, UnixSeconds, WalletState } from "../../src/policy/types.js";
import { ACTION, CODE_HASH, DAY, NOW, TREASURY, mkCfg, mkLedger, mkState } from "../policy/helpers.js";

const WINDOW = 7n * DAY;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

interface Log extends BootLogger {
  infos: string[];
  warns: string[];
}
function capture(): Log {
  const infos: string[] = [];
  const warns: string[] = [];
  return { infos, warns, info: (m) => infos.push(m), warn: (m) => warns.push(m), error: () => undefined };
}

type Inst = { treasuryEOA: Address; actionEOA: Address; codeHash: Hex; attestationRef: string; lastHeartbeat: bigint; generation: number };
const UNREGISTERED: Inst = { treasuryEOA: ZERO, actionEOA: ZERO, codeHash: `0x${"00".repeat(32)}`, attestationRef: "", lastHeartbeat: 0n, generation: 0 };

/** Shared fake time: each sleep advances the clock by its duration (whole seconds). */
class FakeTime {
  t: UnixSeconds = NOW;
  readonly sleeps: number[] = [];
  readonly clock = (): UnixSeconds => this.t;
  readonly sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.t += BigInt(ms / 1000);
  };
  opts(extra: Omit<RegistrationRetryOptions, "clock" | "sleep"> = {}): RegistrationRetryOptions {
    return { clock: this.clock, sleep: this.sleep, ...extra };
  }
}

type SendMode = "ok" | "throw" | "lostReceipt";

/**
 * Scripted registry chain. `instanceOf` entries are consumed per read (last repeats; an Error throws;
 * "live" returns the record as last written by a send). `sends` likewise (last repeats). A "lostReceipt"
 * send lands on-chain (record becomes registered at the current fake time) but the call throws.
 * Optional `balance` makes it a NativeBalanceSource (constant balance).
 */
class RetryChain implements ChainClient {
  readonly events: string[] = [];
  readonly sends: Hex[] = [];
  private ir = 0;
  private is = 0;
  private live: Inst = UNREGISTERED;
  constructor(
    private readonly time: FakeTime,
    private readonly reads: ReadonlyArray<Inst | Error | "live">,
    private readonly sendModes: ReadonlyArray<SendMode> = ["ok"],
  ) {}

  async getNonce(): Promise<number> {
    return 0;
  }
  async estimateFill(_c: Chain, _tx: TxRequest): Promise<FeeFill> {
    return { gasLimit: 200_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
  }
  async sendRaw(_c: Chain, signed: Hex): Promise<SendReceipt> {
    const mode = this.sendModes[Math.min(this.is++, this.sendModes.length - 1)]!;
    this.events.push(`send:${mode}`);
    if (mode === "throw") throw new Error("rpc 503");
    this.sends.push(signed);
    this.live = { treasuryEOA: TREASURY, actionEOA: ACTION, codeHash: CODE_HASH, attestationRef: "attestation-ref-1", lastHeartbeat: this.time.t, generation: 1 };
    if (mode === "lostReceipt") throw new Error("receipt timeout");
    return { hash: `0x${"ab".repeat(32)}`, status: "success" };
  }
  async readContract(_c: Chain, req: ReadContractRequest): Promise<unknown> {
    if (req.functionName === "REVIVAL_WINDOW") return WINDOW;
    if (req.functionName !== "instanceOf") throw new Error(`unexpected read ${req.functionName}`);
    const v = this.reads[Math.min(this.ir++, this.reads.length - 1)]!;
    this.events.push(`read:${v instanceof Error ? "error" : v === "live" ? "live" : "fixed"}`);
    if (v instanceof Error) throw v;
    return { ...(v === "live" ? this.live : v) };
  }
}

/** Unfunded NativeBalanceSource variant — exercises the per-attempt §10 waitSec. */
class UnfundedRetryChain extends RetryChain implements NativeBalanceSource {
  readonly balanceReads: UnixSeconds[] = [];
  constructor(private readonly ft: FakeTime, reads: ReadonlyArray<Inst | Error | "live">, sendModes?: ReadonlyArray<SendMode>) {
    super(ft, reads, sendModes);
  }
  async getBalance(): Promise<bigint> {
    this.balanceReads.push(this.ft.t);
    return REGISTRATION_GAS_FLOOR_WEI - 1n;
  }
}

function regCfg(): ResolvedConfig {
  return { ...mkCfg(), registration: { codeHash: CODE_HASH, attestationRef: "attestation-ref-1" } };
}

function execDeps(chain: ChainClient, cfg: ResolvedConfig, getState: () => Promise<WalletState> = async () => mkState()): ExecDeps {
  const ledger = mkLedger();
  return {
    cfg,
    chain,
    clock: () => NOW,
    getState,
    ledger: { get: () => ledger, set: () => undefined },
    keyring: {
      addresses: () => ({ treasury: TREASURY, action: ACTION }),
      signTxApproved: async () => "0x02deadbeef" as Hex,
    },
  } as unknown as ExecDeps;
}

const giveUps = (l: Log): string[] => l.warns.filter((m) => m.includes("GIVING UP"));
const instanceReads = (c: RetryChain): number => c.events.filter((e) => e.startsWith("read:")).length;

describe("M3C §11: registration retry loop (SPEC-M3C §11)", () => {
  it("M3C §11: defaults — 900 s budget, 30 s delay, 60 s gas wait on retries", () => {
    expect(DEFAULT_REGISTRATION_RETRY_SEC).toBe(900);
    expect(DEFAULT_REGISTRATION_RETRY_DELAY_SEC).toBe(30);
    expect(REGISTRATION_RETRY_GAS_WAIT_SEC).toBe(60);
  });

  it("M3C §11: readFailed ×2 then success ⇒ 3 attempts, registered, two 30 s sleeps", async () => {
    const t = new FakeTime();
    const chain = new RetryChain(t, [new Error("flake 1"), new Error("flake 2"), UNREGISTERED]);
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegisteredWithRetry(cfg, 1, chain, execDeps(chain, cfg), log, t.opts())).toBe("registered");
    expect(chain.events).toEqual(["read:error", "read:error", "read:fixed", "send:ok"]);
    expect(instanceReads(chain)).toBe(3);
    expect(chain.sends).toHaveLength(1);
    expect(t.sleeps).toEqual([30_000, 30_000]);
    expect(t.t - NOW).toBe(60n);
    expect(giveUps(log)).toEqual([]);
    expect(log.infos).toContain("registration: agent 1 registered on attempt 3");
  });

  it("M3C §11: transient G5 STATE_STALE (rh stale in getState) ⇒ sendFailed, retried, registered", async () => {
    const t = new FakeTime();
    const chain = new RetryChain(t, [UNREGISTERED]);
    let calls = 0;
    const getState = async (): Promise<WalletState> => (calls++ === 0 ? { ...mkState(), staleChains: ["rh"] } : mkState());
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegisteredWithRetry(cfg, 1, chain, execDeps(chain, cfg, getState), log, t.opts())).toBe("registered");
    expect(chain.events).toEqual(["read:fixed", "read:fixed", "send:ok"]);
    expect(t.sleeps).toEqual([30_000]);
    expect(log.warns.join("\n")).toMatch(/STATE_STALE/);
  });

  it("M3C §11: sendFailed until budget ⇒ gives up with a LOUD warn, resolves (boot continues); DEFAULT budget arithmetic exact", async () => {
    const t = new FakeTime();
    const chain = new RetryChain(t, [UNREGISTERED], ["throw"]);
    const log = capture();
    const cfg = regCfg();
    const p = ensureRegisteredWithRetry(cfg, 1, chain, execDeps(chain, cfg), log, t.opts());
    await expect(p).resolves.toBe("sendFailed");
    // Attempts at t = 0, 30, …, 900 ⇒ 31 attempts, 30 sleeps of 30 s, exactly 900 s elapsed.
    expect(instanceReads(chain)).toBe(31);
    expect(chain.events.filter((e) => e === "send:throw")).toHaveLength(31);
    expect(t.sleeps).toEqual(Array.from({ length: 30 }, () => 30_000));
    expect(t.t - NOW).toBe(900n);
    expect(giveUps(log)).toHaveLength(1);
    expect(giveUps(log)[0]).toBe(
      "!!! registration: GIVING UP for agent 1 after 31 attempt(s) / 900s (registrationRetrySec 900; last outcome sendFailed) — boot continues UNREGISTERED; heartbeats will fail visibly !!!",
    );
  });

  it("M3C §11: budget not a multiple of the delay ⇒ last sleep clamped to the deadline", async () => {
    const t = new FakeTime();
    const chain = new RetryChain(t, [new Error("down")]);
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegisteredWithRetry(cfg, 1, chain, execDeps(chain, cfg), log, t.opts({ retrySec: 100, retryDelaySec: 30 }))).toBe("readFailed");
    expect(t.sleeps).toEqual([30_000, 30_000, 30_000, 10_000]);
    expect(instanceReads(chain)).toBe(5); // t = 0, 30, 60, 90, 100
    expect(t.t - NOW).toBe(100n);
    expect(giveUps(log)[0]).toMatch(/after 5 attempt\(s\) \/ 100s \(registrationRetrySec 100; last outcome readFailed\)/);
  });

  it("M3C §11: retrySec 0 ⇒ single attempt, no sleep, give-up warned", async () => {
    const t = new FakeTime();
    const chain = new RetryChain(t, [new Error("down")]);
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegisteredWithRetry(cfg, 1, chain, execDeps(chain, cfg), log, t.opts({ retrySec: 0 }))).toBe("readFailed");
    expect(instanceReads(chain)).toBe(1);
    expect(t.sleeps).toEqual([]);
    expect(giveUps(log)).toHaveLength(1);
  });

  it("M3C §11: keyMismatch ⇒ no retry (permanent)", async () => {
    const t = new FakeTime();
    const other: Inst = { treasuryEOA: "0x00000000000000000000000000000000000000aa", actionEOA: ACTION, codeHash: CODE_HASH, attestationRef: "x", lastHeartbeat: NOW - 30n * DAY, generation: 1 };
    const chain = new RetryChain(t, [other]);
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegisteredWithRetry(cfg, 1, chain, execDeps(chain, cfg), log, t.opts())).toBe("keyMismatch");
    expect(instanceReads(chain)).toBe(1);
    expect(chain.sends).toEqual([]);
    expect(t.sleeps).toEqual([]);
    expect(giveUps(log)).toEqual([]);
  });

  it("M3C §11: alreadyRegistered / registered / revived on the first attempt ⇒ no retry", async () => {
    const fresh: Inst = { treasuryEOA: TREASURY, actionEOA: ACTION, codeHash: CODE_HASH, attestationRef: "live", lastHeartbeat: NOW - 60n, generation: 1 };
    const stale: Inst = { ...fresh, lastHeartbeat: NOW - WINDOW - 1n };
    for (const [inst, want] of [[fresh, "alreadyRegistered"], [UNREGISTERED, "registered"], [stale, "revived"]] as const) {
      const t = new FakeTime();
      const chain = new RetryChain(t, [inst]);
      const cfg = regCfg();
      expect(await ensureRegisteredWithRetry(cfg, 1, chain, execDeps(chain, cfg), capture(), t.opts())).toBe(want);
      expect(instanceReads(chain)).toBe(1);
      expect(t.sleeps).toEqual([]);
    }
  });

  it("M3C §11: lost-receipt send ⇒ next attempt re-reads instanceOf ⇒ alreadyRegistered, NO second send", async () => {
    const t = new FakeTime();
    const chain = new RetryChain(t, ["live"], ["lostReceipt", "ok"]);
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegisteredWithRetry(cfg, 1, chain, execDeps(chain, cfg), log, t.opts())).toBe("alreadyRegistered");
    expect(chain.events).toEqual(["read:live", "send:lostReceipt", "read:live"]);
    expect(chain.sends).toHaveLength(1);
    expect(t.sleeps).toEqual([30_000]);
    expect(giveUps(log)).toEqual([]);
    expect(log.infos).toContain("registration: agent 1 alreadyRegistered on attempt 2");
  });

  it("M3C §11: first attempt keeps the configured §10 waitSec; retries pass 60 s; gas waits count toward the budget", async () => {
    const t = new FakeTime();
    const chain = new UnfundedRetryChain(t, [UNREGISTERED], ["throw"]);
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegisteredWithRetry(cfg, 1, chain, execDeps(chain, cfg), log, t.opts({ waitSec: 120, retrySec: 300, retryDelaySec: 30 }))).toBe("sendFailed");
    // Attempt 1: gas wait 0→120 (13 reads), send fails at t=120; sleep 30 ⇒ t=150.
    // Attempt 2: gas wait 150→210 (7 reads), fails at t=210; sleep 30 ⇒ t=240.
    // Attempt 3: gas wait 240→300 (7 reads), fails at t=300 ≥ 300 ⇒ give up.
    const rel = chain.balanceReads.map((x) => Number(x - NOW));
    expect(rel.filter((s) => s <= 120)).toHaveLength(13);
    expect(rel.filter((s) => s >= 150 && s <= 210)).toHaveLength(7);
    expect(rel.filter((s) => s >= 240 && s <= 300)).toHaveLength(7);
    expect(rel).toHaveLength(27);
    expect(chain.events.filter((e) => e === "send:throw")).toHaveLength(3);
    expect(t.t - NOW).toBe(300n);
    const gasTimeouts = log.warns.filter((m) => m.includes("ANYWAY"));
    expect(gasTimeouts.map((m) => /\(registrationGasWaitSec (\d+)\)/.exec(m)?.[1])).toEqual(["120", "60", "60"]);
    expect(giveUps(log)[0]).toMatch(/after 3 attempt\(s\) \/ 300s/);
  });

  it("M3C §11: a throwing sleep never escapes — warned, last outcome returned", async () => {
    const chain = new RetryChain(new FakeTime(), [new Error("down")]);
    const log = capture();
    const cfg = regCfg();
    const opts: RegistrationRetryOptions = {
      clock: () => NOW,
      sleep: async () => {
        throw new Error("timer broke");
      },
    };
    await expect(ensureRegisteredWithRetry(cfg, 1, chain, execDeps(chain, cfg), log, opts)).resolves.toBe("readFailed");
    expect(log.warns.join("\n")).toMatch(/retry loop FAILED unexpectedly for agent 1 after 1 attempt\(s\) \(timer broke; last outcome readFailed\)/);
  });

  it("M3C §11: runtime.registrationRetrySec / registrationRetryDelaySec optional (DEFAULT at use site), non-negative ints", () => {
    const d = RuntimeOpsConfigSchema.parse({});
    expect(d.registrationRetrySec).toBeUndefined();
    expect(d.registrationRetryDelaySec).toBeUndefined();
    const p = RuntimeOpsConfigSchema.parse({ registrationRetrySec: 0, registrationRetryDelaySec: 5 });
    expect(p.registrationRetrySec).toBe(0);
    expect(p.registrationRetryDelaySec).toBe(5);
    for (const bad of [-1, 1.5, "900"]) {
      expect(() => RuntimeOpsConfigSchema.parse({ registrationRetrySec: bad })).toThrow();
      expect(() => RuntimeOpsConfigSchema.parse({ registrationRetryDelaySec: bad })).toThrow();
    }
  });
});
