// SPEC-M2B §6 step 1 — deterministic context bundle + prompt assembly.
//
// Same inputs ⇒ byte-identical rendered context (canonical JSON: sorted keys, bigints as
// decimal strings). Level-dependent limits (budget stretch, §6):
//             trailing actions   watchlist   chat summaries
//   full            20              10              5
//   trimmed          8               3              2
//   minimal          3               0              0
// Mentions and registry events are capped at 10 at every level.

import type { Address } from "viem";
import type { ResolvedConfig } from "../config/schema.js";
import { dayKeyOf, rollLedger } from "../ledger/ledger.js";
import type { ToolSpec, LlmMessage } from "../llm/types.js";
import { kvGet, listActions, listChats, listTrades, rollingSummaryGet, type MemoryDb } from "../memory/db.js";
import { canonicalEncode } from "../policy/approval.js";
import { categoryBudget, inferenceBudget } from "../policy/rules/inference.js";
import { runwayDays } from "../policy/runway.js";
import type { BudgetLedger, UnixSeconds, WalletBalances, WalletState } from "../policy/types.js";
import type { Tier } from "./tier.js";
import { WATCHLIST_KV_KEY } from "./tools.js";

export type ContextLevel = "full" | "trimmed" | "minimal";

export const CONTEXT_LIMITS: Readonly<Record<ContextLevel, { actions: number; watchlist: number; chats: number }>> = {
  full: { actions: 20, watchlist: 10, chats: 5 },
  trimmed: { actions: 8, watchlist: 3, chats: 2 },
  minimal: { actions: 3, watchlist: 0, chats: 0 },
};

export const MENTIONS_CAP = 10;
export const REGISTRY_EVENTS_CAP = 10;
const ACTION_JSON_CHARS = 300;
const TEXT_CHARS = 500;

// ---------------------------------------------------------------------------
// external (mock) sources
// ---------------------------------------------------------------------------

export interface MarketQuote {
  token: Address;
  priceUsdg: bigint; // USDG(6) per whole token
  volume24hUsdg: bigint;
}

export interface MarketDataSource {
  snapshot(tokens: readonly Address[]): Promise<MarketQuote[]>;
}

export interface Mention {
  hash: string;
  author: string;
  text: string;
  ts: UnixSeconds;
}

export interface MentionSource {
  unread(): Promise<Mention[]>;
}

export interface RegistryEvent {
  name: string;
  ts: UnixSeconds;
  data: string;
}

export interface RegistryEventSource {
  recent(): Promise<RegistryEvent[]>;
}

export interface ContextSources {
  market?: MarketDataSource;
  mentions?: MentionSource;
  registry?: RegistryEventSource;
}

// ---------------------------------------------------------------------------
// bundle
// ---------------------------------------------------------------------------

export interface ContextInput {
  db: MemoryDb;
  state: WalletState;
  ledger: BudgetLedger;
  cfg: ResolvedConfig;
  now: UnixSeconds;
  tier: Tier;
  level: ContextLevel;
  sources?: ContextSources;
  /** I1 rev 2: false when runway < minRunwayDays (floor withdrawn). */
  floorApplies?: boolean;
}

type Str<T> = { [K in keyof T]: string };

export interface ContextBundle {
  now: string;
  dayKey: string;
  tier: Tier;
  level: ContextLevel;
  runwayDays: string;
  balances: {
    treasury: Record<string, Record<string, string>>;
    action: Record<string, Record<string, string>>;
  };
  budget: { pulseBudget: string; pulseSpent: string; pulseRemaining: string };
  positions: Array<{ token: string; balance: string; trades: number; pnlUsdg: string }>;
  watchlist: string[];
  market: Array<Str<MarketQuote>>;
  mentions: Array<{ hash: string; author: string; text: string; ts: string }>;
  chatSummaries: string[];
  recentActions: Array<{ id: number; ts: string; kind: string; verdict: string; denyCode: string | null; error: string | null; json: string }>;
  selfSummary: string;
  registryEvents: Array<{ name: string; ts: string; data: string }>;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

function walletStrings(w: WalletBalances): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const chain of ["rh", "base", "arbitrum", "optimism"] as const) {
    const b = w[chain];
    const row: Record<string, string> = { native: b.native.toString(10) };
    if (b.USDG !== undefined) row["USDG"] = b.USDG.toString(10);
    if (b.USDC !== undefined) row["USDC"] = b.USDC.toString(10);
    for (const [t, v] of Object.entries(b.tokens ?? {})) row[t.toLowerCase()] = v.toString(10);
    out[chain] = row;
  }
  return out;
}

function readWatchlist(db: MemoryDb): Address[] {
  const raw = kvGet(db, WATCHLIST_KV_KEY);
  if (raw === undefined) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is Address => typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x));
  } catch {
    return [];
  }
}

