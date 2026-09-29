import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { IndexerApi } from "../src/api.js";
import { buildConfig, loadConfig } from "../src/config.js";
import { CHECK_NAMES, IndexerDb } from "../src/db.js";
import { HttpArweaveClient } from "../src/enrich.js";
import { memoryLogger, type MemoryLogger } from "../src/log.js";
import { loadReleaseTable, matchRelease, type ReleaseTable } from "../src/releases.js";
import { MAX_REPORT_BYTES, parseReport, Verifier, VERIFY_LAST_RUN_KEY, worstStatus } from "../src/verify.js";
import { REVIVAL_WINDOW_KEY } from "../src/watcher.js";

// ---------------------------------------------------------------------------
// Fixtures: the LIVE agent-8 attestation report (Arweave iCt3c0kz…, fetched 2026-09-29) and the
// committed runtime/releases table. No network: Arweave is a fake behind HttpArweaveClient's fetch.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const RELEASES = resolve(here, "../../runtime/releases");
const REPORT_TEXT = readFileSync(join(here, "fixtures/attestation-report-agent8.json"), "utf8");

const NOW = 1_790_700_000;
const REF8 = "iCt3c0kzoGZRzPfhy8XFae6pjuUVhTgFDrBlMciUUzs";
const TREASURY8 = "0xd7EF592E26936627C2dAD31c08EeD561dB5EeCB8";
const ACTION8 = "0x3c169d57729Bf24bdEA3Ef34f5089BE6234bc9a1";
const CODE8 = "0xf489dc609c6b33a7016c113f0965a46de35c4cfd2ef8e8f4751bd845923a4350";
const CFG8 = "0x06640d641b49e5f0918360fb46ab6d24036b1888d062290d3e46c231243905d2";
const OWNER8 = TREASURY8; // Turbo item signed by the treasury key: GraphQL reports the 0x owner.

interface FakeItem {
  owner: string | null; // null ⇒ GraphQL does not know it
  body: string;
  status?: number;
  redirect?: string;
}

class FakeArweave {
  items = new Map<string, FakeItem>();
  graphqlDown = false;
  gatewayDown = false;
  requests: string[] = [];

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    this.requests.push(`${u.hostname}${u.pathname}`);
    if (u.pathname === "/graphql") {
      if (this.graphqlDown) throw new TypeError("fetch failed (ECONNREFUSED)");
      const ids = (JSON.parse(String(init?.body)) as { variables: { ids: string[] } }).variables.ids;
      const edges = ids.flatMap((id) => {
        const it = this.items.get(id);
        return it === undefined || it.owner === null ? [] : [{ node: { id, owner: { address: it.owner } } }];
      });
      return new Response(JSON.stringify({ data: { transactions: { edges } } }), { status: 200 });
    }
    if (this.gatewayDown) throw new TypeError("fetch failed (ETIMEDOUT)");
    const id = u.pathname.slice(1);
    const it = this.items.get(id);
    if (it === undefined) return new Response("not found", { status: 404 });
    if (u.hostname === "arweave.net" && it.redirect !== undefined) return new Response(null, { status: 302, headers: { location: it.redirect } });
    return new Response(it.body, { status: it.status ?? 200 });
  };
}

interface Setup {
  db: IndexerDb;
  fake: FakeArweave;
  log: MemoryLogger;
  v: Verifier;
}

function seedAgent(db: IndexerDb, o: { agentId?: number; ref?: string | null; treasury?: string; action?: string; codeHash?: string; configHash?: string | null; registeredAt?: number } = {}): number {
  const agentId = o.agentId ?? 8;
  const configHash = o.configHash === undefined ? CFG8 : o.configHash;
  if (configHash !== null) {
    db.upsertAgentRequested({ agentId, configHash, creator: "0xC", requestTx: `0xreq${agentId}`, requestBlock: 10, createdAt: NOW - 7200, name: `A${agentId}`, symbol: `S${agentId}`, imageURI: null });
  } else {
    db.advanceState(agentId, "requested");
  }
  db.upsertInstanceRegistered({
    agentId,
    treasuryEOA: o.treasury ?? TREASURY8,
    actionEOA: o.action ?? ACTION8,
    codeHash: o.codeHash ?? CODE8,
    generation: 1,
    attestationRef: o.ref === undefined ? REF8 : o.ref,
    registeredAt: o.registeredAt ?? NOW - 600,
  });
  return agentId;
}

