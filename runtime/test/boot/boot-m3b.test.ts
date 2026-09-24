// SPEC-M3B §2/§3 boot wiring: runtime.tls (in-enclave ACME, acme-client mocked at the module seam)
// and runtime.arweave (TurboUploader mocked). Both DEFAULT off — the legacy suites cover that path.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot, type BootLogger, type BootOverrides, type Runtime, type TimerApi } from "../../src/boot.js";
import type { BalanceReader, Holdings } from "../../src/chat/gate.js";
import { frozenConfigHash } from "../../src/config/schema.js";
import { parseDataItem, verifyDataItem, ownerAddress } from "../../src/attestation/ans104.js";
import { verifyAttestationResponse } from "../../src/attestation/attestation.js";
import { MockChainClient } from "../../src/exec/chain.js";
import { createKeyring } from "../../src/keyring/keyring.js";
import type { KmsClient } from "../../src/keyring/kms.js";
import { MockKms } from "../../src/keyring/mockKms.js";
import { TLS_CERT_FILE, TLS_KEY_FILE } from "../../src/tls/server.js";
import { NOW } from "../policy/helpers.js";
import { MockNautilusServer } from "../attestation/mockNautilus.js";
import { MockTurbo } from "../attestation/mockTurbo.js";
import { DAY, fakeAcme, type FakeAcme } from "../tls/helpers.js";

const FIXTURE = join(__dirname, "fixtures", "runtime.config.json");
const DNS_ROOT = "agents.example.test";
const DOMAIN = `a1.${DNS_ROOT}`; // fixture agentId = 1

const dirs: string[] = [];
const runtimes: Runtime[] = [];
const servers: MockNautilusServer[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.stop().catch(() => undefined);
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "al-boot3b-"));
  dirs.push(d);
  return d;
}

class FakeTimers implements TimerApi {
  pending = new Map<number, { fn: () => void; ms: number }>();
  private n = 0;
  set(fn: () => void, ms: number): unknown {
    this.pending.set(++this.n, { fn, ms });
    return this.n;
  }
  clear(h: unknown): void {
    this.pending.delete(h as number);
  }
}

const quiet: BootLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const holder: BalanceReader = { holdings: async (): Promise<Holdings> => ({ agentBal: 10n, agentSupply: 1_000n, platformBal: 0n, platformSupply: 1n }) };

/** Fixture config + platform/runtime extras (legacy single-file layout). */
function config(dir: string, platform: Record<string, unknown>, runtime: Record<string, unknown>, name = "m3b.config.json"): string {
  const j = JSON.parse(readFileSync(FIXTURE, "utf8")) as { platform: Record<string, unknown>; runtime: Record<string, unknown> };
  Object.assign(j.platform, platform);
  Object.assign(j.runtime, runtime);
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(j));
  return p;
}

interface BootArgs {
  dir: string;
  configPath: string;
  acme?: FakeAcme;
  turbo?: MockTurbo;
  kms?: KmsClient;
  initParamsDir?: string;
  overrides?: Partial<BootOverrides>;
}

async function bootIt(a: BootArgs): Promise<Runtime> {
  mkdirSync(join(a.dir, "data"), { recursive: true }); // the image's /data
  const rt = await boot({
    configPath: a.configPath,
    dbPath: join(a.dir, "data", "agent.db"),
    snapshotDir: join(a.dir, "snapshots"),
    clock: () => NOW,
    kmsRetry: { attempts: 2, delayMs: 1 },
    ...(a.kms !== undefined ? { kms: a.kms } : {}),
    ...(a.initParamsDir !== undefined ? { initParamsDir: a.initParamsDir } : {}),
    overrides: {
      chain: new MockChainClient({ reads: () => 0n }),
      timers: new FakeTimers(),
      logger: quiet,
      chatPort: 0,
      chatReaders: [holder, holder],
      ...(a.acme !== undefined ? { acme: a.acme } : {}),
      ...(a.turbo !== undefined ? { turboUploader: a.turbo } : {}),
      ...(a.overrides ?? {}),
    },
  });
  runtimes.push(rt);
  return rt;
}

