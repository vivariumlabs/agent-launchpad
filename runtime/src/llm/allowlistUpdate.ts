// SPEC-M3B §4 — platform-signed allowlist updates (04 §4: opt-in adoption of newer signed lists).
//
// Wire format (the fetched document; transport UNTRUSTED — only the signature counts):
//   { "payload": { "version": <int ≥ 1>, "validFrom": <unix s>, "entries": X402AllowlistEntry[] },
//     "signature": "0x<65-byte EIP-191 personal_sign>" }
// signature = personal_sign(canonicalEncode(payload)) by the platform allowlist key; verified with viem
// recoverMessageAddress == cfg.allowlistUpdateSigner (FROZEN, hash-bound). The signed message is the
// canonical encoding of the RAW payload as received (before zod coercion), exactly as frozenConfigHash is
// computed over the raw agent.json — so signer and verifier never depend on schema defaults.
//
// Gates, ALL required before anything is persisted (fetchAndAdopt):
//   opted in (agent.adoptAllowlistUpdates, frozen) — opted out ⇒ the source is never called
//   signer configured → envelope shape → signature recovers to the signer → payload schema (strict;
//   entries = the existing X402AllowlistEntrySchema) → version > adoptedVersion (kv; genesis = 0) →
//   validFrom ≤ now → ≥ MIN_INDEPENDENT_OPERATORS distinct inference operators.
// Adoption is atomic: next cfg built first; the signed envelope + version persisted in ONE kv
// transaction; then deps.apply(next) (boot swaps deps.cfg — a single object swap; the engine stays pure,
// cfg is per-call input — and reloads the EndpointManager + keyring K3 view); then a journal draft
// through execute() (normal J1 caps; a J1 deny never undoes the adoption).
//
// Boot re-apply (reapplyAdoptedAllowlist): the newest adopted envelope in kv is RE-VERIFIED in full
// (signature, schema, operators, stored version == payload.version) before it replaces the genesis list —
// the memory DB is not a trust root for spend-bearing config. Failure ⇒ loud error, genesis list,
// replay floor (adoptedVersion) left untouched.

import { recoverMessageAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { X402AllowlistEntrySchema, type ResolvedConfig, type X402AllowlistEntry } from "../config/schema.js";
import type { ExecResult } from "../exec/execute.js";
import { kvGet, kvSet, type MemoryDb } from "../memory/db.js";
import { canonicalEncode } from "../policy/approval.js";
import type { UnixSeconds } from "../policy/types.js";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** kv: the newest adopted signed envelope, JSON `{ payload, signature }` (payload = raw signed object). */
export const KV_ALLOWLIST_ADOPTED = "allowlist:adopted";
/** kv: adopted version (decimal). Absent ⇒ 0 (the genesis list pinned in agent.json). */
export const KV_ALLOWLIST_VERSION = "allowlist:adoptedVersion";
/** kv: last update check (decimal unix s) — daemon step 11 cadence. */
export const KV_ALLOWLIST_LAST_CHECK = "allowlist:lastCheckAt";
/** DEFAULT check interval (runtime.allowlistUpdateIntervalSec): once per day. */
export const ALLOWLIST_CHECK_INTERVAL_SEC = 86_400n;
/** 04 §4: N ≥ 3 independent operators at all times. */
export const MIN_INDEPENDENT_OPERATORS = 3;

// ---------------------------------------------------------------------------
// schemas
// ---------------------------------------------------------------------------

export const AllowlistUpdatePayloadSchema = z
  .object({
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    validFrom: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    entries: z.array(X402AllowlistEntrySchema),
  })
  .strict();

export interface AllowlistUpdatePayload {
  version: number;
  validFrom: number;
  entries: X402AllowlistEntry[];
}

const SignatureSchema = z.custom<Hex>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{130}$/.test(v), {
  message: "signature must be 65-byte hex",
});

export const SignedAllowlistEnvelopeSchema = z.object({ payload: z.unknown(), signature: SignatureSchema }).strict();

export interface SignedAllowlistEnvelope {
  /** The RAW signed payload object (what canonicalEncode is computed over). */
  payload: unknown;
  signature: Hex;
}

// ---------------------------------------------------------------------------
// verification (pure except signature recovery)
// ---------------------------------------------------------------------------

