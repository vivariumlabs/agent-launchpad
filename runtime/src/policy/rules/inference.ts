// SPEC-M2 §3 Inference: I1 (daily budget), I2 (endpoint allowlist + per-call cap),
// plus G3 (Base USDC balance) and T0 (runway gate — inference is a treasury outflow).
//
// Check order: I2 ENDPOINT → I2 PER_CALL_CAP → G3 INSUFFICIENT_BALANCE →
// I1 INFERENCE_BUDGET → T0 RUNWAY → allow.

import type { ResolvedConfig } from "../../config/schema.js";
import type { RunwayState } from "../runway.js";
import type { BudgetLedger, ProposedAction, UnixSeconds, Verdict } from "../types.js";
import { applyBps, floorDiv } from "../util.js";
import { allow, deny, runwayGate } from "./common.js";

type InferenceAction = Extract<ProposedAction, { kind: "inference" }>;
type Category = InferenceAction["category"];

type BudgetCfg = Pick<ResolvedConfig, "inferencePctBps" | "inferenceFloorUsd" | "inferenceCapUsd">;

/**
 * I1 daily budget B = clamp(inferencePctBps × avg(feeIncome7d), floor, cap).
 * avg = (sum of the LAST 7 entries) / 7 — missing days count as 0 (so a
 * partial array still divides by 7). Percentage applied after the average,
 * both floored.
 */
export function inferenceBudget(ledger: Pick<BudgetLedger, "feeIncome7d">, cfg: BudgetCfg): bigint {
  const last7 = ledger.feeIncome7d.slice(Math.max(0, ledger.feeIncome7d.length - 7));
  let sum = 0n;
  for (const x of last7) sum += x;
  const avg = floorDiv(sum, 7n);
  const raw = applyBps(avg, cfg.inferencePctBps);
  if (raw < cfg.inferenceFloorUsd) return cfg.inferenceFloorUsd;
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
  // I1: per-category budget, no inter-category borrowing.
  const B = inferenceBudget(L, cfg);
  const catB = categoryBudget(B, a.category, cfg);
  const spent = L.inferenceSpent[a.category];
  if (spent + a.maxCostUsd > catB) {
    return deny(
      "INFERENCE_BUDGET",
      `I1: ${a.category} spent ${spent} + ${a.maxCostUsd} > category budget ${catB} (daily B ${B})`,
    );
  }
  // T0: inference is a treasury outflow (Base USDC does not count toward fundable).
  const r = runwayGate(s, now, { chain: "base", asset: "USDC", amount: a.maxCostUsd }, cfg);
  if (r !== null) return r;
  return allow(a, now);
}
