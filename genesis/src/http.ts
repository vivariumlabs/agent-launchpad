// The ONLY network (fetch) file in genesis/src (hygiene allowlist). Used by oyster.ts for the Oyster
// indexer GraphQL + provider control-plane IP lookup (M0 RESULTS) and by the Arweave config source.
// Responses are untrusted input: callers validate everything they read.

export interface HttpResponse {
  status: number;
  text: string;
}

export interface HttpClient {
  get(url: string, timeoutMs: number): Promise<HttpResponse>;
  postJson(url: string, body: unknown, timeoutMs: number): Promise<HttpResponse>;
}

const MAX_BODY = 1024 * 1024;

async function doFetch(url: string, init: RequestInit, timeoutMs: number): Promise<HttpResponse> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, redirect: "error", signal: ctl.signal });
    const text = await res.text();
    return { status: res.status, text: text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text };
  } finally {
    clearTimeout(timer);
  }
}

export const fetchHttp: HttpClient = {
  get: (url, timeoutMs) => doFetch(url, { method: "GET" }, timeoutMs),
  postJson: (url, body, timeoutMs) =>
    doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, timeoutMs),
};
