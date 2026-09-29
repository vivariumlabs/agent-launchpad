// M4A debt (a) — action-swap attribution: tx sender → acting agent's "actionSwap" activity row.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { agentRegistryAbi, feeSplitHookAbi, poolManagerAbi } from "../src/abi.js";
import { IndexerApi } from "../src/api.js";
import { IndexerDb, MIGRATIONS } from "../src/db.js";
import { memoryLogger } from "../src/log.js";
import { Watcher } from "../src/watcher.js";
import { ADDR, BASE_TS, contracts, fixedClock, MockChain, mkLog } from "./helpers/mockChain.js";

const T1: Address = getAddress("0x2000000000000000000000000000000000000001"); // < USDG ⇒ currency0
const P1 = `0x${"1".repeat(64)}` as Hex;
const TREAS1: Address = getAddress("0xaa000000000000000000000000000000000000a1");
const ACTION1: Address = getAddress("0xbb000000000000000000000000000000000000b1");
const TREAS7: Address = getAddress("0xaa000000000000000000000000000000000000a7");
const ACTION7: Address = getAddress("0xe2bb6abf00000000000000000000000000007f67");
const STRANGER: Address = getAddress("0xdd000000000000000000000000000000000000dd");
const CODE = `0x${"c0de".repeat(16)}` as Hex;
const SWAP_TX = `0x${"5a".repeat(32)}` as Hex;
const AMOUNT0 = -2_204_007n * 10n ** 15n;
const AMOUNT1 = 1_000_000n;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(opts: { senderBackfillPerPoll?: number } = {}) {
  const chain = new MockChain();
  const db = new IndexerDb(":memory:");
  const log = memoryLogger();
  const w = new Watcher(db, chain, { contracts: contracts(100n), reorgWindowBlocks: 30, maxBlockRange: 10_000, ...opts }, fixedClock(BASE_TS + 2000n), log);
  return { chain, db, log, w };
}

/** Agent 1 owns pool P1; agents 1 and 7 register instances; one Swap on P1 in SWAP_TX at block 990 (inside the re-scan window). */
function world(chain: MockChain): void {
  const L = chain.logs;
  L.push(mkLog(feeSplitHookAbi, "PoolRegistered", { poolId: P1, agentId: 1n, agentToken: T1 }, { address: ADDR.hook, blockNumber: 150n, logIndex: 0 }));
  L.push(mkLog(agentRegistryAbi, "InstanceRegistered", { agentId: 1n, treasuryEOA: TREAS1, actionEOA: ACTION1, codeHash: CODE, generation: 1 }, { address: ADDR.registry, blockNumber: 160n, logIndex: 0 }));
  L.push(mkLog(agentRegistryAbi, "InstanceRegistered", { agentId: 7n, treasuryEOA: TREAS7, actionEOA: ACTION7, codeHash: CODE, generation: 1 }, { address: ADDR.registry, blockNumber: 161n, logIndex: 0 }));
  L.push(
    mkLog(
      poolManagerAbi,
      "Swap",
      { id: P1, sender: ADDR.factory /* the shared router, never the actor */, amount0: AMOUNT0, amount1: AMOUNT1, sqrtPriceX96: 1771595571142957102961n, liquidity: 5n, tick: -1, fee: 10_000 },
      { address: ADDR.poolManager, blockNumber: 990n, logIndex: 2, transactionHash: SWAP_TX },
    ),
  );
}

