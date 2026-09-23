// SPEC-M3 §2 — attestation fetch, verification report (04 §5), and report sinks.
//
// fetchAttestation: GET the raw TEE quote from the Oyster attestation server
// (DEFAULT http://127.0.0.1:1300/attestation/raw; Nitro ⇒ CBOR/COSE_Sign1 document).
// The quote is NOT parsed or verified in-enclave — verification is the outside world's
// job (website 05 §5, `oyster-cvm verify`, third parties per REPRODUCIBLE-BUILD.md).
//
// buildReport: canonical JSON (canonicalEncode from policy/approval.ts ⇒ recursively
// key-sorted, bigints as decimal strings, 0x-hex lowercased) carrying the image id
// (= the codeHash passed to AgentRegistry.registerInstance), image digest, config hash,
// both EOAs, generation, timestamp, and the raw quote as base64.
//
// No Date.now anywhere — `now` is always a caller-supplied bigint.
// Hygiene allowlist: localhost-only HTTP here goes through keyring/nautilusKms.ts's
// localhostGet (node:http permitted in this file too, for the same localhost-only use).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { recoverMessageAddress, stringToBytes, type Address, type Hex } from "viem";
import { attestationDigest, type AttestationSigner } from "../keyring/keyring.js";
import { localhostGet, type LocalGetOptions } from "../keyring/nautilusKms.js";
import { canonicalEncode } from "../policy/approval.js";
import type { OwnAddresses } from "../policy/types.js";

export const DEFAULT_ATTESTATION_URL = "http://127.0.0.1:1300/attestation/raw";
/** Upper bound on an accepted raw quote (Nitro attestation docs are a few KiB). */
export const MAX_QUOTE_BYTES = 1_048_576;

export const REPORT_KIND = "agent-launchpad.attestation-report";
export const REPORT_VERSION = 1;

export interface FetchAttestationOptions {
  timeoutMs?: number;
}

/** Raw quote bytes from the in-enclave attestation server. Throws on non-200 / empty / non-localhost URL. */
export async function fetchAttestation(url: string = DEFAULT_ATTESTATION_URL, opts?: FetchAttestationOptions): Promise<Uint8Array> {
  const getOpts: LocalGetOptions = { maxBytes: MAX_QUOTE_BYTES, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) };
  const res = await localhostGet(url, getOpts);
  if (res.status !== 200) throw new Error(`attestation: GET ${new URL(url).pathname} HTTP ${res.status}`);
  if (res.body.length === 0) throw new Error("attestation: empty quote");
  return new Uint8Array(res.body);
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

export interface BuildReportInput {
  quote: Uint8Array;
  /** Enclave image id (Oyster measurement over compose + init params); = registry codeHash. */
  imageId: Hex;
  /** Container image digest (e.g. "sha256:…"); null/absent ⇒ reported as null. */
  imageDigest?: string | null;
  /** keccak256 of the canonical config JSON (boot's configHash). */
  configHash: Hex;
  ownAddresses: OwnAddresses;
  /** Registry generation, when known; null ⇒ assigned by registerInstance (unknown pre-registration). */
  generation: number | null;
  /** Unix seconds. */
  now: bigint;
}

export interface AttestationReport {
  kind: typeof REPORT_KIND;
  version: typeof REPORT_VERSION;
  imageId: Hex;
  imageDigest: string | null;
  configHash: Hex;
  eoas: { treasury: Address; action: Address };
  generation: number | null;
  timestamp: bigint;
  quoteEncoding: "base64";
  quote: string;
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_STRING_RE = /^0x[0-9a-fA-F]*$/;

/** Canonical JSON verification report (04 §5). Deterministic for identical inputs. */
export function buildReport(input: BuildReportInput): string {
  if (!BYTES32_RE.test(input.imageId)) throw new Error("attestation: imageId must be 32-byte hex");
  if (!BYTES32_RE.test(input.configHash)) throw new Error("attestation: configHash must be 32-byte hex");
  if (input.quote.length === 0) throw new Error("attestation: empty quote");
  const quote = Buffer.from(input.quote).toString("base64");
  // canonicalEncode lowercases 0x-hex-looking strings; a base64 quote of that shape would be corrupted.
  if (HEX_STRING_RE.test(quote)) throw new Error("attestation: base64 quote collides with the canonical hex rule");
  const report: AttestationReport = {
    kind: REPORT_KIND,
    version: REPORT_VERSION,
    imageId: input.imageId,
    imageDigest: input.imageDigest ?? null,
    configHash: input.configHash,
    eoas: { treasury: input.ownAddresses.treasury, action: input.ownAddresses.action },
    generation: input.generation,
    timestamp: input.now,
    quoteEncoding: "base64",
    quote,
  };
  return canonicalEncode(report);
}

// ---------------------------------------------------------------------------
// sinks
// ---------------------------------------------------------------------------

/** Where the report is published. `upload` returns the ref passed to registerInstance (txid / filename). */
export interface AttestationSink {
  upload(report: string, now: bigint): Promise<string>;
}

/** Local-directory sink (mirrors memory/snapshot.ts LocalDirSink); filename derived from `now`. */
export class LocalDirSink implements AttestationSink {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async upload(report: string, now: bigint): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const filename = `attestation-${now.toString(10)}.json`;
    await writeFile(join(this.dir, filename), report, "utf8");
    return filename;
  }
}

