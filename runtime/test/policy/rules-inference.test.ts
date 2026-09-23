// SPEC-M2 §3 Inference: I1 rev 2 (runway-tiered daily budget + dormant gate), I2 (endpoint + per-call cap), G3.
// T0 rev 2: inference is T0-exempt.

import { describe, expect, it } from "vitest";
import { categoryBudget, inferenceBudget } from "../../src/policy/rules/inference.js";
import type { ProposedAction } from "../../src/policy/types.js";
import { DAY, E6, NOW, cfg, ev, expectAllow, expectDeny, mkLedger, mkRunwayState, mkState } from "./helpers.js";

type Inf = Extract<ProposedAction, { kind: "inference" }>;
const inf = (category: Inf["category"], maxCostUsd: bigint, endpointId = "inf-cheap"): Inf => ({
  kind: "inference",
  category,
  endpointId,
  maxCostUsd,
});
const fee7 = (x: bigint): bigint[] => Array.from({ length: 7 }, () => x);

describe("I1: inferenceBudget clamp(25% × avg(feeIncome7d), 5, 60)", () => {
  const cases: Array<[string, bigint[], bigint]> = [
    ["empty feeIncome7d ⇒ floor 5", [], 5n * E6],
    ["all zero ⇒ floor 5", fee7(0n), 5n * E6],
    ["partial [70] ⇒ avg 10 ⇒ 2.5 ⇒ floor 5", [70n * E6], 5n * E6],
    ["partial [140] ⇒ avg 20 ⇒ exactly 5 (floor edge)", [140n * E6], 5n * E6],
    ["partial [140.000028] ⇒ avg 20.000004 ⇒ 5.000001 (just above floor)", [140_000_028n], 5_000_001n],
    ["partial [140.000027] ⇒ avg 20.000003 ⇒ 5.00000075 floors to 5.000000", [140_000_027n], 5n * E6],
    ["7×100 ⇒ 25", fee7(100n * E6), 25n * E6],
    ["7×240 ⇒ exactly 60 (cap edge)", fee7(240n * E6), 60n * E6],
    ["7×239.999996 ⇒ 59.999999 (just below cap)", fee7(239_999_996n), 59_999_999n],
    ["7×240.000004 ⇒ 60.000001 clamps to 60", fee7(240_000_004n), 60n * E6],
    ["7×1e6 USDG ⇒ cap 60", fee7(1_000_000n * E6), 60n * E6],
    ["missing days are zero: [100,100,100] ⇒ avg 42.857142 ⇒ 10.714285", [100n * E6, 100n * E6, 100n * E6], 10_714_285n],
    ["sum not divisible by 7 floors: 1000.000006 ⇒ avg 142.857143 ⇒ 35.714285", [...fee7(0n).slice(0, 6), 1_000_000_006n], 35_714_285n],
    ["more than 7 entries: only the last 7 count", [1_000_000n * E6, ...fee7(100n * E6)], 25n * E6],
  ];
  for (const [name, fees, expected] of cases) {
    it(`I1: ${name}`, () => {
      expect(inferenceBudget({ feeIncome7d: fees }, cfg)).toBe(expected);
    });
  }

  it("I1: category budgets from default weights 60/25/15 of B = 25", () => {
    expect(categoryBudget(25n * E6, "pulse", cfg)).toBe(15n * E6);
    expect(categoryBudget(25n * E6, "chat", cfg)).toBe(6_250_000n);
    expect(categoryBudget(25n * E6, "social", cfg)).toBe(3_750_000n);
  });
  it("I1: floor/cap/pct come from config", () => {
    const c = { ...cfg, inferencePctBps: 5000, inferenceFloorUsd: E6, inferenceCapUsd: 10n * E6 };
    expect(inferenceBudget({ feeIncome7d: fee7(14n * E6) }, c)).toBe(7n * E6);
    expect(inferenceBudget({ feeIncome7d: [] }, c)).toBe(E6);
    expect(inferenceBudget({ feeIncome7d: fee7(100n * E6) }, c)).toBe(10n * E6);
  });
});

