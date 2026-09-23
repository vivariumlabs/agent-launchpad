// SPEC-M3B §1 revival.ts (04 §6). revive(agentId, payerInfo) is allowed ONLY when the registry
// heartbeat is stale beyond REVIVAL_WINDOW — both values read ON-CHAIN (registry.instanceOf +
// registry.REVIVAL_WINDOW, compared against the chain's latest block timestamp, exactly the
// registry's own `block.timestamp - lastHeartbeat <= REVIVAL_WINDOW` rule). It then runs the same
// deploy path with the same frozen config (Arweave ref recorded at genesis; launch db as fallback;
// always re-verified against the recorded configHash) and the same release compose. It does NOT
// seed (reviver pays hosting) except the minimal RH gas leg `revivalGasSeed` (DEFAULT $2).
// The machine re-checks the gate when it picks the revival up (the agent may have woken meanwhile).

import type { Address } from "viem";
import type { AgentInstance, Launchpad } from "./chain.js";
import type { GenesisConfig } from "./config.js";
import type { GenesisDb } from "./db.js";
import type { Logger } from "./log.js";

export class RevivalRefused extends Error {
  constructor(
    readonly reason: "never_registered" | "heartbeat_fresh" | "revival_in_progress" | "unknown_agent" | "bad_payer",
    detail: string,
  ) {
    super(`revival refused (${reason}): ${detail}`);
    this.name = "RevivalRefused";
  }
}

export interface RevivalGate {
  instance: AgentInstance;
  window: bigint;
  chainNow: bigint;
}

/** Throws RevivalRefused unless the on-chain heartbeat is stale beyond the on-chain REVIVAL_WINDOW. */
export async function checkRevivalGate(lp: Launchpad, agentId: number): Promise<RevivalGate> {
  const id = BigInt(agentId);
  const instance = await lp.instanceOf(id);
  if (instance.lastHeartbeat === 0n) throw new RevivalRefused("never_registered", `agent ${agentId} has no registered instance`);
  const window = await lp.revivalWindow();
  const chainNow = (await lp.latestBlock()).timestamp;
  const age = chainNow - instance.lastHeartbeat;
  if (age <= window) {
    throw new RevivalRefused("heartbeat_fresh", `agent ${agentId} heartbeat is ${age}s old (≤ REVIVAL_WINDOW ${window}s) — it is alive`);
  }
  return { instance, window, chainNow };
}

export interface RevivalDeps {
  db: GenesisDb;
  launchpad: Launchpad;
  cfg: Pick<GenesisConfig, "release" | "contracts" | "timing">;
  log: Logger;
}

export interface PayerInfo {
  /** Who paid the revival fee (credited in the wake journal entry, 04 §6). */
  address: string;
  /** Payment reference (tx hash / receipt id), informational. */
  ref?: string | undefined;
}

async function findConfigHash(deps: RevivalDeps, agentId: number): Promise<string | null> {
  const latest = (await deps.launchpad.latestBlock()).number;
  const step = BigInt(deps.cfg.timing.maxBlockRange);
  for (let from = deps.cfg.contracts.startBlock; from <= latest; from += step) {
    const to = from + step - 1n < latest ? from + step - 1n : latest;
    const logs = await deps.launchpad.requestedLogs(from, to, BigInt(agentId));
    const hit = logs.find((l) => l.agentId === BigInt(agentId));
    if (hit !== undefined) return hit.configHash.toLowerCase();
  }
  return null;
}

/** Validates the gate and queues a revival flow (driven by the machine). Returns the revival id. */
export async function revive(deps: RevivalDeps, agentId: number, payer: PayerInfo, now: bigint): Promise<number> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(payer.address)) throw new RevivalRefused("bad_payer", `payer ${payer.address} is not an address`);
  if (deps.db.activeRevivals(agentId).length > 0) throw new RevivalRefused("revival_in_progress", `agent ${agentId} already has an active revival`);
  const gate = await checkRevivalGate(deps.launchpad, agentId);

  const launch = deps.db.getLaunch(agentId);
  const configHash = launch?.configHash ?? (await findConfigHash(deps, agentId));
  if (configHash === null) throw new RevivalRefused("unknown_agent", `no AgentRequested event for agent ${agentId}`);

  const id = deps.db.insertRevival({
    agentId,
    configHash,
    configRef: launch?.configRef ?? null,
    frozenJson: launch?.frozenJson ?? null,
    composePath: launch?.composePath ?? deps.cfg.release.composePath,
    treasury: gate.instance.treasuryEOA as Address,
    payer: payer.address,
    payerRef: payer.ref ?? null,
    startGeneration: gate.instance.generation,
    startedAt: Number(now),
  });
  deps.db.event(`revival:${id}`, agentId, now, "revival_requested", `payer ${payer.address}; heartbeat age ${gate.chainNow - gate.instance.lastHeartbeat}s > ${gate.window}s; generation ${gate.instance.generation}`);
  deps.log.info(`revival ${id} queued for agent ${agentId} (payer ${payer.address})`);
  return id;
}
