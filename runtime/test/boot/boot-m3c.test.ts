// SPEC-M3C §4/§5 boot: the tolerant chainStateReader (never throws; per-chain degradation with a
// per-reader cache; staleChains present ONLY when non-empty) and ensureRegistered honoring
// "never throws" when execute throws (e.g. a throwing getState).

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import {
  boot,
  chainStateReader,
  ensureRegistered,
  type BootLogger,
  type NativeBalanceSource,
  type Runtime,
  type TimerApi,
} from "../../src/boot.js";
import { MockChainClient, type ChainClient, type ReadContractRequest } from "../../src/exec/chain.js";
import { execute, type ExecDeps } from "../../src/exec/execute.js";
import type { Chain, UnixSeconds, WalletState } from "../../src/policy/types.js";
import { ACTION, AGENT_TOKEN, NOW, TREASURY, USDC, USDG_RH, mkCfg, mkLedger } from "../policy/helpers.js";

const FIXTURE = join(__dirname, "fixtures", "runtime.config.json");
const CHAINS: readonly Chain[] = ["rh", "base", "arbitrum", "optimism"];
const HOSTING = { paidUntil: NOW + 86_400n, ratePerDay: 1_700_000n };

const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface CaptureLogger extends BootLogger {
  warns: string[];
}
function capture(): CaptureLogger {
  const warns: string[] = [];
  return { warns, info: () => undefined, warn: (m) => warns.push(m), error: () => undefined };
}

/**
 * ChainClient + native balances. Every balance = level[chain] × 1000 + a per-(asset, owner) offset, so
 * a changed level is visible in fresh reads. `failing` chains throw on every read; `failWhen` throws
 * on one specific read (to prove a chain is never half-fresh).
 */
class FlakyChain extends MockChainClient implements NativeBalanceSource {
  readonly failing = new Set<Chain>();
  failWhen: ((c: Chain, what: string, owner: Address) => boolean) | null = null;
  readonly level: Record<Chain, bigint> = { rh: 1n, base: 2n, arbitrum: 3n, optimism: 4n };
  reads = 0;

  constructor() {
    super();
  }

  private value(c: Chain, what: string, owner: Address): bigint {
    this.reads++;
    if (this.failing.has(c)) throw new Error(`${c} rpc throttled`);
    if (this.failWhen?.(c, what, owner) === true) throw new Error(`${c} ${what} read failed`);
    const off = (owner.toLowerCase() === ACTION.toLowerCase() ? 100n : 0n) + (what === "native" ? 1n : what === "USDC" ? 2n : what === "USDG" ? 3n : 4n);
    return this.level[c] * 1000n + off;
  }

  async getBalance(c: Chain, a: Address): Promise<bigint> {
    return this.value(c, "native", a);
  }

  override async readContract(c: Chain, req: ReadContractRequest): Promise<unknown> {
    const token = req.address.toLowerCase();
    const owner = (req.args?.[0] ?? "0x") as Address;
    const what = token === USDC[c].toLowerCase() ? "USDC" : token === USDG_RH.toLowerCase() ? "USDG" : "token";
    return this.value(c, what, owner);
  }
}

function reader(chain: ChainClient, clock: () => UnixSeconds = () => NOW): { read: () => Promise<WalletState>; log: CaptureLogger } {
  const log = capture();
  return { read: chainStateReader(chain, mkCfg(), HOSTING, { logger: log, clock }), log };
}

/** Expected fresh slice for chain c at level L. */
function freshTreasury(c: Chain, L: bigint): Record<string, unknown> {
  const base = { native: L * 1000n + 1n, USDC: L * 1000n + 2n };
  return c === "rh" ? { ...base, USDG: L * 1000n + 3n, tokens: { [AGENT_TOKEN]: L * 1000n + 4n } } : base;
}
function freshAction(c: Chain, L: bigint): Record<string, unknown> {
  return c === "rh" ? { native: L * 1000n + 101n, USDG: L * 1000n + 103n, tokens: { [AGENT_TOKEN]: L * 1000n + 104n } } : { native: 0n };
}

