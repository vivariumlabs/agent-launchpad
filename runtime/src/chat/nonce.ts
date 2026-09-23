// SPEC-M2C §1 — SIWE nonce store. `GET /nonce` → 16-byte hex, single-use, expires after
// cfg.chatNonceTtlSec (300 s), held in an in-memory Map with pruning.
//
// This file is the ONLY place in src/ permitted to use node:crypto randomBytes (hygiene
// test, test/policy/engine-global.test.ts). Time is always an explicit `now` (injected Clock).

import { randomBytes } from "node:crypto";
import type { UnixSeconds } from "../policy/types.js";

/** Random source (tests inject a deterministic one). */
export type RandomSource = (n: number) => Uint8Array;

export const NONCE_BYTES = 16;
/** Outstanding-nonce cap: GET /nonce is unauthenticated, so the map must be bounded (oldest evicted). */
export const DEFAULT_MAX_OUTSTANDING_NONCES = 10_000;

export interface NonceStoreOptions {
  ttlSec: bigint;
  random?: RandomSource;
  maxOutstanding?: number;
}

export interface IssuedNonce {
  nonce: string;
  expiresAt: UnixSeconds;
}

export interface NonceStore {
  issue(now: UnixSeconds): IssuedNonce;
  /** True iff `nonce` is known and unexpired at `now` (does NOT consume). */
  peek(nonce: string, now: UnixSeconds): boolean;
  /** Atomically check-and-delete: true iff `nonce` was known and unexpired at `now`. Single-use. */
  consume(nonce: string, now: UnixSeconds): boolean;
  size(): number;
}

const defaultRandom: RandomSource = (n) => new Uint8Array(randomBytes(n));

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function createNonceStore(opts: NonceStoreOptions): NonceStore {
  const ttl = opts.ttlSec;
  const random = opts.random ?? defaultRandom;
  const max = opts.maxOutstanding ?? DEFAULT_MAX_OUTSTANDING_NONCES;
  /** nonce → expiresAt (valid iff now < expiresAt). Insertion order ≈ issue order. */
  const live = new Map<string, UnixSeconds>();

  function prune(now: UnixSeconds): void {
    for (const [n, exp] of live) {
      if (now >= exp) live.delete(n);
    }
  }

  return {
    issue(now: UnixSeconds): IssuedNonce {
      prune(now);
      let nonce = "";
      do {
        const bytes = random(NONCE_BYTES);
        if (bytes.length !== NONCE_BYTES) throw new Error(`nonce: random source returned ${bytes.length} bytes`);
        nonce = toHex(bytes);
      } while (live.has(nonce));
      while (live.size >= max) {
        const oldest = live.keys().next();
        if (oldest.done === true) break;
        live.delete(oldest.value);
      }
      const expiresAt = now + ttl;
      live.set(nonce, expiresAt);
      return { nonce, expiresAt };
    },

    peek(nonce: string, now: UnixSeconds): boolean {
      const exp = live.get(nonce);
      return exp !== undefined && now < exp;
    },

    consume(nonce: string, now: UnixSeconds): boolean {
      const exp = live.get(nonce);
      if (exp === undefined) return false;
      live.delete(nonce);
      prune(now);
      return now < exp;
    },

    size(): number {
      return live.size;
    },
  };
}
