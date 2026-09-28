import { describe, expect, it } from "vitest";
import { IndexerDb } from "../src/db.js";
import { Enricher, HttpArweaveClient, MAX_TEXT_CHARS, validateJournalItem } from "../src/enrich.js";
import { memoryLogger } from "../src/log.js";

// ---------------------------------------------------------------------------
// A fake Arweave (GraphQL + gateway) behind an injected fetch — no network.
// ---------------------------------------------------------------------------

interface FakeItem {
  id: string;
  owner: string;
  tags: Array<{ name: string; value: string }>;
  height: number | null;
  timestamp: number | null;
  body: string;
  /** Gateway answers 302 → this Location instead of the body. */
  redirect?: string;
}

const NOW = 1_790_000_000;
const TREASURY = "0xAa00000000000000000000000000000000000001";
const OWNER_A = "ownerA_".padEnd(43, "a");
const OWNER_B = "ownerB_".padEnd(43, "b");
const OWNER_C = "ownerC_".padEnd(43, "c");

let idSeq = 0;
function id(): string {
  idSeq++;
  return `item${idSeq}`.padEnd(43, "_");
}

function tags(kind: string, agentId = 7): FakeItem["tags"] {
  return [
    { name: "App", value: "agent-launchpad" },
    { name: "Kind", value: kind },
    { name: "AgentId", value: String(agentId) },
    { name: "Timestamp", value: String(NOW) },
  ];
}

function journal(owner: string, height: number | null, text: string, over: Partial<{ agentId: unknown; ts: unknown; v: unknown }> = {}): FakeItem {
  const payload = { v: 1, agentId: 7, ts: NOW, text, ...over };
  return { id: id(), owner, tags: tags("journal"), height, timestamp: height === null ? null : NOW, body: JSON.stringify(payload) };
}

function attestation(owner: string, height: number, treasury: string): FakeItem {
  // Canonical report shape (runtime/src/attestation/attestation.ts: canonicalEncode lowercases hex).
  const report = { kind: "agent-launchpad/attestation", version: 1, eoas: { treasury: treasury.toLowerCase(), action: "0xbb00000000000000000000000000000000000001" }, quote: "AAAA" };
  return { id: id(), owner, tags: tags("attestation"), height, timestamp: NOW, body: JSON.stringify(report) };
}

class FakeArweave {
  items: FakeItem[] = [];
  gqlRequests: Array<{ variables: any; query: string }> = [];
  downloads: string[] = [];
  /** Every gateway GET path id (incl. 404s / redirects). */
  gets: string[] = [];
  hosts: string[] = [];
  /** Extra hop target per item id (second redirect test). */
  secondRedirect = new Set<string>();
  pageSize = 100;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    this.hosts.push(u.hostname);
    if (u.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body));
      this.gqlRequests.push(body);
      return new Response(JSON.stringify(this.graphql(body.variables)), { status: 200 });
    }
    const itemId = u.pathname.slice(1);
    this.gets.push(itemId);
    const item = this.items.find((i) => i.id === itemId);
    if (item === undefined) return new Response("not found", { status: 404 });
    if (u.hostname === "arweave.net" && item.redirect !== undefined) {
      this.downloads.push(itemId);
      return new Response(null, { status: 302, headers: { location: item.redirect } });
    }
    if (this.secondRedirect.has(itemId)) return new Response(null, { status: 302, headers: { location: "https://again.arweave.net/x" } });
    this.downloads.push(itemId);
    return new Response(item.body, { status: 200 });
  };

  private graphql(v: { ids?: string[]; tags: Array<{ name: string; values: string[] }>; owners?: string[]; after: string | null }): unknown {
    if (v.ids !== undefined) {
      const hits = this.items.filter((i) => v.ids!.includes(i.id));
      return { data: { transactions: { pageInfo: { hasNextPage: false }, edges: hits.map((i) => ({ cursor: i.id, node: { id: i.id, owner: { address: i.owner } } })) } } };
    }
    let list = this.items.filter((i) =>
      v.tags.every((f) => i.tags.some((t) => t.name === f.name && f.values.includes(t.value))) && (v.owners === undefined || v.owners.includes(i.owner)),
    );
    // HEIGHT_DESC with pending (null height) first.
    list = [...list].sort((a, b) => (b.height ?? Number.MAX_SAFE_INTEGER) - (a.height ?? Number.MAX_SAFE_INTEGER));
    const start = v.after === null ? 0 : list.findIndex((i) => i.id === v.after) + 1;
    const page = list.slice(start, start + this.pageSize);
    return {
      data: {
        transactions: {
          pageInfo: { hasNextPage: start + this.pageSize < list.length },
          edges: page.map((i) => ({
            cursor: i.id,
            node: { id: i.id, owner: { address: i.owner }, tags: i.tags, block: i.height === null ? null : { height: i.height, timestamp: i.timestamp } },
          })),
        },
      },
    };
  }
}