// SPEC-M3B §3: the Turbo/Arweave sink (AttestationSink + SnapshotSink) lives in ./turbo.ts.

// ---------------------------------------------------------------------------
// signed GET /attestation responses (closes the MITM gap found by Job L)
// ---------------------------------------------------------------------------
//
// Response body: { payload, signer, signature } where
//   payload   = canonical form (JSON.parse(canonicalEncode(·))) of
//               { report, attestationRef, certSpkiSha256, certKind, domain, timestamp }
//               (timestamp = unix seconds as a decimal string);
//   signer    = the agent's TREASURY EOA;
//   signature = EIP-191 personal_sign over the 32-byte digest
//               keccak256(utf8("launchpad-attestation-v1") ‖ utf8(canonicalEncode(payload)))
//               by the treasury key (keyring.attestationSigner()).
//
// VERIFIER STORY (third parties, the website, the genesis orchestrator):
//   1. Fetch https://a<agentId>.<agentDnsRoot>/attestation and note the SPKI sha256 of the TLS
//      certificate the connection ACTUALLY presented.
//   2. Recompute canonicalEncode(payload) (recursively key-sorted JSON; bigints as decimal strings;
//      0x-hex lowercased — the payload arrives already canonical, so re-encoding is the identity),
//      then recover the EIP-191 signer of attestationDigest(bytes) from `signature`.
//   3. Require recovered == AgentRegistry.instanceOf(agentId).treasuryEOA (read on-chain — NOT the
//      `signer` field, which is only a hint). The treasury key exists only inside the attested enclave
//      (KMS-derived, bound to (codeHash, agentId, frozenConfigHash)), so a MITM proxy — which can
//      terminate TLS with its own cert and rewrite the JSON — cannot produce this signature.
//   4. Require payload.certSpkiSha256 == the SPKI observed in step 1 (a MITM serving its own cert
//      would have to change certSpkiSha256 and thereby break the signature), and payload.timestamp
//      fresh (bounds replay of an older genuine response across a cert rotation).
//   5. Verify payload.report's quote against the image id (oyster-cvm verify / 04 §5) as before.
// verifyAttestationResponse below implements 2–4 given the on-chain treasury.

export interface AttestationResponsePayloadInput {
  report: string | null;
  attestationRef: string | null;
  certSpkiSha256: Hex | null;
  certKind: "issued" | "placeholder" | null;
  domain: string | null;
  /** Unix seconds (response time). */
  timestamp: bigint;
}

export interface SignedAttestationResponse {
  /** Canonical form of the input (timestamp as a decimal string). */
  payload: Record<string, unknown>;
  signer: Address;
  signature: Hex;
}

/** utf8(canonicalEncode(payload)) — the exact bytes the attestation signature commits to. */
export function attestationPayloadBytes(payload: unknown): Uint8Array {
  return stringToBytes(canonicalEncode(payload));
}

export async function signAttestationResponse(signer: AttestationSigner, input: AttestationResponsePayloadInput): Promise<SignedAttestationResponse> {
  const encoded = canonicalEncode(input);
  const payload = JSON.parse(encoded) as Record<string, unknown>;
  const signature = await signer.sign(stringToBytes(encoded));
  return { payload, signer: signer.address, signature };
}

export interface VerifyAttestationOptions {
  /** registry.instanceOf(agentId).treasuryEOA — read ON-CHAIN by the verifier. */
  expectedTreasury: Address;
  /** SPKI sha256 of the TLS cert the verifier's connection actually saw (checked when given). */
  observedSpkiSha256?: Hex;
  /** Verifier's clock, unix seconds (freshness checked when given). */
  now?: bigint;
  /** DEFAULT 300 s. */
  maxAgeSec?: bigint;
}

export type VerifyAttestationResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: "shape" | "bad_signature" | "wrong_signer" | "spki_mismatch" | "stale" };

const SIG_RE = /^0x[0-9a-fA-F]{130}$/;

/** Steps 2–4 of the verifier story. Never throws. */
export async function verifyAttestationResponse(body: unknown, o: VerifyAttestationOptions): Promise<VerifyAttestationResult> {
  if (body === null || typeof body !== "object") return { ok: false, reason: "shape" };
  const b = body as Record<string, unknown>;
  const payload = b["payload"];
  const signature = b["signature"];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "shape" };
  if (typeof signature !== "string" || !SIG_RE.test(signature)) return { ok: false, reason: "shape" };
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({ message: { raw: attestationDigest(attestationPayloadBytes(payload)) }, signature: signature as Hex });
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (recovered.toLowerCase() !== o.expectedTreasury.toLowerCase()) return { ok: false, reason: "wrong_signer" };
  const p = payload as Record<string, unknown>;
  if (o.observedSpkiSha256 !== undefined) {
    const spki = p["certSpkiSha256"];
    if (typeof spki !== "string" || spki.toLowerCase() !== o.observedSpkiSha256.toLowerCase()) return { ok: false, reason: "spki_mismatch" };
  }
  if (o.now !== undefined) {
    const ts = p["timestamp"];
    if (typeof ts !== "string" || !/^\d+$/.test(ts)) return { ok: false, reason: "shape" };
    const t = BigInt(ts);
    const maxAge = o.maxAgeSec ?? 300n;
    if (t > o.now + maxAge || o.now - t > maxAge) return { ok: false, reason: "stale" };
  }
  return { ok: true, payload: p };
}
