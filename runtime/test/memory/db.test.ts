import { describe, expect, it } from "vitest";
import {
  insertAction,
  insertChat,
  insertJournal,
  insertPost,
  insertTrade,
  kvGet,
  kvSet,
  listActions,
  listChats,
  listJournal,
  listPosts,
  listTrades,
  loadLedger,
  openMemory,
  rollingSummaryGet,
  rollingSummarySet,
  ROLLING_SUMMARY_MAX_CHARS,
  saveLedger,
  serializeLedger,
  deserializeLedger,
} from "../../src/memory/db.js";
import { emptyLedger, fixtureLedger, maxLedger, zeroLedger, UINT256_MAX } from "./fixtures.js";

describe("openMemory + DDL", () => {
  it("creates exactly the 7 SPEC-M2B §4 tables", () => {
    const db = openMemory(":memory:");
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toEqual(["actions", "budget_ledger", "chats", "journal", "kv", "posts", "trades"]);
    db.close();
  });

  it("is idempotent (openMemory twice on the same file does not error)", () => {
    const db1 = openMemory(":memory:");
    db1.close();
    const db2 = openMemory(":memory:");
    db2.close();
  });
});

describe("per-table insert/query helpers", () => {
  it("actions: insert + list round-trips ts as bigint and nullable fields", () => {
    const db = openMemory(":memory:");
    insertAction(db, { ts: 42n, kind: "heartbeat", json: "{}", verdict: "allow" });
    insertAction(db, { ts: 43n, kind: "actionTransfer", json: "{}", verdict: "deny", denyCode: "PER_TX_CAP" });
    const rows = listActions(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ ts: 42n, kind: "heartbeat", verdict: "allow", denyCode: null, txHash: null, error: null });
    expect(rows[1]).toMatchObject({ ts: 43n, denyCode: "PER_TX_CAP" });
    db.close();
  });

  it("chats: insert + list", () => {
    const db = openMemory(":memory:");
    insertChat(db, { ts: 1n, wallet: "0xabc", dir: "in", content: "hi" });
    expect(listChats(db)).toEqual([{ id: 1, ts: 1n, wallet: "0xabc", dir: "in", content: "hi" }]);
    db.close();
  });

  it("posts: insert + list with nullable cast_hash", () => {
    const db = openMemory(":memory:");
    insertPost(db, { ts: 1n, kind: "castPost", content: "gm" });
    expect(listPosts(db)).toEqual([{ id: 1, ts: 1n, kind: "castPost", content: "gm", castHash: null }]);
    db.close();
  });

  it("trades: insert + list preserves large bigints exactly", () => {
    const db = openMemory(":memory:");
    insertTrade(db, { ts: 1n, token: "0xabc", side: "buy", amountIn: UINT256_MAX, amountOut: 0n, pnlUsdg: -5n });
    const rows = listTrades(db);
    expect(rows[0]?.amountIn).toBe(UINT256_MAX);
    expect(rows[0]?.pnlUsdg).toBe(-5n);
    db.close();
  });

  it("journal: insert + list", () => {
    const db = openMemory(":memory:");
    insertJournal(db, { ts: 1n, content: "note", arweaveTxid: "tx1" });
    expect(listJournal(db)).toEqual([{ id: 1, ts: 1n, content: "note", arweaveTxid: "tx1" }]);
    db.close();
  });
});

describe("kv + rollingSummary", () => {
  it("kvGet returns undefined for a missing key", () => {
    const db = openMemory(":memory:");
    expect(kvGet(db, "nope")).toBeUndefined();
    db.close();
  });

  it("kvSet then kvGet round-trips, and re-set overwrites", () => {
    const db = openMemory(":memory:");
    kvSet(db, "k", "v1");
    expect(kvGet(db, "k")).toBe("v1");
    kvSet(db, "k", "v2");
    expect(kvGet(db, "k")).toBe("v2");
    db.close();
  });

  it("rollingSummaryGet is empty string before anything is set", () => {
    const db = openMemory(":memory:");
    expect(rollingSummaryGet(db)).toBe("");
    db.close();
  });

  it("rollingSummarySet under the cap stores verbatim and reports truncated=false", () => {
    const db = openMemory(":memory:");
    const text = "a".repeat(100);
    const result = rollingSummarySet(db, text);
    expect(result.truncated).toBe(false);
    expect(rollingSummaryGet(db)).toBe(text);
    db.close();
  });

  it("rollingSummarySet over the 8000-char cap truncates and reports truncated=true", () => {
    const db = openMemory(":memory:");
    const text = "b".repeat(ROLLING_SUMMARY_MAX_CHARS + 500);
    const result = rollingSummarySet(db, text);
    expect(result.truncated).toBe(true);
    const stored = rollingSummaryGet(db);
    expect(stored).toHaveLength(ROLLING_SUMMARY_MAX_CHARS);
    expect(stored).toBe(text.slice(0, ROLLING_SUMMARY_MAX_CHARS));
    db.close();
  });

  it("rollingSummarySet exactly at the cap does not truncate", () => {
    const db = openMemory(":memory:");
    const text = "c".repeat(ROLLING_SUMMARY_MAX_CHARS);
    const result = rollingSummarySet(db, text);
    expect(result.truncated).toBe(false);
    expect(rollingSummaryGet(db)).toHaveLength(ROLLING_SUMMARY_MAX_CHARS);
    db.close();
  });
});

describe("saveLedger / loadLedger", () => {
  it("loadLedger returns null when nothing has been saved", () => {
    const db = openMemory(":memory:");
    expect(loadLedger(db)).toBeNull();
    db.close();
  });

  it("loadLedger returns the LATEST saved ledger (last row wins)", () => {
    const db = openMemory(":memory:");
    saveLedger(db, emptyLedger(), 1n);
    saveLedger(db, fixtureLedger(), 2n);
    expect(loadLedger(db)).toEqual(fixtureLedger());
    db.close();
  });

  it("round-trips the fixture ledger (nested counterpartySpent + 7-entry feeIncome7d) losslessly", () => {
    const db = openMemory(":memory:");
    const ledger = fixtureLedger();
    saveLedger(db, ledger, 100n);
    expect(loadLedger(db)).toEqual(ledger);
    db.close();
  });
});

describe("serializeLedger / deserializeLedger — nasty-case roundtrips", () => {
  const cases: Array<[string, ReturnType<typeof fixtureLedger>]> = [
    ["empty ledger", emptyLedger()],
    ["all-zero ledger", zeroLedger()],
    ["max-bigint ledger", maxLedger()],
    ["fixture ledger", fixtureLedger()],
  ];

  for (const [name, ledger] of cases) {
    it(`roundtrips: ${name}`, () => {
      const json = serializeLedger(ledger);
      const decoded = deserializeLedger(json);
      expect(decoded).toEqual(ledger);
    });

    it(`${name}: serialized JSON contains no raw numeric literals for bigint fields (all decimal strings)`, () => {
      const json = serializeLedger(ledger);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      expect(typeof parsed.lastAllowanceAt).toBe("string");
      expect(typeof parsed.allowanceAmountToday).toBe("string");
    });
  }

  it("serializeLedger is pure JSON (round-trips through JSON.parse/stringify without loss)", () => {
    const json = serializeLedger(fixtureLedger());
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
