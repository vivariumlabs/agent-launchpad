// Shared fixtures for test/memory/*.test.ts. Not part of src/memory — test
// code is free to use Date.now/Math.random-style nondeterminism (it doesn't
// here, but the src/memory "no wall clock" rule only binds src/memory).

import type { Address } from "viem";
import type { BudgetLedger } from "../../src/policy/types.js";
import {
  insertAction,
  insertChat,
  insertJournal,
  insertPost,
  insertTrade,
  kvSet,
  rollingSummarySet,
  saveLedger,
  type MemoryDb,
} from "../../src/memory/db.js";

const ADDR_1: Address = "0x1111111111111111111111111111111111111a";
const ADDR_2: Address = "0x2222222222222222222222222222222222222b";
const ADDR_3: Address = "0x3333333333333333333333333333333333333c";

export const UINT256_MAX = 2n ** 256n - 1n;

/** A BudgetLedger with nested counterpartySpent + a full 7-entry feeIncome7d. */
export function fixtureLedger(): BudgetLedger {
  return {
    lastAllowanceAt: 1_700_000_000n,
    allowanceAmountToday: 500_000_000n,
    dayKey: "2026-09-23",
    inferenceSpent: { pulse: 1_234_567n, chat: 89_000n, social: 0n },
    treasurySpent: {
      oysterRental: 10_000_000n,
      acrossBridge: 5_000_000n,
      "gasTopUp:rh": 1_000_000_000_000_000n,
      "gasTopUp:base": 2_000_000_000_000_000n,
    },
    counterpartySpent: {
      [ADDR_1.toLowerCase()]: { USDG: 100_000_000n, ETH: 2_000_000_000_000_000n },
      [ADDR_2.toLowerCase()]: { USDG: 0n },
      [ADDR_3.toLowerCase()]: { USDG: UINT256_MAX },
    },
    feeIncome7d: [1_000_000n, 2_000_000n, 0n, 3_500_000n, 0n, 999_999n, 42n],
    castPostsToday: 3n,
    castRepliesToday: 12n,
    journalToday: 1n,
    fcUserDataToday: 2n, // SPEC-M3D §3d
  };
}

export function emptyLedger(): BudgetLedger {
  return {
    lastAllowanceAt: 0n,
    allowanceAmountToday: 0n,
    dayKey: "1970-01-01",
    inferenceSpent: { pulse: 0n, chat: 0n, social: 0n },
    treasurySpent: {},
    counterpartySpent: {},
    feeIncome7d: [],
    castPostsToday: 0n,
    castRepliesToday: 0n,
    journalToday: 0n,
    fcUserDataToday: 0n, // SPEC-M3D §3d
  };
}

export function zeroLedger(): BudgetLedger {
  return {
    lastAllowanceAt: 0n,
    allowanceAmountToday: 0n,
    dayKey: "2026-01-01",
    inferenceSpent: { pulse: 0n, chat: 0n, social: 0n },
    treasurySpent: { oysterRental: 0n, "gasTopUp:rh": 0n },
    counterpartySpent: { [ADDR_1.toLowerCase()]: { USDG: 0n, ETH: 0n } },
    feeIncome7d: [0n, 0n, 0n, 0n, 0n, 0n, 0n],
    castPostsToday: 0n,
    castRepliesToday: 0n,
    journalToday: 0n,
    fcUserDataToday: 0n, // SPEC-M3D §3d
  };
}

export function maxLedger(): BudgetLedger {
  return {
    lastAllowanceAt: UINT256_MAX,
    allowanceAmountToday: UINT256_MAX,
    dayKey: "9999-12-31",
    inferenceSpent: { pulse: UINT256_MAX, chat: UINT256_MAX, social: UINT256_MAX },
    treasurySpent: { oysterRental: UINT256_MAX, "gasTopUp:arbitrum": UINT256_MAX },
    counterpartySpent: { [ADDR_1.toLowerCase()]: { USDG: UINT256_MAX } },
    feeIncome7d: [UINT256_MAX, UINT256_MAX, UINT256_MAX, UINT256_MAX, UINT256_MAX, UINT256_MAX, UINT256_MAX],
    castPostsToday: UINT256_MAX,
    castRepliesToday: UINT256_MAX,
    journalToday: UINT256_MAX,
    fcUserDataToday: UINT256_MAX, // SPEC-M3D §3d
  };
}

/** Populates all 7 tables (actions, chats, posts, trades, journal, budget_ledger, kv) with fixture rows. */
export function populateAllTables(db: MemoryDb): void {
  insertAction(db, {
    ts: 1_700_000_001n,
    kind: "heartbeat",
    json: '{"kind":"heartbeat"}',
    verdict: "allow",
    denyCode: null,
    txHash: "0xabc123",
    error: null,
  });
  insertAction(db, {
    ts: 1_700_000_002n,
    kind: "actionTransfer",
    json: '{"kind":"actionTransfer","amount":"1000"}',
    verdict: "deny",
    denyCode: "PER_TX_CAP",
    txHash: null,
    error: null,
  });

  insertChat(db, { ts: 1_700_000_003n, wallet: ADDR_1, dir: "in", content: "hello agent" });
  insertChat(db, { ts: 1_700_000_004n, wallet: ADDR_1, dir: "out", content: "hello human" });

  insertPost(db, { ts: 1_700_000_005n, kind: "castPost", content: "gm", castHash: "0xdeadbeef" });
  insertPost(db, { ts: 1_700_000_006n, kind: "castReply", content: "gm to you too", castHash: null });

  insertTrade(db, {
    ts: 1_700_000_007n,
    token: "0x4444444444444444444444444444444444444d",
    side: "buy",
    amountIn: 1_000_000n,
    amountOut: 999_000n,
    pnlUsdg: -1_000n,
  });
  insertTrade(db, {
    ts: 1_700_000_008n,
    token: "0x4444444444444444444444444444444444444d",
    side: "sell",
    amountIn: UINT256_MAX,
    amountOut: 0n,
    pnlUsdg: 0n,
  });

  insertJournal(db, { ts: 1_700_000_009n, content: "day one notes", arweaveTxid: "tx-abc" });
  insertJournal(db, { ts: 1_700_000_010n, content: "day two notes", arweaveTxid: null });

  saveLedger(db, fixtureLedger(), 1_700_000_011n);

  kvSet(db, "someKey", "someValue");
  kvSet(db, "lastHeartbeatAt", "1700000001");
  rollingSummarySet(db, "the agent has been doing fine so far.");
}

export interface TableDump {
  actions: unknown[];
  chats: unknown[];
  posts: unknown[];
  trades: unknown[];
  journal: unknown[];
  budgetLedgerJson: string[];
  kv: unknown[];
}

/** Dumps every table (raw rows, as text, so bigints stay decimal strings and compare exactly). */
export function dumpAllTables(db: MemoryDb): TableDump {
  return {
    actions: db.prepare("SELECT * FROM actions ORDER BY id ASC").all(),
    chats: db.prepare("SELECT * FROM chats ORDER BY id ASC").all(),
    posts: db.prepare("SELECT * FROM posts ORDER BY id ASC").all(),
    trades: db.prepare("SELECT * FROM trades ORDER BY id ASC").all(),
    journal: db.prepare("SELECT * FROM journal ORDER BY id ASC").all(),
    budgetLedgerJson: (db.prepare("SELECT json FROM budget_ledger ORDER BY id ASC").all() as { json: string }[]).map(
      (r) => r.json,
    ),
    kv: db.prepare("SELECT * FROM kv ORDER BY key ASC").all(),
  };
}