function setup(opts: { releases?: ReleaseTable | null | "throw"; arweave?: boolean } = {}): Setup {
  const db = new IndexerDb(":memory:");
  const fake = new FakeArweave();
  fake.items.set(REF8, { owner: OWNER8, body: REPORT_TEXT });
  const log = memoryLogger();
  const client = new HttpArweaveClient({ graphqlUrl: "https://arweave.net/graphql", gatewayUrl: "https://arweave.net", fetchImpl: fake.fetch as typeof fetch });
  const table = opts.releases === undefined ? loadReleaseTable(RELEASES, log) : opts.releases;
  const v = new Verifier(
    db,
    opts.arweave === false ? null : client,
    () => {
      if (table === "throw") throw new Error("ENOENT: no such directory");
      return table;
    },
    { now: () => BigInt(NOW) },
    log,
  );
  return { db, fake, log, v };
}

const allPass = Object.fromEntries(CHECK_NAMES.map((k) => [k, "pass"]));

function checks(db: IndexerDb, agentId = 8): Record<string, string> {
  const r = db.attestationChecks(agentId)!;
  return Object.fromEntries(CHECK_NAMES.map((k) => [k, r[k]]));
}

function reasons(db: IndexerDb, agentId = 8): Record<string, string> {
  return (JSON.parse(db.attestationChecks(agentId)!.detail) as { reasons: Record<string, string> }).reasons;
}

function mutateReport(f: (r: Record<string, any>) => void): string {
  const r = JSON.parse(REPORT_TEXT) as Record<string, any>;
  f(r);
  return JSON.stringify(r);
}

// ---------------------------------------------------------------------------
// §1a release table
// ---------------------------------------------------------------------------