describe("I1: per-category daily budget via evaluate", () => {
  // Default ledger: B = 25 ⇒ pulse 15, chat 6.25, social 3.75.
  const rows: Array<[Inf["category"], bigint]> = [
    ["pulse", 15n * E6],
    ["chat", 6_250_000n],
    ["social", 3_750_000n],
  ];
  for (const [cat, budget] of rows) {
    it(`I1: ${cat}: spent + cost == category budget ⇒ allow`, () => {
      const L = mkLedger({ inferenceSpent: { pulse: 0n, chat: 0n, social: 0n, [cat]: budget - 500_000n } });
      expectAllow(ev(inf(cat, 500_000n), { ledger: L }));
    });
    it(`I1: ${cat}: spent + cost == category budget + 1 ⇒ INFERENCE_BUDGET`, () => {
      const L = mkLedger({ inferenceSpent: { pulse: 0n, chat: 0n, social: 0n, [cat]: budget - 500_000n + 1n } });
      expectDeny(ev(inf(cat, 500_000n), { ledger: L }), "INFERENCE_BUDGET");
    });
  }

  it("I1: no inter-category borrowing — pulse exhausted is denied even with chat/social untouched", () => {
    const L = mkLedger({ inferenceSpent: { pulse: 15n * E6, chat: 0n, social: 0n } });
    expectDeny(ev(inf("pulse", 1n), { ledger: L }), "INFERENCE_BUDGET");
    expectAllow(ev(inf("chat", 1n), { ledger: L }));
    expectAllow(ev(inf("social", 1n), { ledger: L }));
  });
  it("I1: clamp floor edge via evaluate — empty feeIncome7d ⇒ B = 5 ⇒ pulse 3", () => {
    const L0 = mkLedger({ feeIncome7d: [], inferenceSpent: { pulse: 2_500_000n, chat: 0n, social: 0n } });
    expectAllow(ev(inf("pulse", 500_000n), { ledger: L0 }));
    const L1 = mkLedger({ feeIncome7d: [], inferenceSpent: { pulse: 2_500_001n, chat: 0n, social: 0n } });
    expectDeny(ev(inf("pulse", 500_000n), { ledger: L1 }), "INFERENCE_BUDGET");
  });
  it("I1: clamp cap edge via evaluate — B = 60 ⇒ pulse 36", () => {
    const L0 = mkLedger({ feeIncome7d: fee7(10_000n * E6), inferenceSpent: { pulse: 35_500_000n, chat: 0n, social: 0n } });
    expectAllow(ev(inf("pulse", 500_000n), { ledger: L0 }));
    const L1 = mkLedger({ feeIncome7d: fee7(10_000n * E6), inferenceSpent: { pulse: 35_500_001n, chat: 0n, social: 0n } });
    expectDeny(ev(inf("pulse", 500_000n), { ledger: L1 }), "INFERENCE_BUDGET");
  });
  it("I1: day rollover — yesterday's exhausted pulse bucket does not count today", () => {
    const L = mkLedger({ dayKey: "2026-09-22", inferenceSpent: { pulse: 15n * E6, chat: 0n, social: 0n } });
    expectAllow(ev(inf("pulse", 500_000n), { ledger: L }));
  });
  it("I1: category weights come from config", () => {
    const c = { ...cfg, inferenceCategoryWeightsBps: { pulse: 10_000, chat: 0, social: 0 } };
    expectAllow(ev(inf("pulse", 500_000n), { cfg: c, ledger: mkLedger({ inferenceSpent: { pulse: 24_500_000n, chat: 0n, social: 0n } }) }));
    expectDeny(ev(inf("social", 1n), { cfg: c }), "INFERENCE_BUDGET");
  });
});

