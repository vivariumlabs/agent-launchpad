// SPEC-M2B §5(c) / SPEC-M2 §7.3 — daily capability canaries.
//
// Fixed in-code prompt set (3 prompts): exact arithmetic, JSON echo of a nonce,
// instruction-following ("reply with exactly: <token>"). Scoring is a
// deterministic string match. Nonces/tokens are derived from (dayNumber,
// endpointId) via keccak256 — no RNG. Self-reported model identity is NEVER
// consulted: only the answer string is scored.
//
// Selection: one canary per endpoint per UTC day; prompt index = dayNumber mod 3.
// Verdict: the trailing window = the last 3 UTC days (today, today-1, today-2).
// Judged only when the window holds 3 results (one per day); score < 2/3
// (i.e. fewer than 2 passes) ⇒ unhealthy.

import { keccak256, stringToBytes } from "viem";
import type { UnixSeconds } from "../policy/types.js";
import { floorDiv, SECONDS_PER_DAY } from "../policy/util.js";

export type CanaryId = "arith" | "jsonEcho" | "exact";

export interface Canary {
  id: CanaryId;
  prompt: string;
  expected: string;
}

/** System prompt used for every canary call (also lets mocks recognize canaries). */
export const CANARY_SYSTEM = "You are being tested for instruction compliance. Output only what is asked, nothing else.";

export const CANARY_MAX_TOKENS = 64;

/** 17×23+9 = 400. */
export const ARITH_PROMPT = "Compute 17*23+9. Reply with only the resulting integer, no other text.";
export const ARITH_EXPECTED = "400";

export function dayNumberOf(now: UnixSeconds): bigint {
  return floorDiv(now, SECONDS_PER_DAY);
}

function derived(dayNumber: bigint, endpointId: string, tag: string): string {
  return keccak256(stringToBytes(`canary|${tag}|${dayNumber.toString(10)}|${endpointId}`)).slice(2, 18);
}

/** The canary for (endpoint, UTC day). Deterministic. */
export function canaryFor(endpointId: string, now: UnixSeconds): Canary {
  const day = dayNumberOf(now);
  const idx = Number(day % 3n);
  if (idx === 0) return { id: "arith", prompt: ARITH_PROMPT, expected: ARITH_EXPECTED };
  if (idx === 1) {
    const nonce = derived(day, endpointId, "nonce");
    const obj = JSON.stringify({ nonce });
    return { id: "jsonEcho", prompt: `Reply with only this JSON object, unchanged: ${obj}`, expected: obj };
  }
  const token = `tok-${derived(day, endpointId, "token")}`;
  return { id: "exact", prompt: `Reply with exactly: ${token}`, expected: token };
}

/** Deterministic string-match scoring (surrounding whitespace ignored). */
export function scoreCanary(canary: Canary, text: string): boolean {
  const t = text.trim();
  if (canary.id !== "jsonEcho") return t === canary.expected;
  let parsed: unknown;
  let expected: unknown;
  try {
    parsed = JSON.parse(t);
    expected = JSON.parse(canary.expected);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  const exp = expected as { nonce: string };
  return keys.length === 1 && keys[0] === "nonce" && (parsed as { nonce?: unknown }).nonce === exp.nonce;
}

export interface CanaryResult {
  dayNumber: bigint;
  pass: boolean;
}

export const CANARY_WINDOW_DAYS = 3n;

/**
 * Trailing-3-day verdict. "insufficient" until the window holds one result for
 * each of the last 3 UTC days; then "unhealthy" iff passes/3 < 2/3.
 */
export function canaryVerdict(history: readonly CanaryResult[], now: UnixSeconds): "healthy" | "unhealthy" | "insufficient" {
  const today = dayNumberOf(now);
  const byDay = new Map<bigint, boolean>();
  for (const r of history) {
    if (r.dayNumber > today - CANARY_WINDOW_DAYS && r.dayNumber <= today) byDay.set(r.dayNumber, r.pass);
  }
  if (BigInt(byDay.size) < CANARY_WINDOW_DAYS) return "insufficient";
  let passes = 0n;
  for (const p of byDay.values()) if (p) passes += 1n;
  // score < 2/3  ⇔  3·passes < 2·3
  return passes * 3n < 2n * CANARY_WINDOW_DAYS ? "unhealthy" : "healthy";
}
