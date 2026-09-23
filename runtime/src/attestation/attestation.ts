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
import type { Address, Hex } from "viem";
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

/** Minimal funded-signer shape for Turbo (ArDrive) uploads; wired in SPEC-M3 s2. */
export interface TurboFundedSigner {
  readonly address: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export class NotFundedError extends Error {
  constructor(readonly signerAddress: string) {
    super(
      `NotFunded: TurboArweaveSink cannot upload — Turbo (Arweave) upload is not wired yet (SPEC-M3 s2); ` +
        `signer ${signerAddress} has no usable Turbo credit balance in this build. Use LocalDirSink until s2.`,
    );
    this.name = "NotFundedError";
  }
}

/** SKELETON: real Turbo upload lands in s2. Always throws NotFundedError. */
export class TurboArweaveSink implements AttestationSink {
  constructor(private readonly signer: TurboFundedSigner) {}

  async upload(_report: string, _now: bigint): Promise<string> {
    throw new NotFundedError(this.signer.address);
  }
}
