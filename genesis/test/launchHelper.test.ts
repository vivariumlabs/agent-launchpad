import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, stringToBytes, type Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { startLaunchHelperServer } from "../bin/launch-helper.js";
import { canonicalEncode, frozenConfigHash } from "../src/canonical.js";
import { buildConfig, loadConfig } from "../src/config.js";
import type { Exec, ExecResult } from "../src/exec.js";
import type { HttpClient, HttpResponse } from "../src/http.js";
import { KMS_ENDPOINT_DEFAULT, KMS_VERIFICATION_KEY_DEFAULT, kmsDerivePathAndQuery, PublicKmsDeriver, verifyKmsSignature } from "../src/kmsDerive.js";
import {
  buildPlatform,
  composeVersionOf,
  createLaunchHelper,
  jsonlSink,
  LaunchHelper,
  parseAllowlistFile,
  readManifestAddrs,
  type FactoryReader,
  type HelperResponse,
  type LaunchHelperDeps,
} from "../src/launchHelper.js";
import { memoryLogger, type MemoryLogger } from "../src/log.js";
import { computeImageIdArgs, OysterCli, type OysterSettings } from "../src/oyster.js";

// ---------------------------------------------------------------------------
// Golden: the LIVE agent 8 (created 2026-09-29, runtime v0.1.6). Its frozen agent.json (fixture), its
// on-chain configHash, its release image-id and its KMS-derived EOAs are all public; the KMS answers
// below are the real HTTP responses (body + x-marlin-kms-signature) captured from the public
// image-KMS endpoint the same day. No network in tests.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const MANIFEST = join(REPO, "contracts", "deployments", "testnet-46630.json");
const COMPOSE = join(REPO, "runtime", "releases", "v0.1.6.yml");
const RELEASE = JSON.parse(readFileSync(join(REPO, "runtime", "releases", "v0.1.6.json"), "utf8")) as { configHashes: Record<string, string>; imageIds: Record<string, string> };
const AGENT8 = JSON.parse(readFileSync(join(here, "fixtures", "agent-8.json"), "utf8")) as { platform: Record<string, unknown>; agent: Record<string, unknown> };

const CFG8 = "0x06640d641b49e5f0918360fb46ab6d24036b1888d062290d3e46c231243905d2";
const IMAGE8 = "f489dc609c6b33a7016c113f0965a46de35c4cfd2ef8e8f4751bd845923a4350";
const TREASURY8 = "0xd7EF592E26936627C2dAD31c08EeD561dB5EeCB8";
const ACTION8 = "0x3c169d57729Bf24bdEA3Ef34f5089BE6234bc9a1";
const FACTORY = "0x7b257abd9BDf3377Af03DD67e2D67a8D5717b118" as Address;
const USDG = "0xe6f7E5832991f5af335C2A21d4F35cea3d47ccAb" as Address;
const REGISTRY = "0xDBA9680C0F1958Af7Bc34a225863D93df2B92f59" as Address;

const KMS_LIVE: Record<string, { body: string; sig: string }> = {
  treasury: {
    body: "0xd7ef592e26936627c2dad31c08eed561db5eecb8",
    sig: "af64fb9fe56a0a25f65a0786bf6327f6e99020403f9921089454ba5e949bdd1477fbdf7d92c173a284cd2fc889d41e8cd94d0191b9d8b206301bc4060e6f67971b",
  },
  action: {
    body: "0x3c169d57729bf24bdea3ef34f5089be6234bc9a1",
    sig: "093c60420cba22945fff9e95a17a31075412af00233fa339488e9c513650b9f44dcfa5697f5d0b8aeabd4948c1c8d33459523a8711f912da7aea917e11e9f4691b",
  },
};

const AGENT8_BODY = {
  agent: {
    name: AGENT8.agent.name as string,
    symbol: AGENT8.agent.symbol as string,
    archetype: AGENT8.agent.archetype as string,
    persona: AGENT8.agent.persona as string,
    models: AGENT8.agent.models as { primary: string; fallbacks: string[]; chatTier: string },
  },
};

const OYSTER: OysterSettings = {
  bin: "/tmp/bin/oyster-cvm",
  deployment: "arb",
  arch: "arm64",
  preset: "blue",
  region: "ap-south-1",
  operator: "0xe10fa12f580e660ecd593ea4119cebc90509d642",
  indexerUrl: "https://indexer.example/graphql",
  deployTimeoutSec: 900,
  verifyTimeoutSec: 120,
  cliTimeoutSec: 120,
  httpTimeoutSec: 20,
};

class MockExec implements Exec {
  calls: Array<{ bin: string; args: readonly string[] }> = [];
  result: (args: readonly string[]) => ExecResult = () => ({ code: 0, stdout: `\u001b[32m INFO\u001b[0m oyster_cvm::commands::image_id: Image ID: ${IMAGE8}\n`, stderr: "", timedOut: false });
  async run(bin: string, args: readonly string[]): Promise<ExecResult> {
    this.calls.push({ bin, args });
    return this.result(args);
  }
}