const tx = SWAP_TX.toLowerCase();
const kindsOf = (db: IndexerDb, agentId: number): string[] => db.activity(agentId, 200).map((e) => e.kind);
const countKind = (db: IndexerDb, kind: string): number => Number((db.db.prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = ?`).get(kind) as { c: number }).c);

describe("M4A(a): schema migration", () => {
  it("M4A(a): migration rebuilds events with per-kind uniqueness and preserves rows", () => {
    const d = mkdtempSync(join(tmpdir(), "indexer-m4a-"));
    dirs.push(d);
    const p = join(d, "v2.sqlite");
    // A v2 database as shipped before this migration.
    const raw = new Database(p);
    raw.exec(MIGRATIONS[0]!);
    raw.exec(MIGRATIONS[1]!);
    raw.pragma("user_version = 2");
    const ins = raw.prepare(`INSERT INTO events (agentId, kind, txHash, logIndex, blockNumber, ts, data) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    ins.run(1, "swap", "0xaa", 2, 10, 100, '{"a":"1"}');
    ins.run(1, "heartbeat", "0xbb", 0, 11, 101, "{}");
    ins.run(null, "buyback_poked", "0xcc", 0, 12, 102, "{}");
    raw.prepare(`DELETE FROM events WHERE txHash = '0xcc'`).run(); // AUTOINCREMENT high-water mark (3) > max(id) (2)
    raw.prepare(`INSERT INTO swaps (txHash, logIndex, poolId, agentId, ts, blockNumber, amount0, amount1, sqrtPriceX96) VALUES ('0xaa', 2, '0xp', 1, 100, 10, '-5', '7', '1')`).run();
    raw.close();

    const db = new IndexerDb(p);
    expect(db.schemaVersion()).toBe(MIGRATIONS.length);
    expect(db.activity(1, 10).map((e) => [e.id, e.kind, e.txHash, e.logIndex, e.data])).toEqual([
      [2, "heartbeat", "0xbb", 0, "{}"],
      [1, "swap", "0xaa", 2, '{"a":"1"}'],
    ]);
    // Per-(txHash, logIndex, kind) uniqueness: another kind on the same log is new; a replay is not.
    expect(db.insertEvent({ agentId: 7, kind: "actionSwap", txHash: "0xaa", logIndex: 2, blockNumber: 10, ts: 100, data: "{}" })).toBe(true);
    expect(db.insertEvent({ agentId: 7, kind: "actionSwap", txHash: "0xaa", logIndex: 2, blockNumber: 10, ts: 100, data: "{}" })).toBe(false);
    expect(db.insertEvent({ agentId: 1, kind: "swap", txHash: "0xaa", logIndex: 2, blockNumber: 10, ts: 100, data: "{}" })).toBe(false);
    // The AUTOINCREMENT sequence survived the rebuild (no id reuse).
    expect(db.activity(7, 10)[0]!.id).toBe(4);
    const idx = db.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'`).all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toContain("events_agent");
    expect(db.swapSender("0xaa", 2)).toEqual({ senderFrom: null, senderAgentId: null, senderWallet: null, senderResolved: 0 });
    db.close();
    const again = new IndexerDb(p); // reopen: no-op
    expect(again.schemaVersion()).toBe(MIGRATIONS.length);
    expect(again.counts().events).toBe(3);
    again.close();
  });
});

