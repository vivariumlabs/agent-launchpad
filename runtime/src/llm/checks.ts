// SPEC-M2B §5(a)(b) / SPEC-M2 §7.1–7.2 — per-call identity/sanity checks.
//
//   (a) price ceiling: quoted price > allowlist maxPricePerMTokUsd ⇒ fail (caller marks unhealthy 6h + rotates)
//   (b) contract: response must be non-empty, respect maxTokens (chars ≤ maxTokens × 4
//       heuristic), JSON-parse, and zod-parse to the pulse tool-call envelope (strict).
//       Per-tool arg validation happens in the tool table (src/pulse/tools.ts).
//   consecutive-failure counter: N consecutive contract failures (cfg.contractFailureLimit,
//       3 DEFAULT) ⇒ caller marks the endpoint unhealthy (1h DEFAULT).
// Self-reported model identity is never read.

import { z } from "zod";
import type { X402AllowlistEntry } from "../config/schema.js";

// ---------------------------------------------------------------------------
// (a) price ceiling
// ---------------------------------------------------------------------------

export function priceWithinCeiling(entry: Pick<X402AllowlistEntry, "maxPricePerMTokUsd">, quotedPerMTokUsd: bigint): boolean {
  return quotedPerMTokUsd <= entry.maxPricePerMTokUsd;
}

// ---------------------------------------------------------------------------
// (b) contract checks — the tool-call envelope
// ---------------------------------------------------------------------------

export const ToolCallSchema = z
  .object({
    tool: z.string().min(1).max(64),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ToolCall = z.infer<typeof ToolCallSchema>;

/** SPEC-M2B §6 step 5: `{ toolCalls?: [], diary?: string, journal?: string, posts?: string[] }` (strict).
 *  SPEC-M3 §3: + optional `publicSummary` (≤ 1000 chars, enforced by the pulse when writing kv —
 *  an over-long summary is a logged skip, not a contract failure of the whole response). */
export const PulseOutputSchema = z
  .object({
    toolCalls: z.array(ToolCallSchema).optional(),
    diary: z.string().optional(),
    journal: z.string().optional(),
    posts: z.array(z.string()).optional(),
    publicSummary: z.string().optional(),
  })
  .strict();

export type PulseOutput = z.infer<typeof PulseOutputSchema>;

export type ContractCheck = { ok: true; output: PulseOutput } | { ok: false; reason: string };

/** chars × 4 heuristic: a response of `text.length` chars ≈ text.length / 4 tokens. */
export function withinMaxTokens(text: string, maxTokens: number): boolean {
  return text.length <= maxTokens * 4;
}

export function contractCheck(text: string, maxTokens: number): ContractCheck {
  if (typeof text !== "string" || text.trim().length === 0) return { ok: false, reason: "empty response" };
  if (!withinMaxTokens(text, maxTokens)) {
    return { ok: false, reason: `response ${text.length} chars exceeds maxTokens ${maxTokens} (×4 chars)` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "response is not valid JSON" };
  }
  const r = PulseOutputSchema.safeParse(json);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first !== undefined && first.path.length > 0 ? first.path.join(".") : "(root)";
    return { ok: false, reason: `schema: ${where}: ${first?.message ?? "invalid"}` };
  }
  return { ok: true, output: r.data };
}

// ---------------------------------------------------------------------------
// consecutive-failure counter
// ---------------------------------------------------------------------------

export class ConsecutiveFailureCounter {
  private readonly counts = new Map<string, number>();

  /** Records a failure; returns the new consecutive count. */
  fail(id: string): number {
    const n = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, n);
    return n;
  }

  succeed(id: string): void {
    this.counts.set(id, 0);
  }

  reset(id: string): void {
    this.counts.set(id, 0);
  }

  count(id: string): number {
    return this.counts.get(id) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// cost estimate (SPEC-M2B §6 step 2)
// ---------------------------------------------------------------------------

const MTOK = 1_000_000n;

/**
 * SPEC-M3 §3c: maxCostUsd = ceil((ceil(promptChars / 4) + maxTokens) × pricePerMTokUsd × 1.5 / 1e6),
 * clamped to [1, maxPerCallUsd]. All USD(6) bigint. The output allowance (maxTokens) is part of the
 * estimate: a real x402 quote is priced for max_tokens of output, and the transport rejects any
 * quote above the estimate — an input-only estimate would price-reject every honest endpoint.
 */
export function estimateMaxCostUsd(promptChars: number, maxTokens: number, pricePerMTokUsd: bigint, maxPerCallUsd: bigint): bigint {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) throw new Error(`estimateMaxCostUsd: maxTokens must be a non-negative integer, got ${maxTokens}`);
  const tokens = (BigInt(promptChars) + 3n) / 4n + BigInt(maxTokens);
  const num = tokens * pricePerMTokUsd * 3n;
  const den = 2n * MTOK;
  let cost = (num + den - 1n) / den;
  if (cost > maxPerCallUsd) cost = maxPerCallUsd;
  if (cost < 1n) cost = 1n;
  return cost;
}
