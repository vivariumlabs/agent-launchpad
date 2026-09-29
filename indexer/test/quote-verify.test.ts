import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { IndexerApi } from "../src/api.js";
import { CHECK_NAMES, IndexerDb, MIGRATIONS } from "../src/db.js";
import { HttpArweaveClient } from "../src/enrich.js";
import { memoryLogger } from "../src/log.js";
import { loadReleaseTable } from "../src/releases.js";
import { decodeReportQuote, MAX_QUOTE_BYTES, parseReport, Verifier, type VerifyDetail } from "../src/verify.js";
import { REVIVAL_WINDOW_KEY } from "../src/watcher.js";

// SPEC-M4D §2 verify integration: the LIVE agent-8 and agent-10 reports (with their raw NSM quotes)
// behind a fake Arweave, against their registered chain values.

const here = dirname(fileURLToPath(import.meta.url));
const RELEASES = resolve(here, "../../runtime/releases");
const TEXT8 = readFileSync(join(here, "fixtures/agent8-report-full.json"), "utf8");
const TEXT10 = readFileSync(join(here, "fixtures/agent10-report-full.json"), "utf8");

const NOW = 1_790_700_000;
const TRUE8 = "f489dc609c6b33a7016c113f0965a46de35c4cfd2ef8e8f4751bd845923a4350";
const TRUE10 = "0558ac2879f92c1fd638d522552a81bbcc5ad8d7d543604567375a0d3fa9cc4a";

interface AgentFixture {
  agentId: number;
  ref: string;
  treasury: string;
  action: string;
  configHash: string;
  /** Registered on chain (instances.codeHash). */
  codeHash: string;
  body: string;
}

const A8: AgentFixture = {
  agentId: 8,
  ref: "iCt3c0kzoGZRzPfhy8XFae6pjuUVhTgFDrBlMciUUzs",
  treasury: "0xd7EF592E26936627C2dAD31c08EeD561dB5EeCB8",
  action: "0x3c169d57729Bf24bdEA3Ef34f5089BE6234bc9a1",
  configHash: "0x06640d641b49e5f0918360fb46ab6d24036b1888d062290d3e46c231243905d2",
  codeHash: `0x${TRUE8}`,
  body: TEXT8,
};
// Agent 10: registered codeHash f489dc60… (copied runtime.json), quote measures 0558ac28….
const A10: AgentFixture = {
  agentId: 10,
  ref: "mAPIQaMePShyIlLUV7mUx0xQ3PQaAXrdlBZVu6kk6nA",
  treasury: "0x124fb1dffc120c8126e79054604bb2c392561bdf",
  action: "0xa8dee9d445e672fe6b281870a1e29e90eb0f0383",
  configHash: "0x081607a76efd25080335a26924adda13cfb876fef9f5f50e875af909b6af1f86",
  codeHash: `0x${TRUE8}`,
  body: TEXT10,
};

function mutate(text: string, f: (r: Record<string, unknown>) => void): string {
  const r = JSON.parse(text) as Record<string, unknown>;
  f(r);
  return JSON.stringify(r);
}

function fakeFetch(bodies: Map<string, { owner: string; body: string }>, opts: { gatewayDown?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname === "/graphql") {
      const ids = (JSON.parse(String(init?.body)) as { variables: { ids: string[] } }).variables.ids;
      const edges = ids.flatMap((id) => (bodies.has(id) ? [{ node: { id, owner: { address: bodies.get(id)!.owner } } }] : []));
      return new Response(JSON.stringify({ data: { transactions: { edges } } }), { status: 200 });
    }
    if (opts.gatewayDown) throw new TypeError("fetch failed (ETIMEDOUT)");
    const it = bodies.get(u.pathname.slice(1));
    return it === undefined ? new Response("not found", { status: 404 }) : new Response(it.body, { status: 200 });
  }) as typeof fetch;
}

