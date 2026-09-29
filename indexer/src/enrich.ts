// SPEC-M4A §3 enrich.ts — journal discovery + trust chain (indexer half).
//
// Per agent with a registered instance (every enrichSec, DEFAULT 120):
//   1. Pin (once per agent; SPEC-M4A §3.1 rev 1): the ONLY pin source is the Arweave item whose id
//      EQUALS the on-chain instance.attestationRef (instances row, kept fresh by the instanceOf
//      reconcile). Tagged items are never a pin source — anyone can upload those; only the agent
//      (registering from inside the enclave) controls attestationRef. Attempted only when the ref
//      looks like an Arweave item id (43-char base64url); drill refs such as
//      "attestation-1790597593.json" never pin and trigger no fetch. The item is fetched BY ID from the
//      gateway (step 3 redirect rule); its top-level JSON eoas.treasury (runtime AttestationReport,
//      runtime/src/attestation/attestation.ts:70/94) must equal the registered treasuryEOA
//      (case-insensitive); its owner (GraphQL lookup by id) becomes journal_owner. Mismatch or fetch
//      failure ⇒ stay unpinned, warned once per agent per process (a mismatched ref is not re-fetched
//      while unchanged; a failed fetch is retried next pass). Until pinned, journal items from ANY
//      owner are ingested with unverified = 1. On pin: other-owner rows are deleted, pinned-owner rows
//      marked verified, and only pinned-owner items are ingested from then on (GraphQL owners filter
//      + local re-check).
//   2. Discovery: Arweave GraphQL, tags App=agent-launchpad, AgentId=<id>, Kind=journal, newest first
//      (sort HEIGHT_DESC). The gateway is UNTRUSTED: every node's tags are re-checked locally.
//   3. Item fetch: gateway GET /<id>, following AT MOST ONE redirect and only to an https host ending
//      ".arweave.net" (the turboHttp.ts download rule). Journal payload {v:1, agentId, ts, text};
//      rejected LOUDLY (skipped, remembered for the process lifetime) on: non-JSON / wrong shape,
//      agentId mismatch, text > 4096 chars, ts outside [block time − 1d, block time + 1d] when the
//      item's block time is known.
//   4. Incremental: a per-agent cursor (`enrich.<agentId>.height` + the mode it was taken in) holds
//      the highest block height fully processed; paging stops once a page reaches items strictly
//      below (it − HEIGHT_MARGIN). Known / rejected ids are never re-fetched. Transport failures and
//      the page bound leave the cursor where it was (retried next pass).
//
// The only network code in this file is HttpArweaveClient, over an injected fetch.

import { getAddress } from "viem";
import type { Clock } from "./clock.js";
import type { IndexerDb, InstanceRow } from "./db.js";
import { errMsg, type Logger } from "./log.js";

export const APP_TAG = "agent-launchpad";
export const MAX_TEXT_CHARS = 4096;
export const TS_TOLERANCE_SEC = 86_400;
export const ARWEAVE_REDIRECT_HOST_SUFFIX = ".arweave.net";
const ID_RE = /^[A-Za-z0-9_-]{43}$/;
/**
 * An item owner as the gateway reports it — an Arweave address (43-char base64url) OR an Ethereum
 * address (Turbo items signed with an EVM key — ANS-104 type 3; the live agent-8 attestation item's
 * owner is its treasury EOA 0xd7EF…). SPEC-M4A rev 2 (Fable ruling 2026-09-29, agent-8 drill):
 * ownerOf() accepts BOTH forms — the original 43-char-only rule made the pin path structurally dead
 * for every runtime-uploaded item, since TurboJournalSink/TurboArweaveSink sign with the treasury
 * key. 0x-form owners are normalized to lowercase at this client boundary (normalizeOwner) so the
 * db's exact-equality pin comparisons hold across gateways' checksum-casing choices.
 */
const OWNER_ANY_RE = /^(?:[A-Za-z0-9_-]{43}|0x[0-9a-fA-F]{40})$/;

