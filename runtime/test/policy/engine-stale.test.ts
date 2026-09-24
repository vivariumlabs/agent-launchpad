// SPEC-M3C §2/§3: chainsTouched ruling + the engine's G5 STATE_STALE gate (after G1, before the
// rule modules). Degraded (cached/zeroed) chain state must never drive a spend; social/journal
// kinds touch no chain balances and are never stale-blocked.

import { describe, expect, it } from "vitest";
import { chainsTouched, type Chain, type ProposedAction, type WalletState } from "../../src/policy/types.js";
import {
  CP, E18, E6, MARLIN_PAY, SPOKE, SWAP_ROUTER, TOKEN_X, TREASURY,
  ev, expectAllow, expectDeny, mkState, raw,
} from "./helpers.js";

const ALL: readonly Chain[] = ["rh", "base", "arbitrum", "optimism"];

// One valid instance of every kind (all allowed under default fixtures) + an acrossBridge transfer.
const VALID: Record<ProposedAction["kind"], ProposedAction> = {
  heartbeat: { kind: "heartbeat" },
  registerInstance: { kind: "registerInstance" },
  distribute: { kind: "distribute" },
  treasuryTransfer: { kind: "treasuryTransfer", purpose: "oysterRental", chain: "arbitrum", asset: "USDC", to: MARLIN_PAY, amount: 10n * E6 },
  allowance: { kind: "allowance", amount: 100n * E6 },
  treasurySwap: { kind: "treasurySwap", tokenIn: TOKEN_X, amountIn: E18, minOut: 1n },
  inference: { kind: "inference", category: "pulse", endpointId: "inf-cheap", maxCostUsd: 100_000n },
  actionTransfer: { kind: "actionTransfer", asset: "ETH", to: CP, amount: E18 / 10n },
  actionSwap: { kind: "actionSwap", tokenIn: "USDG", tokenOut: TOKEN_X, amountIn: 10n * E6, minOut: 0n },
  actionLp: { kind: "actionLp", pool: `0x${"ab".repeat(32)}`, usdgAmount: 10n * E6, tokenAmount: E18, token: TOKEN_X },
  actionMint: { kind: "actionMint", target: CP, value: E18 / 100n },
  castPost: { kind: "castPost", contentHash: `0x${"11".repeat(32)}` },
  castReply: { kind: "castReply", contentHash: `0x${"22".repeat(32)}`, parentHash: `0x${"33".repeat(32)}` },
  journalWrite: { kind: "journalWrite", contentHash: `0x${"44".repeat(32)}`, sizeBytes: 1024n },
  actionApprove: { kind: "actionApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: E18 },
  treasuryApprove: { kind: "treasuryApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: E18 },
};
const BRIDGE: ProposedAction = {
  kind: "treasuryTransfer", purpose: "acrossBridge", chain: "rh", asset: "USDG", to: SPOKE.rh, amount: E6, recipient: TREASURY, destChain: "base",
};

const SOCIAL = new Set<ProposedAction["kind"]>(["castPost", "castReply", "journalWrite"]);
const RH_KINDS: ReadonlyArray<ProposedAction["kind"]> = [
  "heartbeat", "registerInstance", "distribute", "allowance", "treasurySwap", "treasuryApprove",
  "actionTransfer", "actionSwap", "actionLp", "actionMint", "actionApprove",
];
const SPENDS: ProposedAction[] = [...Object.values(VALID).filter((a) => !SOCIAL.has(a.kind)), BRIDGE];

const stale = (chains: readonly Chain[]): WalletState => mkState({ staleChains: chains });

describe("M3C: chainsTouched ruling (SPEC-M3C §2)", () => {
  it("M3C: rh kinds ⇒ [rh]; inference ⇒ [base]; social/journal ⇒ []", () => {
    for (const k of RH_KINDS) expect(chainsTouched(VALID[k]), k).toEqual(["rh"]);
    expect(chainsTouched(VALID.inference)).toEqual(["base"]);
    for (const k of SOCIAL) expect(chainsTouched(VALID[k]), k).toEqual([]);
  });
  it("M3C: treasuryTransfer ⇒ [chain], acrossBridge ⇒ [chain, destChain]", () => {
    expect(chainsTouched(VALID.treasuryTransfer)).toEqual(["arbitrum"]);
    expect(chainsTouched(BRIDGE)).toEqual(["rh", "base"]);
    for (const c of ALL) {
      expect(chainsTouched({ kind: "treasuryTransfer", purpose: "gasTopUp", chain: c, asset: "ETH", to: TREASURY, amount: 1n })).toEqual([c]);
    }
  });
});

describe("M3C: engine G5 STATE_STALE gate (SPEC-M3C §3)", () => {
  it("M3C: sanity — every fixture is allowed with fresh state (staleChains absent or empty)", () => {
    for (const a of [...Object.values(VALID), BRIDGE]) {
      expectAllow(ev(a));
      expectAllow(ev(a, { state: stale([]) }));
    }
  });

  it("M3C: every spend kind is denied STATE_STALE when ANY chain it touches is stale", () => {
    for (const a of SPENDS) {
      for (const c of chainsTouched(a)) {
        const v = ev(a, { state: stale([c]) });
        expectDeny(v, "STATE_STALE");
        if (!v.allow) {
          expect(v.detail).toBe(`G5: balances for ${c} are stale (RPC unreachable) — refusing to act on degraded state`);
        }
      }
      expectDeny(ev(a, { state: stale(ALL) }), "STATE_STALE");
    }
  });

  it("M3C: rh kinds are UNAFFECTED by staleChains [optimism]", () => {
    for (const k of RH_KINDS) expectAllow(ev(VALID[k], { state: stale(["optimism"]) }));
  });

  it("M3C: a spend is unaffected by staleness on chains it does not touch", () => {
    for (const a of SPENDS) {
      const touched = chainsTouched(a);
      const others = ALL.filter((c) => !touched.includes(c));
      expectAllow(ev(a, { state: stale(others) }));
    }
  });

  it("M3C: castPost / castReply / journalWrite are allowed with ALL chains stale", () => {
    for (const k of SOCIAL) expectAllow(ev(VALID[k], { state: stale(ALL) }));
  });

  it("M3C: acrossBridge treasuryTransfer is denied when ONLY its destChain is stale", () => {
    const v = ev(BRIDGE, { state: stale(["base"]) });
    expectDeny(v, "STATE_STALE");
    if (!v.allow) expect(v.detail).toMatch(/^G5: balances for base are stale/);
  });

  it("M3C: the detail lists every stale touched chain (chainsTouched order)", () => {
    const v = ev(BRIDGE, { state: stale(["base", "rh"]) });
    expectDeny(v, "STATE_STALE");
    if (!v.allow) expect(v.detail).toMatch(/^G5: balances for rh, base are stale/);
  });

  it("M3C: G1 runs first (malformed + stale ⇒ MALFORMED); a non-array staleChains fails closed (MALFORMED)", () => {
    expectDeny(ev(raw({ kind: "heartbeat", extra: 1 }), { state: stale(ALL) }), "MALFORMED");
    expectDeny(ev(VALID.heartbeat, { state: { ...mkState(), staleChains: "rh" as unknown as Chain[] } }), "MALFORMED");
  });

  it("M3C: the gate is pure — state is not mutated and repeated calls agree", () => {
    const s = stale(["rh"]);
    const before = JSON.stringify(s, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    const v1 = ev(VALID.heartbeat, { state: s });
    const v2 = ev(VALID.heartbeat, { state: s });
    expect(v1).toEqual(v2);
    expect(JSON.stringify(s, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).toBe(before);
  });
});
