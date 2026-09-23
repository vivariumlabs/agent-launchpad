// SPEC-M2 §3 Action-wallet rules A1–A4 (+ G3). Action rules see ONLY the
// action wallet's balances (WalletBalances), never the treasury's.
//
// A4 chain: no action-wallet kind carries a chain field, so a non-RH chain is
// unrepresentable in a ProposedAction; balances are always read from
// `action.rh` and executors bind action-wallet transactions to RH. CHAIN is
// therefore never emitted by the engine in M2.
//
// USDG canonical form: in action-wallet kinds USDG MUST be referenced by the
// "USDG" symbol. Referencing the USDG token contract by address (cfg.usdg.rh)
// is denied NO_RULE — otherwise A2 would book the same asset under two keys.
//
// Check orders:
//   actionTransfer: USDG-by-address → A3 LOOKALIKE → G3 → A1 PER_TX_CAP → A2 COUNTERPARTY_CAP
//   actionSwap:     USDG-by-address → same-token (NO_RULE) → G3 → A1
//   actionLp:       USDG-by-address → G3 (USDG leg, token leg) → A1 (USDG leg, token leg)
//   actionMint:     A3 LOOKALIKE (target) → G3 (native) → A1 (native)

import type { ResolvedConfig } from "../../config/schema.js";
import { denomKey } from "../../ledger/ledger.js";
import type { BudgetLedger, ProposedAction, UnixSeconds, Verdict, WalletBalances } from "../types.js";
import { applyBps, assetKeyOf, lower, minBig, rhBalanceOf, sameAddress, type ActionAsset } from "../util.js";
import { allow, deny } from "./common.js";

type ActionTransfer = Extract<ProposedAction, { kind: "actionTransfer" }>;
type ActionSwap = Extract<ProposedAction, { kind: "actionSwap" }>;
type ActionLp = Extract<ProposedAction, { kind: "actionLp" }>;
type ActionMint = Extract<ProposedAction, { kind: "actionMint" }>;

export function evaluateActionWallet(
  a: ProposedAction,
  w: WalletBalances,
  L: BudgetLedger,
  cfg: ResolvedConfig,
  now: UnixSeconds,
): Verdict {
  switch (a.kind) {
    case "actionTransfer":
      return evaluateActionTransfer(a, w, L, cfg, now);
    case "actionSwap":
      return evaluateActionSwap(a, w, cfg, now);
    case "actionLp":
      return evaluateActionLp(a, w, cfg, now);
    case "actionMint":
      return evaluateActionMint(a, w, cfg, now);
    default:
      // G2: nothing else may come from the action wallet.
      return deny("NO_RULE", `G2: kind "${a.kind}" has no action-wallet rule`);
  }
}

// ---------------------------------------------------------------------------
// A3 look-alike guard
// ---------------------------------------------------------------------------

/**
 * Protected set (lowercased, deduped): own treasury EOA, all Marlin payment
 * addresses, all Across SpokePools (every chain), the Arweave funding address,
 * and every x402 allowlist payTo (both kinds). The own ACTION EOA is
 * deliberately excluded (SPEC A3: self-send is allowed if caps pass).
 */
export function protectedAddresses(cfg: ResolvedConfig): string[] {
  const all: string[] = [
    cfg.treasury,
    ...cfg.marlin.paymentAddresses,
    ...Object.values(cfg.across.spokePool),
    cfg.arweaveFundingAddress,
    ...cfg.x402Allowlist.map((e) => e.payTo),
  ];
  return [...new Set(all.map(lower))];
}

/** First 4 bytes (hex chars 2..10) and last 4 bytes (final 8 hex chars) of a lowercased address. */
function prefix4(a: string): string {
  return lower(a).slice(2, 10);
}
function suffix4(a: string): string {
  const l = lower(a);
  return l.slice(l.length - 8);
}

/** A3: returns the protected address `to` equals or collides with, or null. */
export function lookalikeOf(to: string, protectedSet: readonly string[]): string | null {
  const t = lower(to);
  const p = prefix4(t);
  const s = suffix4(t);
  for (const x of protectedSet) {
    if (x === t || prefix4(x) === p || suffix4(x) === s) return x;
  }
  return null;
}

function checkA3(target: string, cfg: ResolvedConfig): Verdict | null {
  const hit = lookalikeOf(target, protectedAddresses(cfg));
  if (hit === null) return null;
  return deny(
    "LOOKALIKE",
    lower(target) === hit
      ? `A3: ${target} is a protected address`
      : `A3: ${target} shares first/last 4 bytes with protected address ${hit}`,
  );
}

// ---------------------------------------------------------------------------
// G3 + A1
// ---------------------------------------------------------------------------

function isUsdgAddress(asset: ActionAsset, cfg: ResolvedConfig): boolean {
  return asset !== "USDG" && asset !== "ETH" && sameAddress(asset, cfg.usdg.rh);
}

