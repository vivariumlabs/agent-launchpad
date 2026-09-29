// SPEC-M4A §1 db.ts — better-sqlite3 wrapper, WAL, migrations-in-code (genesis/src/db.ts pattern;
// versioned via PRAGMA user_version so every later schema change is an appended migration).
//
// Money / on-chain integers are stored as base-10 TEXT (bigint end-to-end; int128 swap deltas do
// not fit SQLite's 64-bit INTEGER). Block numbers, log indexes and unix-second timestamps are
// INTEGER. Every chain-derived row is keyed by (txHash, logIndex) — events by (txHash, logIndex,
// kind) since schema v3 — and written INSERT OR IGNORE, so a
// re-scan (reorg window, crash replay) is idempotent. The db seam is deliberately narrow (plain
// methods, no SQL outside this file) so a Postgres adapter is a deploy-time task (SPEC-M4A §0).

import Database from "better-sqlite3";

export type AgentState = "requested" | "live" | "cancelled" | "graduated";

/** Forward-only state rank: a re-scanned older event never regresses an agent. */
const STATE_RANK: Record<AgentState, number> = { requested: 0, live: 1, cancelled: 1, graduated: 2 };

export interface AgentRow {
  agentId: number;
  name: string | null;
  symbol: string | null;
  imageURI: string | null;
  creator: string | null;
  configHash: string | null;
  token: string | null;
  curve: string | null;
  poolId: string | null;
  /** Agent token totalSupply (base units) read once at AgentLive. */
  totalSupply: string | null;
  state: AgentState;
  requestTx: string | null;
  requestBlock: number | null;
  createdAt: number | null;
}

export interface InstanceRow {
  agentId: number;
  treasuryEOA: string;
  actionEOA: string;
  codeHash: string;
  attestationRef: string | null;
  lastHeartbeat: number;
  generation: number;
}

export interface EventInsert {
  agentId: number | null;
  kind: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  ts: number;
  /** JSON-encoded (bigints already stringified). */
  data: string;
}

export interface EventRow extends EventInsert {
  id: number;
}

export interface PoolRow {
  poolId: string;
  agentId: number;
  agentToken: string;
  /** 1 ⇔ the agent token is currency0 (USDG is currency1). */
  agentIsCurrency0: number;
}

export interface SwapRow {
  txHash: string;
  logIndex: number;
  poolId: string;
  agentId: number;
  ts: number;
  blockNumber: number;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
}

export interface CurveTradeRow {
  txHash: string;
  logIndex: number;
  agentId: number;
  side: "buy" | "sell";
  trader: string;
  usdg: string;
  tokens: string;
  fee: string;
  ts: number;
  blockNumber: number;
}

export interface FeeRow {
  txHash: string;
  logIndex: number;
  agentId: number;
  poolId: string;
  buybackLeg: string;
  treasuryLeg: string;
  royaltyLeg: string;
  converted: string;
  ts: number;
  blockNumber: number;
}

export interface BalanceRow {
  agentId: number;
  treasuryUsdg: string;
  treasuryRhEth: string;
  actionUsdg: string;
  actionRhEth: string;
  actionToken: string | null;
  updatedAt: number;
}

export interface JournalRow {
  itemId: string;
  agentId: number;
  ts: number;
  kind: string;
  text: string;
  raw: string;
  fetchedAt: number;
  owner: string;
  unverified: number;
  blockHeight: number | null;
}

export interface JournalOwnerRow {
  agentId: number;
  owner: string;
  attestationItem: string;
  pinnedAt: number;
}

/** SPEC-M4B §1b check outcome. `skip` = not applicable (drill ref / no release table); `pending` = not yet decidable (transport, not indexed). */
export type CheckStatus = "pass" | "fail" | "pending" | "skip";

/** SPEC-M4B §1b check names, in evaluation order (the attestation_checks columns). */
export const CHECK_NAMES = ["refShape", "itemFound", "reportParses", "eoasMatch", "configHashMatch", "imageIdMatch", "releaseMatch"] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export interface AttestationCheckRow {
  agentId: number;
  verifiedAt: number;
  refShape: CheckStatus;
  itemFound: CheckStatus;
  reportParses: CheckStatus;
  eoasMatch: CheckStatus;
  configHashMatch: CheckStatus;
  imageIdMatch: CheckStatus;
  releaseMatch: CheckStatus;
  releaseVersion: string | null;
  /** JSON-encoded verify.ts VerifyDetail. */
  detail: string;
}

