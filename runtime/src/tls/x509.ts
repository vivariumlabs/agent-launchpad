// SPEC-M3B §2 — minimal X.509 v3 builder for the deterministic self-signed placeholder cert
// (and test CAs). Ed25519 signatures only: RFC 8032 signing is deterministic, so identical
// inputs ⇒ byte-identical certificates (restarts never churn the placeholder, no randomness).
// Also: SPKI sha256 (the /attestation pin) and a Date-free validTo parser for renewal math.
//
// No Date / Date.now anywhere: times are unix-second bigints; calendar math is Howard Hinnant's
// days_from_civil / civil_from_days in bigint.

import { createHash, createPublicKey, sign, X509Certificate, type KeyObject } from "node:crypto";
import type { Hex } from "viem";

// ---------------------------------------------------------------------------
// DER primitives
// ---------------------------------------------------------------------------

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const bitString = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"));
const explicit = (n: number, inner: Buffer): Buffer => tlv(0xa0 | n, inner);

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map((p) => BigInt(p));
  const first = parts[0]!;
  const second = parts[1]!;
  const out: number[] = [Number(first * 40n + second)];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [];
    let v = p;
    chunk.unshift(Number(v & 0x7fn));
    v >>= 7n;
    while (v > 0n) {
      chunk.unshift(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** Positive DER INTEGER from big-endian magnitude bytes. */
function derUint(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0) b = b.subarray(1);
  if ((b[0]! & 0x80) !== 0) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

// ---------------------------------------------------------------------------
// calendar (unix seconds ⇄ civil UTC), bigint only
// ---------------------------------------------------------------------------

const SEC_PER_DAY = 86_400n;

/** Days since 1970-01-01 for a proleptic-Gregorian civil date (Hinnant days_from_civil). */
export function daysFromCivil(y: bigint, m: bigint, d: bigint): bigint {
  const yy = m <= 2n ? y - 1n : y;
  const era = (yy >= 0n ? yy : yy - 399n) / 400n;
  const yoe = yy - era * 400n;
  const mp = m > 2n ? m - 3n : m + 9n;
  const doy = (153n * mp + 2n) / 5n + d - 1n;
  const doe = yoe * 365n + yoe / 4n - yoe / 100n + doy;
  return era * 146_097n + doe - 719_468n;
}

/** Civil UTC date-time for unix seconds (≥ 0). */
export function civilFromUnix(t: bigint): { y: bigint; m: bigint; d: bigint; hh: bigint; mm: bigint; ss: bigint } {
  if (t < 0n) throw new Error("x509: negative time");
  const days = t / SEC_PER_DAY;
  const rem = t % SEC_PER_DAY;
  const z = days + 719_468n;
  const era = z / 146_097n;
  const doe = z - era * 146_097n;
  const yoe = (doe - doe / 1460n + doe / 36_524n - doe / 146_096n) / 365n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const d = doy - (153n * mp + 2n) / 5n + 1n;
  const m = mp < 10n ? mp + 3n : mp - 9n;
  const y = yoe + era * 400n + (m <= 2n ? 1n : 0n);
  return { y, m, d, hh: rem / 3600n, mm: (rem % 3600n) / 60n, ss: rem % 60n };
}

const pad = (v: bigint, n: number): string => v.toString(10).padStart(n, "0");

/** RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050. */
function derTime(t: bigint): Buffer {
  const c = civilFromUnix(t);
  const tail = `${pad(c.m, 2)}${pad(c.d, 2)}${pad(c.hh, 2)}${pad(c.mm, 2)}${pad(c.ss, 2)}Z`;
  if (c.y >= 1950n && c.y <= 2049n) return tlv(0x17, Buffer.from(`${pad(c.y % 100n, 2)}${tail}`, "ascii"));
  return tlv(0x18, Buffer.from(`${pad(c.y, 4)}${tail}`, "ascii"));
}

const MONTHS: Record<string, bigint> = { Jan: 1n, Feb: 2n, Mar: 3n, Apr: 4n, May: 5n, Jun: 6n, Jul: 7n, Aug: 8n, Sep: 9n, Oct: 10n, Nov: 11n, Dec: 12n };

/** Parses node:crypto X509Certificate.validTo/validFrom ("Sep  3 12:00:00 2026 GMT") to unix seconds. */
export function parseOpenSslTime(s: string): bigint {
  const m = /^([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4}) GMT$/.exec(s.trim());
  const mon = m === null ? undefined : MONTHS[m[1]!];
  if (m === null || mon === undefined) throw new Error(`x509: unparseable time ${JSON.stringify(s)}`);
  const days = daysFromCivil(BigInt(m[6]!), mon, BigInt(m[2]!));
  return days * SEC_PER_DAY + BigInt(m[3]!) * 3600n + BigInt(m[4]!) * 60n + BigInt(m[5]!);
}

// ---------------------------------------------------------------------------
// certificate
// ---------------------------------------------------------------------------

const OID_ED25519 = "1.3.101.112";
const OID_CN = "2.5.4.3";
const OID_SAN = "2.5.29.17";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";

export interface BuildCertInput {
  /** Subject public key as DER SubjectPublicKeyInfo (any algorithm). */
  subjectSpkiDer: Buffer;
  /** Ed25519 private key of the issuer (= subject key for self-signed). */
  issuerKey: KeyObject;
  issuerCommonName: string;
  subjectCommonName: string;
  /** subjectAltName dNSNames. */
  dnsNames: readonly string[];
  /** Positive serial (big-endian bytes). */
  serial: Buffer;
  notBefore: bigint;
  notAfter: bigint;
  /** basicConstraints cA=TRUE (test CAs). */
  isCa?: boolean;
}

function name(cn: string): Buffer {
  return seq(set(seq(oid(OID_CN), utf8(cn))));
}

/** DER X.509 v3 certificate signed with Ed25519. Deterministic for identical inputs. */
export function buildCertificateDer(input: BuildCertInput): Buffer {
  if (input.issuerKey.asymmetricKeyType !== "ed25519") throw new Error("x509: issuer key must be Ed25519");
  if (input.notAfter <= input.notBefore) throw new Error("x509: notAfter must be > notBefore");
  const sigAlg = seq(oid(OID_ED25519));
  const exts: Buffer[] = [];
  if (input.dnsNames.length > 0) {
    const gn = Buffer.concat(input.dnsNames.map((n) => tlv(0x82, Buffer.from(n, "ascii"))));
    exts.push(seq(oid(OID_SAN), octets(seq(gn))));
  }
  if (input.isCa === true) {
    exts.push(seq(oid(OID_BASIC_CONSTRAINTS), tlv(0x01, Buffer.from([0xff])), octets(seq(tlv(0x01, Buffer.from([0xff]))))));
  }
  const tbs = seq(
    explicit(0, derUint(Buffer.from([2]))),
    derUint(input.serial),
    sigAlg,
    name(input.issuerCommonName),
    seq(derTime(input.notBefore), derTime(input.notAfter)),
    name(input.subjectCommonName),
    input.subjectSpkiDer,
    ...(exts.length > 0 ? [explicit(3, seq(...exts))] : []),
  );
  const signature = sign(null, tbs, input.issuerKey);
  return seq(tbs, sigAlg, bitString(signature));
}

export function derToPem(der: Buffer, label = "CERTIFICATE"): string {
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** sha256 over the DER SubjectPublicKeyInfo of the (leaf) certificate in `certPem`. */
export function certSpkiSha256(certPem: string): Hex {
  const x = new X509Certificate(certPem);
  const spki = x.publicKey.export({ type: "spki", format: "der" });
  return `0x${createHash("sha256").update(spki).digest("hex")}`;
}

/** sha256 over the DER SubjectPublicKeyInfo of a private or public key. */
export function keySpkiSha256(key: KeyObject): Hex {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  return `0x${createHash("sha256").update(pub.export({ type: "spki", format: "der" })).digest("hex")}`;
}

/** Leaf notAfter (unix seconds). */
export function certNotAfter(certPem: string): bigint {
  return parseOpenSslTime(new X509Certificate(certPem).validTo);
}
