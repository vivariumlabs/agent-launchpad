// SPEC-M2C §1 — routes, body validation, nonce store, SIWE parser units, and ONE real-socket
// smoke test (127.0.0.1:0, full nonce → session → chat flow, close).

import { describe, expect, it } from "vitest";
import { createNonceStore } from "../../src/chat/nonce.js";
import { createChatServer, TOKEN_HEADER } from "../../src/chat/server.js";
import { parseRfc3339, parseSiweMessage } from "../../src/chat/siwe.js";
import { resolveConfig } from "../../src/config/schema.js";
import { listChats } from "../../src/memory/db.js";
import { DAY0, NOW, agentJson, platformJson } from "../policy/helpers.js";
import { CHAT_DOMAIN, holder, makeChatHarness, RH_CHAIN_ID, toDate, wallet } from "./harness.js";
import { createSiweMessage } from "viem/siwe";

const A = wallet("A");

describe("routes", () => {
  it("GET /nonce → 32-hex nonce, expiresAt = now + 300; each call distinct", async () => {
    const h = await makeChatHarness();
    const r1 = await h.get("/nonce");
    const r2 = await h.get("/nonce");
    expect(r1.status).toBe(200);
    expect(r1.body["nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(r1.body["expiresAt"]).toBe(Number(NOW + 300n));
    expect(r1.body["nonce"]).not.toBe(r2.body["nonce"]);
  });

  it("GET /health → { ok, tier } (tier from runway)", async () => {
    const h = await makeChatHarness();
    const r = await h.get("/health");
    expect(r).toMatchObject({ status: 200, body: { ok: true, tier: "Active" } });
  });

  it("GET /attestation → 501 when no provider is wired (no tee report, no TLS)", async () => {
    const h = await makeChatHarness();
    expect((await h.get("/attestation")).status).toBe(501);
  });

  it("GET /attestation (SPEC-M3B §2) → 200 provider payload; provider failure → 503; POST → 405", async () => {
    const payload = { report: '{"kind":"agent-launchpad.attestation-report"}', attestationRef: "tx1", certSpkiSha256: `0x${"ab".repeat(32)}` as const, certKind: "issued" as const, domain: "a1.agents.example.test" };
    const h = await makeChatHarness({ attestation: async () => payload });
    const r = await h.get("/attestation");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ payload: { ...payload, timestamp: NOW.toString(10) }, signer: h.kr.addresses().treasury, signature: expect.stringMatching(/^0x[0-9a-f]{130}$/) });
    expect((await h.post("/attestation", {})).status).toBe(405);
    const bad = await makeChatHarness({ attestation: async () => Promise.reject(new Error("tls store gone")) });
    expect(await bad.get("/attestation")).toEqual({ status: 503, body: { error: "attestation_unavailable", detail: "tls store gone" } });
  });

  it("unknown path → 404; wrong method → 405 with allow; query string ignored; trailing slash tolerated", async () => {
    const h = await makeChatHarness();
    expect((await h.get("/admin")).status).toBe(404);
    const r = await h.server.handle({ method: "POST", path: "/nonce", headers: {} });
    expect(r.status).toBe(405);
    expect(r.headers?.["allow"]).toBe("GET");
    expect((await h.post("/health", {})).status).toBe(405);
    expect((await h.get("/chat")).status).toBe(405);
    expect((await h.get("/nonce?x=1")).status).toBe(200);
    expect((await h.get("/health/")).status).toBe(200);
  });

  it("POST /chat body validation: token first (401), then {text} shape, empty, > chatMaxChars (400); exactly 2000 ok", async () => {
    const h = await makeChatHarness();
    h.setHoldings(A.address, holder());
    // unauthenticated garbage gets 401, not 400 (token is step 0)
    expect((await h.post("/chat", "{{{")).status).toBe(401);
    const t = await h.login(A);
    const hdr = { [TOKEN_HEADER]: t };
    expect((await h.post("/chat", "{{{", hdr)).status).toBe(400);
    expect((await h.post("/chat", { text: 5 }, hdr)).status).toBe(400);
    expect((await h.post("/chat", { msg: "hi" }, hdr)).status).toBe(400);
    expect((await h.post("/chat", { text: "   " }, hdr)).status).toBe(400);
    expect((await h.post("/chat", { text: "x".repeat(2001) }, hdr)).status).toBe(400);
    expect(h.readerA.calls).toHaveLength(0); // no RPC for rejected bodies
    expect((await h.post("/chat", { text: "x".repeat(2000) }, hdr)).status).toBe(200);
    expect(listChats(h.db).filter((c) => c.dir === "in")).toHaveLength(1);
  });

  it("config DEFAULTs (SPEC-M2C §1)", async () => {
    const h = await makeChatHarness();
    expect(h.cfg.chatPort).toBe(8420);
    expect(h.cfg.chatMaxChars).toBe(2000);
    expect(h.cfg.chatAgentGateBps).toBe(10);
    expect(h.cfg.chatPlatformGateBps).toBe(100);
    expect(h.cfg.chatHistoryMax).toBe(10);
    expect(h.cfg.chatSessionTtlSec).toBe(3600n);
    expect(h.cfg.chatNonceTtlSec).toBe(300n);
    expect(h.cfg.chatGateTimeoutMs).toBe(3000);
    expect(h.cfg.chatRpc).toHaveLength(2);
  });

  it("chatRpc must be exactly two endpoints", () => {
    const p = platformJson();
    p["chatRpc"] = ["https://only-one"];
    expect(() => resolveConfig({ platform: p, agent: agentJson, ownAddresses: { treasury: "0xaa00000100000000000000000000000000000000" as `0x${string}`, action: "0xaa00000200000000000000000000000000000000" as `0x${string}` } })).toThrow();
  });
});

