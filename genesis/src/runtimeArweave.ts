// SPEC-M4E §1a / R2 — the SECOND (and only other) bridge into the runtime package, beside canonical.ts.
// The frozen-config publication reuses the runtime's own in-house ANS-104 (type-3 Ethereum) data-item
// code and its Turbo HTTP client (upload + one-redirect gateway download) — crypto and transport are
// NEVER duplicated in genesis. Pure re-exports (the hygiene test pins this exact name list); the
// ephemeral signer and publishFrozenConfig live in arweavePublish.ts.
export { createSignedDataItem, parseDataItem, verifyDataItem } from "agent-runtime/src/attestation/ans104.js";
export { DEFAULT_ARWEAVE_GATEWAY_URL, DEFAULT_TURBO_UPLOAD_URL, TurboHttpUploader } from "agent-runtime/src/attestation/turboHttp.js";
export type { TurboHttpOptions } from "agent-runtime/src/attestation/turboHttp.js";
export { TURBO_APP_TAG } from "agent-runtime/src/attestation/turbo.js";
export type { TurboTag, TurboUploader } from "agent-runtime/src/attestation/turbo.js";
export type { TurboSigner } from "agent-runtime/src/keyring/keyring.js";