type HttpsBody = Record<string, unknown> & { payload: Record<string, unknown> };
function httpsGet(port: number, path: string): Promise<{ status: number; body: HttpsBody; spki: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: "127.0.0.1", port, path, servername: DOMAIN, rejectUnauthorized: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const cert = (res.socket as TLSSocket).getPeerX509Certificate();
        const spki = `0x${createHash("sha256").update(cert!.publicKey.export({ type: "spki", format: "der" })).digest("hex")}`;
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as HttpsBody, spki });
      });
    });
    req.on("error", reject);
  });
}

const valid90 = () => ({ notBefore: NOW - DAY, notAfter: NOW + 90n * DAY });

// ---------------------------------------------------------------------------

describe("boot: runtime.tls (SPEC-M3B §2)", () => {
  it("tls.enabled without the FROZEN platform.agentDnsRoot ⇒ refuses before the KMS is touched", async () => {
    const dir = tmp();
    const paths: string[] = [];
    const kms: KmsClient = { derive: async (p) => (paths.push(p), new MockKms("i", "a").derive(p)) };
    await expect(bootIt({ dir, kms, configPath: config(dir, { chatDomain: DOMAIN }, { tls: { enabled: true } }) })).rejects.toThrow(/agentDnsRoot/);
    expect(paths).toEqual([]);
  });

  it("tls.enabled without the chat server ⇒ refuses (TLS ingress fronts chat)", async () => {
    const dir = tmp();
    await expect(bootIt({ dir, configPath: config(dir, { agentDnsRoot: DNS_ROOT }, { tls: { enabled: true } }) })).rejects.toThrow(/requires the chat server/);
  });

  it("agentDnsRoot is validated by the frozen schema", async () => {
    const dir = tmp();
    await expect(bootIt({ dir, configPath: config(dir, { agentDnsRoot: "Not A Host" }, {}) })).rejects.toThrow(/lowercase hostname/);
  });

  it("start(): HTTPS on the placeholder, GET /attestation pins it; background first issuance switches to the CA cert (persisted under <db dir>/tls); step 10 wired", async () => {
    const dir = tmp();
    const acme = fakeAcme({ validity: valid90 });
    const rt = await bootIt({ dir, acme, configPath: config(dir, { chatDomain: DOMAIN, agentDnsRoot: DNS_ROOT }, { tls: { enabled: true, acmeDirectoryUrl: "https://acme-staging-v02.api.letsencrypt.org/directory" } }) });
    expect(rt.tls).not.toBeNull();
    expect(rt.tls!.store.domain).toBe(DOMAIN);
    const placeholderSpki = rt.tls!.spkiSha256();
    let release!: () => void;
    acme.gate = new Promise<void>((r) => (release = r)); // hold the first order: observe the placeholder phase
    await rt.start();
    const port = rt.chatAddress()!.port;
    expect(rt.chatAddress()!.host).toBe("0.0.0.0"); // TLS DEFAULT bind (runtime.chatHost unset)

    const a1 = await httpsGet(port, "/attestation");
    expect(a1.status).toBe(200);
    expect(a1.body.payload).toEqual({ report: null, attestationRef: null, certSpkiSha256: placeholderSpki, certKind: "placeholder", domain: DOMAIN, timestamp: NOW.toString(10) });
    expect(a1.spki).toBe(placeholderSpki); // the endpoint pins the cert actually served
    // treasury-signed: a verifier with the on-chain treasury + the SPKI it saw accepts it
    expect(a1.body.signer).toBe(rt.keyring.addresses().treasury);
    expect(await verifyAttestationResponse(a1.body, { expectedTreasury: rt.keyring.addresses().treasury, observedSpkiSha256: a1.spki as Hex, now: NOW })).toMatchObject({ ok: true });

    release();
    await vi.waitFor(() => expect(rt.tls!.store.current().kind).toBe("issued"));
    expect(acme.clients[0]!.directoryUrl).toBe("https://acme-staging-v02.api.letsencrypt.org/directory");
    const a2 = await httpsGet(port, "/attestation");
    expect(a2.body.payload.certKind).toBe("issued");
    expect(a2.spki).toBe(a2.body.payload.certSpkiSha256);
    expect(await verifyAttestationResponse(a2.body, { expectedTreasury: rt.keyring.addresses().treasury, observedSpkiSha256: a2.spki as Hex })).toMatchObject({ ok: true });
    // the OLD response no longer matches the served cert (a replay across rotation is detectable)
    expect(await verifyAttestationResponse(a1.body, { expectedTreasury: rt.keyring.addresses().treasury, observedSpkiSha256: a2.spki as Hex })).toEqual({ ok: false, reason: "spki_mismatch" });
    expect(a2.spki).not.toBe(placeholderSpki);
    expect((await httpsGet(port, "/health")).status).toBe(200);
    for (const f of [TLS_CERT_FILE, TLS_KEY_FILE]) expect(existsSync(join(dir, "data", "tls", f))).toBe(true);

    const tick = await rt.daemonTick();
    expect(tick.steps.at(-1)).toEqual({ step: "tlsRenewal", status: "skipped", reason: "certificate valid for ≥ 30 days" });
  });

  it("restart: persisted cert reloaded (no new order); the placeholder is identical across boots (KMS-derived, deterministic)", async () => {
    const dir = tmp();
    const cfg = config(dir, { chatDomain: DOMAIN, agentDnsRoot: DNS_ROOT }, { tls: { enabled: true } });
    const acme = fakeAcme({ validity: valid90 });
    const rt1 = await bootIt({ dir, acme, configPath: cfg });
    const p1 = rt1.tls!.spkiSha256();
    await rt1.tls!.renew();
    const issued = rt1.tls!.spkiSha256();
    await rt1.stop();

    const rt2 = await bootIt({ dir, acme, configPath: cfg });
    expect(rt2.tls!.store.current().kind).toBe("issued");
    expect(rt2.tls!.spkiSha256()).toBe(issued);
    await rt2.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(acme.orders).toHaveLength(1);

    const other = tmp(); // fresh volume (revival): same KMS ⇒ same placeholder, re-issuance
    const failing = fakeAcme({ validity: valid90, failWith: () => new Error("dns not repointed yet") });
    const rt3 = await bootIt({ dir: other, acme: failing, configPath: config(other, { chatDomain: DOMAIN, agentDnsRoot: DNS_ROOT }, { tls: { enabled: true } }) });
    expect(rt3.tls!.store.current().kind).toBe("placeholder");
    expect(rt3.tls!.spkiSha256()).toBe(p1);
    expect(rt3.tls!.store.current().material).toEqual((await bootIt({ dir: tmp(), acme: failing, configPath: cfg })).tls!.store.current().material);
  });

  it("DEFAULT (tls off): no TLS manager, GET /attestation stays 501 over plain HTTP, no step 10, no TLS derives", async () => {
    const dir = tmp();
    const paths: string[] = [];
    const inner = new MockKms("image-boot", "agent-boot");
    const kms: KmsClient = { derive: async (p) => (paths.push(p), inner.derive(p)) };
    const rt = await bootIt({ dir, kms, configPath: config(dir, { chatDomain: DOMAIN }, {}) });
    expect(rt.tls).toBeNull();
    await rt.start();
    const res = await fetch(`http://127.0.0.1:${rt.chatAddress()!.port}/attestation`);
    expect(res.status).toBe(501);
    expect((await rt.daemonTick()).steps.map((s) => s.step)).not.toContain("tlsRenewal");
    expect(paths).toEqual(["treasury", "action", "fc", "mem", "chat"]);
  });
});

