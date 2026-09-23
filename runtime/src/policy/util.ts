// Shared pure helpers for src/policy and src/ledger. Integer (bigint) math only.

import type { Address } from "viem";
import type { WalletBalances } from "./types.js";

export const BPS_DENOM = 10_000n;
export const SECONDS_PER_DAY = 86_400n;

/** Lowercase an address/hex string for case-insensitive comparison. */
export function lower(a: string): string {
  return a.toLowerCase();
}

export function sameAddress(a: string, b: string): boolean {
  return lower(a) === lower(b);
}

/** Floor division for bigint (BigInt `/` truncates toward zero). Throws on b = 0n. */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  if ((a % b !== 0n) && ((a < 0n) !== (b < 0n))) return q - 1n;
  return q;
}

/** amount * bps / 10000, floored. */
export function applyBps(amount: bigint, bps: number): bigint {
  return floorDiv(amount * BigInt(bps), BPS_DENOM);
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Case-insensitive lookup in a token balance map. If several keys match the
 * same address with different casing, the SMALLEST value is returned
 * (conservative). Missing ⇒ undefined.
 */
export function lookupToken(tokens: Record<Address, bigint> | undefined, addr: string): bigint | undefined {
  if (tokens === undefined) return undefined;
  const target = lower(addr);
  let found: bigint | undefined;
  for (const [k, v] of Object.entries(tokens)) {
    if (lower(k) === target && typeof v === "bigint") {
      found = found === undefined ? v : minBig(found, v);
    }
  }
  return found;
}

/** Action-wallet asset designator: "USDG", "ETH" (native) or an ERC-20 address. */
export type ActionAsset = Address | "USDG" | "ETH";

/** Counterparty-ledger asset key: "USDG" | "ETH" | lowercased token address. */
export function assetKeyOf(asset: ActionAsset): string {
  if (asset === "USDG" || asset === "ETH") return asset;
  return lower(asset);
}

/**
 * Balance of `asset` on the RH chain of a wallet (action wallet only uses RH).
 * Missing asset ⇒ 0n (G3 then denies any positive amount).
 */
export function rhBalanceOf(wallet: WalletBalances, asset: ActionAsset): bigint {
  const rh = wallet.rh;
  if (asset === "ETH") return rh?.native ?? 0n;
  if (asset === "USDG") return rh?.USDG ?? 0n;
  return lookupToken(rh?.tokens, asset) ?? 0n;
}
