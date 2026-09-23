// SPEC-M2B §1: S1 / S2 / J1 (social + journal pace caps), AP1 / AP2 (approvals),
// acrossBridge destChain (G1), walletForAction extension, ledger pace counters (G4).

import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { applyApproved, emptyLedger, rollLedger } from "../../src/ledger/ledger.js";
import { evaluate } from "../../src/policy/engine.js";
import { evaluateSocial } from "../../src/policy/rules/social.js";
import { walletForAction, type Chain, type ProposedAction } from "../../src/policy/types.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import {
  CP, DAY, DAY0, E18, E6, NOW, SPOKE, SWAP_ROUTER, TOKEN_X, TOKEN_Y, TREASURY, USDG_RH,
  cfg, ev, expectAllow, expectDeny, mkCfg, mkLedger, mkState, raw,
} from "./helpers.js";

const H1 = `0x${"11".repeat(32)}` as `0x${string}`;
const H2 = `0x${"22".repeat(32)}` as `0x${string}`;
const LP_ROUTER = "0x5b0000010000000000000000000000000005b1ab" as `0x${string}`;

const post: ProposedAction = { kind: "castPost", contentHash: H1 };
const reply: ProposedAction = { kind: "castReply", contentHash: H1, parentHash: H2 };
const journal = (sizeBytes: bigint): ProposedAction => ({ kind: "journalWrite", contentHash: H1, sizeBytes });

function withSocial(postsPerDay: number, repliesPerDay: number, base: ResolvedConfig = cfg): ResolvedConfig {
  return { ...base, agent: { ...base.agent, social: { postsPerDay, repliesPerDay } } };
}

// ---------------------------------------------------------------------------
// walletForAction / dispatch
// ---------------------------------------------------------------------------