describe("M4A(a): attribution at ingest", () => {
  it("M4A(a): swap ingest with a matching action EOA ⇒ sender columns + actionSwap event for the acting agent + pool event unchanged", async () => {
    const { chain, db, w } = setup();
    world(chain);
    chain.txSenders.set(tx, ACTION7); // checksummed: matching is case-insensitive
    await w.poll();

    expect(db.swapSender(tx, 2)).toEqual({ senderFrom: ACTION7.toLowerCase(), senderAgentId: 7, senderWallet: "action", senderResolved: 1 });
    const acts = db.activity(7, 200).filter((e) => e.kind === "actionSwap");
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ txHash: tx, logIndex: 2, blockNumber: 990, ts: Number(BASE_TS + 990n) });
    expect(JSON.parse(acts[0]!.data)).toEqual({ poolId: P1, poolAgentId: 1, wallet: "action", amount0: AMOUNT0.toString(), amount1: "1000000", agentIsCurrency0: true });

    // The pool agent's "swap" row keeps its exact shape; no actionSwap lands on the pool agent.
    expect(kindsOf(db, 1)).not.toContain("actionSwap");
    const poolEv = db.activity(1, 200).find((e) => e.kind === "swap")!;
    expect(JSON.parse(poolEv.data)).toEqual({
      poolId: P1,
      sender: ADDR.factory,
      amount0: AMOUNT0.toString(),
      amount1: "1000000",
      sqrtPriceX96: "1771595571142957102961",
      liquidity: "5",
      tick: -1,
      fee: 10_000,
      agentIsCurrency0: true,
    });

    // Re-scan of the trailing window: already resolved ⇒ no second txFrom, no duplicate rows.
    const before = db.counts();
    expect(chain.txFromCalls).toEqual([tx]);
    chain.head = 1005n;
    await w.poll();
    expect(chain.txFromCalls).toEqual([tx]);
    expect(db.counts()).toEqual(before);
  });

  it("M4A(a): treasury EOA match ⇒ wallet \"treasury\"", async () => {
    const { chain, db, w } = setup();
    world(chain);
    chain.txSenders.set(tx, TREAS7.toLowerCase());
    await w.poll();
    expect(db.swapSender(tx, 2)).toMatchObject({ senderAgentId: 7, senderWallet: "treasury", senderResolved: 1 });
    const act = db.activity(7, 200).find((e) => e.kind === "actionSwap")!;
    expect(JSON.parse(act.data)).toMatchObject({ poolAgentId: 1, wallet: "treasury" });
  });

  it("M4A(a): no matching wallet ⇒ senderFrom stored, resolved, no actionSwap event", async () => {
    const { chain, db, w } = setup();
    world(chain);
    chain.txSenders.set(tx, STRANGER);
    await w.poll();
    expect(db.swapSender(tx, 2)).toEqual({ senderFrom: STRANGER.toLowerCase(), senderAgentId: null, senderWallet: null, senderResolved: 1 });
    expect(countKind(db, "actionSwap")).toBe(0);
    expect(countKind(db, "swap")).toBe(1);
    // Resolved rows leave the backfill queue.
    expect(db.unresolvedSwaps(25)).toEqual([]);
  });

  it("M4A(a): txFrom throw ⇒ swap + pool event still ingest, unresolved, LOUD warn; a later poll's backfill resolves it", async () => {
    const { chain, db, w, log } = setup();
    world(chain);
    chain.txSenders.set(tx, ACTION7);
    chain.failTxFrom = Infinity;
    await w.poll();
    expect(db.swapsSince(1, 0)).toHaveLength(1);
    expect(kindsOf(db, 1)).toContain("swap");
    expect(db.swapSender(tx, 2)?.senderResolved).toBe(0);
    expect(countKind(db, "actionSwap")).toBe(0);
    expect(log.lines.some((l) => l.startsWith("WARN SWAP SENDER UNRESOLVED") && l.includes(tx) && l.includes("mock txFrom failure"))).toBe(true);
    expect(db.kvGet("watcher.nextBlock")).toBe("1001"); // the chunk committed

    chain.failTxFrom = 0;
    await w.poll();
    expect(db.swapSender(tx, 2)).toMatchObject({ senderAgentId: 7, senderWallet: "action", senderResolved: 1 });
    expect(kindsOf(db, 7)).toContain("actionSwap");
  });

  it("M4A(a): the node not knowing the tx (txFrom null) is treated as unresolved + warned", async () => {
    const { chain, db, w, log } = setup();
    world(chain); // no txSenders entry ⇒ null
    await w.poll();
    expect(db.swapSender(tx, 2)?.senderResolved).toBe(0);
    expect(log.lines.some((l) => l.startsWith("WARN SWAP SENDER UNRESOLVED") && l.includes("does not know"))).toBe(true);
  });

  it("M4A(a): self-trade (acting agent == pool agent) ⇒ both \"swap\" and \"actionSwap\" rows on the same log", async () => {
    const { chain, db, w } = setup();
    world(chain);
    chain.txSenders.set(tx, ACTION1);
    await w.poll();
    const rows = db.activity(1, 200).filter((e) => e.txHash === tx);
    expect(rows.map((e) => [e.kind, e.logIndex]).sort()).toEqual([
      ["actionSwap", 2],
      ["swap", 2],
    ]);
    expect(JSON.parse(rows.find((e) => e.kind === "actionSwap")!.data)).toMatchObject({ poolAgentId: 1, wallet: "action" });
  });
});