/** SPEC-M4A rev 2: canonical stored/compared owner form — lowercase for 0x-form, verbatim otherwise. */
export function normalizeOwner(owner: string): string {
  return owner.startsWith("0x") ? owner.toLowerCase() : owner;
}

/** EIP-55 checksummed form for the gateway owners filter (a non-address input passes through). */
function checksum0x(a: string): string {
  try {
    return getAddress(a);
  } catch {
    return a;
  }
}
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];
/** Journal items are ≪ 100 KiB; attestation reports carry a base64 quote (a few KiB). */
export const MAX_ITEM_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
/** Arweave blocks (~2 min each) re-scanned below the per-agent height cursor. */
export const HEIGHT_MARGIN = 50;

export interface ArweaveTag {
  name: string;
  value: string;
}

export interface ArweaveNode {
  id: string;
  cursor: string;
  /** Item owner address, normalized (43-char base64url, or lowercase 0x-form for Turbo/EVM-signed items — SPEC-M4A rev 2). */
  owner: string;
  tags: ArweaveTag[];
  blockHeight: number | null;
  blockTimestamp: number | null;
}

export interface ArweavePage {
  nodes: ArweaveNode[];
  hasNextPage: boolean;
}

/** The Arweave seam (HttpArweaveClient in production; mocked via fetchImpl or directly in tests). */
export interface ArweaveClient {
  /** Journal discovery (Kind=journal), optionally owner-filtered. */
  query(agentId: number, owner: string | null, after: string | null): Promise<ArweavePage>;
  /** Owner address of item `id` (GraphQL lookup by id), or null when the gateway does not know it (yet). */
  ownerOf(id: string): Promise<string | null>;
  /** Item data; `maxBytes` DEFAULT MAX_ITEM_BYTES (a larger body throws ArweaveTooLargeError). */
  download(id: string, maxBytes?: number): Promise<Uint8Array>;
}

/** An Arweave item / owner id: 43-char base64url. */
export function isArweaveId(s: string | null | undefined): s is string {
  return typeof s === "string" && ID_RE.test(s);
}

// ---------------------------------------------------------------------------
// HTTP client (GraphQL + gateway), injected fetch
// ---------------------------------------------------------------------------

export interface HttpArweaveOptions {
  graphqlUrl: string;
  gatewayUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Permit http:// (local tests only). DEFAULT false. */
  allowInsecureHttp?: boolean;
}

const QUERY_FIELDS = "{pageInfo{hasNextPage} edges{cursor node{id owner{address} tags{name value} block{height timestamp}}}}";
const QUERY_OPEN =
  "query($tags:[TagFilter!],$after:String){transactions(tags:$tags,first:100,after:$after,sort:HEIGHT_DESC)" + QUERY_FIELDS + "}";
const QUERY_OWNED =
  "query($owners:[String!],$tags:[TagFilter!],$after:String){transactions(owners:$owners,tags:$tags,first:100,after:$after,sort:HEIGHT_DESC)" +
  QUERY_FIELDS +
  "}";
const QUERY_BY_ID = "query($ids:[ID!]){transactions(ids:$ids,first:1){edges{node{id owner{address}}}}}";

