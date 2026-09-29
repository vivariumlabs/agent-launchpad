/**
 * SPEC-M4F §2 — revive-flow helpers, CLIENT-SAFE (no config secrets, no
 * fixtures import): tolerant parsers for the launch-helper's revive payloads,
 * honest refusal copy, the ERC-20 transfer ABI fragment and the tracker's
 * step derivation.
 *
 * Addresses and chain ids come ONLY from the quote payload (R1; M4E R5
 * discipline) — this file carries none.
 */
import { isAddress } from "./factory";
import { parseTimestamp } from "./format";
import type {
  AgentStatus,
  ReviveGate,
  ReviveQuote,
  ReviveQuoteAmounts,
  RevivalHistoryItem,
  RevivalRow,
} from "./types";

/** Standard ERC-20 fragments used by the revival payment (transfer + preflight reads + Transfer log). */
/**
 * M4F rev 1 — the payer-signed revive intent. MUST byte-match genesis/src/reviveApi.ts
 * reviveIntentMessage (keep in sync by hand): binds the payment tx to ONE agentId so a
 * front-runner cannot submit someone else's payment for a different agent.
 */
export function reviveIntentMessage(agentId: number, paymentTx: string): string {
  return `vivarium revive: agent ${agentId}, payment ${paymentTx.toLowerCase()}`;
}

export const usdcAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
] as const;

/** The quote's amounts are USDC micro-units — the token MUST have 6 decimals or the price is wrong. */
export const USDC_DECIMALS = 6;