describe("M4A(a): backfill", () => {
  function seedPreMigration(db: IndexerDb): void {
    db.upsertPool({ poolId: P1, agentId: 1, agentToken: T1, agentIsCurrency0: 1 });
    db.upsertInstanceRegistered({ agentId: 7, treasuryEOA: TREAS7, actionEOA: ACTION7, codeHash: CODE, generation: 1, attestationRef: null, registeredAt: 1 });
    const sw = (txHash: string, blockNumber: number) => ({ txHash, logIndex: 0, poolId: P1, agentId: 1, ts: 1000 + blockNumber, blockNumber, amount0: "-5", amount1: "7", sqrtPriceX96: "1" });
    db.insertSwap(sw("0xold1", 10));
    db.insertSwap(sw("0xold2", 20));
    db.insertSwap(sw("0xold3", 30));
  }

  it("M4A(a): backfill resolves pre-existing unresolved rows oldest first, per-poll cap, idempotently (run twice ⇒ no dupes)", async () => {
    const { chain, db, w } = setup({ senderBackfillPerPoll: 2 });
    seedPreMigration(db);
    chain.txSenders.set("0xold1", ACTION7);
    chain.txSenders.set("0xold2", STRANGER);
    chain.txSenders.set("0xold3", TREAS7);

    expect(await w.backfillSenders()).toBe(2); // cap 2: old1 + old2
    expect(db.swapSender("0xold1", 0)).toMatchObject({ senderAgentId: 7, senderWallet: "action", senderResolved: 1 });
    expect(db.swapSender("0xold2", 0)).toMatchObject({ senderFrom: STRANGER.toLowerCase(), senderAgentId: null, senderResolved: 1 });
    expect(db.swapSender("0xold3", 0)?.senderResolved).toBe(0);

    await w.poll(); // the poll loop runs the backfill after the chunk work
    expect(db.swapSender("0xold3", 0)).toMatchObject({ senderAgentId: 7, senderWallet: "treasury", senderResolved: 1 });
    const acts = db.activity(7, 200).filter((e) => e.kind === "actionSwap");
    expect(acts.map((e) => [e.txHash, JSON.parse(e.data).wallet, e.blockNumber, e.ts])).toEqual([
      ["0xold3", "treasury", 30, 1030],
      ["0xold1", "action", 10, 1010],
    ]);
    expect(JSON.parse(acts[1]!.data)).toEqual({ poolId: P1, poolAgentId: 1, wallet: "action", amount0: "-5", amount1: "7", agentIsCurrency0: true });

    // Run twice more: nothing left to resolve, no duplicate events.
    const before = db.counts();
    expect(await w.backfillSenders()).toBe(0);
    expect(await w.backfillSenders()).toBe(0);
    expect(db.counts()).toEqual(before);

    // Even a forced re-resolution does not duplicate the actionSwap row (unique (txHash, logIndex, kind)).
    db.db.prepare(`UPDATE swaps SET senderResolved = 0`).run();
    expect(await w.backfillSenders()).toBe(2);
    expect(await w.backfillSenders()).toBe(1);
    expect(countKind(db, "actionSwap")).toBe(2);
  });
});

describe("M4A(a): API", () => {
  it("M4A(a): /api/agents/:id/activity serves actionSwap rows untouched", async () => {
    const { chain, db, w } = setup();
    world(chain);
    chain.txSenders.set(tx, ACTION7);
    await w.poll();
    db.upsertAgentRequested({ agentId: 7, configHash: "0xcfg", creator: "0xC", requestTx: "0xr", requestBlock: 1, createdAt: 1, name: "Seven", symbol: "S", imageURI: null });
    const api = new IndexerApi(db, { now: () => BASE_TS + 2000n }, { staleAfterSec: 1800, startBlock: 100n, gatewayUrl: "https://arweave.net" }, memoryLogger());
    const body = api.route("/api/agents/7/activity", new URLSearchParams()) as { agentId: number; events: Array<{ kind: string; txHash: string; logIndex: number; data: Record<string, unknown> }> };
    const act = body.events.find((e) => e.kind === "actionSwap")!;
    expect(act).toMatchObject({ txHash: tx, logIndex: 2 });
    expect(act.data).toEqual({ poolId: P1, poolAgentId: 1, wallet: "action", amount0: AMOUNT0.toString(), amount1: "1000000", agentIsCurrency0: true });
  });
});