function seed(db: IndexerDb, a: AgentFixture, o: { ref?: string; registeredAt?: number } = {}): void {
  db.upsertAgentRequested({ agentId: a.agentId, configHash: a.configHash, creator: "0xC", requestTx: `0xreq${a.agentId}`, requestBlock: 10, createdAt: NOW - 7200, name: "N", symbol: "S", imageURI: null });
  db.upsertInstanceRegistered({
    agentId: a.agentId,
    treasuryEOA: a.treasury,
    actionEOA: a.action,
    codeHash: a.codeHash,
    generation: 1,
    attestationRef: o.ref ?? a.ref,
    registeredAt: o.registeredAt ?? NOW - 600,
  });
}

async function run(db: IndexerDb, bodies: Record<string, string>, opts: { gatewayDown?: boolean } = {}): Promise<void> {
  const m = new Map(Object.entries(bodies).map(([id, body]) => [id, { owner: "0xd7EF592E26936627C2dAD31c08EeD561dB5EeCB8", body }]));
  const client = new HttpArweaveClient({ graphqlUrl: "https://arweave.net/graphql", gatewayUrl: "https://arweave.net", fetchImpl: fakeFetch(m, opts) });
  const log = memoryLogger();
  const table = loadReleaseTable(RELEASES, log);
  await new Verifier(db, client, () => table, { now: () => BigInt(NOW) }, log).runOnce();
}

const checks = (db: IndexerDb, id: number): Record<string, string> => {
  const r = db.attestationChecks(id)!;
  return Object.fromEntries(CHECK_NAMES.map((k) => [k, r[k]]));
};
const detail = (db: IndexerDb, id: number): VerifyDetail => JSON.parse(db.attestationChecks(id)!.detail) as VerifyDetail;
const allPass = Object.fromEntries(CHECK_NAMES.map((k) => [k, "pass"]));

