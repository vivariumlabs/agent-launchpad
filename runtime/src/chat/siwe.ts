// SPEC-M2C §1 — EIP-4361 (Sign-In with Ethereum) message parsing + verification.
// Parsing is implemented here directly (no new deps); signature recovery uses viem's
// verifyMessage (EOA / ecrecover only — no network). Time is always an explicit `now`.
//
// Accepted grammar (EIP-4361 ABNF, strict line layout):
//   [scheme "://"] domain " wants you to sign in with your Ethereum account:"
//   address
//   ""
//   [statement  ""]            ← statement line then blank; absent ⇒ one extra blank line
//   ""  (only when no statement)
//   "URI: " uri
//   "Version: 1"
//   "Chain ID: " decimal
//   "Nonce: " [a-zA-Z0-9]{8,}
//   "Issued At: " RFC 3339
//   ["Expiration Time: " RFC 3339]
//   ["Not Before: " RFC 3339]
//   ["Request ID: " text]
//   ["Resources:" ("- " uri)*]
// Anything else (unknown / duplicate / out-of-order fields, trailing lines) ⇒ malformed.
//
// Checks (verifySiwe), each a distinct 401 reason:
//   SIWE_MALFORMED   parse failure
//   SIWE_DOMAIN      domain ≠ cfg.chatDomain (exact, case-insensitive host)
//   SIWE_CHAIN       chainId ≠ cfg.chainIds.rh
//   SIWE_WINDOW      now ≥ expirationTime | now < notBefore | issuedAt > now + skew |
//                    issuedAt older than the nonce lifetime | expirationTime ≤ issuedAt
//   SIWE_NONCE       nonce unknown / expired / already used
//   SIWE_SIGNATURE   signature does not recover to the declared address
// The nonce is consumed only once every other check has passed (atomic check-and-delete
// after the async signature verification, so concurrent replays yield at most one session).

import { isAddress, verifyMessage, type Address, type Hex } from "viem";
import type { UnixSeconds } from "../policy/types.js";
import type { NonceStore } from "./nonce.js";

export interface SiweMessage {
  scheme?: string;
  domain: string;
  address: Address;
  statement?: string;
  uri: string;
  version: "1";
  chainId: number;
  nonce: string;
  issuedAt: UnixSeconds;
  expirationTime?: UnixSeconds;
  notBefore?: UnixSeconds;
  requestId?: string;
  resources?: string[];
}

export type SiweFailure = "SIWE_MALFORMED" | "SIWE_DOMAIN" | "SIWE_CHAIN" | "SIWE_WINDOW" | "SIWE_NONCE" | "SIWE_SIGNATURE";

export type ParseResult = { ok: true; message: SiweMessage } | { ok: false; detail: string };

export type SiweVerifyResult = { ok: true; message: SiweMessage } | { ok: false; reason: SiweFailure; detail: string };

/** Max accepted SIWE message length (chars). */
export const SIWE_MAX_CHARS = 4096;
/** Tolerated forward clock skew on issuedAt (seconds). */
export const SIWE_ISSUED_AT_SKEW_SEC = 60n;

const HEADER_SUFFIX = " wants you to sign in with your Ethereum account:";
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+\-.]*$/;
const DOMAIN_RE = /^[a-zA-Z0-9.\-]+(:[0-9]{1,5})?$/;
const NONCE_RE = /^[a-zA-Z0-9]{8,}$/;
const CHAIN_ID_RE = /^[1-9][0-9]{0,15}$/;
const URI_RE = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\S+$/;
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------
// RFC 3339 → unix seconds (pure bigint calendar math; no Date)
// ---------------------------------------------------------------------------

/** Days since 1970-01-01 for a proleptic Gregorian civil date (H. Hinnant's algorithm). */
function daysFromCivil(y: bigint, m: bigint, d: bigint): bigint {
  const yy = m <= 2n ? y - 1n : y;
  const era = (yy >= 0n ? yy : yy - 399n) / 400n;
  const yoe = yy - era * 400n;
  const mp = m > 2n ? m - 3n : m + 9n;
  const doy = (153n * mp + 2n) / 5n + d - 1n;
  const doe = yoe * 365n + yoe / 4n - yoe / 100n + doy;
  return era * 146_097n + doe - 719_468n;
}

