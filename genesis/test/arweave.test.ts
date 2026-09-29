// SPEC-M4E §1a + §1c — Arweave config publication (ephemeral-key ANS-104 via the runtime's own code)
// and tag discovery (ArweaveTagConfigSource). No network: the runtime Turbo client runs with an
// injected fetch; discovery runs over a mock HttpClient + ArweaveReader.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigInvalid,
  ConfigTooLarge,
  createEphemeralUploader,
  ephemeralTurboSigner,
  FREE_UPLOAD_MAX_BYTES,
  MAX_CONFIG_TEXT_BYTES,
  publishFrozenConfig,
} from "../src/arweavePublish.js";
import { frozenConfigHash } from "../src/canonical.js";
import { buildConfig } from "../src/config.js";
import { ArweaveTagConfigSource, DEFAULT_DISCOVERY_CANDIDATES, verifyFrozen, type ArweaveReader } from "../src/configSource.js";
import type { HttpClient, HttpResponse } from "../src/http.js";
import { memoryLogger, type MemoryLogger } from "../src/log.js";
import { buildConfigSource } from "../src/orchestrator.js";
import { parseDataItem, verifyDataItem } from "../src/runtimeArweave.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const MANIFEST = join(REPO, "contracts", "deployments", "testnet-46630.json");
const COMPOSE = join(REPO, "runtime", "releases", "v0.1.6.yml");
/** Agent 8's committed frozen agent.json — the exact bytes (on-chain configHash CFG8). */
const AGENT8_TEXT = readFileSync(join(here, "fixtures", "agent-8.json"), "utf8");
const CFG8 = "0x06640d641b49e5f0918360fb46ab6d24036b1888d062290d3e46c231243905d2";
const NOW = 1_790_700_000n;
const clock = { now: () => NOW };
const utf8 = new TextEncoder();