const DRILL_REF = "attestation-1790597593.json";

/** The instanceOf reconcile path: the on-chain struct (attestationRef included) replaces the row. */
function setRef(db: IndexerDb, ref: string | null): void {
  db.reconcileInstance({ agentId: 7, treasuryEOA: TREASURY, actionEOA: "0xB", codeHash: "0xc", attestationRef: ref, lastHeartbeat: NOW, generation: 1 });
}

function setup(ref: string | null = DRILL_REF) {
  const fake = new FakeArweave();
  const db = new IndexerDb(":memory:");
  db.upsertInstanceRegistered({ agentId: 7, treasuryEOA: TREASURY, actionEOA: "0xB", codeHash: "0xc", generation: 1, attestationRef: ref, registeredAt: NOW });
  const log = memoryLogger();
  const client = new HttpArweaveClient({ graphqlUrl: "https://arweave.net/graphql", gatewayUrl: "https://arweave.net", fetchImpl: fake.fetch as typeof fetch });
  const e = new Enricher(db, client, { now: () => BigInt(NOW) }, log);
  return { fake, db, log, e };
}

describe("enrich: discovery → pin → fetch → verify", () => {
  it("until an attestation pins an owner, journal items from any owner are ingested unverified", async () => {
    const { fake, db, e } = setup();
    fake.items.push(journal(OWNER_A, 100, "hello from A"), journal(OWNER_C, 101, "hello from C"));
    expect(await e.runOnce()).toBe(2);
    const rows = db.journal(7, 10);
    expect(rows.map((r) => [r.text, r.unverified]).sort()).toEqual([
      ["hello from A", 1],
      ["hello from C", 1],
    ]);
    expect(fake.gqlRequests[0]!.variables.owners).toBeUndefined();
    expect(fake.gqlRequests[0]!.variables.tags).toEqual([
      { name: "App", values: ["agent-launchpad"] },
      { name: "AgentId", values: ["7"] },
      { name: "Kind", values: ["journal"] },
    ]);
  });

  it("rejects bad items LOUDLY (agentId mismatch, non-JSON, text > 4096, ts outside ±1d) and never re-fetches them", async () => {
    const { fake, db, e, log } = setup();
    const bad = [
      journal(OWNER_A, 100, "x", { agentId: 8 }),
      { ...journal(OWNER_A, 101, "x"), body: "not json {" },
      journal(OWNER_A, 102, "y".repeat(MAX_TEXT_CHARS + 1)),
      journal(OWNER_A, 103, "x", { ts: NOW - 86_401 }),
      journal(OWNER_A, 104, "x", { v: 2 }),
    ];
    const good = journal(OWNER_A, 105, "y".repeat(MAX_TEXT_CHARS));
    fake.items.push(...bad, good);
    expect(await e.runOnce()).toBe(1);
    expect(db.journal(7, 10).map((r) => r.itemId)).toEqual([good.id]);
    const rejects = log.lines.filter((l) => l.startsWith("WARN ENRICH REJECTED"));
    expect(rejects).toHaveLength(5);
    expect(rejects.join("\n")).toMatch(/agentId mismatch/);
    expect(rejects.join("\n")).toMatch(/non-JSON/);
    expect(rejects.join("\n")).toMatch(/4097 chars/);
    expect(rejects.join("\n")).toMatch(/outside block time/);
    const before = fake.downloads.length;
    await e.runOnce();
    expect(fake.downloads.length).toBe(before);
  });

  it("the ts window check is skipped while the item has no block (pending)", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, agentId: 7, ts: 1, text: "t" }));
    expect(validateJournalItem(bytes, 7, null).ok).toBe(true);
    expect(validateJournalItem(bytes, 7, NOW).ok).toBe(false);
  });

  it("re-checks the gateway's tag filter locally", async () => {
    const { fake, db } = setup();
    const wrongAgent = journal(OWNER_A, 100, "other agent");
    const wrongApp = journal(OWNER_A, 101, "other app");
    fake.items.push(wrongAgent, wrongApp);
    wrongAgent.tags = wrongAgent.tags.map((t) => (t.name === "AgentId" ? { ...t, value: "8" } : t));
    wrongApp.tags = wrongApp.tags.map((t) => (t.name === "App" ? { ...t, value: "evil" } : t));
    // A lying gateway: ignores the tag filter and answers with every item.
    const client = new HttpArweaveClient({
      graphqlUrl: "https://arweave.net/graphql",
      gatewayUrl: "https://arweave.net",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(input));
        if (u.pathname === "/graphql") {
          return new Response(
            JSON.stringify({
              data: {
                transactions: {
                  pageInfo: { hasNextPage: false },
                  edges: fake.items.map((i) => ({ cursor: i.id, node: { id: i.id, owner: { address: i.owner }, tags: i.tags, block: { height: i.height, timestamp: i.timestamp } } })),
                },
              },
            }),
            { status: 200 },
          );
        }
        return fake.fetch(input, init);
      }) as typeof fetch,
    });
    const e2 = new Enricher(db, client, { now: () => BigInt(NOW) }, memoryLogger());
    expect(await e2.runOnce()).toBe(0);
    expect(fake.downloads).toEqual([]);
  });

  it("skips agents without a registered instance", async () => {
    const fake = new FakeArweave();
    const db = new IndexerDb(":memory:");
    db.upsertAgentRequested({ agentId: 5, configHash: "0x", creator: "0x", requestTx: "0x", requestBlock: 1, createdAt: 1, name: null, symbol: null, imageURI: null });
    const e = new Enricher(db, new HttpArweaveClient({ graphqlUrl: "https://arweave.net/graphql", gatewayUrl: "https://arweave.net", fetchImpl: fake.fetch as typeof fetch }), { now: () => 1n }, memoryLogger());
    expect(await e.runOnce()).toBe(0);
    expect(fake.gqlRequests).toHaveLength(0);
  });
});

