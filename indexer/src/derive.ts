// SPEC-M4A §1 derive.ts — pure functions (no I/O, no clock, no floats): status badge, price, 24h
// volume, market cap, fee totals. Money is bigint end-to-end; the API formats strings.
//
// Units:
//   USDG amounts        — USDG base units (6 decimals: FeeSplitHook.sol:98, Deploy.s.sol:243).
//   agent-token amounts — token base units (18 decimals: AgentToken is an OZ ERC20 with the default
//                         decimals(), AgentToken.sol:23).
//   priceE18            — USDG per WHOLE agent token, scaled by 1e18 (a fixed-point integer).
//   mcapUsdg            — USDG base units.
//
// token0/token1 resolution (Uniswap v4): a PoolKey orders its currencies ascending by address
// (currency0 < currency1). FeeSplitHook.registerPool accepts only {c0,c1} = {agentToken, usdg}
// (FeeSplitHook.sol:255-262), so for our pools the agent token is currency0 ⇔ agentToken < usdg
// (numeric address order = lowercase-hex string order). The watcher stores that bit per pool at
// PoolRegistered (pools.agentIsCurrency0). sqrtPriceX96 = sqrt(amount1/amount0 in base units) × 2^96:
//   agent = currency0: raw USDG per raw token = sqrtP² / 2^192
//   agent = currency1: raw USDG per raw token = 2^192 / sqrtP²
// and priceE18 = raw × 10^(tokenDecimals − usdgDecimals) × 1e18 = raw × 10^30.

export type Status = "live" | "stale" | "evicted" | "pending";

export const USDG_DECIMALS = 6;
export const TOKEN_DECIMALS = 18;
export const PRICE_DECIMALS = 18;
/** 10^(PRICE_DECIMALS + TOKEN_DECIMALS − USDG_DECIMALS). */
const RAW_TO_E18 = 10n ** BigInt(PRICE_DECIMALS + TOKEN_DECIMALS - USDG_DECIMALS);
export const Q192 = 1n << 192n;
export const DAY_SEC = 86_400n;
/** AgentRegistry.sol:13 REVIVAL_WINDOW = 7 days — used only until the watcher has read the constant. */
export const DEFAULT_REVIVAL_WINDOW = 604_800n;

/**
 * SPEC-M4A §0 status (bounded honesty: chain data only, not the runtime tier):
 *   pending — no registered instance; live — heartbeat age ≤ staleAfterSec;
 *   stale — older, but ≤ REVIVAL_WINDOW (the registry's own revival gate, AgentRegistry.sol:97);
 *   evicted — older than REVIVAL_WINDOW.
 */
export function status(
  instance: { lastHeartbeat: bigint | number } | null | undefined,
  now: bigint,
  revivalWindow: bigint,
  staleAfterSec: bigint,
): Status {
  if (instance === null || instance === undefined) return "pending";
  const hb = BigInt(instance.lastHeartbeat);
  if (hb === 0n) return "pending";
  const age = now - hb;
  if (age <= staleAfterSec) return "live";
  if (age <= revivalWindow) return "stale";
  return "evicted";
}

/** USDG per whole token × 1e18 from a pool's sqrtPriceX96 (floor). null for a zero price. */
export function priceFromSqrtPriceX96(sqrtPriceX96: bigint, agentIsCurrency0: boolean): bigint | null {
  if (sqrtPriceX96 <= 0n) return null;
  const sq = sqrtPriceX96 * sqrtPriceX96;
  return agentIsCurrency0 ? (sq * RAW_TO_E18) / Q192 : (Q192 * RAW_TO_E18) / sq;
}

/** USDG per whole token × 1e18 from a curve fill (usdg / tokens, floor). null when tokens = 0. */
export function priceFromCurveTrade(usdg: bigint, tokens: bigint): bigint | null {
  if (tokens <= 0n) return null;
  return (usdg * RAW_TO_E18) / tokens;
}

export interface PriceResult {
  priceE18: bigint;
  source: "pool" | "curve";
}

