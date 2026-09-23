// Re-export of the single tier implementation (src/pulse/tier.ts). Kept so the
// daemon and its tests import from a daemon-local path.
export {
  ACTIVE_ABOVE_DAYS,
  DORMANT_BELOW_DAYS,
  WAKE_ABOVE_DAYS,
  WAKE_THRESHOLD_DAYS,
  isSurvivalOnly,
  tierOf,
  type Tier,
} from "../pulse/tier.js";