/** Append-only; index = resulting user_version − 1. Never edit a shipped entry. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE cursor (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE agents (
    agentId INTEGER PRIMARY KEY,
    name TEXT, symbol TEXT, imageURI TEXT, creator TEXT, configHash TEXT,
    token TEXT, curve TEXT, poolId TEXT, totalSupply TEXT,
    state TEXT NOT NULL,
    requestTx TEXT, requestBlock INTEGER, createdAt INTEGER
  );
  CREATE INDEX agents_curve ON agents (curve);
  CREATE TABLE instances (
    agentId INTEGER PRIMARY KEY,
    treasuryEOA TEXT NOT NULL, actionEOA TEXT NOT NULL, codeHash TEXT NOT NULL,
    attestationRef TEXT, lastHeartbeat INTEGER NOT NULL, generation INTEGER NOT NULL
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agentId INTEGER, kind TEXT NOT NULL, txHash TEXT NOT NULL, logIndex INTEGER NOT NULL,
    blockNumber INTEGER NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL,
    UNIQUE (txHash, logIndex)
  );
  CREATE INDEX events_agent ON events (agentId, blockNumber, logIndex);
  CREATE TABLE pools (poolId TEXT PRIMARY KEY, agentId INTEGER NOT NULL, agentToken TEXT NOT NULL, agentIsCurrency0 INTEGER NOT NULL);
  CREATE TABLE swaps (
    txHash TEXT NOT NULL, logIndex INTEGER NOT NULL, poolId TEXT NOT NULL, agentId INTEGER NOT NULL,
    ts INTEGER NOT NULL, blockNumber INTEGER NOT NULL, amount0 TEXT NOT NULL, amount1 TEXT NOT NULL, sqrtPriceX96 TEXT NOT NULL,
    PRIMARY KEY (txHash, logIndex)
  );
  CREATE INDEX swaps_agent ON swaps (agentId, blockNumber, logIndex);
  CREATE TABLE trades_curve (
    txHash TEXT NOT NULL, logIndex INTEGER NOT NULL, agentId INTEGER NOT NULL, side TEXT NOT NULL, trader TEXT NOT NULL,
    usdg TEXT NOT NULL, tokens TEXT NOT NULL, fee TEXT NOT NULL, ts INTEGER NOT NULL, blockNumber INTEGER NOT NULL,
    PRIMARY KEY (txHash, logIndex)
  );
  CREATE INDEX trades_curve_agent ON trades_curve (agentId, blockNumber, logIndex);
  CREATE TABLE fees (
    txHash TEXT NOT NULL, logIndex INTEGER NOT NULL, agentId INTEGER NOT NULL, poolId TEXT NOT NULL,
    buybackLeg TEXT NOT NULL, treasuryLeg TEXT NOT NULL, royaltyLeg TEXT NOT NULL, converted TEXT NOT NULL,
    ts INTEGER NOT NULL, blockNumber INTEGER NOT NULL,
    PRIMARY KEY (txHash, logIndex)
  );
  CREATE INDEX fees_agent ON fees (agentId);
  CREATE TABLE balances (
    agentId INTEGER PRIMARY KEY,
    treasuryUsdg TEXT NOT NULL, treasuryRhEth TEXT NOT NULL, actionUsdg TEXT NOT NULL, actionRhEth TEXT NOT NULL,
    actionToken TEXT, updatedAt INTEGER NOT NULL
  );
  CREATE TABLE journal (
    itemId TEXT PRIMARY KEY, agentId INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
    raw TEXT NOT NULL, fetchedAt INTEGER NOT NULL, owner TEXT NOT NULL, unverified INTEGER NOT NULL, blockHeight INTEGER
  );
  CREATE INDEX journal_agent ON journal (agentId, ts);
  CREATE TABLE journal_owner (agentId INTEGER PRIMARY KEY, owner TEXT NOT NULL, attestationItem TEXT NOT NULL, pinnedAt INTEGER NOT NULL);
  `,
  // SPEC-M4B §1b — one row per agent, replaced every verify pass.
  `
  CREATE TABLE attestation_checks (
    agentId INTEGER PRIMARY KEY, verifiedAt INTEGER NOT NULL,
    refShape TEXT NOT NULL, itemFound TEXT NOT NULL, reportParses TEXT NOT NULL, eoasMatch TEXT NOT NULL,
    configHashMatch TEXT NOT NULL, imageIdMatch TEXT NOT NULL, releaseMatch TEXT NOT NULL,
    releaseVersion TEXT, detail TEXT NOT NULL
  );
  `,
  // M4A debt (a) — action-swap attribution: swaps carry the resolved tx sender; events become unique
  // per (txHash, logIndex, kind) so one Swap log can yield the pool agent's "swap" AND the acting
  // agent's "actionSwap" row (rebuild + copy + rename; ids and the events_agent index preserved).
  `
  ALTER TABLE swaps ADD COLUMN senderFrom TEXT;
  ALTER TABLE swaps ADD COLUMN senderAgentId INTEGER;
  ALTER TABLE swaps ADD COLUMN senderWallet TEXT;
  ALTER TABLE swaps ADD COLUMN senderResolved INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX swaps_unresolved ON swaps (senderResolved, blockNumber, logIndex);
  CREATE TABLE events_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agentId INTEGER, kind TEXT NOT NULL, txHash TEXT NOT NULL, logIndex INTEGER NOT NULL,
    blockNumber INTEGER NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL,
    UNIQUE (txHash, logIndex, kind)
  );
  INSERT INTO events_v3 (id, agentId, kind, txHash, logIndex, blockNumber, ts, data)
    SELECT id, agentId, kind, txHash, logIndex, blockNumber, ts, data FROM events ORDER BY id;
  DELETE FROM sqlite_sequence WHERE name = 'events_v3';
  INSERT INTO sqlite_sequence (name, seq) SELECT 'events_v3', seq FROM sqlite_sequence WHERE name = 'events';
  DROP TABLE events;
  ALTER TABLE events_v3 RENAME TO events;
  CREATE INDEX events_agent ON events (agentId, blockNumber, logIndex);
  `,
];

/** "action" ⇔ the tx sender is an agent's actionEOA; "treasury" ⇔ its treasuryEOA. */
export type SenderWallet = "action" | "treasury";

