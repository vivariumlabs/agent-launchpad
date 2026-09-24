// M3 s2 close — HTTP TurboUploader (replaces turboSdk.ts; the 211 MB @ardrive/turbo-sdk is NOT a
// dependency). THE ONLY file under src/attestation that touches the network (hygiene allowlist:
// "attestation/turboHttp.ts": ["fetch("]). SPEC-M3B §3 economics unchanged: uploads spend the
// treasury's Turbo credits seeded at genesis.
//
//   upload    POST <uploadUrl> (DEFAULT https://upload.ardrive.io/v1/tx), body = ONE signed ANS-104
//             data item (./ans104.ts, signed by keyring.turboSigner(): treasury key, 48-byte-only
//             allowlist), content-type application/octet-stream. Response {id} = the Arweave txid;
//             it MUST equal our locally computed id (base64url(sha256(signature))) — a mismatch is an error.
//             No signed request headers: the data-item signature IS the upload authentication.
//   balance   GET <paymentUrl>/account/balance/ethereum?address=<treasury> (DEFAULT
//             https://payment.ardrive.io/v1) → {winc}; 404 ⇒ 0 (no account yet) WITHOUT parsing the
//             body (SPEC-M3D §1a: the live 404 body is plain-text "User Not Found"). Feeds the
//             low-credit WARNING (turbo.ts checkCredits) and the daemon step-12 watermark check.
//   info      GET <paymentUrl>/info → {addresses: {"base-eth": 0x…, …}} (SPEC-M3D §2: the step-12
//             top-up verifies the dynamic payment address against the FROZEN arweaveFundingAddress).
//   fund      POST <paymentUrl>/account/balance/<token> body {tx_id} (SPEC-M3D §2): 200 credited,
//             202 accepted (awaiting confirmations); anything else ⇒ error (the caller retries).
//   cost      GET <paymentUrl>/price/bytes/<n> → {winc}.
//   query     POST <gatewayUrl>/graphql (DEFAULT https://arweave.net) — own items by tags; owners
//             filter = the Arweave-normalized owner address (base64url(sha256(owner pubkey))), and
//             every returned node's owner.key is re-checked against our public key.
//   download  GET <gatewayUrl>/<id> (id format-checked; size-capped). The gateway is UNTRUSTED: snapshot
//             envelopes are AEAD-encrypted under the memory key (restore authenticates them).
//             SPEC-M3D §1b: follows AT MOST ONE redirect, and only to an https Location whose host
//             ends with ".arweave.net" (the gateway 302s to a per-item sandbox subdomain — live-proven).
//
// Transport rules (mirrors llm/httpFetch.ts): https only (unless allowInsecureHttp for local tests),
// redirect: "error" (the ONE exception: download's first hop, above), hard timeout per request, capped
// response bodies. No clock, no randomness.

import type { Address, Hex } from "viem";
import type { TurboSigner } from "../keyring/keyring.js";
import { arweaveOwnerAddress, base64url, createSignedDataItem } from "./ans104.js";
import type { TurboPayment, TurboTag, TurboUploader } from "./turbo.js";

export const DEFAULT_TURBO_UPLOAD_URL = "https://upload.ardrive.io/v1/tx";
export const DEFAULT_TURBO_PAYMENT_URL = "https://payment.ardrive.io/v1";
export const DEFAULT_ARWEAVE_GATEWAY_URL = "https://arweave.net";
export const DEFAULT_TURBO_TIMEOUT_MS = 30_000;
/** JSON responses (upload receipt, balance, price, GraphQL page). */
export const MAX_JSON_BYTES = 1024 * 1024;
/** DEFAULT cap on a downloaded data item (snapshots). */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
/** GraphQL pagination bound (100 ids / page). */
export const MAX_QUERY_PAGES = 20;

const ID_RE = /^[A-Za-z0-9_-]{43}$/;
/** SPEC-M3D §1b: the only redirect targets download may follow (host suffix, https only). */
export const ARWEAVE_REDIRECT_HOST_SUFFIX = ".arweave.net";
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DIGITS_RE = /^\d+$/;

