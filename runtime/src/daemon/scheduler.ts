// SPEC-M2B §7: the treasury daemon ticks every 6 h (cfg.daemonIntervalSec,
// DEFAULT 21600). Clock injected; pure.

import type { ResolvedConfig } from "../config/schema.js";
import type { UnixSeconds } from "../policy/types.js";

export function nextTickAt(now: UnixSeconds, cfg: Pick<ResolvedConfig, "daemonIntervalSec">): UnixSeconds {
  return now + cfg.daemonIntervalSec;
}

/** True when a tick scheduled for `scheduledAt` is due at `now` (undefined ⇒ never ran ⇒ due). */
export function tickDue(now: UnixSeconds, scheduledAt: UnixSeconds | undefined): boolean {
  return scheduledAt === undefined || now >= scheduledAt;
}