function daysInMonth(y: bigint, m: bigint): bigint {
  const leap = (y % 4n === 0n && y % 100n !== 0n) || y % 400n === 0n;
  const table = [31n, leap ? 29n : 28n, 31n, 30n, 31n, 30n, 31n, 31n, 30n, 31n, 30n, 31n];
  return table[Number(m) - 1] ?? 0n;
}

/**
 * Parses an RFC 3339 timestamp to unix seconds. Fractional seconds: `round` = "floor"
 * truncates, "ceil" rounds any non-zero fraction up (used for notBefore so the window is
 * never widened). Returns null if malformed or out of range.
 */
export function parseRfc3339(s: string, round: "floor" | "ceil" = "floor"): UnixSeconds | null {
  const m = RFC3339_RE.exec(s);
  if (m === null) return null;
  const [, ys, mos, ds, hs, mis, ss, frac, tz] = m;
  if (ys === undefined || mos === undefined || ds === undefined || hs === undefined || mis === undefined || ss === undefined || tz === undefined) {
    return null;
  }
  const y = BigInt(ys);
  const mo = BigInt(mos);
  const d = BigInt(ds);
  const h = BigInt(hs);
  const mi = BigInt(mis);
  const sec = BigInt(ss);
  if (mo < 1n || mo > 12n) return null;
  if (d < 1n || d > daysInMonth(y, mo)) return null;
  if (h > 23n || mi > 59n || sec > 59n) return null;
  let t = daysFromCivil(y, mo, d) * 86_400n + h * 3_600n + mi * 60n + sec;
  if (tz !== "Z" && tz !== "z") {
    const sign = tz.startsWith("-") ? -1n : 1n;
    const oh = BigInt(tz.slice(1, 3));
    const om = BigInt(tz.slice(4, 6));
    if (oh > 23n || om > 59n) return null;
    t -= sign * (oh * 3_600n + om * 60n);
  }
  if (round === "ceil" && frac !== undefined && /[1-9]/.test(frac)) t += 1n;
  return t;
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

function fail(detail: string): ParseResult {
  return { ok: false, detail };
}

function field(line: string | undefined, name: string): string | null {
  const prefix = `${name}: `;
  if (line === undefined || !line.startsWith(prefix)) return null;
  return line.slice(prefix.length);
}

export function parseSiweMessage(text: string): ParseResult {
  if (typeof text !== "string") return fail("message must be a string");
  if (text.length === 0 || text.length > SIWE_MAX_CHARS) return fail(`message length must be 1..${SIWE_MAX_CHARS}`);
  if (text.includes("\r")) return fail("CR not allowed (LF line endings only)");
  const lines = text.split("\n");
  let i = 0;

  // header
  const header = lines[i++] ?? "";
  if (!header.endsWith(HEADER_SUFFIX)) return fail("bad header line");
  let origin = header.slice(0, header.length - HEADER_SUFFIX.length);
  let scheme: string | undefined;
  const sep = origin.indexOf("://");
  if (sep >= 0) {
    scheme = origin.slice(0, sep);
    origin = origin.slice(sep + 3);
    if (!SCHEME_RE.test(scheme)) return fail("bad scheme");
  }
  if (!DOMAIN_RE.test(origin)) return fail("bad domain");
  const domain = origin;

  // address
  const address = lines[i++] ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !isAddress(address)) return fail("bad address (EIP-55 checksum)");

  // blank, [statement, blank] | blank
  if (lines[i++] !== "") return fail("expected blank line after address");
  let statement: string | undefined;
  const maybeStatement = lines[i++];
  if (maybeStatement === undefined) return fail("truncated message");
  if (maybeStatement !== "") {
    statement = maybeStatement;
    if (lines[i++] !== "") return fail("expected blank line after statement");
  }

  const uri = field(lines[i++], "URI");
  if (uri === null || !URI_RE.test(uri)) return fail("bad URI field");
  const version = field(lines[i++], "Version");
  if (version !== "1") return fail("bad Version field (must be 1)");
  const chainIdStr = field(lines[i++], "Chain ID");
  if (chainIdStr === null || !CHAIN_ID_RE.test(chainIdStr)) return fail("bad Chain ID field");
  const chainId = Number(chainIdStr);
  if (!Number.isSafeInteger(chainId)) return fail("bad Chain ID field");
  const nonce = field(lines[i++], "Nonce");
  if (nonce === null || !NONCE_RE.test(nonce)) return fail("bad Nonce field");
  const issuedAtStr = field(lines[i++], "Issued At");
  const issuedAt = issuedAtStr === null ? null : parseRfc3339(issuedAtStr, "floor");
  if (issuedAt === null) return fail("bad Issued At field");

  const msg: SiweMessage = { domain, address: address as Address, uri, version: "1", chainId, nonce, issuedAt };
  if (scheme !== undefined) msg.scheme = scheme;
  if (statement !== undefined) msg.statement = statement;

  const exp = field(lines[i], "Expiration Time");
  if (exp !== null) {
    const t = parseRfc3339(exp, "floor");
    if (t === null) return fail("bad Expiration Time field");
    msg.expirationTime = t;
    i++;
  }
  const nbf = field(lines[i], "Not Before");
  if (nbf !== null) {
    const t = parseRfc3339(nbf, "ceil");
    if (t === null) return fail("bad Not Before field");
    msg.notBefore = t;
    i++;
  }
  const rid = field(lines[i], "Request ID");
  if (rid !== null) {
    msg.requestId = rid;
    i++;
  }
  if (lines[i] === "Resources:") {
    i++;
    const resources: string[] = [];
    while (i < lines.length && (lines[i] ?? "").startsWith("- ")) {
      const r = (lines[i] ?? "").slice(2);
      if (!URI_RE.test(r)) return fail("bad resource URI");
      resources.push(r);
      i++;
    }
    msg.resources = resources;
  }
  if (i !== lines.length) return fail(`unexpected content at line ${i + 1}`);
  return { ok: true, message: msg };
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export interface SiweVerifyOptions {
  domain: string;
  chainId: number;
  nonces: NonceStore;
  /** Nonce lifetime: an issuedAt older than this is stale. */
  nonceTtlSec: bigint;
  now: UnixSeconds;
}

function deny(reason: SiweFailure, detail: string): SiweVerifyResult {
  return { ok: false, reason, detail };
}

export async function verifySiwe(text: string, signature: Hex, opts: SiweVerifyOptions): Promise<SiweVerifyResult> {
  const parsed = parseSiweMessage(text);
  if (!parsed.ok) return deny("SIWE_MALFORMED", parsed.detail);
  const m = parsed.message;
  const now = opts.now;

  if (m.domain.toLowerCase() !== opts.domain.toLowerCase()) return deny("SIWE_DOMAIN", `domain "${m.domain}" is not "${opts.domain}"`);
  if (m.chainId !== opts.chainId) return deny("SIWE_CHAIN", `chainId ${m.chainId} is not ${opts.chainId}`);

  if (m.expirationTime !== undefined && m.expirationTime <= m.issuedAt) return deny("SIWE_WINDOW", "expirationTime ≤ issuedAt");
  if (m.expirationTime !== undefined && now >= m.expirationTime) return deny("SIWE_WINDOW", "message expired");
  if (m.notBefore !== undefined && now < m.notBefore) return deny("SIWE_WINDOW", "message not yet valid (notBefore)");
  if (m.issuedAt > now + SIWE_ISSUED_AT_SKEW_SEC) return deny("SIWE_WINDOW", "issuedAt is in the future");
  if (now - m.issuedAt > opts.nonceTtlSec) return deny("SIWE_WINDOW", "issuedAt is older than the nonce lifetime");

  if (!opts.nonces.peek(m.nonce, now)) return deny("SIWE_NONCE", "nonce unknown, expired or already used");

  let valid = false;
  try {
    valid = await verifyMessage({ address: m.address, message: text, signature });
  } catch {
    valid = false;
  }
  if (!valid) return deny("SIWE_SIGNATURE", "signature does not match the declared address");

  // Atomic single-use consumption AFTER the await: concurrent replays of one signed message
  // race here and at most one wins.
  if (!opts.nonces.consume(m.nonce, now)) return deny("SIWE_NONCE", "nonce unknown, expired or already used");
  return { ok: true, message: m };
}
