// SPEC-M2 §4 ledger reducers + UTC dayKey, and engine+reducer sequences.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyApproved, dayKeyOf, emptyLedger, recordFeeIncome, rollLedger } from "../../src/ledger/ledger.js";
import type { BudgetLedger, ProposedAction } from "../../src/policy/types.js";
import {
  ACTION, ARWEAVE, CP, DAY, DAY0, E18, E6, MARLIN_PAY, NOW, PAYTO_DATA, SPOKE, TOKEN_X, TREASURY,
  cfg, expectAllow, expectDeny, mkLedger, mkState,
} from "./helpers.js";
import { evaluate } from "../../src/policy/engine.js";

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object") {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

describe("dayKeyOf (Hinnant civil_from_days, no Date)", () => {
  const cases: Array<[bigint, string]> = [
    [0n, "1970-01-01"],
    [86_399n, "1970-01-01"],
    [86_400n, "1970-01-02"],
    [951_782_400n, "2000-02-29"],
    [951_782_399n, "2000-02-28"],
    [951_868_799n, "2000-02-29"],
    [951_868_800n, "2000-03-01"],
    [4_107_542_399n, "2100-02-28"], // 2100 is not a leap year
    [4_107_542_400n, "2100-03-01"],
    [DAY0 - 1n, "2026-09-22"],
    [DAY0, "2026-09-23"],
    [NOW, "2026-09-23"],
    [DAY0 + DAY - 1n, "2026-09-23"],
    [DAY0 + DAY, "2026-09-24"],
    [253_402_300_799n, "9999-12-31"],
  ];
  for (const [t, k] of cases) {
    it(`dayKeyOf(${t}) = ${k}`, () => expect(dayKeyOf(t)).toBe(k));
  }
  it("matches Date#toISOString for arbitrary timestamps (property, test-side oracle)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 253_402_300_799n }), (t) => {
        expect(dayKeyOf(t)).toBe(new Date(Number(t) * 1000).toISOString().slice(0, 10));
      }),
      { numRuns: 2000 },
    );
  });
});

describe("emptyLedger / rollLedger", () => {
  it("emptyLedger has zeroed buckets and today's dayKey", () => {
    expect(emptyLedger(NOW)).toEqual({
      lastAllowanceAt: 0n,
      allowanceAmountToday: 0n,
      dayKey: "2026-09-23",
      inferenceSpent: { pulse: 0n, chat: 0n, social: 0n },
      treasurySpent: {},
      counterpartySpent: {},
      feeIncome7d: [],
      castPostsToday: 0n,
      castRepliesToday: 0n,
      journalToday: 0n,
    });
  });
  it("rollLedger same day ⇒ same object", () => {
    const L = mkLedger();
    expect(rollLedger(L, NOW)).toBe(L);
  });
  it("G4: rollLedger with a rewound clock (previous day) ⇒ same object, buckets kept", () => {
    const L = mkLedger({ treasurySpent: { oysterRental: 100n * E6 }, inferenceSpent: { pulse: 1n, chat: 2n, social: 3n } });
    expect(rollLedger(L, NOW - DAY)).toBe(L);
    expect(rollLedger(L, NOW - 365n * DAY)).toBe(L);
    expect(rollLedger(L, 0n)).toBe(L);
  });
  it("rollLedger new day ⇒ daily buckets + allowanceAmountToday reset; lastAllowanceAt + feeIncome7d kept", () => {
    const L = mkLedger({
      lastAllowanceAt: NOW - 100n,
      allowanceAmountToday: 400n * E6,
      inferenceSpent: { pulse: 1n, chat: 2n, social: 3n },
      treasurySpent: { oysterRental: 5n, "gasTopUp:rh": 7n },
      counterpartySpent: { [CP]: { USDG: 9n, "ETH:denom": 11n } },
      feeIncome7d: [1n, 2n, 3n],
    });
    const R = rollLedger(L, DAY0 + DAY);
    expect(R).toEqual({
      lastAllowanceAt: NOW - 100n,
      allowanceAmountToday: 0n,
      dayKey: "2026-09-24",
      inferenceSpent: { pulse: 0n, chat: 0n, social: 0n },
      treasurySpent: {},
      counterpartySpent: {},
      feeIncome7d: [1n, 2n, 3n],
      castPostsToday: 0n,
      castRepliesToday: 0n,
      journalToday: 0n,
    });
  });
});