describe("M4D §2: verify integration", () => {
  it("M4D §2: CHECK_NAMES appends quoteValid, measurementMatch (evaluation order)", () => {
    expect(CHECK_NAMES.slice(-2)).toEqual(["quoteValid", "measurementMatch"]);
    expect(CHECK_NAMES).toHaveLength(9);
  });

  it("M4D §2: agent-8 fixture ⇒ quoteValid pass + measurementMatch pass (9/9), detail records the verified quote", async () => {
    const db = new IndexerDb(":memory:");
    seed(db, A8);
    await run(db, { [A8.ref]: A8.body });
    expect(checks(db, 8)).toEqual(allPass);
    expect(detail(db, 8).quote).toEqual({
      trueImageId: TRUE8,
      timestampMs: 1790665491169,
      moduleId: "i-09cb181a285c48de2-enc01a0ebfa4bd3d9ac",
      rootKeyOk: true,
      registeredCodeHash: A8.codeHash,
      reportImageId: A8.codeHash,
      reportImageIdDiverges: false,
    });
    expect(detail(db, 8).reasons).toEqual({});
  });

  it("M4D §2: agent-10 fixture with registered codeHash f489dc60… ⇒ quoteValid pass + measurementMatch FAIL (detail carries both ids); the self-report checks all pass", async () => {
    const db = new IndexerDb(":memory:");
    seed(db, A10);
    await run(db, { [A10.ref]: A10.body });
    // Self-consistent misreport: every M4B report↔chain check passes; only the quote sees it.
    expect(checks(db, 10)).toEqual({ ...allPass, measurementMatch: "fail" });
    const d = detail(db, 10);
    expect(d.quote).toMatchObject({ trueImageId: TRUE10, rootKeyOk: true, registeredCodeHash: `0x${TRUE8}`, reportImageId: `0x${TRUE8}`, reportImageIdDiverges: true });
    expect(d.reasons.measurementMatch).toBe(
      `quote image-id ${TRUE10} ≠ registry codeHash 0x${TRUE8}; report self-reports imageId 0x${TRUE8} (also diverges from the quote)`,
    );
    // 0x-/case-insensitive: registering the TRUE id (upper-case, no 0x) passes.
    const ok = new IndexerDb(":memory:");
    seed(ok, { ...A10, codeHash: TRUE10.toUpperCase() });
    await run(ok, { [A10.ref]: A10.body });
    expect(checks(ok, 10)).toMatchObject({ quoteValid: "pass", measurementMatch: "pass", imageIdMatch: "fail" });
  });

  it("M4D §2: report without quote ⇒ quoteValid fail 'no quote in report' (measurementMatch skip); bad encoding / base64 / bytes ⇒ fail", async () => {
    const cases: Array<[string, string, RegExp]> = [
      ["no quote", mutate(TEXT8, (r) => delete r.quote), /^no quote in report$/],
      ["quote null", mutate(TEXT8, (r) => (r.quote = null)), /^no quote in report$/],
      ["encoding hex", mutate(TEXT8, (r) => (r.quoteEncoding = "hex")), /^quoteEncoding "hex" ≠ "base64"$/],
      ["encoding missing", mutate(TEXT8, (r) => delete r.quoteEncoding), /^quoteEncoding null ≠ "base64"$/],
      ["not base64", mutate(TEXT8, (r) => (r.quote = "!!!!")), /not valid base64/],
      ["oversize", mutate(TEXT8, (r) => (r.quote = "A".repeat(Math.ceil(MAX_QUOTE_BYTES / 3) * 4 + 4))), /exceeds/],
      ["not a COSE doc", mutate(TEXT8, (r) => (r.quote = Buffer.from("hello world").toString("base64"))), /CBOR|COSE/],
      ["agent-10 quote in agent-8's report (wrong measurement is a data fact, not a quote fault)", mutate(TEXT8, (r) => (r.quote = JSON.parse(TEXT10).quote)), /^$/],
    ];
    for (const [name, body, want] of cases) {
      const db = new IndexerDb(":memory:");
      seed(db, A8);
      await run(db, { [A8.ref]: body });
      const got = checks(db, 8);
      if (want.source === "^$") {
        expect([name, got.quoteValid, got.measurementMatch]).toEqual([name, "pass", "fail"]);
        continue;
      }
      expect([name, got]).toEqual([name, { ...allPass, quoteValid: "fail", measurementMatch: "skip" }]);
      expect([name, detail(db, 8).reasons.quoteValid]).toEqual([name, expect.stringMatching(want)]);
      expect(detail(db, 8).reasons.measurementMatch).toBe("quoteValid failed");
      expect(detail(db, 8).quote).toBeNull();
    }
  });

  it("M4D §2: drill ref ⇒ both skip; unparseable report / oversize item / transport ⇒ both skip, never pending (R2)", async () => {
    const db = new IndexerDb(":memory:");
    seed(db, A8, { ref: "attestation-1790597593.json" });
    await run(db, {});
    expect(checks(db, 8)).toMatchObject({ refShape: "skip", quoteValid: "skip", measurementMatch: "skip" });

    const bad = new IndexerDb(":memory:");
    seed(bad, A8);
    await run(bad, { [A8.ref]: "not json {" });
    expect(checks(bad, 8)).toMatchObject({ reportParses: "fail", quoteValid: "skip", measurementMatch: "skip" });

    const big = new IndexerDb(":memory:");
    seed(big, A8);
    await run(big, { [A8.ref]: "x".repeat(256 * 1024 + 1) });
    expect(checks(big, 8)).toMatchObject({ itemFound: "fail", quoteValid: "skip", measurementMatch: "skip" });

    const down = new IndexerDb(":memory:");
    seed(down, A8);
    await run(down, { [A8.ref]: A8.body }, { gatewayDown: true });
    expect(checks(down, 8)).toMatchObject({ itemFound: "pending", quoteValid: "skip", measurementMatch: "skip" });
    expect(detail(down, 8).reasons.quoteValid).toBe("report not fetched (transport)");
  });

  it("M4D §2: summary alert fires ONLY when a measurementMatch-failing agent is live (stale ⇒ reported, no alert)", async () => {
    const summary = async (registeredAt10: number): Promise<{ alert: boolean; agents: unknown[] }> => {
      const db = new IndexerDb(":memory:");
      db.kvSet(REVIVAL_WINDOW_KEY, "604800");
      seed(db, A8);
      seed(db, A10, { registeredAt: registeredAt10 });
      await run(db, { [A8.ref]: A8.body, [A10.ref]: A10.body });
      const api = new IndexerApi(db, { now: () => BigInt(NOW) }, { staleAfterSec: 1800, startBlock: 1n, gatewayUrl: "https://arweave.net/" }, memoryLogger());
      return api.attestationSummary(BigInt(NOW)) as { alert: boolean; agents: unknown[] };
    };
    const stale = await summary(NOW - 3 * 86_400);
    expect(stale.alert).toBe(false);
    expect(stale.agents).toEqual([
      { agentId: 8, status: "live", worst: "pass", failing: [] },
      { agentId: 10, status: "stale", worst: "fail", failing: ["measurementMatch"] },
    ]);
    const live = await summary(NOW - 600);
    expect(live.alert).toBe(true);
    expect(live.agents).toContainEqual({ agentId: 10, status: "live", worst: "fail", failing: ["measurementMatch"] });
  });

  it("M4D §2: parseReport carries the quote fields; decodeReportQuote is strict canonical base64", () => {
    const p = parseReport(new TextEncoder().encode(TEXT8));
    expect(p.ok && p.quote.quoteEncoding).toBe("base64");
    expect(p.quote?.quote).toBe(JSON.parse(TEXT8).quote);
    const d = decodeReportQuote({ quote: "AAE=", quoteEncoding: "base64" });
    expect(d).toEqual({ ok: true, bytes: Uint8Array.of(0, 1) });
    expect(decodeReportQuote({ quote: "AAF=", quoteEncoding: "base64" })).toEqual({ ok: false, reason: "quote is not canonical base64" });
    expect(decodeReportQuote({ quote: "AAE", quoteEncoding: "base64" })).toEqual({ ok: false, reason: "quote is not valid base64" });
    expect(decodeReportQuote({ quote: "", quoteEncoding: "base64" })).toEqual({ ok: false, reason: "no quote in report" });
  });
});

