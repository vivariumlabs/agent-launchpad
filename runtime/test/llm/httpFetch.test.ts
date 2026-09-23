// SPEC-M3 §3 — FetchHttpClient (the only network file under src/llm): no redirects, hard
// timeout, https-only by default, capped body. Exercised against a local node:http server on
// 127.0.0.1:0 (http allowed only via the explicit allowInsecureHttp test flag).

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FetchHttpClient } from "../../src/llm/httpFetch.js";
import type { HttpRequest } from "../../src/llm/types.js";

let server: http.Server;
let base = "";
const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      switch (req.url) {
        case "/402":
          res.writeHead(402, { "content-type": "application/json", "X-Custom": "Yes" });
          res.end(JSON.stringify({ x402Version: 1, accepts: [] }));
          return;
        case "/ok":
          res.writeHead(200, { "content-type": "application/json", "X-PAYMENT-RESPONSE": "abc" });
          res.end("{}");
          return;
        case "/redirect":
          res.writeHead(302, { location: `${base}/ok` });
          res.end();
          return;
        case "/big":
          res.writeHead(200);
          res.end("x".repeat(2048));
          return;
        case "/hang":
          return; // never answers
        default:
          res.writeHead(404);
          res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

function req(path: string, over: Partial<HttpRequest> = {}): HttpRequest {
  return { method: "POST", url: `${base}${path}`, headers: { "content-type": "application/json", "x-payment": "p" }, body: '{"a":1}', timeoutMs: 2000, ...over };
}

describe("FetchHttpClient", () => {
  const c = new FetchHttpClient({ allowInsecureHttp: true, maxBodyBytes: 1024 });

  it("passes status, body and lowercased headers through (402 is not an error)", async () => {
    const r = await c.request(req("/402"));
    expect(r.status).toBe(402);
    expect(JSON.parse(r.body)).toEqual({ x402Version: 1, accepts: [] });
    expect(r.headers["x-custom"]).toBe("Yes");
    const ok = await c.request(req("/ok"));
    expect(ok.headers["x-payment-response"]).toBe("abc");
    const last = seen[seen.length - 1];
    expect(last?.body).toBe('{"a":1}');
    expect(last?.headers["x-payment"]).toBe("p");
  });

  it("never follows redirects", async () => {
    const before = seen.length;
    await expect(c.request(req("/redirect"))).rejects.toThrow();
    expect(seen.slice(before).map((s) => s.url)).toEqual(["/redirect"]);
  });

  it("hard timeout", async () => {
    await expect(c.request(req("/hang", { timeoutMs: 50 }))).rejects.toThrow();
  });

  it("body cap", async () => {
    await expect(c.request(req("/big"))).rejects.toThrow(/exceeds 1024 bytes/);
  });

  it("https only by default: http:// refused before any request", async () => {
    const strict = new FetchHttpClient();
    const before = seen.length;
    await expect(strict.request(req("/ok"))).rejects.toThrow(/non-https/);
    expect(seen.length).toBe(before);
  });
});
