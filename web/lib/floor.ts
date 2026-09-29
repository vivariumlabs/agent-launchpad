/**
 * $TOKEN redemption floor (D18, SPEC-M4G §3/§4): inline ABI fragments,
 * tolerant /api/floor parser, exact bigint math + precise formatting.
 *
 * ABI transcribed from SPEC-M4G §1 IFloorVault (contracts/src/interfaces/
 * ILaunchpad.sol) + FloorVault custom errors — inline on purpose, no
 * cross-package import into the Next bundle (SPEC-M4A §2):
 *   event Redeemed(address indexed redeemer, uint256 tokensBurned, uint256 usdgPaid)
 *   event StrayBurned(address indexed caller, uint256 amount)
 *   function redeem(uint256 amount) returns (uint256 usdgPaid)
 *   function quoteRedeem(uint256 amount) view returns (uint256 usdgPaid)
 *   function floorPrice() view returns (uint256)   // USDG base units per whole token × 1e18
 *   function state() view returns (usdgBalance, tokenSupply, totalRedeemedUsdg, totalBurned)
 *
 * R3 (binding): payout = floor(amount · B / S) with B, S read before any
 * state change ⇒ for a fixed amount the payout never decreases over time, so
 * redeem has no min-out parameter. Addresses: ONLY from /api/contracts.
 */
import { parseTimestamp } from "./format";
import type { FloorFlow, FloorResult, FloorTotals, FloorView } from "./types";

