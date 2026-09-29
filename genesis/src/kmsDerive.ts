// SPEC-M4B §2 / R4 — the PUBLIC Nautilus KMS derive endpoint (image-based KMS), key-free. Mirrors
// `oyster-cvm kms-derive --image-id <id> --path <p> --key-type secp256k1/address/ethereum` (5.0.1),
// the M0-proven way to predict an agent's KMS-derived EOAs (runtime/spikes/m0-marlin-kms/RESULTS.md
// "Public determinism"; BUILD-STATE: agent-2 treasury == kms-derive prediction). Request shape and
// response authentication taken from the 5.0.1 CLI and verified live 2026-09-29 against agent 8
// (image f489dc60…: treasury 0xd7EF592E…, action 0x3c169d57…):
//
//   GET <kmsEndpoint>/derive/secp256k1/address/ethereum?image_id=<64-hex>&path=<path>
//     DEFAULT kmsEndpoint http://image-v4.kms.box:1101 (the CLI's image-KMS default)
//   200 text/plain body: the checksum-less 0x address (42 bytes)
//   header x-marlin-kms-signature: 65-byte secp256k1 signature (r‖s‖v, hex, no 0x) over
//     sha256(<path+query as requested> ‖ <body bytes>), signed by the KMS root server key; the CLI
//     recovers the signer and compares it to --kms-verification-key (DEFAULT below, uncompressed
//     public key without the 04 prefix). We do the same: the endpoint is plain http, so an
//     unauthenticated answer could substitute the treasury a creator pins on-chain.
//
// Network through the injected HttpClient (http.ts, the one fetch seam). Throws on ANY anomaly —
// the caller never returns a partial prediction.

import { concat, getAddress, recoverPublicKey, sha256, stringToBytes, type Address, type Hex } from "viem";
import type { HttpClient } from "./http.js";

export const KMS_ENDPOINT_DEFAULT = "http://image-v4.kms.box:1101";
/** oyster-cvm 5.0.1 kms-derive --kms-verification-key DEFAULT (image-based KMS root server). */
export const KMS_VERIFICATION_KEY_DEFAULT =
  "14eadecaec620fac17b084dcd423b0a75ed2c248b0f73be1bb9b408476567ffc221f420612dd995555650dc19dbe972e7277cb6bfe5ce26650ec907be759b276";
export const KMS_KEY_TYPE = "secp256k1/address/ethereum";
export const KMS_SIGNATURE_HEADER = "x-marlin-kms-signature";

const IMAGE_ID_RE = /^[0-9a-f]{64}$/;
const PATH_RE = /^[a-z0-9_-]{1,32}$/;
const SIG_RE = /^(?:0x)?[0-9a-fA-F]{130}$/;
const PUBKEY_RE = /^[0-9a-fA-F]{128}$/;

export interface KmsDeriver {
  /** The KMS-derived Ethereum address for (image-id, derivation path). Throws on any failure. */
  deriveAddress(imageId: string, path: string): Promise<Address>;
}

/** The exact path+query the KMS root server signs (and that we request). */
export function kmsDerivePathAndQuery(imageId: string, path: string): string {
  if (!IMAGE_ID_RE.test(imageId)) throw new Error(`kms-derive: bad image id ${JSON.stringify(imageId)}`);
  if (!PATH_RE.test(path)) throw new Error(`kms-derive: bad derivation path ${JSON.stringify(path)}`);
  return `/derive/${KMS_KEY_TYPE}?image_id=${imageId}&path=${path}`;
}

/** Recovers the signer of a KMS response and checks it against the verification key. Pure (async only for viem). */
export async function verifyKmsSignature(pathAndQuery: string, body: string, signatureHex: string, verificationKey: string): Promise<boolean> {
  if (!SIG_RE.test(signatureHex) || !PUBKEY_RE.test(verificationKey)) return false;
  const sig = (signatureHex.startsWith("0x") ? signatureHex : `0x${signatureHex}`) as Hex;
  const hash = sha256(concat([stringToBytes(pathAndQuery), stringToBytes(body)]));
  try {
    const pub = await recoverPublicKey({ hash, signature: sig });
    return pub.toLowerCase() === `0x04${verificationKey.toLowerCase()}`;
  } catch {
    return false;
  }
}

export class PublicKmsDeriver implements KmsDeriver {
  private readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly verificationKey: string,
    private readonly http: HttpClient,
    private readonly timeoutMs: number,
  ) {
    const u = new URL(endpoint);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`kms-derive: unsupported endpoint protocol ${u.protocol}`);
    if (u.pathname !== "/" && u.pathname !== "") throw new Error("kms-derive: kmsEndpoint must be an origin (no path) — the signed URI is the request path");
    if (!PUBKEY_RE.test(verificationKey)) throw new Error("kms-derive: kmsVerificationKey must be 128 hex chars (uncompressed secp256k1 public key without 04)");
    this.endpoint = `${u.protocol}//${u.host}`;
  }

  async deriveAddress(imageId: string, path: string): Promise<Address> {
    const pq = kmsDerivePathAndQuery(imageId, path);
    const res = await this.http.get(`${this.endpoint}${pq}`, this.timeoutMs);
    if (res.status !== 200) throw new Error(`kms-derive ${path}: HTTP ${res.status}`);
    const sig = res.headers?.[KMS_SIGNATURE_HEADER];
    if (sig === undefined) throw new Error(`kms-derive ${path}: response has no ${KMS_SIGNATURE_HEADER} header`);
    if (!(await verifyKmsSignature(pq, res.text, sig, this.verificationKey))) throw new Error(`kms-derive ${path}: signature does not verify against the KMS root key — refusing the answer`);
    const addr = res.text.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`kms-derive ${path}: body is not an address`);
    return getAddress(addr);
  }
}
