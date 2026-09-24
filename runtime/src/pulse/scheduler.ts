// SPEC-M2B §6 — scheduler: next pulse time, budget stretch, tier transitions. Pure except
// announceTierTransition (which goes through execute()).
//
// Budget stretch (01 §5 "degrade, don't stop"): remaining pulse-category budget
// < cfg.stretchThresholdBps (20% DEFAULT) of the category budget ⇒ interval ×2 and the
// context level drops: remaining ≥ threshold ⇒ full; ≥ threshold/2 ⇒ trimmed; else minimal.
// An inference deny for RUNWAY or INFERENCE_BUDGET also stretches (and forces minimal).

import type { ResolvedConfig } from "../config/schema.js";
import { execute, type ExecDeps, type ExecResult } from "../exec/execute.js";
import { rollLedger } from "../ledger/ledger.js";
import { categoryBudget, inferenceBudget } from "../policy/rules/inference.js";
import type { BudgetLedger, DenyCode, UnixSeconds } from "../policy/types.js";
import type { ContextLevel } from "./context.js";
import { PULSE_INTERVAL_SEC, tierOf, type Tier } from "./tier.js";
import { contentAction, type FcContext } from "./tools.js";

export const STRETCH_FACTOR = 2n;

/** Next pulse time; null ⇒ no pulses in this tier (Dormant: daemon-only; Evicted). */
export function nextPulse(tier: Tier, stretch: boolean, now: UnixSeconds): UnixSeconds | null {
  const base = PULSE_INTERVAL_SEC[tier];
  if (base === null) return null;
  return now + (stretch ? base * STRETCH_FACTOR : base);
}

export interface BudgetPressure {
  budget: bigint;
  spent: bigint;
  remaining: bigint;
  stretch: boolean;
  level: ContextLevel;
}

export function budgetPressure(
  ledger: BudgetLedger,
  cfg: Pick<ResolvedConfig, "inferencePctBps" | "inferenceFloorUsd" | "inferenceCapUsd" | "inferenceCategoryWeightsBps" | "stretchThresholdBps">,
  now: UnixSeconds,
  /** I1 rev 2: false when runway < minRunwayDays (floor withdrawn) — pacing then matches the engine. */
  floorApplies = true,
): BudgetPressure {
  const L = rollLedger(ledger, now);
  const budget = categoryBudget(inferenceBudget(L, cfg, floorApplies), "pulse", cfg);
  const spent = L.inferenceSpent.pulse;
  const remaining = budget > spent ? budget - spent : 0n;
  const th = BigInt(cfg.stretchThresholdBps);
  // remaining / budget < th / 10000  ⇔  remaining·10000 < budget·th
  const r = remaining * 10_000n;
  const stretch = r < budget * th;
  let level: ContextLevel = "full";
  if (stretch) level = r * 2n < budget * th ? "minimal" : "trimmed";
  return { budget, spent, remaining, stretch, level };
}

export const STRETCH_DENY_CODES: ReadonlySet<DenyCode> = new Set<DenyCode>(["RUNWAY", "INFERENCE_BUDGET"]);

export interface SchedulerState {
  tier: Tier;
  nextPulseAt: UnixSeconds | null;
  stretch: boolean;
}

export interface TierTransition {
  from: Tier;
  to: Tier;
}

export interface PlanInput {
  runwayDays: bigint;
  hostingLapsed?: boolean;
  pressure: BudgetPressure;
  /** Deny code of this pulse's inference gate, if it was denied. */
  inferenceDeny?: DenyCode;
  now: UnixSeconds;
}

export function planNext(prev: SchedulerState, input: PlanInput): { state: SchedulerState; transition: TierTransition | null } {
  const tier = tierOf(input.runwayDays, prev.tier, input.hostingLapsed === true);
  const stretch = input.pressure.stretch || (input.inferenceDeny !== undefined && STRETCH_DENY_CODES.has(input.inferenceDeny));
  const state: SchedulerState = { tier, stretch, nextPulseAt: nextPulse(tier, stretch, input.now) };
  return { state, transition: tier === prev.tier ? null : { from: prev.tier, to: tier } };
}

/** Deterministic announcement draft for a tier transition. */
export function transitionAnnouncement(t: TierTransition): string {
  const what: Record<Tier, string> = {
    Active: "fully awake: trading, posting and journaling",
    Conserving: "conserving: social and journal only, pulsing every 4h",
    Dormant: "dormant: no thinking until my runway recovers",
    Evicted: "evicted: hosting lapsed",
  };
  return `Status change ${t.from} → ${t.to}. I am now ${what[t.to]}.`;
}

/**
 * Tier transition announcement: a castPost draft through the normal engine (pace caps apply).
 * SPEC-M3D §3e ruling: `fc` present (kv fc.fid exists) ⇒ messageBytes = serialized CastAdd MessageData
 * (buildCastAddData; 320-byte cap ⇒ null); absent ⇒ today's UTF-8 bytes.
 */
export async function announceTierTransition(t: TierTransition, deps: ExecDeps, fc?: FcContext): Promise<ExecResult | null> {
  const r = contentAction("castPost", transitionAnnouncement(t), deps.cfg, fc);
  if (!r.ok) return null;
  return execute(r.action, deps, r.extras);
}