class MockKmsHttp implements HttpClient {
  urls: string[] = [];
  override: (path: string, url: string) => HttpResponse | Error | null = () => null;
  async get(url: string): Promise<HttpResponse> {
    this.urls.push(url);
    const path = new URL(url).searchParams.get("path") ?? "";
    const o = this.override(path, url);
    if (o instanceof Error) throw o;
    if (o !== null) return o;
    const live = KMS_LIVE[path];
    if (live === undefined || new URL(url).searchParams.get("image_id") !== IMAGE8) return { status: 404, text: "unknown", headers: {} };
    return { status: 200, text: live.body, headers: { "content-type": "text/plain; charset=utf-8", "x-marlin-kms-signature": live.sig } };
  }
  async postJson(): Promise<HttpResponse> {
    throw new Error("unused");
  }
}

interface World {
  helper: LaunchHelper;
  exec: MockExec;
  kmsHttp: MockKmsHttp;
  factory: { count: bigint | Error; calls: number };
  rejections: Array<Record<string, unknown>>;
  log: MemoryLogger;
}

function platform8(): Record<string, unknown> {
  return buildPlatform({ template: AGENT8, contracts: { registry: REGISTRY, usdg: USDG }, manifest: readManifestAddrs(MANIFEST), allowlist: null });
}

function world(o: { sink?: (e: Record<string, unknown>) => void; publisher?: LaunchHelperDeps["publisher"] } = {}): World {
  const exec = new MockExec();
  const kmsHttp = new MockKmsHttp();
  const factoryState = { count: 7n as bigint | Error, calls: 0 };
  const factory: FactoryReader = {
    agentCount: async () => {
      factoryState.calls++;
      if (factoryState.count instanceof Error) throw factoryState.count;
      return factoryState.count;
    },
  };
  const rejections: Array<Record<string, unknown>> = [];
  const log = memoryLogger();
  const helper = new LaunchHelper({
    platform: platform8(),
    composePath: COMPOSE,
    composeVersion: "v0.1.6",
    contracts: { factory: FACTORY, usdg: USDG },
    oyster: new OysterCli(OYSTER, exec, kmsHttp),
    kms: new PublicKmsDeriver(KMS_ENDPOINT_DEFAULT, KMS_VERIFICATION_KEY_DEFAULT, kmsHttp, 5000),
    factory,
    rejections: (e) => {
      rejections.push(e);
      o.sink?.(e);
    },
    corsOrigin: "*",
    clock: { now: () => 1_790_700_000n },
    log,
    ...(o.publisher === undefined ? {} : { publisher: o.publisher }),
  });
  return { helper, exec, kmsHttp, factory: factoryState, rejections, log };
}

