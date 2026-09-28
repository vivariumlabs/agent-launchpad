import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IndexerDb, MIGRATIONS, TABLES } from "../src/db.js";

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "indexer-db-"));
  dirs.push(d);
  return join(d, "i.sqlite");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ev = (logIndex: number) => ({ agentId: 7, kind: "swap", txHash: "0xaa", logIndex, blockNumber: 10, ts: 100, data: "{}" });

describe("migrations", () => {
  it("fresh db lands on the latest version with every table; reopen is a no-op that keeps data", () => {
    const p = tmpDb();
    const db = new IndexerDb(p);
    expect(db.schemaVersion()).toBe(MIGRATIONS.length);
    expect(Object.keys(db.counts()).sort()).toEqual([...TABLES].sort());
    expect(db.db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.kvSet("watcher.nextBlock", "123");
    db.insertEvent(ev(0));
    db.close();
    const again = new IndexerDb(p);
    expect(again.schemaVersion()).toBe(MIGRATIONS.length);
    expect(again.kvGet("watcher.nextBlock")).toBe("123");
    expect(again.counts().events).toBe(1);
    again.close();
  });
});

describe("idempotent upserts keyed (txHash, logIndex)", () => {
  it("events / swaps / curve trades / fees ignore a replay", () => {
    const db = new IndexerDb(":memory:");
    expect(db.insertEvent(ev(1))).toBe(true);
    expect(db.insertEvent(ev(1))).toBe(false);
    expect(db.insertEvent(ev(2))).toBe(true);
    const swap = { txHash: "0xbb", logIndex: 3, poolId: "0xp", agentId: 7, ts: 1, blockNumber: 2, amount0: "-5", amount1: "170141183460469231731687303715884105727", sqrtPriceX96: "79228162514264337593543950336" };
    expect(db.insertSwap(swap)).toBe(true);
    expect(db.insertSwap({ ...swap, amount0: "999" })).toBe(false);
    expect(db.latestSwap(7)?.amount1).toBe("170141183460469231731687303715884105727"); // int128 max survives as TEXT
    expect(db.latestSwap(7)?.amount0).toBe("-5");
    const trade = { txHash: "0xcc", logIndex: 0, agentId: 7, side: "buy" as const, trader: "0x1", usdg: "1", tokens: "2", fee: "0", ts: 1, blockNumber: 1 };
    expect(db.insertCurveTrade(trade)).toBe(true);
    expect(db.insertCurveTrade(trade)).toBe(false);
    const fee = { txHash: "0xdd", logIndex: 0, agentId: 7, poolId: "0xp", buybackLeg: "1", treasuryLeg: "1", royaltyLeg: "1", converted: "0", ts: 1, blockNumber: 1 };
    expect(db.insertFee(fee)).toBe(true);
    expect(db.insertFee(fee)).toBe(false);
    expect(db.counts()).toMatchObject({ events: 2, swaps: 1, trades_curve: 1, fees: 1 });
    db.close();
  });

  it("agent state only moves forward; request fields refill without resetting state", () => {
    const db = new IndexerDb(":memory:");
    const req = { agentId: 2, configHash: "0xc", creator: "0xA", requestTx: "0x1", requestBlock: 5, createdAt: 50, name: null, symbol: null, imageURI: null };
    db.upsertAgentRequested(req);
    expect(db.agent(2)?.state).toBe("requested");
    db.markAgentLive({ agentId: 2, token: "0xT", curve: "0xC", totalSupply: "10", name: "Two", symbol: "TWO", imageURI: "ar://x" });
    db.upsertAgentRequested({ ...req, name: "ignored" });
    expect(db.agent(2)).toMatchObject({ state: "live", name: "Two", symbol: "TWO", token: "0xT", totalSupply: "10", requestTx: "0x1" });
    db.advanceState(2, "graduated");
    db.advanceState(2, "live");
    db.advanceState(2, "cancelled");
    expect(db.agent(2)?.state).toBe("graduated");
    db.advanceState(9, "cancelled"); // unknown agent ⇒ bare row
    expect(db.agent(9)?.state).toBe("cancelled");
    expect(db.curveMap().get("0xc")).toBe(2);
    db.close();
  });

  it("instances: generation + heartbeat forward-only; reconcile is authoritative for fields", () => {
    const db = new IndexerDb(":memory:");
    const reg = { agentId: 7, treasuryEOA: "0xT", actionEOA: "0xA", codeHash: "0xh", generation: 2, attestationRef: "ref2", registeredAt: 200 };
    db.upsertInstanceRegistered(reg);
    db.upsertInstanceRegistered({ ...reg, generation: 1, attestationRef: "ref1", registeredAt: 100 }); // older replay
    expect(db.instance(7)).toMatchObject({ generation: 2, attestationRef: "ref2", lastHeartbeat: 200 });
    expect(db.heartbeat(7, 150)).toBe(true);
    expect(db.instance(7)?.lastHeartbeat).toBe(200);
    db.heartbeat(7, 300);
    expect(db.instance(7)?.lastHeartbeat).toBe(300);
    expect(db.heartbeat(8, 300)).toBe(false);
    db.reconcileInstance({ agentId: 7, treasuryEOA: "0xT", actionEOA: "0xA", codeHash: "0xh", attestationRef: "ref3", lastHeartbeat: 250, generation: 3 });
    expect(db.instance(7)).toMatchObject({ generation: 3, attestationRef: "ref3", lastHeartbeat: 300 });
    db.close();
  });

  it("journal pin deletes other-owner rows and verifies the pinned owner's; pins once", () => {
    const db = new IndexerDb(":memory:");
    const j = (itemId: string, owner: string) => ({ itemId, agentId: 7, ts: 1, kind: "journal", text: "t", raw: "{}", fetchedAt: 1, owner, unverified: 1, blockHeight: null });
    db.insertJournal(j("a".repeat(43), "OWNER_A"));
    db.insertJournal(j("b".repeat(43), "OWNER_B"));
    db.insertJournal({ ...j("c".repeat(43), "OWNER_B"), agentId: 8 });
    expect(db.pinJournalOwner({ agentId: 7, owner: "OWNER_A", attestationItem: "x", pinnedAt: 5 })).toBe(1);
    expect(db.journal(7, 10).map((r) => [r.owner, r.unverified])).toEqual([["OWNER_A", 0]]);
    expect(db.journal(8, 10)).toHaveLength(1); // other agents untouched
    db.pinJournalOwner({ agentId: 7, owner: "OWNER_B", attestationItem: "y", pinnedAt: 6 });
    expect(db.journalOwner(7)?.owner).toBe("OWNER_A");
    db.close();
  });
});
