// SPEC-M2 §4. Pure ledger reducers. No mutation: every reducer returns a new
// object (structural sharing of untouched sub-objects). No clock: `now` is an
// explicit input. Integer math only.

import type { Address } from "viem";
import type { BudgetLedger, ProposedAction, TreasurySpentKey, UnixSeconds, WalletState } from "../policy/types.js";
import { assetKeyOf, floorDiv, lower, rhBalanceOf, SECONDS_PER_DAY, type ActionAsset } from "../policy/util.js";

// ---------------------------------------------------------------------------
// UTC day key (no Date object): Howard Hinnant's civil_from_days.
// ---------------------------------------------------------------------------

/** "YYYY-MM-DD" (UTC) of a unix-seconds timestamp. Pure integer arithmetic. */
export function dayKeyOf(now: UnixSeconds): string {
  const days = floorDiv(now, SECONDS_PER_DAY);
  const z = days + 719_468n;
  const era = floorDiv(z, 146_097n);
  const doe = z - era * 146_097n; // [0, 146096]
  const yoe = (doe - doe / 1_460n + doe / 36_524n - doe / 146_096n) / 365n; // [0, 399]
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n); // [0, 365]
  const mp = (5n * doy + 2n) / 153n; // [0, 11]
  const d = doy - (153n * mp + 2n) / 5n + 1n; // [1, 31]
  const m = mp < 10n ? mp + 3n : mp - 9n; // [1, 12]
  const y = yoe + era * 400n + (m <= 2n ? 1n : 0n);
  const yStr = y < 0n ? "-" + (-y).toString().padStart(4, "0") : y.toString().padStart(4, "0");
  return `${yStr}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Constructors / day rollover
// ---------------------------------------------------------------------------

export function emptyLedger(now: UnixSeconds): BudgetLedger {
  return {
    lastAllowanceAt: 0n,
    allowanceAmountToday: 0n,
    dayKey: dayKeyOf(now),
    inferenceSpent: { pulse: 0n, chat: 0n, social: 0n },
    treasurySpent: {},
    counterpartySpent: {},
    feeIncome7d: [],
    castPostsToday: 0n,
    castRepliesToday: 0n,
    journalToday: 0n,
  };
}

/**
 * Returns the ledger as seen on the UTC day of `now`.
 *
 * G4 (rev 1): daily buckets reset FORWARD ONLY. If dayKeyOf(now) ≤ ledger.dayKey
 * (lexicographic compare on "YYYY-MM-DD"), the ledger is treated as current-day
 * and the same object is returned — a rewound (host-influenced) clock must never
 * refresh daily caps. Only dayKeyOf(now) > ledger.dayKey rolls: inferenceSpent,
 * treasurySpent, counterpartySpent (incl. A2 denominator snapshots),
 * allowanceAmountToday and the SPEC-M2B pace counters (castPostsToday,
 * castRepliesToday, journalToday) → empty/0n; lastAllowanceAt and feeIncome7d
 * are kept.
 *
 * Used by BOTH the engine (read view) and applyApproved (write path), so the
 * two can never disagree on rollover semantics.
 */
export function rollLedger(ledger: BudgetLedger, now: UnixSeconds): BudgetLedger {
  const today = dayKeyOf(now);
  if (today <= ledger.dayKey) return ledger; // G4: same day or clock rewind ⇒ no reset

  return {
    lastAllowanceAt: ledger.lastAllowanceAt,
    allowanceAmountToday: 0n,
    dayKey: today,
    inferenceSpent: { pulse: 0n, chat: 0n, social: 0n },
    treasurySpent: {},
    counterpartySpent: {},
    feeIncome7d: ledger.feeIncome7d,
    castPostsToday: 0n,
    castRepliesToday: 0n,
    journalToday: 0n,
  };
}

// ---------------------------------------------------------------------------
// applyApproved
// ---------------------------------------------------------------------------

/** treasurySpent bucket for a treasuryTransfer (T3). ETH bridges count against gasTopUp:<source chain>. */
export function treasurySpentKey(
  action: Extract<ProposedAction, { kind: "treasuryTransfer" }>,
): TreasurySpentKey {
  if (action.purpose === "gasTopUp") return `gasTopUp:${action.chain}`;
  if (action.purpose === "acrossBridge" && action.asset === "ETH") return `gasTopUp:${action.chain}`;
  return action.purpose;
}

/** Ledger key under counterpartySpent[to] holding the A2 denominator snapshot for a non-USDG asset. */
export function denomKey(assetKey: string): string {
  return `${assetKey}:denom`;
}

/**
 * Advance the ledger after an approved action was executed (SPEC-M2 §4).
 *
 * `stateAtApproval` is the WalletState the engine evaluated against. It is
 * needed ONLY to snapshot the A2 denominator (action-wallet balance of the
 * asset at first send of the day) for non-USDG `actionTransfer`s and (A2 rev 2)
 * `actionMint`s (target-keyed, asset "ETH"). If it is
 * omitted, no snapshot is written and the engine keeps using the live
 * balance as denominator for that counterparty/asset (documented fallback).
 */
export function applyApproved(
  ledger: BudgetLedger,
  action: ProposedAction,
  now: UnixSeconds,
  stateAtApproval?: Pick<WalletState, "action">,
): BudgetLedger {
  const L = rollLedger(ledger, now);

  switch (action.kind) {
    case "treasuryTransfer": {
      const key = treasurySpentKey(action);
      const prev = L.treasurySpent[key] ?? 0n;
      return { ...L, treasurySpent: { ...L.treasurySpent, [key]: prev + action.amount } };
    }
    case "allowance":
      return { ...L, lastAllowanceAt: now, allowanceAmountToday: action.amount };
    case "inference": {
      const cat = action.category;
      return {
        ...L,
        inferenceSpent: { ...L.inferenceSpent, [cat]: L.inferenceSpent[cat] + action.maxCostUsd },
      };
    }
    case "actionTransfer":
      return recordCounterparty(L, action.to, action.asset, action.amount, stateAtApproval);
    case "actionMint":
      // A2 rev 2: actionMint is counterparty-capped (target-keyed, "ETH").
      return recordCounterparty(L, action.target, "ETH", action.value, stateAtApproval);
    // SPEC-M2B §1 pace counters.
    case "castPost":
      return { ...L, castPostsToday: L.castPostsToday + 1n };
    case "castReply":
      return { ...L, castRepliesToday: L.castRepliesToday + 1n };
    case "journalWrite":
      return { ...L, journalToday: L.journalToday + 1n };
    case "heartbeat":
    case "registerInstance":
    case "distribute":
    case "treasurySwap":
    case "actionSwap":
    case "actionLp":
    case "actionApprove":
    case "treasuryApprove":
      // No budget buckets for these kinds (A2-exempt / zero-value / income / approvals).
      return L;
  }
}

/** A2 bookkeeping: add `amount` to counterpartySpent[cp][asset]; snapshot the non-USDG denominator on first send. */
function recordCounterparty(
  L: BudgetLedger,
  counterparty: Address,
  asset: ActionAsset,
  amount: bigint,
  stateAtApproval: Pick<WalletState, "action"> | undefined,
): BudgetLedger {
  const to = lower(counterparty) as Address;
  const ak = assetKeyOf(asset);
  const prevRec: Record<string, bigint> = L.counterpartySpent[to] ?? {};
  const rec: Record<string, bigint> = { ...prevRec, [ak]: (prevRec[ak] ?? 0n) + amount };
  if (ak !== "USDG" && prevRec[denomKey(ak)] === undefined && stateAtApproval !== undefined) {
    rec[denomKey(ak)] = rhBalanceOf(stateAtApproval.action, asset);
  }
  return { ...L, counterpartySpent: { ...L.counterpartySpent, [to]: rec } };
}

// ---------------------------------------------------------------------------
// recordFeeIncome
// ---------------------------------------------------------------------------

/** Daemon-called at UTC rollover: append a complete day's fee income, keep the last 7. */
export function recordFeeIncome(ledger: BudgetLedger, dayTotalUsdg: bigint): BudgetLedger {
  const next = [...ledger.feeIncome7d, dayTotalUsdg];
  return { ...ledger, feeIncome7d: next.slice(Math.max(0, next.length - 7)) };
}