export interface TurboHttpOptions {
  uploadUrl?: string;
  paymentUrl?: string;
  gatewayUrl?: string;
  timeoutMs?: number;
  maxDownloadBytes?: number;
  /** Permit http:// (local tests only). DEFAULT false. */
  allowInsecureHttp?: boolean;
  /** Injected fetch (tests). DEFAULT globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

async function readCappedBytes(res: Response, cap: number): Promise<Uint8Array> {
  const body = res.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new Error(`turbo: response body exceeds ${cap} bytes`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function wincOf(body: unknown, what: string): bigint {
  const w = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["winc"] : undefined;
  if (typeof w === "string" && DIGITS_RE.test(w)) return BigInt(w);
  if (typeof w === "number" && Number.isSafeInteger(w) && w >= 0) return BigInt(w);
  throw new Error(`turbo: ${what}: missing/invalid winc`);
}

export class TurboHttpUploader implements TurboUploader, TurboPayment {
  private readonly uploadUrl: string;
  private readonly paymentUrl: string;
  private readonly gatewayUrl: string;
  private readonly timeoutMs: number;
  private readonly maxDownloadBytes: number;
  private readonly allowInsecure: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly ownerKeyB64: string;

  constructor(
    private readonly signer: TurboSigner,
    o: TurboHttpOptions = {},
  ) {
    this.uploadUrl = o.uploadUrl ?? DEFAULT_TURBO_UPLOAD_URL;
    this.paymentUrl = (o.paymentUrl ?? DEFAULT_TURBO_PAYMENT_URL).replace(/\/+$/, "");
    this.gatewayUrl = (o.gatewayUrl ?? DEFAULT_ARWEAVE_GATEWAY_URL).replace(/\/+$/, "");
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TURBO_TIMEOUT_MS;
    this.maxDownloadBytes = o.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    this.allowInsecure = o.allowInsecureHttp ?? false;
    this.fetchImpl = o.fetchImpl ?? globalThis.fetch;
    this.ownerKeyB64 = base64url(signer.publicKey);
    for (const u of [this.uploadUrl, this.paymentUrl, this.gatewayUrl]) this.checkUrl(new URL(u));
  }

  private checkUrl(u: URL): void {
    if (u.protocol !== "https:" && !(this.allowInsecure && u.protocol === "http:")) throw new Error(`turbo: refusing non-https URL (${u.protocol})`);
  }

  /**
   * One HTTP exchange. redirect "error" everywhere except download's first hop ("manual", SPEC-M3D
   * §1b): a manual 3xx returns its Location and an EMPTY body (never read).
   */
  private async request(
    url: string,
    init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: Uint8Array | string },
    cap: number,
    redirect: "error" | "manual" = "error",
  ): Promise<{ status: number; body: Uint8Array; location: string | null }> {
    const u = new URL(url);
    this.checkUrl(u);
    const res = await this.fetchImpl(u, {
      method: init.method,
      ...(init.headers !== undefined ? { headers: init.headers } : {}),
      // Uint8Array is a valid fetch body at runtime; the cast only bridges TS's ArrayBufferLike vs BodyInit typing.
      ...(init.body !== undefined ? { body: init.body as RequestInit["body"] } : {}),
      redirect,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (redirect === "manual" && REDIRECT_STATUSES.includes(res.status)) {
      await res.body?.cancel();
      return { status: res.status, body: new Uint8Array(0), location: res.headers.get("location") };
    }
    return { status: res.status, body: await readCappedBytes(res, cap), location: null };
  }

  private async json(url: string, init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: Uint8Array | string }, okStatuses: readonly number[], what: string): Promise<{ status: number; body: unknown }> {
    const r = await this.request(url, init, MAX_JSON_BYTES);
    return this.parseJson(r, okStatuses, what);
  }

  private parseJson(r: { status: number; body: Uint8Array }, okStatuses: readonly number[], what: string): { status: number; body: unknown } {
    if (!okStatuses.includes(r.status)) throw new Error(`turbo: ${what}: HTTP ${r.status}`);
    const text = new TextDecoder().decode(r.body);
    if (text.length === 0) return { status: r.status, body: null };
    try {
      return { status: r.status, body: JSON.parse(text) as unknown };
    } catch {
      throw new Error(`turbo: ${what}: non-JSON response`);
    }
  }

  async upload(data: Uint8Array, tags: readonly TurboTag[]): Promise<{ id: string }> {
    const item = await createSignedDataItem(data, tags, this.signer);
    const r = await this.json(this.uploadUrl, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: item.bytes }, [200, 202], "upload");
    const id = r.body !== null && typeof r.body === "object" ? (r.body as Record<string, unknown>)["id"] : undefined;
    if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("turbo: upload: response carries no valid id");
    if (id !== item.id) throw new Error(`turbo: upload: service id ${id} != locally computed data-item id ${item.id}`);
    return { id };
  }

  async balanceWinc(): Promise<bigint> {
    const url = `${this.paymentUrl}/account/balance/ethereum?address=${encodeURIComponent(this.signer.address)}`;
    const raw = await this.request(url, { method: "GET" }, MAX_JSON_BYTES);
    // SPEC-M3D §1a: 404 ⇒ 0 WITHOUT parsing the body (live: plain-text "User Not Found").
    if (raw.status === 404) return 0n;
    return wincOf(this.parseJson(raw, [200], "balance").body, "balance");
  }

  /**
   * SPEC-M3D §2: the payment service's CURRENT receiving address for `token` (GET /info →
   * addresses[token]). UNTRUSTED — the step-12 caller pays only when it equals the frozen
   * arweaveFundingAddress. null ⇒ the service lists no (valid) address for the token.
   */
  async paymentAddress(token: string): Promise<Address | null> {
    const r = await this.json(`${this.paymentUrl}/info`, { method: "GET" }, [200], "info");
    const addrs = r.body !== null && typeof r.body === "object" ? (r.body as Record<string, unknown>)["addresses"] : undefined;
    const a = addrs !== null && typeof addrs === "object" ? (addrs as Record<string, unknown>)[token] : undefined;
    return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as Address) : null;
  }

  /**
   * SPEC-M3D §2: POST <paymentUrl>/account/balance/<token> {tx_id} — asks the service to credit a
   * payment tx the treasury sent. 200 = credited, 202 = accepted (awaiting confirmations); any other
   * status ⇒ throws (the step-12 caller retries). One attempt; no retry here.
   */
  async submitFundTx(token: string, txId: Hex): Promise<{ status: number; body: unknown }> {
    if (!/^[a-z0-9-]{1,32}$/.test(token)) throw new Error(`turbo: bad token ${token}`);
    if (!TX_HASH_RE.test(txId)) throw new Error("turbo: fund: bad tx id");
    return this.json(
      `${this.paymentUrl}/account/balance/${token}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx_id: txId }) },
      [200, 202],
      "fund",
    );
  }

  async costWinc(bytes: number): Promise<bigint> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`turbo: bad byte count ${bytes}`);
    const r = await this.json(`${this.paymentUrl}/price/bytes/${bytes}`, { method: "GET" }, [200], "price");
    return wincOf(r.body, "price");
  }

  async query(owner: Address, tags: readonly TurboTag[]): Promise<string[]> {
    if (owner.toLowerCase() !== this.signer.address.toLowerCase()) throw new Error("turbo: query supports the signer's own items only");
    const q =
      "query($owners:[String!],$tags:[TagFilter!],$after:String){transactions(owners:$owners,tags:$tags,first:100,after:$after,sort:HEIGHT_DESC)" +
      "{pageInfo{hasNextPage} edges{cursor node{id owner{key}}}}}";
    const ids: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_QUERY_PAGES; page++) {
      const variables = { owners: [arweaveOwnerAddress(this.signer.publicKey)], tags: tags.map((t) => ({ name: t.name, values: [t.value] })), after };
      const r = await this.json(`${this.gatewayUrl}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables }) }, [200], "graphql");
      const tx = (r.body as { data?: { transactions?: { pageInfo?: { hasNextPage?: unknown }; edges?: unknown } } } | null)?.data?.transactions;
      if (tx === undefined || !Array.isArray(tx.edges)) throw new Error("turbo: graphql: malformed response");
      let cursor: string | null = null;
      for (const e of tx.edges as Array<{ cursor?: unknown; node?: { id?: unknown; owner?: { key?: unknown } } }>) {
        const id = e.node?.id;
        if (typeof e.cursor === "string") cursor = e.cursor;
        if (typeof id !== "string" || !ID_RE.test(id)) continue;
        if (e.node?.owner?.key !== this.ownerKeyB64) continue; // belt: the gateway's owners filter is untrusted
        if (!ids.includes(id)) ids.push(id);
      }
      if (tx.pageInfo?.hasNextPage !== true || cursor === null) break;
      after = cursor;
    }
    return ids;
  }

  async download(id: string): Promise<Uint8Array> {
    if (!ID_RE.test(id)) throw new Error("turbo: bad data-item id");
    let r = await this.request(`${this.gatewayUrl}/${id}`, { method: "GET" }, this.maxDownloadBytes, "manual");
    if (REDIRECT_STATUSES.includes(r.status)) {
      // SPEC-M3D §1b: at most ONE hop, https only, host *.arweave.net only; the hop itself is redirect: "error".
      const loc = r.location;
      if (loc === null) throw new Error(`turbo: download ${id}: HTTP ${r.status} without Location`);
      let target: URL;
      try {
        target = new URL(loc, `${this.gatewayUrl}/${id}`);
      } catch {
        throw new Error(`turbo: download ${id}: unparseable redirect Location`);
      }
      if (target.protocol !== "https:") throw new Error(`turbo: download ${id}: refusing non-https redirect (${target.protocol})`);
      if (!target.hostname.toLowerCase().endsWith(ARWEAVE_REDIRECT_HOST_SUFFIX)) {
        throw new Error(`turbo: download ${id}: refusing redirect to host ${target.hostname} (only *${ARWEAVE_REDIRECT_HOST_SUFFIX})`);
      }
      r = await this.request(target.toString(), { method: "GET" }, this.maxDownloadBytes);
      if (REDIRECT_STATUSES.includes(r.status)) throw new Error(`turbo: download ${id}: refusing a second redirect (HTTP ${r.status})`);
    }
    if (r.status !== 200) throw new Error(`turbo: download ${id}: HTTP ${r.status}`);
    return r.body;
  }
}

export function createHttpTurboUploader(signer: TurboSigner, opts: TurboHttpOptions = {}): TurboUploader {
  return new TurboHttpUploader(signer, opts);
}
