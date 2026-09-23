// SPEC-M3B §4 — network fetch of the platform-signed allowlist document. THE ONLY file besides
// llm/httpFetch.ts that may call fetch (hygiene allowlist: "llm/allowlistFetch.ts": ["fetch("]).
//
// The transport is UNTRUSTED by design (src/llm/allowlistUpdate.ts verifies the signature against the
// frozen signer before anything is used); these limits only bound resource use:
//   - GET, no redirects (redirect: "error"), hard timeout, https only (allowInsecureHttp: tests only)
//   - body capped (maxBodyBytes, 256 KiB DEFAULT); non-200 ⇒ reject

import type { AllowlistSource } from "./allowlistUpdate.js";
import { readCapped } from "./httpFetch.js";

export const ALLOWLIST_MAX_BODY_BYTES = 256 * 1024;
export const ALLOWLIST_FETCH_TIMEOUT_MS = 30_000;

export interface FetchAllowlistSourceOptions {
  allowInsecureHttp?: boolean;
  maxBodyBytes?: number;
  timeoutMs?: number;
}

export class FetchAllowlistSource implements AllowlistSource {
  private readonly url: URL;
  private readonly maxBodyBytes: number;
  private readonly timeoutMs: number;

  constructor(url: string, opts: FetchAllowlistSourceOptions = {}) {
    const u = new URL(url);
    if (u.protocol !== "https:" && !(opts.allowInsecureHttp === true && u.protocol === "http:")) {
      throw new Error(`allowlist fetch: refusing non-https URL (${u.protocol})`);
    }
    this.url = u;
    this.maxBodyBytes = opts.maxBodyBytes ?? ALLOWLIST_MAX_BODY_BYTES;
    this.timeoutMs = opts.timeoutMs ?? ALLOWLIST_FETCH_TIMEOUT_MS;
  }

  async load(): Promise<string> {
    const res = await fetch(this.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    const body = await readCapped(res, this.maxBodyBytes);
    if (res.status !== 200) throw new Error(`allowlist fetch: HTTP ${res.status}`);
    return body;
  }
}
