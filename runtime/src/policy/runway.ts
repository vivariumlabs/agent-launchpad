// SPEC-M2 §3 "Runway". Pure integer day math.
//
//   fundable   = treasury.arbitrum.USDC + haircut(treasury.rh.USDG)
//   haircut(x) = x * (10_000 - bridgeHaircutBps) / 10_000        (floor)
//   runwayDays = floor((hostingPaidUntil - now) / 86400) + floor(fundable / hostingRatePerDay)
//
// Both terms are FLOORED (not truncated): hostingPaidUntil 1s in the past
// contributes -1 day. hostingRatePerDay = 0n means hosting costs nothing ⇒
// runway is treated as infinite and RUNWAY_INFINITE_DAYS is returned.
// A spend reduces the leg it is drawn from BEFORE the haircut is applied;
// spends on any other (chain, asset) leave `fundable` unchanged (e.g. inference
// paid from Base USDC, gasTopUp ETH) but callers still gate on the result (T0).

import type { Chain, UnixSeconds, WalletState } from "./types.js";
import { applyBps, BPS_DENOM, floorDiv, SECONDS_PER_DAY } from "./util.js";

/** Sentinel returned when hostingRatePerDay is 0n (infinite runway). 10^9 days. */
export const RUNWAY_INFINITE_DAYS = 1_000_000_000n;

export interface SpendDelta {
  chain: Chain;
  asset: "USDG" | "USDC" | "ETH";
  amount: bigint;
}

export type RunwayState = Pick<WalletState, "treasury" | "hostingPaidUntil" | "hostingRatePerDay">;

/** Fundable hosting balance (USDC(6)-equivalent) after an optional spend. */
export function fundable(state: RunwayState, bridgeHaircutBps: number, spend?: SpendDelta): bigint {
  let arbUsdc = state.treasury.arbitrum?.USDC ?? 0n;
  let rhUsdg = state.treasury.rh?.USDG ?? 0n;
  if (spend !== undefined) {
    if (spend.chain === "arbitrum" && spend.asset === "USDC") arbUsdc -= spend.amount;
    else if (spend.chain === "rh" && spend.asset === "USDG") rhUsdg -= spend.amount;
  }
  return arbUsdc + applyBps(rhUsdg, Number(BPS_DENOM) - bridgeHaircutBps);
}

/**
 * Runway in whole days after `spend` (if any). May be negative.
 * `bridgeHaircutBps` comes from cfg.bridgeHaircutBps (explicit so the helper
 * stays config-free and pure).
 */
export function runwayDays(
  state: RunwayState,
  now: UnixSeconds,
  spend: SpendDelta | undefined,
  bridgeHaircutBps: number,
): bigint {
  if (state.hostingRatePerDay === 0n) return RUNWAY_INFINITE_DAYS;
  const paidDays = floorDiv(state.hostingPaidUntil - now, SECONDS_PER_DAY);
  const fundedDays = floorDiv(fundable(state, bridgeHaircutBps, spend), state.hostingRatePerDay);
  return paidDays + fundedDays;
}
