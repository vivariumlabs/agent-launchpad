// SPEC-M3C §10 boot: registration gas wait. Before a registerInstance send (genesis AND revival),
// ensureRegistered polls the treasury's rh native balance (NativeBalanceSource) every 10 s up to
// runtime.registrationGasWaitSec (DEFAULT 600) until ≥ REGISTRATION_GAS_FLOOR_WEI; timeout ⇒ attempt
// anyway (LOUD warn); read errors = not yet funded (warned once); no wait when registered+fresh,
// keyMismatch, no NativeBalanceSource, or tee:false. Fake clock + fake sleep ⇒ instant.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import {
  boot,
  DEFAULT_REGISTRATION_GAS_WAIT_SEC,
  ensureRegistered,
  REGISTRATION_GAS_FLOOR_WEI,
  waitForRegistrationGas,
  type BootLogger,
  type NativeBalanceSource,
  type RegistrationGasWaitOptions,
  type Runtime,
  type TimerApi,
} from "../../src/boot.js";
import { RuntimeOpsConfigSchema, type ResolvedConfig } from "../../src/config/schema.js";
import { MockChainClient, type ChainClient, type FeeFill, type ReadContractRequest, type SendReceipt, type TxRequest } from "../../src/exec/chain.js";
import type { ExecDeps } from "../../src/exec/execute.js";
import type { Chain, UnixSeconds } from "../../src/policy/types.js";
import { ACTION, CODE_HASH, DAY, NOW, TREASURY, mkCfg, mkLedger, mkState } from "../policy/helpers.js";

const FIXTURE = join(__dirname, "fixtures", "runtime.config.json");
const WINDOW = 7n * DAY;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

/**
 * Registry + native-balance chain. `balances` is consumed one per getBalance (last entry repeats);
 * an Error entry throws. `events` records the interleaving of balance reads and sends.
 */
class GasChain implements ChainClient, NativeBalanceSource {
  readonly events: string[] = [];
  readonly balanceReads: Array<{ chain: Chain; address: Address }> = [];
  readonly sends: Hex[] = [];
  private i = 0;
  constructor(
    private readonly balances: ReadonlyArray<bigint | Error>,
    private readonly inst: Inst = UNREGISTERED,
  ) {}

  async getBalance(chain: Chain, address: Address): Promise<bigint> {
    this.balanceReads.push({ chain, address });
    const v = this.balances[Math.min(this.i++, this.balances.length - 1)]!;
    this.events.push(`balance:${v instanceof Error ? "error" : v.toString()}`);
    if (v instanceof Error) throw v;
    return v;
  }
  async getNonce(): Promise<number> {
    return 0;
  }
  async estimateFill(_c: Chain, _tx: TxRequest): Promise<FeeFill> {
    return { gasLimit: 200_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
  }
  async sendRaw(_c: Chain, signed: Hex): Promise<SendReceipt> {
    this.sends.push(signed);
    this.events.push("send");
    return { hash: `0x${"ab".repeat(32)}`, status: "success" };
  }
  async readContract(_c: Chain, req: ReadContractRequest): Promise<unknown> {
    if (req.functionName === "instanceOf") return { ...this.inst };
    if (req.functionName === "REVIVAL_WINDOW") return WINDOW;
    throw new Error(`unexpected read ${req.functionName}`);
  }
}

function regCfg(): ResolvedConfig {
  return { ...mkCfg(), registration: { codeHash: CODE_HASH, attestationRef: "attestation-ref-1" } };
}

/** Real execute() path: engine T1 allow → buildTx(cfg.registration) → fake-signed → chain.sendRaw. */
function execDeps(chain: ChainClient, cfg: ResolvedConfig): ExecDeps {
  const ledger = mkLedger();
  return {
    cfg,
    chain,
    clock: () => NOW,
    getState: async () => mkState(),
    ledger: { get: () => ledger, set: () => undefined },
    keyring: {
      addresses: () => ({ treasury: TREASURY, action: ACTION }),
      signTxApproved: async () => "0x02deadbeef" as Hex,
    },
  } as unknown as ExecDeps;
}

/** Fake clock + sleep: each sleep advances the clock by its duration (whole seconds). */
function fakeTime(): { opts: (waitSec?: number) => RegistrationGasWaitOptions; sleeps: number[]; now: () => UnixSeconds } {
  let now: UnixSeconds = NOW;
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
    now += BigInt(ms / 1000);
  };
  return {
    opts: (waitSec) => ({ clock: () => now, sleep, ...(waitSec !== undefined ? { waitSec } : {}) }),
    sleeps,
    now: () => now,
  };
}

