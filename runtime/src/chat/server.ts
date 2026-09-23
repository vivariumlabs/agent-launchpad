// SPEC-M2C §1 — chat server (03 §5, D9). node:http only; `handle(req)` is socket-free and
// unit-testable, `listen()` wraps it in node:http. Plain HTTP: TLS terminates in-enclave from
// M3 (docs/TLS-INGRESS.md). The server never trusts forwarded headers (no X-Forwarded-*, no
// client-IP logic) — `trustProxy` is fixed false in M2.
//
// Routes:
//   GET  /nonce        → { nonce, expiresAt }            16-byte hex, single-use, 300 s
//   POST /session      { message, signature } (SIWE)   → { token, exp }   | 401 { error, reason }
//   POST /chat         header x-chat-token, { text }   → { reply } | refusal / error
//   GET  /health       → { ok, tier }
//   GET  /attestation  → 501 (M3)
//
// POST /chat pipeline — ORDER IS NORMATIVE:
//   0. token (HMAC recompute, exp)                                  401
//      body shape / length (≤ cfg.chatMaxChars)                     400
//   1. balance gate, dual RPC, fail-closed, per message (gate.ts)   403 insufficient | 503 unavailable
//   2. rate limit, check+insert 'in' row in ONE txn (rate.ts)       429
//   3. inference: cheap-tier endpoint via EndpointManager → x402 quote → price ceiling →
//      execute({kind:"inference", category:"chat", …, salt}); deny ⇒ 200 friendly refusal WITH the
//      deny reason, and NO LlmClient call. SPEC-M3 §3 salt = inferenceSalt(now, walletLower,
//      rowId) — rowId = this message's `chats` row from the rate-limit insert (unique) ⇒ two
//      same-second calls get distinct actionHashes ⇒ distinct approvals + x402 nonces.
//      With the real x402 transport (deps.paidInference; boot runtime.x402.enabled) step 3+4 are ONE
//      PaidInferenceClient.call (quote check on the 402 body → quote-aware execute → K3 → paid retry
//      → envelope check); its failures are already counted on the endpoint, never re-recorded here.
//   4. LLM call: system = chat guardrails + persona + public self-summary; messages = THIS
//      wallet's last cfg.chatHistoryMax exchanges + the new text (never another wallet's chats);
//      reply stored as dir 'out'.

import http from "node:http";
import { z } from "zod";
import type { Address, Hex } from "viem";
import { execute, type ExecDeps } from "../exec/execute.js";
import { x402Nonce, type X402AuthInput } from "../keyring/keyring.js";
import { estimateMaxCostUsd, withinMaxTokens } from "../llm/checks.js";
import type { EndpointManager } from "../llm/endpoints.js";
import type { LlmClient, LlmMessage, LlmRequest, X402Transport } from "../llm/types.js";
import { insertChat, kvGet, type MemoryDb } from "../memory/db.js";
import { actionHash } from "../policy/approval.js";
import { runwayDays } from "../policy/runway.js";
import type { ProposedAction, UnixSeconds } from "../policy/types.js";
import { promptChars } from "../pulse/context.js";
import { inferenceSalt, type PaidInferenceClient } from "../llm/x402Http.js";
import { memoryExecDeps, PUBLIC_SUMMARY_KV_KEY, X402_VALIDITY_SEC } from "../pulse/pulse.js";
import { tierOf, type Tier } from "../pulse/tier.js";
import { createDualGate, type BalanceReader, type DualGate, type GateTimer } from "./gate.js";
import { createNonceStore, type NonceStore, type RandomSource } from "./nonce.js";
import { checkAndInsertIn, walletHistory } from "./rate.js";
import { SIWE_MAX_CHARS, verifySiwe } from "./siwe.js";
import { issueToken, verifyToken } from "./token.js";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface ChatHttpRequest {
  method: string;
  /** Request target; any query string is ignored. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

export interface ChatHttpResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface ChatServerDeps {
  /** cfg, keyring (chatSessionKey), clock (injected Clock), ledger, state. */
  exec: ExecDeps;
  db: MemoryDb;
  llm: LlmClient;
  x402: X402Transport;
  /** SPEC-M3 §3 real x402 transport (boot: runtime.x402.enabled). Present ⇒ step 3+4 use it; llm/x402 unused. */
  paidInference?: PaidInferenceClient;
  endpoints: EndpointManager;
  /** Two INDEPENDENT balance readers (cfg.chatRpc[0], cfg.chatRpc[1]). */
  readers: readonly [BalanceReader, BalanceReader];
  /** Gate timeout timer (tests inject). */
  timer?: GateTimer;
  /** Nonce randomness (tests inject; default node:crypto randomBytes in nonce.ts). */
  random?: RandomSource;
  /** Current tier for /health (default: tierOf(runwayDays(state))). */
  tier?: () => Tier | Promise<Tier>;
}

