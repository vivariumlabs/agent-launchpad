// SPEC-M3B §4 test helper: a scripted PLATFORM allowlist key that produces valid signed update documents
// (EIP-191 personal_sign over canonicalEncode(payload)), plus a scripted AllowlistSource.

import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { allowlistSigningMessage, type AllowlistSource } from "../../src/llm/allowlistUpdate.js";

/** Scripted platform allowlist key (test-only). */
export const PLATFORM_ALLOWLIST_KEY = `0x${"a1".repeat(32)}` as Hex;
export const PLATFORM_ALLOWLIST_SIGNER: Address = privateKeyToAccount(PLATFORM_ALLOWLIST_KEY).address;
/** Some OTHER key (wrong signer). */
export const ROGUE_KEY = `0x${"b2".repeat(32)}` as Hex;

/** Raw JSON allowlist entry (as the platform publishes it: bigint fields as decimal strings). */
export function rawEntry(id: string, operator: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const n = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 0xffffffff, 7).toString(16).padStart(8, "0");
  return {
    id,
    kind: "inference",
    operator,
    url: `https://${id}.invalid`,
    payTo: `0xee${n}${"0".repeat(30)}`,
    model: `model-${id}`,
    tier: "cheap",
    maxPricePerMTokUsd: "1000000",
    attested: false,
    ...over,
  };
}

export interface RawPayload {
  version: number;
  validFrom: number;
  entries: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export function rawPayload(version: number, validFrom: number, entries: Array<Record<string, unknown>>): RawPayload {
  return { version, validFrom, entries };
}

/** Signed envelope object { payload, signature } by `key` (DEFAULT the platform key). */
export async function signEnvelope(payload: unknown, key: Hex = PLATFORM_ALLOWLIST_KEY): Promise<{ payload: unknown; signature: Hex }> {
  const signature = await privateKeyToAccount(key).signMessage({ message: allowlistSigningMessage(payload) });
  return { payload, signature };
}

/** Signed document text (what the platform serves). */
export async function signedDoc(payload: unknown, key: Hex = PLATFORM_ALLOWLIST_KEY): Promise<string> {
  return JSON.stringify(await signEnvelope(payload, key));
}

/** Three independent operators (the 04 §4 floor), ids a/b/c unless given. */
export function threeOps(prefix = "ep"): Array<Record<string, unknown>> {
  return [rawEntry(`${prefix}-1`, "op-one"), rawEntry(`${prefix}-2`, "op-two"), rawEntry(`${prefix}-3`, "op-three")];
}

/** Scripted transport: serves queued docs (string) or throws queued Errors; counts calls. */
export class ScriptedAllowlistSource implements AllowlistSource {
  calls = 0;
  readonly queue: Array<string | Error> = [];
  /** Served when the queue is empty (null ⇒ throw). */
  fallback: string | null = null;

  push(...docs: Array<string | Error>): this {
    this.queue.push(...docs);
    return this;
  }

  async load(): Promise<string> {
    this.calls++;
    const next = this.queue.shift() ?? this.fallback;
    if (next === null) throw new Error("scripted source: nothing to serve");
    if (next instanceof Error) throw next;
    return next;
  }
}