const waiting = (l: Log): string[] => l.infos.filter((m) => m.startsWith("registration: waiting for preGas"));

describe("M3C §10: registration gas wait (SPEC-M3C §10)", () => {
  it("M3C §10: REGISTRATION_GAS_FLOOR_WEI = 1e14 (0.0001 ETH); DEFAULT wait 600 s", () => {
    expect(REGISTRATION_GAS_FLOOR_WEI).toBe(100_000_000_000_000n);
    expect(DEFAULT_REGISTRATION_GAS_WAIT_SEC).toBe(600);
  });

  it("M3C §10: funded after N polls ⇒ registerInstance sent only AFTER the floor is met; polls every 10 s; info every 30 s", async () => {
    const chain = new GasChain([0n, 0n, 1n, 0n, REGISTRATION_GAS_FLOOR_WEI - 1n, REGISTRATION_GAS_FLOOR_WEI]);
    const t = fakeTime();
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegistered(cfg, 1, chain, execDeps(chain, cfg), log, NOW, t.opts())).toBe("registered");
    expect(chain.sends).toHaveLength(1);
    expect(chain.events).toEqual(["balance:0", "balance:0", "balance:1", "balance:0", `balance:${REGISTRATION_GAS_FLOOR_WEI - 1n}`, `balance:${REGISTRATION_GAS_FLOOR_WEI}`, "send"]);
    expect(chain.balanceReads.every((r) => r.chain === "rh" && r.address === TREASURY)).toBe(true);
    expect(t.sleeps).toEqual([10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(waiting(log)).toHaveLength(2); // t = 0 s and t = 30 s
    expect(waiting(log)[1]).toMatch(/\(30s \/ 600s\)/);
    expect(log.infos.join("\n")).toMatch(/funded on rh \(100000000000000 wei\) after 50s — proceeding/);
    expect(log.infos.join("\n")).toMatch(/registerInstance sent for agent 1/);
    expect(log.warns).toEqual([]);
  });

  it("M3C §10: already funded at the first read ⇒ no sleep, no waiting log, sent", async () => {
    const chain = new GasChain([REGISTRATION_GAS_FLOOR_WEI * 3n]);
    const t = fakeTime();
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegistered(cfg, 1, chain, execDeps(chain, cfg), log, NOW, t.opts())).toBe("registered");
    expect(t.sleeps).toEqual([]);
    expect(waiting(log)).toEqual([]);
    expect(chain.events).toEqual([`balance:${REGISTRATION_GAS_FLOOR_WEI * 3n}`, "send"]);
  });

  it("M3C §10: timeout ⇒ registerInstance ATTEMPTED anyway with a LOUD warning (DEFAULT 600 s)", async () => {
    const chain = new GasChain([0n]);
    const t = fakeTime();
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegistered(cfg, 1, chain, execDeps(chain, cfg), log, NOW, t.opts())).toBe("registered");
    expect(chain.sends).toHaveLength(1);
    expect(chain.events.at(-1)).toBe("send");
    expect(chain.balanceReads).toHaveLength(61); // t = 0, 10, …, 600
    expect(t.sleeps).toHaveLength(60);
    expect(t.now() - NOW).toBe(600n);
    expect(waiting(log)).toHaveLength(20); // t = 0, 30, …, 570
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]).toMatch(/^!!! registration: treasury .* rh balance 0 wei < floor 100000000000000 wei after 600s \(registrationGasWaitSec 600\) — attempting registerInstance for agent 1 ANYWAY !!!$/);
  });

  it("M3C §10: a non-multiple-of-10 wait clamps the last sleep to the deadline", async () => {
    const chain = new GasChain([0n]);
    const t = fakeTime();
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegistered(cfg, 1, chain, execDeps(chain, cfg), log, NOW, t.opts(25))).toBe("registered");
    expect(t.sleeps).toEqual([10_000, 10_000, 5_000]);
    expect(chain.balanceReads).toHaveLength(4);
    expect(log.warns.join("\n")).toMatch(/after 25s \(registrationGasWaitSec 25\) — attempting registerInstance for agent 1 ANYWAY/);
  });

  it("M3C §10: waitSec 0 ⇒ one read, no sleep, attempt at once (warned)", async () => {
    const chain = new GasChain([0n]);
    const t = fakeTime();
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegistered(cfg, 1, chain, execDeps(chain, cfg), log, NOW, t.opts(0))).toBe("registered");
    expect(t.sleeps).toEqual([]);
    expect(chain.balanceReads).toHaveLength(1);
    expect(log.warns.join("\n")).toMatch(/ANYWAY/);
  });

  it("M3C §10: read errors count as not-yet-funded (warned ONCE), then funded ⇒ sent", async () => {
    const chain = new GasChain([new Error("rpc throttled"), new Error("rpc throttled"), 0n, new Error("again"), REGISTRATION_GAS_FLOOR_WEI]);
    const t = fakeTime();
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegistered(cfg, 1, chain, execDeps(chain, cfg), log, NOW, t.opts())).toBe("registered");
    expect(chain.events).toEqual(["balance:error", "balance:error", "balance:0", "balance:error", `balance:${REGISTRATION_GAS_FLOOR_WEI}`, "send"]);
    expect(t.sleeps).toHaveLength(4);
    expect(log.warns).toEqual(["!!! registration: treasury rh balance read FAILED (rpc throttled) — treating as not yet funded; still polling !!!"]);
    expect(waiting(log)[0]).toMatch(/balance unreadable/);
  });

  it("M3C §10: read errors until timeout ⇒ attempted anyway, never throws", async () => {
    const chain = new GasChain([new Error("rpc down")]);
    const t = fakeTime();
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegistered(cfg, 1, chain, execDeps(chain, cfg), log, NOW, t.opts(20))).toBe("registered");
    expect(chain.sends).toHaveLength(1);
    expect(log.warns).toHaveLength(2);
    expect(log.warns[1]).toMatch(/rh balance unreadable < floor .* after 20s .* ANYWAY/);
  });

  it("M3C §10: a throwing sleep never escapes ensureRegistered (attempted anyway)", async () => {
    const chain = new GasChain([0n]);
    const log = capture();
    const cfg = regCfg();
    const opts: RegistrationGasWaitOptions = {
      clock: () => NOW,
      sleep: async () => {
        throw new Error("timer broke");
      },
    };
    expect(await ensureRegistered(cfg, 1, chain, execDeps(chain, cfg), log, NOW, opts)).toBe("registered");
    expect(log.warns.join("\n")).toMatch(/gas wait FAILED unexpectedly \(timer broke\) — attempting registerInstance anyway/);
  });

  it("M3C §10: REVIVAL path waits too (stale record, matching keys) ⇒ revived after funding", async () => {
    const stale: Inst = { treasuryEOA: TREASURY, actionEOA: ACTION, codeHash: CODE_HASH, attestationRef: "old", lastHeartbeat: NOW - WINDOW - 1n, generation: 2 };
    const chain = new GasChain([0n, REGISTRATION_GAS_FLOOR_WEI], stale);
    const t = fakeTime();
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegistered(cfg, 1, chain, execDeps(chain, cfg), log, NOW, t.opts())).toBe("revived");
    expect(chain.events).toEqual(["balance:0", `balance:${REGISTRATION_GAS_FLOOR_WEI}`, "send"]);
    expect(t.sleeps).toEqual([10_000]);
  });

  it("M3C §10: already registered (fresh heartbeat) ⇒ no wait, no balance read, nothing sent", async () => {
    const fresh: Inst = { treasuryEOA: TREASURY, actionEOA: ACTION, codeHash: CODE_HASH, attestationRef: "live", lastHeartbeat: NOW - 60n, generation: 1 };
    const chain = new GasChain([0n], fresh);
    const t = fakeTime();
    const log = capture();
    const cfg = regCfg();
    expect(await ensureRegistered(cfg, 1, chain, execDeps(chain, cfg), log, NOW, t.opts())).toBe("alreadyRegistered");
    expect(chain.balanceReads).toEqual([]);
    expect(t.sleeps).toEqual([]);
    expect(chain.sends).toEqual([]);
    expect(waiting(log)).toEqual([]);
  });

  it("M3C §10: stale record pinned to DIFFERENT keys ⇒ keyMismatch returned before any wait", async () => {
    const other: Inst = { treasuryEOA: "0x00000000000000000000000000000000000000aa", actionEOA: ACTION, codeHash: CODE_HASH, attestationRef: "x", lastHeartbeat: NOW - 30n * DAY, generation: 1 };
    const chain = new GasChain([0n], other);
    const t = fakeTime();
    const cfg = regCfg();
    expect(await ensureRegistered(cfg, 1, chain, execDeps(chain, cfg), capture(), NOW, t.opts())).toBe("keyMismatch");
    expect(chain.balanceReads).toEqual([]);
    expect(t.sleeps).toEqual([]);
  });

  it("M3C §10: no NativeBalanceSource (mock chain) ⇒ no wait (existing behavior)", async () => {
    const chain = new MockChainClient({ reads: () => 0n });
    const t = fakeTime();
    const log = capture();
    expect(await waitForRegistrationGas(chain, TREASURY, 1, log, t.opts())).toBe("noBalanceSource");
    expect(t.sleeps).toEqual([]);
    expect(log.infos).toEqual([]);
    expect(log.warns).toEqual([]);
  });

  it("M3C §10: tee:false boot is unchanged — unfunded NativeBalanceSource chain, no registration, no wait", async () => {
    const dir = mkdtempSync(join(tmpdir(), "al-boot3c10-"));
    dirs.push(dir);
    mkdirSync(join(dir, "data"), { recursive: true });
    const chain = new GasChain([0n]); // treasury unfunded: a wrongly-armed wait would hang on the real sleep
    const log = capture();
    const timers: TimerApi = { set: () => 0, clear: () => undefined };
    const rt = await boot({
      configPath: FIXTURE,
      dbPath: join(dir, "data", "agent.db"),
      snapshotDir: join(dir, "snapshots"),
      clock: () => NOW,
      overrides: { chain, timers, logger: log },
    });
    runtimes.push(rt);
    expect(chain.sends).toEqual([]);
    expect(waiting(log)).toEqual([]);
    expect(log.infos.join("\n")).not.toMatch(/registration:/);
  });

  it("M3C §10: runtime.registrationGasWaitSec is optional (DEFAULT at use site), non-negative int", () => {
    expect(RuntimeOpsConfigSchema.parse({}).registrationGasWaitSec).toBeUndefined();
    expect(RuntimeOpsConfigSchema.parse({ registrationGasWaitSec: 120 }).registrationGasWaitSec).toBe(120);
    expect(RuntimeOpsConfigSchema.parse({ registrationGasWaitSec: 0 }).registrationGasWaitSec).toBe(0);
    for (const bad of [-1, 1.5, "600"]) expect(() => RuntimeOpsConfigSchema.parse({ registrationGasWaitSec: bad })).toThrow();
  });
});
