// SPEC-M4D §0/§2 — AWS Nitro NSM attestation-document (quote) verification, in-house (R1).
//
// Mirrors Marlin's `oyster::attestation::verify` (oyster-monorepo sdks/rs/src/attestation.rs — what
// `oyster-cvm verify` runs) and its reference TS port (sdks/ts/attestation/mod.ts), read 2026-09-29:
//   1. COSE_Sign1 = CBOR [protected: bstr, unprotected, payload: bstr, signature: bstr] (untagged).
//   2. protected header alg (key 1) MUST be ES384 (-35).
//   3. payload = CBOR map {module_id, digest, timestamp (ms), pcrs {uint: bstr48}, certificate,
//      cabundle [bstr], public_key, user_data, nonce}.
//   4. signature: ECDSA P-384 / SHA-384 (WebCrypto raw r‖s) over
//      Sig_structure ["Signature1", protected, h'', payload], with the LEAF cert's key.
//   5. chain [leaf, ...cabundle reversed]: each adjacent pair — signature against the issuer key,
//      issuer == subject linkage, validity window AT THE DOC TIMESTAMP (R4: no max-age; historical
//      quotes verify). The root's raw key must equal the pinned AWS_ROOT_KEY.
//   6. image-id = SHA256( be32(1<<0 | 1<<1 | 1<<2 | 1<<16) ‖ PCR0 ‖ PCR1 ‖ PCR2 ‖ PCR16 )
//      (attestation.rs:102-107; PCR16 all-zero when absent, as parse_pcrs does).

import { createHash, KeyObject, webcrypto, X509Certificate } from "node:crypto";
import { CborError, decodeCbor, encodeSigStructure1, type CborMap, type CborValue } from "./cbor.js";

/**
 * AWS Nitro Enclaves root public key (raw P-384 x‖y, 96 bytes) — THE trust anchor.
 * Provenance (three independent agreements, SPEC-M4D §0): (1) Marlin SDK constant AWS_ROOT_KEY in
 * both sdks/rs/src/attestation.rs and sdks/ts/attestation/mod.ts; (2) printed as the root key by
 * every live `oyster-cvm verify` run this project has done; (3) the key carried by the root cert of
 * both golden quotes' cabundles (agent 8 iCt3c0kz…, agent 10 mAPIQaMe…).
 */
export const AWS_ROOT_KEY_HEX =
  "fc0254eba608c1f36870e29ada90be46383292736e894bfff672d989444b5051e534a4b1f6dbe3c0bc581a32b7b176070ede12d69a3fea211b66e752cf7dd1dd095f6f1370f4170843d9dc100121e4cf63012809664487c9796284304dc53ff4";
export const AWS_ROOT_KEY: Uint8Array = Uint8Array.from(Buffer.from(AWS_ROOT_KEY_HEX, "hex"));

/** COSE alg ES384. */
export const COSE_ALG_ES384 = -35;

/** be32((1<<0)|(1<<1)|(1<<2)|(1<<16)) — the PCR bitflags word of the image-id. */
const IMAGE_ID_FLAGS = Uint8Array.of(0x00, 0x01, 0x00, 0x07);

/**
 * DER SubjectPublicKeyInfo prefix of an uncompressed P-384 EC key (120 bytes total):
 *   30 76                      SEQUENCE (118)
 *     30 10                    SEQUENCE (16)
 *       06 07 2a8648ce3d0201   OID id-ecPublicKey
 *       06 05 2b81040022       OID secp384r1
 *     03 62 00                 BIT STRING (98), 0 unused bits
 *       04                     uncompressed point marker
 * followed by x (48) ‖ y (48). The reference slices rawData at 24; we ASSERT the 24 bytes instead.
 */
const P384_SPKI_PREFIX = Uint8Array.from(Buffer.from("3076301006072a8648ce3d020106052b81040022036200" + "04", "hex"));

export class QuoteError extends Error {
  constructor(readonly reason: string) {
    super(`quote: ${reason}`);
    this.name = "QuoteError";
  }
}

export interface QuoteResult {
  /** lowercase hex, no 0x. */
  trueImageId: string;
  timestampMs: number;
  moduleId: string;
  rootKeyOk: true;
}