export const floorVaultAbi = [
  {
    type: "function",
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ name: "usdgPaid", type: "uint256" }],
  },
  {
    type: "function",
    name: "quoteRedeem",
    stateMutability: "view",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ name: "usdgPaid", type: "uint256" }],
  },
  {
    type: "function",
    name: "floorPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "Redeemed",
    inputs: [
      { name: "redeemer", type: "address", indexed: true },
      { name: "tokensBurned", type: "uint256", indexed: false },
      { name: "usdgPaid", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "ZeroPayout", inputs: [] },
  { type: "error", name: "InexactTransfer", inputs: [] },
  { type: "error", name: "BurnFailed", inputs: [] },
  { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
] as const;

/** $TOKEN side: balanceOf / allowance / approve + OZ ERC20 custom errors (so viem decodes reverts). */
export const platformTokenAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [
      { name: "sender", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ERC20InsufficientAllowance",
    inputs: [
      { name: "spender", type: "address" },
      { name: "allowance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
] as const;

/** FloorVault asserts token.decimals() == 18 (R6). */
export const TOKEN_DECIMALS = 18;
export const USDG_DECIMALS = 6;
/** floorPriceX18 → human USDG per whole token: ÷ 1e18 (scale) ÷ 1e6 (USDG base units). */
export const FLOOR_PRICE_DECIMALS = 18 + USDG_DECIMALS;

/** R3 payout, exactly as the vault computes it: floor(amount · B / S); 0 when S == 0. */
export function payoutFor(amount: bigint, vaultUsdg: bigint, supply: bigint): bigint {
  if (supply === 0n || amount <= 0n) return 0n;
  return (amount * vaultUsdg) / supply;
}

/** floorPrice(): mulDiv(B, 1e36, S); 0 if S == 0. */
export function floorPriceX18Of(vaultUsdg: bigint, supply: bigint): bigint {
  return supply === 0n ? 0n : (vaultUsdg * 10n ** 36n) / supply;
}

// ---------------------------------------------------------------------------
// Precise formatting (a tiny floor must never render as "0")
// ---------------------------------------------------------------------------

function toBig(raw: string | bigint | null | undefined): bigint | null {
  if (typeof raw === "bigint") return raw;
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return null;
  try {
    return BigInt(raw.trim());
  } catch {
    return null;
  }
}

function withCommas(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Fixed-point integer -> decimal string keeping `sig` significant digits,
 * ROUNDED DOWN (never overstates a floor or a payout). Only an exact zero
 * renders as "0"; e.g. 1250195332658227848 @ 24 dec, sig 4 -> "0.00000125".
 * Integer parts are always shown in full.
 */
export function formatSignificant(raw: string | bigint | null | undefined, decimals: number, sig = 4): string | null {
  const v = toBig(raw);
  if (v === null) return null;
  if (v === 0n) return "0";
  const digits = v.toString();
  const intLen = digits.length - decimals;
  if (intLen > 0) {
    const intPart = digits.slice(0, intLen);
    const fracDigits = Math.max(0, sig - intLen);
    const frac = digits.slice(intLen, intLen + fracDigits).replace(/0+$/, "");
    return frac === "" ? withCommas(intPart) : `${withCommas(intPart)}.${frac}`;
  }
  const zeros = -intLen;
  const frac = digits.slice(0, sig).replace(/0+$/, "");
  return `0.${"0".repeat(zeros)}${frac}`;
}

const SUPERSCRIPT: Record<string, string> = {
  "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
};

/** Scientific form "1.250 × 10⁻⁶" for values < 1e-4 (null otherwise) — a second, glanceable rendering. */
export function formatScientific(raw: string | bigint | null | undefined, decimals: number, sig = 4): string | null {
  const v = toBig(raw);
  if (v === null || v === 0n) return null;
  const digits = v.toString();
  const exp = digits.length - decimals - 1;
  if (exp >= -4) return null;
  const mant = digits.slice(0, sig).padEnd(sig, "0");
  const expStr = String(exp).split("").map((c) => SUPERSCRIPT[c] ?? c).join("");
  return `${mant.charAt(0)}.${mant.slice(1)} × 10${expStr}`;
}

/** Human floor, USDG per whole token. */
export function formatFloorPrice(floorPriceX18: string | bigint | null, sig = 4): string | null {
  return formatSignificant(floorPriceX18, FLOOR_PRICE_DECIMALS, sig);
}

/** USDG amount, full 6-dp precision, trailing zeros trimmed (small payouts stay visible). */
export function formatUsdgPrecise(raw: string | bigint | null | undefined): string | null {
  const v = toBig(raw);
  if (v === null) return null;
  const base = 10n ** BigInt(USDG_DECIMALS);
  const int = withCommas((v / base).toString());
  const frac = (v % base).toString().padStart(USDG_DECIMALS, "0").replace(/0+$/, "");
  return frac === "" ? int : `${int}.${frac}`;
}

/** Token amount (18 dec): full integer part + up to 4 fractional digits, rounded down; sub-1 amounts keep 4 sig. */
export function formatTokenAmount(raw: string | bigint | null | undefined): string | null {
  const v = toBig(raw);
  if (v === null) return null;
  const base = 10n ** BigInt(TOKEN_DECIMALS);
  if (v > 0n && v < base) return formatSignificant(v, TOKEN_DECIMALS, 4);
  const int = withCommas((v / base).toString());
  const frac = (v % base).toString().padStart(TOKEN_DECIMALS, "0").slice(0, 4).replace(/0+$/, "");
  return frac === "" ? int : `${int}.${frac}`;
}

/**
 * User input ("1,234.5") -> token base units; null when not a plain
 * non-negative decimal or it has more than 18 fractional digits.
 */
export function parseTokenInput(text: string): bigint | null {
  const s = text.trim().replace(/,/g, "").replace(/_/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [intPart = "", fracPart = ""] = s.split(".");
  if (fracPart.length > TOKEN_DECIMALS) return null;
  try {
    return BigInt(intPart === "" ? "0" : intPart) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt(fracPart.padEnd(TOKEN_DECIMALS, "0") || "0");
  } catch {
    return null;
  }
}

/** Exact inverse of parseTokenInput (used by Max: every base unit preserved). */
export function tokenInputOf(v: bigint): string {
  const base = 10n ** BigInt(TOKEN_DECIMALS);
  const frac = (v % base).toString().padStart(TOKEN_DECIMALS, "0").replace(/0+$/, "");
  return frac === "" ? (v / base).toString() : `${(v / base).toString()}.${frac}`;
}

// ---------------------------------------------------------------------------
// Tolerant /api/floor parse
// ---------------------------------------------------------------------------

function uintStr(v: unknown): string | null {
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return v.trim();
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  return null;
}

function intOrNull(v: unknown): number | null {
  const s = uintStr(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function tsOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.floor(v > 1e12 ? v / 1000 : v) : null;
  if (typeof v === "string") return parseTimestamp(v);
  return null;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function normalizeFlow(raw: unknown): FloorFlow | null {
  const r = obj(raw);
  const txHash = strOrNull(r.txHash);
  const kind = strOrNull(r.kind);
  if (!txHash || !kind) return null;
  return {
    txHash,
    logIndex: intOrNull(r.logIndex),
    kind,
    account: strOrNull(r.account),
    usdg: uintStr(r.usdg),
    tokens: uintStr(r.tokens),
    agentId: intOrNull(r.agentId),
    ts: tsOf(r.ts),
    blockNumber: intOrNull(r.blockNumber),
  };
}

/**
 * /api/floor wire -> FloorResult. `{enabled:false}` (literal false) => disabled;
 * anything without a literal `enabled: true` => unavailable (never guessed).
 */
export function normalizeFloor(raw: unknown): FloorResult {
  const r = obj(raw);
  if (r.enabled === false) return { kind: "disabled" };
  if (r.enabled !== true) return { kind: "unavailable", message: "unexpected /api/floor response shape" };
  const t = obj(r.token);
  const tot = obj(r.totals);
  const totals: FloorTotals = {
    feePool: uintStr(tot.feePool),
    feeCurve: uintStr(tot.feeCurve),
    donations: uintStr(tot.donations),
    redeemedUsdg: uintStr(tot.redeemedUsdg),
    burnedTokens: uintStr(tot.burnedTokens),
    strayBurned: uintStr(tot.strayBurned),
    redemptions: intOrNull(tot.redemptions),
  };
  const recent = Array.isArray(r.recent)
    ? r.recent.map(normalizeFlow).filter((f): f is FloorFlow => f !== null).slice(0, 50)
    : [];
  const floor: FloorView = {
    vault: strOrNull(r.vault),
    token: {
      address: strOrNull(t.address),
      name: strOrNull(t.name),
      symbol: strOrNull(t.symbol),
      decimals: intOrNull(t.decimals),
      totalSupply: uintStr(t.totalSupply),
    },
    usdg: strOrNull(r.usdg),
    vaultUsdg: uintStr(r.vaultUsdg),
    floorPriceX18: uintStr(r.floorPriceX18),
    totals,
    recent,
    updatedAt: tsOf(r.updatedAt),
  };
  return { kind: "ok", floor };
}

/** Fixtures scenarios for /token (`?floor=`). */
export type FloorScenario = "active" | "fresh" | "disabled";
export const FLOOR_SCENARIOS: { id: FloorScenario; label: string }[] = [
  { id: "active", label: "Active (fees, donation, redemptions)" },
  { id: "fresh", label: "Fresh (all zero)" },
  { id: "disabled", label: "Disabled (no vault)" },
];
export function floorScenarioOf(v: string | string[] | undefined): FloorScenario {
  const s = Array.isArray(v) ? v[0] : v;
  return s === "fresh" || s === "disabled" ? s : "active";
}

/** Human label for a floor_flows kind (free-form tolerated). */
export function floorFlowLabel(kind: string): string {
  switch (kind) {
    case "fee_pool":
      return "Pool fee inflow";
    case "fee_curve":
      return "Curve fee inflow";
    case "donation":
      return "Donation";
    case "redeem":
      return "Redemption";
    case "stray_burn":
      return "Stray tokens burned";
    default: {
      const w = kind.replace(/[_-]+/g, " ").trim();
      return w === "" ? kind : w.charAt(0).toUpperCase() + w.slice(1);
    }
  }
}
