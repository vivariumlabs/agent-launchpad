// SPEC-M3B §1 db.ts — SQLite persistence for the orchestrator.
//   launches(agentId PK, state, requestTx, deployJobId, cvmIp, configHash, per-step attempt counts,
//            updatedAt, lastError, …)          — one genesis flow per agent
//   revivals(id PK, agentId, …same columns)  — one row per revival request (04 §6)
//   seeds(flow, leg, agentId, txHash, status, usdMicro, …) — per-leg seeding plan + tx record
//                                             (incl. the pre-registration gas leg "preGas")
//   kv(k PK, v)                               — watcher cursor, deploy lock
//   revival_payments(txHash PK, …)            — SPEC-M4F R1: every revival payment tx the launch-helper
//                                             accepted (single use: the PK is the reuse guard)
//   events(…)                                 — append-only audit trail of every side effect
// Every transition is persisted BEFORE the side effect it guards where possible (deploy attempt +
// pre-deploy job snapshot before the CLI runs; signed raw tx + hash before broadcast).

import Database from "better-sqlite3";

/**
 * SPEC-M4F R5: EXTERNAL = terminal "completed outside this orchestrator" — a REQUESTED genesis launch
 * whose agent was already registered on-chain when the machine adopted it (never driven).
 */
export type State = "REQUESTED" | "DEPLOYING" | "AWAITING_REGISTER" | "SEEDING" | "RECONCILING" | "FINALIZING" | "LIVE" | "FAILED" | "EXTERNAL";
export const TERMINAL: readonly State[] = ["LIVE", "FAILED", "EXTERNAL"];
const TERMINAL_SQL = TERMINAL.map((s) => `'${s}'`).join(",");
export type FlowKind = "genesis" | "revival";

export interface FlowRef {
  kind: FlowKind;
  id: number;
}

export function flowKey(f: FlowRef): string {
  return `${f.kind}:${f.id}`;
}

/** Columns shared by launches and revivals. Timestamps: unix seconds. */
export interface FlowRow {
  kind: FlowKind;
  id: number;
  agentId: number;
  state: State;
  startedAt: number;
  configHash: string;
  configRef: string | null;
  frozenJson: string | null;
  composePath: string | null;
  imageId: string | null;
  deployJobId: string | null;
  deployInFlight: number;
  deployStartedAt: number | null;
  preDeployJobs: string | null;
  cvmIp: string | null;
  attestationOk: number;
  treasury: string | null;
  deployAttempts: number;
  verifyAttempts: number;
  seedAttempts: number;
  reconcileAttempts: number;
  finalizeAttempts: number;
  finalizeTx: string | null;
  finalizeRaw: string | null;
  failReason: string | null;
  failStep: string | null;
  lastError: string | null;
  updatedAt: number;
  // launches only
  requestTx: string | null;
  requestBlock: number | null;
  creator: string | null;
  // revivals only
  payer: string | null;
  payerRef: string | null;
  startGeneration: number | null;
}

export type FlowPatch = Partial<Omit<FlowRow, "kind" | "id" | "agentId">>;

/** `deferred` = the USDG remainder leg before its amount is resolved (after every other leg). */
export type SeedStatus = "deferred" | "planned" | "submitted" | "confirmed" | "satisfied" | "skipped" | "failed";

export interface SeedRow {
  flow: string;
  leg: string;
  agentId: number;
  chain: string;
  /** "virtual" = no transfer of ours (the `hosting` leg: the deploy's rental, paid at deploy time). */
  asset: "native" | "erc20" | "turbo" | "virtual";
  token: string | null;
  target: string;
  amount: string; // base units (wei / 6-dec token units / µUSD for turbo + virtual), decimal string
  mode: "required" | "conditional";
  /** µUSD budget of the leg, frozen at plan time (remainder leg: the creation fee = its budget). */
  usdMicro: string | null;
  txHash: string | null;
  raw: string | null;
  status: SeedStatus;
  note: string | null;
  attempts: number;
  updatedAt: number;
}

