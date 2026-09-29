/**
 * SPEC-M4G dual-stack helpers (client-safe, pure). The legacy v1 stack
 * (agents 1–11) stays live; the v2 stack issues agent ids from 101. Per-agent
 * contract addresses come from the agent payload's `stack` (indexer), the
 * launch flow uses the PRIMARY (v2) factory from /api/contracts. Nothing here
 * carries an address.
 */
import { isAddress } from "./factory";
import type { AgentFees, AgentStack, AgentView, StackInfo } from "./types";

/** Legacy badge copy — SPEC-M4G §4, verbatim. */
export const LEGACY_STACK_COPY = "legacy stack — its platform leg went to the retired buyback";

function intOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** Tolerant `stack` parse: null unless version is an integer and all five addresses are well-formed. */
export function normalizeStack(raw: unknown): AgentStack | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const version = intOf(r.version);
  if (version === null) return null;
  const addr = (k: string): `0x${string}` | null => {
    const v = r[k];
    return typeof v === "string" && isAddress(v) ? v : null;
  };
  const factory = addr("factory");
  const registry = addr("registry");
  const hook = addr("hook");
  const distributor = addr("distributor");
  const nft = addr("nft");
  if (!factory || !registry || !hook || !distributor || !nft) return null;
  return { version, legacy: r.legacy === true, factory, registry, hook, distributor, nft };
}

/** `/api/contracts` stacks[] entry. */
export function normalizeStackInfo(raw: unknown): StackInfo | null {
  const s = normalizeStack(raw);
  if (!s) return null;
  const r = raw as Record<string, unknown>;
  return { ...s, startBlock: intOf(r.startBlock), firstAgentId: intOf(r.firstAgentId) };
}

/** The agent's validated stack, null when the indexer omitted it or sent garbage. */
export function agentStack(agent: Pick<AgentView, "stack">): AgentStack | null {
  return normalizeStack(agent.stack ?? null);
}

/**
 * Lifetime platform leg (USDG base units string). Tolerates a pre-rename
 * indexer that still sends `buybackLeg`; null when neither is a uint string.
 */
export function platformLegOf(fees: AgentFees): string | null {
  const f = fees as unknown as Record<string, unknown>;
  const v = f.platformLeg ?? f.buybackLeg;
  return typeof v === "string" && /^\d+$/.test(v) ? v : null;
}

/** Fee-breakdown label for the platform leg — SPEC-M4G §4. Unknown stack => neutral label. */
export function platformLegLabel(stack: AgentStack | null): string {
  if (stack === null) return "Platform leg";
  return stack.legacy ? "Platform leg (legacy buyback)" : "Floor vault";
}
