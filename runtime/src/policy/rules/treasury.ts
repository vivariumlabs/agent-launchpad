// SPEC-M2 §3 Treasury rules T0–T5 (+ G3 balance checks). Treasury rules see
// ONLY the treasury wallet (RunwayState has no `action` field), so a treasury
// kind can never be evaluated against action-wallet balances.
//
// Check orders:
//   treasuryTransfer: T2 WHITELIST → T2 BRIDGE_RECIPIENT → G3 → T3 DAILY_CAP → T0 RUNWAY
//                     (T0 rev 2: ONLY acrossBridge with asset USDG/USDC; oysterRental, gasTopUp,
//                     ETH bridges, arweaveFunding and x402Data are T0-exempt)
//   allowance:        T4 ALLOWANCE_EARLY → G3 → T4 ALLOWANCE_AMOUNT → T0 RUNWAY
//   treasurySwap:     T5 (tokenIn ≠ USDG ⇒ NO_RULE) → G3 (held on RH, amountIn ≤ balance). T0-exempt.
//   heartbeat / registerInstance / distribute: T1 allow.
//   treasuryApprove:  AP2 APPROVE_SPENDER (spender == cfg.swapRouter.rh) → token ≠ USDG (NO_RULE)
//                     → G3 (held on RH, amount ≤ balance). T0-exempt (no outflow).

import type { ResolvedConfig } from "../../config/schema.js";
import { treasurySpentKey } from "../../ledger/ledger.js";
import type { RunwayState } from "../runway.js";
import type { BudgetLedger, ProposedAction, UnixSeconds, Verdict, WalletBalances } from "../types.js";
import { applyBps, lookupToken, lower, minBig, SECONDS_PER_DAY, sameAddress } from "../util.js";
import { allow, deny, runwayGate } from "./common.js";
import { evaluateInference } from "./inference.js";

type TreasuryTransfer = Extract<ProposedAction, { kind: "treasuryTransfer" }>;
type Allowance = Extract<ProposedAction, { kind: "allowance" }>;
type TreasurySwap = Extract<ProposedAction, { kind: "treasurySwap" }>;
type TreasuryApprove = Extract<ProposedAction, { kind: "treasuryApprove" }>;

export function evaluateTreasury(
  a: ProposedAction,
  s: RunwayState,
  L: BudgetLedger,
  cfg: ResolvedConfig,
  now: UnixSeconds,
): Verdict {
  switch (a.kind) {
    case "heartbeat":
    case "registerInstance":
    case "distribute":
      // T1: zero-value calls; executors hardcode target+selector from config.
      return allow(a, now);
    case "treasuryTransfer":
      return evaluateTreasuryTransfer(a, s, L, cfg, now);
    case "allowance":
      return evaluateAllowance(a, s, L, cfg, now);
    case "treasurySwap":
      return evaluateTreasurySwap(a, s, cfg, now);
    case "inference":
      return evaluateInference(a, s, L, cfg, now);
    case "treasuryApprove":
      return evaluateTreasuryApprove(a, s, cfg, now);
    default:
      // G2: nothing else may come from the treasury wallet.
      return deny("NO_RULE", `G2: kind "${a.kind}" has no treasury rule`);
  }
}

// ---------------------------------------------------------------------------
// T2 matrix
// ---------------------------------------------------------------------------

function inList(to: string, list: readonly string[]): boolean {
  const t = lower(to);
  return list.some((x) => lower(x) === t);
}

