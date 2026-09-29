// SPEC-M4A §1 — the ONE chain seam of the indexer: a narrow read-only interface (logs, block
// timestamps, the handful of view calls the indexer needs) + its viem implementation. Tests
// implement IndexerChain in memory (test/helpers/mockChain.ts); no network in tests.

import { createPublicClient, encodeEventTopics, fallback, http, TransactionNotFoundError, type Address, type Hex, type PublicClient } from "viem";
import { agentFactoryAbi, agentNftAbi, agentRegistryAbi, erc20Abi } from "./abi.js";
import { stackForAgent } from "./config.js";

/** ERC-20 Transfer topic0. */
export const ERC20_TRANSFER_TOPIC = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer" })[0] as Hex;
/** erc20Abi[0] is the Transfer event (abi.ts). */
const TRANSFER_EVENT = erc20Abi[0];

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
  /**
   * SPEC-M4G §3: `token`'s ERC-20 Transfer logs whose `to` (topic2) is `to`, over [fromBlock,
   * toBlock] — the floor vault's USDG inflows.
   */
  getTransferLogsTo(token: Address, to: Address, fromBlock: bigint, toBlock: bigint): Promise<RawLog[]>;
  blockTimestamp(n: bigint): Promise<bigint>;
  /**
   * factory.pendingAgent (of the agent's stack, SPEC-M4G R2 id ranges) — tried at `atBlock` first (the record is deleted at finalize/cancel,
   * AgentFactory.sol:251/291), falling back to latest when the node has no state for that block.
   */
  pendingAgent(agentId: bigint, atBlock?: bigint): Promise<PendingAgent>;
  /** registry.instanceOf (the agent's stack) — the zero struct (lastHeartbeat 0) when unregistered. */
  instanceOf(agentId: bigint): Promise<AgentInstance>;
  revivalWindow(): Promise<bigint>;
  tokenInfo(token: Address): Promise<TokenInfo>;
  /** AgentNFT.tokenURI of the agent's stack. */
  nftTokenURI(agentId: bigint): Promise<string>;
  erc20Balance(token: Address, who: Address): Promise<bigint>;
  erc20TotalSupply(token: Address): Promise<bigint>;
  erc20Decimals(token: Address): Promise<number>;
  nativeBalance(who: Address): Promise<bigint>;
  /** eth_getTransactionByHash → `from`, lowercased; null when the node does not know the tx. */
  txFrom(txHash: Hex): Promise<string | null>;
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export interface ViemChainOpts {
  rpc: readonly string[];
  /** Every stack (primary first); per-agent reads go to the agent's stack (stackForAgent). */
  stacks: ReadonlyArray<{ factory: Address; registry: Address; nft: Address; firstAgentId: number }>;
  timeoutMs?: number;
}

export class ViemIndexerChain implements IndexerChain {
  private readonly client: PublicClient;

  /** The stack whose id range holds agentId (SPEC-M4G R2); throws when none does. */
  private stackOf(agentId: bigint): { factory: Address; registry: Address; nft: Address } {
    const st = agentId <= BigInt(Number.MAX_SAFE_INTEGER) ? stackForAgent(this.o.stacks, Number(agentId)) : undefined;
    if (st === undefined) throw new Error(`agent ${agentId}: no configured stack covers this id`);
    return st;
  }

  constructor(private readonly o: ViemChainOpts) {
    if (o.stacks.length === 0) throw new Error("ViemIndexerChain: no stacks");
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

  async getTransferLogsTo(token: Address, to: Address, fromBlock: bigint, toBlock: bigint): Promise<RawLog[]> {
    // topics = [Transfer, any from, to] — viem encodes the indexed `to` arg into topic2.
    const logs = await this.client.getLogs({ address: token, event: TRANSFER_EVENT, args: { to }, fromBlock, toBlock, strict: false });
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
        address: this.stackOf(agentId).factory,
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
    return this.client.readContract({ address: this.stackOf(agentId).registry, abi: agentRegistryAbi, functionName: "instanceOf", args: [agentId] }) as Promise<AgentInstance>;
  }

  /** The primary stack's registry constant (every stack's AgentRegistry has the same 7 days). */
  revivalWindow(): Promise<bigint> {
    return this.client.readContract({ address: this.o.stacks[0]!.registry, abi: agentRegistryAbi, functionName: "REVIVAL_WINDOW" });
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
    return this.client.readContract({ address: this.stackOf(agentId).nft, abi: agentNftAbi, functionName: "tokenURI", args: [agentId] });
  }

  erc20Balance(token: Address, who: Address): Promise<bigint> {
    return this.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  }

  erc20TotalSupply(token: Address): Promise<bigint> {
    return this.client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" });
  }

  erc20Decimals(token: Address): Promise<number> {
    return this.client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  }

  nativeBalance(who: Address): Promise<bigint> {
    return this.client.getBalance({ address: who });
  }

  async txFrom(txHash: Hex): Promise<string | null> {
    try {
      return (await this.client.getTransaction({ hash: txHash })).from.toLowerCase();
    } catch (e) {
      if (e instanceof TransactionNotFoundError) return null;
      throw e;
    }
  }
}