// ---------------------------------------------------------------------------
// migration v4
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("M4D §2: migration v4", () => {
  it("M4D §2: a v3 db upgrades to v4; existing attestation_checks rows read pending on the new columns; upsert writes them", () => {
    const d = mkdtempSync(join(tmpdir(), "indexer-m4d-"));
    dirs.push(d);
    const p = join(d, "v3.sqlite");
    const raw = new Database(p);
    for (const m of MIGRATIONS.slice(0, 3)) raw.exec(m);
    raw.pragma("user_version = 3");
    raw
      .prepare(
        `INSERT INTO attestation_checks (agentId, verifiedAt, refShape, itemFound, reportParses, eoasMatch, configHashMatch, imageIdMatch, releaseMatch, releaseVersion, detail)
         VALUES (8, 123, 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'v0.1.6', '{"reasons":{}}')`,
      )
      .run();
    raw.close();

    const db = new IndexerDb(p);
    expect(MIGRATIONS).toHaveLength(4);
    expect(db.schemaVersion()).toBe(4);
    expect(db.attestationChecks(8)).toEqual({
      agentId: 8,
      verifiedAt: 123,
      refShape: "pass",
      itemFound: "pass",
      reportParses: "pass",
      eoasMatch: "pass",
      configHashMatch: "pass",
      imageIdMatch: "pass",
      releaseMatch: "pass",
      quoteValid: "pending",
      measurementMatch: "pending",
      releaseVersion: "v0.1.6",
      detail: '{"reasons":{}}',
    });
    db.upsertAttestationChecks({ ...db.attestationChecks(8)!, verifiedAt: 456, quoteValid: "pass", measurementMatch: "fail" });
    expect(db.attestationChecks(8)).toMatchObject({ verifiedAt: 456, quoteValid: "pass", measurementMatch: "fail" });
    db.close();
    const again = new IndexerDb(p); // reopen: no-op
    expect(again.schemaVersion()).toBe(4);
    expect(again.attestationChecks(8)).toMatchObject({ quoteValid: "pass", measurementMatch: "fail" });
    again.close();
  });
});
