/**
 * SPEC-M4C §2 — chat tab client: endpoint resolution (R3) + the browser → enclave
 * transport (R2: NO Next API route ever touches /nonce, /session or /chat; every
 * call below is a direct browser fetch to the agent's own chat server).
 *
 * Wire contract (runtime/src/chat/server.ts header):
 *   GET  /health   → 200 { ok: true, tier } | 503 { ok: false, detail }
 *   GET  /nonce    → 200 { nonce, expiresAt }
 *   POST /session  { message, signature } → 200 { token, exp, wallet } | 400 { error, detail } | 401 { error, reason, detail }
 *   POST /chat     header x-chat-token, { text }
 *                  → 200 { reply, refused?, denyCode? }
 *                  | 400 { error: "bad_request", detail }
 *                  | 401 { error: "unauthorized", reason: TOKEN_* }
 *                  | 403 { error: "not_a_holder", reply }
 *                  | 429 { error: "rate_limited", window, retryAfterSec, reply }  (+ retry-after header)
 *                  | 503 { error: "gate_unavailable", reply, detail } | 503 { error: <other>, reply, detail? }
 *
 * Every parsed value is type-checked; nothing null/NaN reaches the UI.
 */
import { AGENT_DNS_ROOT } from "./config";

export const TOKEN_HEADER = "x-chat-token";

// ---------------------------------------------------------------------------
// endpoint resolution (R3)
// ---------------------------------------------------------------------------

/** Runtime SIWE DOMAIN_RE — the endpoint host must satisfy it or /session can never succeed. */
const SIWE_DOMAIN_RE = /^[a-zA-Z0-9.\-]+(:[0-9]{1,5})?$/;

export function defaultEndpoint(agentId: number): string {
  return `https://a${agentId}.${AGENT_DNS_ROOT}`;
}

export type EndpointCheck =
  | { ok: true; origin: string; host: string; secure: boolean }
  | { ok: false; error: string };

/** Validates an endpoint override: must be an http(s) ORIGIN (scheme://host[:port], no path/query). */
export function parseEndpoint(raw: string): EndpointCheck {
  const s = raw.trim().replace(/\/+$/, "");
  if (s === "") return { ok: false, error: "Enter an endpoint, e.g. https://a9.vivarium.systems" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "Not a URL — expected scheme://host[:port]" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "Only http:// or https:// endpoints" };
  if (u.username !== "" || u.password !== "") return { ok: false, error: "No credentials in the endpoint URL" };
  if ((u.pathname !== "" && u.pathname !== "/") || u.search !== "" || u.hash !== "") {
    return { ok: false, error: "Origin only (scheme://host[:port]) — the chat routes live at the root" };
  }
  if (!SIWE_DOMAIN_RE.test(u.host)) {
    return { ok: false, error: `Host "${u.host}" cannot be a SIWE domain (letters, digits, dots, dashes, optional :port)` };
  }
  return { ok: true, origin: u.origin, host: u.host, secure: u.protocol === "https:" };
}

// ---------------------------------------------------------------------------
// transport results
// ---------------------------------------------------------------------------

export type HealthResult =
  | { kind: "ok"; tier: string }
  | { kind: "unhealthy"; status: number; detail: string }
  | { kind: "unreachable"; detail: string };

export type NonceResult = { kind: "ok"; nonce: string } | { kind: "error"; detail: string };

export type SessionResult =
  | { kind: "ok"; token: string; exp: number }
  | { kind: "unauthorized"; reason: string; detail: string }
  | { kind: "error"; detail: string };

export type ChatResult =
  | { kind: "reply"; reply: string; refused: boolean }
  | { kind: "bad_request"; detail: string }
  | { kind: "unauthorized"; reason: string }
  | { kind: "insufficient"; reply: string }
  | { kind: "rate_limited"; window: "hour" | "day" | null; retryAfterSec: number | null; reply: string }
  | { kind: "gate_unavailable"; reply: string }
  | { kind: "unavailable"; error: string; reply: string }
  | { kind: "error"; detail: string };

export interface ChatTransport {
  health(): Promise<HealthResult>;
  nonce(): Promise<NonceResult>;
  session(message: string, signature: string): Promise<SessionResult>;
  chat(token: string, text: string): Promise<ChatResult>;
}

// ---------------------------------------------------------------------------
// response parsing (shared by the live transport and the fixture mock)
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;

function str(b: Body | null, k: string): string | null {
  const v = b?.[k];
  return typeof v === "string" ? v : null;
}

