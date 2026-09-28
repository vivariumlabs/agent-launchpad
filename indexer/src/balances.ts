// SPEC-M4A §1 balance refresh loop (every balanceRefreshSec, DEFAULT 300): RH-chain reads only (this
// slice) — treasury USDG + native, action USDG + native + agent token → `balances`. The same pass
// reconciles each registered instance against registry.instanceOf (the chain struct is
// authoritative; fills attestationRef and any instance whose InstanceRegistered predates startBlock).
// Per-agent try/catch: one failing agent never blocks the others; failures are LOUD warns.

import { getAddress, type Address } from "viem";
import type { IndexerChain } from "./chain.js";
import type { Clock } from "./clock.js";
import type { IndexerDb } from "./db.js";
import { errMsg, type Logger } from "./log.js";

export class BalanceRefresher {
  constructor(
    private readonly db: IndexerDb,
    private readonly chain: IndexerChain,
    private readonly usdg: Address,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  /** Returns the number of agents refreshed. Never throws. */
  async refreshAll(): Promise<number> {
    let ok = 0;
    for (const a of this.db.agents()) {
      try {
        if (await this.refreshAgent(a.agentId)) ok++;
      } catch (e) {
        this.log.warn(`BALANCE REFRESH FAILED for agent ${a.agentId}: ${errMsg(e)}`);
      }
    }
    return ok;
  }

  /** false ⇒ the agent has no registered instance (nothing to read). */
  async refreshAgent(agentId: number): Promise<boolean> {
    const inst = await this.chain.instanceOf(BigInt(agentId));
    if (inst.lastHeartbeat === 0n) return false;
    this.db.reconcileInstance({
      agentId,
      treasuryEOA: getAddress(inst.treasuryEOA),
      actionEOA: getAddress(inst.actionEOA),
      codeHash: inst.codeHash.toLowerCase(),
      attestationRef: inst.attestationRef === "" ? null : inst.attestationRef,
      lastHeartbeat: Number(inst.lastHeartbeat),
      generation: inst.generation,
    });
    const token = this.db.agent(agentId)?.token ?? null;
    const [treasuryUsdg, treasuryRhEth, actionUsdg, actionRhEth, actionToken] = await Promise.all([
      this.chain.erc20Balance(this.usdg, inst.treasuryEOA),
      this.chain.nativeBalance(inst.treasuryEOA),
      this.chain.erc20Balance(this.usdg, inst.actionEOA),
      this.chain.nativeBalance(inst.actionEOA),
      token === null ? Promise.resolve(null) : this.chain.erc20Balance(token as Address, inst.actionEOA),
    ]);
    this.db.upsertBalances({
      agentId,
      treasuryUsdg: treasuryUsdg.toString(),
      treasuryRhEth: treasuryRhEth.toString(),
      actionUsdg: actionUsdg.toString(),
      actionRhEth: actionRhEth.toString(),
      actionToken: actionToken === null ? null : actionToken.toString(),
      updatedAt: Number(this.clock.now()),
    });
    return true;
  }
}