/** Latest pool swap wins; fallback: the latest bonding-curve trade; else null. */
export function derivePrice(
  latestSwap: { sqrtPriceX96: bigint; agentIsCurrency0: boolean } | null | undefined,
  latestCurveTrade: { usdg: bigint; tokens: bigint } | null | undefined,
): PriceResult | null {
  if (latestSwap !== null && latestSwap !== undefined) {
    const p = priceFromSqrtPriceX96(latestSwap.sqrtPriceX96, latestSwap.agentIsCurrency0);
    if (p !== null) return { priceE18: p, source: "pool" };
  }
  if (latestCurveTrade !== null && latestCurveTrade !== undefined) {
    const p = priceFromCurveTrade(latestCurveTrade.usdg, latestCurveTrade.tokens);
    if (p !== null) return { priceE18: p, source: "curve" };
  }
  return null;
}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/**
 * USDG volume (base units) over (now − 24h, now]: |USDG-side delta| of every pool swap + the USDG
 * leg of every curve trade. The USDG side of a swap is amount1 when the agent is currency0, else amount0.
 */
export function volume24h(
  swaps: ReadonlyArray<{ ts: bigint | number; amount0: bigint; amount1: bigint; agentIsCurrency0: boolean }>,
  curveTrades: ReadonlyArray<{ ts: bigint | number; usdg: bigint }>,
  now: bigint,
): bigint {
  const since = now - DAY_SEC;
  let v = 0n;
  for (const s of swaps) {
    const t = BigInt(s.ts);
    if (t <= since || t > now) continue;
    v += abs(s.agentIsCurrency0 ? s.amount1 : s.amount0);
  }
  for (const c of curveTrades) {
    const t = BigInt(c.ts);
    if (t <= since || t > now) continue;
    v += abs(c.usdg);
  }
  return v;
}

/** priceE18 × totalSupply (token base units) → USDG base units (floor). */
export function mcapUsdg(priceE18: bigint, totalSupply: bigint): bigint {
  return (priceE18 * totalSupply) / RAW_TO_E18;
}

/**
 * SPEC-M4G: `platformLeg` = the hook's platform third (v2: the floor vault, D18; v1: the retired
 * buyback). The fees.buybackLeg db column keeps its name.
 */
export interface FeeTotals {
  platformLeg: bigint;
  treasuryLeg: bigint;
  royaltyLeg: bigint;
  converted: bigint;
  count: number;
}

export function feeTotals(rows: ReadonlyArray<{ platformLeg: bigint; treasuryLeg: bigint; royaltyLeg: bigint; converted: bigint }>): FeeTotals {
  const t: FeeTotals = { platformLeg: 0n, treasuryLeg: 0n, royaltyLeg: 0n, converted: 0n, count: rows.length };
  for (const r of rows) {
    t.platformLeg += r.platformLeg;
    t.treasuryLeg += r.treasuryLeg;
    t.royaltyLeg += r.royaltyLeg;
    t.converted += r.converted;
  }
  return t;
}

/** 1e36 — floorPriceX18 = B · 1e36 / S (USDG base units per whole 1e18-unit token, × 1e18; IFloorVault.floorPrice). */
export const FLOOR_PRICE_SCALE = 10n ** 36n;

/**
 * SPEC-M4G §3 / R3 floor price: floor(B · 1e36 / S) with B = vault USDG (base units) and S = the
 * platform token's totalSupply (base units) — the same value IFloorVault.floorPrice() returns.
 * 0 when S = 0 (floor undefined).
 */
export function floorPriceX18(vaultUsdg: bigint, totalSupply: bigint): bigint {
  if (totalSupply <= 0n) return 0n;
  return (vaultUsdg * FLOOR_PRICE_SCALE) / totalSupply;
}

/** Fixed-point integer → decimal string, trailing zeros trimmed ("1500000", 6 → "1.5"). */
export function formatFixed(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const int = v / scale;
  const frac = (v % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac === "" ? "" : `.${frac}`}`;
}
