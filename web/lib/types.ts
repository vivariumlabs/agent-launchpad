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
  /**
   * USDG base units (6 dec) integer string — lifetime platform leg (SPEC-M4G
   * §3: renamed from `buybackLeg`). v2 stack: it went to the FloorVault (D18);
   * legacy v1 stack: it went to the retired TreasuryBuyback. Read via
   * lib/stack.ts `platformLegOf` (tolerates a pre-rename indexer).
   */
  platformLeg: string;
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
  /**
   * SPEC-M4G §3 dual-stack: the contract stack this agent lives on. Optional
   * in the type only so a pre-M4G indexer still parses — always read it via
   * lib/stack.ts `agentStack` (validated; null when absent/malformed).
   */
  stack?: AgentStack | null;
}

/**
 * SPEC-M4G §3: per-agent contract stack. The legacy v1 stack (agents 1–11)
 * stays live and indexed; the v2 stack issues agent ids from 101. Every
 * per-agent contract read/write (NFT claim/burn, …) uses THESE addresses,
 * never the primary manifest's.
 */
export interface AgentStack {
  version: number;
  legacy: boolean;
  factory: `0x${string}`;
  registry: `0x${string}`;
  hook: `0x${string}`;
  distributor: `0x${string}`;
  nft: `0x${string}`;
}

/** SPEC-M4G §3 `/api/contracts` `stacks[]` entry (primary first). */
export interface StackInfo extends AgentStack {
  startBlock: number | null;
  firstAgentId: number | null;
}

