// attestation/turboHttp.ts — the in-house Turbo/Arweave HTTP uploader (fake fetch + one real local socket).

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { arweaveOwnerAddress, base64url, parseDataItem, verifyDataItem } from "../../src/attestation/ans104.js";
import { TurboArweaveSink, turboTags } from "../../src/attestation/turbo.js";
import { createHttpTurboUploader, DEFAULT_TURBO_UPLOAD_URL, TurboHttpUploader } from "../../src/attestation/turboHttp.js";
import { createKeyring } from "../../src/keyring/keyring.js";
import { MockKms } from "../../src/keyring/mockKms.js";

const kms = new MockKms("image-thttp", "agent-thttp");
const ID43 = "A".repeat(43);

async function signer() {
  const kr = await createKeyring(kms, { retry: { attempts: 1, delayMs: 1 } });
  return kr.turboSigner();
}

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array | string | null;
  redirect: string | undefined;
  hasSignal: boolean;
}

function fakeFetch(handler: (c: Call) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const b = init?.body;
    const c: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: b instanceof Uint8Array ? b : typeof b === "string" ? b : null,
      redirect: init?.redirect,
      hasSignal: init?.signal instanceof AbortSignal,
    };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

describe("TurboHttpUploader.upload", () => {
  it("POSTs ONE signed ANS-104 item (octet-stream, no redirects, timeout) to the DEFAULT endpoint; returns the service id == local id", async () => {
    const s = await signer();
    const { fetchImpl, calls } = fakeFetch((c) => json({ id: parseDataItem(c.body as Uint8Array).id, winc: "0" }));
    const u = new TurboHttpUploader(s, { fetchImpl });
    const data = new TextEncoder().encode("report");
    const tags = turboTags("attestation", 9, 123n);
    const { id } = await u.upload(data, tags);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe(DEFAULT_TURBO_UPLOAD_URL);
    expect(DEFAULT_TURBO_UPLOAD_URL).toBe("https://upload.ardrive.io/v1/tx");
    expect(c.method).toBe("POST");
    expect(c.headers.get("content-type")).toBe("application/octet-stream");
    expect(c.redirect).toBe("error");
    expect(c.hasSignal).toBe(true);
    expect([...c.headers.keys()]).toEqual(["content-type"]); // no signed-request headers
    const item = parseDataItem(c.body as Uint8Array);
    expect(item.id).toBe(id);
    expect(item.tags).toEqual(tags);
    expect(item.data).toEqual(data);
    expect(await verifyDataItem(c.body as Uint8Array)).toBe(true);
  });

  it("202 accepted; service id ≠ local id ⇒ error; missing/garbled id ⇒ error; non-2xx ⇒ error with status", async () => {
    const s = await signer();
    const ok = fakeFetch((c) => json({ id: parseDataItem(c.body as Uint8Array).id }, 202));
    await expect(new TurboHttpUploader(s, { fetchImpl: ok.fetchImpl }).upload(new Uint8Array(1), [])).resolves.toMatchObject({ id: expect.any(String) });
    for (const [res, re] of [
      [json({ id: ID43 }), /!= locally computed/],
      [json({}), /no valid id/],
      [json({ id: "../../etc" }), /no valid id/],
      [new Response("<html>", { status: 200 }), /non-JSON/],
      [json({ error: "insufficient balance" }, 402), /HTTP 402/],
    ] as const) {
      const f = fakeFetch(() => res.clone());
      await expect(new TurboHttpUploader(s, { fetchImpl: f.fetchImpl }).upload(new Uint8Array(1), [])).rejects.toThrow(re);
    }
  });

  it("https only (unless allowInsecureHttp) — checked at construction", async () => {
    const s = await signer();
    expect(() => new TurboHttpUploader(s, { uploadUrl: "http://upload.example/v1/tx" })).toThrow(/non-https/);
    expect(() => new TurboHttpUploader(s, { gatewayUrl: "file:///etc" })).toThrow(/non-https/);
    expect(() => new TurboHttpUploader(s, { uploadUrl: "http://127.0.0.1:1/v1/tx", allowInsecureHttp: true })).not.toThrow();
  });

  it("oversized response bodies are refused (1 MiB JSON cap)", async () => {
    const s = await signer();
    const f = fakeFetch(() => new Response("x".repeat(1024 * 1024 + 1), { status: 200 }));
    await expect(new TurboHttpUploader(s, { fetchImpl: f.fetchImpl }).upload(new Uint8Array(1), [])).rejects.toThrow(/exceeds/);
  });
});

