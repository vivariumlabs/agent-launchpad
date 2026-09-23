// SPEC-M2B §6 tiers (01 §6) + scheduler (nextPulse, budget stretch, transitions).

import { describe, expect, it } from "vitest";
import { dayKeyOf } from "../../src/ledger/ledger.js";
import { budgetPressure, nextPulse, planNext, transitionAnnouncement, type BudgetPressure } from "../../src/pulse/scheduler.js";
import { PULSE_INTERVAL_SEC, pulsesEnabled, tierOf, type Tier } from "../../src/pulse/tier.js";
import { tierOf as daemonTierOf } from "../../src/daemon/tier.js";
import { DAY, E6, NOW, cfg, mkLedger } from "../policy/helpers.js";

describe("tierOf boundaries (14 / 3 / 5-day edges)", () => {
  it("daemon/tier.ts re-exports the single implementation", () => {
    expect(daemonTierOf).toBe(tierOf);
  });
  const cases: Array<[bigint, Tier | undefined, Tier]> = [
    [1000n, undefined, "Active"],
    [15n, undefined, "Active"],
    [14n, undefined, "Conserving"], // "> 14" is Active
    [3n, undefined, "Conserving"], // 3–14 inclusive
    [2n, undefined, "Dormant"],
    [0n, undefined, "Dormant"],
    [-5n, undefined, "Dormant"],
    // wake hysteresis from Dormant: stays Dormant until runway > 5
    [3n, "Dormant", "Dormant"],
    [5n, "Dormant", "Dormant"],
    [6n, "Dormant", "Conserving"],
    [15n, "Dormant", "Active"],
    // hysteresis only applies from Dormant
    [4n, "Conserving", "Conserving"],
    [4n, "Active", "Conserving"],
    [2n, "Active", "Dormant"],
    // unified semantics: a no-longer-lapsed Evicted wakes like Dormant (> 5d)
    [2n, "Evicted", "Dormant"],
    [4n, "Evicted", "Dormant"],
    [5n, "Evicted", "Dormant"],
    [6n, "Evicted", "Conserving"],
    [15n, "Evicted", "Active"],
  ];
  for (const [days, prev, want] of cases) {
    it(`runway ${days}d prev=${prev ?? "-"} ⇒ ${want}`, () => {
      expect(tierOf(days, prev)).toBe(want);
    });
  }
  it("hosting lapsed ⇒ Evicted regardless of runway", () => {
    expect(tierOf(1000n, "Active", true)).toBe("Evicted");
    expect(tierOf(0n, undefined, true)).toBe("Evicted");
  });
  it("intervals: Active 30 min, Conserving 4 h, Dormant/Evicted no pulses", () => {
    expect(PULSE_INTERVAL_SEC).toEqual({ Active: 1800n, Conserving: 14_400n, Dormant: null, Evicted: null });
    expect(["Active", "Conserving", "Dormant", "Evicted"].map((t) => pulsesEnabled(t as Tier))).toEqual([true, true, false, false]);
  });
});

describe("nextPulse (stretch math)", () => {
  it("interval, ×2 when stretched, null for Dormant/Evicted", () => {
    expect(nextPulse("Active", false, NOW)).toBe(NOW + 1800n);
    expect(nextPulse("Active", true, NOW)).toBe(NOW + 3600n);
    expect(nextPulse("Conserving", false, NOW)).toBe(NOW + 14_400n);
    expect(nextPulse("Conserving", true, NOW)).toBe(NOW + 28_800n);
    expect(nextPulse("Dormant", false, NOW)).toBeNull();
    expect(nextPulse("Dormant", true, NOW)).toBeNull();
    expect(nextPulse("Evicted", false, NOW)).toBeNull();
  });
});