describe("M4B §1: release table", () => {
  it("M4B §1: loads every committed v*.json and matches a codeHash 0x-/case-insensitively against ANY release's imageIds", () => {
    const log = memoryLogger();
    const t = loadReleaseTable(RELEASES, log);
    expect(t.releases.map((r) => r.version)).toEqual(["v0.1.0", "v0.1.1", "v0.1.2", "v0.1.3", "v0.1.4", "v0.1.5", "v0.1.6"]);
    expect(log.lines).toEqual([]);
    const hit = { version: "v0.1.6", commit: "3d9455fb69976db448dd1edb6b991843fb604282", agentId: "8" };
    expect(matchRelease(t, CODE8)).toEqual(hit);
    expect(matchRelease(t, CODE8.slice(2))).toEqual(hit);
    expect(matchRelease(t, CODE8.toUpperCase().replace("0X", "0x"))).toEqual(hit);
    expect(matchRelease(t, `0X${CODE8.slice(2).toUpperCase()}`)).toEqual(hit);
    // An older release's entry (v0.1.5, agent 7).
    expect(matchRelease(t, "0xCD5040AED65836D8BF6CA1CFEEABB44DA43475A970946940CF1467F7F108E804")).toMatchObject({ version: "v0.1.5", agentId: "7" });
    expect(matchRelease(t, `0x${"ab".repeat(32)}`)).toBeNull();
    expect(matchRelease(t, "0xc0de")).toBeNull();
  });

  it("M4B §1: a malformed release record is skipped LOUDLY, the rest still load", () => {
    const d = mkdtempSync(join(tmpdir(), "releases-"));
    try {
      writeFileSync(join(d, "v1.0.0.json"), JSON.stringify({ version: "v1.0.0", imageDigest: "sha256:x", imageRef: "r@sha256:x", imageIds: { "1": "aa".repeat(32) }, commit: "c1" }));
      writeFileSync(join(d, "v1.0.1.json"), "{ not json");
      writeFileSync(join(d, "v1.0.2.json"), JSON.stringify({ version: "v1.0.2", imageIds: { "2": "zz" } }));
      writeFileSync(join(d, "notes.json"), "{}");
      const log = memoryLogger();
      const t = loadReleaseTable(d, log);
      expect(t.releases.map((r) => r.version)).toEqual(["v1.0.0"]);
      expect(log.lines.filter((l) => l.startsWith("WARN RELEASES: skipping malformed"))).toHaveLength(2);
      expect(matchRelease(t, `0x${"AA".repeat(32)}`)?.version).toBe("v1.0.0");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// §1b verify pass
// ---------------------------------------------------------------------------

describe("M4B §1: verify pass (mock GraphQL + gateway)", () => {
  it("M4B §1: all-pass fixture — the live agent-8 report against its chain values and releases/v0.1.6", async () => {
    const { db, fake, v, log } = setup();
    seedAgent(db);
    // The gateway 302s to a *.arweave.net sandbox host (one redirect allowed).
    fake.items.get(REF8)!.redirect = `https://sandbox123.arweave.net/${REF8}`;
    expect(await v.runOnce()).toBe(1);
    expect(checks(db)).toEqual(allPass);
    const r = db.attestationChecks(8)!;
    expect(r.releaseVersion).toBe("v0.1.6");
    expect(r.verifiedAt).toBe(NOW);
    const detail = JSON.parse(r.detail);
    expect(detail).toMatchObject({
      reasons: {},
      owner: OWNER8.toLowerCase(), // SPEC-M4A rev 2: 0x-form owners normalized lowercase at the client boundary
      itemBytes: Buffer.byteLength(REPORT_TEXT),
      releaseCommit: "3d9455fb69976db448dd1edb6b991843fb604282",
      report: { treasury: TREASURY8.toLowerCase(), action: ACTION8.toLowerCase(), configHash: CFG8, imageId: CODE8 },
    });
    expect(fake.requests).toContain(`sandbox123.arweave.net/${REF8}`);
    expect(db.kvGet(VERIFY_LAST_RUN_KEY)).toBe(String(NOW));
    expect(log.lines.filter((l) => l.startsWith("WARN"))).toEqual([]);
  });

  const failCases: Array<[string, string, (s: Setup) => void]> = [
    ["eoasMatch", "treasury", (s) => s.fake.items.set(REF8, { owner: OWNER8, body: mutateReport((r) => (r.eoas.treasury = "0x" + "11".repeat(20))) })],
    ["eoasMatch", "action", (s) => s.fake.items.set(REF8, { owner: OWNER8, body: mutateReport((r) => (r.eoas.action = "0x" + "22".repeat(20))) })],
    ["configHashMatch", "configHash", (s) => s.fake.items.set(REF8, { owner: OWNER8, body: mutateReport((r) => (r.configHash = "0x" + "33".repeat(32))) })],
    ["imageIdMatch", "imageId", (s) => s.fake.items.set(REF8, { owner: OWNER8, body: mutateReport((r) => (r.imageId = "0x" + "44".repeat(32))) })],
  ];

  it.each(failCases)("M4B §1: single-check failure isolated — %s (%s)", async (check, _what, mutate) => {
    const s = setup();
    seedAgent(s.db);
    mutate(s);
    await s.v.runOnce();
    expect(checks(s.db)).toEqual({ ...allPass, [check]: "fail" });
    expect(reasons(s.db)[check]).toMatch(/≠/);
    expect(s.log.lines.some((l) => l.startsWith("WARN ATTESTATION CHECK FAILED: agent 8") && l.includes(check))).toBe(true);
  });

  it("M4B §1: single-check failure isolated — releaseMatch (codeHash in no release; report agrees with the chain)", async () => {
    const s = setup();
    const other = `0x${"5a".repeat(32)}`;
    seedAgent(s.db, { codeHash: other });
    s.fake.items.set(REF8, { owner: OWNER8, body: mutateReport((r) => (r.imageId = other)) });
    await s.v.runOnce();
    expect(checks(s.db)).toEqual({ ...allPass, releaseMatch: "fail" });
    expect(s.db.attestationChecks(8)!.releaseVersion).toBeNull();
  });

  it("M4B §1: single-check failure isolated — reportParses (wrong kind / non-JSON / missing field); dependent checks skip, never fail", async () => {
    const bodies = [
      mutateReport((r) => (r.kind = "agent-launchpad/attestation")),
      "not json {",
      mutateReport((r) => delete r.imageId),
      mutateReport((r) => delete r.eoas),
    ];
    for (const body of bodies) {
      const s = setup();
      seedAgent(s.db);
      s.fake.items.set(REF8, { owner: OWNER8, body });
      await s.v.runOnce();
      expect(checks(s.db)).toEqual({ ...allPass, reportParses: "fail", eoasMatch: "skip", configHashMatch: "skip", imageIdMatch: "skip" });
    }
  });

  it("M4B §1: single-check failure isolated — itemFound (item > 256 KiB); report checks skip", async () => {
    const s = setup();
    seedAgent(s.db);
    s.fake.items.set(REF8, { owner: OWNER8, body: "x".repeat(MAX_REPORT_BYTES + 1) });
    await s.v.runOnce();
    expect(checks(s.db)).toEqual({ ...allPass, itemFound: "fail", reportParses: "skip", eoasMatch: "skip", configHashMatch: "skip", imageIdMatch: "skip" });
    // exactly 256 KiB is allowed (then fails to parse — a different check)
    const t = setup();
    seedAgent(t.db);
    t.fake.items.set(REF8, { owner: OWNER8, body: "x".repeat(MAX_REPORT_BYTES) });
    await t.v.runOnce();
    expect(checks(t.db)).toMatchObject({ itemFound: "pass", reportParses: "fail" });
  });

  it("M4B §1: transport error ⇒ pending, never fail (gateway down, GraphQL down, HTTP 5xx, 404, not indexed, bad redirect) + LOUD warn", async () => {
    const scenarios: Array<[string, (s: Setup) => void, string[]]> = [
      ["gateway down", (s) => (s.fake.gatewayDown = true), ["itemFound", "reportParses", "eoasMatch", "configHashMatch", "imageIdMatch"]],
      ["gateway 502", (s) => (s.fake.items.get(REF8)!.status = 502), ["itemFound", "reportParses", "eoasMatch", "configHashMatch", "imageIdMatch"]],
      ["gateway 404", (s) => s.fake.items.delete(REF8), ["itemFound", "reportParses", "eoasMatch", "configHashMatch", "imageIdMatch"]],
      ["redirect off-arweave", (s) => (s.fake.items.get(REF8)!.redirect = `https://evil.example/${REF8}`), ["itemFound", "reportParses", "eoasMatch", "configHashMatch", "imageIdMatch"]],
      ["GraphQL down", (s) => (s.fake.graphqlDown = true), ["itemFound"]],
      ["not indexed by GraphQL yet", (s) => (s.fake.items.get(REF8)!.owner = null), ["itemFound"]],
    ];
    for (const [name, arrange, pending] of scenarios) {
      const s = setup();
      seedAgent(s.db);
      arrange(s);
      await s.v.runOnce();
      const got = checks(s.db);
      expect([name, Object.values(got).includes("fail")]).toEqual([name, false]);
      expect([name, Object.keys(got).filter((k) => got[k] === "pending").sort()]).toEqual([name, [...pending].sort()]);
      expect([name, got.refShape, got.releaseMatch]).toEqual([name, "pass", "pass"]);
      expect([name, s.log.lines.some((l) => l.startsWith("WARN VERIFY: agent 8") && l.includes("PENDING"))]).toEqual([name, true]);
    }
  });

  it("M4B §1: configHashMatch pending (not fail) while the factory configHash is not indexed", async () => {
    const s = setup();
    seedAgent(s.db, { configHash: null });
    await s.v.runOnce();
    expect(checks(s.db)).toEqual({ ...allPass, configHashMatch: "pending" });
  });

  it("M4B §1: drill-style local ref ⇒ refShape skip and every downstream check skip (no fetch)", async () => {
    const s = setup();
    seedAgent(s.db, { agentId: 3, ref: "attestation-1790597593.json" });
    seedAgent(s.db, { agentId: 4, ref: null });
    await s.v.runOnce();
    const skipAll = Object.fromEntries(CHECK_NAMES.map((k) => [k, "skip"]));
    expect(checks(s.db, 3)).toEqual(skipAll);
    expect(checks(s.db, 4)).toEqual(skipAll);
    expect(reasons(s.db, 3).refShape).toBe("local ref (drill): attestation-1790597593.json");
    expect(reasons(s.db, 4).refShape).toBe("no attestationRef registered");
    expect(s.fake.requests).toEqual([]);
  });

  it("M4B §1: no release table ⇒ releaseMatch skip 'no release table'; unreadable ⇒ pending; arweave disabled ⇒ Arweave checks skip", async () => {
    const a = setup({ releases: null });
    seedAgent(a.db);
    await a.v.runOnce();
    expect(checks(a.db)).toEqual({ ...allPass, releaseMatch: "skip" });
    expect(reasons(a.db).releaseMatch).toBe("no release table");

    const b = setup({ releases: "throw" });
    seedAgent(b.db);
    await b.v.runOnce();
    expect(checks(b.db)).toEqual({ ...allPass, releaseMatch: "pending" });

    const c = setup({ arweave: false });
    seedAgent(c.db);
    await c.v.runOnce();
    expect(checks(c.db)).toEqual({ refShape: "pass", itemFound: "skip", reportParses: "skip", eoasMatch: "skip", configHashMatch: "skip", imageIdMatch: "skip", releaseMatch: "pass" });
    expect(c.fake.requests).toEqual([]);
  });

  it("M4B §1: parseReport / worstStatus are pure (fail > pending > skip > pass)", () => {
    expect(parseReport(new TextEncoder().encode(REPORT_TEXT)).ok).toBe(true);
    expect(parseReport(new TextEncoder().encode("[]"))).toMatchObject({ ok: false, reason: "report is not a JSON object" });
    expect(worstStatus(["pass", "skip"])).toBe("skip");
    expect(worstStatus(["pass", "skip", "pending"])).toBe("pending");
    expect(worstStatus(["pending", "fail", "skip"])).toBe("fail");
    expect(worstStatus(["pass"])).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// §1c API (real http, temp db)
// ---------------------------------------------------------------------------

const servers: Array<{ server: Server; db: IndexerDb; dir: string }> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((r) => s.server.close(() => r()));
    s.db.close();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

async function serve(seed: (db: IndexerDb) => Promise<void> | void): Promise<(path: string) => Promise<{ status: number; body: any }>> {
  const dir = mkdtempSync(join(tmpdir(), "indexer-att-"));
  const db = new IndexerDb(join(dir, "a.sqlite"));
  db.kvSet(REVIVAL_WINDOW_KEY, "604800");
  await seed(db);
  const api = new IndexerApi(db, { now: () => BigInt(NOW) }, { staleAfterSec: 1800, startBlock: 1n, gatewayUrl: "https://arweave.net/" }, memoryLogger());
  const server = api.server();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  servers.push({ server, db, dir });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
}

/** Runs one verify pass over whatever the seeder registered, with per-agent Arweave bodies. */
async function verifyWith(db: IndexerDb, bodies: Record<string, string>): Promise<void> {
  const fake = new FakeArweave();
  for (const [id, body] of Object.entries(bodies)) fake.items.set(id, { owner: OWNER8, body });
  const client = new HttpArweaveClient({ graphqlUrl: "https://arweave.net/graphql", gatewayUrl: "https://arweave.net", fetchImpl: fake.fetch as typeof fetch });
  const log = memoryLogger();
  const t = loadReleaseTable(RELEASES, log);
  await new Verifier(db, client, () => t, { now: () => BigInt(NOW) }, log).runOnce();
}

describe("M4B §1: attestation API", () => {
  it("M4B §1: GET /api/agents/:id/attestation — checks, release, Arweave link, report vs registry, generation history, verify-yourself commands; 404/400", async () => {
    const get = await serve(async (db) => {
      seedAgent(db);
      db.insertEvent({ agentId: 8, kind: "registered", txHash: "0xreg8", logIndex: 3, blockNumber: 500, ts: NOW - 600, data: JSON.stringify({ treasuryEOA: TREASURY8, actionEOA: ACTION8, codeHash: CODE8, generation: 1 }) });
      db.insertEvent({ agentId: 8, kind: "heartbeat", txHash: "0xhb", logIndex: 0, blockNumber: 501, ts: NOW - 60, data: "{}" });
      seedAgent(db, { agentId: 3, ref: "attestation-1790597593.json", codeHash: `0x${"a5".repeat(32)}` });
      db.upsertAgentRequested({ agentId: 9, configHash: CFG8, creator: "0xC", requestTx: "0xr9", requestBlock: 11, createdAt: NOW, name: "N", symbol: "N", imageURI: null });
      await verifyWith(db, { [REF8]: REPORT_TEXT });
    });
    const r = await get("/api/agents/8/attestation");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      agentId: 8,
      checks: CHECK_NAMES.map((name) => ({ name, status: "pass", detail: null })),
      verifiedAt: NOW,
      releaseVersion: "v0.1.6",
      releaseCommit: "3d9455fb69976db448dd1edb6b991843fb604282",
      attestationRef: REF8,
      arweaveUrl: `https://arweave.net/${REF8}`,
      owner: OWNER8.toLowerCase(), // SPEC-M4A rev 2: 0x-form owners normalized lowercase at the client boundary
      report: { treasury: TREASURY8.toLowerCase(), action: ACTION8.toLowerCase(), configHash: CFG8, imageId: CODE8 },
      registry: { treasuryEOA: TREASURY8, actionEOA: ACTION8, codeHash: CODE8, configHash: CFG8, generation: 1, lastHeartbeat: NOW - 600 },
      status: "live",
      generationHistory: [{ generation: 1, treasuryEOA: TREASURY8, actionEOA: ACTION8, codeHash: CODE8, ts: NOW - 600, txHash: "0xreg8" }],
      verifyYourself: {
        imageId: CODE8.slice(2),
        enclaveIpHint: null,
        commands: [
          `oyster-cvm verify --enclave-ip <ENCLAVE_IP> --image-id ${CODE8.slice(2)}`,
          "curl -s http://<ENCLAVE_IP>:8420/attestation",
          `oyster-cvm kms-derive --image-id ${CODE8.slice(2)} --path treasury --key-type secp256k1/address/ethereum`,
          `oyster-cvm kms-derive --image-id ${CODE8.slice(2)} --path action --key-type secp256k1/address/ethereum`,
          `curl -sL https://arweave.net/${REF8}`,
        ],
      },
    });

    const drill = await get("/api/agents/3/attestation");
    expect(drill.body.checks.map((c: { status: string }) => c.status)).toEqual(Array(7).fill("skip"));
    expect(drill.body.checks[0].detail).toBe("local ref (drill): attestation-1790597593.json");
    expect(drill.body.arweaveUrl).toBeNull();
    expect(drill.body.verifyYourself.commands).toHaveLength(4);

    // Requested, never registered: nothing verified yet.
    const pending = await get("/api/agents/9/attestation");
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ verifiedAt: null, registry: null, status: "pending", attestationRef: null, generationHistory: [], verifyYourself: { imageId: null, commands: [] } });
    expect(pending.body.checks.every((c: { status: string }) => c.status === "pending")).toBe(true);

    expect((await get("/api/agents/42/attestation")).status).toBe(404);
    expect((await get("/api/agents/abc/attestation")).status).toBe(400);
    expect((await get("/api/attestation")).status).toBe(404);
    expect((await get("/api/attestation/nope")).status).toBe(404);
  });

  it("M4B §1: GET /api/attestation/summary — alert only on live+fail (live+pending ⇒ no alert; stale+fail ⇒ reported, no alert)", async () => {
    const badEoa = mutateReport((r) => (r.eoas.treasury = "0x" + "11".repeat(20)));
    const REF_B = "B".repeat(43);
    const REF_C = "C".repeat(43);
    // (1) live + pass, (2) live + pending (gateway has no item), (3) stale + fail, (4) drill skip.
    const noAlert = await serve(async (db) => {
      seedAgent(db, { agentId: 1 });
      seedAgent(db, { agentId: 2, ref: REF_B });
      seedAgent(db, { agentId: 3, ref: REF_C, registeredAt: NOW - 3 * 86_400 });
      seedAgent(db, { agentId: 4, ref: "attestation-1.json" });
      await verifyWith(db, { [REF8]: REPORT_TEXT, [REF_C]: badEoa });
    });
    const s = await noAlert("/api/attestation/summary");
    expect(s.status).toBe(200);
    expect(s.body).toEqual({
      alert: false,
      verifiedAt: NOW,
      agents: [
        { agentId: 1, status: "live", worst: "pass", failing: [] },
        { agentId: 2, status: "live", worst: "pending", failing: [] },
        { agentId: 3, status: "stale", worst: "fail", failing: ["eoasMatch"] },
        { agentId: 4, status: "live", worst: "skip", failing: [] },
      ],
    });

    // live + fail ⇒ alert.
    const alert = await serve(async (db) => {
      seedAgent(db, { agentId: 1 });
      seedAgent(db, { agentId: 5, ref: REF_C });
      await verifyWith(db, { [REF8]: REPORT_TEXT, [REF_C]: badEoa });
    });
    const a = await alert("/api/attestation/summary");
    expect(a.body.alert).toBe(true);
    expect(a.body.agents).toContainEqual({ agentId: 5, status: "live", worst: "fail", failing: ["eoasMatch"] });

    // Never verified: no rows ⇒ pending, no alert, verifiedAt null.
    const fresh = await serve((db) => void seedAgent(db));
    expect((await fresh("/api/attestation/summary")).body).toEqual({ alert: false, verifiedAt: null, agents: [{ agentId: 8, status: "live", worst: "pending", failing: [] }] });
  });
});

describe("M4B §1: config", () => {
  it("M4B §1: releasesDir resolves relative to the config file (testnet e2e ⇒ runtime/releases); verifySec DEFAULT 300; unset ⇒ undefined", () => {
    const cfg = loadConfig(resolve(here, "../e2e/testnet.json"));
    expect(cfg.releasesDir).toBe(RELEASES);
    expect(cfg.verifySec).toBe(300);
    const manifest = resolve(here, "../../contracts/deployments/testnet-46630.json");
    const c = buildConfig({ chain: { rpc: "https://a.example", chainId: 46630 }, deploymentManifest: manifest, dbPath: "x.sqlite" }, "/base");
    expect(c.releasesDir).toBeUndefined();
    expect(c.verifySec).toBe(300);
    expect(buildConfig({ chain: { rpc: "https://a.example", chainId: 46630 }, deploymentManifest: manifest, dbPath: "x", releasesDir: "rel" }, "/base").releasesDir).toBe("/base/rel");
  });
});
