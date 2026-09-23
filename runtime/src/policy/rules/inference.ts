// SPEC-M2 §3 Inference: I1 rev 2 (daily budget, runway-tiered), I2 (endpoint
// allowlist + per-call cap), plus G3 (Base USDC balance).
//
// T0 rev 2: inference is T0-EXEMPT (it spends already-bridged Base USDC; the
// refill bridge is where the 45-day reserve bites). Instead I1 rev 2 applies:
//   runwayDays ≥ minRunwayDays                  ⇒ B = clamp(raw, floor, cap)
//   dormantRunwayDays ≤ runwayDays < minRunway  ⇒ B = min(raw, cap)   (no floor)
//   runwayDays < dormantRunwayDays              ⇒ deny(RUNWAY)        (Dormant: no LLM calls)
// runwayDays is computed once (no spend delta — Base USDC is not fundable).
//
// Check order: I2 ENDPOINT → I2 PER_CALL_CAP → G3 INSUFFICIENT_BALANCE →
// I1 INFERENCE_BUDGET → I1 RUNWAY (dormant) → allow.

import type { ResolvedConfig } from "../../config/schema.js";
import { runwayDays, type RunwayState } from "../runway.js";
import type { BudgetLedger, ProposedAction, UnixSeconds, Verdict } from "../types.js";
import { applyBps, floorDiv } from "../util.js";
import { allow, deny } from "./common.js";

type InferenceAction = Extract<ProposedAction, { kind: "inference" }>;
type Category = InferenceAction["category"];

type BudgetCfg = Pick<ResolvedConfig, "inferencePctBps" | "inferenceFloorUsd" | "inferenceCapUsd">;

/**
 * I1 daily budget. raw = inferencePctBps × avg(feeIncome7d); avg = (sum of the
 * LAST 7 entries) / 7 — missing days count as 0 (so a partial array still
 * divides by 7). Percentage applied after the average, both floored.
 *
 * `floorApplies` (I1 rev 2): true (default) ⇒ B = clamp(raw, floor, cap);
 * false (runway below minRunwayDays) ⇒ B = min(raw, cap) — no floor.
 */
export function inferenceBudget(
  ledger: Pick<BudgetLedger, "feeIncome7d">,
  cfg: BudgetCfg,
  floorApplies = true,
): bigint {
  const last7 = ledger.feeIncome7d.slice(Math.max(0, ledger.feeIncome7d.length - 7));
  let sum = 0n;
  for (const x of last7) sum += x;
  const avg = floorDiv(sum, 7n);
  const raw = applyBps(avg, cfg.inferencePctBps);
  if (floorApplies && raw < cfg.inferenceFloorUsd) return cfg.inferenceFloorUsd;
  if (raw > cfg.inferenceCapUsd) return cfg.inferenceCapUsd;
  return raw;
}

/** Category budget = B × weight[category] / 10000 (floored). */
export function categoryBudget(B: bigint, category: Category, cfg: Pick<ResolvedConfig, "inferenceCategoryWeightsBps">): bigint {
  return applyBps(B, cfg.inferenceCategoryWeightsBps[category]);
}

export function evaluateInference(
  a: InferenceAction,
  s: RunwayState,
  L: BudgetLedger,
  cfg: ResolvedConfig,
  now: UnixSeconds,
): Verdict {
  // I2: endpoint must be an allowlisted inference entry; chat requires tier "cheap".
  const entry = cfg.x402Allowlist.find((e) => e.id === a.endpointId && e.kind === "inference");
  if (entry === undefined) {
    return deny("ENDPOINT", `I2: endpointId "${a.endpointId}" is not an allowlisted inference endpoint`);
  }
  if (a.category === "chat" && entry.tier !== "cheap") {
    return deny("ENDPOINT", `I2: chat requires a tier "cheap" endpoint; "${entry.id}" is tier "${entry.tier}"`);
  }
  // I2: per-call cap.
  if (a.maxCostUsd > cfg.maxPerCallUsd) {
    return deny("PER_CALL_CAP", `I2: maxCostUsd ${a.maxCostUsd} > maxPerCallUsd ${cfg.maxPerCallUsd}`);
  }
  // G3: paid from treasury Base USDC.
  const baseUsdc = s.treasury.base?.USDC ?? 0n;
  if (baseUsdc < a.maxCostUsd) {
    return deny("INSUFFICIENT_BALANCE", `G3: treasury base USDC ${baseUsdc} < maxCostUsd ${a.maxCostUsd}`);
  }
  // I1 rev 2: runway computed once; drives both the floor and the dormant gate.
  const days = runwayDays(s, now, undefined, cfg.bridgeHaircutBps);
  // I1: per-category budget, no inter-category borrowing.
  const B = inferenceBudget(L, cfg, days >= BigInt(cfg.minRunwayDays));
  const catB = categoryBudget(B, a.category, cfg);
  const spent = L.inferenceSpent[a.category];
  if (spent + a.maxCostUsd > catB) {
    return deny(
      "INFERENCE_BUDGET",
      `I1: ${a.category} spent ${spent} + ${a.maxCostUsd} > category budget ${catB} (daily B ${B})`,
    );
  }
  // I1 rev 2: Dormant = no LLM calls (01 §6).
  if (days < cfg.dormantRunwayDays) {
    return deny(
      "RUNWAY",
      `I1: Dormant: no LLM calls (runway ${days.toString()}d < dormantRunwayDays ${cfg.dormantRunwayDays.toString()}d)`,
    );
  }
  return allow(a, now);
}