describe("budgetPressure (stretchThresholdBps 2000)", () => {
  // default ledger: feeIncome 100/day ⇒ B = 25 USDG ⇒ pulse budget 15 USDG; 20% = 3 USDG, 10% = 1.5 USDG
  const budget = 15n * E6;
  const at = (spent: bigint): BudgetPressure => budgetPressure(mkLedger({ inferenceSpent: { pulse: spent, chat: 0n, social: 0n } }), cfg, NOW);
  it("remaining ≥ 20% ⇒ full, no stretch (boundary exactly 20%)", () => {
    expect(at(0n)).toEqual({ budget, spent: 0n, remaining: budget, stretch: false, level: "full" });
    expect(at(12n * E6)).toMatchObject({ remaining: 3n * E6, stretch: false, level: "full" });
  });
  it("remaining < 20% ⇒ stretch + trimmed; < 10% ⇒ minimal; exhausted ⇒ minimal", () => {
    expect(at(12n * E6 + 1n)).toMatchObject({ stretch: true, level: "trimmed" });
    expect(at(13_500_000n)).toMatchObject({ remaining: 1_500_000n, stretch: true, level: "trimmed" });
    expect(at(13_500_001n)).toMatchObject({ stretch: true, level: "minimal" });
    expect(at(15n * E6)).toMatchObject({ remaining: 0n, stretch: true, level: "minimal" });
    expect(at(20n * E6)).toMatchObject({ remaining: 0n, stretch: true, level: "minimal" });
  });
  it("a new UTC day resets the pressure (ledger rolled forward)", () => {
    const L = mkLedger({ inferenceSpent: { pulse: 15n * E6, chat: 0n, social: 0n } });
    expect(L.dayKey).toBe(dayKeyOf(NOW));
    expect(budgetPressure(L, cfg, NOW + DAY)).toMatchObject({ spent: 0n, stretch: false, level: "full" });
  });
});

describe("planNext: tier transitions + stretch", () => {
  const calm: BudgetPressure = { budget: 1n, spent: 0n, remaining: 1n, stretch: false, level: "full" };
  it("no transition, calm budget", () => {
    const r = planNext({ tier: "Active", nextPulseAt: null, stretch: false }, { runwayDays: 100n, pressure: calm, now: NOW });
    expect(r).toEqual({ state: { tier: "Active", stretch: false, nextPulseAt: NOW + 1800n }, transition: null });
  });
  it("INFERENCE_BUDGET / RUNWAY deny ⇒ stretched; other denies are not", () => {
    const p = { tier: "Active" as Tier, nextPulseAt: null, stretch: false };
    expect(planNext(p, { runwayDays: 100n, pressure: calm, inferenceDeny: "INFERENCE_BUDGET", now: NOW }).state.nextPulseAt).toBe(NOW + 3600n);
    expect(planNext(p, { runwayDays: 100n, pressure: calm, inferenceDeny: "RUNWAY", now: NOW }).state.stretch).toBe(true);
    expect(planNext(p, { runwayDays: 100n, pressure: calm, inferenceDeny: "ENDPOINT", now: NOW }).state.stretch).toBe(false);
  });
  it("Active → Conserving → Dormant → (wake) Conserving", () => {
    let s = { tier: "Active" as Tier, nextPulseAt: null as bigint | null, stretch: false };
    const r1 = planNext(s, { runwayDays: 10n, pressure: calm, now: NOW });
    expect(r1.transition).toEqual({ from: "Active", to: "Conserving" });
    expect(r1.state.nextPulseAt).toBe(NOW + 14_400n);
    s = r1.state;
    const r2 = planNext(s, { runwayDays: 2n, pressure: calm, now: NOW });
    expect(r2.transition).toEqual({ from: "Conserving", to: "Dormant" });
    expect(r2.state.nextPulseAt).toBeNull();
    const r3 = planNext(r2.state, { runwayDays: 5n, pressure: calm, now: NOW });
    expect(r3.transition).toBeNull();
    const r4 = planNext(r3.state, { runwayDays: 6n, pressure: calm, now: NOW });
    expect(r4.transition).toEqual({ from: "Dormant", to: "Conserving" });
    expect(transitionAnnouncement(r4.transition!)).toContain("Dormant → Conserving");
  });
});
