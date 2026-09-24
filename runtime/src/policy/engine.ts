// SPEC-M2 §1, §3. evaluate(): pure, deterministic, default-deny.
//
// Pipeline:
//   1. `now` must be a non-negative bigint                    ⇒ else MALFORMED
//   2. G1: zod shape validation (validate.ts)                 ⇒ else MALFORMED
//   2b. G5 (SPEC-M3C §3): state.staleChains ∩ chainsTouched(a) ≠ ∅ ⇒ STATE_STALE — degraded
//      (cached/zeroed) balances never drive a spend. Social/journal kinds touch no chain (∅).
//   3. Roll the ledger view forward to dayKeyOf(now) (G4: only a LATER day empties
//      daily buckets; same day or a rewound clock keeps the ledger as-is)
//   4. Wallet inferred from kind (walletForAction); treasury kinds are evaluated
//      with ONLY treasury balances, action kinds with ONLY action balances,
//      fc/journal kinds (SPEC-M2B §1) with NO balances at all (pace caps only).
//   5. Rule modules; each ends in an explicit allow or a coded deny.
//   G2: every switch has a NO_RULE default; there is no generic allow path.
//   Any exception while evaluating (e.g. structurally broken state/config) ⇒
//   deny(MALFORMED) — the engine never throws and never allows on error.
//
// The approval is issued over the zod-validated COPY of the action, so what is
// hashed is exactly what the rules saw.

import type { ResolvedConfig } from "../config/schema.js";
import { rollLedger } from "../ledger/ledger.js";
import { deny } from "./rules/common.js";
import { evaluateActionWallet } from "./rules/action.js";
import { evaluateSocial } from "./rules/social.js";
import { evaluateTreasury } from "./rules/treasury.js";
import { chainsTouched, walletForAction, type BudgetLedger, type ProposedAction, type UnixSeconds, type Verdict, type WalletState } from "./types.js";
import { validateAction, validNow } from "./validate.js";

export function evaluate(
  action: ProposedAction,
  state: WalletState,
  ledger: BudgetLedger,
  cfg: ResolvedConfig,
  now: UnixSeconds,
): Verdict {
  try {
    if (!validNow(now)) return deny("MALFORMED", "G1: now must be a non-negative bigint (unix seconds)");

    const v = validateAction(action);
    if (!v.ok) return deny("MALFORMED", v.detail);
    const a = v.action;

    // G5 (SPEC-M3C §3): refuse to act on stale chain state.
    const touched = chainsTouched(a);
    if (touched.length > 0) {
      const stale: unknown = state.staleChains;
      if (stale !== undefined) {
        if (!Array.isArray(stale)) throw new Error("state.staleChains must be an array of chains");
        const hit = touched.filter((c) => stale.includes(c));
        if (hit.length > 0) {
          return deny("STATE_STALE", `G5: balances for ${hit.join(", ")} are stale (RPC unreachable) — refusing to act on degraded state`);
        }
      }
    }

    const L = rollLedger(ledger, now);
    const wallet = walletForAction(a.kind);
    if (wallet === "treasury") {
      return evaluateTreasury(
        a,
        { treasury: state.treasury, hostingPaidUntil: state.hostingPaidUntil, hostingRatePerDay: state.hostingRatePerDay },
        L,
        cfg,
        now,
      );
    }
    if (wallet === "action") {
      return evaluateActionWallet(a, state.action, L, cfg, now);
    }
    if (wallet === "fc" || wallet === "journal") {
      return evaluateSocial(a, L, cfg, now);
    }
    return deny("NO_RULE", `G2: no wallet for kind "${a.kind}"`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return deny("MALFORMED", `evaluation error (action/state/ledger/config): ${msg}`);
  }
}