// ---------------------------------------------------------------------------
// Tolerant scalar parsers (bad => null; never NaN).
// ---------------------------------------------------------------------------

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Non-negative integer (number or digit string) -> base-10 string. */
export function uintString(v: unknown): string | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    try {
      return BigInt(v.trim()).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/** Non-negative safe integer (number or digit string) -> number. */
export function safeInt(v: unknown): number | null {
  const s = uintString(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** Unix-seconds timestamp from a number, digit string (s or ms) or ISO string. */
function ts(v: unknown): number | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) return null;
    const n = Math.floor(v);
    return n >= 1e12 ? Math.floor(n / 1000) : n;
  }
  if (typeof v === "string") return parseTimestamp(v);
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function addr(v: unknown): string | null {
  return typeof v === "string" && isAddress(v.trim()) ? v.trim() : null;
}

// ---------------------------------------------------------------------------
// Wire -> view.
// ---------------------------------------------------------------------------

function parseAmounts(raw: unknown): ReviveQuoteAmounts | null {
  const q = obj(raw);
  if (!q) return null;
  return {
    rateUsdcMicroPerHour: uintString(q.rateUsdcMicroPerHour),
    durationMin: safeInt(q.durationMin),
    hostingUsdcMicro: uintString(q.hostingUsdcMicro),
    gasSeedUsdMicro: uintString(q.gasSeedUsdMicro),
    totalUsdcMicro: uintString(q.totalUsdcMicro),
    payTo: addr(q.payTo),
    // Pinned contract says `usdc`; the helper implementation (genesis/src/reviveApi.ts quoteJson) sends `token`.
    usdc: addr(q.usdc) ?? addr(q.token),
    chainId: safeInt(q.chainId),
    decimals: q.decimals === undefined ? null : safeInt(q.decimals),
    decimalsDeclared: q.decimals !== undefined,
  };
}

function parseGate(raw: unknown): ReviveGate {
  const g = obj(raw) ?? {};
  const lastHeartbeat = ts(g.lastHeartbeat);
  const revivalWindow = safeInt(g.revivalWindow);
  let evictableAt = ts(g.evictableAt);
  // Derive only from BOTH real values — never from a default window.
  if (evictableAt === null && lastHeartbeat !== null && lastHeartbeat > 0 && revivalWindow !== null) {
    evictableAt = lastHeartbeat + revivalWindow;
  }
  return { lastHeartbeat: lastHeartbeat === 0 ? null : lastHeartbeat, revivalWindow, evictableAt };
}

function parseHistory(raw: unknown): RevivalHistoryItem[] {
  if (!Array.isArray(raw)) return [];
  const out: RevivalHistoryItem[] = [];
  for (const r of raw) {
    const h = obj(r);
    if (!h) continue;
    out.push({
      generation: safeInt(h.generation),
      payer: addr(h.payer) ?? str(h.payer),
      startedAt: ts(h.startedAt),
      state: str(h.state),
    });
  }
  return out;
}

/** GET /api/revive/quote/:agentId body -> ReviveQuote, or null when unusable. */
export function parseReviveQuote(raw: unknown, expectedAgentId: number): ReviveQuote | null {
  const b = obj(raw);
  if (!b) return null;
  if (typeof b.revivable !== "boolean") return null;
  const agentId = safeInt(b.agentId);
  if (agentId !== null && agentId !== expectedAgentId) return null;
  return {
    agentId: expectedAgentId,
    revivable: b.revivable === true,
    reason: str(b.reason),
    detail: str(b.detail),
    quote: parseAmounts(b.quote),
    gate: parseGate(b.gate),
    history: parseHistory(b.history),
  };
}

/** The helper's revival rows (tolerant: revivalId | id, several failure-text spellings). */
export function parseRevivalRows(raw: unknown): RevivalRow[] {
  const b = obj(raw);
  const list = Array.isArray(b?.revivals) ? (b?.revivals as unknown[]) : Array.isArray(raw) ? (raw as unknown[]) : [];
  const out: RevivalRow[] = [];
  for (const r of list) {
    const o = obj(r);
    if (!o) continue;
    const id = o.revivalId ?? o.id;
    out.push({
      revivalId: typeof id === "number" && Number.isSafeInteger(id) ? String(id) : str(id),
      state: str(o.state),
      startedAt: ts(o.startedAt),
      payer: addr(o.payer) ?? str(o.payer),
      startGeneration: safeInt(o.startGeneration),
      failReason: str(o.failReason),
      lastError: str(o.lastError),
      updatedAt: ts(o.updatedAt),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pay-flow readiness (R2: no pay button unless the quote says revivable AND
// the quote carries everything a correct transfer needs).
// ---------------------------------------------------------------------------

export interface PayTarget {
  token: `0x${string}`;
  payTo: `0x${string}`;
  chainId: number;
  total: bigint;
  totalRaw: string;
}

export type PayReadiness = { ok: true; target: PayTarget } | { ok: false; why: string };

export function payReadiness(q: ReviveQuote): PayReadiness {
  if (!q.revivable) return { ok: false, why: "not revivable" };
  const a = q.quote;
  if (!a) return { ok: false, why: "The helper marked this agent revivable but sent no price quote." };
  if (a.usdc === null || a.chainId === null) {
    return {
      ok: false,
      why: "The quote does not name the payment token and chain, so this site will not guess them. Payment is disabled until the launch helper sends a complete quote.",
    };
  }
  if (a.decimalsDeclared && a.decimals !== USDC_DECIMALS) {
    return { ok: false, why: `The quote declares a ${a.decimals ?? "malformed"}-decimal token; its amounts are ${USDC_DECIMALS}-decimal USDC units. Payment disabled.` };
  }
  if (a.payTo === null) return { ok: false, why: "The quote has no valid payment recipient — payment disabled." };
  if (a.totalUsdcMicro === null) return { ok: false, why: "The quote has no valid total — payment disabled." };
  const total = BigInt(a.totalUsdcMicro);
  if (total <= 0n) return { ok: false, why: "The quote's total is zero — payment disabled." };
  if (a.chainId <= 0) return { ok: false, why: "The quote's chain id is invalid — payment disabled." };
  return {
    ok: true,
    target: {
      token: a.usdc as `0x${string}`,
      payTo: a.payTo as `0x${string}`,
      chainId: a.chainId,
      total,
      totalRaw: a.totalUsdcMicro,
    },
  };
}

// ---------------------------------------------------------------------------
// Honest refusal copy (R2). Unknown codes render the raw code + detail.
// ---------------------------------------------------------------------------

export function refusalText(reason: string | null): { title: string; body: string } {
  switch (reason) {
    case "config_unavailable":
      return {
        title: "No revivable configuration exists",
        body: "Reviving re-derives the agent's identity from its frozen config and the exact runtime build its code hash names. Neither can be found for this agent — typically because it predates config publication. Nothing can bring it back, so there is nothing to pay for.",
      };
    case "heartbeat_fresh":
      return {
        title: "Alive",
        body: "Its last heartbeat is inside the on-chain revival window. The registry refuses a new instance until the window passes.",
      };
    case "never_registered":
      return {
        title: "Never registered",
        body: "This agent never registered an instance on-chain, so there is no identity to revive.",
      };
    case "revival_in_progress":
      return {
        title: "Revival already in progress",
        body: "Someone has already paid and the orchestrator is working on it.",
      };
    case "unknown_agent":
      return { title: "Unknown agent", body: "The orchestrator has no record of this agent's creation." };
    default:
      return {
        title: "Not revivable",
        body: reason ? `The orchestrator's dry run refused this revival (${reason}).` : "The orchestrator's dry run refused this revival.",
      };
  }
}

// ---------------------------------------------------------------------------
// Tracker steps (SPEC-M4F §2): payment verified → queued → deploying →
// registered (generation N+1) → seeded/live.
// ---------------------------------------------------------------------------

export type StepState = "done" | "active" | "waiting" | "failed";

export interface TrackerStep {
  key: "verified" | "queued" | "deploying" | "registered" | "live";
  state: StepState;
}

const REGISTERED_STATES = new Set(["SEEDING", "RECONCILING", "FINALIZING", "LIVE"]);
const DEPLOY_STATES = new Set(["DEPLOYING", "AWAITING_REGISTER"]);

export interface TrackerInput {
  /** POST /api/revive answered 200 (known from the URL) — the helper verified the payment. */
  paymentAccepted: boolean;
  row: RevivalRow | null;
  /** Generation before the revival (row.startGeneration, else URL/quote). */
  startGeneration: number | null;
  indexerGeneration: number | null;
  indexerStatus: AgentStatus | null;
}

export function registeredObserved(t: TrackerInput): boolean {
  const state = t.row?.state ?? null;
  if (state !== null && REGISTERED_STATES.has(state)) return true;
  return t.startGeneration !== null && t.indexerGeneration !== null && t.indexerGeneration > t.startGeneration;
}

export function trackerSteps(t: TrackerInput): { steps: TrackerStep[]; live: boolean; failed: boolean } {
  const state = t.row?.state ?? null;
  const failed = state === "FAILED";
  const registered = registeredObserved(t);
  const live = state === "LIVE" || (state === null && registered && t.indexerStatus === "live");

  const verified = t.paymentAccepted || t.row !== null;
  const queuedDone = registered || (state !== null && state !== "REQUESTED");
  const deployDone = registered || state === "AWAITING_REGISTER";

  let s: StepState[] = [
    verified ? "done" : "active",
    queuedDone ? "done" : verified ? "active" : "waiting",
    deployDone ? "done" : state !== null && DEPLOY_STATES.has(state) ? "active" : "waiting",
    registered ? "done" : state === "AWAITING_REGISTER" ? "active" : "waiting",
    live ? "done" : registered ? "active" : "waiting",
  ];
  if (failed) {
    // The first not-done step is where it stopped.
    const i = s.findIndex((x) => x !== "done");
    s = s.map((x, j) => (j === i ? "failed" : j > i && i >= 0 ? "waiting" : x));
  }
  const keys: TrackerStep["key"][] = ["verified", "queued", "deploying", "registered", "live"];
  return { steps: keys.map((key, i) => ({ key, state: s[i] ?? "waiting" })), live, failed };
}

/** Pick the revival this tracker follows: the matching id, else the newest started at/after `since` (minus slack), else newest. */
export function pickRevival(rows: RevivalRow[], revivalId: string | null, since: number | null): RevivalRow | null {
  if (rows.length === 0) return null;
  if (revivalId !== null) {
    const hit = rows.find((r) => r.revivalId === revivalId);
    if (hit) return hit;
  }
  const byNewest = [...rows].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  if (since !== null) {
    const recent = byNewest.find((r) => r.startedAt !== null && r.startedAt >= since - 600);
    if (recent) return recent;
    return null;
  }
  return byNewest[0] ?? null;
}

/** "2d 3h 04m" / "12m 05s" countdown text for a positive number of seconds. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h ${pad(m)}m`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m ${pad(sec)}s`;
}

/** Whole-unit duration, e.g. "34 days", "5 hours". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  if (d >= 1) return `${d} day${d === 1 ? "" : "s"}`;
  const h = Math.floor(s / 3600);
  if (h >= 1) return `${h} hour${h === 1 ? "" : "s"}`;
  const m = Math.floor(s / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** Revival tracker deep link. */
export function reviveTrackUrl(p: {
  agentId: number;
  since: number;
  tx?: string | null;
  revivalId?: string | null;
  gen?: number | null;
}): string {
  const q = new URLSearchParams({ since: String(p.since) });
  if (p.tx) q.set("tx", p.tx);
  if (p.revivalId) q.set("rid", p.revivalId);
  if (p.gen !== null && p.gen !== undefined) q.set("gen", String(p.gen));
  return `/mausoleum/track/${p.agentId}?${q.toString()}`;
}