/**
 * `kind` is a free-form string emitted by the watcher (swap, curve_buy,
 * curve_sell, curve_graduated, requested, live, cancelled, graduated,
 * genesis_opened, registered, heartbeat, pool_registered, fee_collected,
 * distributed, royalty_credited, royalty_claimed, emancipated, buyback_poked,
 * nft_transfer, actionSwap, and any future kind) — NOT a narrow union.
 * Humanize known kinds; fall back to the raw kind label for anything else.
 *
 * "actionSwap" (M4A debt (a)): lands on the ACTING agent's feed when its
 * action or treasury EOA sent a tx that swapped on an indexed pool (same
 * txHash/logIndex as the pool agent's "swap" row). data: { poolId: string,
 * poolAgentId: number, wallet: "action" | "treasury", amount0: string,
 * amount1: string, agentIsCurrency0: boolean }.
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

/** `data` of an ActivityItem with kind "actionSwap" (see ActivityItem). */
export interface ActionSwapData {
  poolId: string;
  poolAgentId: number;
  wallet: "action" | "treasury";
  /** Signed int128 pool deltas, base-10 strings. */
  amount0: string;
  amount1: string;
  agentIsCurrency0: boolean;
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

// ---------------------------------------------------------------------------
// SPEC-M4B §1c — attestation endpoints (indexer/src/api.ts, being built in
// parallel). Pinned contract from the spec; DUPLICATED here by design
// (SPEC-M4A §2) — keep in sync by hand.
//
//   GET /api/agents/:id/attestation -> AttestationView
//   GET /api/attestation/summary    -> AttestationSummary
// ---------------------------------------------------------------------------

/**
 * One check verdict. `pending` = not yet verifiable (e.g. Arweave/GraphQL
 * unreachable — transport is never a failure, R2); `skip` = not applicable
 * (drill-style local ref, or no release table configured). Only `pass` may
 * ever render a ✅ (R1: honest checkmarks).
 */
export type CheckResult = "pass" | "fail" | "pending" | "skip";

/** Check names, in the indexer's evaluation order (SPEC-M4B §1b; SPEC-M4D R3 appends the quote checks). */
export type AttestationCheckName =
  | "refShape"
  | "itemFound"
  | "reportParses"
  | "eoasMatch"
  | "configHashMatch"
  | "imageIdMatch"
  | "releaseMatch"
  | "quoteValid"
  | "measurementMatch";

export type AttestationChecks = Record<AttestationCheckName, CheckResult>;

/** One InstanceRegistered event (generation 0 = genesis, >0 = revival). */
export interface GenerationRecord {
  generation: number;
  treasuryEOA: string;
  actionEOA: string;
  codeHash: string;
  /** Unix seconds. */
  ts: number;
  txHash: string;
}

export interface VerifyYourself {
  /** The registered code hash / image-id to verify against, null if unknown. */
  imageId: string | null;
  /** Enclave IP is not on-chain — always null in v1 (commands carry a placeholder). Optional: not in every pinned shape. */
  enclaveIpHint?: string | null;
  /** Shell commands templated by the indexer from the real values. */
  commands: string[];
}

/**
 * Attestation for one agent, as the web consumes it. web/lib/api.ts
 * NORMALIZES the indexer's wire shape into this (tolerating `checks` as a
 * name->result record OR as [{name, status, detail}], and `verifiedAt` as a
 * string or unix-seconds number) — see normalizeAttestation. A missing or
 * unrecognized check value becomes "pending", never "pass" (R1).
 */
export interface AttestationView {
  checks: AttestationChecks;
  /** Per-check reason for a non-pass status, when the indexer provides one. */
  checkDetails: Partial<Record<AttestationCheckName, string>>;
  /** Unix seconds of the last verify pass, null if never verified. */
  verifiedAt: number | null;
  /** Matched runtime release version (e.g. "0.1.6"), null when no match / no release table. */
  releaseVersion: string | null;
  attestationRef: string | null;
  /** Gateway URL for attestationRef, null when the ref is not an Arweave item id. */
  arweaveUrl: string | null;
  generationHistory: GenerationRecord[];
  verifyYourself: VerifyYourself;
  /** Values read from the Arweave report, when the indexer exposes them (null until parsed / not exposed). */
  report: AttestationReportFields | null;
  /** Git commit of the matched release, when exposed. */
  releaseCommit: string | null;
}

export interface AttestationReportFields {
  treasury: string | null;
  action: string | null;
  configHash: string | null;
  imageId: string | null;
}

export interface AttestationSummaryAgent {
  agentId: number;
  status: AgentStatus;
  worst: CheckResult;
  failing: AttestationCheckName[];
}

export interface AttestationSummary {
  /** True iff some LIVE agent has a FAILING check (R2). */
  alert: boolean;
  agents: AttestationSummaryAgent[];
  /** ISO string or unix seconds (the pinned shape left it open) — display only. */
  verifiedAt: string | number | null;
}

// ---------------------------------------------------------------------------
// SPEC-M4B §2 — launch-helper endpoints (genesis/src/launchHelper.ts, being
// built in parallel). Called ONLY server-side (R4). DUPLICATED by design.
//
//   GET  /api/launch/template -> LaunchTemplate
//   POST /api/launch/prepare  {agent: LaunchAgentInput}
//        -> 200 LaunchPrepared | 422 LaunchViolations | 502 {error}
// ---------------------------------------------------------------------------

export type Archetype = string;

/**
 * One x402 inference allowlist entry. agent.models refs are MODEL names
 * (the launch-helper validates primary/fallbacks against `model`; the
 * runtime matches a ref against entry id OR model, so one model ref covers
 * every operator serving it).
 */
export interface LaunchModelOption {
  id: string;
  operator: string;
  model: string;
  tier: string;
  attested?: boolean;
}

export interface LaunchTemplate {
  /** The platform section genesis would freeze — opaque to the web. */
  platform: Record<string, unknown>;
  defaults: {
    archetypes: Archetype[];
    models: LaunchModelOption[];
    /** USDG base units (6 dec) integer string, e.g. "75000000". */
    creationFeeUsdg: string;
    /** Default chat tier, when the helper provides one. */
    chatTier?: string;
  };
  composeVersion: string;
  rubricVersion?: string;
}

export interface LaunchAgentInput {
  name: string;
  symbol: string;
  archetype: Archetype;
  persona: string;
  models: {
    primary: string;
    fallbacks: string[];
    chatTier: string;
  };
}

export interface LaunchPrepared {
  /** Predicted id (factory agentCount()+1) — can race a concurrent create; re-check after receipt. */
  agentId: number;
  predicted: true;
  /** The frozen agent.json (object, or exact bytes as a string). */
  agentJson: Record<string, unknown> | string;
  /** bytes32 hex. */
  configHash: string;
  imageId: string;
  expectedTreasuryEOA: string;
  actionEOA: string;
  createArgs: {
    factory: string;
    usdg: string;
    /** USDG base units integer string. */
    fee: string;
  };
  /**
   * SPEC-M4E §1b: the EXACT canonical file text the helper hashed. The web
   * round-trips these bytes (never re-serializes agentJson) to the publish
   * step. Optional: an older helper omits it (publish is then impossible).
   */
  agentJsonText?: string;
}

/**
 * SPEC-M4E §1b — POST /api/launch/publish {agentJsonText, configHash?} (helper,
 * proxied by web/app/api/launch/publish/route.ts) -> 200 LaunchPublished |
 * 413 (over 100 KiB) | 422 (hash/schema/moderation) | 502 (upload failed) |
 * 503 (publishing not configured on the helper).
 */
export interface LaunchPublished {
  /** 43-char base64url Arweave item id. */
  txId: string;
  /** "ar://<txId>". */
  ref: string;
  /** bytes32 hex — must equal the prepared configHash. */
  configHash: string;
}

/** A server-side moderation violation: a string (pinned shape) or the helper's structured object. */
export type LaunchViolation =
  | string
  | { category?: string; rule?: string; field?: string; match?: string; message: string };

/** 422 body. */
export interface LaunchViolations {
  error?: string;
  rubricVersion?: string;
  violations: LaunchViolation[];
}

// ---------------------------------------------------------------------------
// Web-internal (NOT an indexer mirror): the launch progress tracker's polling
// payload, served by web/app/api/launch/status/[id]/route.ts.
// ---------------------------------------------------------------------------

export interface LaunchStatus {
  agentId: number;
  /** Factory row observed by the indexer. */
  exists: boolean;
  state: AgentState | null;
  status: AgentStatus | null;
  name: string | null;
  /** Registry instance row observed (TEE booted + registered). */
  hasInstance: boolean;
  /** Attestation checks, null when not (yet) available. */
  checks: AttestationChecks | null;
  /** Unix seconds this status was assembled. */
  observedAt: number;
}

// ---------------------------------------------------------------------------
// SPEC-M4E §2 — indexer NFT endpoints (being built in parallel). Pinned
// contract DUPLICATED here by design (SPEC-M4A §2); web/lib/nfts.ts parses
// the wire shape TOLERANTLY (unknown fields ignored, bad values -> null).
//
//   GET /api/contracts                  -> ContractsResponse
//   GET /api/wallets/:address/nfts      -> WalletNftsResponse
// ---------------------------------------------------------------------------

/**
 * R5: the ONLY source of contract addresses for the web — nothing hardcoded.
 * Normalized by web/lib/nfts.ts `normalizeContracts`: the indexer serves the
 * manifest's address keys FLAT next to `chainId` (indexer/src/config.ts
 * contractsViewOf); an `addresses` sub-object is accepted too.
 */
export interface ContractsResponse {
  chainId: number;
  /** PRIMARY (v2) stack: factory, registry, nft, distributor, usdg, floorVault, platformToken, ... */
  addresses: Record<string, string>;
  /** SPEC-M4G §3 `stacks` (primary first); null when the indexer predates dual-stack. */
  stacks: StackInfo[] | null;
}

/** One agent NFT (tokenId == agentId, AgentNFT.sol:9) held by the wallet, as the web consumes it. */
export interface WalletNft {
  agentId: number;
  name: string | null;
  symbol: string | null;
  /** Unix seconds the wallet became owner, null if absent/unparseable. */
  since: number | null;
  /** From indexer Emancipated events (true only on a literal `true`). */
  emancipated: boolean;
  /** USDG base units integer string (sum of Claimed events), null if absent/malformed. */
  lifetimeClaimed: string | null;
  /**
   * USDG base units integer string swept to the treasury at burn (Emancipated
   * `sweptToTreasury`), null when unknown. Not in the pinned shape — read
   * tolerantly from the row, or enriched by the web route from the agent's
   * `emancipated` activity event.
   */
  sweptToTreasury: string | null;
  /**
   * SPEC-M4G: the agent's contract stack (claim/burn target addresses). Read
   * from the row when the indexer carries it, else enriched by the web route
   * from the agent payload's `stack`. null = unknown.
   */
  stack: AgentStack | null;
}

export interface WalletNftsResponse {
  address: string;
  nfts: WalletNft[];
}

// ---------------------------------------------------------------------------
// SPEC-M4F §1/§2 — launch-helper revive endpoints (genesis/src/launchHelper.ts,
// being built in parallel). Called ONLY server-side (M4B R4), proxied by
// web/app/api/revive/*. Pinned contract DUPLICATED here by design; the wire
// shape is parsed TOLERANTLY by web/lib/revive.ts (unknown fields ignored,
// bad values -> null — never NaN, never a guessed default).
//
//   GET  /api/revive/quote/:agentId  -> ReviveQuoteWire
//   POST /api/revive {agentId, payer, paymentTx}
//        -> 200 {revivalId} | 402 {error} | 409 {error, reason} | 503 manual mode
//   GET  /api/revive/status/:agentId -> {revivals: [{revivalId?, state, startedAt, payer, ...}]}
// ---------------------------------------------------------------------------

/**
 * Revival price (R6), as the web consumes it. Every amount is a base-10
 * integer string in USDC micro-units (6 dec). `usdc`/`chainId` are null when
 * the helper omitted them — the pay flow is then DISABLED (never guessed).
 */
export interface ReviveQuoteAmounts {
  rateUsdcMicroPerHour: string | null;
  durationMin: number | null;
  hostingUsdcMicro: string | null;
  gasSeedUsdMicro: string | null;
  totalUsdcMicro: string | null;
  /** The orchestrator funding wallet (R1). null when absent/malformed. */
  payTo: string | null;
  /** ERC-20 token to pay with — from the quote ONLY. */
  usdc: string | null;
  /** Chain the payment goes on — from the quote ONLY. */
  chainId: number | null;
  /** Token decimals the helper declares (optional wire field `decimals`), null when absent/malformed. */
  decimals: number | null;
  /** True when the wire carried a `decimals` field at all (a declared non-6 value disables payment). */
  decimalsDeclared: boolean;
}

/** On-chain revival gate (unix seconds / seconds). */
export interface ReviveGate {
  lastHeartbeat: number | null;
  revivalWindow: number | null;
  evictableAt: number | null;
}

/** One revivals-table row (R7 reviver credit). */
export interface RevivalHistoryItem {
  generation: number | null;
  payer: string | null;
  startedAt: number | null;
  state: string | null;
}

export interface ReviveQuote {
  agentId: number;
  /** True ONLY on a literal `true` from the helper (R2). */
  revivable: boolean;
  /** Refusal code (config_unavailable, heartbeat_fresh, ...), null when revivable. */
  reason: string | null;
  /** Free-text refusal detail, when the helper provides one. */
  detail: string | null;
  quote: ReviveQuoteAmounts | null;
  gate: ReviveGate;
  history: RevivalHistoryItem[];
}

/** Server-side quote read outcome (web/lib/reviveServer.ts). */
export type ReviveQuoteResult =
  | { kind: "ok"; quote: ReviveQuote }
  /** Helper unset, or it answered 503 (no genesisDb / payTo configured). */
  | { kind: "manual"; message: string | null }
  | { kind: "unavailable"; message: string };

/** One revival row from GET /api/revive/status (tolerant). */
export interface RevivalRow {
  revivalId: string | null;
  /** Orchestrator flow state (REQUESTED, DEPLOYING, AWAITING_REGISTER, SEEDING, RECONCILING, FINALIZING, LIVE, FAILED, …). */
  state: string | null;
  startedAt: number | null;
  payer: string | null;
  /** Generation at the time the revival was queued (the new one is > this). */
  startGeneration: number | null;
  failReason: string | null;
  lastError: string | null;
  updatedAt: number | null;
}

/**
 * Web-internal (NOT a helper mirror): the revival tracker's polling payload,
 * served by web/app/api/revive/status/[id]/route.ts — the helper's revival
 * rows joined with the indexer's instance row (the generation bump is the
 * visible proof).
 */
export interface ReviveStatus {
  agentId: number;
  helper: "ok" | "manual" | "unreachable";
  helperError: string | null;
  revivals: RevivalRow[];
  indexer: "ok" | "unreachable";
  /** Registered instance generation per the indexer, null when unknown. */
  generation: number | null;
  lastHeartbeat: number | null;
  status: AgentStatus | null;
  /** Unix seconds this status was assembled. */
  observedAt: number;
}

// ---------------------------------------------------------------------------
// SPEC-M4G §3 — GET /api/floor (indexer, being built in parallel). Pinned
// contract DUPLICATED here by design; parsed TOLERANTLY by web/lib/floor.ts
// (unknown fields ignored, bad values -> null — never NaN, never a guess).
//
//   GET /api/floor -> {enabled:false} | {enabled:true, vault, token, usdg,
//                      vaultUsdg, floorPriceX18, totals, recent, updatedAt}
// ---------------------------------------------------------------------------

export interface FloorTokenInfo {
  address: string | null;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  /** Token base units (18 dec) integer string. */
  totalSupply: string | null;
}

/** Lifetime totals. USDG amounts: 6-dec base-unit strings; token amounts: 18-dec base-unit strings. */
export interface FloorTotals {
  feePool: string | null;
  feeCurve: string | null;
  donations: string | null;
  redeemedUsdg: string | null;
  burnedTokens: string | null;
  strayBurned: string | null;
  redemptions: number | null;
}

/** One floor_flows row (kind in fee_pool | fee_curve | donation | redeem | stray_burn — free-form tolerated). */
export interface FloorFlow {
  txHash: string;
  logIndex: number | null;
  kind: string;
  account: string | null;
  usdg: string | null;
  tokens: string | null;
  agentId: number | null;
  ts: number | null;
  blockNumber: number | null;
}

export interface FloorView {
  vault: string | null;
  token: FloorTokenInfo;
  usdg: string | null;
  /** USDG base units held by the vault (B). */
  vaultUsdg: string | null;
  /** B·1e36/S as an integer string: USDG base units per whole token × 1e18; "0" when S = 0. */
  floorPriceX18: string | null;
  totals: FloorTotals;
  /** Newest first, ≤ 50. */
  recent: FloorFlow[];
  /** Unix seconds, null when absent. */
  updatedAt: number | null;
}

/** Server-side floor read outcome (web/lib/api.ts getFloor). */
export type FloorResult =
  | { kind: "ok"; floor: FloorView }
  /** {enabled:false}: no vault configured (the floor launches with the v2 stack). */
  | { kind: "disabled" }
  | { kind: "unavailable"; message: string };
