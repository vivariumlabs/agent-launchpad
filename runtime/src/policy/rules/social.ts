// SPEC-M2B §1 social / journal rules S1, S2, J1. Pure.
//
// These kinds route to the fc key (castPost/castReply) or the arweave/mem path
// (journalWrite). They are evaluated with NO balance access at all — the
// function signature takes only the (rolled) ledger and config: pace caps only.
// Content moderation is the guardrail prompt's job; the engine sees only
// hashes and sizes (G1 validates their shape).
//
// Check orders:
//   castPost:     S1 PACE_CAP  (castPostsToday   < min(agent.social.postsPerDay,   postsPerDayMax))
//   castReply:    S2 PACE_CAP  (castRepliesToday < min(agent.social.repliesPerDay, repliesPerDayMax))
//   journalWrite: J1 MALFORMED (sizeBytes > journalMaxBytes) → J1 PACE_CAP (journalToday < journalDailyCap)

import type { ResolvedConfig } from "../../config/schema.js";
import type { BudgetLedger, ProposedAction, UnixSeconds, Verdict } from "../types.js";
import { minBig } from "../util.js";
import { allow, deny } from "./common.js";

/** S1: effective posts/day = agent config, bounded by the platform max (≤ 8 DEFAULT). */
export function postsPerDayCap(cfg: ResolvedConfig): bigint {
  return minBig(BigInt(cfg.agent.social.postsPerDay), BigInt(cfg.postsPerDayMax));
}

/** S2: effective replies/day = agent config, bounded by the platform max (≤ 30 DEFAULT). */
export function repliesPerDayCap(cfg: ResolvedConfig): bigint {
  return minBig(BigInt(cfg.agent.social.repliesPerDay), BigInt(cfg.repliesPerDayMax));
}

export function evaluateSocial(a: ProposedAction, L: BudgetLedger, cfg: ResolvedConfig, now: UnixSeconds): Verdict {
  switch (a.kind) {
    case "castPost": {
      const cap = postsPerDayCap(cfg);
      if (L.castPostsToday < cap) return allow(a, now);
      return deny("PACE_CAP", `S1: castPostsToday ${L.castPostsToday} >= postsPerDay ${cap}`);
    }
    case "castReply": {
      const cap = repliesPerDayCap(cfg);
      if (L.castRepliesToday < cap) return allow(a, now);
      return deny("PACE_CAP", `S2: castRepliesToday ${L.castRepliesToday} >= repliesPerDay ${cap}`);
    }
    case "journalWrite": {
      if (a.sizeBytes > cfg.journalMaxBytes) {
        return deny("MALFORMED", `J1: sizeBytes ${a.sizeBytes} > journalMaxBytes ${cfg.journalMaxBytes}`);
      }
      const cap = BigInt(cfg.journalDailyCap);
      if (L.journalToday < cap) return allow(a, now);
      return deny("PACE_CAP", `J1: journalToday ${L.journalToday} >= journalDailyCap ${cap}`);
    }
    default:
      // G2: nothing else routes to the fc / journal paths.
      return deny("NO_RULE", `G2: kind "${a.kind}" has no social/journal rule`);
  }
}
