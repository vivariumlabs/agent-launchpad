// SPEC-M4A §1 — the ONE chain seam of the indexer: a narrow read-only interface (logs, block
// timestamps, the handful of view calls the indexer needs) + its viem implementation. Tests
// implement IndexerChain in memory (test/helpers/mockChain.ts); no network in tests.

import { createPublicClient, fallback, http, type Address, type Hex, type PublicClient } from "viem";
import { agentFactoryAbi, agentNftAbi, agentRegistryAbi, erc20Abi } from "./abi.js";

export interface RawLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

export interface PendingAgent {
  creator: Address;
  configHash: Hex;
  imageURI: string;
  name: string;
  symbol: string;
  genesisDeadline: bigint;
  feePaid: boolean;
}

export interface AgentInstance {
  treasuryEOA: Address;
  actionEOA: Address;
  codeHash: Hex;
  attestationRef: string;
  lastHeartbeat: bigint;
  generation: number;
}

export interface TokenInfo {
  name: string;
  symbol: string;
  totalSupply: bigint;
}

export interface IndexerChain {
  blockNumber(): Promise<bigint>;
  /** eth_getLogs over an address set, every topic (the caller decodes by emitting address). */
  getLogs(addresses: readonly Address[], fromBlock: bigint, toBlock: bigint): Promise<RawLog[]>;
  blockTimestamp(n: bigint): Promise<bigint>;
  /**
   * factory.pendingAgent — tried at `atBlock` first (the record is deleted at finalize/cancel,
   * AgentFactory.sol:251/291), falling back to latest when the node has no state for that block.
   */
  pendingAgent(agentId: bigint, atBlock?: bigint): Promise<PendingAgent>;
  /** registry.instanceOf — the zero struct (lastHeartbeat 0) when unregistered. */
  instanceOf(agentId: bigint): Promise<AgentInstance>;
  revivalWindow(): Promise<bigint>;
  tokenInfo(token: Address): Promise<TokenInfo>;
  nftTokenURI(agentId: bigint): Promise<string>;
  erc20Balance(token: Address, who: Address): Promise<bigint>;
  nativeBalance(who: Address): Promise<bigint>;
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export interface ViemChainOpts {
  rpc: readonly string[];
  factory: Address;
  registry: Address;
  nft: Address;
  timeoutMs?: number;
}

export class ViemIndexerChain implements IndexerChain {
  private readonly client: PublicClient;

  constructor(private readonly o: ViemChainOpts) {
    const timeout = o.timeoutMs ?? 20_000;
    const transports = o.rpc.map((u) => http(u, { timeout, retryCount: 1 }));
    this.client = createPublicClient({ transport: transports.length === 1 ? transports[0]! : fallback(transports) });
  }

  blockNumber(): Promise<bigint> {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }

  async getLogs(addresses: readonly Address[], fromBlock: bigint, toBlock: bigint): Promise<RawLog[]> {
    if (addresses.length === 0) return [];
    const logs = await this.client.getLogs({ address: [...addresses], fromBlock, toBlock });
    const out: RawLog[] = [];
    for (const l of logs) {
      if (l.blockNumber === null || l.transactionHash === null || l.logIndex === null) continue; // pending
      out.push({ address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex });
    }
    return out;
  }

  async blockTimestamp(n: bigint): Promise<bigint> {
    return (await this.client.getBlock({ blockNumber: n })).timestamp;
  }

  async pendingAgent(agentId: bigint, atBlock?: bigint): Promise<PendingAgent> {
    const read = (blockNumber?: bigint): Promise<PendingAgent> =>
      this.client.readContract({
        address: this.o.factory,
        abi: agentFactoryAbi,
        functionName: "pendingAgent",
        args: [agentId],
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      }) as Promise<PendingAgent>;
    if (atBlock !== undefined) {
      try {
        return await read(atBlock);
      } catch {
        // non-archive node: fall through to latest
      }
    }
    return read();
  }

  instanceOf(agentId: bigint): Promise<AgentInstance> {
    return this.client.readContract({ address: this.o.registry, abi: agentRegistryAbi, functionName: "instanceOf", args: [agentId] }) as Promise<AgentInstance>;
  }

  revivalWindow(): Promise<bigint> {
    return this.client.readContract({ address: this.o.registry, abi: agentRegistryAbi, functionName: "REVIVAL_WINDOW" });
  }

  async tokenInfo(token: Address): Promise<TokenInfo> {
    const [name, symbol, totalSupply] = await Promise.all([
      this.client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
      this.client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
      this.client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
    ]);
    return { name, symbol, totalSupply };
  }

  nftTokenURI(agentId: bigint): Promise<string> {
    return this.client.readContract({ address: this.o.nft, abi: agentNftAbi, functionName: "tokenURI", args: [agentId] });
  }

  erc20Balance(token: Address, who: Address): Promise<bigint> {
    return this.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  }

  nativeBalance(who: Address): Promise<bigint> {
    return this.client.getBalance({ address: who });
  }
}