describe("I2: endpoint allowlist + per-call cap", () => {
  it("I2: unknown endpointId ⇒ ENDPOINT", () => expectDeny(ev(inf("pulse", 1n, "nope")), "ENDPOINT"));
  it("I2: empty endpointId ⇒ ENDPOINT", () => expectDeny(ev(inf("pulse", 1n, "")), "ENDPOINT"));
  it("I2: endpoint of kind data ⇒ ENDPOINT", () => expectDeny(ev(inf("pulse", 1n, "data-1")), "ENDPOINT"));
  it("I2: standard-tier endpoint allowed for pulse and social", () => {
    expectAllow(ev(inf("pulse", 1n, "inf-std")));
    expectAllow(ev(inf("social", 1n, "inf-std")));
  });
  it("I2: chat on standard-tier endpoint ⇒ ENDPOINT", () => expectDeny(ev(inf("chat", 1n, "inf-std")), "ENDPOINT"));
  it("I2: chat on cheap-tier endpoint ⇒ allow", () => expectAllow(ev(inf("chat", 1n, "inf-cheap"))));
  it("I2: maxCostUsd == maxPerCallUsd (0.50) ⇒ allow", () => expectAllow(ev(inf("pulse", 500_000n))));
  it("I2: maxCostUsd == maxPerCallUsd + 1 ⇒ PER_CALL_CAP", () => expectDeny(ev(inf("pulse", 500_001n)), "PER_CALL_CAP"));
  it("I2: per-call cap comes from config", () => {
    expectDeny(ev(inf("pulse", 100_001n), { cfg: { ...cfg, maxPerCallUsd: 100_000n } }), "PER_CALL_CAP");
  });
  it("I2: ENDPOINT is reported before PER_CALL_CAP", () => expectDeny(ev(inf("pulse", 10n * E6, "nope")), "ENDPOINT"));
});

describe("G3 + T0 rev 2 exemption for inference", () => {
  it("G3: treasury base USDC < maxCostUsd ⇒ INSUFFICIENT_BALANCE", () => {
    const s = mkState();
    s.treasury.base = { native: 0n, USDC: 99_999n };
    expectDeny(ev(inf("pulse", 100_000n), { state: s }), "INSUFFICIENT_BALANCE");
    expectAllow(ev(inf("pulse", 99_999n), { state: s }));
  });
  it("G3: inference never draws on arbitrum USDC or rh USDG", () => {
    const s = mkState();
    s.treasury.base = { native: 0n };
    expectDeny(ev(inf("pulse", 1n), { state: s }), "INSUFFICIENT_BALANCE");
  });
  it("T0 rev 2: inference is T0-exempt — 44d runway ⇒ allow (Base USDC does not count toward fundable)", () => {
    const s44 = mkRunwayState(76_499_999n);
    s44.treasury.base = { native: 0n, USDC: 1_000_000n * E6 };
    expectAllow(ev(inf("pulse", 1n), { state: s44 }));
  });
  it("T0: hostingRatePerDay = 0 ⇒ infinite runway ⇒ allow", () => {
    const s = mkRunwayState(0n, 0n, 0n, 0n);
    expectAllow(ev(inf("pulse", 1n), { state: s }));
  });
});