describe("applyApproved", () => {
  const tt = (purpose: Extract<ProposedAction, { kind: "treasuryTransfer" }>["purpose"], chain: "rh" | "base" | "arbitrum" | "optimism", asset: "USDG" | "USDC" | "ETH", to: `0x${string}`, amount: bigint, recipient?: `0x${string}`): ProposedAction =>
    recipient === undefined
      ? { kind: "treasuryTransfer", purpose, chain, asset, to, amount }
      : purpose === "acrossBridge" // SPEC-M2B: acrossBridge requires destChain ≠ chain
        ? { kind: "treasuryTransfer", purpose, chain, asset, to, amount, recipient, destChain: chain === "rh" ? "base" : "rh" }
        : { kind: "treasuryTransfer", purpose, chain, asset, to, amount, recipient };

  const bucketCases: Array<[string, ProposedAction, string]> = [
    ["oysterRental", tt("oysterRental", "arbitrum", "USDC", MARLIN_PAY, 5n), "oysterRental"],
    ["acrossBridge USDG", tt("acrossBridge", "rh", "USDG", SPOKE.rh, 5n, TREASURY), "acrossBridge"],
    ["acrossBridge USDC", tt("acrossBridge", "arbitrum", "USDC", SPOKE.arbitrum, 5n, TREASURY), "acrossBridge"],
    ["acrossBridge ETH from base ⇒ gasTopUp:base", tt("acrossBridge", "base", "ETH", SPOKE.base, 5n, TREASURY), "gasTopUp:base"],
    ["arweaveFunding", tt("arweaveFunding", "rh", "USDG", ARWEAVE, 5n), "arweaveFunding"],
    ["gasTopUp optimism ⇒ gasTopUp:optimism", tt("gasTopUp", "optimism", "ETH", ACTION, 5n), "gasTopUp:optimism"],
    ["x402Data", tt("x402Data", "base", "USDC", PAYTO_DATA, 5n), "x402Data"],
  ];
  for (const [name, a, key] of bucketCases) {
    it(`treasuryTransfer ${name} adds to treasurySpent["${key}"]`, () => {
      const L1 = applyApproved(mkLedger(), a, NOW);
      expect(L1.treasurySpent).toEqual({ [key]: 5n });
      const L2 = applyApproved(L1, a, NOW);
      expect(L2.treasurySpent).toEqual({ [key]: 10n });
    });
  }

  it("allowance sets lastAllowanceAt = now and allowanceAmountToday = amount", () => {
    const L = applyApproved(mkLedger(), { kind: "allowance", amount: 321n }, NOW);
    expect(L.lastAllowanceAt).toBe(NOW);
    expect(L.allowanceAmountToday).toBe(321n);
  });

  it("inference adds maxCostUsd to its category only", () => {
    let L = applyApproved(mkLedger(), { kind: "inference", category: "chat", endpointId: "inf-cheap", maxCostUsd: 7n }, NOW);
    L = applyApproved(L, { kind: "inference", category: "chat", endpointId: "inf-cheap", maxCostUsd: 3n }, NOW);
    expect(L.inferenceSpent).toEqual({ pulse: 0n, chat: 10n, social: 0n });
  });

  it("actionTransfer USDG: lowercase counterparty key, 'USDG' asset key, no denominator snapshot", () => {
    const L = applyApproved(mkLedger(), { kind: "actionTransfer", asset: "USDG", to: CP.toUpperCase().replace("0X", "0x") as `0x${string}`, amount: 4n }, NOW, mkState());
    expect(L.counterpartySpent).toEqual({ [CP.toLowerCase()]: { USDG: 4n } });
  });
  it("actionTransfer ETH first send of the day snapshots the pre-send balance as denominator", () => {
    const s = mkState(); // action native 1 ETH
    const L1 = applyApproved(mkLedger(), { kind: "actionTransfer", asset: "ETH", to: CP, amount: 10n }, NOW, s);
    expect(L1.counterpartySpent[CP]).toEqual({ ETH: 10n, "ETH:denom": E18 });
    // second send: snapshot NOT overwritten even if balance changed
    const s2 = mkState();
    s2.action.rh = { ...s2.action.rh, native: 5n };
    const L2 = applyApproved(L1, { kind: "actionTransfer", asset: "ETH", to: CP, amount: 1n }, NOW, s2);
    expect(L2.counterpartySpent[CP]).toEqual({ ETH: 11n, "ETH:denom": E18 });
  });
  it("actionTransfer token: lowercased token address asset key + snapshot", () => {
    const L = applyApproved(mkLedger(), { kind: "actionTransfer", asset: TOKEN_X, to: CP, amount: 2n }, NOW, mkState());
    const k = TOKEN_X.toLowerCase();
    expect(L.counterpartySpent[CP]).toEqual({ [k]: 2n, [`${k}:denom`]: 500n * E18 });
  });
  it("A2 rev 2: actionMint records counterpartySpent[target].ETH (lowercased) + ETH denom snapshot on first send", () => {
    const s = mkState(); // action native 1 ETH
    const T = CP.toUpperCase().replace("0X", "0x") as `0x${string}`;
    const L1 = applyApproved(mkLedger(), { kind: "actionMint", target: T, value: 10n }, NOW, s);
    expect(L1.counterpartySpent).toEqual({ [CP.toLowerCase()]: { ETH: 10n, "ETH:denom": E18 } });
    const s2 = mkState();
    s2.action.rh = { ...s2.action.rh, native: 5n };
    const L2 = applyApproved(L1, { kind: "actionMint", target: CP, value: 1n }, NOW, s2);
    expect(L2.counterpartySpent[CP]).toEqual({ ETH: 11n, "ETH:denom": E18 });
    // an ETH actionTransfer to the same address accumulates into the same bucket
    const L3 = applyApproved(L2, { kind: "actionTransfer", asset: "ETH", to: CP, amount: 2n }, NOW, s);
    expect(L3.counterpartySpent[CP]).toEqual({ ETH: 13n, "ETH:denom": E18 });
  });
  it("A2 rev 2: actionMint without stateAtApproval: spend recorded, no snapshot", () => {
    const L = applyApproved(mkLedger(), { kind: "actionMint", target: CP, value: 7n }, NOW);
    expect(L.counterpartySpent[CP]).toEqual({ ETH: 7n });
  });
  it("actionTransfer without stateAtApproval: spend recorded, no snapshot (documented fallback)", () => {
    const L = applyApproved(mkLedger(), { kind: "actionTransfer", asset: "ETH", to: CP, amount: 10n }, NOW);
    expect(L.counterpartySpent[CP]).toEqual({ ETH: 10n });
  });

  const noOps: ProposedAction[] = [
    { kind: "heartbeat" },
    { kind: "registerInstance" },
    { kind: "distribute" },
    { kind: "treasurySwap", tokenIn: TOKEN_X, amountIn: 1n, minOut: 1n },
    { kind: "actionSwap", tokenIn: "USDG", tokenOut: TOKEN_X, amountIn: 1n, minOut: 0n },
    { kind: "actionLp", pool: `0x${"ab".repeat(32)}`, usdgAmount: 1n, tokenAmount: 1n, token: TOKEN_X },
  ];
  for (const a of noOps) {
    it(`${a.kind}: no budget bucket changes (same day ⇒ same object)`, () => {
      const L = mkLedger();
      expect(applyApproved(L, a, NOW)).toBe(L);
    });
  }

  it("never mutates its input (deep-frozen ledger and state)", () => {
    const L = deepFreeze(mkLedger({ counterpartySpent: { [CP]: { ETH: 1n } }, treasurySpent: { oysterRental: 1n } }));
    const s = deepFreeze(mkState());
    const before = structuredClone(L);
    const actions: ProposedAction[] = [
      tt("oysterRental", "arbitrum", "USDC", MARLIN_PAY, 5n),
      { kind: "allowance", amount: 1n },
      { kind: "inference", category: "pulse", endpointId: "inf-cheap", maxCostUsd: 1n },
      { kind: "actionTransfer", asset: "ETH", to: CP, amount: 1n },
      { kind: "actionTransfer", asset: TOKEN_X, to: CP, amount: 1n },
    ];
    for (const a of actions) {
      applyApproved(L, a, NOW, s);
      applyApproved(L, a, DAY0 + DAY, s);
    }
    expect(L).toEqual(before);
  });

  it("G4: applyApproved with a rewound clock keeps dayKey and accumulates into today's buckets", () => {
    const a = tt("oysterRental", "arbitrum", "USDC", MARLIN_PAY, 60n * E6);
    let L = applyApproved(mkLedger({ allowanceAmountToday: 9n }), a, NOW); // 2026-09-23
    L = applyApproved(L, a, NOW - DAY); // clock rewound to 2026-09-22
    expect(L.dayKey).toBe("2026-09-23");
    expect(L.treasurySpent.oysterRental).toBe(120n * E6);
    expect(L.allowanceAmountToday).toBe(9n);
    L = applyApproved(L, a, NOW + DAY); // forward roll still resets
    expect(L.dayKey).toBe("2026-09-24");
    expect(L.treasurySpent.oysterRental).toBe(60n * E6);
    expect(L.allowanceAmountToday).toBe(0n);
  });

  it("day rollover mid-sequence: 23:59:59 spend then 00:00:00 spend starts a fresh bucket", () => {
    const a = tt("oysterRental", "arbitrum", "USDC", MARLIN_PAY, 60n * E6);
    const last = DAY0 + DAY - 1n;
    let L = applyApproved(mkLedger({ allowanceAmountToday: 9n, lastAllowanceAt: DAY0 }), a, last);
    expect(L.dayKey).toBe("2026-09-23");
    expect(L.treasurySpent.oysterRental).toBe(60n * E6);
    L = applyApproved(L, a, last + 1n);
    expect(L.dayKey).toBe("2026-09-24");
    expect(L.treasurySpent.oysterRental).toBe(60n * E6);
    expect(L.allowanceAmountToday).toBe(0n);
    expect(L.lastAllowanceAt).toBe(DAY0);
  });
});