export async function buildContext(input: ContextInput): Promise<ContextBundle> {
  const { db, state, cfg, now, tier, level } = input;
  const lim = CONTEXT_LIMITS[level];
  const L = rollLedger(input.ledger, now);

  const B = inferenceBudget(L, cfg, input.floorApplies ?? true); // I1 rev 2
  const pulseBudget = categoryBudget(B, "pulse", cfg);
  const pulseSpent = L.inferenceSpent.pulse;
  const remaining = pulseBudget > pulseSpent ? pulseBudget - pulseSpent : 0n;

  // Positions: action-wallet RH token balances + P&L aggregated from `trades`.
  const trades = listTrades(db);
  const agg = new Map<string, { trades: number; pnl: bigint }>();
  for (const t of trades) {
    const k = t.token.toLowerCase();
    const prev = agg.get(k) ?? { trades: 0, pnl: 0n };
    agg.set(k, { trades: prev.trades + 1, pnl: prev.pnl + t.pnlUsdg });
  }
  const tokenKeys = new Set<string>([...Object.keys(state.action.rh.tokens ?? {}).map((k) => k.toLowerCase()), ...agg.keys()]);
  const positions = [...tokenKeys].sort().map((token) => {
    let bal = 0n;
    for (const [k, v] of Object.entries(state.action.rh.tokens ?? {})) if (k.toLowerCase() === token) bal = v;
    const a = agg.get(token) ?? { trades: 0, pnl: 0n };
    return { token, balance: bal.toString(10), trades: a.trades, pnlUsdg: a.pnl.toString(10) };
  });

  const watchlist = readWatchlist(db).slice(0, lim.watchlist);
  const marketTokens: Address[] = [];
  if (cfg.agentTokenAddress !== undefined) marketTokens.push(cfg.agentTokenAddress);
  for (const t of watchlist) if (!marketTokens.some((m) => m.toLowerCase() === t.toLowerCase())) marketTokens.push(t);
  const quotes = input.sources?.market !== undefined ? await input.sources.market.snapshot(marketTokens) : [];
  const market = quotes
    .map((q) => ({ token: q.token.toLowerCase(), priceUsdg: q.priceUsdg.toString(10), volume24hUsdg: q.volume24hUsdg.toString(10) }))
    .sort((x, y) => (x.token < y.token ? -1 : x.token > y.token ? 1 : 0));

  const mentionsRaw = input.sources?.mentions !== undefined ? await input.sources.mentions.unread() : [];
  const mentions = [...mentionsRaw]
    .sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : 0))
    .slice(-MENTIONS_CAP)
    .map((m) => ({ hash: m.hash, author: m.author, text: clip(m.text, TEXT_CHARS), ts: m.ts.toString(10) }));

  const chatSummaries = lim.chats === 0 ? [] : listChats(db).filter((c) => c.dir === "summary").slice(-lim.chats).map((c) => clip(c.content, TEXT_CHARS));

  const recentActions = listActions(db)
    .slice(-lim.actions)
    .map((r) => ({
      id: r.id,
      ts: r.ts.toString(10),
      kind: r.kind,
      verdict: r.verdict,
      denyCode: r.denyCode,
      error: r.error === null ? null : clip(r.error, TEXT_CHARS),
      json: clip(r.json, ACTION_JSON_CHARS),
    }));

  const evRaw = input.sources?.registry !== undefined ? await input.sources.registry.recent() : [];
  const registryEvents = [...evRaw]
    .sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    .slice(-REGISTRY_EVENTS_CAP)
    .map((e) => ({ name: e.name, ts: e.ts.toString(10), data: clip(e.data, TEXT_CHARS) }));

  return {
    now: now.toString(10),
    dayKey: dayKeyOf(now),
    tier,
    level,
    runwayDays: runwayDays(state, now, undefined, cfg.bridgeHaircutBps).toString(10),
    balances: { treasury: walletStrings(state.treasury), action: walletStrings(state.action) },
    budget: { pulseBudget: pulseBudget.toString(10), pulseSpent: pulseSpent.toString(10), pulseRemaining: remaining.toString(10) },
    positions,
    watchlist: watchlist.map((w) => w.toLowerCase()),
    market,
    mentions,
    chatSummaries,
    recentActions,
    selfSummary: rollingSummaryGet(db),
    registryEvents,
  };
}

/** Canonical JSON (sorted keys) — deterministic. */
export function renderContext(bundle: ContextBundle): string {
  return canonicalEncode(bundle);
}

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

/** Platform guardrails (fixed, in the code hash — 03 §4). */
export const GUARDRAIL_PROMPT = [
  "You are an autonomous on-chain agent. Platform rules (non-negotiable):",
  "- No illegal content, no harassment, no financial-advice framing; you are an AI and say so if asked.",
  "- You can only act through the tools listed below. Every action is checked by a deterministic policy engine;",
  "  denied actions are recorded and shown to you next pulse. Treasury funds are not reachable by any tool.",
  "- Output ONE JSON object and nothing else:",
  '  {"toolCalls":[{"tool":"<name>","args":{...}}], "diary":"<private line>", "journal":"<optional public entry>", "posts":["<optional post>"]}',
  "- Amounts are base-unit integer strings. At most 5 tool calls are processed per pulse.",
].join("\n");

export function buildPrompt(cfg: ResolvedConfig, bundle: ContextBundle, tools: readonly ToolSpec[]): { system: string; messages: LlmMessage[] } {
  const system = [
    GUARDRAIL_PROMPT,
    `Archetype: ${cfg.agent.archetype}. Name: ${cfg.agent.name} ($${cfg.agent.symbol}).`,
    `Persona: ${cfg.agent.persona}`,
    `Tools: ${canonicalEncode(tools)}`,
  ].join("\n\n");
  return { system, messages: [{ role: "user", content: `Context:\n${renderContext(bundle)}` }] };
}

/** Prompt size in chars (system + messages + tool schema), for the maxCost estimate. */
export function promptChars(system: string, messages: readonly LlmMessage[], tools: readonly ToolSpec[]): number {
  let n = system.length + canonicalEncode(tools).length;
  for (const m of messages) n += m.content.length;
  return n;
}
