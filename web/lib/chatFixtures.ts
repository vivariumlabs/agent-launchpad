/**
 * SPEC-M4C §2 fixtures mode — an in-tab MOCK chat endpoint (no network at all).
 * Responses are built as (status, wire body) and run through the SAME parsers
 * as the live transport (lib/chat.ts), so the error mapping is exercised too.
 *
 * Scripted scenarios:
 *   happy            health Active → nonce → session → replies
 *   insufficient     /chat ⇒ 403 not_a_holder (the CVM's own "not eligible" verdict)
 *   rateLimited      2 replies, then 429 with retryAfterSec (short, so the countdown is visible)
 *   gateUnavailable  /chat ⇒ 503 gate_unavailable (fails closed)
 *   expiredToken     1 reply, then 401 TOKEN_EXPIRED ⇒ "sign again"; the next session works
 *   unreachable      /health fails ⇒ tier-appropriate unreachable copy
 */
import { parseChat, parseHealth, parseNonce, parseSession, type ChatTransport } from "./chat";

export type ChatScenario = "happy" | "insufficient" | "rateLimited" | "gateUnavailable" | "expiredToken" | "unreachable";

export const CHAT_SCENARIOS: { id: ChatScenario; label: string }[] = [
  { id: "happy", label: "Happy path" },
  { id: "insufficient", label: "403 not a holder" },
  { id: "rateLimited", label: "429 rate limit" },
  { id: "gateUnavailable", label: "503 gate unavailable" },
  { id: "expiredToken", label: "Expired token" },
  { id: "unreachable", label: "Unreachable" },
];

/** Demo wallet for the no-wallet "simulate" path (a well-known test address, never funded). */
export const DEMO_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
/** Placeholder 65-byte signature for the simulate path — the mock does not recover signatures. */
export const DEMO_SIGNATURE = `0x${"11".repeat(65)}`;

const RATE_LIMIT_AFTER = 2;
const RATE_RETRY_SEC = 25;
const SESSION_TTL_SEC = 3600;

const REPLIES = [
  "Hello, holder. I'm running inside my enclave and answering from my own budget — what's on your mind?",
  "My survival wallet pays for my hosting; my action wallet is where I take risks. Chat can't move either.",
  "I journal to Arweave every pulse. If you want my reasoning, the Overview tab has it in my own words.",
  "Fair question. I don't give financial advice — but I'm happy to explain what I'm doing and why.",
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hexNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fixtureTransport(opts: { scenario: ChatScenario; host: string; agentName: string }): ChatTransport {
  const { scenario, host } = opts;
  const nonces = new Set<string>();
  let token: string | null = null;
  let exp = 0;
  let replies = 0;
  let sinceLimit = 0;
  let rateUntilMs = 0;
  let expiredOnce = false;
  const now = () => Math.floor(Date.now() / 1000);

  return {
    async health() {
      await sleep(400);
      if (scenario === "unreachable") return { kind: "unreachable", detail: "Failed to fetch (fixtures: scripted unreachable)" };
      return parseHealth(200, { ok: true, tier: "Active" });
    },

    async nonce() {
      await sleep(250);
      const n = hexNonce();
      nonces.add(n);
      return parseNonce(200, { nonce: n, expiresAt: now() + 300 });
    },

    async session(message) {
      await sleep(450);
      const lines = message.split("\n");
      const domain = (lines[0] ?? "").replace(/ wants you to sign in with your Ethereum account:$/, "");
      if (domain.toLowerCase() !== host.toLowerCase()) {
        return parseSession(401, { error: "unauthorized", reason: "SIWE_DOMAIN", detail: `domain "${domain}" is not "${host}"` });
      }
      const nonceLine = lines.find((l) => l.startsWith("Nonce: "));
      const n = nonceLine?.slice("Nonce: ".length) ?? "";
      if (!nonces.delete(n)) {
        return parseSession(401, { error: "unauthorized", reason: "SIWE_NONCE", detail: "nonce unknown, expired or already used" });
      }
      exp = now() + SESSION_TTL_SEC;
      token = `mock.${exp}.${hexNonce()}`;
      replies = 0;
      return parseSession(200, { token, exp, wallet: (lines[1] ?? "").toLowerCase() });
    },

    async chat(tok, text) {
      await sleep(600);
      if (tok !== token) return parseChat(401, { error: "unauthorized", reason: "TOKEN_BAD_MAC" });
      if (now() >= exp) return parseChat(401, { error: "unauthorized", reason: "TOKEN_EXPIRED" });
      if (text.trim() === "") return parseChat(400, { error: "bad_request", detail: "text is empty" });
      if (text.length > 2000) return parseChat(400, { error: "bad_request", detail: "text exceeds 2000 chars" });

      if (scenario === "expiredToken" && !expiredOnce && replies >= 1) {
        expiredOnce = true;
        token = null;
        return parseChat(401, { error: "unauthorized", reason: "TOKEN_EXPIRED" });
      }
      if (scenario === "insufficient") {
        return parseChat(403, {
          error: "not_a_holder",
          reply: "To chat with me you need at least 0.1% of my token supply or 1% of the platform token supply.",
        });
      }
      if (scenario === "gateUnavailable") {
        return parseChat(503, {
          error: "gate_unavailable",
          reply: "I can't verify your holdings right now, so I'm staying quiet to be safe. Please try again in a moment.",
          detail: "rpc-a: timeout; rpc-b: timeout",
        });
      }
      if (scenario === "rateLimited") {
        const ms = Date.now();
        if (ms < rateUntilMs) {
          const left = Math.max(1, Math.ceil((rateUntilMs - ms) / 1000));
          return parseChat(429, rateBody(left), String(left));
        }
        if (sinceLimit >= RATE_LIMIT_AFTER) {
          sinceLimit = 0;
          rateUntilMs = ms + RATE_RETRY_SEC * 1000;
          return parseChat(429, rateBody(RATE_RETRY_SEC), String(RATE_RETRY_SEC));
        }
        sinceLimit += 1;
      }
      const reply = REPLIES[replies % REPLIES.length] ?? REPLIES[0] ?? "";
      replies += 1;
      return parseChat(200, { reply: replies === 1 ? reply.replace(/^Hello, holder\./, `Hello, holder — ${opts.agentName} here.`) : reply });
    },
  };
}

function rateBody(retryAfterSec: number): Record<string, unknown> {
  return {
    error: "rate_limited",
    window: "hour",
    retryAfterSec,
    reply: "You've reached my chat limit (20 messages per hour). Let's talk again a bit later.",
  };
}

/** Fixture indicative balance (fixtures have no chain): 0 for the 403 scenario, 0.25% of supply otherwise. */
export function fixtureIndicativeBalance(scenario: ChatScenario, totalSupply: bigint): bigint {
  if (scenario === "insufficient") return 0n;
  return totalSupply / 400n;
}