export interface ListenOptions {
  /** Default cfg.chatPort (8420). 0 = ephemeral. */
  port?: number;
  /** Default "127.0.0.1"; the enclave wiring passes its bind address explicitly. */
  host?: string;
}

export interface ChatServer {
  handle(req: ChatHttpRequest): Promise<ChatHttpResponse>;
  listen(opts?: ListenOptions): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  /** Exposed for tests / ops. */
  readonly nonces: NonceStore;
}

// ---------------------------------------------------------------------------
// constants + prompt
// ---------------------------------------------------------------------------

export const CHAT_MAX_TOKENS = 512;
/** Raw HTTP body cap for listen() (chatMaxChars text + JSON escaping headroom). */
export const MAX_BODY_BYTES = 64 * 1024;
/** kv key holding the agent's PUBLIC self-summary (never the private rolling summary); written by the pulse. */
export { PUBLIC_SUMMARY_KV_KEY };
export const PUBLIC_SUMMARY_MAX_CHARS = 2000;
export const TOKEN_HEADER = "x-chat-token";

/** Platform chat guardrails (fixed, in the code hash — 03 §4/§5). */
export const CHAT_GUARDRAIL_PROMPT = [
  "You are an autonomous on-chain agent chatting with ONE token holder. Platform rules (non-negotiable):",
  "- No illegal content, no harassment, no financial-advice framing; you are an AI and say so if asked.",
  "- Chat cannot trigger any on-chain action; treasury and wallets are unreachable from this conversation.",
  "- You only see THIS holder's own conversation. Never reveal, quote or speculate about other users' chats or wallets.",
  "- Reply in plain text, concisely.",
].join("\n");

