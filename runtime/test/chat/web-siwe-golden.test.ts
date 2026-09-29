// M4C §2: web SIWE builder golden (SPEC-M4C §2 / R6).
//
// web/ has no test runner, so this ONE test pins the web chat tab's SIWE builder against the
// runtime's parser + verifier. The block below is an INLINE COPY of the output-producing logic in
// web/lib/siwe.ts (buildSiweMessage + siweFieldsForEndpoint + siweStatement). KEEP IN SYNC BY HAND:
// if either web/lib/siwe.ts or src/chat/siwe.ts changes, update the copy and this test must stay
// green — that is the whole point (it fails if the two grammars drift).

import { getAddress } from "viem";
import { createSiweMessage } from "viem/siwe";
import { describe, expect, it } from "vitest";
import { createNonceStore } from "../../src/chat/nonce.js";
import { parseSiweMessage, verifySiwe } from "../../src/chat/siwe.js";
import { CHAT_DOMAIN, RH_CHAIN_ID, holder, makeChatHarness, toDate, wallet } from "./harness.js";

// ---------------------------------------------------------------------------
// BEGIN inline copy of web/lib/siwe.ts (keep in sync)
// ---------------------------------------------------------------------------

const SIWE_HEADER_SUFFIX = " wants you to sign in with your Ethereum account:";
const DOMAIN_RE = /^[a-zA-Z0-9.\-]+(:[0-9]{1,5})?$/;
const NONCE_RE = /^[a-zA-Z0-9]{8,}$/;

interface SiweInput {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: Date;
}

function siweStatement(agentId: number): string {
  return `Sign in to chat with agent #${agentId}. This signature proves wallet ownership only; it cannot move funds.`;
}

function siweFieldsForEndpoint(endpoint: string): { domain: string; uri: string } {
  const u = new URL(endpoint);
  return { domain: u.host, uri: u.origin };
}

function buildSiweMessage(input: SiweInput): string {
  if (!DOMAIN_RE.test(input.domain)) throw new Error(`SIWE: domain "${input.domain}" is not host[:port]`);
  if (!NONCE_RE.test(input.nonce)) throw new Error("SIWE: nonce must be ≥8 alphanumerics");
  if (input.statement === "" || input.statement.includes("\n")) throw new Error("SIWE: statement must be one non-empty line");
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error("SIWE: bad chainId");
  const issued = input.issuedAt.getTime();
  if (!Number.isFinite(issued)) throw new Error("SIWE: bad issuedAt");
  return [
    `${input.domain}${SIWE_HEADER_SUFFIX}`,
    getAddress(input.address),
    "",
    input.statement,
    "",
    `URI: ${input.uri}`,
    "Version: 1",
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// END inline copy
// ---------------------------------------------------------------------------

/** What the chat tab does: endpoint → domain/uri, chain 46630, nonce verbatim, issuedAt = Date. */
function webMessage(endpoint: string, address: string, nonce: string, issuedAt: Date, agentId = 9): string {
  const { domain, uri } = siweFieldsForEndpoint(endpoint);
  return buildSiweMessage({ domain, address, statement: siweStatement(agentId), uri, chainId: RH_CHAIN_ID, nonce, issuedAt });
}

describe("M4C §2: web SIWE builder golden", () => {
  it("byte-exact golden for fixed inputs (and equal to viem's reference createSiweMessage)", () => {
    const acct = wallet("golden");
    const issuedAt = new Date("2026-09-29T12:00:00.000Z");
    const text = webMessage("https://a9.vivarium.systems", acct.address.toLowerCase(), "0123456789abcdef0123456789abcdef", issuedAt);
    expect(text).toBe(
      [
        "a9.vivarium.systems wants you to sign in with your Ethereum account:",
        getAddress(acct.address),
        "",
        "Sign in to chat with agent #9. This signature proves wallet ownership only; it cannot move funds.",
        "",
        "URI: https://a9.vivarium.systems",
        "Version: 1",
        "Chain ID: 46630",
        "Nonce: 0123456789abcdef0123456789abcdef",
        "Issued At: 2026-09-29T12:00:00.000Z",
      ].join("\n"),
    );
    expect(text).toBe(
      createSiweMessage({
        domain: "a9.vivarium.systems",
        address: getAddress(acct.address),
        statement: siweStatement(9),
        uri: "https://a9.vivarium.systems",
        version: "1",
        chainId: RH_CHAIN_ID,
        nonce: "0123456789abcdef0123456789abcdef",
        issuedAt,
      }),
    );
    const p = parseSiweMessage(text);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.message.domain).toBe("a9.vivarium.systems");
      expect(p.message.uri).toBe("https://a9.vivarium.systems");
      expect(p.message.chainId).toBe(46630);
      expect(p.message.statement).toBe(siweStatement(9));
      expect(p.message.expirationTime).toBeUndefined();
    }
  });

  it("endpoint → domain keeps a non-default port and drops a default one", () => {
    expect(siweFieldsForEndpoint("http://127.0.0.1:8420")).toEqual({ domain: "127.0.0.1:8420", uri: "http://127.0.0.1:8420" });
    expect(siweFieldsForEndpoint("https://a9.vivarium.systems:443")).toEqual({ domain: "a9.vivarium.systems", uri: "https://a9.vivarium.systems" });
    expect(siweFieldsForEndpoint("http://agent.example.com:80")).toEqual({ domain: "agent.example.com", uri: "http://agent.example.com" });
  });

  it("runtime verifySiwe accepts a web-built message (lowercase input address, real signature)", async () => {
    const acct = wallet("golden-verify");
    const nowMs = Date.UTC(2026, 8, 29, 12, 0, 0);
    const now = BigInt(nowMs / 1000);
    const nonces = createNonceStore({ ttlSec: 300n });
    const { nonce } = nonces.issue(now);
    const text = webMessage(`https://${CHAT_DOMAIN}`, acct.address.toLowerCase(), nonce, new Date(nowMs + 123));
    const signature = await acct.signMessage({ message: text });
    const v = await verifySiwe(text, signature, { domain: CHAT_DOMAIN, chainId: RH_CHAIN_ID, nonces, nonceTtlSec: 300n, now });
    expect(v).toMatchObject({ ok: true });
    if (v.ok) expect(v.message.address).toBe(getAddress(acct.address));
  });

  it("POST /session accepts it end-to-end (nonce route → web builder → sign → token), and /chat works", async () => {
    const h = await makeChatHarness();
    const acct = wallet("golden-session");
    h.setHoldings(acct.address, holder());
    const n = await h.get("/nonce");
    expect(n.status).toBe(200);
    const text = webMessage(`https://${CHAT_DOMAIN}`, acct.address, n.body["nonce"] as string, toDate(h.now()));
    const s = await h.post("/session", { message: text, signature: await acct.signMessage({ message: text }) });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(typeof s.body["token"]).toBe("string");
    expect(typeof s.body["exp"]).toBe("number");
    const c = await h.chat(s.body["token"] as string, "hello from the web tab");
    expect(c.status).toBe(200);
  });

  it("drill endpoint with a port: domain host:port verifies against a chatDomain of host:port", async () => {
    const h = await makeChatHarness({ chatDomain: "127.0.0.1:8420" });
    const acct = wallet("golden-port");
    const n = await h.get("/nonce");
    const text = webMessage("http://127.0.0.1:8420", acct.address, n.body["nonce"] as string, toDate(h.now()));
    const s = await h.post("/session", { message: text, signature: await acct.signMessage({ message: text }) });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
  });
});
