// SPEC-M3B §1 watcher.ts — polls factory logs for AgentRequested (viem getLogs through
// Launchpad.requestedLogs), cursor in kv, and emits new launches into the state machine (a
// REQUESTED row; the machine's resumer drives it). Chunked by maxBlockRange; `confirmations` blocks
// behind head (reorg margin). Launch rows + cursor advance commit in ONE sqlite transaction, and
// inserts are INSERT OR IGNORE — replaying a range can never duplicate or reset a launch.

import type { Launchpad } from "./chain.js";
import type { GenesisDb } from "./db.js";
import type { Logger } from "./log.js";

export const CURSOR_KEY = "watcher.nextBlock";

export interface WatcherOpts {
  startBlock: bigint;
  confirmations: number;
  maxBlockRange: number;
}

export class Watcher {
  constructor(
    private readonly db: GenesisDb,
    private readonly lp: Launchpad,
    private readonly opts: WatcherOpts,
    private readonly log: Logger,
  ) {}

  cursor(): bigint {
    const v = this.db.kvGet(CURSOR_KEY);
    return v === undefined ? this.opts.startBlock : BigInt(v);
  }

  /** Scan up to (head − confirmations). Returns the agentIds newly inserted. */
  async poll(): Promise<number[]> {
    const head = (await this.lp.latestBlock()).number - BigInt(this.opts.confirmations);
    const inserted: number[] = [];
    let next = this.cursor();
    const step = BigInt(this.opts.maxBlockRange);
    while (next <= head) {
      const to = next + step - 1n < head ? next + step - 1n : head;
      const logs = await this.lp.requestedLogs(next, to);
      const ts = new Map<bigint, bigint>();
      for (const l of logs) if (!ts.has(l.blockNumber)) ts.set(l.blockNumber, await this.lp.blockTimestamp(l.blockNumber));
      const newNext = to + 1n;
      this.db.tx(() => {
        for (const l of logs) {
          if (l.agentId <= 0n || l.agentId > BigInt(Number.MAX_SAFE_INTEGER)) {
            this.log.error(`watcher: ignoring AgentRequested with out-of-range agentId ${l.agentId}`);
            continue;
          }
          const isNew = this.db.insertRequested({
            agentId: Number(l.agentId),
            configHash: l.configHash,
            creator: l.creator,
            requestTx: l.txHash,
            requestBlock: Number(l.blockNumber),
            requestedAt: Number(ts.get(l.blockNumber) ?? 0n),
          });
          if (isNew) {
            inserted.push(Number(l.agentId));
            this.db.event(`genesis:${l.agentId}`, Number(l.agentId), ts.get(l.blockNumber) ?? 0n, "requested", `tx ${l.txHash} block ${l.blockNumber} configHash ${l.configHash} creator ${l.creator}`);
          }
        }
        this.db.kvSet(CURSOR_KEY, newNext.toString());
      });
      next = newNext;
    }
    if (inserted.length > 0) this.log.info(`watcher: new launch request(s) ${inserted.join(", ")}`);
    return inserted;
  }
}