describe("nonce store", () => {
  it("single-use, expiry at ttl, pruning, bounded size (oldest evicted)", () => {
    let i = 0;
    const store = createNonceStore({ ttlSec: 300n, maxOutstanding: 3, random: () => new Uint8Array(16).fill(++i) });
    const a = store.issue(NOW);
    expect(store.consume(a.nonce, NOW)).toBe(true);
    expect(store.consume(a.nonce, NOW)).toBe(false);
    const b = store.issue(NOW);
    expect(store.peek(b.nonce, NOW + 299n)).toBe(true);
    expect(store.consume(b.nonce, NOW + 300n)).toBe(false);
    const n1 = store.issue(NOW);
    store.issue(NOW);
    store.issue(NOW);
    store.issue(NOW); // evicts n1
    expect(store.size()).toBe(3);
    expect(store.peek(n1.nonce, NOW)).toBe(false);
    store.issue(NOW + 1000n); // prunes all expired
    expect(store.size()).toBe(1);
  });
  it("re-draws on collision", () => {
    const seq = [1, 1, 2];
    let k = 0;
    const store = createNonceStore({ ttlSec: 300n, random: () => new Uint8Array(16).fill(seq[k++] ?? 9) });
    const x = store.issue(NOW);
    const y = store.issue(NOW);
    expect(x.nonce).not.toBe(y.nonce);
  });
});