describe("walletForAction (SPEC-M2B §1)", () => {
  it("social kinds → fc, journal → journal, approvals → own wallets", () => {
    expect(walletForAction("castPost")).toBe("fc");
    expect(walletForAction("castReply")).toBe("fc");
    expect(walletForAction("journalWrite")).toBe("journal");
    expect(walletForAction("actionApprove")).toBe("action");
    expect(walletForAction("treasuryApprove")).toBe("treasury");
  });
  it("unknown kind throws", () => {
    expect(() => walletForAction("nope" as ProposedAction["kind"])).toThrow();
  });
  it("G2: social rule module denies every non-social kind with NO_RULE", () => {
    const others: ProposedAction[] = [
      { kind: "heartbeat" },
      { kind: "allowance", amount: E6 },
      { kind: "actionTransfer", asset: "ETH", to: CP, amount: 1n },
      { kind: "actionApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: 1n },
      { kind: "treasuryApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: 1n },
    ];
    for (const a of others) expectDeny(evaluateSocial(a, mkLedger(), cfg, NOW), "NO_RULE");
  });
  it("fc/journal kinds are evaluated with NO balance access (structurally broken state still allows)", () => {
    const broken = raw({}) as unknown as Parameters<typeof evaluate>[1];
    expectAllow(evaluate(post, broken, mkLedger(), cfg, NOW));
    expectAllow(evaluate(reply, broken, mkLedger(), cfg, NOW));
    expectAllow(evaluate(journal(10n), broken, mkLedger(), cfg, NOW));
  });
});

// ---------------------------------------------------------------------------
// G1 shape for the new kinds
// ---------------------------------------------------------------------------

describe("G1: new kinds ⇒ MALFORMED on bad shape", () => {
  const cases: Array<[string, unknown]> = [
    ["castPost missing contentHash", { kind: "castPost" }],
    ["castPost contentHash 20 bytes", { kind: "castPost", contentHash: `0x${"11".repeat(20)}` }],
    ["castPost contentHash non-hex", { kind: "castPost", contentHash: `0x${"zz".repeat(32)}` }],
    ["castPost extra field", { kind: "castPost", contentHash: H1, text: "hi" }],
    ["castReply missing parentHash", { kind: "castReply", contentHash: H1 }],
    ["castReply parentHash 31 bytes (S2 G1)", { kind: "castReply", contentHash: H1, parentHash: `0x${"22".repeat(31)}` }],
    ["castReply parentHash 33 bytes", { kind: "castReply", contentHash: H1, parentHash: `0x${"22".repeat(33)}` }],
    ["castReply parentHash no 0x", { kind: "castReply", contentHash: H1, parentHash: "22".repeat(32) }],
    ["journalWrite sizeBytes 0n", { kind: "journalWrite", contentHash: H1, sizeBytes: 0n }],
    ["journalWrite sizeBytes negative", { kind: "journalWrite", contentHash: H1, sizeBytes: -1n }],
    ["journalWrite sizeBytes number", { kind: "journalWrite", contentHash: H1, sizeBytes: 10 }],
    ["journalWrite missing contentHash", { kind: "journalWrite", sizeBytes: 10n }],
    ["actionApprove amount 0n", { kind: "actionApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: 0n }],
    ["actionApprove bad spender", { kind: "actionApprove", token: TOKEN_X, spender: "0x1234", amount: 1n }],
    ["actionApprove token 'USDG' symbol", { kind: "actionApprove", token: "USDG", spender: SWAP_ROUTER, amount: 1n }],
    ["actionApprove extra field", { kind: "actionApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: 1n, chain: "rh" }],
    ["treasuryApprove amount negative", { kind: "treasuryApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: -1n }],
    ["treasuryApprove missing spender", { kind: "treasuryApprove", token: TOKEN_X, amount: 1n }],
  ];
  for (const [name, input] of cases) {
    it(`G1: ${name} ⇒ MALFORMED`, () => expectDeny(ev(raw(input)), "MALFORMED"));
  }
});

// ---------------------------------------------------------------------------
// S1 castPost
// ---------------------------------------------------------------------------

describe("S1: castPost pace cap", () => {
  it("S1: allowed while castPostsToday < postsPerDay", () => {
    const c = withSocial(3, 1);
    expectAllow(ev(post, { cfg: c, ledger: mkLedger({ castPostsToday: 0n }) }));
    expectAllow(ev(post, { cfg: c, ledger: mkLedger({ castPostsToday: 2n }) }));
  });
  it("S1: boundary — castPostsToday == postsPerDay ⇒ PACE_CAP", () => {
    const c = withSocial(3, 1);
    expectDeny(ev(post, { cfg: c, ledger: mkLedger({ castPostsToday: 3n }) }), "PACE_CAP");
    expectDeny(ev(post, { cfg: c, ledger: mkLedger({ castPostsToday: 99n }) }), "PACE_CAP");
  });
  it("S1: postsPerDay 0 ⇒ every post denied", () => {
    expectDeny(ev(post, { cfg: withSocial(0, 1), ledger: mkLedger() }), "PACE_CAP");
  });
  it("S1: platform bound — agent postsPerDay 50 is clamped to postsPerDayMax 8 (DEFAULT)", () => {
    const c = withSocial(50, 1);
    expect(c.postsPerDayMax).toBe(8);
    expectAllow(ev(post, { cfg: c, ledger: mkLedger({ castPostsToday: 7n }) }));
    expectDeny(ev(post, { cfg: c, ledger: mkLedger({ castPostsToday: 8n }) }), "PACE_CAP");
  });
  it("S1: platform bound is itself configurable (postsPerDayMax override)", () => {
    const c = withSocial(50, 1, mkCfg({ postsPerDayMax: 2 }));
    expectAllow(ev(post, { cfg: c, ledger: mkLedger({ castPostsToday: 1n }) }));
    expectDeny(ev(post, { cfg: c, ledger: mkLedger({ castPostsToday: 2n }) }), "PACE_CAP");
  });
  it("S1: reply counter does not affect posts", () => {
    expectAllow(ev(post, { cfg: withSocial(1, 1), ledger: mkLedger({ castRepliesToday: 100n }) }));
  });
});

// ---------------------------------------------------------------------------
// S2 castReply
// ---------------------------------------------------------------------------

describe("S2: castReply pace cap", () => {
  it("S2: allowed while castRepliesToday < repliesPerDay", () => {
    const c = withSocial(1, 5);
    expectAllow(ev(reply, { cfg: c, ledger: mkLedger({ castRepliesToday: 4n }) }));
  });
  it("S2: boundary — castRepliesToday == repliesPerDay ⇒ PACE_CAP", () => {
    expectDeny(ev(reply, { cfg: withSocial(1, 5), ledger: mkLedger({ castRepliesToday: 5n }) }), "PACE_CAP");
  });
  it("S2: platform bound — agent repliesPerDay 100 clamped to repliesPerDayMax 30 (DEFAULT)", () => {
    const c = withSocial(1, 100);
    expect(c.repliesPerDayMax).toBe(30);
    expectAllow(ev(reply, { cfg: c, ledger: mkLedger({ castRepliesToday: 29n }) }));
    expectDeny(ev(reply, { cfg: c, ledger: mkLedger({ castRepliesToday: 30n }) }), "PACE_CAP");
  });
  it("S2: post counter does not affect replies", () => {
    expectAllow(ev(reply, { cfg: withSocial(1, 1), ledger: mkLedger({ castPostsToday: 100n }) }));
  });
});

// ---------------------------------------------------------------------------
// J1 journalWrite
// ---------------------------------------------------------------------------

describe("J1: journalWrite", () => {
  it("J1: DEFAULTs journalDailyCap 4, journalMaxBytes 65536", () => {
    expect(cfg.journalDailyCap).toBe(4);
    expect(cfg.journalMaxBytes).toBe(65_536n);
  });
  it("J1: allowed below daily cap and at exactly journalMaxBytes", () => {
    expectAllow(ev(journal(65_536n), { ledger: mkLedger({ journalToday: 3n }) }));
    expectAllow(ev(journal(1n)));
  });
  it("J1: sizeBytes journalMaxBytes + 1 ⇒ MALFORMED", () => {
    expectDeny(ev(journal(65_537n)), "MALFORMED");
  });
  it("J1: journalToday == cap ⇒ PACE_CAP", () => {
    expectDeny(ev(journal(10n), { ledger: mkLedger({ journalToday: 4n }) }), "PACE_CAP");
  });
  it("J1: oversize AND over-pace ⇒ MALFORMED checked first", () => {
    expectDeny(ev(journal(65_537n), { ledger: mkLedger({ journalToday: 4n }) }), "MALFORMED");
  });
  it("J1: caps are config-driven", () => {
    const c = mkCfg({ journalDailyCap: 1, journalMaxBytes: "100" });
    expectAllow(ev(journal(100n), { cfg: c }));
    expectDeny(ev(journal(101n), { cfg: c }), "MALFORMED");
    expectDeny(ev(journal(100n), { cfg: c, ledger: mkLedger({ journalToday: 1n }) }), "PACE_CAP");
  });
});

// ---------------------------------------------------------------------------
// Ledger pace counters (applyApproved + G4)
// ---------------------------------------------------------------------------

describe("ledger pace counters", () => {
  it("emptyLedger zeroes the new counters", () => {
    const L = emptyLedger(NOW);
    expect([L.castPostsToday, L.castRepliesToday, L.journalToday]).toEqual([0n, 0n, 0n]);
  });
  it("applyApproved increments exactly the matching counter", () => {
    let L = mkLedger();
    L = applyApproved(L, post, NOW);
    expect([L.castPostsToday, L.castRepliesToday, L.journalToday]).toEqual([1n, 0n, 0n]);
    L = applyApproved(L, reply, NOW);
    L = applyApproved(L, reply, NOW);
    expect([L.castPostsToday, L.castRepliesToday, L.journalToday]).toEqual([1n, 2n, 0n]);
    L = applyApproved(L, journal(5n), NOW);
    expect([L.castPostsToday, L.castRepliesToday, L.journalToday]).toEqual([1n, 2n, 1n]);
  });
  it("approvals book no budget bucket", () => {
    const L = mkLedger();
    expect(applyApproved(L, { kind: "actionApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: 1n }, NOW)).toEqual(L);
    expect(applyApproved(L, { kind: "treasuryApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: 1n }, NOW)).toEqual(L);
  });
  it("G4: forward day roll resets the counters", () => {
    const L = mkLedger({ castPostsToday: 5n, castRepliesToday: 6n, journalToday: 7n });
    const R = rollLedger(L, DAY0 + DAY);
    expect([R.castPostsToday, R.castRepliesToday, R.journalToday]).toEqual([0n, 0n, 0n]);
  });
  it("G4: rewound clock keeps the counters (no reset)", () => {
    const L = mkLedger({ castPostsToday: 5n, castRepliesToday: 6n, journalToday: 7n });
    expect(rollLedger(L, NOW - DAY)).toBe(L);
  });
  it("G4 (engine view): exhausted post cap stays exhausted on clock rewind; next UTC day allows", () => {
    const c = withSocial(2, 1);
    const L = mkLedger({ castPostsToday: 2n, journalToday: 4n });
    expectDeny(ev(post, { cfg: c, ledger: L, now: NOW - DAY }), "PACE_CAP");
    expectDeny(ev(journal(1n), { ledger: L, now: NOW - DAY }), "PACE_CAP");
    const midnight = DAY0 + DAY;
    expectDeny(ev(post, { cfg: c, ledger: L, now: midnight - 1n }), "PACE_CAP");
    expectAllow(ev(post, { cfg: c, ledger: L, now: midnight }));
    expectAllow(ev(journal(1n), { ledger: L, now: midnight }));
  });
  it("engine+reducer sequence: exactly postsPerDay posts per UTC day", () => {
    const c = withSocial(3, 1);
    let L = mkLedger();
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      const v = evaluate(post, mkState(), L, c, NOW + BigInt(i));
      if (v.allow) {
        allowed++;
        L = applyApproved(L, post, NOW + BigInt(i));
      } else expectDeny(v, "PACE_CAP");
    }
    expect(allowed).toBe(3);
    const next = DAY0 + DAY + 10n;
    expectAllow(evaluate(post, mkState(), L, c, next));
  });
});

// ---------------------------------------------------------------------------
// AP1 actionApprove
// ---------------------------------------------------------------------------

describe("AP1: actionApprove", () => {
  // default action wallet: 1000 USDG, 500 TOKEN_X, 500 TOKEN_Y on rh ⇒ A1 caps 200 USDG / 100 TOKEN_X
  const ap = (token: `0x${string}`, spender: `0x${string}`, amount: bigint): ProposedAction => ({ kind: "actionApprove", token, spender, amount });

  it("AP1: swap router spender, token amount ≤ 20% ⇒ allow", () => {
    expectAllow(ev(ap(TOKEN_X, SWAP_ROUTER, 100n * E18)));
  });
  it("AP1: spender match is case-insensitive (checksummed)", () => {
    expectAllow(ev(ap(TOKEN_X, getAddress(SWAP_ROUTER), E18)));
  });
  it("AP1: USDG referenced by token address is allowed (exempt from USDG-by-address NO_RULE); cap basis = USDG balance", () => {
    expectAllow(ev(ap(USDG_RH, SWAP_ROUTER, 200n * E6)));
    expectDeny(ev(ap(USDG_RH, SWAP_ROUTER, 200n * E6 + 1n)), "PER_TX_CAP");
    expectAllow(ev(ap(getAddress(USDG_RH), SWAP_ROUTER, E6)));
  });
  it("AP1: A1 boundary on token — exactly 20% allow, +1 PER_TX_CAP", () => {
    expectAllow(ev(ap(TOKEN_Y, SWAP_ROUTER, 100n * E18)));
    expectDeny(ev(ap(TOKEN_Y, SWAP_ROUTER, 100n * E18 + 1n)), "PER_TX_CAP");
  });
  it("AP1: amount > balance ⇒ INSUFFICIENT_BALANCE (G3)", () => {
    expectDeny(ev(ap(TOKEN_X, SWAP_ROUTER, 501n * E18)), "INSUFFICIENT_BALANCE");
  });
  it("AP1: token not held ⇒ INSUFFICIENT_BALANCE", () => {
    expectDeny(ev(ap(CP, SWAP_ROUTER, 1n)), "INSUFFICIENT_BALANCE");
  });
  it("AP1: rogue spender ⇒ APPROVE_SPENDER (checked before balance)", () => {
    for (const s of [CP, TREASURY, SPOKE.rh, cfg.poolManager.rh, cfg.feeSplitHook.rh, USDG_RH]) {
      expectDeny(ev(ap(TOKEN_X, s, 1n)), "APPROVE_SPENDER");
      expectDeny(ev(ap(TOKEN_X, s, 10_000n * E18)), "APPROVE_SPENDER");
    }
  });
  it("AP1: modifyLiquidityRouter spender allowed only when configured", () => {
    expectDeny(ev(ap(TOKEN_X, LP_ROUTER, E18)), "APPROVE_SPENDER");
    const c = { ...cfg, modifyLiquidityRouter: { rh: LP_ROUTER } };
    expectAllow(ev(ap(TOKEN_X, LP_ROUTER, E18), { cfg: c }));
  });
  it("AP1: A3 does not apply — approving a token whose address collides with a protected prefix still allows if caps pass", () => {
    // spender is canonical by construction; token address is what's approved, not a recipient.
    const s = mkState();
    const collider = `0x${TREASURY.slice(2, 10)}${"7".repeat(32)}` as `0x${string}`;
    s.action.rh = { ...s.action.rh, tokens: { ...s.action.rh.tokens, [collider]: 100n } };
    expectAllow(ev(ap(collider, SWAP_ROUTER, 20n), { state: s }));
  });
  it("AP1: evaluated against the ACTION wallet only", () => {
    const s = mkState();
    s.action.rh = { ...s.action.rh, tokens: {} };
    expectDeny(ev(ap(TOKEN_X, SWAP_ROUTER, 1n), { state: s }), "INSUFFICIENT_BALANCE");
  });
});

// ---------------------------------------------------------------------------
// AP2 treasuryApprove
// ---------------------------------------------------------------------------

describe("AP2: treasuryApprove", () => {
  // default treasury: 1000 TOKEN_X on rh, 10_000 USDG
  const tap = (token: `0x${string}`, spender: `0x${string}`, amount: bigint): ProposedAction => ({ kind: "treasuryApprove", token, spender, amount });

  it("AP2: swap router, held token, amount ≤ balance ⇒ allow (full balance OK — no 20% cap)", () => {
    expectAllow(ev(tap(TOKEN_X, SWAP_ROUTER, 1000n * E18)));
    expectAllow(ev(tap(TOKEN_X, getAddress(SWAP_ROUTER), 1n)));
  });
  it("AP2: amount balance + 1 ⇒ INSUFFICIENT_BALANCE", () => {
    expectDeny(ev(tap(TOKEN_X, SWAP_ROUTER, 1000n * E18 + 1n)), "INSUFFICIENT_BALANCE");
  });
  it("AP2: token not held by treasury ⇒ INSUFFICIENT_BALANCE", () => {
    expectDeny(ev(tap(TOKEN_Y, SWAP_ROUTER, 1n)), "INSUFFICIENT_BALANCE");
  });
  it("AP2: USDG token ⇒ NO_RULE", () => {
    expectDeny(ev(tap(USDG_RH, SWAP_ROUTER, 1n)), "NO_RULE");
    expectDeny(ev(tap(getAddress(USDG_RH), SWAP_ROUTER, 1n)), "NO_RULE");
  });
  it("AP2: rogue spender ⇒ APPROVE_SPENDER", () => {
    expectDeny(ev(tap(TOKEN_X, CP, 1n)), "APPROVE_SPENDER");
  });
  it("AP2: modifyLiquidityRouter is NOT a valid treasury spender even when configured", () => {
    const c = { ...cfg, modifyLiquidityRouter: { rh: LP_ROUTER } };
    expectDeny(ev(tap(TOKEN_X, LP_ROUTER, 1n), { cfg: c }), "APPROVE_SPENDER");
  });
  it("AP2: T0-exempt (not an outflow) — allowed with runway far below 45d", () => {
    const s = mkState({ hostingPaidUntil: NOW - 100n * DAY });
    s.treasury.rh = { ...s.treasury.rh, USDG: 0n };
    s.treasury.arbitrum = { ...s.treasury.arbitrum, USDC: 0n };
    expectAllow(ev(tap(TOKEN_X, SWAP_ROUTER, E18), { state: s }));
  });
  it("AP2: evaluated against the TREASURY wallet only", () => {
    const s = mkState();
    s.treasury.rh = { ...s.treasury.rh, tokens: {} };
    s.action.rh = { ...s.action.rh, tokens: { [TOKEN_X]: 10_000n * E18 } };
    expectDeny(ev(tap(TOKEN_X, SWAP_ROUTER, 1n), { state: s }), "INSUFFICIENT_BALANCE");
  });
});

// ---------------------------------------------------------------------------
// acrossBridge destChain (SPEC-M2B §3, G1-level)
// ---------------------------------------------------------------------------

describe("G1: acrossBridge destChain", () => {
  const base = { kind: "treasuryTransfer", purpose: "acrossBridge", chain: "rh", asset: "USDG", to: SPOKE.rh, amount: 10n * E6, recipient: TREASURY } as const;
  it("destChain present and ≠ source ⇒ allow (every dest)", () => {
    for (const d of ["base", "arbitrum", "optimism"] as Chain[]) expectAllow(ev({ ...base, destChain: d }));
  });
  it("destChain missing on acrossBridge ⇒ MALFORMED", () => {
    expectDeny(ev(raw(base)), "MALFORMED");
  });
  it("destChain explicitly undefined on acrossBridge ⇒ MALFORMED", () => {
    expectDeny(ev(raw({ ...base, destChain: undefined })), "MALFORMED");
  });
  it("destChain == source chain ⇒ MALFORMED", () => {
    expectDeny(ev({ ...base, destChain: "rh" }), "MALFORMED");
    expectDeny(ev({ ...base, chain: "base", to: SPOKE.base, asset: "USDC", destChain: "base" }), "MALFORMED");
  });
  it("destChain unknown chain ⇒ MALFORMED", () => {
    expectDeny(ev(raw({ ...base, destChain: "polygon" })), "MALFORMED");
  });
  it("destChain on a non-bridge purpose ⇒ MALFORMED", () => {
    const rows: ProposedAction[] = [
      { kind: "treasuryTransfer", purpose: "oysterRental", chain: "arbitrum", asset: "USDC", to: cfg.marlin.paymentAddresses[0]!, amount: E6, destChain: "base" },
      { kind: "treasuryTransfer", purpose: "gasTopUp", chain: "rh", asset: "ETH", to: TREASURY, amount: 1n, destChain: "base" },
      { kind: "treasuryTransfer", purpose: "arweaveFunding", chain: "rh", asset: "USDG", to: cfg.arweaveFundingAddress, amount: 1n, destChain: "base" },
    ];
    for (const a of rows) expectDeny(ev(a), "MALFORMED");
  });
  it("destChain is part of the approval hash (different dest ⇒ different actionHash)", () => {
    const v1 = ev({ ...base, destChain: "base" });
    const v2 = ev({ ...base, destChain: "arbitrum" });
    if (!v1.allow || !v2.allow) throw new Error("expected allows");
    expect(v1.approval.actionHash).not.toBe(v2.approval.actionHash);
  });
});
