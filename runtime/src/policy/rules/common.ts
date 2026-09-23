// Shared verdict constructors + the T0 runway gate. Pure.

import type { ResolvedConfig } from "../../config/schema.js";
import { issueApproval } from "../approval.js";
import { runwayDays, type RunwayState, type SpendDelta } from "../runway.js";
import type { DenyCode, ProposedAction, UnixSeconds, Verdict } from "../types.js";

export function deny(code: DenyCode, detail: string): Verdict {
  return { allow: false, code, detail };
}

/** The ONLY way a rule produces an allow: an Approval over the validated action. */
export function allow(action: ProposedAction, now: UnixSeconds): Verdict {
  return { allow: true, approval: issueApproval(action, now) };
}

/**
 * T0: runway after `spend` must be >= cfg.minRunwayDays. Returns a RUNWAY deny
 * verdict, or null if the gate passes.
 */
export function runwayGate(
  s: RunwayState,
  now: UnixSeconds,
  spend: SpendDelta,
  cfg: Pick<ResolvedConfig, "minRunwayDays" | "bridgeHaircutBps">,
): Verdict | null {
  const days = runwayDays(s, now, spend, cfg.bridgeHaircutBps);
  if (days >= BigInt(cfg.minRunwayDays)) return null;
  return deny(
    "RUNWAY",
    `T0: runway after spend would be ${days.toString()}d < minRunwayDays ${cfg.minRunwayDays}d`,
  );
}