describe("TurboHttpUploader balance / cost", () => {
  it("balance: GET payment /account/balance/ethereum?address=<treasury> → winc; 404 ⇒ 0; bad winc ⇒ throws", async () => {
    const s = await signer();
    const f = fakeFetch(() => json({ winc: "123456789012345678901234567890" }));
    const u = new TurboHttpUploader(s, { fetchImpl: f.fetchImpl });
    expect(await u.balanceWinc()).toBe(123456789012345678901234567890n);
    expect(f.calls[0]!.url).toBe(`https://payment.ardrive.io/v1/account/balance/ethereum?address=${s.address}`);
    expect(f.calls[0]!.method).toBe("GET");
    expect(await new TurboHttpUploader(s, { fetchImpl: fakeFetch(() => json({ error: "no user" }, 404)).fetchImpl }).balanceWinc()).toBe(0n);
    await expect(new TurboHttpUploader(s, { fetchImpl: fakeFetch(() => json({ winc: "-5" })).fetchImpl }).balanceWinc()).rejects.toThrow(/winc/);
    await expect(new TurboHttpUploader(s, { fetchImpl: fakeFetch(() => json({ winc: 1.5 })).fetchImpl }).balanceWinc()).rejects.toThrow(/winc/);
  });

  it("cost: GET payment /price/bytes/<n> → winc; feeds the sink's low-credit warning", async () => {
    const s = await signer();
    const f = fakeFetch((c) => (c.url.includes("/price/bytes/") ? json({ winc: "1000", adjustments: [] }) : c.url.includes("/balance/") ? json({ winc: "5" }) : json({ id: parseDataItem(c.body as Uint8Array).id })));
    const u = new TurboHttpUploader(s, { fetchImpl: f.fetchImpl, paymentUrl: "https://pay.example/v1/" });
    expect(await u.costWinc(2048)).toBe(1000n);
    expect(f.calls[0]!.url).toBe("https://pay.example/v1/price/bytes/2048");
    await expect(u.costWinc(-1)).rejects.toThrow(/bad byte count/);
    const warns: string[] = [];
    const sink = new TurboArweaveSink({ uploader: u, agentId: 3, owner: s.address, logger: { info: () => undefined, warn: (m) => warns.push(m) } });
    const id = await sink.write(new Uint8Array(2048), 1n);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(warns.join("\n")).toMatch(/TURBO CREDITS LOW: 5 winc < 30000 winc/);
  });
});