export type AllowlistRejectCode =
  | "OPTED_OUT"
  | "NO_SIGNER"
  | "FETCH"
  | "MALFORMED"
  | "SIGNATURE"
  | "SCHEMA"
  | "NOT_NEWER"
  | "NOT_YET_VALID"
  | "OPERATORS";

export type VerifyResult =
  | { ok: true; envelope: SignedAllowlistEnvelope; payload: AllowlistUpdatePayload }
  | { ok: false; code: AllowlistRejectCode; detail: string };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The EIP-191 message the platform key signs: canonicalEncode(raw payload). */
export function allowlistSigningMessage(payload: unknown): string {
  return canonicalEncode(payload);
}

/** Distinct operators among INFERENCE entries (trimmed, case-insensitive). */
export function independentOperators(entries: readonly X402AllowlistEntry[]): number {
  return new Set(entries.filter((e) => e.kind === "inference").map((e) => e.operator.trim().toLowerCase())).size;
}

/**
 * Envelope → signature → payload schema → operator floor. Version / validFrom are the caller's
 * (they depend on kv + clock). Never throws.
 */
export async function verifySignedAllowlist(raw: unknown, signer: Address): Promise<VerifyResult> {
  const env = SignedAllowlistEnvelopeSchema.safeParse(raw);
  if (!env.success) return { ok: false, code: "MALFORMED", detail: `envelope: ${env.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  const envelope: SignedAllowlistEnvelope = { payload: env.data.payload, signature: env.data.signature };
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({ message: allowlistSigningMessage(envelope.payload), signature: envelope.signature });
  } catch (e) {
    return { ok: false, code: "SIGNATURE", detail: `unrecoverable signature: ${errMsg(e)}` };
  }
  if (recovered.toLowerCase() !== signer.toLowerCase()) {
    return { ok: false, code: "SIGNATURE", detail: `signed by ${recovered}, not the frozen allowlistUpdateSigner ${signer}` };
  }
  // safeParse is NOT enough: bigintCoerce's transform THROWS (BigInt("lots") ⇒ SyntaxError) instead of
  // reporting an issue — a throw is a schema failure too.
  let p: ReturnType<typeof AllowlistUpdatePayloadSchema.safeParse>;
  try {
    p = AllowlistUpdatePayloadSchema.safeParse(envelope.payload);
  } catch (e) {
    return { ok: false, code: "SCHEMA", detail: `entry coercion failed: ${errMsg(e)}` };
  }
  if (!p.success) return { ok: false, code: "SCHEMA", detail: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const payload: AllowlistUpdatePayload = p.data;
  const ops = independentOperators(payload.entries);
  if (ops < MIN_INDEPENDENT_OPERATORS) {
    return { ok: false, code: "OPERATORS", detail: `${ops} independent inference operators < ${MIN_INDEPENDENT_OPERATORS} (04 §4)` };
  }
  return { ok: true, envelope, payload };
}

/** kv adopted version (0 = genesis list). A malformed value reads as +∞ (never lowers the replay floor). */
export function adoptedVersion(db: MemoryDb): number {
  const v = kvGet(db, KV_ALLOWLIST_VERSION);
  if (v === undefined) return 0;
  return /^\d+$/.test(v) ? Number(v) : Number.POSITIVE_INFINITY;
}

/** ResolvedConfig with ONLY the allowlist replaced (every other field — caps, addresses — kept). */
export function withAllowlist(cfg: ResolvedConfig, entries: readonly X402AllowlistEntry[]): ResolvedConfig {
  return { ...cfg, x402Allowlist: entries.map((e) => ({ ...e })) };
}

// ---------------------------------------------------------------------------
// fetchAndAdopt
// ---------------------------------------------------------------------------

/** Untrusted transport: returns the raw document text (src/llm/allowlistFetch.ts = the network impl). */
export interface AllowlistSource {
  load(): Promise<string>;
}

export interface AllowlistUpdateDeps {
  /** adoptsAllowlistUpdates(cfg.agent) — FROZEN. false ⇒ the source is never called. */
  optedIn: boolean;
  /** cfg.allowlistUpdateSigner (FROZEN). Absent ⇒ nothing can be verified ⇒ never fetches. */
  signer: Address | undefined;
  source: AllowlistSource;
  db: MemoryDb;
  clock(): UnixSeconds;
  /** Current effective config. */
  cfg(): ResolvedConfig;
  /** Swap in the adopted config (deps.cfg + EndpointManager reload + keyring K3 view). */
  apply(next: ResolvedConfig): void;
  /** Persona-visible adoption event: a journal draft through execute() (J1 caps). null ⇒ not drafted. */
  journal?(text: string): Promise<ExecResult | null>;
}

export type AdoptResult =
  | {
      status: "adopted";
      version: number;
      validFrom: number;
      previousVersion: number;
      added: string[];
      removed: string[];
      operators: number;
      journal: ExecResult | null;
    }
  | { status: "rejected"; code: AllowlistRejectCode; detail: string };

/** Adoption journal text (bounded id lists; J1 still enforces journalMaxBytes). */
export function adoptionJournalText(r: { version: number; validFrom: number; previousVersion: number; added: string[]; removed: string[]; operators: number; total: number }): string {
  const list = (xs: string[]): string => (xs.length === 0 ? "none" : xs.length <= 20 ? xs.join(", ") : `${xs.slice(0, 20).join(", ")} (+${xs.length - 20} more)`);
  return (
    `[allowlist] I adopted the platform-signed endpoint allowlist v${r.version} (valid from ${r.validFrom}; was v${r.previousVersion}): ` +
    `${r.total} endpoints across ${r.operators} independent operators. Added: ${list(r.added)}. Removed: ${list(r.removed)}.`
  );
}

export async function fetchAndAdopt(deps: AllowlistUpdateDeps): Promise<AdoptResult> {
  if (!deps.optedIn) return { status: "rejected", code: "OPTED_OUT", detail: "agent opted out of allowlist updates at genesis (frozen)" };
  const signer = deps.signer;
  if (signer === undefined) return { status: "rejected", code: "NO_SIGNER", detail: "no frozen platform.allowlistUpdateSigner — updates cannot be verified" };

  let text: string;
  try {
    text = await deps.source.load();
  } catch (e) {
    return { status: "rejected", code: "FETCH", detail: errMsg(e) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { status: "rejected", code: "MALFORMED", detail: `invalid JSON: ${errMsg(e)}` };
  }
  const v = await verifySignedAllowlist(raw, signer);
  if (!v.ok) return { status: "rejected", code: v.code, detail: v.detail };
  const { payload, envelope } = v;

  const previousVersion = adoptedVersion(deps.db);
  if (!(payload.version > previousVersion)) {
    return { status: "rejected", code: "NOT_NEWER", detail: `version ${payload.version} <= adopted ${previousVersion}` };
  }
  const now = deps.clock();
  if (BigInt(payload.validFrom) > now) {
    return { status: "rejected", code: "NOT_YET_VALID", detail: `validFrom ${payload.validFrom} > now ${now}` };
  }

  // Everything that can fail is done; build → persist atomically → swap.
  const current = deps.cfg();
  const next = withAllowlist(current, payload.entries);
  const before = new Set(current.x402Allowlist.map((e) => e.id));
  const after = new Set(payload.entries.map((e) => e.id));
  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  deps.db.transaction(() => {
    kvSet(deps.db, KV_ALLOWLIST_ADOPTED, JSON.stringify({ payload: envelope.payload, signature: envelope.signature }));
    kvSet(deps.db, KV_ALLOWLIST_VERSION, payload.version.toString(10));
  })();
  deps.apply(next);

  const operators = independentOperators(payload.entries);
  let journal: ExecResult | null = null;
  if (deps.journal !== undefined) {
    journal = await deps.journal(
      adoptionJournalText({ version: payload.version, validFrom: payload.validFrom, previousVersion, added, removed, operators, total: payload.entries.length }),
    );
  }
  return { status: "adopted", version: payload.version, validFrom: payload.validFrom, previousVersion, added, removed, operators, journal };
}

// ---------------------------------------------------------------------------
// boot re-apply
// ---------------------------------------------------------------------------

export interface ReapplyDeps {
  optedIn: boolean;
  signer: Address | undefined;
  db: MemoryDb;
  /** Genesis (frozen) config the adopted list is applied onto. */
  base: ResolvedConfig;
  logger: { info(m: string): void; error(m: string): void };
}

export type ReapplyResult = { cfg: ResolvedConfig; version: number } | null;

/** Boot, BEFORE the first pulse: newest adopted envelope from kv, fully re-verified, or null (genesis list). */
export async function reapplyAdoptedAllowlist(deps: ReapplyDeps): Promise<ReapplyResult> {
  const stored = kvGet(deps.db, KV_ALLOWLIST_ADOPTED);
  if (stored === undefined) return null;
  if (!deps.optedIn) {
    deps.logger.error("allowlist: an adopted allowlist is stored but this agent opted out at genesis — IGNORED (genesis list in force)");
    return null;
  }
  if (deps.signer === undefined) {
    deps.logger.error("allowlist: an adopted allowlist is stored but no frozen allowlistUpdateSigner — IGNORED (genesis list in force)");
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch (e) {
    deps.logger.error(`!!! allowlist: stored adopted allowlist is not JSON (${errMsg(e)}) — IGNORED, genesis list in force !!!`);
    return null;
  }
  const v = await verifySignedAllowlist(raw, deps.signer);
  if (!v.ok) {
    deps.logger.error(`!!! allowlist: stored adopted allowlist FAILED re-verification (${v.code}: ${v.detail}) — IGNORED, genesis list in force !!!`);
    return null;
  }
  const kvVersion = adoptedVersion(deps.db);
  if (kvVersion !== v.payload.version) {
    deps.logger.error(`!!! allowlist: stored adopted allowlist v${v.payload.version} != adoptedVersion ${kvVersion} — IGNORED, genesis list in force !!!`);
    return null;
  }
  deps.logger.info(`allowlist: re-applied adopted signed allowlist v${v.payload.version} (${v.payload.entries.length} entries)`);
  return { cfg: withAllowlist(deps.base, v.payload.entries), version: v.payload.version };
}

// ---------------------------------------------------------------------------
// daemon step 11 hook
// ---------------------------------------------------------------------------

/** Due iff no (parseable) last check, or now − last ≥ intervalSec. */
export function allowlistCheckDue(db: MemoryDb, now: UnixSeconds, intervalSec: bigint = ALLOWLIST_CHECK_INTERVAL_SEC): boolean {
  const raw = kvGet(db, KV_ALLOWLIST_LAST_CHECK);
  if (raw === undefined || !/^\d+$/.test(raw)) return true;
  return now - BigInt(raw) >= intervalSec;
}

/** Codes that are routine outcomes of a daily poll (skip), not failures (step error). */
const ROUTINE: ReadonlySet<AllowlistRejectCode> = new Set(["NOT_NEWER", "NOT_YET_VALID"]);

export interface AllowlistStepOutcome {
  /** undefined ⇒ ran (adopted); string ⇒ skip reason. Security/transport rejections THROW (step error). */
  skip?: string;
  notes: string[];
  results: ExecResult[];
}

/**
 * One step-11 check: records the check time FIRST (one attempt per interval, success or not), then
 * fetchAndAdopt. Rejections other than NOT_NEWER / NOT_YET_VALID throw so the daemon reports a step error.
 */
export async function runAllowlistCheck(deps: AllowlistUpdateDeps, now: UnixSeconds): Promise<AllowlistStepOutcome> {
  kvSet(deps.db, KV_ALLOWLIST_LAST_CHECK, now.toString(10));
  const r = await fetchAndAdopt(deps);
  if (r.status === "rejected") {
    if (ROUTINE.has(r.code)) return { skip: `no adoptable update (${r.code}: ${r.detail})`, notes: [], results: [] };
    throw new Error(`allowlist update rejected (${r.code}): ${r.detail}`);
  }
  const notes = [`adopted signed allowlist v${r.version} (was v${r.previousVersion}); added [${r.added.join(", ")}], removed [${r.removed.join(", ")}]`];
  if (r.journal === null) notes.push("adoption journal not drafted");
  else if (!r.journal.verdict.allow) notes.push(`adoption journal denied: ${r.journal.verdict.code}`);
  return { notes, results: r.journal === null ? [] : [r.journal] };
}
