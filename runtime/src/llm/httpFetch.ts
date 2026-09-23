// SPEC-M3 §3 — node fetch implementation of HttpClient. THE ONLY file under src/llm that
// touches the network (hygiene allowlist: "llm/httpFetch.ts": ["fetch("]).
//
//   - no redirects (redirect: "error" ⇒ a 3xx rejects)
//   - hard timeout per request (AbortSignal.timeout)
//   - https only unless constructed with allowInsecureHttp (local testing)
//   - response body capped (maxBodyBytes, 1 MiB DEFAULT); over cap ⇒ reject

import type { HttpClient, HttpRequest, HttpResponse } from "./types.js";

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface FetchHttpClientOptions {
  /** Permit plain http:// URLs (tests / local dev only). DEFAULT false. */
  allowInsecureHttp?: boolean;
  maxBodyBytes?: number;
}

/** Reads a response body, rejecting once it exceeds `cap` bytes (also used by llm/allowlistFetch.ts). */
export async function readCapped(res: Response, cap: number): Promise<string> {
  const body = res.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new Error(`http: response body exceeds ${cap} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class FetchHttpClient implements HttpClient {
  private readonly allowInsecure: boolean;
  private readonly maxBodyBytes: number;

  constructor(opts: FetchHttpClientOptions = {}) {
    this.allowInsecure = opts.allowInsecureHttp ?? false;
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const u = new URL(req.url);
    if (u.protocol !== "https:" && !(this.allowInsecure && u.protocol === "http:")) {
      throw new Error(`http: refusing non-https URL (${u.protocol})`);
    }
    const res = await fetch(u, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "error",
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const body = await readCapped(res, this.maxBodyBytes);
    return { status: res.status, headers, body };
  }
}