describe("boot: runtime.arweave (SPEC-M3B §3)", () => {
  async function treasury(): Promise<Address> {
    return (await createKeyring(new MockKms("image-boot", "agent-boot"), { retry: { attempts: 1, delayMs: 1 } })).addresses().treasury;
  }

  it("arweave.enabled without an injected uploader ⇒ the in-house TurboHttpUploader (ANS-104, treasury-signed) is wired: boot only probes GraphQL for snapshots; a snapshot POSTs a verifiable data item", async () => {
    const dir = tmp();
    const calls: Array<{ method: string; url: string; ct: string | null; body: Uint8Array | null }> = [];
    const fake = async (input: URL | string, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const body = init?.body instanceof Uint8Array ? init.body : null;
      calls.push({ method: init?.method ?? "GET", url, ct: new Headers(init?.headers).get("content-type"), body });
      if (url === "https://upload.ardrive.io/v1/tx") return new Response(JSON.stringify({ id: parseDataItem(body!).id, owner: "x" }), { status: 200 });
      if (url.startsWith("https://payment.ardrive.io/v1/account/balance/ethereum?address=")) return new Response(JSON.stringify({ winc: "1000000000000000" }), { status: 200 });
      if (url.startsWith("https://payment.ardrive.io/v1/price/bytes/")) return new Response(JSON.stringify({ winc: "1000" }), { status: 200 });
      if (url === "https://arweave.net/graphql") return new Response(JSON.stringify({ data: { transactions: { pageInfo: { hasNextPage: false }, edges: [] } } }), { status: 200 });
      return new Response("nope", { status: 500 });
    };
    vi.stubGlobal("fetch", fake);
    try {
      const logs: string[] = [];
      const rt = await bootIt({ dir, configPath: config(dir, {}, { arweave: { enabled: true } }), overrides: { logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) } } });
      // boot's only network: the fresh-db restore probe (GraphQL list of own snapshots on Arweave)
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://arweave.net/graphql"]);
      expect(logs.join("\n")).toMatch(/uploader https:\/\/upload\.ardrive\.io\/v1\/tx/);
      const tick = await rt.daemonTick();
      const post = calls.find((c) => c.method === "POST" && c.url.includes("upload"))!;
      expect(post.url).toBe("https://upload.ardrive.io/v1/tx");
      expect(post.ct).toBe("application/octet-stream");
      const item = parseDataItem(post.body!);
      expect(tick.snapshotId).toBe(item.id);
      expect(await verifyDataItem(post.body!)).toBe(true);
      expect(ownerAddress(item.owner)).toBe(rt.keyring.addresses().treasury);
      expect(item.tags).toContainEqual({ name: "Kind", value: "snapshot" });
      expect(calls.some((c) => c.url.includes(`address=${rt.keyring.addresses().treasury}`))).toBe(true);
      await rt.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("snapshots go to Turbo (id = txid) AND the local mirror; a fresh enclave restores from Turbo", async () => {
    const turbo = new MockTurbo(await treasury());
    const dir = tmp();
    const rt = await bootIt({ dir, turbo, configPath: config(dir, {}, { arweave: { enabled: true } }) });
    const tick = await rt.daemonTick();
    expect(tick.snapshotId).toMatch(/^tx/);
    expect(turbo.items.get(tick.snapshotId!)!.tags).toContainEqual({ name: "Kind", value: "snapshot" });
    expect(turbo.items.get(tick.snapshotId!)!.tags).toContainEqual({ name: "AgentId", value: "1" });
    expect(readdirSync(join(dir, "snapshots"))).toEqual([`snapshot-${NOW}.bin`]);
    await rt.stop();

    const fresh = tmp(); // revival: new volume, only Arweave remembers
    const rt2 = await bootIt({ dir: fresh, turbo, configPath: config(fresh, {}, { arweave: { enabled: true } }) });
    expect(rt2.restoredFrom).toMatch(/^tx/);
    expect(existsSync(join(fresh, "snapshots"))).toBe(false);
  });

  it("localMirror: false ⇒ Turbo only", async () => {
    const turbo = new MockTurbo(await treasury());
    const dir = tmp();
    const rt = await bootIt({ dir, turbo, configPath: config(dir, {}, { arweave: { enabled: true, localMirror: false } }) });
    expect((await rt.daemonTick()).snapshotId).toMatch(/^tx/);
    expect(existsSync(join(dir, "snapshots"))).toBe(false);
  });

  it("tee + arweave + tls: attestationRef = Turbo txid (registration-ready), local copy kept, GET /attestation serves the exact published report + SPKI", async () => {
    const s = new MockNautilusServer({ seed: "image-a|agent-1" });
    await s.start();
    servers.push(s);
    const IMAGE_ID = `0x${"28e981ac".repeat(8)}` as Hex;
    const dir = tmp();
    const j = JSON.parse(readFileSync(FIXTURE, "utf8")) as { platform: Record<string, unknown>; agent: unknown; runtime: Record<string, unknown> };
    Object.assign(j.platform, { chatDomain: DOMAIN, agentDnsRoot: DNS_ROOT });
    delete j.runtime.mockKms;
    Object.assign(j.runtime, { tee: true, kmsUrl: s.baseUrl, attestationUrl: s.attestationUrl, imageId: IMAGE_ID, arweave: { enabled: true }, tls: { enabled: true }, registrationRetrySec: 0 /* SPEC-M3C §11: one-shot registration here (no real-sleep retries) */ });
    const cfgPath = join(dir, "tee.json");
    writeFileSync(cfgPath, JSON.stringify(j));
    const init = join(dir, "init");
    mkdirSync(init);
    writeFileSync(join(init, "agent-id"), "agent-1");
    writeFileSync(join(init, "config-hash"), frozenConfigHash({ platform: j.platform, agent: j.agent }));

    const probe = await createKeyring(new (await import("../../src/keyring/nautilusKms.js")).NautilusKms(s.baseUrl), { retry: { attempts: 1, delayMs: 1 } });
    const turbo = new MockTurbo(probe.addresses().treasury);
    const acme = fakeAcme({ validity: valid90, failWith: () => new Error("hold: placeholder phase") });
    const rt = await bootIt({ dir, turbo, acme, configPath: cfgPath, initParamsDir: init });
    expect(rt.attestationRef).toMatch(/^tx/);
    expect(rt.cfg.registration).toEqual({ codeHash: IMAGE_ID, attestationRef: rt.attestationRef });
    const item = turbo.items.get(rt.attestationRef!)!;
    expect(item.tags).toContainEqual({ name: "Kind", value: "attestation" });
    expect(readdirSync(join(dir, "attestations"))).toEqual([`attestation-${NOW}.json`]);
    const published = new TextDecoder().decode(item.data);
    expect(readFileSync(join(dir, "attestations", `attestation-${NOW}.json`), "utf8")).toBe(published);
    // the TLS placeholder derive happened lazily AFTER the five boot keys (no ACME derive before issuance)
    expect(s.derivePaths.slice(-6)).toEqual(["treasury", "action", "fc", "mem", "chat", "tls"]);

    await rt.start();
    const a = await httpsGet(rt.chatAddress()!.port, "/attestation");
    expect(a.status).toBe(200);
    expect(a.body.payload.report).toBe(published);
    expect(a.body.payload.attestationRef).toBe(rt.attestationRef);
    expect(a.body.payload.certSpkiSha256).toBe(a.spki);
    expect(await verifyAttestationResponse(a.body, { expectedTreasury: probe.addresses().treasury, observedSpkiSha256: a.spki as Hex, now: NOW })).toMatchObject({ ok: true });
    expect((JSON.parse(published) as { imageId: string }).imageId).toBe(IMAGE_ID);
  });
});