describe("TurboHttpUploader query / download", () => {
  it("query: GraphQL owners = Arweave-normalized owner, tag filters, pagination; nodes with a foreign owner key are dropped", async () => {
    const s = await signer();
    const myKey = base64url(s.publicKey);
    const pages = [
      { data: { transactions: { pageInfo: { hasNextPage: true }, edges: [{ cursor: "c1", node: { id: "B".repeat(43), owner: { key: myKey } } }, { cursor: "c2", node: { id: "C".repeat(43), owner: { key: "someone-else" } } }] } } },
      { data: { transactions: { pageInfo: { hasNextPage: false }, edges: [{ cursor: "c3", node: { id: "D".repeat(43), owner: { key: myKey } } }, { cursor: "c4", node: { id: "bad id", owner: { key: myKey } } }] } } },
    ];
    let n = 0;
    const f = fakeFetch(() => json(pages[n++]));
    const u = new TurboHttpUploader(s, { fetchImpl: f.fetchImpl });
    const tags = turboTags("snapshot", 5, 0n).filter((t) => t.name !== "Timestamp");
    expect(await u.query(s.address, tags)).toEqual(["B".repeat(43), "D".repeat(43)]);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.url).toBe("https://arweave.net/graphql");
    const v0 = (JSON.parse(f.calls[0]!.body as string) as { variables: { owners: string[]; tags: unknown[]; after: string | null } }).variables;
    expect(v0.owners).toEqual([arweaveOwnerAddress(s.publicKey)]);
    expect(v0.tags).toEqual(tags.map((t) => ({ name: t.name, values: [t.value] })));
    expect(v0.after).toBeNull();
    expect((JSON.parse(f.calls[1]!.body as string) as { variables: { after: string } }).variables.after).toBe("c2");
    await expect(u.query("0x0000000000000000000000000000000000000001", tags)).rejects.toThrow(/own items/);
    await expect(new TurboHttpUploader(s, { fetchImpl: fakeFetch(() => json({ errors: [] })).fetchImpl }).query(s.address, tags)).rejects.toThrow(/malformed/);
  });

  it("download: GET <gateway>/<id>, id format-checked (no path injection), size-capped, non-200 ⇒ throws", async () => {
    const s = await signer();
    const f = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const u = new TurboHttpUploader(s, { fetchImpl: f.fetchImpl, gatewayUrl: "https://gw.example/" });
    expect(await u.download(ID43)).toEqual(new Uint8Array([1, 2, 3]));
    expect(f.calls[0]!.url).toBe(`https://gw.example/${ID43}`);
    await expect(u.download("../graphql")).rejects.toThrow(/bad data-item id/);
    await expect(new TurboHttpUploader(s, { fetchImpl: f.fetchImpl, maxDownloadBytes: 2 }).download(ID43)).rejects.toThrow(/exceeds/);
    await expect(new TurboHttpUploader(s, { fetchImpl: fakeFetch(() => new Response("", { status: 404 })).fetchImpl }).download(ID43)).rejects.toThrow(/HTTP 404/);
  });
});

