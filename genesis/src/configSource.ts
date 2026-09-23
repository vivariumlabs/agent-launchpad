// Where the FROZEN agent.json comes from. 02 §1: "the config itself goes to the genesis service
// off-chain and to Arweave"; only its keccak (configHash) is on-chain. Whatever the source, the
// text is verified with the RUNTIME's own frozenConfigHash before anything is deployed — a config
// that does not hash to the on-chain value is never deployed (04 §7 row 2).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FrozenConfigFileSchema, frozenConfigHash } from "./canonical.js";
import { Fatal } from "./errors.js";
import type { HttpClient } from "./http.js";

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

/** Arweave gateway fetch for `ar://<txid>` refs (revival: "fetched from Arweave ref recorded at genesis"). */
export class ArweaveConfigSource implements ConfigSource {
  constructor(
    private readonly gateway: string,
    private readonly http: HttpClient,
    private readonly timeoutMs: number,
  ) {}

  async load(q: { ref?: string | null }): Promise<FrozenConfigDoc | null> {
    const m = q.ref === undefined || q.ref === null ? null : /^ar:\/\/([A-Za-z0-9_-]{43})$/.exec(q.ref);
    if (m === null) return null;
    const res = await this.http.get(`${this.gateway.replace(/\/+$/, "")}/${m[1]!}`, this.timeoutMs);
    return res.status === 200 ? { text: res.text, ref: q.ref! } : null;
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
