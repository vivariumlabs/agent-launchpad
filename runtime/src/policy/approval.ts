// SPEC-M2 §1, §5. Pure, no I/O, no Date.now, no RNG.

import { keccak256, stringToBytes, type Hex } from "viem";
import type { Approval, ProposedAction, UnixSeconds } from "./types.js";

const HEX_STRING_RE = /^0x[0-9a-fA-F]*$/;

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "string") {
    return HEX_STRING_RE.test(value) ? value.toLowerCase() : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize(obj[key]);
    }
    return result;
  }
  return value;
}

/**
 * JSON encoding with recursively sorted keys, bigints as decimal strings,
 * and 0x-prefixed strings lowercased.
 *
 * Typed `unknown` (widened from `ProposedAction` per SPEC-M2 §1) so that
 * `config/schema.ts`'s `configHash` can reuse the exact same canonical
 * encoding, per the M2 scaffold spec item 4 ("using the same canonical
 * encoding as approval.ts (import it)"). Behavior for ProposedAction inputs
 * is unchanged.
 */
export function canonicalEncode(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** keccak256 of the utf8 bytes of canonicalEncode(action). */
export function actionHash(action: ProposedAction): Hex {
  return keccak256(stringToBytes(canonicalEncode(action)));
}

const TTL_SEC = 60 as const;

export function issueApproval(action: ProposedAction, now: UnixSeconds): Approval {
  return {
    actionHash: actionHash(action),
    issuedAt: now,
    ttlSec: TTL_SEC,
  };
}