function finiteNum(b: Body | null, k: string): number | null {
  const v = b?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const NONCE_RE = /^[a-zA-Z0-9]{8,}$/;

export function parseHealth(status: number, b: Body | null): HealthResult {
  const tier = str(b, "tier");
  if (status === 200 && b?.ok === true && tier !== null) return { kind: "ok", tier };
  return { kind: "unhealthy", status, detail: str(b, "detail") ?? str(b, "error") ?? `HTTP ${status}` };
}

export function parseNonce(status: number, b: Body | null): NonceResult {
  const nonce = str(b, "nonce");
  if (status === 200 && nonce !== null && NONCE_RE.test(nonce)) return { kind: "ok", nonce };
  return { kind: "error", detail: str(b, "detail") ?? str(b, "error") ?? `HTTP ${status}` };
}

export function parseSession(status: number, b: Body | null): SessionResult {
  const token = str(b, "token");
  const exp = finiteNum(b, "exp");
  if (status === 200 && token !== null && token !== "" && exp !== null && exp > 0) return { kind: "ok", token, exp };
  if (status === 401) return { kind: "unauthorized", reason: str(b, "reason") ?? "UNAUTHORIZED", detail: str(b, "detail") ?? "" };
  return { kind: "error", detail: str(b, "detail") ?? str(b, "error") ?? `HTTP ${status}` };
}

/** retryAfterSec from the 429 body, falling back to the retry-after header (null = unknown, never NaN). */
function retryAfter(b: Body | null, header: string | null): number | null {
  const fromBody = finiteNum(b, "retryAfterSec");
  if (fromBody !== null && fromBody > 0) return Math.ceil(fromBody);
  if (header !== null && /^\d+$/.test(header.trim())) {
    const n = Number(header.trim());
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return null;
}

export function parseChat(status: number, b: Body | null, retryAfterHeader: string | null = null): ChatResult {
  const reply = str(b, "reply");
  const error = str(b, "error");
  switch (status) {
    case 200:
      if (reply === null) return { kind: "error", detail: "the agent answered 200 without a reply" };
      return { kind: "reply", reply, refused: b?.refused === true };
    case 400:
      return { kind: "bad_request", detail: str(b, "detail") ?? "bad request" };
    case 401:
      return { kind: "unauthorized", reason: str(b, "reason") ?? "UNAUTHORIZED" };
    case 403:
      return { kind: "insufficient", reply: reply ?? "Not eligible: the agent's balance gate refused this wallet." };
    case 429: {
      const w = str(b, "window");
      return {
        kind: "rate_limited",
        window: w === "hour" || w === "day" ? w : null,
        retryAfterSec: retryAfter(b, retryAfterHeader),
        reply: reply ?? "Rate limited by the agent.",
      };
    }
    case 503:
      if (error === "gate_unavailable") return { kind: "gate_unavailable", reply: reply ?? "" };
      return { kind: "unavailable", error: error ?? "unavailable", reply: reply ?? "The agent is temporarily unavailable." };
    default:
      return { kind: "error", detail: str(b, "detail") ?? error ?? `HTTP ${status}` };
  }
}

// ---------------------------------------------------------------------------
// live transport: browser → enclave, direct fetch
// ---------------------------------------------------------------------------

const HEALTH_TIMEOUT_MS = 6_000;
const NONCE_TIMEOUT_MS = 10_000;
const SESSION_TIMEOUT_MS = 20_000;
/** /chat includes a paid inference round-trip. */
const CHAT_TIMEOUT_MS = 90_000;

async function readBody(res: Response): Promise<Body | null> {
  try {
    const v: unknown = await res.json();
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Body) : null;
  } catch {
    return null;
  }
}

function errDetail(e: unknown): string {
  if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) return "timed out";
  return e instanceof Error ? e.message : String(e);
}

export function liveTransport(origin: string): ChatTransport {
  const get = (path: string, timeoutMs: number) =>
    fetch(`${origin}${path}`, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  const post = (path: string, body: unknown, timeoutMs: number, headers: Record<string, string> = {}) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  return {
    async health() {
      try {
        const res = await get("/health", HEALTH_TIMEOUT_MS);
        return parseHealth(res.status, await readBody(res));
      } catch (e) {
        return { kind: "unreachable", detail: errDetail(e) };
      }
    },
    async nonce() {
      try {
        const res = await get("/nonce", NONCE_TIMEOUT_MS);
        return parseNonce(res.status, await readBody(res));
      } catch (e) {
        return { kind: "error", detail: errDetail(e) };
      }
    },
    async session(message, signature) {
      try {
        const res = await post("/session", { message, signature }, SESSION_TIMEOUT_MS);
        return parseSession(res.status, await readBody(res));
      } catch (e) {
        return { kind: "error", detail: errDetail(e) };
      }
    },
    async chat(token, text) {
      try {
        const res = await post("/chat", { text }, CHAT_TIMEOUT_MS, { [TOKEN_HEADER]: token });
        return parseChat(res.status, await readBody(res), res.headers.get("retry-after"));
      } catch (e) {
        return { kind: "error", detail: `could not reach the agent: ${errDetail(e)}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// indicative balance (R4) — display only, never a verdict
// ---------------------------------------------------------------------------

export const erc20ReadAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** balance / supply as a percentage string with 4 decimals, via bigint (no floats); null if supply is 0. */
export function sharePercent(balance: bigint, supply: bigint): string | null {
  if (supply <= 0n || balance < 0n) return null;
  const scaled = (balance * 1_000_000n) / supply; // percent × 10^4
  const whole = scaled / 10_000n;
  const frac = (scaled % 10_000n).toString().padStart(4, "0");
  return `${whole.toString()}.${frac}%`;
}

/** Unix seconds now. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** "m:ss" / "h:mm:ss" countdown label from whole seconds (clamped at 0). */
export function formatCountdown(sec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(r).padStart(2, "0")}`;
}
