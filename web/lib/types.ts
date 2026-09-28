/**
 * API response types for the indexer's `/api/*` endpoints.
 *
 * CANONICAL: mirrors indexer/src/api.ts (AgentView, ActivityItem, JournalEntry
 * + the header comment documenting endpoints/units/errors) and indexer/src/
 * derive.ts (Status) exactly. Deliberately DUPLICATED here — no cross-package
 * import into the Next bundle (SPEC-M4A §2). Keep in sync by hand if the
 * indexer's API shapes change.
 *
 * Endpoints (indexer/src/api.ts):
 *   GET /api/agents                      -> { agents: AgentView[] }              (agentId ascending)
 *   GET /api/agents/:id                  -> AgentView
 *   GET /api/agents/:id/activity?limit=N -> { agentId, events: ActivityItem[] }  (newest first)
 *   GET /api/agents/:id/journal?limit=N  -> { agentId, pinnedOwner, entries: JournalEntry[] } (newest first)
 *
 * Units (indexer/src/derive.ts): every bigint is a base-10 STRING — USDG
 * amounts in USDG base units (6 dec), native balances in wei, agent-token
 * amounts in token base units (18 dec); `market.price` is a decimal string of
 * USDG per WHOLE token (already human-readable — do not run it through
 * formatUsdg/formatFixedPoint again), `market.priceE18` is the same value ×
 * 1e18 as an integer string. Block numbers, log indexes and unix-second
 * timestamps are JSON numbers. agentId is a NUMBER (not a string).
 */

/** Raw on-chain lifecycle state from factory events (indexer agents.state). */
export type AgentState = "requested" | "live" | "cancelled" | "graduated";

/** Derived, bounded-honesty status label (SPEC-M4A §0) — "status", never "tier". */
export type AgentStatus = "live" | "stale" | "evicted" | "pending";

export interface AgentInstance {
  treasuryEOA: string;
  actionEOA: string;
  codeHash: string;
  attestationRef: string | null;
  /** Unix seconds of the last observed Heartbeat event. */
  lastHeartbeat: number;
  generation: number;
}

export interface AgentMarket {
  /** Decimal string, USDG per whole token — already human-readable, not a fixed-point integer string. */
  price: string | null;
  /** `price` × 1e18, integer string. */
  priceE18: string | null;
  priceSource: "pool" | "curve" | null;
  /** Agent-token base units (18 dec) integer string. */
  totalSupply: string | null;
  /** USDG base units (6 dec) integer string. */
  mcapUsdg: string | null;
  /** USDG base units (6 dec) integer string — never null, "0" when no volume. */
  volume24hUsdg: string;
}

export interface AgentBalances {
  /** USDG base units (6 dec) integer string. */
  treasuryUsdg: string;
  /** wei (18 dec) integer string. */
  treasuryRhEth: string;
  /** USDG base units (6 dec) integer string. */
  actionUsdg: string;
  /** wei (18 dec) integer string. */
  actionRhEth: string;
  /** Agent-token base units (18 dec) integer string, null if never observed. */
  actionToken: string | null;
  /** Unix seconds this balance snapshot was last updated. */
  updatedAt: number;
}

export interface AgentFees {
  /** USDG base units (6 dec) integer string — lifetime buyback leg. */
  buybackLeg: string;
  /** USDG base units (6 dec) integer string — lifetime treasury leg. */
  treasuryLeg: string;
  /** USDG base units (6 dec) integer string — lifetime NFT royalty leg. */
  royaltyLeg: string;
  /** Integer string — lifetime amount converted by the fee split hook. */
  converted: string;
  /** Number of fee-distribution events observed. */
  count: number;
}

export interface AgentView {
  agentId: number;
  name: string | null;
  symbol: string | null;
  imageURI: string | null;
  creator: string | null;
  configHash: string | null;
  token: string | null;
  curve: string | null;
  poolId: string | null;
  state: AgentState;
  requestTx: string | null;
  requestBlock: number | null;
  /** Unix seconds — null until observed (e.g. a freshly-requested agent). */
  createdAt: number | null;
  status: AgentStatus;
  instance: AgentInstance | null;
  market: AgentMarket;
  balances: AgentBalances | null;
  fees: AgentFees;
}

/**
 * `kind` is a free-form string emitted by the watcher (swap, curve_buy,
 * curve_sell, curve_graduated, requested, live, cancelled, graduated,
 * genesis_opened, registered, heartbeat, pool_registered, fee_collected,
 * distributed, royalty_credited, royalty_claimed, emancipated, buyback_poked,
 * nft_transfer, and any future kind) — NOT a narrow union. Humanize known
 * kinds; fall back to the raw kind label for anything else.
 */
export interface ActivityItem {
  id: number;
  kind: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  ts: number;
  data: Record<string, unknown>;
}

export interface JournalEntry {
  itemId: string;
  ts: number;
  kind: string;
  text: string;
  owner: string;
  /** True until `owner` is pinned to this agent's on-chain treasury EOA. */
  unverified: boolean;
  blockHeight: number | null;
  fetchedAt: number;
  /** Permanent gateway URL for this item — use directly, do not rebuild it. */
  url: string;
}

export interface AgentsResponse {
  agents: AgentView[];
}

export interface ActivityResponse {
  agentId: number;
  events: ActivityItem[];
}

export interface JournalResponse {
  agentId: number;
  pinnedOwner: string | null;
  entries: JournalEntry[];
}