async function call(w: World, method: string, url: string, body?: unknown): Promise<{ status: number; body: any; res: HelperResponse }> {
  const res = await w.helper.handle({ method, url, body: body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, body: res.body === "" ? null : JSON.parse(res.body), res };
}

// ---------------------------------------------------------------------------

describe("M4B §2: template", () => {
  it("M4B §2: GET /api/launch/template — platform (template + manifest overlay), archetypes, allowlist models, fee 75000000, composeVersion; CORS", async () => {
    const w = world();
    const r = await call(w, "GET", "/api/launch/template");
    expect(r.status).toBe(200);
    expect(r.res.headers["access-control-allow-origin"]).toBe("*");
    expect(r.res.headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
    expect(r.body.platform).toEqual(AGENT8.platform); // agent-8's platform IS what the overlay reproduces
    expect(r.body.defaults).toEqual({
      archetypes: ["trader", "artist", "poster", "degen", "sage"],
      models: [
        { id: "dexl-free", model: "dexl-free", operator: "dexl.io", tier: "cheap", attested: false },
        { id: "dexl-deepseek", model: "deepseek-v4-flash", operator: "dexl.io", tier: "standard", attested: false },
        { id: "synthora-fast", model: "fast", operator: "hergertsynthora.com", tier: "cheap", attested: false },
        { id: "unykorn-llm", model: "default", operator: "unykorn.org", tier: "cheap", attested: false },
      ],
      creationFeeUsdg: "75000000",
      social: { postsPerDay: 4, repliesPerDay: 4 },
      chatTier: "cheap",
    });
    expect(r.body.composeVersion).toBe("v0.1.6");
    expect(r.body.rubricVersion).toBe("v1");
    expect((await call(w, "POST", "/api/launch/template", {})).status).toBe(405);
    expect((await call(w, "GET", "/api/launch/prepare")).status).toBe(405);
    expect((await call(w, "GET", "/nope")).status).toBe(404);
    const o = await call(w, "OPTIONS", "/api/launch/prepare");
    expect(o.status).toBe(204);
    expect(o.res.headers["access-control-allow-headers"]).toBe("content-type");
  });

  it("M4B §2: platform builder — per-agent keys stripped, manifest addresses overlay .rh, missing required keys / invalid template allowlist refused", () => {
    const seven = JSON.parse(readFileSync(join(REPO, "genesis", "e2e", "agent-7.json"), "utf8")) as { platform: Record<string, any> };
    expect(seven.platform.agentTokenAddress).toBeDefined();
    const tampered = JSON.parse(JSON.stringify(seven));
    tampered.platform.registry.rh = "0x0000000000000000000000000000000000000001";
    tampered.platform.swapRouter = { rh: "0x0000000000000000000000000000000000000002" };
    const p = buildPlatform({ template: tampered, contracts: { registry: REGISTRY, usdg: USDG }, manifest: readManifestAddrs(MANIFEST), allowlist: null }) as Record<string, any>;
    expect(p.agentTokenAddress).toBeUndefined();
    expect(p.agentPoolId).toBeUndefined();
    expect(p.registry).toEqual({ ...seven.platform.registry, rh: REGISTRY });
    expect(p.swapRouter).toEqual({ rh: "0xb37851154a9645719B7F83E469918347D7C736A7" });
    expect(p.feeSplitHook.rh).toBe("0x40053E41fa0Bcdcd2EB127954Ce624323e9aa044");
    expect(p.chainIds).toEqual({ rh: 46630 });
    const noCaps = JSON.parse(JSON.stringify(seven));
    delete noCaps.platform.caps;
    expect(() => buildPlatform({ template: noCaps, contracts: { registry: REGISTRY, usdg: USDG }, manifest: null, allowlist: null })).toThrow(/caps/);
    const badList = JSON.parse(JSON.stringify(seven));
    badList.platform.x402Allowlist[0].payTo = "TO-VERIFY";
    expect(() => buildPlatform({ template: badList, contracts: { registry: REGISTRY, usdg: USDG }, manifest: null, allowlist: null })).toThrow(/invalid entries/);
    expect(() => buildPlatform({ template: { agent: {} }, contracts: { registry: REGISTRY, usdg: USDG }, manifest: null, allowlist: null })).toThrow(/platform/);
  });

  it("M4B §2: allowlistPath — the committed draft: `_` keys stripped, an unverified payTo entry DROPPED (reported), the rest replace x402Allowlist", () => {
    const draft = JSON.parse(readFileSync(join(REPO, "genesis", "e2e", "allowlist-live-draft.json"), "utf8"));
    const { entries, dropped } = parseAllowlistFile(draft);
    expect(entries.map((e) => e.id)).toEqual(["synthora-fast", "synthora-smart", "x402farm-llm", "venice-reserve"]);
    expect(entries.every((e) => !Object.keys(e).some((k) => k.startsWith("_")))).toBe(true);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatch(/^dexl-deepseek-flash: payTo/);
    const p = buildPlatform({ template: AGENT8, contracts: { registry: REGISTRY, usdg: USDG }, manifest: null, allowlist: entries });
    expect((p.x402Allowlist as unknown[]).length).toBe(4);
    expect(() => buildPlatform({ template: AGENT8, contracts: { registry: REGISTRY, usdg: USDG }, manifest: null, allowlist: [] })).toThrow(/no valid entries/);
    expect(() => parseAllowlistFile({ nope: 1 })).toThrow();
  });

  it("M4B §2: composeVersion from the release record (cross-checked) or the compose file stem", () => {
    const rel = JSON.parse(readFileSync(join(REPO, "runtime", "releases", "v0.1.6.json"), "utf8"));
    expect(composeVersionOf(COMPOSE, rel, { arch: "arm64", preset: "blue" })).toBe("v0.1.6");
    expect(composeVersionOf(COMPOSE, undefined, { arch: "arm64", preset: "blue" })).toBe("v0.1.6");
    expect(() => composeVersionOf(join(REPO, "runtime", "releases", "v0.1.5.yml"), rel, { arch: "arm64", preset: "blue" })).toThrow(/composeFile/);
    expect(() => composeVersionOf(COMPOSE, rel, { arch: "amd64", preset: "blue" })).toThrow(/arch/);
  });
});

describe("M4B §2: prepare", () => {
  it("M4B §2: happy path — golden configHash (= on-chain agent 8 = runtime canonicalEncode+keccak of the same json), imageId via Exec, EOAs via signed KMS answers", async () => {
    const w = world();
    const r = await call(w, "POST", "/api/launch/prepare", AGENT8_BODY);
    expect(r.status).toBe(200);
    // The frozen agent.json is byte-for-byte (canonically) agent 8's.
    expect(r.body.agentJson).toEqual(AGENT8);
    expect(r.body.agentId).toBe(8);
    expect(r.body.configHash).toBe(CFG8);
    expect(r.body.configHash).toBe(RELEASE.configHashes["8"]);
    expect(r.body.configHash).toBe(keccak256(stringToBytes(canonicalEncode(r.body.agentJson))));
    expect(r.body.configHash).toBe(frozenConfigHash(AGENT8));
    expect(r.body.imageId).toBe(IMAGE8);
    expect(r.body.imageId).toBe(RELEASE.imageIds["8"]);
    expect(r.body).toMatchObject({
      predicted: true,
      expectedTreasuryEOA: TREASURY8,
      actionEOA: ACTION8,
      createArgs: { factory: FACTORY, usdg: USDG, fee: "75000000" },
      composeVersion: "v0.1.6",
      rubricVersion: "v1",
    });
    expect(r.body.note).toMatch(/AgentRequested/);
    // compute-image-id argv: exactly the oyster.ts (≡ runtime/scripts/compute-image-id.sh) form.
    expect(w.exec.calls).toEqual([{ bin: "/tmp/bin/oyster-cvm", args: computeImageIdArgs(OYSTER, { composePath: COMPOSE, agentId: 8, configHash: CFG8 }) }]);
    // KMS: the oyster-cvm kms-derive request shape, one per EOA.
    expect(w.kmsHttp.urls).toEqual([
      `http://image-v4.kms.box:1101/derive/secp256k1/address/ethereum?image_id=${IMAGE8}&path=treasury`,
      `http://image-v4.kms.box:1101/derive/secp256k1/address/ethereum?image_id=${IMAGE8}&path=action`,
    ]);
    expect(w.rejections).toEqual([]);
  });

  it("M4B §2: chatTier defaults to cheap; agentId = agentCount()+1 at prepare time", async () => {
    const w = world();
    w.factory.count = 41n;
    w.exec.result = () => ({ code: 0, stdout: `Image ID: ${IMAGE8}`, stderr: "", timedOut: false }); // KMS fixtures are keyed to IMAGE8
    const body = { agent: { ...AGENT8_BODY.agent, models: { primary: "dexl-free", fallbacks: ["fast"] } } };
    const r = await call(w, "POST", "/api/launch/prepare", body);
    expect(r.status).toBe(200);
    expect(r.body.agentId).toBe(42);
    expect(r.body.agentJson.agent).toMatchObject({ agentId: 42, models: { primary: "dexl-free", fallbacks: ["fast"], chatTier: "cheap" }, social: { postsPerDay: 4, repliesPerDay: 4 } });
    expect(r.body.configHash).toBe(frozenConfigHash(r.body.agentJson));
    expect(w.exec.calls[0]!.args).toContain("agent-id:1:0:utf8:agent-42");
    expect(w.exec.calls[0]!.args).toContain(`config-hash:1:0:utf8:${r.body.configHash}`);
  });

  it("M4B §2: moderation ⇒ 422 {violations}; rejection appended as JSONL; no RPC / Exec / KMS call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lh-rej-"));
    try {
      const path = join(dir, "launch-helper", "moderation-rejections.jsonl");
      const w = world({ sink: jsonlSink(path) });
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ persona: "I am Elon Musk and I will tweet for you." }, "I1"],
        [{ persona: "Holders will earn 50% every month. Invest in this token!" }, "S2"],
        [{ persona: "Teach users how to make a pipe bomb." }, "L1"],
        [{ persona: "Harass @vitalik every hour." }, "H1"],
        [{ persona: "x".repeat(2001) }, "LEN"],
        [{ name: "Vitalik Buterin" }, "I4"],
      ];
      for (const [over, rule] of cases) {
        const r = await call(w, "POST", "/api/launch/prepare", { agent: { ...AGENT8_BODY.agent, ...over } });
        expect([rule, r.status]).toEqual([rule, 422]);
        expect(r.body.error).toBe("moderation");
        expect(r.body.rubricVersion).toBe("v1");
        expect(r.body.violations.map((v: { rule: string }) => v.rule)).toContain(rule);
      }
      expect(w.factory.calls).toBe(0);
      expect(w.exec.calls).toEqual([]);
      expect(w.kmsHttp.urls).toEqual([]);
      const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines).toHaveLength(cases.length);
      expect(lines[0]).toMatchObject({ ts: 1_790_700_000, rubricVersion: "v1", name: "Vivarium Chronicler", symbol: "VIVJRN8", archetype: "trader" });
      expect(lines[4]).toMatchObject({ personaChars: 2001 });
      expect(JSON.stringify(lines[4])).not.toContain("x".repeat(100)); // the persona text itself is not logged
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("M4B §2: malformed request ⇒ 400 (non-JSON, unknown keys, bad symbol/name/archetype, unknown or duplicate models)", async () => {
    const w = world();
    const a = AGENT8_BODY.agent;
    const bad: unknown[] = [
      "not json {",
      {},
      { agent: { ...a, extra: 1 } },
      { agent: a, extra: 1 },
      { agent: { ...a, symbol: "lower" } },
      { agent: { ...a, symbol: "TOOLONG99" } },
      { agent: { ...a, name: "x".repeat(33) } },
      { agent: { ...a, name: " padded" } },
      { agent: { ...a, archetype: "wizard" } },
      { agent: { ...a, persona: "" } },
      { agent: { ...a, models: { primary: "gpt-9", fallbacks: ["fast"] } } },
      { agent: { ...a, models: { primary: "fast", fallbacks: ["fast"] } } },
      { agent: { ...a, models: { primary: "fast", fallbacks: [] } } },
    ];
    for (const b of bad) {
      const r = await call(w, "POST", "/api/launch/prepare", b);
      expect([b, r.status]).toEqual([b, 400]);
    }
    expect(w.factory.calls).toBe(0);
    expect(w.exec.calls).toEqual([]);
  });

  it("M4B §2: KMS failure ⇒ 502 with reason, never a partial prediction (HTTP error, no/forged signature, tampered body, transport, action fails after treasury)", async () => {
    const forged = { status: 200, text: KMS_LIVE.treasury!.body, headers: { "x-marlin-kms-signature": KMS_LIVE.action!.sig } };
    const tampered = { status: 200, text: "0x0000000000000000000000000000000000000bad", headers: { "x-marlin-kms-signature": KMS_LIVE.treasury!.sig } };
    const cases: Array<[string, (path: string) => HttpResponse | Error | null, RegExp]> = [
      ["HTTP 500", () => ({ status: 500, text: "boom", headers: {} }), /HTTP 500/],
      ["no signature header", (p) => ({ status: 200, text: KMS_LIVE[p]!.body, headers: {} }), /no x-marlin-kms-signature/],
      ["forged signature", (p) => (p === "treasury" ? forged : null), /signature does not verify/],
      ["tampered body", (p) => (p === "treasury" ? tampered : null), /signature does not verify/],
      ["transport", () => new Error("ECONNREFUSED"), /ECONNREFUSED/],
      ["action fails after treasury", (p) => (p === "action" ? { status: 503, text: "", headers: {} } : null), /kms-derive action: HTTP 503/],
    ];
    for (const [name, override, reason] of cases) {
      const w = world();
      w.kmsHttp.override = override;
      const r = await call(w, "POST", "/api/launch/prepare", AGENT8_BODY);
      expect([name, r.status]).toEqual([name, 502]);
      expect(r.body.error).toBe("upstream failure");
      expect(r.body.stage).toBe("kms-derive");
      expect(r.body.reason).toMatch(reason);
      expect(Object.keys(r.body).sort()).toEqual(["error", "reason", "stage"]); // no agentJson / configHash / EOAs
      expect(w.log.lines.some((l) => l.startsWith("WARN launch-helper: prepare FAILED at kms-derive"))).toBe(true);
    }
  });

  it("M4B §2: Exec (compute-image-id) failure ⇒ 502 with reason, KMS never called; RPC failure ⇒ 502 before Exec", async () => {
    const execFails: Array<[string, ExecResult]> = [
      ["non-zero exit", { code: 1, stdout: "", stderr: "error: docker-compose not found", timedOut: false }],
      ["timed out", { code: null, stdout: "", stderr: "", timedOut: true }],
      ["no Image ID line", { code: 0, stdout: "all good", stderr: "", timedOut: false }],
    ];
    for (const [name, res] of execFails) {
      const w = world();
      w.exec.result = () => res;
      const r = await call(w, "POST", "/api/launch/prepare", AGENT8_BODY);
      expect([name, r.status, r.body.stage]).toEqual([name, 502, "compute-image-id"]);
      expect(r.body.reason).toMatch(/compute-image-id failed/);
      expect(Object.keys(r.body).sort()).toEqual(["error", "reason", "stage"]);
      expect(w.kmsHttp.urls).toEqual([]);
    }
    const w = world();
    w.factory.count = new Error("RPC timeout");
    const r = await call(w, "POST", "/api/launch/prepare", AGENT8_BODY);
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "upstream failure", stage: "rpc", reason: "RPC timeout" });
    expect(w.exec.calls).toEqual([]);
  });
});

