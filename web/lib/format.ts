/**
 * Formatting helpers for API values (SPEC-M4A §2): amounts arrive as
 * bigint-ish decimal strings; format here rather than at the call site.
 * All parsing goes through BigInt to avoid float precision loss.
 */

/**
 * Fixed-point integer string (e.g. USDG 6-decimal, wei 18-decimal) ->
 * display string with thousands separators, rounded to `displayDecimals`.
 */
export function formatFixedPoint(
  raw: string | null | undefined,
  decimals: number,
  displayDecimals: number,
): string {
  const parsed = parseFixed(raw);
  if (parsed === null) return (0).toFixed(displayDecimals);
  const { negative, value } = parsed;

  const base = 10n ** BigInt(decimals);
  const intPart = value / base;
  const fracPart = value % base;
  const fracStr = fracPart.toString().padStart(decimals, "0");

  let intStr = intPart.toString();
  let displayFrac = fracStr.slice(0, displayDecimals).padEnd(displayDecimals, "0");

  const roundDigit = fracStr.charAt(displayDecimals);
  if (roundDigit !== "" && Number(roundDigit) >= 5) {
    const digits = displayFrac.split("").map(Number);
    let carry = 1;
    for (let i = digits.length - 1; i >= 0 && carry; i--) {
      const d = (digits[i] ?? 0) + carry;
      digits[i] = d % 10;
      carry = d >= 10 ? 1 : 0;
    }
    displayFrac = digits.join("");
    if (carry) intStr = (BigInt(intStr) + 1n).toString();
  }

  const withCommas = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const result = displayDecimals > 0 ? `${withCommas}.${displayFrac}` : withCommas;
  return negative && value !== 0n ? `-${result}` : result;
}

/** USDG amounts (6-decimal integer strings) formatted to 2dp, e.g. "1,234.56". */
export function formatUsdg(raw: string | null | undefined): string {
  return formatFixedPoint(raw, 6, 2);
}

/** ETH/wei amounts (18-decimal integer strings) formatted to 4 significant figures. */
export function formatEth(raw: string | null | undefined): string {
  const parsed = parseFixed(raw);
  if (parsed === null || parsed.value === 0n) return "0";
  const asFixed = formatFixedPoint(raw, 18, 18).replace(/,/g, "");
  const num = Number(asFixed);
  if (!Number.isFinite(num) || num === 0) return "0";
  return trimTrailingZeros(num.toPrecision(4));
}

function trimTrailingZeros(numStr: string): string {
  if (!numStr.includes(".")) return numStr;
  return numStr.replace(/0+$/, "").replace(/\.$/, "");
}

/** Compact currency, e.g. "$12.3k", "$1.2M". `decimals` is the raw string's fixed-point scale. */
export function formatCompactUsd(
  raw: string | null | undefined,
  decimals = 6,
): string {
  const parsed = parseFixed(raw);
  if (parsed === null) return "$0";
  const base = 10 ** decimals;
  const num = (parsed.negative ? -1 : 1) * (Number(parsed.value) / base);
  const compact = new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(num);
  return `$${compact}`;
}

/**
 * Applies `fmt` to `raw` unless it is null, in which case renders an em-dash.
 * Use for genuinely-absent values (a pending agent's null market/instance/
 * balances fields) — never let a formatter coerce "unknown" into "0".
 */
export function formatOrDash<T>(raw: T | null, fmt: (value: T) => string): string {
  return raw === null ? "—" : fmt(raw);
}

/** "0x1234…abcd" */
export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 2) return address;
  return `${address.slice(0, chars + 2)}…${address.slice(-chars)}`;
}

/** Relative time, e.g. "3h ago", "just now". Input is unix seconds. */
export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diffSec = Math.max(0, Math.floor(now / 1000) - ts);
  if (diffSec < 30) return "just now";
  const units: [number, string][] = [
    [31536000, "y"],
    [2592000, "mo"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  for (const [secs, label] of units) {
    if (diffSec >= secs) {
      const n = Math.floor(diffSec / secs);
      return `${n}${label} ago`;
    }
  }
  return `${diffSec}s ago`;
}

/** Absolute ISO-ish timestamp for title attributes / tooltips. Input is unix seconds. */
export function formatAbsoluteTime(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function parseFixed(
  raw: string | null | undefined,
): { negative: boolean; value: bigint } | null {
  if (raw === null || raw === undefined || raw === "") return { negative: false, value: 0n };
  let s = raw.trim();
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^\d+$/.test(s)) return null;
  try {
    return { negative, value: BigInt(s) };
  } catch {
    return null;
  }
}
