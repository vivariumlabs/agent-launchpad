// SPEC-M3F §2: a failing agent-token balanceOf (e.g. a deterministic revert from a bad
// agentTokenAddress) no longer pins rh stale. Both token reads share their OWN try/catch inside the rh
// group: failure ⇒ ONE LOUD warn per read attempt and `tokens` OMITTED from both rh slices; rh freshness
// is decided by the remaining reads. Consumers read a missing token entry as 0.

import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { chainStateReader, type BootLogger } from "../../src/boot.js";
import type { ReadContractRequest } from "../../src/exec/chain.js";
import { MockChainClient } from "../../src/exec/chain.js";
import { evaluate } from "../../src/policy/engine.js";
import { runwayDays } from "../../src/policy/runway.js";
import type { Chain, ProposedAction, UnixSeconds, WalletState } from "../../src/policy/types.js";
import { rhBalanceOf } from "../../src/policy/util.js";
import { tierOf } from "../../src/pulse/tier.js";
import { ACTION, AGENT_TOKEN, DAY, E18, E6, NOW, TREASURY, USDC, USDG_RH, expectAllow, expectDeny, mkCfg, mkLedger } from "../policy/helpers.js";

const CHAINS: readonly Chain[] = ["rh", "base", "arbitrum", "optimism"];
const HOSTING = { paidUntil: NOW + 30n * DAY, ratePerDay: 1_700_000n };
const TOKEN_WARN = /^!!! getState: agent token read reverted — tokens omitted from state; check agentTokenAddress \(.*\) !!!$/;

interface Log extends BootLogger {
  warns: string[];
}
function capture(): Log {
  const warns: string[] = [];
  return { warns, info: () => undefined, warn: (m) => warns.push(m), error: () => undefined };
}

type Fail = "none" | "treasuryToken" | "actionToken" | "bothTokens" | "tokenGarbage" | "treasuryUsdg" | "allRh";

/** Mock chain: native 0.1 ETH everywhere (action rh 0.0005), USDG/USDC/agent-token balances; scripted failures. */
function mkChain(): { chain: MockChainClient; fail: { mode: Fail } } {
  const fail: { mode: Fail } = { mode: "none" };
  const balances: Record<string, bigint> = {};
  for (const c of CHAINS) balances[`${c}:${TREASURY.toLowerCase()}`] = E18 / 10n;
  balances[`rh:${ACTION.toLowerCase()}`] = (E18 * 5n) / 10_000n;
  const reads = (c: Chain, req: ReadContractRequest): unknown => {
    if (fail.mode === "allRh" && c === "rh") throw new Error("rh rpc down");
    const t = req.address.toLowerCase();
    const owner = String(req.args?.[0]).toLowerCase();
    const isTreasury = owner === TREASURY.toLowerCase();
    if (t === AGENT_TOKEN.toLowerCase()) {
      if (fail.mode === "bothTokens") throw new Error("execution reverted");
      if (fail.mode === "treasuryToken" && isTreasury) throw new Error("execution reverted (treasury)");
      if (fail.mode === "actionToken" && !isTreasury) throw new Error("execution reverted (action)");
      if (fail.mode === "tokenGarbage") return "0xdeadbeef";
      return isTreasury ? 1000n * E18 : 500n * E18;
    }
    if (t === USDG_RH.toLowerCase()) {
      if (fail.mode === "treasuryUsdg" && isTreasury) throw new Error("rh USDG read failed");
      return isTreasury ? 10_000n * E6 : 1000n * E6;
    }
    if (t === USDC[c].toLowerCase()) return c === "arbitrum" ? 200n * E6 : 50n * E6;
    throw new Error(`unexpected read ${req.functionName}@${req.address}`);
  };
  const chain = new MockChainClient({ balances, reads });
  const inner = chain.getBalance!;
  chain.getBalance = async (c: Chain, a: Address) => {
    if (fail.mode === "allRh" && c === "rh") throw new Error("rh rpc down");
    return inner(c, a);
  };
  return { chain, fail };
}