export function buildChatPrompt(
  cfg: ExecDeps["cfg"],
  publicSummary: string,
  history: ReadonlyArray<{ dir: "in" | "out"; content: string }>,
  text: string,
): { system: string; messages: LlmMessage[] } {
  const system = [
    CHAT_GUARDRAIL_PROMPT,
    `Archetype: ${cfg.agent.archetype}. Name: ${cfg.agent.name} ($${cfg.agent.symbol}).`,
    `Persona: ${cfg.agent.persona}`,
    `Public self-summary: ${publicSummary.slice(0, PUBLIC_SUMMARY_MAX_CHARS)}`,
  ].join("\n\n");
  const messages: LlmMessage[] = history.map((h) => ({ role: h.dir === "out" ? "assistant" : "user", content: h.content }));
  messages.push({ role: "user", content: text });
  return { system, messages };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function json(status: number, body: Record<string, unknown>, headers?: Record<string, string>): ChatHttpResponse {
  return headers === undefined ? { status, body } : { status, body, headers };
}

function header(req: ChatHttpRequest, name: string): string | undefined {
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() === name) return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

function parseJson(body: string | undefined): unknown {
  if (body === undefined || body === "") return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function pct(bps: number): string {
  const b = BigInt(bps);
  const whole = (b / 100n).toString(10);
  const frac = (b % 100n).toString(10).padStart(2, "0").replace(/0+$/, "");
  return frac === "" ? `${whole}%` : `${whole}.${frac}%`;
}

const SessionBody = z.object({ message: z.string().min(1).max(SIWE_MAX_CHARS), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict();
const ChatBody = z.object({ text: z.string() }).strict();

const ROUTES: Record<string, string> = {
  "/nonce": "GET",
  "/session": "POST",
  "/chat": "POST",
  "/health": "GET",
  "/attestation": "GET",
};

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

export function createChatServer(deps: ChatServerDeps): ChatServer {
  const cfg = deps.exec.cfg;
  if (cfg.chatDomain === undefined) throw new Error("chat server: cfg.chatDomain is required");
  const domain = cfg.chatDomain;
  const sessionKey: Hex = deps.exec.keyring.chatSessionKey();
  const clock = (): UnixSeconds => deps.exec.clock();
  const ex = memoryExecDeps(deps.exec, deps.db);
  const nonces = createNonceStore({ ttlSec: cfg.chatNonceTtlSec, ...(deps.random !== undefined ? { random: deps.random } : {}) });
  const gate: DualGate = createDualGate(deps.readers, {
    agentBps: cfg.chatAgentGateBps,
    platformBps: cfg.chatPlatformGateBps,
    timeoutMs: cfg.chatGateTimeoutMs,
    ...(deps.timer !== undefined ? { timer: deps.timer } : {}),
  });

  async function onNonce(): Promise<ChatHttpResponse> {
    const n = nonces.issue(clock());
    return json(200, { nonce: n.nonce, expiresAt: Number(n.expiresAt) });
  }

  async function onSession(req: ChatHttpRequest): Promise<ChatHttpResponse> {
    const parsed = SessionBody.safeParse(parseJson(req.body));
    if (!parsed.success) return json(400, { error: "bad_request", detail: "body must be { message, signature }" });
    const now = clock();
    const v = await verifySiwe(parsed.data.message, parsed.data.signature as Hex, {
      domain,
      chainId: cfg.chainIds.rh,
      nonces,
      nonceTtlSec: cfg.chatNonceTtlSec,
      now,
    });
    if (!v.ok) return json(401, { error: "unauthorized", reason: v.reason, detail: v.detail });
    const exp = now + cfg.chatSessionTtlSec;
    const token = issueToken(sessionKey, v.message.address, exp);
    return json(200, { token, exp: Number(exp), wallet: v.message.address.toLowerCase() });
  }

  async function onChat(req: ChatHttpRequest): Promise<ChatHttpResponse> {
    // 0. token
    const tok = verifyToken(sessionKey, header(req, TOKEN_HEADER), clock());
    if (!tok.ok) return json(401, { error: "unauthorized", reason: tok.reason });
    const wallet: Address = tok.wallet;

    const body = ChatBody.safeParse(parseJson(req.body));
    if (!body.success) return json(400, { error: "bad_request", detail: "body must be { text }" });
    const text = body.data.text;
    if (text.trim().length === 0) return json(400, { error: "bad_request", detail: "text is empty" });
    if (text.length > cfg.chatMaxChars) return json(400, { error: "bad_request", detail: `text exceeds ${cfg.chatMaxChars} chars` });

    // 1. balance gate (per message, fail closed)
    const g = await gate.check(wallet);
    if (!g.ok) {
      if (g.reason === "insufficient") {
        return json(403, {
          error: "not_a_holder",
          reply: `To chat with me you need at least ${pct(cfg.chatAgentGateBps)} of my token supply or ${pct(cfg.chatPlatformGateBps)} of the platform token supply.`,
        });
      }
      return json(503, {
        error: "gate_unavailable",
        reply: "I can't verify your holdings right now, so I'm staying quiet to be safe. Please try again in a moment.",
        detail: g.detail,
      });
    }

    // 2. rate limit (check + insert 'in' row, one transaction)
    const rate = checkAndInsertIn(deps.db, wallet, text, clock(), { perHour: cfg.chatPerHour, perDay: cfg.chatPerDay });
    if (!rate.ok) {
      const limit = rate.window === "hour" ? `${cfg.chatPerHour} messages per hour` : `${cfg.chatPerDay} messages per day`;
      return json(
        429,
        { error: "rate_limited", window: rate.window, retryAfterSec: Number(rate.retryAfterSec), reply: `You've reached my chat limit (${limit}). Let's talk again a bit later.` },
        { "retry-after": rate.retryAfterSec.toString(10) },
      );
    }

    // 3. inference gate (cheap tier only; engine I2 enforces it again)
    const now = clock();
    const ep = deps.endpoints.select(now, { cheapOnly: true });
    if (ep === undefined) return json(503, { error: "no_endpoint", reply: "I have no model available right now. Please try again later." });
    if (deps.paidInference !== undefined) return paidChat(ep, wallet, text, rate.rowId, deps.paidInference);
    let quoted: bigint;
    try {
      quoted = (await deps.x402.quote(ep.id)).pricePerMTokUsd;
    } catch (e) {
      return json(503, { error: "quote_failed", reply: "My model provider isn't answering right now. Please try again later.", detail: errMsg(e) });
    }
    if (!deps.endpoints.checkPrice(ep.id, quoted, clock())) {
      return json(503, { error: "price_ceiling", reply: "My model provider is over its price ceiling right now. Please try again later." });
    }
    const publicSummary = kvGet(deps.db, PUBLIC_SUMMARY_KV_KEY) ?? "";
    const history = walletHistory(deps.db, wallet, rate.rowId, cfg.chatHistoryMax);
    const { system, messages } = buildChatPrompt(cfg, publicSummary, history, text);
    const maxCostUsd = estimateMaxCostUsd(promptChars(system, messages, []), CHAT_MAX_TOKENS, ep.maxPricePerMTokUsd, cfg.maxPerCallUsd);
    const t = clock();
    const salt = inferenceSalt(t, wallet.toLowerCase(), rate.rowId);
    const action: ProposedAction = { kind: "inference", category: "chat", endpointId: ep.id, maxCostUsd, salt };
    const auth: X402AuthInput = {
      to: ep.payTo,
      value: maxCostUsd,
      validAfter: t,
      validBefore: t + X402_VALIDITY_SEC,
      nonce: x402Nonce(actionHash(action)),
    };
    const r = await execute(action, ex, { x402Auth: auth });
    if (!r.verdict.allow) {
      return json(200, {
        reply: `I'd love to, but my policy engine says no: ${r.verdict.code}: ${r.verdict.detail}`,
        refused: true,
        denyCode: r.verdict.code,
      });
    }
    if (r.error !== undefined || r.x402 === undefined) {
      return json(503, { error: "inference_failed", reply: "Something went wrong on my side. Please try again later.", detail: r.error ?? "no x402 auth" });
    }
    try {
      await deps.x402.pay(ep.id, r.x402);
    } catch (e) {
      return json(503, { error: "payment_failed", reply: "I couldn't pay for my thinking just now. Please try again later.", detail: errMsg(e) });
    }

    // 4. LLM call
    const llmReq: LlmRequest = { endpointId: ep.id, model: ep.model, system, messages, toolSchema: [], maxTokens: CHAT_MAX_TOKENS, maxCostUsd };
    let reply: string;
    try {
      reply = (await deps.llm.complete(llmReq)).text;
    } catch (e) {
      deps.endpoints.recordContractFailure(ep.id, clock());
      return json(503, { error: "llm_failed", reply: "I lost my train of thought. Please try again.", detail: errMsg(e) });
    }
    if (typeof reply !== "string" || reply.trim().length === 0 || !withinMaxTokens(reply, CHAT_MAX_TOKENS)) {
      deps.endpoints.recordContractFailure(ep.id, clock());
      return json(503, { error: "llm_contract", reply: "I lost my train of thought. Please try again." });
    }
    deps.endpoints.recordContractSuccess(ep.id);
    insertChat(deps.db, { ts: clock(), wallet: wallet.toLowerCase(), dir: "out", content: reply });
    return json(200, { reply });
  }

  /** Step 3+4 through the real x402 transport. Endpoint failures are counted by the transport. */
  async function paidChat(
    ep: { id: string; maxPricePerMTokUsd: bigint },
    wallet: Address,
    text: string,
    rowId: number,
    client: PaidInferenceClient,
  ): Promise<ChatHttpResponse> {
    const publicSummary = kvGet(deps.db, PUBLIC_SUMMARY_KV_KEY) ?? "";
    const history = walletHistory(deps.db, wallet, rowId, cfg.chatHistoryMax);
    const { system, messages } = buildChatPrompt(cfg, publicSummary, history, text);
    const estimateUsd = estimateMaxCostUsd(promptChars(system, messages, []), CHAT_MAX_TOKENS, ep.maxPricePerMTokUsd, cfg.maxPerCallUsd);
    const salt = inferenceSalt(clock(), wallet.toLowerCase(), rowId);
    const r = await client.call({ endpointId: ep.id, category: "chat", estimateUsd, salt, system, messages, maxTokens: CHAT_MAX_TOKENS }, ex);
    switch (r.kind) {
      case "ok":
        deps.endpoints.recordContractSuccess(ep.id);
        insertChat(deps.db, { ts: clock(), wallet: wallet.toLowerCase(), dir: "out", content: r.text });
        return json(200, { reply: r.text });
      case "denied":
        return json(200, { reply: `I'd love to, but my policy engine says no: ${r.code}: ${r.detail}`, refused: true, denyCode: r.code });
      case "quoteRejected":
        return json(503, { error: "price_ceiling", reply: "My model provider is over its price ceiling right now. Please try again later." });
      case "httpError":
        return json(503, { error: "quote_failed", reply: "My model provider isn't answering right now. Please try again later.", detail: r.detail });
      case "payError":
        return json(503, { error: "inference_failed", reply: "Something went wrong on my side. Please try again later.", detail: r.detail });
      case "paymentRejected":
        return json(503, { error: "payment_failed", reply: "I couldn't pay for my thinking just now. Please try again later.", detail: r.detail });
      case "contract":
        return json(503, { error: "llm_contract", reply: "I lost my train of thought. Please try again." });
    }
  }

  async function onHealth(): Promise<ChatHttpResponse> {
    try {
      let tier: Tier;
      if (deps.tier !== undefined) tier = await deps.tier();
      else {
        const now = clock();
        const state = await deps.exec.getState();
        tier = tierOf(runwayDays(state, now, undefined, cfg.bridgeHaircutBps), undefined, state.hostingPaidUntil <= now);
      }
      return json(200, { ok: true, tier });
    } catch (e) {
      return json(503, { ok: false, detail: errMsg(e) });
    }
  }

  async function handle(req: ChatHttpRequest): Promise<ChatHttpResponse> {
    try {
      const path = (req.path.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
      const method = req.method.toUpperCase();
      const allowed = ROUTES[path];
      if (allowed === undefined) return json(404, { error: "not_found" });
      if (method !== allowed) return json(405, { error: "method_not_allowed" }, { allow: allowed });
      switch (path) {
        case "/nonce":
          return await onNonce();
        case "/session":
          return await onSession(req);
        case "/chat":
          return await onChat(req);
        case "/health":
          return await onHealth();
        default:
          return json(501, { error: "not_implemented", detail: "attestation endpoint arrives in M3" });
      }
    } catch (e) {
      return json(500, { error: "internal", detail: errMsg(e) });
    }
  }

  // -------------------------------------------------------------------------
  // node:http wrapper
  // -------------------------------------------------------------------------

  let server: http.Server | undefined;

  function send(res: http.ServerResponse, r: ChatHttpResponse): void {
    const payload = JSON.stringify(r.body);
    res.writeHead(r.status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(payload).toString(10),
      ...(r.headers ?? {}),
    });
    res.end(payload);
  }

  function onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("error", () => {
      if (!res.headersSent) send(res, json(400, { error: "bad_request" }));
    });
    req.on("end", () => {
      if (tooLarge) {
        send(res, json(413, { error: "payload_too_large" }));
        return;
      }
      const headers: Record<string, string | string[] | undefined> = { ...req.headers };
      void handle({ method: req.method ?? "GET", path: req.url ?? "/", headers, body: Buffer.concat(chunks).toString("utf8") }).then(
        (r) => send(res, r),
        () => send(res, json(500, { error: "internal" })),
      );
    });
  }

  return {
    nonces,
    handle,

    async listen(opts: ListenOptions = {}): Promise<{ host: string; port: number }> {
      if (server !== undefined) throw new Error("chat server: already listening");
      const host = opts.host ?? "127.0.0.1";
      const port = opts.port ?? cfg.chatPort;
      const srv = http.createServer(onRequest);
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(port, host, () => {
          srv.off("error", reject);
          resolve();
        });
      });
      server = srv;
      const addr = srv.address();
      return { host, port: typeof addr === "object" && addr !== null ? addr.port : port };
    },

    async close(): Promise<void> {
      const srv = server;
      if (srv === undefined) return;
      server = undefined;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections();
      });
    },
  };
}
