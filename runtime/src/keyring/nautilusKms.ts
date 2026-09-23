// SPEC-M3 §2 — real Nautilus (Marlin Oyster) KMS client.
//
//   GET http://127.0.0.1:1100/derive/secp256k1?path=<path>  →  32-byte key, either as hex text
//   (M0 drill) or as the raw 32 bytes. Unambiguous: a body of exactly 32 bytes is raw; anything
//   else must normalize to 64 hex chars (normalizeKeyHex). 33 raw bytes etc. ⇒ reject.
//
// In-enclave, LOCALHOST ONLY: the constructor (and localhostGet) refuse any URL whose
// host is not 127.0.0.1 / localhost, or that is not plain http, or that carries
// credentials. The connection is always made to 127.0.0.1 (a "localhost" name is never
// resolved), there are no redirects (node:http does not follow them), bounded body size,
// and a request timeout.
//
// agentId is bound by Oyster at the KMS layer (attested init-param user data,
// M0 RESULTS), so this client does NOT append the agentId to derive paths.
// The boot-time first-touch retry (M0 gotcha: the derive server comes up after the
// containers start) is the existing withRetry inside createKeyring — unchanged.
//
// Hygiene allowlist: node:http is permitted in this file (localhost only).

import { request, type IncomingMessage } from "node:http";
import type { Hex } from "viem";
import type { KmsClient } from "./kms.js";

export const DEFAULT_KMS_URL = "http://127.0.0.1:1100";
/** DEFAULT per-request timeout for in-enclave localhost calls. */
export const DEFAULT_LOCAL_TIMEOUT_MS = 10_000;

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

export class NonLocalUrlError extends Error {
  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(`refusing non-localhost URL ${url}: ${reason} (in-enclave services are 127.0.0.1/localhost over http only)`);
    this.name = "NonLocalUrlError";
  }
}

/** Parses `url` and throws NonLocalUrlError unless it is http://127.0.0.1|localhost[:port]/… with no credentials. */
export function assertLocalhostUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new NonLocalUrlError(url, "unparseable");
  }
  if (u.protocol !== "http:") throw new NonLocalUrlError(url, `protocol ${u.protocol}`);
  if (u.username !== "" || u.password !== "") throw new NonLocalUrlError(url, "credentials in URL");
  if (!LOCAL_HOSTS.has(u.hostname.toLowerCase())) throw new NonLocalUrlError(url, `host ${u.hostname}`);
  return u;
}

export interface LocalGetResult {
  status: number;
  body: Buffer;
}

export interface LocalGetOptions {
  timeoutMs?: number;
  /** Max accepted response body size in bytes (larger ⇒ reject). */
  maxBytes: number;
}

/**
 * GET over node:http against a localhost-only URL (asserted here as well). Always
 * connects to 127.0.0.1 (IPv4) regardless of the URL's host spelling.
 */
export function localhostGet(url: string, opts: LocalGetOptions): Promise<LocalGetResult> {
  const u = assertLocalhostUrl(url);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS;
  return new Promise<LocalGetResult>((resolvePromise, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        family: 4,
        port: u.port === "" ? 80 : Number(u.port),
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: { host: u.host },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            req.destroy(new Error(`localhostGet ${u.pathname}: response exceeds ${opts.maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`localhostGet ${u.pathname}: timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

/** Normalizes a derive response: strip all whitespace and a leading 0x/0X; require exactly 32 bytes of hex. */
export function normalizeKeyHex(text: string): Hex {
  let s = text.replace(/\s+/g, "");
  if (s.startsWith("0x") || s.startsWith("0X")) s = s.slice(2);
  if (!KEY_HEX_RE.test(s)) {
    throw new Error(`nautilus-kms: derive response is not 32 bytes of hex (got ${s.length} chars after normalization)`);
  }
  return `0x${s.toLowerCase()}`;
}

/** Derive response body ⇒ key: exactly 32 bytes ⇒ raw key bytes; otherwise hex text (normalizeKeyHex). */
export function normalizeKeyBody(body: Uint8Array): Hex {
  if (body.length === 32) return `0x${Buffer.from(body).toString("hex")}`;
  return normalizeKeyHex(Buffer.from(body).toString("utf8"));
}

export interface NautilusKmsOptions {
  timeoutMs?: number;
}

export class NautilusKms implements KmsClient {
  private readonly base: URL;
  private readonly timeoutMs: number | undefined;

  /** `baseUrl` = cfg.runtime.kmsUrl (DEFAULT http://127.0.0.1:1100). Throws on a non-localhost URL. */
  constructor(baseUrl: string = DEFAULT_KMS_URL, opts?: NautilusKmsOptions) {
    this.base = assertLocalhostUrl(baseUrl);
    this.timeoutMs = opts?.timeoutMs;
  }

  async derive(path: string): Promise<Hex> {
    const u = new URL("/derive/secp256k1", this.base);
    u.searchParams.set("path", path);
    const res = await localhostGet(u.toString(), {
      maxBytes: 4096,
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
    if (res.status !== 200) {
      throw new Error(`nautilus-kms: derive(${path}) HTTP ${res.status}`);
    }
    return normalizeKeyBody(res.body);
  }
}