describe("recordFeeIncome", () => {
  it("appends and keeps only the last 7 entries in order", () => {
    let L: BudgetLedger = emptyLedger(NOW);
    for (let i = 1n; i <= 9n; i++) L = recordFeeIncome(L, i);
    expect(L.feeIncome7d).toEqual([3n, 4n, 5n, 6n, 7n, 8n, 9n]);
  });
  it("partial history is kept as-is (missing days treated as 0 by I1)", () => {
    const L = recordFeeIncome(recordFeeIncome(emptyLedger(NOW), 5n), 6n);
    expect(L.feeIncome7d).toEqual([5n, 6n]);
  });
  it("does not mutate the input ledger", () => {
    const L = deepFreeze(emptyLedger(NOW));
    const L2 = recordFeeIncome(L, 1n);
    expect(L.feeIncome7d).toEqual([]);
    expect(L2).not.toBe(L);
  });
});

describe("engine + reducer sequences", () => {
  it("T4: allowance → +86399s EARLY → +86400s allowed", () => {
    const s = mkState();
    const a: ProposedAction = { kind: "allowance", amount: 100n * E6 };
    let L = mkLedger();
    expectAllow(evaluate(a, s, L, cfg, NOW));
    L = applyApproved(L, a, NOW, s);
    expectDeny(evaluate(a, s, L, cfg, NOW + 86_399n), "ALLOWANCE_EARLY");
    expectAllow(evaluate(a, s, L, cfg, NOW + 86_400n));
  });

  it("T3: repeated arweaveFunding fills the 10 USDG bucket then denies; next UTC day allowed again", () => {
    const s = mkState();
    const a: ProposedAction = { kind: "treasuryTransfer", purpose: "arweaveFunding", chain: "rh", asset: "USDG", to: ARWEAVE, amount: 4n * E6 };
    let L = mkLedger();
    for (let i = 0; i < 2; i++) {
      expectAllow(evaluate(a, s, L, cfg, NOW));
      L = applyApproved(L, a, NOW, s);
    }
    expectDeny(evaluate(a, s, L, cfg, NOW), "DAILY_CAP"); // 8 + 4 > 10
    expectAllow(evaluate({ ...a, amount: 2n * E6 }, s, L, cfg, NOW)); // 8 + 2 == 10
    expectAllow(evaluate(a, s, L, cfg, DAY0 + DAY));
  });

  it("A2: first ETH send snapshots the denominator; later sends use it even after balance grows", () => {
    let s = mkState(); // 1 ETH ⇒ cap per counterparty 0.3 ETH
    const send = (amt: bigint): ProposedAction => ({ kind: "actionTransfer", asset: "ETH", to: CP, amount: amt });
    let L = mkLedger();
    expectAllow(evaluate(send(2n * 10n ** 17n), s, L, cfg, NOW));
    L = applyApproved(L, send(2n * 10n ** 17n), NOW, s);
    // balance grows to 10 ETH; snapshot (1 ETH) still binds: 0.2 + 0.1 == 0.3 ok, +1 wei denied
    s = mkState();
    s.action.rh = { ...s.action.rh, native: 10n * E18 };
    expectAllow(evaluate(send(10n ** 17n), s, L, cfg, NOW));
    expectDeny(evaluate(send(10n ** 17n + 1n), s, L, cfg, NOW), "COUNTERPARTY_CAP");
  });

  it("A2 rev 2: repeated actionMints to one target cross 30% of the snapshot ⇒ COUNTERPARTY_CAP; ledger records them", () => {
    const s = mkState(); // 1 ETH ⇒ per-tx 0.2, per-counterparty 0.3
    const m = (v: bigint): ProposedAction => ({ kind: "actionMint", target: CP, value: v });
    let L = mkLedger();
    const step = 10n ** 17n; // 0.1 ETH
    for (let i = 0; i < 3; i++) {
      expectAllow(evaluate(m(step), s, L, cfg, NOW));
      L = applyApproved(L, m(step), NOW, s);
    }
    expect(L.counterpartySpent[CP]).toEqual({ ETH: 3n * step, "ETH:denom": E18 });
    expectDeny(evaluate(m(1n), s, L, cfg, NOW), "COUNTERPARTY_CAP");
    // a different target is unaffected; next UTC day resets
    expectAllow(evaluate({ kind: "actionMint", target: `0x${"12".repeat(20)}`, value: step }, s, L, cfg, NOW));
    expectAllow(evaluate(m(step), s, L, cfg, DAY0 + DAY));
  });

  it("A2: USDG counterparty cap is 30% of today's allowance, set by the allowance reducer", () => {
    const s = mkState();
    let L = mkLedger();
    const usdg = (amt: bigint): ProposedAction => ({ kind: "actionTransfer", asset: "USDG", to: CP, amount: amt });
    expectDeny(evaluate(usdg(E6), s, L, cfg, NOW), "COUNTERPARTY_CAP");
    L = applyApproved(L, { kind: "allowance", amount: 500n * E6 }, NOW, s);
    expectAllow(evaluate(usdg(150n * E6), s, L, cfg, NOW));
    L = applyApproved(L, usdg(150n * E6), NOW, s);
    expectDeny(evaluate(usdg(1n), s, L, cfg, NOW), "COUNTERPARTY_CAP");
  });

  it("I1: inference sequence stops exactly at the category budget", () => {
    const s = mkState();
    let L = mkLedger(); // pulse budget 15 USDG
    const call: ProposedAction = { kind: "inference", category: "pulse", endpointId: "inf-cheap", maxCostUsd: 500_000n };
    let n = 0;
    for (;;) {
      const v = evaluate(call, s, L, cfg, NOW);
      if (!v.allow) {
        expectDeny(v, "INFERENCE_BUDGET");
        break;
      }
      L = applyApproved(L, call, NOW, s);
      n++;
    }
    expect(n).toBe(30);
    expect(L.inferenceSpent.pulse).toBe(15n * E6);
  });
});

void E18;
