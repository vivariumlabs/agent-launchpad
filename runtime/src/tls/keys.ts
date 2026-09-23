// SPEC-M3B §2 — deterministic key material from KMS-derived 32-byte seeds.
//   acmeAccountKeyPem: ECDSA P-256 (ES256 — the ACME JWS default) from keyring.acmeAccountKey();
//     same agentId + image ⇒ same ACME account across revivals (docs/TLS-INGRESS.md §3).
//   placeholderKey: Ed25519 from keyring.tlsPlaceholderKey(); signs the self-signed placeholder
//     deterministically (RFC 8032) ⇒ restarts never churn the placeholder cert or its SPKI pin.
// The issued-certificate key is NOT derived: it is generated per issuance (acme.ts) and never leaves
// the enclave's /data/tls (regenerated after revival).

import { createECDH, createPrivateKey, type KeyObject } from "node:crypto";
import { hexToBytes, type Hex } from "viem";

/** secp256r1 group order n. */
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function b64url(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

function seedBytes(seed: Hex, what: string): Uint8Array {
  const b = hexToBytes(seed);
  if (b.length !== 32) throw new Error(`tls keys: ${what} seed must be 32 bytes, got ${b.length}`);
  return b;
}

/** P-256 private key from a 32-byte seed: d = (seed mod (n−1)) + 1 ∈ [1, n−1]. PKCS#8 PEM. */
export function p256KeyFromSeed(seed: Hex): KeyObject {
  const raw = seedBytes(seed, "P-256");
  const d = (BigInt(`0x${Buffer.from(raw).toString("hex")}`) % (P256_N - 1n)) + 1n;
  const dBytes = Buffer.from(d.toString(16).padStart(64, "0"), "hex");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(dBytes);
  const pub = ecdh.getPublicKey(); // 0x04 ‖ x ‖ y
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: b64url(dBytes), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
    format: "jwk",
  });
}

export function acmeAccountKeyPem(seed: Hex): string {
  return p256KeyFromSeed(seed).export({ type: "pkcs8", format: "pem" }).toString();
}

/** RFC 8410 PKCS#8 prefix for an Ed25519 private key (the 32-byte seed follows). */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function ed25519KeyFromSeed(seed: Hex): KeyObject {
  const raw = seedBytes(seed, "Ed25519");
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(raw)]), format: "der", type: "pkcs8" });
}
