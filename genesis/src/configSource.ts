// Where the FROZEN agent.json comes from. 02 §1: "the config itself goes to the genesis service
// off-chain and to Arweave"; only its keccak (configHash) is on-chain. Whatever the source, the
// text is verified with the RUNTIME's own frozenConfigHash before anything is deployed — a config
// that does not hash to the on-chain value is never deployed (04 §7 row 2).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_KIND, createArweaveReader } from "./arweavePublish.js";
import { FrozenConfigFileSchema, frozenConfigHash } from "./canonical.js";
import type { GenesisConfig } from "./config.js";
import { errMsg, Fatal } from "./errors.js";
import type { HttpClient } from "./http.js";
import type { Logger } from "./log.js";
import { DEFAULT_ARWEAVE_GATEWAY_URL, TURBO_APP_TAG } from "./runtimeArweave.js";

export interface FrozenConfigDoc {
  /** Exact file text (deployed byte-for-byte as agent.json). */
  text: string;
  /** Where it came from: "inbox:<hash>.json" | "ar://<txid>". Recorded for revival (04 §6). */
  ref: string;
}

export interface ConfigSource {
  /** null ⇒ not (yet) available from this source. */
  load(q: { configHash: string; ref?: string | null }): Promise<FrozenConfigDoc | null>;
}

const HASH_RE = /^0x[0-9a-f]{64}$/;

/** Inbox directory the website drops frozen configs into, named <configHash lowercase>.json. */
export class DirConfigSource implements ConfigSource {
  constructor(private readonly dir: string) {}

  async load(q: { configHash: string }): Promise<FrozenConfigDoc | null> {
    const h = q.configHash.toLowerCase();
    if (!HASH_RE.test(h)) throw new Error(`bad configHash ${q.configHash}`);
    const p = join(this.dir, `${h}.json`);
    if (!existsSync(p)) return null;
    return { text: readFileSync(p, "utf8"), ref: `inbox:${h}.json` };
  }
}

/**
 * Arweave fetch for `ar://<txid>` refs (revival: "fetched from Arweave ref recorded at genesis").
 * M4E fix (Fable, 2026-09-29): reads through ArweaveReader (the runtime's one-redirect download) —
 * the old raw-HttpClient GET refused redirects, and arweave.net 302s item fetches to its data door,
 * so the ref path (the one REVIVAL uses) would have failed on every live fetch.
 */
export class ArweaveConfigSource implements ConfigSource {
  constructor(private readonly reader: ArweaveReader) {}

  async load(q: { ref?: string | null }): Promise<FrozenConfigDoc | null> {
    const m = q.ref === undefined || q.ref === null ? null : /^ar:\/\/([A-Za-z0-9_-]{43})$/.exec(q.ref);
    if (m === null) return null;
    try {
      return { text: Buffer.from(await this.reader.download(m[1]!)).toString("utf8"), ref: q.ref! };
    } catch {
      return null; // retry semantics, like the tag source
    }
  }
}

/** DEFAULT cap on discovery candidates fetched per load (R1: tag spam is a bounded DoS at worst). */
export const DEFAULT_DISCOVERY_CANDIDATES = 5;

const ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** Gateway byte reader (production: the runtime Turbo client's one-redirect download, arweavePublish.ts). */
export interface ArweaveReader {
  download(id: string): Promise<Uint8Array>;
}

/**
 * SPEC-M4E §1c — discovers a frozen config published by the launch-helper (arweavePublish.ts) by its
 * §1a tags {App: "agent-launchpad", Kind: "config", ConfigHash: <0x lowercase>}: Arweave GraphQL,
 * newest first, at most `maxCandidates` items; each is fetched and the FIRST whose text hashes to the
 * configHash (frozenConfigHash — a cheap local pre-check; the caller's verifyFrozen still runs) wins.
 * Tags/owners are untrusted hints (R1): a spoofed item with the right tags and wrong bytes is skipped.
 * None found / GraphQL or gateway failure ⇒ null (R4: null is a retry — GraphQL indexing lags minutes).
 */
export class ArweaveTagConfigSource implements ConfigSource {
  constructor(
    private readonly o: {
      graphqlUrl: string;
      http: HttpClient;
      reader: ArweaveReader;
      timeoutMs: number;
      log: Logger;
      maxCandidates?: number;
    },
  ) {}

  private async candidates(h: string, first: number): Promise<string[]> {
    const query =
      "query($tags:[TagFilter!],$first:Int){transactions(tags:$tags,first:$first,sort:HEIGHT_DESC){edges{node{id}}}}";
    const variables = {
      tags: [
        { name: "App", values: [TURBO_APP_TAG] },
        { name: "Kind", values: [CONFIG_KIND] },
        { name: "ConfigHash", values: [h] },
      ],
      first,
    };
    const res = await this.o.http.postJson(this.o.graphqlUrl, { query, variables }, this.o.timeoutMs);
    if (res.status !== 200) throw new Error(`graphql HTTP ${res.status}`);
    const body = JSON.parse(res.text) as { data?: { transactions?: { edges?: unknown } } } | null;
    const edges = body?.data?.transactions?.edges;
    if (!Array.isArray(edges)) throw new Error("graphql: malformed response");
    const ids: string[] = [];
    for (const e of edges as Array<{ node?: { id?: unknown } } | null>) {
      const id = e?.node?.id;
      if (typeof id === "string" && ID_RE.test(id) && !ids.includes(id)) ids.push(id);
    }
    return ids.slice(0, first);
  }

  async load(q: { configHash: string }): Promise<FrozenConfigDoc | null> {
    const h = q.configHash.toLowerCase();
    if (!HASH_RE.test(h)) throw new Error(`bad configHash ${q.configHash}`);
    const max = this.o.maxCandidates ?? DEFAULT_DISCOVERY_CANDIDATES;
    let ids: string[];
    try {
      ids = await this.candidates(h, max);
    } catch (e) {
      this.o.log.warn(`arweave discovery: GraphQL lookup for ${h} failed (retrying later): ${errMsg(e)}`);
      return null;
    }
    const dec = new TextDecoder("utf-8", { fatal: true });
    for (const id of ids) {
      let text: string;
      try {
        text = dec.decode(await this.o.reader.download(id));
      } catch (e) {
        this.o.log.warn(`arweave discovery: fetch ar://${id} for ${h} failed (retrying later): ${errMsg(e)}`);
        continue;
      }
      if (hashesTo(text, h)) return { text, ref: `ar://${id}` };
      this.o.log.warn(`arweave discovery: ar://${id} carries ConfigHash ${h} but its bytes do not hash to it — SKIPPED (spoofed/corrupt)`);
    }
    return null;
  }
}

/** Local pre-check: text is a {platform, agent} JSON whose frozenConfigHash equals h (never throws). */
function hashesTo(text: string, h: string): boolean {
  try {
    const env = FrozenConfigFileSchema.safeParse(JSON.parse(text));
    return env.success && frozenConfigHash({ platform: env.data.platform, agent: env.data.agent }).toLowerCase() === h;
  } catch {
    return false;
  }
}

/** First source that has it wins (callers verify the hash regardless of source). */
export class ChainedConfigSource implements ConfigSource {
  constructor(private readonly sources: readonly ConfigSource[]) {}

  async load(q: { configHash: string; ref?: string | null }): Promise<FrozenConfigDoc | null> {
    for (const s of this.sources) {
      const d = await s.load(q);
      if (d !== null) return d;
    }
    return null;
  }
}

/**
 * Throws Fatal unless `text` is a frozen agent.json ({ platform, agent } exactly) whose
 * frozenConfigHash equals `configHash` and whose agent.agentId equals the on-chain agentId (boot
 * cross-checks /init-params/agent-id against it — a mismatch could never boot).
 */
export function verifyFrozen(text: string, configHash: string, agentId: number): void {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Fatal("config_invalid", "frozen config is not JSON");
  }
  const env = FrozenConfigFileSchema.safeParse(raw);
  if (!env.success) throw new Fatal("config_invalid", "frozen config must be exactly { platform, agent }");
  const h = frozenConfigHash({ platform: env.data.platform, agent: env.data.agent });
  if (h.toLowerCase() !== configHash.toLowerCase()) {
    throw new Fatal("config_hash_mismatch", `frozen config hashes to ${h}, on-chain configHash is ${configHash.toLowerCase()}`);
  }
  const a = env.data.agent;
  const id = a !== null && typeof a === "object" && "agentId" in a ? (a as { agentId: unknown }).agentId : undefined;
  if (id !== agentId) throw new Fatal("config_agent_id_mismatch", `config agent.agentId ${String(id)} ≠ on-chain agentId ${agentId}`);
}

/**
 * (Moved here from orchestrator.ts for SPEC-M4F: the secret-free launch-helper composes the same R4
 * chain for its revival dry-run without importing the orchestrator's wallet-loading module.)
 * The orchestrator's frozen-config sources, in order: inbox dir (operator override / drills), SPEC-M4E
 * §1c Arweave tag discovery (arweaveDiscovery.enabled), then the ar://<txid> ref fetch (arweaveGateway
 * set). First non-null wins; the machine runs verifyFrozen on whatever comes back.
 */
export function buildConfigSource(cfg: GenesisConfig, o: { http: HttpClient; log: Logger; arweaveReader?: ArweaveReader }): ChainedConfigSource {
  const http = o.http;
  const sources: ConfigSource[] = [new DirConfigSource(cfg.configInboxDir)];
  // SPEC-M4E §1c / R4: inbox first (operator override / drills), then tag discovery of the
  // launch-helper-published config; the recorded ref becomes ar://<txid> (revival, 04 §6).
  const gateway = (cfg.arweaveGateway ?? DEFAULT_ARWEAVE_GATEWAY_URL).replace(/\/+$/, "");
  const timeoutMs = cfg.oyster.httpTimeoutSec * 1000;
  const reader = o.arweaveReader ?? createArweaveReader({ gatewayUrl: gateway, timeoutMs });
  if (cfg.arweaveDiscovery.enabled) {
    sources.push(
      new ArweaveTagConfigSource({
        graphqlUrl: cfg.arweaveGraphqlUrl ?? `${gateway}/graphql`,
        http,
        reader,
        timeoutMs,
        log: o.log,
        maxCandidates: cfg.arweaveDiscovery.maxCandidates,
      }),
    );
  }
  // ar://<ref> loads (revival) share the SAME one-redirect reader (M4E fix — raw GET refused the
  // arweave.net 302 to its data door, so every live ref fetch failed).
  sources.push(new ArweaveConfigSource(reader));
  return new ChainedConfigSource(sources);
}