/** T2: returns a WHITELIST / BRIDGE_RECIPIENT deny, or null if the transfer matches its row exactly. */
export function checkT2(a: TreasuryTransfer, cfg: ResolvedConfig): Verdict | null {
  const row = `T2[${a.purpose}]`;
  const wl = (why: string): Verdict => deny("WHITELIST", `${row}: ${why}`);
  switch (a.purpose) {
    case "oysterRental":
      if (a.chain !== "arbitrum") return wl(`chain must be arbitrum, got ${a.chain}`);
      if (a.asset !== "USDC") return wl(`asset must be USDC, got ${a.asset}`);
      if (!inList(a.to, cfg.marlin.paymentAddresses)) return wl(`to ${a.to} is not a Marlin payment address`);
      return null;
    case "acrossBridge": {
      const spoke = cfg.across.spokePool[a.chain];
      if (!sameAddress(a.to, spoke)) return wl(`to ${a.to} is not the Across SpokePool on ${a.chain}`);
      if (a.recipient === undefined) return deny("BRIDGE_RECIPIENT", `${row}: recipient is required`);
      if (!sameAddress(a.recipient, cfg.treasury)) {
        return deny("BRIDGE_RECIPIENT", `${row}: recipient ${a.recipient} is not the own treasury EOA`);
      }
      return null;
    }
    case "arweaveFunding":
      if (a.chain !== "rh") return wl(`chain must be rh, got ${a.chain}`);
      if (a.asset !== "USDG") return wl(`asset must be USDG, got ${a.asset}`);
      if (!sameAddress(a.to, cfg.arweaveFundingAddress)) return wl(`to ${a.to} is not the Arweave funding address`);
      return null;
    case "gasTopUp":
      if (a.asset !== "ETH") return wl(`asset must be ETH, got ${a.asset}`);
      if (!inList(a.to, [cfg.treasury, cfg.action])) return wl(`to ${a.to} is not an own EOA`);
      return null;
    case "x402Data": {
      // rev 1: no x402Inference purpose — inference is paid only via the `inference` kind.
      if (a.chain !== "base") return wl(`chain must be base, got ${a.chain}`);
      if (a.asset !== "USDC") return wl(`asset must be USDC, got ${a.asset}`);
      const payTos = cfg.x402Allowlist.filter((e) => e.kind === "data").map((e) => e.payTo);
      if (!inList(a.to, payTos)) return wl(`to ${a.to} is not an allowlisted data endpoint payTo`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// T3 caps
// ---------------------------------------------------------------------------

/** T3 daily cap for a treasuryTransfer, in the bucket's asset units. */
export function t3Cap(a: TreasuryTransfer, cfg: ResolvedConfig): bigint {
  switch (a.purpose) {
    case "oysterRental":
      return cfg.oysterRentalDailyCapUsdc;
    case "acrossBridge":
      // ETH bridges count against the gasTopUp per-chain cap (source chain).
      return a.asset === "ETH" ? cfg.gasTopUpDailyCapWeiPerChain : cfg.acrossBridgeDailyCapUsd;
    case "arweaveFunding":
      return cfg.arweaveDailyCapUsdg;
    case "gasTopUp":
      return cfg.gasTopUpDailyCapWeiPerChain;
    case "x402Data":
      return cfg.x402DataDailyCapUsdc;
  }
}

function treasuryBalance(w: WalletBalances, chain: TreasuryTransfer["chain"], asset: TreasuryTransfer["asset"]): bigint {
  const c = w[chain];
  if (asset === "ETH") return c?.native ?? 0n;
  if (asset === "USDG") return c?.USDG ?? 0n;
  return c?.USDC ?? 0n;
}

function evaluateTreasuryTransfer(
  a: TreasuryTransfer,
  s: RunwayState,
  L: BudgetLedger,
  cfg: ResolvedConfig,
  now: UnixSeconds,
): Verdict {
  const t2 = checkT2(a, cfg);
  if (t2 !== null) return t2;

  const bal = treasuryBalance(s.treasury, a.chain, a.asset);
  if (bal < a.amount) {
    return deny("INSUFFICIENT_BALANCE", `G3: treasury ${a.chain} ${a.asset} balance ${bal} < amount ${a.amount}`);
  }

  const key = treasurySpentKey(a);
  const spent = L.treasurySpent[key] ?? 0n;
  const cap = t3Cap(a, cfg);
  if (spent + a.amount > cap) {
    return deny("DAILY_CAP", `T3[${key}]: spent today ${spent} + ${a.amount} > cap ${cap}`);
  }

  // T0 rev 2: the reserve gates only outflows that drain `fundable` — USDG/USDC bridges.
  if (a.purpose === "acrossBridge" && (a.asset === "USDG" || a.asset === "USDC")) {
    const r = runwayGate(s, now, { chain: a.chain, asset: a.asset, amount: a.amount }, cfg);
    if (r !== null) return r;
  }
  return allow(a, now);
}

// ---------------------------------------------------------------------------
// T4 allowance
// ---------------------------------------------------------------------------

/** T4 max allowance = min(treasury.rh.USDG × allowancePctBps, allowanceCapUsdg). */
export function allowanceMax(s: RunwayState, cfg: ResolvedConfig): bigint {
  const usdg = s.treasury.rh?.USDG ?? 0n;
  return minBig(applyBps(usdg, cfg.allowancePctBps), cfg.allowanceCapUsdg);
}

function evaluateAllowance(a: Allowance, s: RunwayState, L: BudgetLedger, cfg: ResolvedConfig, now: UnixSeconds): Verdict {
  // lastAllowanceAt = 0n means "never"; now >= 86400 always holds for real clocks,
  // but treat 0n explicitly as never so tiny test clocks behave the same.
  if (L.lastAllowanceAt !== 0n && now - L.lastAllowanceAt < SECONDS_PER_DAY) {
    return deny(
      "ALLOWANCE_EARLY",
      `T4: ${now - L.lastAllowanceAt}s since last allowance < ${SECONDS_PER_DAY}s`,
    );
  }
  const usdg = s.treasury.rh?.USDG ?? 0n;
  if (usdg < a.amount) {
    return deny("INSUFFICIENT_BALANCE", `G3: treasury rh USDG balance ${usdg} < amount ${a.amount}`);
  }
  const max = allowanceMax(s, cfg);
  if (a.amount > max) {
    return deny("ALLOWANCE_AMOUNT", `T4: amount ${a.amount} > min(${cfg.allowancePctBps}bps of ${usdg}, ${cfg.allowanceCapUsdg}) = ${max}`);
  }
  const r = runwayGate(s, now, { chain: "rh", asset: "USDG", amount: a.amount }, cfg);
  if (r !== null) return r;
  return allow(a, now);
}

// ---------------------------------------------------------------------------
// T5 treasurySwap (T0-exempt: converts held tokens INTO USDG, not a fundable outflow)
// ---------------------------------------------------------------------------

function evaluateTreasurySwap(a: TreasurySwap, s: RunwayState, cfg: ResolvedConfig, now: UnixSeconds): Verdict {
  if (sameAddress(a.tokenIn, cfg.usdg.rh)) {
    return deny("NO_RULE", `T5: tokenIn must not be USDG`);
  }
  const held = lookupToken(s.treasury.rh?.tokens, a.tokenIn);
  if (held === undefined) {
    return deny("INSUFFICIENT_BALANCE", `G3/T5: treasury holds no ${a.tokenIn} on rh`);
  }
  if (held < a.amountIn) {
    return deny("INSUFFICIENT_BALANCE", `G3/T5: treasury rh ${a.tokenIn} balance ${held} < amountIn ${a.amountIn}`);
  }
  // minOut > 0 is enforced at G1 (MALFORMED).
  return allow(a, now);
}

// ---------------------------------------------------------------------------
// AP2 treasuryApprove (SPEC-M2B §1) — for T5 income-conversion swaps
// ---------------------------------------------------------------------------

function evaluateTreasuryApprove(a: TreasuryApprove, s: RunwayState, cfg: ResolvedConfig, now: UnixSeconds): Verdict {
  if (!sameAddress(a.spender, cfg.swapRouter.rh)) {
    return deny("APPROVE_SPENDER", `AP2: spender ${a.spender} is not the configured swap router`);
  }
  if (sameAddress(a.token, cfg.usdg.rh)) {
    return deny("NO_RULE", `AP2: token must not be USDG`);
  }
  const held = lookupToken(s.treasury.rh?.tokens, a.token);
  if (held === undefined) {
    return deny("INSUFFICIENT_BALANCE", `G3/AP2: treasury holds no ${a.token} on rh`);
  }
  if (held < a.amount) {
    return deny("INSUFFICIENT_BALANCE", `G3/AP2: treasury rh ${a.token} balance ${held} < amount ${a.amount}`);
  }
  return allow(a, now);
}