export type SeedPatch = Partial<Pick<SeedRow, "txHash" | "raw" | "status" | "note" | "attempts" | "amount">>;

/**
 * SPEC-M4F R1 revival payment record. status: `claimed` (verified, revive() running), `queued`
 * (revivalId set), `refund_due` (verified payment but revive() refused — the operator returns the fee
 * manually on testnet). A row is never deleted except when revive() failed transiently (so the payer
 * can resubmit the same tx).
 */
export type PaymentStatus = "claimed" | "queued" | "refund_due";

export interface PaymentRow {
  txHash: string;
  agentId: number;
  payer: string;
  /** Verified USDC base units (6 decimals) paid to payTo, decimal string. */
  amount: string;
  status: PaymentStatus;
  revivalId: number | null;
  note: string | null;
  at: number;
  updatedAt: number;
}

export interface EventRow {
  id: number;
  flow: string;
  agentId: number;
  at: number;
  kind: string;
  detail: string;
}

const FLOW_COLUMNS = `
  state TEXT NOT NULL,
  startedAt INTEGER NOT NULL,
  configHash TEXT NOT NULL,
  configRef TEXT,
  frozenJson TEXT,
  composePath TEXT,
  imageId TEXT,
  deployJobId TEXT,
  deployInFlight INTEGER NOT NULL DEFAULT 0,
  deployStartedAt INTEGER,
  preDeployJobs TEXT,
  cvmIp TEXT,
  attestationOk INTEGER NOT NULL DEFAULT 0,
  treasury TEXT,
  deployAttempts INTEGER NOT NULL DEFAULT 0,
  verifyAttempts INTEGER NOT NULL DEFAULT 0,
  seedAttempts INTEGER NOT NULL DEFAULT 0,
  reconcileAttempts INTEGER NOT NULL DEFAULT 0,
  finalizeAttempts INTEGER NOT NULL DEFAULT 0,
  finalizeTx TEXT,
  finalizeRaw TEXT,
  failReason TEXT,
  failStep TEXT,
  lastError TEXT,
  updatedAt INTEGER NOT NULL`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS launches (
  agentId INTEGER PRIMARY KEY,
  requestTx TEXT,
  requestBlock INTEGER,
  creator TEXT,
  ${FLOW_COLUMNS}
);
CREATE TABLE IF NOT EXISTS revivals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agentId INTEGER NOT NULL,
  payer TEXT,
  payerRef TEXT,
  startGeneration INTEGER,
  ${FLOW_COLUMNS}
);
CREATE TABLE IF NOT EXISTS seeds (
  flow TEXT NOT NULL,
  leg TEXT NOT NULL,
  agentId INTEGER NOT NULL,
  chain TEXT NOT NULL,
  asset TEXT NOT NULL,
  token TEXT,
  target TEXT NOT NULL,
  amount TEXT NOT NULL,
  mode TEXT NOT NULL,
  usdMicro TEXT,
  txHash TEXT,
  raw TEXT,
  status TEXT NOT NULL,
  note TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (flow, leg)
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS revival_payments (
  txHash TEXT PRIMARY KEY,
  agentId INTEGER NOT NULL,
  payer TEXT NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL,
  revivalId INTEGER,
  note TEXT,
  at INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow TEXT NOT NULL,
  agentId INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
`;

const PATCHABLE = new Set<string>([
  "state", "startedAt", "configHash", "configRef", "frozenJson", "composePath", "imageId", "deployJobId", "deployInFlight",
  "deployStartedAt", "preDeployJobs", "cvmIp", "attestationOk", "treasury", "deployAttempts", "verifyAttempts",
  "seedAttempts", "reconcileAttempts", "finalizeAttempts", "finalizeTx", "finalizeRaw", "failReason", "failStep",
  "lastError", "updatedAt", "requestTx", "requestBlock", "creator", "payer", "payerRef", "startGeneration",
]);

type Raw = Record<string, unknown>;

function toFlow(kind: FlowKind, r: Raw): FlowRow {
  const n = (k: string): number | null => (r[k] === null || r[k] === undefined ? null : Number(r[k]));
  const s = (k: string): string | null => (r[k] === null || r[k] === undefined ? null : String(r[k]));
  return {
    kind,
    id: kind === "genesis" ? Number(r.agentId) : Number(r.id),
    agentId: Number(r.agentId),
    state: String(r.state) as State,
    startedAt: Number(r.startedAt),
    configHash: String(r.configHash),
    configRef: s("configRef"),
    frozenJson: s("frozenJson"),
    composePath: s("composePath"),
    imageId: s("imageId"),
    deployJobId: s("deployJobId"),
    deployInFlight: Number(r.deployInFlight),
    deployStartedAt: n("deployStartedAt"),
    preDeployJobs: s("preDeployJobs"),
    cvmIp: s("cvmIp"),
    attestationOk: Number(r.attestationOk),
    treasury: s("treasury"),
    deployAttempts: Number(r.deployAttempts),
    verifyAttempts: Number(r.verifyAttempts),
    seedAttempts: Number(r.seedAttempts),
    reconcileAttempts: Number(r.reconcileAttempts),
    finalizeAttempts: Number(r.finalizeAttempts),
    finalizeTx: s("finalizeTx"),
    finalizeRaw: s("finalizeRaw"),
    failReason: s("failReason"),
    failStep: s("failStep"),
    lastError: s("lastError"),
    updatedAt: Number(r.updatedAt),
    requestTx: s("requestTx"),
    requestBlock: n("requestBlock"),
    creator: s("creator"),
    payer: s("payer"),
    payerRef: s("payerRef"),
    startGeneration: n("startGeneration"),
  };
}

function toPayment(r: Raw): PaymentRow {
  return {
    txHash: String(r.txHash),
    agentId: Number(r.agentId),
    payer: String(r.payer),
    amount: String(r.amount),
    status: String(r.status) as PaymentStatus,
    revivalId: r.revivalId === null || r.revivalId === undefined ? null : Number(r.revivalId),
    note: r.note === null || r.note === undefined ? null : String(r.note),
    at: Number(r.at),
    updatedAt: Number(r.updatedAt),
  };
}

export interface RequestedInsert {
  agentId: number;
  configHash: string;
  creator: string;
  requestTx: string;
  requestBlock: number;
  requestedAt: number;
}

export interface RevivalInsert {
  agentId: number;
  configHash: string;
  configRef: string | null;
  frozenJson: string | null;
  composePath: string | null;
  treasury: string;
  payer: string;
  payerRef: string | null;
  startGeneration: number;
  startedAt: number;
}

export class GenesisDb {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(SCHEMA);
    // Pre-existing dbs (built before the usdMicro column): additive migration.
    const cols = (this.db.prepare(`PRAGMA table_info(seeds)`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes("usdMicro")) this.db.exec(`ALTER TABLE seeds ADD COLUMN usdMicro TEXT`);
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private table(kind: FlowKind): { name: string; pk: string } {
    return kind === "genesis" ? { name: "launches", pk: "agentId" } : { name: "revivals", pk: "id" };
  }

  /** Watcher entry: INSERT OR IGNORE (a re-seen event never resets a launch). Returns true if new. */
  insertRequested(r: RequestedInsert): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO launches (agentId, requestTx, requestBlock, creator, state, startedAt, configHash, updatedAt)
         VALUES (?, ?, ?, ?, 'REQUESTED', ?, ?, ?)`,
      )
      .run(r.agentId, r.requestTx, r.requestBlock, r.creator, r.requestedAt, r.configHash.toLowerCase(), r.requestedAt);
    return res.changes === 1;
  }

  insertRevival(r: RevivalInsert): number {
    const res = this.db
      .prepare(
        `INSERT INTO revivals (agentId, payer, payerRef, startGeneration, state, startedAt, configHash, configRef, frozenJson,
                               composePath, treasury, updatedAt)
         VALUES (?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.agentId, r.payer, r.payerRef, r.startGeneration, r.startedAt, r.configHash.toLowerCase(), r.configRef, r.frozenJson,
        r.composePath, r.treasury, r.startedAt);
    return Number(res.lastInsertRowid);
  }

  getFlow(ref: FlowRef): FlowRow | undefined {
    const t = this.table(ref.kind);
    const r = this.db.prepare(`SELECT * FROM ${t.name} WHERE ${t.pk} = ?`).get(ref.id) as Raw | undefined;
    return r === undefined ? undefined : toFlow(ref.kind, r);
  }

  getLaunch(agentId: number): FlowRow | undefined {
    return this.getFlow({ kind: "genesis", id: agentId });
  }

  /** Non-terminal revivals of an agent (at most one may be active). */
  activeRevivals(agentId: number): FlowRow[] {
    const rows = this.db.prepare(`SELECT * FROM revivals WHERE agentId = ? AND state NOT IN (${TERMINAL_SQL}) ORDER BY id`).all(agentId) as Raw[];
    return rows.map((r) => toFlow("revival", r));
  }

  /** Every non-terminal flow, genesis first (by agentId), then revivals (by id). */
  nonTerminal(): FlowRef[] {
    const g = this.db.prepare(`SELECT agentId FROM launches WHERE state NOT IN (${TERMINAL_SQL}) ORDER BY agentId`).all() as Array<{ agentId: number }>;
    const r = this.db.prepare(`SELECT id FROM revivals WHERE state NOT IN (${TERMINAL_SQL}) ORDER BY id`).all() as Array<{ id: number }>;
    return [...g.map((x) => ({ kind: "genesis" as const, id: Number(x.agentId) })), ...r.map((x) => ({ kind: "revival" as const, id: Number(x.id) }))];
  }

  /** Every revival of an agent (any state), oldest first. */
  revivalsOf(agentId: number): FlowRow[] {
    return (this.db.prepare(`SELECT * FROM revivals WHERE agentId = ? ORDER BY id`).all(agentId) as Raw[]).map((r) => toFlow("revival", r));
  }

  allFlows(kind: FlowKind): FlowRow[] {
    const t = this.table(kind);
    return (this.db.prepare(`SELECT * FROM ${t.name} ORDER BY ${t.pk}`).all() as Raw[]).map((r) => toFlow(kind, r));
  }

  patchFlow(ref: FlowRef, patch: FlowPatch, now: bigint): void {
    const t = this.table(ref.kind);
    const entries = Object.entries({ ...patch, updatedAt: Number(now) }).filter(([k]) => PATCHABLE.has(k));
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    const vals = entries.map(([, v]) => (v === undefined ? null : v));
    this.db.prepare(`UPDATE ${t.name} SET ${sets} WHERE ${t.pk} = ?`).run(...vals, ref.id);
  }

  // ---- seeds ----

  seeds(flow: string): SeedRow[] {
    return (this.db.prepare(`SELECT * FROM seeds WHERE flow = ? ORDER BY rowid`).all(flow) as Raw[]).map((r) => ({
      flow: String(r.flow),
      leg: String(r.leg),
      agentId: Number(r.agentId),
      chain: String(r.chain),
      asset: String(r.asset) as SeedRow["asset"],
      token: r.token === null ? null : String(r.token),
      target: String(r.target),
      amount: String(r.amount),
      mode: String(r.mode) as SeedRow["mode"],
      usdMicro: r.usdMicro === null || r.usdMicro === undefined ? null : String(r.usdMicro),
      txHash: r.txHash === null ? null : String(r.txHash),
      raw: r.raw === null ? null : String(r.raw),
      status: String(r.status) as SeedStatus,
      note: r.note === null ? null : String(r.note),
      attempts: Number(r.attempts),
      updatedAt: Number(r.updatedAt),
    }));
  }

  /** The seeding plan is frozen at first SEEDING entry: INSERT OR IGNORE, never re-planned. */
  planSeeds(
    rows: Array<Omit<SeedRow, "txHash" | "raw" | "status" | "note" | "attempts" | "updatedAt"> & { status?: "planned" | "deferred" }>,
    now: bigint,
  ): void {
    const st = this.db.prepare(
      `INSERT OR IGNORE INTO seeds (flow, leg, agentId, chain, asset, token, target, amount, mode, usdMicro, status, attempts, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    this.tx(() => {
      for (const r of rows) st.run(r.flow, r.leg, r.agentId, r.chain, r.asset, r.token, r.target, r.amount, r.mode, r.usdMicro, r.status ?? "planned", Number(now));
    });
  }

  patchSeed(flow: string, leg: string, patch: SeedPatch, now: bigint): void {
    const entries = Object.entries({ ...patch, updatedAt: Number(now) });
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    const vals = entries.map(([, v]) => (v === undefined ? null : v));
    this.db.prepare(`UPDATE seeds SET ${sets} WHERE flow = ? AND leg = ?`).run(...vals, flow, leg);
  }

  // ---- kv ----

  kvGet(k: string): string | undefined {
    const r = this.db.prepare(`SELECT v FROM kv WHERE k = ?`).get(k) as { v: string } | undefined;
    return r?.v;
  }

  kvSet(k: string, v: string): void {
    this.db.prepare(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v);
  }

  kvDel(k: string): void {
    this.db.prepare(`DELETE FROM kv WHERE k = ?`).run(k);
  }

  // ---- revival payments (SPEC-M4F R1) ----

  /** Claims a payment tx: INSERT OR IGNORE on the txHash PK. false ⇒ already used (reuse guard). */
  claimPayment(p: { txHash: string; agentId: number; payer: string; amount: string; at: number }): boolean {
    const res = this.db
      .prepare(`INSERT OR IGNORE INTO revival_payments (txHash, agentId, payer, amount, status, at, updatedAt) VALUES (?, ?, ?, ?, 'claimed', ?, ?)`)
      .run(p.txHash.toLowerCase(), p.agentId, p.payer, p.amount, p.at, p.at);
    return res.changes === 1;
  }

  getPayment(txHash: string): PaymentRow | undefined {
    const r = this.db.prepare(`SELECT * FROM revival_payments WHERE txHash = ?`).get(txHash.toLowerCase()) as Raw | undefined;
    return r === undefined ? undefined : toPayment(r);
  }

  paymentsOf(agentId: number): PaymentRow[] {
    return (this.db.prepare(`SELECT * FROM revival_payments WHERE agentId = ? ORDER BY at, txHash`).all(agentId) as Raw[]).map(toPayment);
  }

  patchPayment(txHash: string, patch: { status: PaymentStatus; revivalId?: number | null; note?: string | null }, now: bigint): void {
    this.db
      .prepare(`UPDATE revival_payments SET status = ?, revivalId = COALESCE(?, revivalId), note = COALESCE(?, note), updatedAt = ? WHERE txHash = ?`)
      .run(patch.status, patch.revivalId ?? null, patch.note ?? null, Number(now), txHash.toLowerCase());
  }

  /** Releases a claim (ONLY when revive() failed transiently — nothing was queued or refused). */
  releasePayment(txHash: string): void {
    this.db.prepare(`DELETE FROM revival_payments WHERE txHash = ? AND status = 'claimed'`).run(txHash.toLowerCase());
  }

  // ---- audit trail ----

  event(flow: string, agentId: number, now: bigint, kind: string, detail: string): void {
    this.db.prepare(`INSERT INTO events (flow, agentId, at, kind, detail) VALUES (?, ?, ?, ?, ?)`).run(flow, agentId, Number(now), kind, detail);
  }

  events(flow?: string): EventRow[] {
    const rows = (flow === undefined
      ? this.db.prepare(`SELECT * FROM events ORDER BY id`).all()
      : this.db.prepare(`SELECT * FROM events WHERE flow = ? ORDER BY id`).all(flow)) as Raw[];
    return rows.map((r) => ({ id: Number(r.id), flow: String(r.flow), agentId: Number(r.agentId), at: Number(r.at), kind: String(r.kind), detail: String(r.detail) }));
  }
}