describe("M3C: tolerant chainStateReader (SPEC-M3C §4)", () => {
  it("M3C: all-success ⇒ fresh balances, staleChains key ABSENT (exact), no warning", async () => {
    const chain = new FlakyChain();
    const { read, log } = reader(chain);
    const s = await read();
    expect("staleChains" in s).toBe(false);
    expect(Object.keys(s).sort()).toEqual(["action", "hostingPaidUntil", "hostingRatePerDay", "treasury"]);
    for (const c of CHAINS) {
      expect(s.treasury[c]).toEqual(freshTreasury(c, chain.level[c]));
      expect(s.action[c]).toEqual(freshAction(c, chain.level[c]));
    }
    expect(s.hostingPaidUntil).toBe(HOSTING.paidUntil);
    expect(s.hostingRatePerDay).toBe(HOSTING.ratePerDay);
    expect(log.warns).toEqual([]);
  });

  it("M3C: base throws ⇒ staleChains [\"base\"], base zeroed, other chains real, LOUD warning", async () => {
    const chain = new FlakyChain();
    chain.failing.add("base");
    const { read, log } = reader(chain);
    const s = await read();
    expect(s.staleChains).toEqual(["base"]);
    expect(s.treasury.base).toEqual({ native: 0n, USDC: 0n });
    expect(s.action.base).toEqual({ native: 0n });
    for (const c of ["rh", "arbitrum", "optimism"] as const) {
      expect(s.treasury[c]).toEqual(freshTreasury(c, chain.level[c]));
      expect(s.action[c]).toEqual(freshAction(c, chain.level[c]));
    }
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]).toBe("!!! getState: base reads FAILED (base rpc throttled) — using zeros; spends touching base deny STATE_STALE !!!");
  });

  it("M3C: success-then-failure ⇒ the CACHED slice is served AND the chain is still stale; recovery is automatic", async () => {
    const chain = new FlakyChain();
    let now = NOW;
    const { read, log } = reader(chain, () => now);
    const first = await read();
    expect("staleChains" in first).toBe(false);

    chain.level.base = 9n; // would be visible on a fresh read
    chain.failing.add("base");
    now = NOW + 42n;
    const second = await read();
    expect(second.staleChains).toEqual(["base"]);
    expect(second.treasury.base).toEqual(freshTreasury("base", 2n)); // cached, NOT zeros, NOT level 9
    expect(second.treasury.rh).toEqual(freshTreasury("rh", 1n));
    expect(log.warns).toEqual([
      "!!! getState: base reads FAILED (base rpc throttled) — using cached values (age 42s); spends touching base deny STATE_STALE !!!",
    ]);

    // Mutating a returned state never corrupts the cache.
    second.treasury.base.USDC = 0n;
    const third = await read();
    expect(third.treasury.base).toEqual(freshTreasury("base", 2n));

    chain.failing.clear();
    const healed = await read();
    expect("staleChains" in healed).toBe(false);
    expect(healed.treasury.base).toEqual(freshTreasury("base", 9n));
  });

  it("M3C: no half-fresh chains — ONE failed read on rh (the action EOA's USDG) marks ALL of rh stale (treasury too)", async () => {
    const chain = new FlakyChain();
    chain.failWhen = (c, what, owner) => c === "rh" && what === "USDG" && owner.toLowerCase() === ACTION.toLowerCase();
    const { read, log } = reader(chain);
    const s = await read();
    expect(s.staleChains).toEqual(["rh"]);
    expect(s.treasury.rh).toEqual({ native: 0n, USDC: 0n, USDG: 0n, tokens: { [AGENT_TOKEN]: 0n } });
    expect(s.action.rh).toEqual({ native: 0n, USDG: 0n, tokens: { [AGENT_TOKEN]: 0n } });
    expect(s.treasury.base).toEqual(freshTreasury("base", 2n));
    expect(log.warns.join("\n")).toMatch(/getState: rh reads FAILED \(rh USDG read failed\) — using zeros/);
  });

  it("M3C: every chain failing ⇒ resolves (never throws), all four stale, one warning per chain", async () => {
    const chain = new FlakyChain();
    for (const c of CHAINS) chain.failing.add(c);
    const { read, log } = reader(chain);
    const s = await read();
    expect(s.staleChains).toEqual(["rh", "base", "arbitrum", "optimism"]);
    expect(log.warns).toHaveLength(4);
    expect(s.hostingPaidUntil).toBe(HOSTING.paidUntil);
  });

  it("M3C: a non-bigint read is a failure of that chain (not a throw out of getState)", async () => {
    const chain = new MockChainClient({ reads: (c) => (c === "arbitrum" ? "garbage" : 5n) });
    const { read, log } = reader(chain);
    const s = await read();
    expect(s.staleChains).toEqual(["arbitrum"]);
    expect(log.warns.join("\n")).toMatch(/arbitrum reads FAILED \(balanceOf\(.*\)@arbitrum: expected bigint, got string\)/);
  });

  it("M3C: boot with a throttled chain boots; getState degrades; a spend touching it is denied STATE_STALE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "al-boot3c-"));
    dirs.push(dir);
    mkdirSync(join(dir, "data"), { recursive: true });
    const chain = new FlakyChain();
    chain.failing.add("base");
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
    const s = await rt.exec.getState();
    expect(s.staleChains).toEqual(["base"]);
    const r = await execute({ kind: "inference", category: "pulse", endpointId: "ep-a", maxCostUsd: 100_000n }, rt.exec, { meterOnly: true });
    expect(r.verdict).toMatchObject({ allow: false, code: "STATE_STALE" });
    expect(log.warns.join("\n")).toMatch(/getState: base reads FAILED/);
  });
});

describe("M3C: ensureRegistered never throws (SPEC-M3C §5)", () => {
  const ZERO_INST = {
    treasuryEOA: "0x0000000000000000000000000000000000000000",
    actionEOA: "0x0000000000000000000000000000000000000000",
    codeHash: `0x${"00".repeat(32)}`,
    attestationRef: "",
    lastHeartbeat: 0n,
    generation: 0,
  };

  it("M3C: deps whose getState throws ⇒ resolves \"sendFailed\" (never rejects), LOUD warning, nothing sent", async () => {
    const chain = new MockChainClient({ reads: (_c, r) => (r.functionName === "instanceOf" ? ZERO_INST : 0n) });
    const ledger = mkLedger();
    const exec = {
      cfg: mkCfg(),
      chain,
      clock: () => NOW,
      getState: async (): Promise<WalletState> => {
        throw new Error("rpc throttled");
      },
      ledger: { get: () => ledger, set: () => undefined },
      keyring: { addresses: () => ({ treasury: TREASURY, action: ACTION }) },
    } as unknown as ExecDeps;
    const log = capture();
    await expect(ensureRegistered(mkCfg(), 1, chain, exec, log, NOW)).resolves.toBe("sendFailed");
    expect(chain.sent).toHaveLength(0);
    expect(log.warns.join("\n")).toMatch(/registerInstance THREW for agent 1 \(rpc throttled\) — boot continues UNREGISTERED/);
  });
});