/** G3 then A1 for one outgoing leg. */
function checkLeg(label: string, asset: ActionAsset, amount: bigint, w: WalletBalances, cfg: ResolvedConfig): Verdict | null {
  const bal = rhBalanceOf(w, asset);
  if (bal < amount) {
    return deny("INSUFFICIENT_BALANCE", `G3: action rh ${asset} balance ${bal} < ${label} ${amount}`);
  }
  const cap = applyBps(bal, cfg.perTxPctBps);
  if (amount > cap) {
    return deny("PER_TX_CAP", `A1: ${label} ${amount} > ${cfg.perTxPctBps}bps of ${asset} balance ${bal} = ${cap}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// A2 counterparty cap
// ---------------------------------------------------------------------------

/**
 * Today's counterparty record for `to`, matching ledger keys case-insensitively
 * (reducers write lowercase; any stray casing is merged conservatively:
 * spends summed, denominator snapshots min'd).
 */
function counterpartyRecord(L: BudgetLedger, to: string): Record<string, bigint> {
  const t = lower(to);
  const out: Record<string, bigint> = {};
  for (const [k, rec] of Object.entries(L.counterpartySpent)) {
    if (lower(k) !== t) continue;
    for (const [ak, v] of Object.entries(rec)) {
      const prev = out[ak];
      if (ak.endsWith(":denom")) out[ak] = prev === undefined ? v : minBig(prev, v);
      else out[ak] = (prev ?? 0n) + v;
    }
  }
  return out;
}

function checkA2(a: ActionTransfer, w: WalletBalances, L: BudgetLedger, cfg: ResolvedConfig): Verdict | null {
  const ak = assetKeyOf(a.asset);
  const rec = counterpartyRecord(L, a.to);
  const spent = rec[ak] ?? 0n;
  let denom: bigint;
  let basis: string;
  if (ak === "USDG") {
    denom = L.allowanceAmountToday;
    basis = "allowanceAmountToday";
  } else {
    const snap = rec[denomKey(ak)];
    denom = snap ?? rhBalanceOf(w, a.asset);
    basis = snap === undefined ? "current balance" : "first-send snapshot";
  }
  const cap = applyBps(denom, cfg.counterpartyPctBps);
  if (spent + a.amount > cap) {
    return deny(
      "COUNTERPARTY_CAP",
      `A2: to ${lower(a.to)} ${ak} spent today ${spent} + ${a.amount} > ${cfg.counterpartyPctBps}bps of ${basis} ${denom} = ${cap}`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

function evaluateActionTransfer(a: ActionTransfer, w: WalletBalances, L: BudgetLedger, cfg: ResolvedConfig, now: UnixSeconds): Verdict {
  if (isUsdgAddress(a.asset, cfg)) return deny("NO_RULE", `USDG must be referenced as "USDG", not by token address`);
  const a3 = checkA3(a.to, cfg);
  if (a3 !== null) return a3;
  const leg = checkLeg("amount", a.asset, a.amount, w, cfg);
  if (leg !== null) return leg;
  const a2 = checkA2(a, w, L, cfg);
  if (a2 !== null) return a2;
  return allow(a, now);
}

function evaluateActionSwap(a: ActionSwap, w: WalletBalances, cfg: ResolvedConfig, now: UnixSeconds): Verdict {
  if (isUsdgAddress(a.tokenIn, cfg) || isUsdgAddress(a.tokenOut, cfg)) {
    return deny("NO_RULE", `USDG must be referenced as "USDG", not by token address`);
  }
  // A4: every token is an RH token (no chain field; executor routes via cfg.poolManager.rh).
  if (assetKeyOf(a.tokenIn) === assetKeyOf(a.tokenOut)) {
    return deny("NO_RULE", `A4: tokenIn and tokenOut are the same asset`);
  }
  // A2 exempt (canonical PoolManager); minOut >= 0 accepted as given (G1).
  const leg = checkLeg("amountIn", a.tokenIn, a.amountIn, w, cfg);
  if (leg !== null) return leg;
  return allow(a, now);
}

function evaluateActionLp(a: ActionLp, w: WalletBalances, cfg: ResolvedConfig, now: UnixSeconds): Verdict {
  if (isUsdgAddress(a.token, cfg)) {
    return deny("NO_RULE", `A4: LP token must not be USDG (pool must be USDG/<token>)`);
  }
  // A4: pool includes USDG by construction (usdgAmount leg). PoolId ↔ (USDG, token)
  // binding is not computable here without fee/tickSpacing/hooks — executor concern.
  const usdgLeg = checkLeg("usdgAmount", "USDG", a.usdgAmount, w, cfg);
  if (usdgLeg !== null) return usdgLeg;
  const tokenLeg = checkLeg("tokenAmount", a.token, a.tokenAmount, w, cfg);
  if (tokenLeg !== null) return tokenLeg;
  return allow(a, now);
}

function evaluateActionMint(a: ActionMint, w: WalletBalances, cfg: ResolvedConfig, now: UnixSeconds): Verdict {
  const a3 = checkA3(a.target, cfg);
  if (a3 !== null) return a3;
  const leg = checkLeg("value", "ETH", a.value, w, cfg);
  if (leg !== null) return leg;
  return allow(a, now);
}
