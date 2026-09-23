// SPEC-M2C §1 step 2 — per-wallet chat rate limits: cfg.chatPerHour (20) over a sliding hour
// and cfg.chatPerDay (100) per UTC day. Source of truth = `chats` row counts (dir 'in').
// Check + insert of the user row run inside ONE better-sqlite3 IMMEDIATE transaction, so
// concurrent requests can never exceed the cap (a single Node process already serializes the
// synchronous calls; the transaction keeps it correct across connections too).
// Also: this wallet's history query for the chat context (strictly WHERE wallet = ?).

import type { MemoryDb } from "../memory/db.js";
import type { UnixSeconds } from "../policy/types.js";

export const HOUR_SEC = 3_600n;
export const DAY_SEC = 86_400n;

export interface RateLimits {
  perHour: number;
  perDay: number;
}

export type RateResult =
  | { ok: true; rowId: number }
  | { ok: false; window: "hour" | "day"; retryAfterSec: bigint };

function dayStartOf(now: UnixSeconds): bigint {
  const r = now % DAY_SEC;
  return now - (r < 0n ? r + DAY_SEC : r);
}

function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  return 0n;
}

/**
 * Atomically: count this wallet's 'in' rows in the sliding hour (ts > now − 3600) and in the
 * current UTC day (ts ≥ dayStart); if either count is at its cap ⇒ refuse (no insert);
 * else insert the 'in' row. Rows with ts in the future (clock rewind) count conservatively.
 */
export function checkAndInsertIn(db: MemoryDb, wallet: string, content: string, now: UnixSeconds, limits: RateLimits): RateResult {
  const w = wallet.toLowerCase();
  const hourFrom = now - HOUR_SEC;
  const dayStart = dayStartOf(now);
  const countHour = db.prepare(
    "SELECT COUNT(*) AS n, MIN(CAST(ts AS INTEGER)) AS oldest FROM chats WHERE wallet = ? AND dir = 'in' AND CAST(ts AS INTEGER) > ?",
  );
  const countDay = db.prepare("SELECT COUNT(*) AS n FROM chats WHERE wallet = ? AND dir = 'in' AND CAST(ts AS INTEGER) >= ?");
  const insert = db.prepare("INSERT INTO chats (ts, wallet, dir, content) VALUES (?, ?, 'in', ?)");

  const tx = db.transaction((): RateResult => {
    const h = countHour.get(w, hourFrom) as { n: number; oldest: unknown };
    if (h.n >= limits.perHour) {
      const oldest = h.oldest === null ? now : toBig(h.oldest);
      const retry = oldest + HOUR_SEC - now;
      return { ok: false, window: "hour", retryAfterSec: retry > 0n ? retry : 1n };
    }
    const d = countDay.get(w, dayStart) as { n: number };
    if (d.n >= limits.perDay) {
      return { ok: false, window: "day", retryAfterSec: dayStart + DAY_SEC - now };
    }
    const info = insert.run(now.toString(10), w, content);
    return { ok: true, rowId: Number(info.lastInsertRowid) };
  });
  return tx.immediate();
}

export interface HistoryRow {
  dir: "in" | "out";
  content: string;
}

/**
 * THIS wallet's last `maxExchanges` exchanges (≤ 2 × maxExchanges rows of dir in|out) strictly
 * before row `beforeId`, oldest first. The WHERE wallet = ? clause is the isolation boundary
 * (03 §5: never another wallet's chats).
 */
export function walletHistory(db: MemoryDb, wallet: string, beforeId: number, maxExchanges: number): HistoryRow[] {
  if (maxExchanges <= 0) return [];
  const rows = db
    .prepare("SELECT dir, content FROM chats WHERE wallet = ? AND dir IN ('in', 'out') AND id < ? ORDER BY id DESC LIMIT ?")
    .all(wallet.toLowerCase(), beforeId, maxExchanges * 2) as Array<{ dir: string; content: string }>;
  return rows.reverse().map((r) => ({ dir: r.dir === "out" ? "out" : "in", content: r.content }));
}
