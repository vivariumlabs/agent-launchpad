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

/** Check names, in the indexer's evaluation order (SPEC-M4B §1b). */
export type AttestationCheckName =
  | "refShape"
  | "itemFound"
  | "reportParses"
  | "eoasMatch"
  | "configHashMatch"
  | "imageIdMatch"
  | "releaseMatch";

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