function reader(clock: () => UnixSeconds = () => NOW) {
  const { chain, fail } = mkChain();
  const log = capture();
  return { read: chainStateReader(chain, mkCfg(), HOSTING, { logger: log, clock }), fail, log };
}

describe("M3F §2: degraded agent-token reads (SPEC-M3F §2)", () => {
  it("M3F §2: token read throws, everything else succeeds ⇒ rh FRESH, tokens ABSENT from both slices, ONE loud warn", async () => {
    const { read, fail, log } = reader();
    fail.mode = "bothTokens";
    const s = await read();
    expect("staleChains" in s).toBe(false);
    expect("tokens" in s.treasury.rh).toBe(false);
    expect("tokens" in s.action.rh).toBe(false);
    expect(s.treasury.rh).toEqual({ native: E18 / 10n, USDC: 50n * E6, USDG: 10_000n * E6 });
    expect(s.action.rh).toEqual({ native: (E18 * 5n) / 10_000n, USDG: 1000n * E6 });
    for (const c of ["base", "arbitrum", "optimism"] as const) expect(s.treasury[c].native).toBe(E18 / 10n);
    expect(log.warns).toEqual([
      "!!! getState: agent token read reverted — tokens omitted from state; check agentTokenAddress (execution reverted) !!!",
    ]);
  });

  it("M3F §2: only ONE of the two token reads fails (treasury or action) ⇒ tokens omitted from BOTH slices", async () => {
    for (const mode of ["treasuryToken", "actionToken"] as const) {
      const { read, fail, log } = reader();
      fail.mode = mode;
      const s = await read();
      expect("staleChains" in s, mode).toBe(false);
      expect("tokens" in s.treasury.rh, mode).toBe(false);
      expect("tokens" in s.action.rh, mode).toBe(false);
      expect(log.warns, mode).toHaveLength(1);
      expect(log.warns[0], mode).toMatch(TOKEN_WARN);
    }
  });

  it("M3F §2: a non-bigint token result is the same degraded read (not a stale rh)", async () => {
    const { read, fail, log } = reader();
    fail.mode = "tokenGarbage";
    const s = await read();
    expect("staleChains" in s).toBe(false);
    expect("tokens" in s.treasury.rh).toBe(false);
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]).toMatch(/agent token read reverted.*balanceOf\(.*\)@rh: expected bigint, got string/);
  });

  it("M3F §2: one warn PER READ ATTEMPT; recovery restores tokens on the next read (no stale, no warn)", async () => {
    const { read, fail, log } = reader();
    fail.mode = "bothTokens";
    await read();
    await read();
    expect(log.warns).toHaveLength(2);
    fail.mode = "none";
    const s = await read();
    expect(s.treasury.rh.tokens).toEqual({ [AGENT_TOKEN]: 1000n * E18 });
    expect(s.action.rh.tokens).toEqual({ [AGENT_TOKEN]: 500n * E18 });
    expect(log.warns).toHaveLength(2);
  });

  it("M3F §2: all rh reads fail ⇒ rh STILL stale (grouping intact): zeros WITH zero tokens, only the chain warning", async () => {
    const { read, fail, log } = reader();
    fail.mode = "allRh";
    const s = await read();
    expect(s.staleChains).toEqual(["rh"]);
    expect(s.treasury.rh).toEqual({ native: 0n, USDC: 0n, USDG: 0n, tokens: { [AGENT_TOKEN]: 0n } });
    expect(s.action.rh).toEqual({ native: 0n, USDG: 0n, tokens: { [AGENT_TOKEN]: 0n } });
    expect(log.warns).toEqual(["!!! getState: rh reads FAILED (rh rpc down) — using zeros; spends touching rh deny STATE_STALE !!!"]);
  });

  it("M3F §2: a NON-token rh read failing still stales all of rh (only the token reads are carved out)", async () => {
    const { read, fail, log } = reader();
    fail.mode = "treasuryUsdg";
    const s = await read();
    expect(s.staleChains).toEqual(["rh"]);
    expect(log.warns).toEqual(["!!! getState: rh reads FAILED (rh USDG read failed) — using zeros; spends touching rh deny STATE_STALE !!!"]);
  });

  it("M3F §2: a degraded read is cached as-is (no tokens); a later full rh failure serves it, stale", async () => {
    let now: UnixSeconds = NOW;
    const { read, fail, log } = reader(() => now);
    fail.mode = "bothTokens";
    const degraded = await read();
    fail.mode = "allRh";
    now = NOW + 5n;
    const s = await read();
    expect(s.staleChains).toEqual(["rh"]);
    expect(s.treasury.rh).toEqual(degraded.treasury.rh);
    expect(s.action.rh).toEqual(degraded.action.rh);
    expect(log.warns[1]).toBe("!!! getState: rh reads FAILED (rh rpc down) — using cached values (age 5s); spends touching rh deny STATE_STALE !!!");
  });
});