export interface VerifyQuoteOptions {
  /** Trust anchor override — tests only (the "root key swapped" case). Default AWS_ROOT_KEY. */
  rootKey?: Uint8Array;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** Raw 96-byte x‖y of a P-384 public key; throws on anything but the exact uncompressed P-384 SPKI. */
export function rawP384(key: KeyObject): Uint8Array {
  const der = new Uint8Array(key.export({ format: "der", type: "spki" }));
  if (der.length !== P384_SPKI_PREFIX.length + 96 || !eq(der.subarray(0, P384_SPKI_PREFIX.length), P384_SPKI_PREFIX)) {
    throw new QuoteError(`public key is not an uncompressed P-384 SPKI (${der.length} bytes, prefix ${hex(der.subarray(0, 24))})`);
  }
  return der.slice(P384_SPKI_PREFIX.length);
}

function cert(der: Uint8Array, what: string): X509Certificate {
  try {
    return new X509Certificate(Buffer.from(der));
  } catch (e) {
    throw new QuoteError(`${what}: not a DER X.509 certificate (${e instanceof Error ? e.message : String(e)})`);
  }
}

function certTime(s: string, what: string): number {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new QuoteError(`${what}: unparseable validity time ${JSON.stringify(s)}`);
  return t;
}

/**
 * §0 chain walk: certs = [leaf, ...cabundle reversed]; per adjacent (current, issuer): signature
 * with the issuer's key, issuer/subject linkage, and current's validity window at the doc timestamp
 * (second resolution, as attestation.rs's Asn1Time::from_unix(ts/1000)). Returns the root's raw key.
 */
export function verifyCertChain(leafDer: Uint8Array, cabundle: readonly Uint8Array[], timestampMs: number): Uint8Array {
  if (cabundle.length === 0) throw new QuoteError("cabundle is empty");
  const certs = [cert(leafDer, "leaf certificate"), ...cabundle.map((d, i) => cert(d, `cabundle[${i}]`)).reverse()];
  const atMs = Math.floor(timestampMs / 1000) * 1000;
  for (let i = 0; i < certs.length - 1; i++) {
    const current = certs[i]!;
    const issuer = certs[i + 1]!;
    if (!current.verify(issuer.publicKey)) throw new QuoteError(`chain: certificate ${i} signature does not verify against its issuer`);
    if (current.issuer !== issuer.subject || !current.checkIssued(issuer)) throw new QuoteError(`chain: certificate ${i} issuer ≠ next certificate's subject`);
    const notBefore = certTime(current.validFrom, `certificate ${i} validFrom`);
    const notAfter = certTime(current.validTo, `certificate ${i} validTo`);
    if (notAfter < atMs || notBefore > atMs) {
      throw new QuoteError(`chain: certificate ${i} not valid at doc timestamp ${new Date(atMs).toISOString()} (valid ${current.validFrom} – ${current.validTo})`);
    }
  }
  return rawP384(certs[certs.length - 1]!.publicKey);
}

const isBytes = (v: CborValue | undefined): v is Uint8Array => v instanceof Uint8Array;
const isMap = (v: CborValue | undefined): v is CborMap => v instanceof Map;

interface Payload {
  moduleId: string;
  timestampMs: number;
  pcrs: Map<number, Uint8Array>;
  certificate: Uint8Array;
  cabundle: Uint8Array[];
}

/** The reference's isAttestationPayload shape check (+ attestation.rs's required keys). */
function parsePayload(v: CborValue): Payload {
  if (!isMap(v)) throw new QuoteError("payload is not a CBOR map");
  const moduleId = v.get("module_id");
  const digest = v.get("digest");
  const timestamp = v.get("timestamp");
  const pcrs = v.get("pcrs");
  const certificate = v.get("certificate");
  const cabundle = v.get("cabundle");
  if (typeof moduleId !== "string") throw new QuoteError("payload.module_id is not a text string");
  if (typeof digest !== "string") throw new QuoteError("payload.digest is not a text string");
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new QuoteError("payload.timestamp is not an unsigned integer");
  if (!isMap(pcrs)) throw new QuoteError("payload.pcrs is not a map");
  if (!isBytes(certificate)) throw new QuoteError("payload.certificate is not a byte string");
  if (!Array.isArray(cabundle) || !cabundle.every(isBytes)) throw new QuoteError("payload.cabundle is not an array of byte strings");
  for (const k of ["public_key", "user_data", "nonce"]) {
    const x = v.get(k);
    if (!(x === null || isBytes(x))) throw new QuoteError(`payload.${k} is missing or not null/byte string`);
  }
  const pcrMap = new Map<number, Uint8Array>();
  for (const [k, x] of pcrs) {
    if (typeof k !== "number" || k < 0 || !isBytes(x)) throw new QuoteError("payload.pcrs is not a map<uint, bstr>");
    pcrMap.set(k, x);
  }
  return { moduleId, timestampMs: timestamp, pcrs: pcrMap, certificate, cabundle: cabundle as Uint8Array[] };
}

/** §0 image-id from the doc's own PCRs 0, 1, 2, 16 (PCR16 zero when absent — attestation.rs parse_pcrs). */
export function imageIdFromPcrs(pcrs: ReadonlyMap<number, Uint8Array>): string {
  const h = createHash("sha256").update(IMAGE_ID_FLAGS);
  for (const i of [0, 1, 2]) {
    const p = pcrs.get(i);
    if (p === undefined || p.length !== 48) throw new QuoteError(`PCR${i} ${p === undefined ? "missing" : `is ${p.length} bytes, not 48`}`);
    h.update(p);
  }
  const p16 = pcrs.get(16);
  if (p16 !== undefined && p16.length !== 48) throw new QuoteError(`PCR16 is ${p16.length} bytes, not 48`);
  h.update(p16 ?? new Uint8Array(48));
  return h.digest("hex");
}

/**
 * Full §0 verification. Resolves with the true image-id or throws QuoteError(reason). Every
 * failure — malformed CBOR/COSE, wrong alg, bad signature, broken chain, cert invalid at the doc
 * timestamp, unpinned root — is a QuoteError (R2: a property of the data ⇒ `fail`).
 */
export async function verifyQuote(quote: Uint8Array, opts: VerifyQuoteOptions = {}): Promise<QuoteResult> {
  const rootKey = opts.rootKey ?? AWS_ROOT_KEY;
  try {
    // 1. COSE_Sign1
    const cose = decodeCbor(quote);
    if (!Array.isArray(cose) || cose.length !== 4) throw new QuoteError("not a COSE_Sign1 4-array");
    const [protectedBytes, , payloadBytes, signature] = cose;
    if (!isBytes(protectedBytes) || !isBytes(payloadBytes) || !isBytes(signature)) throw new QuoteError("COSE_Sign1 protected/payload/signature are not byte strings");

    // 2. alg
    const prot = decodeCbor(protectedBytes);
    if (!isMap(prot)) throw new QuoteError("COSE protected header is not a map");
    const alg = prot.get(1);
    if (alg !== COSE_ALG_ES384) throw new QuoteError(`COSE alg ${JSON.stringify(alg ?? null)} ≠ ES384 (-35)`);

    // 3. payload
    const p = parsePayload(decodeCbor(payloadBytes));
    const trueImageId = imageIdFromPcrs(p.pcrs);

    // 4. COSE signature with the leaf key (the reference's exact WebCrypto calls).
    if (signature.length !== 96) throw new QuoteError(`ES384 signature is ${signature.length} bytes, not 96 (r‖s)`);
    const leafRaw = rawP384(cert(p.certificate, "leaf certificate").publicKey);
    const uncompressed = new Uint8Array(97);
    uncompressed[0] = 0x04;
    uncompressed.set(leafRaw, 1);
    const key = await webcrypto.subtle.importKey("raw", uncompressed, { name: "ECDSA", namedCurve: "P-384" }, true, ["verify"]);
    const ok = await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-384" }, key, signature, encodeSigStructure1(protectedBytes, new Uint8Array(0), payloadBytes));
    if (!ok) throw new QuoteError("COSE_Sign1 signature invalid");

    // 5. chain at the doc timestamp + root pin.
    const root = verifyCertChain(p.certificate, p.cabundle, p.timestampMs);
    if (!eq(root, rootKey)) throw new QuoteError(`root key ${hex(root)} ≠ pinned AWS Nitro root`);

    return { trueImageId, timestampMs: p.timestampMs, moduleId: p.moduleId, rootKeyOk: true };
  } catch (e) {
    if (e instanceof QuoteError) throw e;
    if (e instanceof CborError) throw new QuoteError(e.message);
    throw new QuoteError(`verification error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
