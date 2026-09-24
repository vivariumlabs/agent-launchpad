// SPEC-M3D §3c — Farcaster hub client. THE ONLY file under src/social that touches the network
// (hygiene allowlist: "social/hubClient.ts": ["fetch("]).
//
//   submit  POST <hub.url>/v1/submitMessage, body = the serialized Message (fcMessage.encodeMessage),
//           content-type application/octet-stream. Hubs come from the FROZEN platform.farcaster.hubs
//           allowlist (D15: platform snapchain nodes; Neynar-keyed APIs are never in the pipeline) and are
//           tried IN ORDER; the first 2xx wins; all failing ⇒ throws (casts are best-effort: the draft row
//           stays in the local memory log).
//
// Transport rules (mirrors llm/httpFetch.ts / attestation/turboHttp.ts): https only (allowInsecureHttp for
// local tests), redirect: "error", 15 s timeout per request, capped response body (read and discarded).
// No clock, no randomness.

import type { FarcasterConfig } from "../config/schema.js";

export const DEFAULT_HUB_TIMEOUT_MS = 15_000;
/** Response bodies are drained up to this many bytes (then the stream is cancelled). */
export const MAX_HUB_RESPONSE_BYTES = 64 * 1024;

export type HubEntry = FarcasterConfig["hubs"][number];

export interface HubSubmitResult {
  hubId: string;
  status: number;
}

/** The hub seam used by fcSink (HubClient in production; mocked in tests). */
export interface HubSubmitter {
  submitMessage(messageBytes: Uint8Array): Promise<HubSubmitResult>;
}

export interface HubClientOptions {
  hubs: readonly HubEntry[];
  /** DEFAULT DEFAULT_HUB_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Permit http:// hub URLs (local tests only). DEFAULT false. */
  allowInsecureHttp?: boolean;
  /** Injected fetch (tests). DEFAULT globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function drain(res: Response): Promise<void> {
  const body = res.body;
  if (body === null) return;
  const reader = body.getReader();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    size += value.byteLength;
    if (size > MAX_HUB_RESPONSE_BYTES) {
      await reader.cancel();
      return;
    }
  }
}

export class HubClient implements HubSubmitter {
  private readonly hubs: readonly HubEntry[];
  private readonly timeoutMs: number;
  private readonly allowInsecure: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(o: HubClientOptions) {
    if (o.hubs.length === 0) throw new Error("hubClient: no hubs configured");
    this.hubs = o.hubs.map((h) => ({ ...h }));
    this.timeoutMs = o.timeoutMs ?? DEFAULT_HUB_TIMEOUT_MS;
    this.allowInsecure = o.allowInsecureHttp ?? false;
    this.fetchImpl = o.fetchImpl ?? globalThis.fetch;
    for (const h of this.hubs) this.submitUrl(h);
  }

  private submitUrl(h: HubEntry): URL {
    const u = new URL(`${h.url.replace(/\/+$/, "")}/v1/submitMessage`);
    if (u.protocol !== "https:" && !(this.allowInsecure && u.protocol === "http:")) {
      throw new Error(`hubClient: refusing non-https hub URL for ${h.id} (${u.protocol})`);
    }
    return u;
  }

  async submitMessage(messageBytes: Uint8Array): Promise<HubSubmitResult> {
    if (!(messageBytes instanceof Uint8Array) || messageBytes.length === 0) throw new Error("hubClient: empty message");
    const failures: string[] = [];
    for (const h of this.hubs) {
      try {
        const res = await this.fetchImpl(this.submitUrl(h), {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          // Uint8Array is a valid fetch body at runtime; the cast only bridges TS's ArrayBufferLike vs BodyInit typing.
          body: messageBytes as RequestInit["body"],
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        await drain(res);
        if (res.status >= 200 && res.status < 300) return { hubId: h.id, status: res.status };
        failures.push(`${h.id}: HTTP ${res.status}`);
      } catch (e) {
        failures.push(`${h.id}: ${errMsg(e)}`);
      }
    }
    throw new Error(`hubClient: every hub failed (${failures.join("; ")})`);
  }
}