describe("M4B §2: KMS derive client", () => {
  it("M4B §2: request path+query and signature verification against the real captured agent-8 answers", async () => {
    expect(kmsDerivePathAndQuery(IMAGE8, "treasury")).toBe(`/derive/secp256k1/address/ethereum?image_id=${IMAGE8}&path=treasury`);
    expect(() => kmsDerivePathAndQuery(`0x${IMAGE8}`, "treasury")).toThrow(/image id/);
    expect(() => kmsDerivePathAndQuery(IMAGE8, "tre&asury")).toThrow(/path/);
    for (const p of ["treasury", "action"] as const) {
      const pq = kmsDerivePathAndQuery(IMAGE8, p);
      expect(await verifyKmsSignature(pq, KMS_LIVE[p]!.body, KMS_LIVE[p]!.sig, KMS_VERIFICATION_KEY_DEFAULT)).toBe(true);
      expect(await verifyKmsSignature(pq, KMS_LIVE[p]!.body, KMS_LIVE[p]!.sig, "ab".repeat(64))).toBe(false);
      expect(await verifyKmsSignature(pq.replace("path=", "path=x"), KMS_LIVE[p]!.body, KMS_LIVE[p]!.sig, KMS_VERIFICATION_KEY_DEFAULT)).toBe(false);
      expect(await verifyKmsSignature(pq, KMS_LIVE[p]!.body, "zz", KMS_VERIFICATION_KEY_DEFAULT)).toBe(false);
    }
    const http = new MockKmsHttp();
    const kms = new PublicKmsDeriver("http://image-v4.kms.box:1101/", KMS_VERIFICATION_KEY_DEFAULT, http, 1000);
    expect(await kms.deriveAddress(IMAGE8, "treasury")).toBe(TREASURY8);
    expect(() => new PublicKmsDeriver("http://kms.example/prefix", KMS_VERIFICATION_KEY_DEFAULT, http, 1000)).toThrow(/origin/);
    expect(() => new PublicKmsDeriver("http://kms.example", "00", http, 1000)).toThrow(/128 hex/);
  });
});

