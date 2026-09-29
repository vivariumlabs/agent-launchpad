// SPEC-M4C §1 — chat-server CORS (R1). Headers are attached at the wire choke point (send(), shared by
// the node:http and TLS listeners); the preflight response is built in handle(). Non-preflight
// responses are therefore asserted over a real 127.0.0.1:0 socket (handle() output is unchanged —
// existing tests pin it with exact toEqual).

import { describe, expect, it } from "vitest";
import { CORS_HEADERS, TOKEN_HEADER } from "../../src/chat/server.js";
import { holder, makeChatHarness, pauper, wallet, type ChatHarness } from "./harness.js";

const A = wallet("cors-A");
const B = wallet("cors-B");

const ALLOW_ORIGIN = "*";
const ALLOW_HEADERS = "content-type, x-chat-token";
const ALLOW_METHODS = "GET, POST, OPTIONS";
const ROUTE_LIST = ["/nonce", "/session", "/chat", "/health", "/attestation"];

function expectCors(get: (name: string) => string | null): void {
  expect(get("access-control-allow-origin")).toBe(ALLOW_ORIGIN);
  expect(get("access-control-allow-headers")).toBe(ALLOW_HEADERS);
  expect(get("access-control-allow-methods")).toBe(ALLOW_METHODS);
}

async function withWire<T>(h: ChatHarness, fn: (base: string) => Promise<T>): Promise<T> {
  const { host, port } = await h.server.listen({ port: 0, host: "127.0.0.1" });
  try {
    return await fn(`http://${host}:${port}`);
  } finally {
    await h.server.close();
  }
}

const JSON_POST = { "content-type": "application/json" };