describe("enrich: owner pin ONLY via the on-chain attestationRef item (SPEC-M4A §3.1 rev 1)", () => {
  it("pins the owner of the item whose id = attestationRef (treasury case-insensitive); drops other owners; then pinned-only", async () => {
    const { fake, db, e, log } = setup();
    fake.items.push(journal(OWNER_A, 100, "spam from A"));
    await e.runOnce();
    expect(db.journal(7, 10)).toHaveLength(1);

    const att = attestation(OWNER_B, 105, TREASURY); // payload lowercases; TREASURY is checksummed
    fake.items.push(att, journal(OWNER_B, 120, "real entry"), journal(OWNER_A, 121, "more spam"));
    setRef(db, att.id);
    await e.runOnce();
    expect(db.journalOwner(7)).toMatchObject({ owner: OWNER_B, attestationItem: att.id });
    expect(db.journal(7, 10).map((r) => [r.owner, r.text, r.unverified])).toEqual([[OWNER_B, "real entry", 0]]);
    expect(log.lines.some((l) => l.includes("PINNED") && l.includes(OWNER_B) && l.includes(att.id))).toBe(true);
    // Owner came from a GraphQL lookup BY ID; discovery is owner-filtered after the pin.
    expect(fake.gqlRequests.some((r) => JSON.stringify(r.variables.ids) === JSON.stringify([att.id]))).toBe(true);
    expect(fake.gqlRequests.at(-1)!.variables.owners).toEqual([OWNER_B]);

    fake.items.push(journal(OWNER_A, 130, "ignored"), journal(OWNER_B, 131, "second real"));
    await e.runOnce();
    expect(db.journal(7, 10).map((r) => r.text).sort()).toEqual(["real entry", "second real"]);
    expect(db.journal(7, 10).every((r) => r.owner === OWNER_B && r.unverified === 0)).toBe(true);
  });

  it("SPOOF REGRESSION: tag-uploaded attestation items with the right treasury never pin", async () => {
    const { fake, db, e } = setup(DRILL_REF);
    // Attacker C uploads a copy of a valid report, tagged App/AgentId=7/Kind=attestation, newest of all.
    const spoof = attestation(OWNER_C, 200, TREASURY);
    fake.items.push(spoof, journal(OWNER_C, 199, "attacker entry"));
    await e.runOnce();
    await e.runOnce();
    expect(db.journalOwner(7)).toBeUndefined();
    expect(fake.gets).not.toContain(spoof.id);
    expect(db.journal(7, 10).map((r) => [r.owner, r.unverified])).toEqual([[OWNER_C, 1]]);

    // With a real attestationRef, the pin goes to ITS owner — the newer tagged spoof is irrelevant.
    const real = attestation(OWNER_B, 150, TREASURY);
    fake.items.push(real);
    setRef(db, real.id);
    await e.runOnce();
    expect(db.journalOwner(7)).toMatchObject({ owner: OWNER_B, attestationItem: real.id });
    expect(fake.gets).not.toContain(spoof.id);
    expect(db.journal(7, 10)).toEqual([]); // attacker's unverified row deleted on pin
    // Discovery no longer asks for Kind=attestation at all.
    expect(fake.gqlRequests.every((r) => r.variables.tags === undefined || JSON.stringify(r.variables.tags).includes('"values":["journal"]'))).toBe(true);
  });

  it("a non-Arweave-looking attestationRef (drill local file / null / wrong length) ⇒ no fetch, no pin, no warning", async () => {
    for (const ref of [DRILL_REF, null, "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`]) {
      const { fake, db, e, log } = setup(ref);
      fake.items.push(journal(OWNER_A, 100, "entry"));
      expect(await e.runOnce()).toBe(1);
      expect(db.journalOwner(7)).toBeUndefined();
      expect(fake.gets).toHaveLength(1); // only the journal item
      expect(fake.gqlRequests.some((r) => r.variables.ids !== undefined)).toBe(false);
      expect(log.lines.filter((l) => l.startsWith("WARN"))).toEqual([]);
    }
  });

  it("treasury mismatch ⇒ no pin, warned ONCE per agent, the immutable item is not re-fetched", async () => {
    const wrong = attestation(OWNER_B, 105, "0x9999999999999999999999999999999999999999");
    const { fake, db, e, log } = setup(wrong.id);
    fake.items.push(wrong, journal(OWNER_A, 110, "entry"));
    await e.runOnce();
    await e.runOnce();
    await e.runOnce();
    expect(db.journalOwner(7)).toBeUndefined();
    expect(db.journal(7, 10).map((r) => r.unverified)).toEqual([1]);
    const warns = log.lines.filter((l) => l.startsWith("WARN ENRICH") && l.includes("does not attest"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(wrong.id);
    expect(fake.gets.filter((x) => x === wrong.id)).toHaveLength(1);
    expect(fake.gqlRequests.some((r) => r.variables.ids !== undefined)).toBe(false); // no owner lookup on mismatch
  });

  it("payload without top-level eoas.treasury (or non-JSON) ⇒ no pin", async () => {
    const nested = { ...attestation(OWNER_B, 105, TREASURY), body: JSON.stringify({ report: { eoas: { treasury: TREASURY } } }) };
    const junk = { ...attestation(OWNER_B, 106, TREASURY), body: "not json" };
    for (const item of [nested, junk]) {
      const { fake, db, e, log } = setup(item.id);
      fake.items.push(item);
      await e.runOnce();
      expect(db.journalOwner(7)).toBeUndefined();
      expect(log.lines.some((l) => l.includes("does not attest"))).toBe(true);
    }
  });

  it("fetch failure ⇒ no pin, warned once, retried each pass; pins once the item is served", async () => {
    const att = attestation(OWNER_B, 105, TREASURY);
    const { fake, db, e, log } = setup(att.id);
    fake.items.push(journal(OWNER_A, 100, "entry")); // att not served yet ⇒ 404
    await e.runOnce();
    await e.runOnce();
    expect(db.journalOwner(7)).toBeUndefined();
    expect(fake.gets.filter((x) => x === att.id)).toHaveLength(2);
    expect(log.lines.filter((l) => l.startsWith("WARN ENRICH") && l.includes("fetch failed"))).toHaveLength(1);
    expect(db.journal(7, 10).map((r) => r.unverified)).toEqual([1]);

    fake.items.push(att);
    await e.runOnce();
    expect(db.journalOwner(7)).toMatchObject({ owner: OWNER_B });
    expect(db.journal(7, 10)).toEqual([]); // OWNER_A's unverified row dropped
  });

  it("the attestationRef fetch obeys the ONE-redirect *.arweave.net rule", async () => {
    const att = attestation(OWNER_B, 105, TREASURY);
    att.redirect = `https://evil.example/${att.id}`;
    const { fake, db, e, log } = setup(att.id);
    fake.items.push(att);
    await e.runOnce();
    expect(db.journalOwner(7)).toBeUndefined();
    expect(fake.hosts).not.toContain("evil.example");
    expect(log.lines.some((l) => l.includes("refusing redirect to host evil.example"))).toBe(true);
  });

  it("owner lookup: a gateway answering with a different id (or none) ⇒ no pin", async () => {
    const att = attestation(OWNER_B, 105, TREASURY);
    const { fake, db, log } = setup(att.id);
    fake.items.push(att);
    const lying = new HttpArweaveClient({
      graphqlUrl: "https://arweave.net/graphql",
      gatewayUrl: "https://arweave.net",
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(input));
        if (u.pathname === "/graphql") {
          const other = "z".repeat(43);
          return new Response(JSON.stringify({ data: { transactions: { edges: [{ cursor: other, node: { id: other, owner: { address: OWNER_C } } }] } } }), { status: 200 });
        }
        return fake.fetch(input, init);
      }) as typeof fetch,
    });
    expect(await lying.ownerOf(att.id)).toBeNull();
    const e2 = new Enricher(db, lying, { now: () => BigInt(NOW) }, log);
    await e2.runOnce();
    expect(db.journalOwner(7)).toBeUndefined();
    expect(log.lines.some((l) => l.includes("owner unknown to the gateway"))).toBe(true);
  });
});

