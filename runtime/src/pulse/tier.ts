// SPEC-M2B §6 / §7 step 9 / 01 §6 — runway tiers. Pure. SINGLE implementation
// (src/daemon/tier.ts re-exports this module).
//
//   Active      runway > 14 d          pulse every 30 min, all capabilities
//   Conserving  3 ≤ runway ≤ 14 d      pulse every 4 h, cheap model, social+journal only
//   Dormant     runway < 3 d           no pulses (daemon-only); wake when runway > 5 d
//   Evicted     hosting lapsed         no pulses (revival per D10)
//
// runwayDays is the integer (floored) value from policy/runway.ts, so "> 14" means ≥ 15.
// Wake hysteresis: from Dormant — or from Evicted once hosting is no longer lapsed —
// the agent stays Dormant until runway > WAKE_THRESHOLD_DAYS (it must clear > 5 d to
// leave the survival loop).

export type Tier = "Active" | "Conserving" | "Dormant" | "Evicted";

/** Active iff runwayDays > this. */
export const ACTIVE_ABOVE_DAYS = 14n;
/** Dormant iff runwayDays < this. */
export const DORMANT_BELOW_DAYS = 3n;
/** A Dormant (or formerly Evicted) agent wakes only when runwayDays > this. */
export const WAKE_THRESHOLD_DAYS = 5n;
/** Daemon-side name for WAKE_THRESHOLD_DAYS (kept for existing importers). */
export const WAKE_ABOVE_DAYS = WAKE_THRESHOLD_DAYS;

/** Pulse interval per tier in seconds; null = no pulses (daemon-only / dead). */
export const PULSE_INTERVAL_SEC: Readonly<Record<Tier, bigint | null>> = {
  Active: 1_800n,
  Conserving: 14_400n,
  Dormant: null,
  Evicted: null,
};

export function tierOf(runwayDays: bigint, prev?: Tier, hostingLapsed = false): Tier {
  if (hostingLapsed) return "Evicted";
  if (runwayDays < DORMANT_BELOW_DAYS) return "Dormant";
  if ((prev === "Dormant" || prev === "Evicted") && runwayDays <= WAKE_THRESHOLD_DAYS) return "Dormant";
  if (runwayDays > ACTIVE_ABOVE_DAYS) return "Active";
  return "Conserving";
}

export function pulsesEnabled(tier: Tier): boolean {
  return PULSE_INTERVAL_SEC[tier] !== null;
}

/** Dormant and Evicted run the daemon survival subset only (SPEC-M2B §7). */
export function isSurvivalOnly(t: Tier): boolean {
  return t === "Dormant" || t === "Evicted";
}
