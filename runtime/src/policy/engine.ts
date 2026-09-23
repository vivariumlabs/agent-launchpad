// SPEC-M2 §1, §3. evaluate(): pure, deterministic, default-deny.
//
// Pipeline:
//   1. `now` must be a non-negative bigint                    ⇒ else MALFORMED
//   2. G1: zod shape validation (validate.ts)                 ⇒ else MALFORMED
//   3. Roll the ledger view forward to dayKeyOf(now) (G4: only a LATER day empties
//      daily buckets; same day or a rewound clock keeps the ledger as-is)
//   4. Wallet inferred from kind (walletForAction); treasury kinds are evaluated
//      with ONLY treasury balances, action kinds with ONLY action balances.
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
import { evaluateTreasury } from "./rules/treasury.js";
import { walletForAction, type BudgetLedger, type ProposedAction, type UnixSeconds, type Verdict, type WalletState } from "./types.js";
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
    return deny("NO_RULE", `G2: no wallet for kind "${a.kind}"`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return deny("MALFORMED", `evaluation error (action/state/ledger/config): ${msg}`);
  }
}