describe("M4B §2: server + config", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0)) await c();
  });

  it("M4B §2: node:http listener (bin/launch-helper.ts) — real http GET/POST/OPTIONS, 413 on an oversize body", async () => {
    const w = world();
    const server: Server = await startLaunchHelperServer(w.helper, 0, "127.0.0.1", w.log);
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const t = await fetch(`${base}/api/launch/template`);
    expect(t.status).toBe(200);
    expect(t.headers.get("access-control-allow-origin")).toBe("*");
    expect(((await t.json()) as { composeVersion: string }).composeVersion).toBe("v0.1.6");
    const p = await fetch(`${base}/api/launch/prepare`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(AGENT8_BODY) });
    expect(p.status).toBe(200);
    expect(((await p.json()) as { configHash: string }).configHash).toBe(CFG8);
    const o = await fetch(`${base}/api/launch/prepare`, { method: "OPTIONS" });
    expect(o.status).toBe(204);
    const big = await fetch(`${base}/api/launch/prepare`, { method: "POST", body: "x".repeat(70 * 1024) });
    expect(big.status).toBe(413);
  });

  it("M4B §2: config launchHelper section — DEFAULTs + path resolution; the committed testnet config wires a helper whose template is agent 8's platform (no key read, no network)", async () => {
    const cfg = loadConfig(join(REPO, "genesis", "e2e", "genesis.testnet.json"));
    const lh = cfg.launchHelper!;
    // The committed e2e config moved to v0.1.7 in 9b2e137 (stranger-launch rehearsal); SPEC-M4F adds genesisDb + revivalPayTo.
    expect(lh).toMatchObject({
      port: 8426,
      host: "127.0.0.1",
      corsOrigin: "*",
      composePath: join(REPO, "runtime", "releases", "v0.1.7.yml"),
      kmsEndpoint: "http://image-v4.kms.box:1101",
      kmsVerificationKey: KMS_VERIFICATION_KEY_DEFAULT,
      oysterBin: "/tmp/bin/oyster-cvm",
      releasesTemplate: join(REPO, "runtime", "releases", "v0.1.7.json"),
      genesisDb: join(REPO, "genesis", "e2e", "data", "genesis.sqlite"),
      revivalPayTo: "0x6930FD5C95a2D9d80F3d165597d55843e8A00154",
      platformTemplate: join(REPO, "genesis", "e2e", "platform-template.testnet.json"),
      deploymentManifestPath: MANIFEST,
      httpTimeoutSec: 20,
    });
    const { helper } = createLaunchHelper(cfg, memoryLogger(), { factory: { agentCount: async () => 7n } });
    const tpl = helper.template() as { platform: unknown; composeVersion: string };
    expect(tpl.composeVersion).toBe("v0.1.7");
    // SPEC-M4D §3: the template = agent 8's platform + agentDnsRoot (golden still anchored on agent 8).
    expect(tpl.platform).toEqual({ ...AGENT8.platform, agentDnsRoot: "vivarium.systems" });
    const { agentDnsRoot: _dnsRoot, ...platform8Only } = tpl.platform as Record<string, unknown>;
    expect(frozenConfigHash({ platform: platform8Only, agent: AGENT8.agent })).toBe(CFG8);

    // Section optional; DEFAULTs fill from the rest of the config.
    const d = mkdtempSync(join(tmpdir(), "lh-cfg-"));
    cleanup.push(async () => rmSync(d, { recursive: true, force: true }));
    const base = {
      dataDir: "data",
      walletKeyPath: "never-read.key",
      deploymentManifest: MANIFEST,
      chains: { rh: { rpc: "https://rpc.example", chainId: 46630, maxFeePerGasWei: "1", maxPriorityFeePerGasWei: "0" }, arbitrum: { rpc: "https://rpc.example", chainId: 42161, maxFeePerGasWei: "1", maxPriorityFeePerGasWei: "0" } },
      release: { composePath: COMPOSE },
      configInboxDir: "inbox",
    };
    expect(buildConfig(base, d).launchHelper).toBeUndefined();
    const c = buildConfig({ ...base, launchHelper: { platformTemplate: "tpl.json" } }, d).launchHelper!;
    expect(c).toMatchObject({ port: 8426, composePath: COMPOSE, oysterBin: "oyster-cvm", platformTemplate: join(d, "tpl.json") });
    expect(c.releasesTemplate).toBeUndefined();
    expect(() => buildConfig({ ...base, launchHelper: { platformTemplate: "t", walletKeyPath: "k" } }, d)).toThrow();
    expect(() => buildConfig({ ...base, launchHelper: {} }, d)).toThrow();
    expect(() => buildConfig({ ...base, launchHelper: { platformTemplate: "t", composePath: join(REPO, "runtime", "docker-compose.oyster.yml") } }, d)).toThrow(/template/);
  });

  it("M4B §2: secret-free by construction — launch-helper sources never import the wallet/keyfile, signing, or tx paths", () => {
    const files = ["src/launchHelper.ts", "src/kmsDerive.ts", "src/moderation.ts", "bin/launch-helper.ts"].map((f) => [f, readFileSync(join(here, "..", f), "utf8")] as const);
    for (const [f, src] of files) {
      expect([f, /from\s+["']\.\.?\/(?:src\/)?(?:keyfile|machine|seeder|orchestrator|revival|chain)\.js["']/.test(src)]).toEqual([f, false]);
      expect([f, /walletKeyPath\b(?!\s*is never)/.test(src.replace(/\/\/.*$/gm, ""))]).toEqual([f, false]);
      expect([f, /privateKeyToAccount|signTransaction|sendTransaction|writeContract/.test(src)]).toEqual([f, false]);
    }
  });
});

// ---------------------------------------------------------------------------
// SPEC-M4E §1b — prepare's agentJsonText + POST /api/launch/publish
// ---------------------------------------------------------------------------

const AGENT8_TEXT = readFileSync(join(here, "fixtures", "agent-8.json"), "utf8");

function mockPublisher(): { publisher: NonNullable<LaunchHelperDeps["publisher"]>; uploads: Array<{ data: Uint8Array; tags: readonly { name: string; value: string }[] }>; lines: Array<Record<string, unknown>>; fail: Error | null } {
  const st = { uploads: [] as Array<{ data: Uint8Array; tags: readonly { name: string; value: string }[] }>, lines: [] as Array<Record<string, unknown>>, fail: null as Error | null };
  return Object.assign(st, {
    publisher: {
      uploader: {
        upload: async (data: Uint8Array, tags: readonly { name: string; value: string }[]) => {
          st.uploads.push({ data, tags });
          if (st.fail !== null) throw st.fail;
          return { id: "T".repeat(43) };
        },
      },
      log: (e: Record<string, unknown>) => {
        st.lines.push(e);
      },
    },
  });
}

describe("M4E §1b: prepare agentJsonText + publish endpoint", () => {
  it("M4E §1: prepare returns agentJsonText whose frozenConfigHash equals the returned configHash (golden agent 8)", async () => {
    const w = world();
    const r = await call(w, "POST", "/api/launch/prepare", AGENT8_BODY);
    expect(r.status).toBe(200);
    expect(typeof r.body.agentJsonText).toBe("string");
    const parsed = JSON.parse(r.body.agentJsonText as string) as { platform: unknown; agent: unknown };
    expect(parsed).toEqual(r.body.agentJson);
    expect(frozenConfigHash(parsed).toLowerCase()).toBe(r.body.configHash);
    expect(r.body.configHash).toBe(CFG8);
    // Round trip: the exact text publish would upload re-hashes to the same value.
    const p = mockPublisher();
    const w2 = world({ publisher: p.publisher });
    const pub = await call(w2, "POST", "/api/launch/publish", { agentJsonText: r.body.agentJsonText, configHash: r.body.configHash });
    expect(pub.status).toBe(200);
    expect(pub.body.configHash).toBe(CFG8);
    expect(new TextDecoder().decode(p.uploads[0]!.data)).toBe(r.body.agentJsonText);
  });

  it("M4E §1: launch-helper publish endpoint status matrix — 200 / 400 / 405 / 413 / 422 (schema, hash mismatch, moderation) / 502 / 503; one JSONL line per upload attempt", async () => {
    const p = mockPublisher();
    const w = world({ publisher: p.publisher });

    // 200: exact bytes uploaded, §1a tags, {txId, ref, configHash}.
    const ok = await call(w, "POST", "/api/launch/publish", { agentJsonText: AGENT8_TEXT });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ txId: "T".repeat(43), ref: `ar://${"T".repeat(43)}`, configHash: CFG8 });
    expect(ok.res.headers["access-control-allow-origin"]).toBe("*");
    expect(Buffer.from(p.uploads[0]!.data).equals(Buffer.from(AGENT8_TEXT, "utf8"))).toBe(true);
    expect(p.uploads[0]!.tags).toEqual([
      { name: "App", value: "agent-launchpad" },
      { name: "Kind", value: "config" },
      { name: "ConfigHash", value: CFG8 },
      { name: "Timestamp", value: "1790700000" },
    ]);
    expect(p.lines).toEqual([{ ts: 1_790_700_000, ok: true, configHash: CFG8, agentId: 8, bytes: Buffer.byteLength(AGENT8_TEXT), txId: "T".repeat(43) }]);
    expect((await call(w, "POST", "/api/launch/publish", { agentJsonText: AGENT8_TEXT, configHash: CFG8.toUpperCase().replace("0X", "0x") })).status).toBe(200);

    // 400: malformed body — non-JSON, object form (ruling: text ONLY), unknown keys, missing text.
    for (const body of ["{", { agentJson: JSON.parse(AGENT8_TEXT) }, { agentJsonText: AGENT8_TEXT, extra: 1 }, {}, { agentJsonText: 5 }, { agentJsonText: AGENT8_TEXT, configHash: "0x12" }]) {
      expect([body, (await call(w, "POST", "/api/launch/publish", body)).status]).toEqual([body, 400]);
    }
    expect((await call(w, "GET", "/api/launch/publish")).status).toBe(405);

    // 413: over the free-upload limit (checked before any upload).
    const big = await call(w, "POST", "/api/launch/publish", { agentJsonText: JSON.stringify({ platform: { pad: "x".repeat(100 * 1024) }, agent: {} }) });
    expect(big.status).toBe(413);
    expect(big.body.maxBytes).toBeLessThan(100 * 1024);

    // 422: not JSON / not exactly {platform, agent} / hash mismatch / agent shape / moderation.
    const u422 = async (body: unknown): Promise<string> => {
      const r = await call(w, "POST", "/api/launch/publish", body);
      expect(r.status).toBe(422);
      return r.body.error as string;
    };
    expect(await u422({ agentJsonText: "not json" })).toBe("config_invalid");
    expect(await u422({ agentJsonText: JSON.stringify({ platform: {}, agent: {}, runtime: {} }) })).toBe("config_invalid");
    expect(await u422({ agentJsonText: AGENT8_TEXT, configHash: `0x${"ab".repeat(32)}` })).toBe("config_hash_mismatch");
    expect(await u422({ agentJsonText: JSON.stringify({ platform: {}, agent: { name: 1 } }) })).toBe("config_invalid");
    const bad = JSON.parse(AGENT8_TEXT) as { platform: unknown; agent: Record<string, unknown> };
    bad.agent.persona = "Holders will earn 50% every month. Invest in this token!";
    expect(await u422({ agentJsonText: JSON.stringify(bad, null, 2) })).toBe("moderation");
    expect(w.rejections).toHaveLength(1);
    expect(p.uploads).toHaveLength(2); // nothing uploaded for any 4xx

    // 502: upload failure (reason surfaced, JSONL ok:false).
    p.fail = new Error("turbo: upload: HTTP 402");
    const up = await call(w, "POST", "/api/launch/publish", { agentJsonText: AGENT8_TEXT });
    expect(up.status).toBe(502);
    expect(up.body).toEqual({ error: "upstream failure", stage: "arweave-upload", reason: "turbo: upload: HTTP 402" });
    expect(p.lines.at(-1)).toMatchObject({ ok: false, configHash: CFG8, agentId: 8, reason: "turbo: upload: HTTP 402" });
    expect(p.lines).toHaveLength(3);

    // 503: a helper without a publisher.
    expect((await call(world(), "POST", "/api/launch/publish", { agentJsonText: AGENT8_TEXT })).status).toBe(503);
  });

  it("M4E §1: node:http listener — /publish takes a body above the 64 KiB prepare cap (text limit enforced by the handler), prepare keeps its cap; createLaunchHelper wires an ephemeral publisher + publishes.jsonl", async () => {
    const p = mockPublisher();
    const w = world({ publisher: p.publisher });
    const server: Server = await startLaunchHelperServer(w.helper, 0, "127.0.0.1", w.log);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const text = JSON.stringify({ platform: { pad: "z".repeat(90 * 1024) }, agent: { agentId: 99, name: "Pad", persona: "A padded but harmless persona." } });
      const r = await fetch(`${base}/api/launch/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentJsonText: text }) });
      expect(r.status).toBe(200);
      expect(new TextDecoder().decode(p.uploads[0]!.data)).toBe(text);
      const tooBig = await fetch(`${base}/api/launch/publish`, { method: "POST", body: "x".repeat(300 * 1024) });
      expect(tooBig.status).toBe(413);
      const prep = await fetch(`${base}/api/launch/prepare`, { method: "POST", body: "x".repeat(70 * 1024) });
      expect(prep.status).toBe(413);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    const cfg = loadConfig(join(REPO, "genesis", "e2e", "genesis.testnet.json"));
    const d = mkdtempSync(join(tmpdir(), "lh-pub-"));
    try {
      const up = mockPublisher();
      const { helper } = createLaunchHelper({ ...cfg, dataDir: d }, memoryLogger(), { factory: { agentCount: async () => 7n }, uploader: up.publisher.uploader, clock: { now: () => 5n } });
      const res = await helper.handle({ method: "POST", url: "/api/launch/publish", body: JSON.stringify({ agentJsonText: AGENT8_TEXT }) });
      expect(res.status).toBe(200);
      const lines = readFileSync(join(d, "launch-helper", "publishes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines).toEqual([{ ts: 5, ok: true, configHash: CFG8, agentId: 8, bytes: Buffer.byteLength(AGENT8_TEXT), txId: "T".repeat(43) }]);
      // Default wiring (no injected uploader): a publisher exists — no key file, no config secret.
      const { helper: h2 } = createLaunchHelper({ ...cfg, dataDir: d }, memoryLogger(), { factory: { agentCount: async () => 7n } });
      const r2 = await h2.handle({ method: "POST", url: "/api/launch/publish", body: JSON.stringify({ agentJsonText: "nope" }) });
      expect(r2.status).toBe(422);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