describe("I1 rev 2: runway-tiered budget + dormant gate", () => {
  const RATE = 1_700_000n; // mkRunwayState default hosting rate / day
  /** runway = floor(arbUsdc / rate) days (paidUntil = now); Base USDC plentiful. */
  const atDays = (arbUsdc: bigint): ReturnType<typeof mkState> => {
    const s = mkRunwayState(arbUsdc);
    s.treasury.base = { native: 0n, USDC: 1_000_000n * E6 };
    return s;
  };
  const d = (n: bigint): ReturnType<typeof mkState> => atDays(n * RATE);
  // feeIncome7d = [70] ⇒ avg 10 ⇒ raw 2.5 USDG (< floor 5) ⇒ pulse share 60%.
  const lowIncome = (pulseSpent: bigint): ReturnType<typeof mkLedger> =>
    mkLedger({ feeIncome7d: [70n * E6], inferenceSpent: { pulse: pulseSpent, chat: 0n, social: 0n } });

  it("I1: inferenceBudget(floorApplies=false) = min(raw, cap) — no floor", () => {
    expect(inferenceBudget({ feeIncome7d: [70n * E6] }, cfg, false)).toBe(2_500_000n);
    expect(inferenceBudget({ feeIncome7d: [] }, cfg, false)).toBe(0n);
    expect(inferenceBudget({ feeIncome7d: fee7(10_000n * E6) }, cfg, false)).toBe(60n * E6);
    expect(inferenceBudget({ feeIncome7d: [70n * E6] }, cfg, true)).toBe(5n * E6);
  });
  it("I1: Conserving (10d) agent with income CAN think: budget = raw 2.5 ⇒ pulse 1.5 (spent+cost == 1.5 allow, +1 deny)", () => {
    expectAllow(ev(inf("pulse", 500_000n), { state: d(10n), ledger: lowIncome(1_000_000n) }));
    expectDeny(ev(inf("pulse", 500_000n), { state: d(10n), ledger: lowIncome(1_000_001n) }), "INFERENCE_BUDGET");
  });
  it("I1: same ledger at ≥ 45d ⇒ floor applies (B = 5 ⇒ pulse 3)", () => {
    expectAllow(ev(inf("pulse", 500_000n), { state: d(45n), ledger: lowIncome(2_500_000n) }));
    expectDeny(ev(inf("pulse", 500_000n), { state: d(45n), ledger: lowIncome(2_500_001n) }), "INFERENCE_BUDGET");
  });
  it("I1: 44d is below minRunwayDays ⇒ floor withdrawn (pulse 1.5, not 3)", () => {
    expectDeny(ev(inf("pulse", 500_000n), { state: d(44n), ledger: lowIncome(1_000_001n) }), "INFERENCE_BUDGET");
    expectAllow(ev(inf("pulse", 500_000n), { state: d(44n), ledger: lowIncome(1_000_000n) }));
  });
  it("I1: Conserving with high income ⇒ cap 60 still binds (pulse 36)", () => {
    const L = (spent: bigint) => mkLedger({ feeIncome7d: fee7(10_000n * E6), inferenceSpent: { pulse: spent, chat: 0n, social: 0n } });
    expectAllow(ev(inf("pulse", 500_000n), { state: d(10n), ledger: L(35_500_000n) }));
    expectDeny(ev(inf("pulse", 500_000n), { state: d(10n), ledger: L(35_500_001n) }), "INFERENCE_BUDGET");
  });
  it("I1: Conserving with no income ⇒ B = 0 ⇒ INFERENCE_BUDGET", () => {
    expectDeny(ev(inf("pulse", 1n), { state: d(10n), ledger: mkLedger({ feeIncome7d: [] }) }), "INFERENCE_BUDGET");
  });
  it("I1: runway exactly 3d ⇒ allow (Conserving, floor-free)", () => {
    expectAllow(ev(inf("pulse", 500_000n), { state: d(3n), ledger: lowIncome(0n) }));
  });
  it("I1: runway 2.9d (floors to 2) ⇒ RUNWAY (Dormant: no LLM calls)", () => {
    const s = atDays((29n * RATE) / 10n);
    const v = ev(inf("pulse", 1n), { state: s, ledger: lowIncome(0n) });
    expectDeny(v, "RUNWAY");
    if (!v.allow) expect(v.detail).toContain("Dormant: no LLM calls");
  });
  it("I1: hostingPaidUntil in the past drags runway negative ⇒ RUNWAY", () => {
    expectDeny(ev(inf("pulse", 1n), { state: { ...mkState(), hostingPaidUntil: NOW - 6000n * DAY } }), "RUNWAY");
  });
  it("I1: dormantRunwayDays comes from config", () => {
    expectDeny(ev(inf("pulse", 1n), { state: d(5n), ledger: lowIncome(0n), cfg: { ...cfg, dormantRunwayDays: 6n } }), "RUNWAY");
    expectAllow(ev(inf("pulse", 1n), { state: d(5n), ledger: lowIncome(0n), cfg: { ...cfg, dormantRunwayDays: 5n } }));
    expect(cfg.dormantRunwayDays).toBe(3n);
  });
  it("I1: check order — budget (INFERENCE_BUDGET) is reported before the dormant RUNWAY deny", () => {
    expectDeny(ev(inf("pulse", 1n), { state: d(1n), ledger: mkLedger({ feeIncome7d: [] }) }), "INFERENCE_BUDGET");
  });
});