describe("SIWE parser (EIP-4361) units", () => {
  const base = {
    domain: CHAT_DOMAIN,
    address: A.address,
    uri: `https://${CHAT_DOMAIN}/chat`,
    version: "1" as const,
    chainId: RH_CHAIN_ID,
    nonce: "abcdef0123456789",
    issuedAt: toDate(NOW),
  };
  it("round-trips viem's reference createSiweMessage with every optional field", () => {
    const text = createSiweMessage({
      ...base,
      scheme: "https",
      statement: "Hello",
      expirationTime: toDate(NOW + 600n),
      notBefore: toDate(NOW - 5n),
      requestId: "req-1",
      resources: ["https://example.com/a", "ipfs://bafy"],
    });
    const p = parseSiweMessage(text);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.message).toEqual({
      scheme: "https",
      domain: CHAT_DOMAIN,
      address: A.address,
      statement: "Hello",
      uri: base.uri,
      version: "1",
      chainId: RH_CHAIN_ID,
      nonce: base.nonce,
      issuedAt: NOW,
      expirationTime: NOW + 600n,
      notBefore: NOW - 5n,
      requestId: "req-1",
      resources: ["https://example.com/a", "ipfs://bafy"],
    });
  });
  it("no statement (two blank lines) parses", () => {
    const p = parseSiweMessage(createSiweMessage(base));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.message.statement).toBeUndefined();
  });
  it("rejects out-of-order optional fields and duplicates", () => {
    const text = createSiweMessage({ ...base, expirationTime: toDate(NOW + 600n), notBefore: toDate(NOW) });
    const swapped = text.replace(/(Expiration Time: [^\n]+)\n(Not Before: [^\n]+)/, "$2\n$1");
    expect(parseSiweMessage(swapped).ok).toBe(false);
    expect(parseSiweMessage(`${text}\nNot Before: ${toDate(NOW).toISOString()}`).ok).toBe(false);
    expect(parseSiweMessage(text.replace("Nonce: abcdef0123456789", "Nonce: short")).ok).toBe(false);
    expect(parseSiweMessage("x".repeat(5000)).ok).toBe(false);
  });
  it("parseRfc3339: epoch, offsets, fractions, leap day, invalid dates", () => {
    expect(parseRfc3339("1970-01-01T00:00:00Z")).toBe(0n);
    expect(parseRfc3339("2026-09-23T00:00:00.000Z")).toBe(DAY0);
    expect(parseRfc3339("2026-09-23T02:00:00+02:00")).toBe(DAY0);
    expect(parseRfc3339("2026-09-22T19:30:00-04:30")).toBe(DAY0);
    expect(parseRfc3339("2024-02-29T00:00:00Z")).toBe(1_709_164_800n);
    expect(parseRfc3339("2023-02-29T00:00:00Z")).toBeNull();
    expect(parseRfc3339("2026-13-01T00:00:00Z")).toBeNull();
    expect(parseRfc3339("2026-09-23T24:00:00Z")).toBeNull();
    expect(parseRfc3339("2026-09-23 00:00:00Z")).toBeNull();
    expect(parseRfc3339("2026-09-23T00:00:00")).toBeNull();
    expect(parseRfc3339("2026-09-23T00:00:00.5Z", "floor")).toBe(DAY0);
    expect(parseRfc3339("2026-09-23T00:00:00.5Z", "ceil")).toBe(DAY0 + 1n);
    expect(parseRfc3339("2026-09-23T00:00:00.000Z", "ceil")).toBe(DAY0);
    expect(parseRfc3339("1900-03-01T00:00:00Z")).toBe(-2_203_891_200n);
  });
});

describe("socket smoke test (node:http, 127.0.0.1:0)", () => {
  it("full nonce → session → chat flow over a real socket, then close", async () => {
    const h = await makeChatHarness();
    h.setHoldings(A.address, holder());
    const { host, port } = await h.server.listen({ port: 0, host: "127.0.0.1" });
    expect(port).toBeGreaterThan(0);
    const base = `http://${host}:${port}`;
    try {
      const n = await fetch(`${base}/nonce`);
      expect(n.status).toBe(200);
      expect(n.headers.get("content-type")).toContain("application/json");
      const { nonce } = (await n.json()) as { nonce: string };
      const message = h.siwe(A, nonce);
      const signature = await A.signMessage({ message });
      const s = await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) });
      expect(s.status).toBe(200);
      const { token } = (await s.json()) as { token: string };
      const c = await fetch(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json", [TOKEN_HEADER]: token }, body: JSON.stringify({ text: "hello over the wire" }) });
      expect(c.status).toBe(200);
      expect(await c.json()).toEqual({ reply: "echo: hello over the wire" });
      const bad = await fetch(`${base}/chat`, { method: "POST", body: JSON.stringify({ text: "no token" }) });
      expect(bad.status).toBe(401);
      const big = await fetch(`${base}/chat`, { method: "POST", headers: { [TOKEN_HEADER]: token }, body: "x".repeat(70_000) });
      expect(big.status).toBe(413);
      expect((await fetch(`${base}/attestation`)).status).toBe(501);
    } finally {
      await h.server.close();
    }
    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });
});

describe("construction", () => {
  it("throws without cfg.chatDomain", async () => {
    const h = await makeChatHarness();
    const cfgNoDomain = { ...h.cfg, chatDomain: undefined };
    expect(() =>
      createChatServer({ exec: { ...h.exec, cfg: cfgNoDomain }, db: h.db, llm: h.llm, x402: h.x402, endpoints: h.endpoints, readers: [h.readerA, h.readerB] }),
    ).toThrow(/chatDomain/);
  });
});