describe("M4C §1: preflight", () => {
  it("M4C §1: OPTIONS on every known route → 204, exact header set, empty body, no auth", async () => {
    const h = await makeChatHarness();
    for (const path of ROUTE_LIST) {
      const r = await h.server.handle({ method: "OPTIONS", path, headers: {} });
      expect(r.status, path).toBe(204);
      expect(r.body, path).toEqual({});
      expect(r.headers, path).toEqual({
        "Access-Control-Allow-Origin": ALLOW_ORIGIN,
        "Access-Control-Allow-Headers": ALLOW_HEADERS,
        "Access-Control-Allow-Methods": ALLOW_METHODS,
        "Access-Control-Max-Age": "600",
      });
    }
    expect(CORS_HEADERS["Access-Control-Allow-Origin"]).toBe("*");
    // no auth / no RPC / no nonce issued by a preflight
    expect(h.readerA.calls).toHaveLength(0);
    expect(h.server.nonces.size()).toBe(0);
  });

  it("M4C §1: OPTIONS tolerates lowercase method, query string and trailing slash (same route normalisation)", async () => {
    const h = await makeChatHarness();
    expect((await h.server.handle({ method: "options", path: "/chat?x=1", headers: {} })).status).toBe(204);
    expect((await h.server.handle({ method: "OPTIONS", path: "/health/", headers: {} })).status).toBe(204);
  });

  it("M4C §1: OPTIONS on an unknown route → 404 (existing unknown-route behaviour)", async () => {
    const h = await makeChatHarness();
    const r = await h.server.handle({ method: "OPTIONS", path: "/admin", headers: {} });
    expect(r).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("M4C §1: preflight over the wire → 204, no body, exact CORS headers incl. max-age, on every route", async () => {
    const h = await makeChatHarness();
    await withWire(h, async (base) => {
      for (const path of ROUTE_LIST) {
        const r = await fetch(`${base}${path}`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-chat-token" } });
        expect(r.status, path).toBe(204);
        expect(await r.text(), path).toBe("");
        expectCors((n) => r.headers.get(n));
        expect(r.headers.get("access-control-max-age"), path).toBe("600");
      }
      const unknown = await fetch(`${base}/admin`, { method: "OPTIONS" });
      expect(unknown.status).toBe(404);
    });
  });
});

describe("M4C §1: headers on every response (over the wire)", () => {
  it("M4C §1: success responses (200 nonce, health, session, chat) carry CORS; non-preflight has no max-age", async () => {
    const h = await makeChatHarness();
    h.setHoldings(A.address, holder());
    await withWire(h, async (base) => {
      const n = await fetch(`${base}/nonce`);
      expect(n.status).toBe(200);
      expectCors((k) => n.headers.get(k));
      expect(n.headers.get("access-control-max-age")).toBeNull();
      const { nonce } = (await n.json()) as { nonce: string };

      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expectCors((k) => health.headers.get(k));

      const message = h.siwe(A, nonce);
      const signature = await A.signMessage({ message });
      const s = await fetch(`${base}/session`, { method: "POST", headers: JSON_POST, body: JSON.stringify({ message, signature }) });
      expect(s.status).toBe(200);
      expectCors((k) => s.headers.get(k));
      const { token } = (await s.json()) as { token: string };

      const c = await fetch(`${base}/chat`, { method: "POST", headers: { ...JSON_POST, [TOKEN_HEADER]: token }, body: JSON.stringify({ text: "hi" }) });
      expect(c.status).toBe(200);
      expectCors((k) => c.headers.get(k));
      expect(await c.json()).toEqual({ reply: "echo: hi" });
    });
  });

  it("M4C §1: error responses 400 / 401 / 403 / 404 / 405 / 413 / 429 / 501 / 503 carry CORS on every route that can emit them", async () => {
    const h = await makeChatHarness({ caps: { chatPerHour: 1 } });
    h.setHoldings(A.address, holder());
    h.setHoldings(B.address, pauper());
    const tokA = await h.login(A);
    const tokB = await h.login(B);
    await withWire(h, async (base) => {
      const seen = new Map<number, string[]>();
      const check = async (label: string, want: number, p: Promise<Response>): Promise<void> => {
        const r = await p;
        expect(r.status, label).toBe(want);
        expectCors((k) => r.headers.get(k));
        seen.set(want, [...(seen.get(want) ?? []), label]);
      };
      // 400: session body, chat body
      await check("POST /session bad body", 400, fetch(`${base}/session`, { method: "POST", headers: JSON_POST, body: "{}" }));
      await check("POST /chat empty text", 400, fetch(`${base}/chat`, { method: "POST", headers: { ...JSON_POST, [TOKEN_HEADER]: tokA }, body: JSON.stringify({ text: "  " }) }));
      // 401: session (bad SIWE), chat (no token)
      await check("POST /session bad signature", 401, fetch(`${base}/session`, { method: "POST", headers: JSON_POST, body: JSON.stringify({ message: "x", signature: `0x${"00".repeat(65)}` }) }));
      await check("POST /chat no token", 401, fetch(`${base}/chat`, { method: "POST", headers: JSON_POST, body: JSON.stringify({ text: "hi" }) }));
      // 403: not a holder
      await check("POST /chat pauper", 403, fetch(`${base}/chat`, { method: "POST", headers: { ...JSON_POST, [TOKEN_HEADER]: tokB }, body: JSON.stringify({ text: "hi" }) }));
      // 404 / 405
      await check("GET /admin", 404, fetch(`${base}/admin`));
      await check("POST /nonce", 405, fetch(`${base}/nonce`, { method: "POST", body: "{}" }));
      await check("GET /chat", 405, fetch(`${base}/chat`));
      await check("DELETE /health", 405, fetch(`${base}/health`, { method: "DELETE" }));
      // 413: oversized raw body (send() path outside handle())
      await check("POST /chat oversized", 413, fetch(`${base}/chat`, { method: "POST", headers: { [TOKEN_HEADER]: tokA }, body: "x".repeat(70_000) }));
      // 501: attestation not wired
      await check("GET /attestation unwired", 501, fetch(`${base}/attestation`));
      // 429 (perHour 1: first ok, second limited) — also keeps retry-after intact
      await check("POST /chat first", 200, fetch(`${base}/chat`, { method: "POST", headers: { ...JSON_POST, [TOKEN_HEADER]: tokA }, body: JSON.stringify({ text: "one" }) }));
      const limited = await fetch(`${base}/chat`, { method: "POST", headers: { ...JSON_POST, [TOKEN_HEADER]: tokA }, body: JSON.stringify({ text: "two" }) });
      expect(limited.status).toBe(429);
      expectCors((k) => limited.headers.get(k));
      expect(limited.headers.get("retry-after")).not.toBeNull();
      // 503: gate unavailable (both RPCs reject ⇒ fail closed)
      h.readerA.mode = "reject";
      h.readerB.mode = "reject";
      await check("POST /chat gate down", 503, fetch(`${base}/chat`, { method: "POST", headers: { ...JSON_POST, [TOKEN_HEADER]: tokA }, body: JSON.stringify({ text: "three" }) }));
      expect([...seen.keys()].sort()).toEqual([200, 400, 401, 403, 404, 405, 413, 501, 503]);
    });
  });

  it("M4C §1: 503 /attestation (provider failure) and 200 /attestation carry CORS", async () => {
    const bad = await makeChatHarness({ attestation: async () => Promise.reject(new Error("tls store gone")) });
    await withWire(bad, async (base) => {
      const r = await fetch(`${base}/attestation`);
      expect(r.status).toBe(503);
      expectCors((k) => r.headers.get(k));
    });
    const ok = await makeChatHarness({ attestation: async () => ({ report: null, attestationRef: null, certSpkiSha256: null, certKind: null, domain: null }) });
    await withWire(ok, async (base) => {
      const r = await fetch(`${base}/attestation`);
      expect(r.status).toBe(200);
      expectCors((k) => r.headers.get(k));
    });
  });

  it("M4C §1: existing per-response headers survive (405 allow, 429 retry-after, content-type, cache-control)", async () => {
    const h = await makeChatHarness();
    await withWire(h, async (base) => {
      const r = await fetch(`${base}/nonce`, { method: "POST", body: "{}" });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("GET");
      expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(r.headers.get("cache-control")).toBe("no-store");
      expectCors((k) => r.headers.get(k));
    });
  });
});

describe("M4C §1: no drift (golden bodies)", () => {
  it("M4C §1: GET /health 200 body is byte-identical to the pre-change shape (handle() and wire)", async () => {
    const h = await makeChatHarness();
    const expected = '{"ok":true,"tier":"Active"}';
    const r = await h.get("/health");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toBe(expected);
    expect(r.headers).toBeUndefined(); // handle() output for non-preflight is unchanged
    await withWire(h, async (base) => {
      const w = await fetch(`${base}/health`);
      expect(w.status).toBe(200);
      expect(await w.text()).toBe(expected);
    });
  });

  it("M4C §1: POST /chat 401 (no token) body is byte-identical to the pre-change shape (handle() and wire)", async () => {
    const h = await makeChatHarness();
    const expected = '{"error":"unauthorized","reason":"TOKEN_MISSING"}';
    const r = await h.post("/chat", { text: "hi" });
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).toBe(expected);
    expect(r.headers?.["allow"]).toBeUndefined();
    await withWire(h, async (base) => {
      const w = await fetch(`${base}/chat`, { method: "POST", headers: JSON_POST, body: JSON.stringify({ text: "hi" }) });
      expect(w.status).toBe(401);
      expect(await w.text()).toBe(expected);
    });
  });
});
