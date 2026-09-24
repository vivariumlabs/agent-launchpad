// SPEC-M2B §4 (Job B scope only). No Date.now/Math.random anywhere in this
// module — all timestamps are `ts: bigint` / `now: bigint` parameters.

import DatabaseCtor from "better-sqlite3";
import type { Address } from "viem";
import type { BudgetLedger, TreasurySpentKey, UnixSeconds } from "../policy/types.js";

export type MemoryDb = DatabaseCtor.Database;

/**
 * Opens (creating if needed) the memory SQLite database at `path`
 * (":memory:" supported for tests) and ensures the 7 SPEC-M2B §4 tables
 * exist.
 */
export function openMemory(path: string): MemoryDb {
  // Deliberately NOT WAL journal mode: a WAL-mode db's serialize()/deserialize
  // round-trip (snapshot.ts) reopens the restored bytes as a fresh in-memory
  // handle with no companion -wal/-shm files, which WAL mode cannot open
  // ("unable to open database file"). Default (rollback-journal) mode
  // serializes/deserializes as a single self-contained file.
  const db = new DatabaseCtor(path);
  db.exec(DDL);
  return db;
}

const DDL = `
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  json TEXT NOT NULL,
  verdict TEXT NOT NULL,
  deny_code TEXT,
  tx_hash TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  wallet TEXT NOT NULL,
  dir TEXT NOT NULL,
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  cast_hash TEXT
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  token TEXT NOT NULL,
  side TEXT NOT NULL,
  amount_in TEXT NOT NULL,
  amount_out TEXT NOT NULL,
  pnl_usdg TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  content TEXT NOT NULL,
  arweave_txid TEXT
);

CREATE TABLE IF NOT EXISTS budget_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

export interface NewActionRow {
  ts: UnixSeconds;
  kind: string;
  json: string;
  verdict: string;
  denyCode?: string | null;
  txHash?: string | null;
  error?: string | null;
}

export interface ActionRow extends NewActionRow {
  id: number;
  denyCode: string | null;
  txHash: string | null;
  error: string | null;
}

export function insertAction(db: MemoryDb, row: NewActionRow): number {
  const stmt = db.prepare(
    "INSERT INTO actions (ts, kind, json, verdict, deny_code, tx_hash, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const info = stmt.run(
    row.ts.toString(10),
    row.kind,
    row.json,
    row.verdict,
    row.denyCode ?? null,
    row.txHash ?? null,
    row.error ?? null,
  );
  return Number(info.lastInsertRowid);
}

/**
 * Rewrites the json of the LATEST actions row with this kind + json (post-hoc annotation, e.g. x402
 * settlement; no schema change). Returns the number of rows changed (0 or 1).
 */
export function updateLatestActionJson(db: MemoryDb, kind: string, fromJson: string, toJson: string): number {
  const info = db
    .prepare("UPDATE actions SET json = ? WHERE id = (SELECT id FROM actions WHERE kind = ? AND json = ? ORDER BY id DESC LIMIT 1)")
    .run(toJson, kind, fromJson);
  return Number(info.changes);
}

interface ActionRowRaw {
  id: number;
  ts: string;
  kind: string;
  json: string;
  verdict: string;
  deny_code: string | null;
  tx_hash: string | null;
  error: string | null;
}

function rowFromRaw(raw: ActionRowRaw): ActionRow {
  return {
    id: raw.id,
    ts: BigInt(raw.ts),
    kind: raw.kind,
    json: raw.json,
    verdict: raw.verdict,
    denyCode: raw.deny_code,
    txHash: raw.tx_hash,
    error: raw.error,
  };
}

export function listActions(db: MemoryDb): ActionRow[] {
  const rows = db.prepare("SELECT * FROM actions ORDER BY id ASC").all() as ActionRowRaw[];
  return rows.map(rowFromRaw);
}

// ---------------------------------------------------------------------------
// chats
// ---------------------------------------------------------------------------

export interface NewChatRow {
  ts: UnixSeconds;
  wallet: string;
  dir: string;
  content: string;
}

export interface ChatRow extends NewChatRow {
  id: number;
}

export function insertChat(db: MemoryDb, row: NewChatRow): number {
  const info = db
    .prepare("INSERT INTO chats (ts, wallet, dir, content) VALUES (?, ?, ?, ?)")
    .run(row.ts.toString(10), row.wallet, row.dir, row.content);
  return Number(info.lastInsertRowid);
}

interface ChatRowRaw {
  id: number;
  ts: string;
  wallet: string;
  dir: string;
  content: string;
}

export function listChats(db: MemoryDb): ChatRow[] {
  const rows = db.prepare("SELECT * FROM chats ORDER BY id ASC").all() as ChatRowRaw[];
  return rows.map((raw) => ({ id: raw.id, ts: BigInt(raw.ts), wallet: raw.wallet, dir: raw.dir, content: raw.content }));
}

// ---------------------------------------------------------------------------
// posts
// ---------------------------------------------------------------------------

export interface NewPostRow {
  ts: UnixSeconds;
  kind: string;
  content: string;
  castHash?: string | null;
}

export interface PostRow extends NewPostRow {
  id: number;
  castHash: string | null;
}

export function insertPost(db: MemoryDb, row: NewPostRow): number {
  const info = db
    .prepare("INSERT INTO posts (ts, kind, content, cast_hash) VALUES (?, ?, ?, ?)")
    .run(row.ts.toString(10), row.kind, row.content, row.castHash ?? null);
  return Number(info.lastInsertRowid);
}

interface PostRowRaw {
  id: number;
  ts: string;
  kind: string;
  content: string;
  cast_hash: string | null;
}

export function listPosts(db: MemoryDb): PostRow[] {
  const rows = db.prepare("SELECT * FROM posts ORDER BY id ASC").all() as PostRowRaw[];
  return rows.map((raw) => ({
    id: raw.id,
    ts: BigInt(raw.ts),
    kind: raw.kind,
    content: raw.content,
    castHash: raw.cast_hash,
  }));
}

// ---------------------------------------------------------------------------
// trades
// ---------------------------------------------------------------------------

export interface NewTradeRow {
  ts: UnixSeconds;
  token: string;
  side: string;
  amountIn: bigint;
  amountOut: bigint;
  pnlUsdg: bigint;
}

export interface TradeRow extends NewTradeRow {
  id: number;
}

export function insertTrade(db: MemoryDb, row: NewTradeRow): number {
  const info = db
    .prepare("INSERT INTO trades (ts, token, side, amount_in, amount_out, pnl_usdg) VALUES (?, ?, ?, ?, ?, ?)")
    .run(row.ts.toString(10), row.token, row.side, row.amountIn.toString(10), row.amountOut.toString(10), row.pnlUsdg.toString(10));
  return Number(info.lastInsertRowid);
}

interface TradeRowRaw {
  id: number;
  ts: string;
  token: string;
  side: string;
  amount_in: string;
  amount_out: string;
  pnl_usdg: string;
}

export function listTrades(db: MemoryDb): TradeRow[] {
  const rows = db.prepare("SELECT * FROM trades ORDER BY id ASC").all() as TradeRowRaw[];
  return rows.map((raw) => ({
    id: raw.id,
    ts: BigInt(raw.ts),
    token: raw.token,
    side: raw.side,
    amountIn: BigInt(raw.amount_in),
    amountOut: BigInt(raw.amount_out),
    pnlUsdg: BigInt(raw.pnl_usdg),
  }));
}

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

export interface NewJournalRow {
  ts: UnixSeconds;
  content: string;
  arweaveTxid?: string | null;
}

export interface JournalRow extends NewJournalRow {
  id: number;
  arweaveTxid: string | null;
}

export function insertJournal(db: MemoryDb, row: NewJournalRow): number {
  const info = db
    .prepare("INSERT INTO journal (ts, content, arweave_txid) VALUES (?, ?, ?)")
    .run(row.ts.toString(10), row.content, row.arweaveTxid ?? null);
  return Number(info.lastInsertRowid);
}

interface JournalRowRaw {
  id: number;
  ts: string;
  content: string;
  arweave_txid: string | null;
}

export function listJournal(db: MemoryDb): JournalRow[] {
  const rows = db.prepare("SELECT * FROM journal ORDER BY id ASC").all() as JournalRowRaw[];
  return rows.map((raw) => ({ id: raw.id, ts: BigInt(raw.ts), content: raw.content, arweaveTxid: raw.arweave_txid }));
}

// ---------------------------------------------------------------------------
// budget_ledger — latest row = current BudgetLedger
// ---------------------------------------------------------------------------

interface SerializedBudgetLedger {
  lastAllowanceAt: string;
  allowanceAmountToday: string;
  dayKey: string;
  inferenceSpent: { pulse: string; chat: string; social: string };
  treasurySpent: Record<string, string>;
  counterpartySpent: Record<string, Record<string, string>>;
  feeIncome7d: string[];
  castPostsToday: string;
  castRepliesToday: string;
  journalToday: string;
  /** SPEC-M3D §3d; absent in pre-M3D rows/snapshots ⇒ 0. */
  fcUserDataToday?: string;
}

/** BudgetLedger -> JSON string, all bigints as decimal strings (lossless). */
export function serializeLedger(ledger: BudgetLedger): string {
  const treasurySpent: Record<string, string> = {};
  for (const [key, value] of Object.entries(ledger.treasurySpent)) {
    if (value === undefined) continue;
    treasurySpent[key] = value.toString(10);
  }

  const counterpartySpent: Record<string, Record<string, string>> = {};
  for (const [addr, assets] of Object.entries(ledger.counterpartySpent)) {
    const encodedAssets: Record<string, string> = {};
    for (const [assetKey, amount] of Object.entries(assets)) {
      encodedAssets[assetKey] = amount.toString(10);
    }
    counterpartySpent[addr] = encodedAssets;
  }

  const serialized: SerializedBudgetLedger = {
    lastAllowanceAt: ledger.lastAllowanceAt.toString(10),
    allowanceAmountToday: ledger.allowanceAmountToday.toString(10),
    dayKey: ledger.dayKey,
    inferenceSpent: {
      pulse: ledger.inferenceSpent.pulse.toString(10),
      chat: ledger.inferenceSpent.chat.toString(10),
      social: ledger.inferenceSpent.social.toString(10),
    },
    treasurySpent,
    counterpartySpent,
    feeIncome7d: ledger.feeIncome7d.map((v) => v.toString(10)),
    castPostsToday: ledger.castPostsToday.toString(10),
    castRepliesToday: ledger.castRepliesToday.toString(10),
    journalToday: ledger.journalToday.toString(10),
    fcUserDataToday: ledger.fcUserDataToday.toString(10),
  };
  return JSON.stringify(serialized);
}

/** JSON string (from serializeLedger) -> BudgetLedger. Inverse of serializeLedger. */
export function deserializeLedger(json: string): BudgetLedger {
  const parsed = JSON.parse(json) as SerializedBudgetLedger;

  const treasurySpent: Partial<Record<TreasurySpentKey, bigint>> = {};
  for (const [key, value] of Object.entries(parsed.treasurySpent)) {
    treasurySpent[key as TreasurySpentKey] = BigInt(value);
  }

  const counterpartySpent: Record<Address, Record<string, bigint>> = {};
  for (const [addr, assets] of Object.entries(parsed.counterpartySpent)) {
    const decodedAssets: Record<string, bigint> = {};
    for (const [assetKey, amount] of Object.entries(assets)) {
      decodedAssets[assetKey] = BigInt(amount);
    }
    counterpartySpent[addr as Address] = decodedAssets;
  }

  return {
    lastAllowanceAt: BigInt(parsed.lastAllowanceAt),
    allowanceAmountToday: BigInt(parsed.allowanceAmountToday),
    dayKey: parsed.dayKey,
    inferenceSpent: {
      pulse: BigInt(parsed.inferenceSpent.pulse),
      chat: BigInt(parsed.inferenceSpent.chat),
      social: BigInt(parsed.inferenceSpent.social),
    },
    treasurySpent,
    counterpartySpent,
    feeIncome7d: parsed.feeIncome7d.map((v) => BigInt(v)),
    castPostsToday: BigInt(parsed.castPostsToday),
    castRepliesToday: BigInt(parsed.castRepliesToday),
    journalToday: BigInt(parsed.journalToday),
    fcUserDataToday: parsed.fcUserDataToday !== undefined ? BigInt(parsed.fcUserDataToday) : 0n,
  };
}

export function saveLedger(db: MemoryDb, ledger: BudgetLedger, ts: UnixSeconds): void {
  db.prepare("INSERT INTO budget_ledger (ts, json) VALUES (?, ?)").run(ts.toString(10), serializeLedger(ledger));
}

export function loadLedger(db: MemoryDb): BudgetLedger | null {
  const row = db.prepare("SELECT json FROM budget_ledger ORDER BY id DESC LIMIT 1").get() as { json: string } | undefined;
  if (!row) return null;
  return deserializeLedger(row.json);
}

// ---------------------------------------------------------------------------
// kv
// ---------------------------------------------------------------------------

export function kvGet(db: MemoryDb, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(db: MemoryDb, key: string, value: string): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

// ---------------------------------------------------------------------------
// rolling self-summary (kv-backed, capped per SPEC-M2B §4)
// ---------------------------------------------------------------------------

const ROLLING_SUMMARY_KEY = "rollingSummary";
export const ROLLING_SUMMARY_MAX_CHARS = 8000;

export function rollingSummaryGet(db: MemoryDb): string {
  return kvGet(db, ROLLING_SUMMARY_KEY) ?? "";
}

export interface RollingSummarySetResult {
  truncated: boolean;
}

export function rollingSummarySet(db: MemoryDb, text: string): RollingSummarySetResult {
  const truncated = text.length > ROLLING_SUMMARY_MAX_CHARS;
  const stored = truncated ? text.slice(0, ROLLING_SUMMARY_MAX_CHARS) : text;
  kvSet(db, ROLLING_SUMMARY_KEY, stored);
  return { truncated };
}