describe("M3D: live-probe fixes (SPEC-M3D §1a/§1b) + payment seam (§2)", () => {
  it("M3D: balance 404 with the live plain-text body \"User Not Found\" ⇒ 0n (body NOT parsed); other non-2xx / non-JSON stay errors", async () => {
    const s = await signer();
    const plain404 = fakeFetch(() => new Response("User Not Found", { status: 404, headers: { "content-type": "text/plain" } }));
    expect(await new TurboHttpUploader(s, { fetchImpl: plain404.fetchImpl }).balanceWinc()).toBe(0n);
    await expect(new TurboHttpUploader(s, { fetchImpl: fakeFetch(() => new Response("oops", { status: 500 })).fetchImpl }).balanceWinc()).rejects.toThrow(/HTTP 500/);
    await expect(new TurboHttpUploader(s, { fetchImpl: fakeFetch(() => new Response("User Not Found", { status: 200 })).fetchImpl }).balanceWinc()).rejects.toThrow(/non-JSON/);
  });

  it("M3D: download follows EXACTLY ONE https *.arweave.net redirect (first hop manual, the hop itself redirect: error)", async () => {
    const s = await signer();
    const f = fakeFetch((c) =>
      c.url === `https://arweave.net/${ID43}`
        ? new Response(null, { status: 302, headers: { location: `https://sbx123abc.arweave.net/${ID43}` } })
        : new Response(new Uint8Array([7, 8, 9]), { status: 200 }),
    );
    const u = new TurboHttpUploader(s, { fetchImpl: f.fetchImpl });
    expect(await u.download(ID43)).toEqual(new Uint8Array([7, 8, 9]));
    expect(f.calls.map((c) => [c.url, c.redirect])).toEqual([
      [`https://arweave.net/${ID43}`, "manual"],
      [`https://sbx123abc.arweave.net/${ID43}`, "error"],
    ]);
  });

  it("M3D: download refuses an http Location, a foreign host, a look-alike host, a missing Location and a second redirect", async () => {
    const s = await signer();
    const redirectTo = (loc: string | null, second = false) =>
      fakeFetch((c) =>
        c.url.startsWith("https://arweave.net/")
          ? new Response(null, { status: 302, headers: loc === null ? {} : { location: loc } })
          : second
            ? new Response(null, { status: 302, headers: { location: `https://again.arweave.net/${ID43}` } })
            : new Response(new Uint8Array([1]), { status: 200 }),
      );
    const cases: Array<[string | null, boolean, RegExp]> = [
      [`http://sbx.arweave.net/${ID43}`, false, /non-https redirect/],
      [`https://evil.example/${ID43}`, false, /refusing redirect to host evil\.example/],
      [`https://arweave.net.evil.example/${ID43}`, false, /refusing redirect to host/],
      [`https://evilarweave.net/${ID43}`, false, /refusing redirect to host/],
      [`/${ID43}?x=1`, false, /refusing redirect to host arweave\.net/],
      [null, false, /without Location/],
      [`https://sbx.arweave.net/${ID43}`, true, /second redirect/],
    ];
    for (const [loc, second, re] of cases) {
      const f = redirectTo(loc, second);
      await expect(new TurboHttpUploader(s, { fetchImpl: f.fetchImpl }).download(ID43), String(loc)).rejects.toThrow(re);
      expect(f.calls.length).toBeLessThanOrEqual(2);
    }
  });

  it("M3D: paymentAddress = GET <payment>/info → addresses[token] (null when absent/invalid); submitFundTx POSTs {tx_id} JSON, 200/202 ok, else throws", async () => {
    const s = await signer();
    const TURBO = "0x6A0A10FFD285c971B841bee8892878c0d583Bf67";
    const f = fakeFetch((c) =>
      c.url.endsWith("/info") ? json({ version: "x", addresses: { ethereum: "0x1111111111111111111111111111111111111111", "base-eth": TURBO } }) : json({ ok: true }, 202),
    );
    const u = new TurboHttpUploader(s, { fetchImpl: f.fetchImpl });
    expect(await u.paymentAddress("base-eth")).toBe(TURBO);
    expect(await u.paymentAddress("solana")).toBeNull();
    expect(f.calls[0]!.url).toBe("https://payment.ardrive.io/v1/info");
    const tx = `0x${"ab".repeat(32)}` as const;
    expect((await u.submitFundTx("base-eth", tx)).status).toBe(202);
    const post = f.calls[2]!;
    expect([post.url, post.method, post.headers.get("content-type"), post.body]).toEqual([
      "https://payment.ardrive.io/v1/account/balance/base-eth", "POST", "application/json", JSON.stringify({ tx_id: tx }),
    ]);
    await expect(new TurboHttpUploader(s, { fetchImpl: fakeFetch(() => json({ error: "pending" }, 400)).fetchImpl }).submitFundTx("base-eth", tx)).rejects.toThrow(/HTTP 400/);
    await expect(u.submitFundTx("base-eth", "0x1234")).rejects.toThrow(/bad tx id/);
    await expect(u.submitFundTx("../x", tx)).rejects.toThrow(/bad token/);
    expect(await new TurboHttpUploader(s, { fetchImpl: fakeFetch(() => json({ addresses: { "base-eth": "not-an-address" } })).fetchImpl }).paymentAddress("base-eth")).toBeNull();
  });
});

describe("TurboHttpUploader over a real local socket (global fetch)", () => {
  it("the POSTed bytes arrive intact and verify; the sink returns the service id", async () => {
    const s = await signer();
    let received: Buffer | null = null;
    let ct: string | undefined;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received = Buffer.concat(chunks);
        ct = req.headers["content-type"];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: parseDataItem(new Uint8Array(received)).id }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const u = createHttpTurboUploader(s, { uploadUrl: `http://127.0.0.1:${port}/v1/tx`, allowInsecureHttp: true });
      const sink = new TurboArweaveSink({ uploader: u, agentId: 11, owner: s.address });
      const ref = await sink.upload('{"kind":"agent-launchpad.attestation-report"}', 77n);
      expect(ct).toBe("application/octet-stream");
      expect(await verifyDataItem(new Uint8Array(received!))).toBe(true);
      const item = parseDataItem(new Uint8Array(received!));
      expect(item.id).toBe(ref);
      expect(item.tags).toEqual(turboTags("attestation", 11, 77n));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