describe("M3F §2: consumers of a token-less state (missing token entry ⇒ 0)", () => {
  async function states(): Promise<{ full: WalletState; degraded: WalletState }> {
    const r = reader();
    const full = await r.read();
    r.fail.mode = "bothTokens";
    const degraded = await r.read();
    expect(full.treasury.rh.tokens).toBeDefined();
    expect(degraded.treasury.rh.tokens).toBeUndefined();
    return { full, degraded };
  }

  it("M3F §2: engine — registration / allowance / gasTopUp allowed and IDENTICAL to the token-bearing state", async () => {
    const { full, degraded } = await states();
    const cfg = mkCfg();
    const actions: ProposedAction[] = [
      { kind: "registerInstance" },
      { kind: "heartbeat" },
      { kind: "allowance", amount: 500n * E6 },
      { kind: "treasuryTransfer", purpose: "gasTopUp", chain: "rh", asset: "ETH", to: cfg.action, amount: 2_500_000_000_000_000n },
    ];
    for (const a of actions) {
      const vd = evaluate(a, degraded, mkLedger(), cfg, NOW);
      expectAllow(vd);
      expect(vd, a.kind).toEqual(evaluate(a, full, mkLedger(), cfg, NOW));
    }
  });

  it("M3F §2: token-spending rules read the missing entry as 0 ⇒ deny INSUFFICIENT_BALANCE (no overshoot possible)", async () => {
    const { full, degraded } = await states();
    const cfg = mkCfg();
    expect(rhBalanceOf(degraded.action, AGENT_TOKEN)).toBe(0n);
    expect(rhBalanceOf(degraded.treasury, AGENT_TOKEN)).toBe(0n);
    expect(rhBalanceOf(full.action, AGENT_TOKEN)).toBe(500n * E18);

    const swap: ProposedAction = { kind: "treasurySwap", tokenIn: AGENT_TOKEN, amountIn: 1n, minOut: 1n };
    expectAllow(evaluate(swap, full, mkLedger(), cfg, NOW));
    expectDeny(evaluate(swap, degraded, mkLedger(), cfg, NOW), "INSUFFICIENT_BALANCE");

    const sell: ProposedAction = { kind: "actionSwap", tokenIn: AGENT_TOKEN, tokenOut: "USDG", amountIn: 1n, minOut: 1n };
    expectAllow(evaluate(sell, full, mkLedger(), cfg, NOW));
    expectDeny(evaluate(sell, degraded, mkLedger(), cfg, NOW), "INSUFFICIENT_BALANCE");
  });

  it("M3F §2: runway / tier math is unaffected by absent tokens (fundable = arb USDC + haircut rh USDG only)", async () => {
    const { full, degraded } = await states();
    const cfg = mkCfg();
    const rd = runwayDays(degraded, NOW, undefined, cfg.bridgeHaircutBps);
    expect(rd).toBe(runwayDays(full, NOW, undefined, cfg.bridgeHaircutBps));
    expect(tierOf(rd)).toBe(tierOf(runwayDays(full, NOW, undefined, cfg.bridgeHaircutBps)));
    expect(tierOf(rd)).toBe("Active");
  });
});