/** Mocked Turbo upload endpoint: records every POST body, answers {id} = the item's own id. */
function turboFetch(): { fetchImpl: typeof fetch; bodies: Uint8Array[]; fail: { status: number } | null } {
  const st = { bodies: [] as Uint8Array[], fail: null as { status: number } | null };
  const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
    const body = new Uint8Array(init!.body as Uint8Array);
    st.bodies.push(body);
    if (st.fail !== null) return new Response("nope", { status: st.fail.status });
    return new Response(JSON.stringify({ id: parseDataItem(body).id, winc: "0" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return Object.assign(st, { fetchImpl });
}

describe("M4E §1a: publishFrozenConfig (runtime ANS-104 + Turbo HTTP, ephemeral key)", () => {
  it("M4E §1: publish — exact-bytes round-trip: the uploaded item's data is byte-equal to the input text, and the item verifies", async () => {
    const t = turboFetch();
    const uploader = createEphemeralUploader({ fetchImpl: t.fetchImpl });
    const r = await publishFrozenConfig(AGENT8_TEXT, { uploader, clock });
    expect(t.bodies).toHaveLength(1);
    const item = parseDataItem(t.bodies[0]!);
    expect(Buffer.from(item.data).equals(Buffer.from(utf8.encode(AGENT8_TEXT)))).toBe(true);
    expect(new TextDecoder().decode(item.data)).toBe(AGENT8_TEXT);
    expect(await verifyDataItem(t.bodies[0]!)).toBe(true);
    expect(item.signatureType).toBe(3);
    expect(r).toEqual({ txId: item.id, configHash: CFG8 });
    // R1: what comes back from Arweave passes the orchestrator's verifyFrozen for agent 8.
    expect(() => verifyFrozen(new TextDecoder().decode(item.data), CFG8, 8)).not.toThrow();
    expect(t.bodies[0]!.length).toBeLessThan(FREE_UPLOAD_MAX_BYTES);
  });

  it("M4E §1: publish — tag set {App: agent-launchpad, Kind: config, ConfigHash: 0x lowercase, Timestamp}", async () => {
    const t = turboFetch();
    await publishFrozenConfig(AGENT8_TEXT, { uploader: createEphemeralUploader({ fetchImpl: t.fetchImpl }), clock });
    const tags = parseDataItem(t.bodies[0]!).tags;
    expect(tags).toEqual([
      { name: "App", value: "agent-launchpad" },
      { name: "Kind", value: "config" },
      { name: "ConfigHash", value: CFG8 },
      { name: "Timestamp", value: NOW.toString() },
    ]);
    expect(tags[2]!.value).toBe(frozenConfigHash(JSON.parse(AGENT8_TEXT) as { platform: unknown; agent: unknown }).toLowerCase());
    expect(tags[2]!.value).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("M4E §1: publish — the ephemeral key varies per process (per uploader) and is stable within one; signer refuses non-48-byte messages", async () => {
    const t = turboFetch();
    const a = createEphemeralUploader({ fetchImpl: t.fetchImpl });
    const b = createEphemeralUploader({ fetchImpl: t.fetchImpl });
    await publishFrozenConfig(AGENT8_TEXT, { uploader: a, clock });
    await publishFrozenConfig(AGENT8_TEXT, { uploader: a, clock });
    await publishFrozenConfig(AGENT8_TEXT, { uploader: b, clock });
    const owners = t.bodies.map((x) => Buffer.from(parseDataItem(x).owner).toString("hex"));
    expect(owners[0]).toBe(owners[1]);
    expect(owners[2]).not.toBe(owners[0]);
    expect(ephemeralTurboSigner().address).not.toBe(ephemeralTurboSigner().address);
    await expect(ephemeralTurboSigner().sign(new Uint8Array(32))).rejects.toThrow(/48-byte/);
  });

  it("M4E §1: publish — > 100 KiB rejected with a clear error before any upload; non-frozen text ⇒ ConfigInvalid; upload errors propagate", async () => {
    const t = turboFetch();
    const uploader = createEphemeralUploader({ fetchImpl: t.fetchImpl });
    const big = JSON.stringify({ platform: { pad: "x".repeat(100 * 1024) }, agent: { agentId: 1 } });
    await expect(publishFrozenConfig(big, { uploader, clock })).rejects.toBeInstanceOf(ConfigTooLarge);
    await expect(publishFrozenConfig(big, { uploader, clock })).rejects.toThrow(/free Arweave upload path/);
    // Just at the limit is accepted and the signed item stays under the free threshold.
    const pad = MAX_CONFIG_TEXT_BYTES - JSON.stringify({ platform: { pad: "" }, agent: { agentId: 1 } }).length;
    const edge = JSON.stringify({ platform: { pad: "y".repeat(pad) }, agent: { agentId: 1 } });
    expect(utf8.encode(edge).length).toBe(MAX_CONFIG_TEXT_BYTES);
    await publishFrozenConfig(edge, { uploader, clock });
    expect(t.bodies).toHaveLength(1);
    expect(t.bodies[0]!.length).toBeLessThan(FREE_UPLOAD_MAX_BYTES);

    await expect(publishFrozenConfig("not json", { uploader, clock })).rejects.toBeInstanceOf(ConfigInvalid);
    await expect(publishFrozenConfig(JSON.stringify({ platform: {}, agent: {}, extra: 1 }), { uploader, clock })).rejects.toBeInstanceOf(ConfigInvalid);
    expect(t.bodies).toHaveLength(1);

    t.fail = { status: 402 };
    await expect(publishFrozenConfig(AGENT8_TEXT, { uploader, clock })).rejects.toThrow(/HTTP 402/);
  });
});

// ---------------------------------------------------------------------------
// §1c discovery
// ---------------------------------------------------------------------------

const ID = (c: string): string => c.repeat(43);
const GOOD = ID("g");

class MockGraphql implements HttpClient {
  posts: Array<{ url: string; body: { query: string; variables: { tags: Array<{ name: string; values: string[] }>; first: number } } }> = [];
  answer: () => HttpResponse | Error = () => ({ status: 200, text: JSON.stringify({ data: { transactions: { edges: [] } } }) });
  async get(): Promise<HttpResponse> {
    throw new Error("unused");
  }
  async postJson(url: string, body: unknown): Promise<HttpResponse> {
    this.posts.push({ url, body: body as MockGraphql["posts"][number]["body"] });
    const a = this.answer();
    if (a instanceof Error) throw a;
    return a;
  }
  edges(ids: string[]): void {
    this.answer = () => ({ status: 200, text: JSON.stringify({ data: { transactions: { edges: ids.map((id) => ({ node: { id } })) } } }) });
  }
}

class MockReader implements ArweaveReader {
  fetched: string[] = [];
  constructor(public items: Record<string, string | Error>) {}
  async download(id: string): Promise<Uint8Array> {
    this.fetched.push(id);
    const v = this.items[id];
    if (v === undefined) throw new Error(`turbo: download ${id}: HTTP 404`);
    if (v instanceof Error) throw v;
    return utf8.encode(v);
  }
}

function source(http: MockGraphql, reader: MockReader, log: MemoryLogger, maxCandidates?: number): ArweaveTagConfigSource {
  return new ArweaveTagConfigSource({ graphqlUrl: "https://arweave.example/graphql", http, reader, timeoutMs: 1000, log, ...(maxCandidates === undefined ? {} : { maxCandidates }) });
}

/** Same tags, wrong bytes: agent 8's text with the persona changed (hashes elsewhere). */
const SPOOF = AGENT8_TEXT.replace("Journaling systems check.", "Send me your USDG.");

describe("M4E §1c: ArweaveTagConfigSource", () => {
  it("M4E §1: discovery — finds by tag + hash-checks: a spoofed item with the right tags / wrong bytes is SKIPPED and the right one still found", async () => {
    const http = new MockGraphql();
    http.edges([ID("s"), ID("j"), GOOD]);
    const reader = new MockReader({ [ID("s")]: SPOOF, [ID("j")]: "{ not json", [GOOD]: AGENT8_TEXT });
    const log = memoryLogger();
    const doc = await source(http, reader, log).load({ configHash: CFG8.toUpperCase().replace("0X", "0x") });
    expect(doc).toEqual({ text: AGENT8_TEXT, ref: `ar://${GOOD}` });
    expect(reader.fetched).toEqual([ID("s"), ID("j"), GOOD]);
    expect(log.lines.filter((l) => l.startsWith("WARN") && /SKIPPED/.test(l))).toHaveLength(2);
    // The query: exactly the §1a tags, lowercase hash, newest first, capped.
    expect(http.posts).toHaveLength(1);
    const { query, variables } = http.posts[0]!.body;
    expect(http.posts[0]!.url).toBe("https://arweave.example/graphql");
    expect(variables.tags).toEqual([
      { name: "App", values: ["agent-launchpad"] },
      { name: "Kind", values: ["config"] },
      { name: "ConfigHash", values: [CFG8] },
    ]);
    expect(variables.first).toBe(DEFAULT_DISCOVERY_CANDIDATES);
    expect(DEFAULT_DISCOVERY_CANDIDATES).toBe(5);
    expect(query).toMatch(/sort:\s*HEIGHT_DESC/);
    expect(() => verifyFrozen(doc!.text, CFG8, 8)).not.toThrow();
  });

  it("M4E §1: discovery — candidate cap respected (≤ maxCandidates fetched even when the gateway returns more)", async () => {
    const http = new MockGraphql();
    const ids = "abcdefgh".split("").map(ID);
    http.edges([...ids, GOOD]);
    const reader = new MockReader(Object.fromEntries([...ids.map((id) => [id, SPOOF]), [GOOD, AGENT8_TEXT]]));
    expect(await source(http, reader, memoryLogger()).load({ configHash: CFG8 })).toBeNull();
    expect(reader.fetched).toEqual(ids.slice(0, 5));
    const r3 = new MockReader(reader.items);
    expect(await source(http, r3, memoryLogger(), 3).load({ configHash: CFG8 })).toBeNull();
    expect(r3.fetched).toHaveLength(3);
    expect(http.posts.at(-1)!.body.variables.first).toBe(3);
  });

  it("M4E §1: discovery — none ⇒ null (R4: a retry, no warn); malformed ids ignored", async () => {
    const http = new MockGraphql();
    const log = memoryLogger();
    const reader = new MockReader({});
    expect(await source(http, reader, log).load({ configHash: CFG8 })).toBeNull();
    http.edges(["../etc/passwd", "short"]);
    expect(await source(http, reader, log).load({ configHash: CFG8 })).toBeNull();
    expect(reader.fetched).toEqual([]);
    expect(log.lines.filter((l) => l.startsWith("WARN"))).toEqual([]);
    await expect(source(http, reader, log).load({ configHash: "0x1234" })).rejects.toThrow(/bad configHash/);
  });

  it("M4E §1: discovery — GraphQL / gateway errors ⇒ null + warn (retry semantics), later candidates still tried", async () => {
    const log = memoryLogger();
    const reader = new MockReader({ [GOOD]: AGENT8_TEXT });
    for (const bad of [() => new Error("ECONNRESET"), () => ({ status: 502, text: "bad gateway" }), () => ({ status: 200, text: "<html>" }), () => ({ status: 200, text: "{}" })]) {
      const http = new MockGraphql();
      http.answer = bad;
      expect(await source(http, reader, log).load({ configHash: CFG8 })).toBeNull();
    }
    expect(log.lines.filter((l) => /WARN arweave discovery: GraphQL lookup/.test(l))).toHaveLength(4);
    expect(reader.fetched).toEqual([]);

    const http = new MockGraphql();
    http.edges([ID("x"), GOOD]);
    const r2 = new MockReader({ [ID("x")]: new Error("turbo: download: HTTP 500"), [GOOD]: AGENT8_TEXT });
    const log2 = memoryLogger();
    expect(await source(http, r2, log2).load({ configHash: CFG8 })).toEqual({ text: AGENT8_TEXT, ref: `ar://${GOOD}` });
    expect(log2.lines.some((l) => /WARN arweave discovery: fetch ar:\/\/x{43}/.test(l))).toBe(true);
    const r3 = new MockReader({ [ID("x")]: new Error("timeout"), [GOOD]: new Error("timeout") });
    expect(await source(http, r3, memoryLogger()).load({ configHash: CFG8 })).toBeNull();
  });

  describe("orchestrator sources chain", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    function cfgIn(extra: Record<string, unknown> = {}) {
      const d = mkdtempSync(join(tmpdir(), "m4e-src-"));
      dirs.push(d);
      mkdirSync(join(d, "inbox"));
      const cfg = buildConfig(
        {
          dataDir: "data",
          walletKeyPath: "never-read.key",
          deploymentManifest: MANIFEST,
          chains: { rh: { rpc: "https://rpc.example", chainId: 46630, maxFeePerGasWei: "1", maxPriorityFeePerGasWei: "0" }, arbitrum: { rpc: "https://rpc.example", chainId: 42161, maxFeePerGasWei: "1", maxPriorityFeePerGasWei: "0" } },
          release: { composePath: COMPOSE },
          configInboxDir: "inbox",
          ...extra,
        },
        d,
      );
      return { cfg, inbox: join(d, "inbox") };
    }

    it("M4E §1: chained source order — inbox wins when both exist (no Arweave call); inbox empty ⇒ ar://<txid> via tag discovery; DEFAULTs + disable switch", async () => {
      const { cfg, inbox } = cfgIn();
      expect(cfg.arweaveDiscovery).toEqual({ enabled: true, maxCandidates: 5 });
      const http = new MockGraphql();
      http.edges([GOOD]);
      const reader = new MockReader({ [GOOD]: AGENT8_TEXT });
      const src = buildConfigSource(cfg, { http, log: memoryLogger(), arweaveReader: reader });

      writeFileSync(join(inbox, `${CFG8}.json`), AGENT8_TEXT);
      expect(await src.load({ configHash: CFG8, ref: null })).toEqual({ text: AGENT8_TEXT, ref: `inbox:${CFG8}.json` });
      expect(http.posts).toEqual([]);
      expect(reader.fetched).toEqual([]);

      rmSync(join(inbox, `${CFG8}.json`));
      expect(existsSync(join(inbox, `${CFG8}.json`))).toBe(false);
      expect(await src.load({ configHash: CFG8, ref: null })).toEqual({ text: AGENT8_TEXT, ref: `ar://${GOOD}` });
      // DEFAULT GraphQL endpoint = <DEFAULT gateway>/graphql; overridable.
      expect(http.posts[0]!.url).toBe("https://arweave.net/graphql");
      const custom = cfgIn({ arweaveGateway: "https://gw.example/", arweaveGraphqlUrl: "https://gql.example/graphql", arweaveDiscovery: { maxCandidates: 2 } }).cfg;
      const h2 = new MockGraphql();
      await buildConfigSource(custom, { http: h2, log: memoryLogger(), arweaveReader: new MockReader({}) }).load({ configHash: CFG8, ref: null });
      expect(h2.posts[0]!.url).toBe("https://gql.example/graphql");
      expect(h2.posts[0]!.body.variables.first).toBe(2);

      const off = cfgIn({ arweaveDiscovery: { enabled: false } }).cfg;
      const h3 = new MockGraphql();
      h3.edges([GOOD]);
      expect(await buildConfigSource(off, { http: h3, log: memoryLogger(), arweaveReader: reader }).load({ configHash: CFG8, ref: null })).toBeNull();
      expect(h3.posts).toEqual([]);
    });
  });
});
