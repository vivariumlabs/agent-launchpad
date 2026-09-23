// SPEC-M2B §7 step 9 / 01 §6 tier thresholds + §7 scheduler.

import { describe, expect, it } from "vitest";
import { nextTickAt, tickDue } from "../../src/daemon/scheduler.js";
import { isSurvivalOnly, tierOf } from "../../src/daemon/tier.js";
import { mkCfg, NOW } from "../policy/helpers.js";

describe("tierOf (01 §6)", () => {
  it("thresholds: >14 Active, 3–14 Conserving, <3 Dormant", () => {
    expect(tierOf(15n, undefined, false)).toBe("Active");
    expect(tierOf(14n, undefined, false)).toBe("Conserving");
    expect(tierOf(3n, undefined, false)).toBe("Conserving");
    expect(tierOf(2n, undefined, false)).toBe("Dormant");
    expect(tierOf(-5n, undefined, false)).toBe("Dormant");
    expect(tierOf(1_000_000_000n, "Active", false)).toBe("Active");
  });
  it("Dormant hysteresis: wake only when runway > 5d", () => {
    expect(tierOf(3n, "Dormant", false)).toBe("Dormant");
    expect(tierOf(5n, "Dormant", false)).toBe("Dormant");
    expect(tierOf(6n, "Dormant", false)).toBe("Conserving");
    expect(tierOf(15n, "Dormant", false)).toBe("Active");
    // non-Dormant prev: no hysteresis
    expect(tierOf(4n, "Conserving", false)).toBe("Conserving");
    expect(tierOf(4n, "Active", false)).toBe("Conserving");
  });
  it("Evicted iff hosting lapsed; a no-longer-lapsed Evicted wakes like Dormant", () => {
    expect(tierOf(100n, "Active", true)).toBe("Evicted");
    expect(tierOf(4n, "Evicted", false)).toBe("Dormant");
    expect(tierOf(6n, "Evicted", false)).toBe("Conserving");
  });
  it("survival-only tiers", () => {
    expect(isSurvivalOnly("Dormant")).toBe(true);
    expect(isSurvivalOnly("Evicted")).toBe(true);
    expect(isSurvivalOnly("Active")).toBe(false);
    expect(isSurvivalOnly("Conserving")).toBe(false);
  });
});

describe("scheduler", () => {
  it("next tick = now + daemonIntervalSec (21600 DEFAULT)", () => {
    expect(mkCfg().daemonIntervalSec).toBe(21_600n);
    expect(nextTickAt(NOW, mkCfg())).toBe(NOW + 21_600n);
    expect(nextTickAt(NOW, mkCfg({ daemonIntervalSec: "3600" }))).toBe(NOW + 3_600n);
  });
  it("tickDue", () => {
    expect(tickDue(NOW, undefined)).toBe(true);
    expect(tickDue(NOW, NOW)).toBe(true);
    expect(tickDue(NOW, NOW + 1n)).toBe(false);
  });
});