describe("enrich: gateway redirect rule (ONE hop, https *.arweave.net only)", () => {
  it("follows one redirect to a *.arweave.net sandbox host", async () => {
    const { fake, db, e } = setup();
    const it1 = journal(OWNER_A, 100, "via sandbox");
    it1.redirect = `https://abcdef.arweave.net/${it1.id}`;
    fake.items.push(it1);
    expect(await e.runOnce()).toBe(1);
    expect(db.journal(7, 10)[0]!.text).toBe("via sandbox");
    expect(fake.hosts).toContain("abcdef.arweave.net");
  });

  it("refuses a foreign host, a non-https hop, and a second redirect — nothing ingested, warned, retried later", async () => {
    const { fake, db, e, log } = setup();
    const foreign = journal(OWNER_A, 100, "x");
    foreign.redirect = `https://evil.example/${foreign.id}`;
    const plain = journal(OWNER_A, 101, "x");
    plain.redirect = `http://sub.arweave.net/${plain.id}`;
    const twice = journal(OWNER_A, 102, "x");
    twice.redirect = `https://one.arweave.net/${twice.id}`;
    fake.secondRedirect.add(twice.id);
    fake.items.push(foreign, plain, twice);
    expect(await e.runOnce()).toBe(0);
    expect(db.journal(7, 10)).toHaveLength(0);
    expect(fake.hosts).not.toContain("evil.example");
    expect(fake.hosts).not.toContain("sub.arweave.net");
    const warns = log.lines.filter((l) => l.includes("fetch failed")).join("\n");
    expect(warns).toMatch(/refusing redirect to host evil\.example/);
    expect(warns).toMatch(/refusing non-https redirect/);
    expect(warns).toMatch(/refusing a second redirect/);
    // Transport failures do not advance the per-agent cursor (retried next pass).
    expect(db.kvGet("enrich.7.height")).toBeUndefined();
  });
});

describe("enrich: incremental per-agent cursor", () => {
  it("a later pass stops paging once it reaches items below (stored height − margin)", async () => {
    const { fake, db, e } = setup();
    for (let h = 1000; h > 850; h--) fake.items.push(journal(OWNER_A, h, `entry ${h}`));
    expect(await e.runOnce()).toBe(150);
    expect(fake.gqlRequests).toHaveLength(2); // 100 + 50
    expect(db.kvGet("enrich.7.height")).toBe("1000");
    const downloads = fake.downloads.length;
    fake.items.push(journal(OWNER_A, 1001, "fresh"));
    expect(await e.runOnce()).toBe(1);
    expect(fake.gqlRequests).toHaveLength(3); // one page: heights 1001..903 reach below 950
    expect(fake.downloads.length).toBe(downloads + 1);
    expect(db.kvGet("enrich.7.height")).toBe("1001");
  });
});