/** A body (item data or GraphQL response) larger than the reader's byte cap — a property of the item, not a transport failure. */
export class ArweaveTooLargeError extends Error {
  constructor(readonly cap: number) {
    super(`arweave: response body exceeds ${cap} bytes`);
    this.name = "ArweaveTooLargeError";
  }
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const body = res.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new ArweaveTooLargeError(cap);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export class HttpArweaveClient implements ArweaveClient {
  private readonly graphqlUrl: string;
  private readonly gatewayUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly allowInsecure: boolean;

  constructor(o: HttpArweaveOptions) {
    this.graphqlUrl = o.graphqlUrl;
    this.gatewayUrl = o.gatewayUrl.replace(/\/+$/, "");
    this.fetchImpl = o.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.allowInsecure = o.allowInsecureHttp ?? false;
    for (const u of [this.graphqlUrl, this.gatewayUrl]) this.checkUrl(new URL(u));
  }

  private checkUrl(u: URL): void {
    if (u.protocol !== "https:" && !(this.allowInsecure && u.protocol === "http:")) throw new Error(`arweave: refusing non-https URL (${u.protocol})`);
  }

  private async graphql(body: unknown): Promise<{ pageInfo?: { hasNextPage?: unknown }; edges: unknown[] }> {
    const u = new URL(this.graphqlUrl);
    this.checkUrl(u);
    const res = await this.fetchImpl(u, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`arweave: graphql: HTTP ${res.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(await readCapped(res, MAX_JSON_BYTES)));
    } catch (e) {
      throw new Error(`arweave: graphql: non-JSON response (${errMsg(e)})`);
    }
    const tx = (parsed as { data?: { transactions?: { pageInfo?: { hasNextPage?: unknown }; edges?: unknown } } } | null)?.data?.transactions;
    if (tx === undefined || tx === null || !Array.isArray(tx.edges)) throw new Error("arweave: graphql: malformed response");
    return tx as { pageInfo?: { hasNextPage?: unknown }; edges: unknown[] };
  }

  private async ownerLookup(id: string, ownerRe: RegExp): Promise<string | null> {
    if (!ID_RE.test(id)) throw new Error("arweave: bad item id");
    const tx = await this.graphql({ query: QUERY_BY_ID, variables: { ids: [id] } });
    for (const e of tx.edges as Array<Record<string, unknown>>) {
      const node = e.node as { id?: unknown; owner?: { address?: unknown } } | undefined;
      const addr = node?.owner?.address;
      // Untrusted gateway: only the node for exactly this id counts.
      if (node?.id === id && typeof addr === "string" && ownerRe.test(addr)) return normalizeOwner(addr);
    }
    return null;
  }

  /** SPEC-M4A rev 2: both owner forms (see OWNER_ANY_RE), normalized; null when the gateway does not know the item (yet). */
  async ownerOf(id: string): Promise<string | null> {
    return this.ownerLookup(id, OWNER_ANY_RE);
  }

  /** SPEC-M4B §1b itemFound: alias of ownerOf (kept for the verifier's call site). */
  async itemOwner(id: string): Promise<string | null> {
    return this.ownerOf(id);
  }

  async query(agentId: number, owner: string | null, after: string | null): Promise<ArweavePage> {
    const tags = [
      { name: "App", values: [APP_TAG] },
      { name: "AgentId", values: [agentId.toString(10)] },
      { name: "Kind", values: ["journal"] },
    ];
    // SPEC-M4A rev 2: a pinned 0x-form owner is stored lowercase, but the gateway's owners filter may
    // match its stored representation exactly — send both casings (OR within the list). The local
    // owner re-check downstream compares normalized forms either way.
    const ownerFilter = owner === null ? null : owner.startsWith("0x") ? [owner, checksum0x(owner)] : [owner];
    const body = ownerFilter === null ? { query: QUERY_OPEN, variables: { tags, after } } : { query: QUERY_OWNED, variables: { owners: ownerFilter, tags, after } };
    const tx = await this.graphql(body);
    const nodes: ArweaveNode[] = [];
    for (const e of tx.edges as Array<Record<string, unknown>>) {
      const node = e.node as Record<string, unknown> | undefined;
      const id = node?.id;
      const cursor = e.cursor;
      const ownerAddr = (node?.owner as { address?: unknown } | undefined)?.address;
      if (typeof id !== "string" || !ID_RE.test(id) || typeof cursor !== "string" || typeof ownerAddr !== "string") continue;
      const tags: ArweaveTag[] = [];
      if (Array.isArray(node?.tags)) {
        for (const t of node.tags as Array<{ name?: unknown; value?: unknown }>) {
          if (typeof t.name === "string" && typeof t.value === "string") tags.push({ name: t.name, value: t.value });
        }
      }
      const block = node?.block as { height?: unknown; timestamp?: unknown } | null | undefined;
      const height = typeof block?.height === "number" && Number.isSafeInteger(block.height) ? block.height : null;
      const bts = typeof block?.timestamp === "number" && Number.isSafeInteger(block.timestamp) ? block.timestamp : null;
      nodes.push({ id, cursor, owner: normalizeOwner(ownerAddr), tags, blockHeight: height, blockTimestamp: bts });
    }
    return { nodes, hasNextPage: tx.pageInfo?.hasNextPage === true };
  }

  async download(id: string, maxBytes: number = MAX_ITEM_BYTES): Promise<Uint8Array> {
    if (!ID_RE.test(id)) throw new Error("arweave: bad item id");
    const first = new URL(`${this.gatewayUrl}/${id}`);
    this.checkUrl(first);
    let res = await this.fetchImpl(first, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
    if (REDIRECT_STATUSES.includes(res.status)) {
      const loc = res.headers.get("location");
      await res.body?.cancel();
      if (loc === null) throw new Error(`arweave: download ${id}: HTTP ${res.status} without Location`);
      let target: URL;
      try {
        target = new URL(loc, first);
      } catch {
        throw new Error(`arweave: download ${id}: unparseable redirect Location`);
      }
      if (target.protocol !== "https:") throw new Error(`arweave: download ${id}: refusing non-https redirect (${target.protocol})`);
      if (!target.hostname.toLowerCase().endsWith(ARWEAVE_REDIRECT_HOST_SUFFIX)) {
        throw new Error(`arweave: download ${id}: refusing redirect to host ${target.hostname} (only *${ARWEAVE_REDIRECT_HOST_SUFFIX})`);
      }
      // The ONE hop; a second redirect is an error (redirect: "error" makes fetch reject it; "manual" + check covers mocks).
      res = await this.fetchImpl(target, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
      if (REDIRECT_STATUSES.includes(res.status)) {
        await res.body?.cancel();
        throw new Error(`arweave: download ${id}: refusing a second redirect (HTTP ${res.status})`);
      }
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`arweave: download ${id}: HTTP ${res.status}`);
    }
    return readCapped(res, maxBytes);
  }
}

// ---------------------------------------------------------------------------
// Payload validation (pure)
// ---------------------------------------------------------------------------

export interface JournalPayload {
  v: 1;
  agentId: number;
  ts: number;
  text: string;
}

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

function parseJson(bytes: Uint8Array): Verdict<unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not UTF-8" };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "non-JSON" };
  }
}

/** §3 step 2 checks. `blockTimestamp` null ⇒ the ts window check is skipped (item not yet in a block). */
export function validateJournalItem(bytes: Uint8Array, agentId: number, blockTimestamp: number | null): Verdict<JournalPayload> {
  const j = parseJson(bytes);
  if (!j.ok) return j;
  const p = j.value;
  if (p === null || typeof p !== "object" || Array.isArray(p)) return { ok: false, reason: "payload is not a JSON object" };
  const o = p as Record<string, unknown>;
  if (o.v !== 1) return { ok: false, reason: `unsupported v ${JSON.stringify(o.v)}` };
  if (o.agentId !== agentId) return { ok: false, reason: `agentId mismatch (payload ${JSON.stringify(o.agentId)}, expected ${agentId})` };
  if (typeof o.ts !== "number" || !Number.isSafeInteger(o.ts) || o.ts < 0) return { ok: false, reason: "ts is not a unix-seconds integer" };
  if (typeof o.text !== "string") return { ok: false, reason: "text is not a string" };
  if (o.text.length > MAX_TEXT_CHARS) return { ok: false, reason: `text is ${o.text.length} chars (> ${MAX_TEXT_CHARS})` };
  if (blockTimestamp !== null && (o.ts < blockTimestamp - TS_TOLERANCE_SEC || o.ts > blockTimestamp + TS_TOLERANCE_SEC)) {
    return { ok: false, reason: `ts ${o.ts} outside block time ${blockTimestamp} ± 1d` };
  }
  return { ok: true, value: { v: 1, agentId, ts: o.ts, text: o.text } };
}

/** The attestation payload's eoas.treasury, or null when absent / malformed. */
export function attestationTreasury(bytes: Uint8Array): string | null {
  const j = parseJson(bytes);
  if (!j.ok || j.value === null || typeof j.value !== "object") return null;
  const eoas = (j.value as Record<string, unknown>).eoas;
  if (eoas === null || typeof eoas !== "object") return null;
  const t = (eoas as Record<string, unknown>).treasury;
  return typeof t === "string" && /^0x[0-9a-fA-F]{40}$/.test(t) ? t : null;
}

// ---------------------------------------------------------------------------
// Enricher
// ---------------------------------------------------------------------------

export interface EnricherOpts {
  /** GraphQL pages (100 items each) per agent per pass. DEFAULT 20 (the turboHttp bound). */
  maxPages?: number;
}

function tag(n: ArweaveNode, name: string): string | undefined {
  return n.tags.find((t) => t.name === name)?.value;
}

export class Enricher {
  /** Journal item ids rejected this process — not re-fetched, not re-warned. */
  private readonly rejected = new Set<string>();
  /** Agents already warned about a failed / mismatched pin (warn once per agent per process). */
  private readonly pinWarned = new Set<number>();
  /** agentId → attestationRef whose payload does not attest the treasury (immutable item: not re-fetched while the ref is unchanged). */
  private readonly pinMismatch = new Map<number, string>();
  private readonly maxPages: number;

  constructor(
    private readonly db: IndexerDb,
    private readonly arweave: ArweaveClient,
    private readonly clock: Clock,
    private readonly log: Logger,
    o: EnricherOpts = {},
  ) {
    this.maxPages = o.maxPages ?? 20;
  }

  /** One pass over every registered agent. Never throws. Returns journal rows inserted. */
  async runOnce(): Promise<number> {
    let inserted = 0;
    for (const inst of this.db.instances()) {
      try {
        inserted += await this.enrichAgent(inst);
      } catch (e) {
        this.log.warn(`ENRICH FAILED for agent ${inst.agentId}: ${errMsg(e)}`);
      }
    }
    return inserted;
  }

  private cursorKeys(agentId: number): { height: string; mode: string } {
    return { height: `enrich.${agentId}.height`, mode: `enrich.${agentId}.mode` };
  }

  private pinWarn(agentId: number, msg: string): void {
    if (this.pinWarned.has(agentId)) return;
    this.pinWarned.add(agentId);
    this.log.warn(msg);
  }

  /**
   * §3.1 rev 1: pin from the item whose id EQUALS the on-chain attestationRef — never from tagged
   * items. Returns the pinned owner, or null (stay unpinned). Never throws.
   */
  private async tryPin(inst: InstanceRow): Promise<string | null> {
    const { agentId, treasuryEOA } = inst;
    const ref = inst.attestationRef;
    if (!isArweaveId(ref)) return null; // no ref / local drill ref: no fetch, no pin, no warning
    if (this.pinMismatch.get(agentId) === ref) return null;
    const why = `ENRICH: agent ${agentId}: attestationRef ${ref}`;
    let bytes: Uint8Array;
    try {
      bytes = await this.arweave.download(ref);
    } catch (e) {
      this.pinWarn(agentId, `${why}: fetch failed — journal owner NOT pinned (retried each pass; warned once): ${errMsg(e)}`);
      return null;
    }
    const t = attestationTreasury(bytes);
    if (t === null || t.toLowerCase() !== treasuryEOA.toLowerCase()) {
      this.pinMismatch.set(agentId, ref);
      this.pinWarn(agentId, `${why}: payload eoas.treasury ${t ?? "(absent)"} does not attest registered treasury ${treasuryEOA} — journal owner NOT pinned`);
      return null;
    }
    let owner: string | null;
    try {
      owner = await this.arweave.ownerOf(ref);
    } catch (e) {
      this.pinWarn(agentId, `${why}: owner lookup failed — journal owner NOT pinned (retried each pass; warned once): ${errMsg(e)}`);
      return null;
    }
    if (owner === null) {
      this.pinWarn(agentId, `${why}: owner unknown to the gateway (not indexed yet?) — journal owner NOT pinned (retried each pass; warned once)`);
      return null;
    }
    const deleted = this.db.pinJournalOwner({ agentId, owner, attestationItem: ref, pinnedAt: Number(this.clock.now()) });
    const pinned = this.db.journalOwner(agentId)!.owner;
    this.log.info(`enrich: agent ${agentId}: journal owner PINNED to ${pinned} (attestationRef ${ref}); ${deleted} other-owner unverified row(s) deleted`);
    return pinned;
  }

  /** Returns journal rows inserted for this agent. Throws only on GraphQL discovery failure. */
  async enrichAgent(inst: InstanceRow): Promise<number> {
    const agentId = inst.agentId;
    const pinned = this.db.journalOwner(agentId)?.owner ?? (await this.tryPin(inst));
    const mode = pinned === null ? "open" : `pinned:${pinned}`;
    const keys = this.cursorKeys(agentId);
    const stored = this.db.kvGet(keys.mode) === mode ? this.db.kvGet(keys.height) : undefined;
    // Re-scan margin below the stored height: bundled data items can be indexed after items at higher heights.
    const stopBelow = stored === undefined ? null : Number(stored) - HEIGHT_MARGIN;

    let inserted = 0;
    let complete = true;
    let maxHeight = stored === undefined ? -1 : Number(stored);
    let after: string | null = null;

    for (let page = 0; page < this.maxPages; page++) {
      const res = await this.arweave.query(agentId, pinned, after);
      let reachedOld = false;
      for (const n of res.nodes) {
        after = n.cursor;
        if (n.blockHeight !== null) {
          if (stopBelow !== null && n.blockHeight < stopBelow) {
            reachedOld = true;
            continue;
          }
          if (n.blockHeight > maxHeight) maxHeight = n.blockHeight;
        }
        // Untrusted gateway: re-check the filter locally.
        if (tag(n, "App") !== APP_TAG || tag(n, "AgentId") !== agentId.toString(10) || tag(n, "Kind") !== "journal") continue;
        if (pinned !== null && n.owner !== pinned) continue;
        if (this.rejected.has(n.id) || this.db.hasJournalItem(n.id)) continue;
        let bytes: Uint8Array;
        try {
          bytes = await this.arweave.download(n.id);
        } catch (e) {
          complete = false;
          this.log.warn(`enrich: agent ${agentId}: journal item ${n.id} fetch failed: ${errMsg(e)}`);
          continue;
        }
        const v = validateJournalItem(bytes, agentId, n.blockTimestamp);
        if (!v.ok) {
          this.rejected.add(n.id);
          this.log.warn(`ENRICH REJECTED journal item ${n.id} (agent ${agentId}, owner ${n.owner}): ${v.reason}`);
          continue;
        }
        const ok = this.db.insertJournal({
          itemId: n.id,
          agentId,
          ts: v.value.ts,
          kind: "journal",
          text: v.value.text,
          raw: new TextDecoder().decode(bytes),
          fetchedAt: Number(this.clock.now()),
          owner: n.owner,
          unverified: pinned === null ? 1 : 0,
          blockHeight: n.blockHeight,
        });
        if (ok) inserted++;
      }
      if (reachedOld || !res.hasNextPage) break;
      if (page === this.maxPages - 1) complete = false; // page bound hit: do not advance past unseen items
    }

    if (complete && maxHeight >= 0) {
      this.db.tx(() => {
        this.db.kvSet(keys.mode, mode);
        this.db.kvSet(keys.height, String(maxHeight));
      });
    }
    return inserted;
  }
}