/** A swap row whose tx sender is not yet resolved (backfill queue), with its pool's orientation. */
export interface UnresolvedSwap extends SwapRow {
  agentIsCurrency0: number;
}

type Raw = Record<string, unknown>;

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toAgent(r: Raw): AgentRow {
  return {
    agentId: Number(r.agentId),
    name: s(r.name),
    symbol: s(r.symbol),
    imageURI: s(r.imageURI),
    creator: s(r.creator),
    configHash: s(r.configHash),
    token: s(r.token),
    curve: s(r.curve),
    poolId: s(r.poolId),
    totalSupply: s(r.totalSupply),
    state: String(r.state) as AgentState,
    requestTx: s(r.requestTx),
    requestBlock: n(r.requestBlock),
    createdAt: n(r.createdAt),
  };
}

export const TABLES = ["agents", "instances", "events", "pools", "swaps", "trades_curve", "fees", "balances", "journal", "journal_owner", "attestation_checks"] as const;

export class IndexerDb {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    const v = Number(this.db.pragma("user_version", { simple: true }));
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[i]!);
        this.db.pragma(`user_version = ${i + 1}`);
      });
    }
  }

  schemaVersion(): number {
    return Number(this.db.pragma("user_version", { simple: true }));
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- cursor / meta kv ----

  kvGet(k: string): string | undefined {
    const r = this.db.prepare(`SELECT v FROM cursor WHERE k = ?`).get(k) as { v: string } | undefined;
    return r?.v;
  }

  kvSet(k: string, v: string): void {
    this.db.prepare(`INSERT INTO cursor (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v);
  }

  // ---- agents ----

  /** AgentRequested: insert, or fill only the request fields (never touches state). */
  upsertAgentRequested(a: {
    agentId: number;
    configHash: string;
    creator: string;
    requestTx: string;
    requestBlock: number;
    createdAt: number;
    name: string | null;
    symbol: string | null;
    imageURI: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO agents (agentId, name, symbol, imageURI, creator, configHash, state, requestTx, requestBlock, createdAt)
         VALUES (@agentId, @name, @symbol, @imageURI, @creator, @configHash, 'requested', @requestTx, @requestBlock, @createdAt)
         ON CONFLICT(agentId) DO UPDATE SET
           name = COALESCE(agents.name, excluded.name),
           symbol = COALESCE(agents.symbol, excluded.symbol),
           imageURI = COALESCE(agents.imageURI, excluded.imageURI),
           creator = excluded.creator,
           configHash = excluded.configHash,
           requestTx = excluded.requestTx,
           requestBlock = excluded.requestBlock,
           createdAt = excluded.createdAt`,
      )
      .run(a);
  }

  /** AgentLive: token/curve/totalSupply (+ metadata fill) and state → live (forward-only). */
  markAgentLive(a: { agentId: number; token: string; curve: string; totalSupply: string | null; name: string | null; symbol: string | null; imageURI: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO agents (agentId, name, symbol, imageURI, token, curve, totalSupply, state)
         VALUES (@agentId, @name, @symbol, @imageURI, @token, @curve, @totalSupply, 'live')
         ON CONFLICT(agentId) DO UPDATE SET
           token = excluded.token,
           curve = excluded.curve,
           totalSupply = COALESCE(excluded.totalSupply, agents.totalSupply),
           name = COALESCE(agents.name, excluded.name),
           symbol = COALESCE(agents.symbol, excluded.symbol),
           imageURI = COALESCE(agents.imageURI, excluded.imageURI)`,
      )
      .run(a);
    this.advanceState(a.agentId, "live");
  }

  /** Forward-only state change; inserts a bare row when the agent is unknown (startBlock after the request). */
  advanceState(agentId: number, state: AgentState): void {
    const cur = this.db.prepare(`SELECT state FROM agents WHERE agentId = ?`).get(agentId) as { state: AgentState } | undefined;
    if (cur === undefined) {
      this.db.prepare(`INSERT INTO agents (agentId, state) VALUES (?, ?)`).run(agentId, state);
      return;
    }
    if (STATE_RANK[state] > STATE_RANK[cur.state]) this.db.prepare(`UPDATE agents SET state = ? WHERE agentId = ?`).run(state, agentId);
  }

  setAgentPool(agentId: number, poolId: string): void {
    this.db.prepare(`UPDATE agents SET poolId = ? WHERE agentId = ?`).run(poolId, agentId);
  }

  agents(): AgentRow[] {
    return (this.db.prepare(`SELECT * FROM agents ORDER BY agentId`).all() as Raw[]).map(toAgent);
  }

  agent(agentId: number): AgentRow | undefined {
    const r = this.db.prepare(`SELECT * FROM agents WHERE agentId = ?`).get(agentId) as Raw | undefined;
    return r === undefined ? undefined : toAgent(r);
  }

  /** lowercase curve address → agentId, for every agent seen live. */
  curveMap(): Map<string, number> {
    const rows = this.db.prepare(`SELECT agentId, curve FROM agents WHERE curve IS NOT NULL`).all() as Array<{ agentId: number; curve: string }>;
    return new Map(rows.map((r) => [r.curve.toLowerCase(), Number(r.agentId)]));
  }

  // ---- instances ----

  /**
   * InstanceRegistered (first registration or revival). lastHeartbeat = the block timestamp (the
   * registry sets it at registration, AgentRegistry.sol:94/104). A re-scanned older generation never
   * overwrites a newer one; lastHeartbeat only moves forward.
   */
  upsertInstanceRegistered(i: { agentId: number; treasuryEOA: string; actionEOA: string; codeHash: string; generation: number; attestationRef: string | null; registeredAt: number }): void {
    this.db
      .prepare(
        `INSERT INTO instances (agentId, treasuryEOA, actionEOA, codeHash, attestationRef, lastHeartbeat, generation)
         VALUES (@agentId, @treasuryEOA, @actionEOA, @codeHash, @attestationRef, @registeredAt, @generation)
         ON CONFLICT(agentId) DO UPDATE SET
           treasuryEOA = CASE WHEN excluded.generation >= instances.generation THEN excluded.treasuryEOA ELSE instances.treasuryEOA END,
           actionEOA = CASE WHEN excluded.generation >= instances.generation THEN excluded.actionEOA ELSE instances.actionEOA END,
           codeHash = CASE WHEN excluded.generation >= instances.generation THEN excluded.codeHash ELSE instances.codeHash END,
           attestationRef = CASE WHEN excluded.generation >= instances.generation THEN COALESCE(excluded.attestationRef, instances.attestationRef) ELSE instances.attestationRef END,
           generation = MAX(instances.generation, excluded.generation),
           lastHeartbeat = MAX(instances.lastHeartbeat, excluded.lastHeartbeat)`,
      )
      .run(i);
  }

  /** Heartbeat: forward-only. Ignored (returns false) when the instance row is unknown. */
  heartbeat(agentId: number, ts: number): boolean {
    const r = this.db.prepare(`UPDATE instances SET lastHeartbeat = MAX(lastHeartbeat, ?) WHERE agentId = ?`).run(ts, agentId);
    return r.changes === 1;
  }

  /** Periodic instanceOf reconcile: the chain's current struct is authoritative. */
  reconcileInstance(i: InstanceRow): void {
    this.db
      .prepare(
        `INSERT INTO instances (agentId, treasuryEOA, actionEOA, codeHash, attestationRef, lastHeartbeat, generation)
         VALUES (@agentId, @treasuryEOA, @actionEOA, @codeHash, @attestationRef, @lastHeartbeat, @generation)
         ON CONFLICT(agentId) DO UPDATE SET
           treasuryEOA = excluded.treasuryEOA, actionEOA = excluded.actionEOA, codeHash = excluded.codeHash,
           attestationRef = excluded.attestationRef, generation = excluded.generation,
           lastHeartbeat = MAX(instances.lastHeartbeat, excluded.lastHeartbeat)`,
      )
      .run(i);
  }

  instance(agentId: number): InstanceRow | undefined {
    const r = this.db.prepare(`SELECT * FROM instances WHERE agentId = ?`).get(agentId) as Raw | undefined;
    if (r === undefined) return undefined;
    return {
      agentId: Number(r.agentId),
      treasuryEOA: String(r.treasuryEOA),
      actionEOA: String(r.actionEOA),
      codeHash: String(r.codeHash),
      attestationRef: s(r.attestationRef),
      lastHeartbeat: Number(r.lastHeartbeat),
      generation: Number(r.generation),
    };
  }

  instances(): InstanceRow[] {
    return (this.db.prepare(`SELECT agentId FROM instances ORDER BY agentId`).all() as Array<{ agentId: number }>).map((r) => this.instance(Number(r.agentId))!);
  }

  // ---- events (activity feed) ----

  /** Returns true iff the row is new. */
  insertEvent(e: EventInsert): boolean {
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO events (agentId, kind, txHash, logIndex, blockNumber, ts, data) VALUES (@agentId, @kind, @txHash, @logIndex, @blockNumber, @ts, @data)`)
      .run(e);
    return r.changes === 1;
  }

  /** Newest first. */
  activity(agentId: number, limit: number): EventRow[] {
    return (
      this.db.prepare(`SELECT * FROM events WHERE agentId = ? ORDER BY blockNumber DESC, logIndex DESC LIMIT ?`).all(agentId, limit) as Raw[]
    ).map((r) => ({
      id: Number(r.id),
      agentId: n(r.agentId),
      kind: String(r.kind),
      txHash: String(r.txHash),
      logIndex: Number(r.logIndex),
      blockNumber: Number(r.blockNumber),
      ts: Number(r.ts),
      data: String(r.data),
    }));
  }

  /** Every event of one kind for an agent, oldest first (SPEC-M4B §1b generation history: kind "registered"). */
  eventsOfKind(agentId: number, kind: string): EventRow[] {
    return (
      this.db.prepare(`SELECT * FROM events WHERE agentId = ? AND kind = ? ORDER BY blockNumber, logIndex`).all(agentId, kind) as Raw[]
    ).map((r) => ({
      id: Number(r.id),
      agentId: n(r.agentId),
      kind: String(r.kind),
      txHash: String(r.txHash),
      logIndex: Number(r.logIndex),
      blockNumber: Number(r.blockNumber),
      ts: Number(r.ts),
      data: String(r.data),
    }));
  }

  // ---- pools / swaps / curve trades / fees ----

  upsertPool(p: PoolRow): void {
    this.db
      .prepare(`INSERT INTO pools (poolId, agentId, agentToken, agentIsCurrency0) VALUES (@poolId, @agentId, @agentToken, @agentIsCurrency0) ON CONFLICT(poolId) DO NOTHING`)
      .run(p);
  }

  pools(): PoolRow[] {
    return (this.db.prepare(`SELECT * FROM pools`).all() as Raw[]).map((r) => ({
      poolId: String(r.poolId),
      agentId: Number(r.agentId),
      agentToken: String(r.agentToken),
      agentIsCurrency0: Number(r.agentIsCurrency0),
    }));
  }

  pool(poolId: string): PoolRow | undefined {
    const r = this.db.prepare(`SELECT * FROM pools WHERE poolId = ?`).get(poolId.toLowerCase()) as Raw | undefined;
    return r === undefined
      ? undefined
      : { poolId: String(r.poolId), agentId: Number(r.agentId), agentToken: String(r.agentToken), agentIsCurrency0: Number(r.agentIsCurrency0) };
  }

  insertSwap(r: SwapRow): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO swaps (txHash, logIndex, poolId, agentId, ts, blockNumber, amount0, amount1, sqrtPriceX96)
           VALUES (@txHash, @logIndex, @poolId, @agentId, @ts, @blockNumber, @amount0, @amount1, @sqrtPriceX96)`,
        )
        .run(r).changes === 1
    );
  }

  // ---- swap sender attribution (M4A debt (a)) ----

  /** True iff the swap row exists and its tx sender is already resolved. */
  swapSenderResolved(txHash: string, logIndex: number): boolean {
    const r = this.db.prepare(`SELECT senderResolved FROM swaps WHERE txHash = ? AND logIndex = ?`).get(txHash, logIndex) as { senderResolved: number } | undefined;
    return r !== undefined && Number(r.senderResolved) === 1;
  }

  /** Resolve a swap's tx sender once (no-op when already resolved). Returns true iff the row changed. */
  setSwapSender(txHash: string, logIndex: number, from: string, agentId: number | null, wallet: SenderWallet | null): boolean {
    return (
      this.db
        .prepare(
          `UPDATE swaps SET senderFrom = ?, senderAgentId = ?, senderWallet = ?, senderResolved = 1
           WHERE txHash = ? AND logIndex = ? AND senderResolved = 0`,
        )
        .run(from.toLowerCase(), agentId, wallet, txHash, logIndex).changes === 1
    );
  }

  swapSender(txHash: string, logIndex: number): { senderFrom: string | null; senderAgentId: number | null; senderWallet: SenderWallet | null; senderResolved: number } | undefined {
    const r = this.db.prepare(`SELECT senderFrom, senderAgentId, senderWallet, senderResolved FROM swaps WHERE txHash = ? AND logIndex = ?`).get(txHash, logIndex) as Raw | undefined;
    if (r === undefined) return undefined;
    return { senderFrom: s(r.senderFrom), senderAgentId: n(r.senderAgentId), senderWallet: s(r.senderWallet) as SenderWallet | null, senderResolved: Number(r.senderResolved) };
  }

  /** Oldest-first swaps whose tx sender is unresolved (the backfill queue). */
  unresolvedSwaps(limit: number): UnresolvedSwap[] {
    return (
      this.db
        .prepare(
          `SELECT s.*, COALESCE(p.agentIsCurrency0, 0) AS agentIsCurrency0 FROM swaps s LEFT JOIN pools p ON p.poolId = s.poolId
           WHERE s.senderResolved = 0 ORDER BY s.blockNumber, s.logIndex LIMIT ?`,
        )
        .all(limit) as Raw[]
    ).map((r) => ({ ...this.toSwap(r), agentIsCurrency0: Number(r.agentIsCurrency0) }));
  }

  /**
   * The agent whose CURRENT instance wallet is `addr` (case-insensitive): actionEOA ⇒ "action",
   * treasuryEOA ⇒ "treasury". An action match wins over a treasury match; ties by lowest agentId.
   */
  agentByWallet(addr: string): { agentId: number; wallet: SenderWallet } | null {
    const a = addr.toLowerCase();
    const r = this.db
      .prepare(
        `SELECT agentId, CASE WHEN lower(actionEOA) = @a THEN 'action' ELSE 'treasury' END AS wallet FROM instances
         WHERE lower(actionEOA) = @a OR lower(treasuryEOA) = @a
         ORDER BY CASE WHEN lower(actionEOA) = @a THEN 0 ELSE 1 END, agentId LIMIT 1`,
      )
      .get({ a }) as { agentId: number; wallet: SenderWallet } | undefined;
    return r === undefined ? null : { agentId: Number(r.agentId), wallet: r.wallet };
  }

  insertCurveTrade(r: CurveTradeRow): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO trades_curve (txHash, logIndex, agentId, side, trader, usdg, tokens, fee, ts, blockNumber)
           VALUES (@txHash, @logIndex, @agentId, @side, @trader, @usdg, @tokens, @fee, @ts, @blockNumber)`,
        )
        .run(r).changes === 1
    );
  }

  insertFee(r: FeeRow): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO fees (txHash, logIndex, agentId, poolId, buybackLeg, treasuryLeg, royaltyLeg, converted, ts, blockNumber)
           VALUES (@txHash, @logIndex, @agentId, @poolId, @buybackLeg, @treasuryLeg, @royaltyLeg, @converted, @ts, @blockNumber)`,
        )
        .run(r).changes === 1
    );
  }

  private toSwap(r: Raw): SwapRow {
    return {
      txHash: String(r.txHash),
      logIndex: Number(r.logIndex),
      poolId: String(r.poolId),
      agentId: Number(r.agentId),
      ts: Number(r.ts),
      blockNumber: Number(r.blockNumber),
      amount0: String(r.amount0),
      amount1: String(r.amount1),
      sqrtPriceX96: String(r.sqrtPriceX96),
    };
  }

  private toTrade(r: Raw): CurveTradeRow {
    return {
      txHash: String(r.txHash),
      logIndex: Number(r.logIndex),
      agentId: Number(r.agentId),
      side: String(r.side) as "buy" | "sell",
      trader: String(r.trader),
      usdg: String(r.usdg),
      tokens: String(r.tokens),
      fee: String(r.fee),
      ts: Number(r.ts),
      blockNumber: Number(r.blockNumber),
    };
  }

  latestSwap(agentId: number): SwapRow | undefined {
    const r = this.db.prepare(`SELECT * FROM swaps WHERE agentId = ? ORDER BY blockNumber DESC, logIndex DESC LIMIT 1`).get(agentId) as Raw | undefined;
    return r === undefined ? undefined : this.toSwap(r);
  }

  swapsSince(agentId: number, sinceTs: number): SwapRow[] {
    return (this.db.prepare(`SELECT * FROM swaps WHERE agentId = ? AND ts >= ?`).all(agentId, sinceTs) as Raw[]).map((r) => this.toSwap(r));
  }

  latestCurveTrade(agentId: number): CurveTradeRow | undefined {
    const r = this.db.prepare(`SELECT * FROM trades_curve WHERE agentId = ? ORDER BY blockNumber DESC, logIndex DESC LIMIT 1`).get(agentId) as Raw | undefined;
    return r === undefined ? undefined : this.toTrade(r);
  }

  curveTradesSince(agentId: number, sinceTs: number): CurveTradeRow[] {
    return (this.db.prepare(`SELECT * FROM trades_curve WHERE agentId = ? AND ts >= ?`).all(agentId, sinceTs) as Raw[]).map((r) => this.toTrade(r));
  }

  fees(agentId: number): FeeRow[] {
    return (this.db.prepare(`SELECT * FROM fees WHERE agentId = ? ORDER BY blockNumber, logIndex`).all(agentId) as Raw[]).map((r) => ({
      txHash: String(r.txHash),
      logIndex: Number(r.logIndex),
      agentId: Number(r.agentId),
      poolId: String(r.poolId),
      buybackLeg: String(r.buybackLeg),
      treasuryLeg: String(r.treasuryLeg),
      royaltyLeg: String(r.royaltyLeg),
      converted: String(r.converted),
      ts: Number(r.ts),
      blockNumber: Number(r.blockNumber),
    }));
  }

  // ---- balances ----

  upsertBalances(b: BalanceRow): void {
    this.db
      .prepare(
        `INSERT INTO balances (agentId, treasuryUsdg, treasuryRhEth, actionUsdg, actionRhEth, actionToken, updatedAt)
         VALUES (@agentId, @treasuryUsdg, @treasuryRhEth, @actionUsdg, @actionRhEth, @actionToken, @updatedAt)
         ON CONFLICT(agentId) DO UPDATE SET
           treasuryUsdg = excluded.treasuryUsdg, treasuryRhEth = excluded.treasuryRhEth, actionUsdg = excluded.actionUsdg,
           actionRhEth = excluded.actionRhEth, actionToken = excluded.actionToken, updatedAt = excluded.updatedAt`,
      )
      .run(b);
  }

  balances(agentId: number): BalanceRow | undefined {
    const r = this.db.prepare(`SELECT * FROM balances WHERE agentId = ?`).get(agentId) as Raw | undefined;
    if (r === undefined) return undefined;
    return {
      agentId: Number(r.agentId),
      treasuryUsdg: String(r.treasuryUsdg),
      treasuryRhEth: String(r.treasuryRhEth),
      actionUsdg: String(r.actionUsdg),
      actionRhEth: String(r.actionRhEth),
      actionToken: s(r.actionToken),
      updatedAt: Number(r.updatedAt),
    };
  }

  // ---- journal (§3) ----

  hasJournalItem(itemId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM journal WHERE itemId = ?`).get(itemId) !== undefined;
  }

  insertJournal(j: JournalRow): boolean {
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO journal (itemId, agentId, ts, kind, text, raw, fetchedAt, owner, unverified, blockHeight)
           VALUES (@itemId, @agentId, @ts, @kind, @text, @raw, @fetchedAt, @owner, @unverified, @blockHeight)`,
        )
        .run(j).changes === 1
    );
  }

  /** Newest first. */
  journal(agentId: number, limit: number): JournalRow[] {
    return (this.db.prepare(`SELECT * FROM journal WHERE agentId = ? ORDER BY ts DESC, itemId DESC LIMIT ?`).all(agentId, limit) as Raw[]).map((r) => ({
      itemId: String(r.itemId),
      agentId: Number(r.agentId),
      ts: Number(r.ts),
      kind: String(r.kind),
      text: String(r.text),
      raw: String(r.raw),
      fetchedAt: Number(r.fetchedAt),
      owner: String(r.owner),
      unverified: Number(r.unverified),
      blockHeight: n(r.blockHeight),
    }));
  }

  journalOwner(agentId: number): JournalOwnerRow | undefined {
    const r = this.db.prepare(`SELECT * FROM journal_owner WHERE agentId = ?`).get(agentId) as Raw | undefined;
    if (r === undefined) return undefined;
    return { agentId: Number(r.agentId), owner: String(r.owner), attestationItem: String(r.attestationItem), pinnedAt: Number(r.pinnedAt) };
  }

  /**
   * §3 pin: record the owner once, then (same transaction) delete every journal row of the agent
   * from any other owner and mark the pinned owner's earlier rows verified. Returns rows deleted.
   */
  pinJournalOwner(p: JournalOwnerRow): number {
    return this.tx(() => {
      this.db.prepare(`INSERT OR IGNORE INTO journal_owner (agentId, owner, attestationItem, pinnedAt) VALUES (@agentId, @owner, @attestationItem, @pinnedAt)`).run(p);
      const pinned = this.journalOwner(p.agentId)!;
      const del = this.db.prepare(`DELETE FROM journal WHERE agentId = ? AND owner != ?`).run(p.agentId, pinned.owner);
      this.db.prepare(`UPDATE journal SET unverified = 0 WHERE agentId = ? AND owner = ?`).run(p.agentId, pinned.owner);
      return del.changes;
    });
  }

  // ---- attestation checks (SPEC-M4B §1b) ----

  upsertAttestationChecks(r: AttestationCheckRow): void {
    this.db
      .prepare(
        `INSERT INTO attestation_checks (agentId, verifiedAt, refShape, itemFound, reportParses, eoasMatch, configHashMatch, imageIdMatch, releaseMatch, releaseVersion, detail)
         VALUES (@agentId, @verifiedAt, @refShape, @itemFound, @reportParses, @eoasMatch, @configHashMatch, @imageIdMatch, @releaseMatch, @releaseVersion, @detail)
         ON CONFLICT(agentId) DO UPDATE SET
           verifiedAt = excluded.verifiedAt, refShape = excluded.refShape, itemFound = excluded.itemFound, reportParses = excluded.reportParses,
           eoasMatch = excluded.eoasMatch, configHashMatch = excluded.configHashMatch, imageIdMatch = excluded.imageIdMatch,
           releaseMatch = excluded.releaseMatch, releaseVersion = excluded.releaseVersion, detail = excluded.detail`,
      )
      .run(r);
  }

  private toChecks(r: Raw): AttestationCheckRow {
    const c = (k: string): CheckStatus => String(r[k]) as CheckStatus;
    return {
      agentId: Number(r.agentId),
      verifiedAt: Number(r.verifiedAt),
      refShape: c("refShape"),
      itemFound: c("itemFound"),
      reportParses: c("reportParses"),
      eoasMatch: c("eoasMatch"),
      configHashMatch: c("configHashMatch"),
      imageIdMatch: c("imageIdMatch"),
      releaseMatch: c("releaseMatch"),
      releaseVersion: s(r.releaseVersion),
      detail: String(r.detail),
    };
  }

  attestationChecks(agentId: number): AttestationCheckRow | undefined {
    const r = this.db.prepare(`SELECT * FROM attestation_checks WHERE agentId = ?`).get(agentId) as Raw | undefined;
    return r === undefined ? undefined : this.toChecks(r);
  }

  // ---- status ----

  counts(): Record<(typeof TABLES)[number], number> {
    const out = {} as Record<(typeof TABLES)[number], number>;
    for (const t of TABLES) out[t] = Number((this.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
    return out;
  }
}
