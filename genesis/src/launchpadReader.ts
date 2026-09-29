// SPEC-M4F: the RH launchpad READS (factory + registry views, AgentRequested logs) over a viem
// PublicClient — moved out of chain.ts so the secret-free launch-helper can use it without importing
// the signing ChainClient module (chain.ts re-exports it). No key, no write, no tx.

import type { Address, PublicClient } from "viem";
import { agentFactoryAbi, agentRegistryAbi } from "./abi.js";
import type { AgentInstance, Launchpad, PendingAgent, RequestedLog } from "./chain.js";

export class ViemLaunchpad implements Launchpad {
  constructor(
    private readonly pub: PublicClient,
    readonly factory: Address,
    readonly registry: Address,
    readonly usdg: Address,
  ) {}

  async latestBlock(): Promise<{ number: bigint; timestamp: bigint }> {
    const b = await this.pub.getBlock({ blockTag: "latest" });
    if (b.number === null) throw new Error("latest block has no number");
    return { number: b.number, timestamp: b.timestamp };
  }

  async blockTimestamp(n: bigint): Promise<bigint> {
    return (await this.pub.getBlock({ blockNumber: n })).timestamp;
  }

  async requestedLogs(fromBlock: bigint, toBlock: bigint, agentId?: bigint): Promise<RequestedLog[]> {
    const event = agentFactoryAbi[0];
    const logs = await this.pub.getLogs({
      address: this.factory,
      event,
      args: agentId === undefined ? undefined : { agentId },
      fromBlock,
      toBlock,
      strict: true,
    });
    const out: RequestedLog[] = [];
    for (const l of logs) {
      if (l.blockNumber === null || l.transactionHash === null || l.logIndex === null) continue; // pending logs: not final
      out.push({
        agentId: l.args.agentId,
        configHash: l.args.configHash,
        creator: l.args.creator,
        blockNumber: l.blockNumber,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
      });
    }
    return out;
  }

  async pendingAgent(agentId: bigint): Promise<PendingAgent> {
    const p = await this.pub.readContract({ address: this.factory, abi: agentFactoryAbi, functionName: "pendingAgent", args: [agentId] });
    return { ...p };
  }

  tokenOf(agentId: bigint): Promise<Address> {
    return this.pub.readContract({ address: this.factory, abi: agentFactoryAbi, functionName: "tokenOf", args: [agentId] });
  }

  creationFee(): Promise<bigint> {
    return this.pub.readContract({ address: this.factory, abi: agentFactoryAbi, functionName: "CREATION_FEE" });
  }

  isRegistered(agentId: bigint): Promise<boolean> {
    return this.pub.readContract({ address: this.registry, abi: agentRegistryAbi, functionName: "isRegistered", args: [agentId] });
  }

  async instanceOf(agentId: bigint): Promise<AgentInstance> {
    const i = await this.pub.readContract({ address: this.registry, abi: agentRegistryAbi, functionName: "instanceOf", args: [agentId] });
    return { ...i };
  }

  expectedTreasuryEOA(agentId: bigint): Promise<Address> {
    return this.pub.readContract({ address: this.registry, abi: agentRegistryAbi, functionName: "expectedTreasuryEOA", args: [agentId] });
  }

  genesisDeadline(agentId: bigint): Promise<bigint> {
    return this.pub.readContract({ address: this.registry, abi: agentRegistryAbi, functionName: "genesisDeadline", args: [agentId] });
  }

  revivalWindow(): Promise<bigint> {
    return this.pub.readContract({ address: this.registry, abi: agentRegistryAbi, functionName: "REVIVAL_WINDOW" });
  }
}
