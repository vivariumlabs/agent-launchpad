// In-memory IndexerChain (no network) + an ABI-encoding log builder for watcher tests.

import { encodeAbiParameters, encodeEventTopics, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import type { AgentInstance, IndexerChain, PendingAgent, RawLog, TokenInfo } from "../../src/chain.js";
import type { ContractsCfg } from "../../src/config.js";

export const ADDR = {
  factory: "0x1000000000000000000000000000000000000001",
  registry: "0x1000000000000000000000000000000000000002",
  hook: "0x1000000000000000000000000000000000000003",
  distributor: "0x1000000000000000000000000000000000000004",
  treasuryBuyback: "0x1000000000000000000000000000000000000005",
  poolManager: "0x1000000000000000000000000000000000000006",
  nft: "0x1000000000000000000000000000000000000007",
  usdg: "0x5000000000000000000000000000000000000005",
} as const satisfies Record<string, Address>;

export function contracts(startBlock = 100n): ContractsCfg {
  return { ...ADDR, startBlock };
}

export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const BASE_TS = 1_790_000_000n;

let txCounter = 0;
export function txHash(): Hex {
  txCounter++;
  return `0x${txCounter.toString(16).padStart(64, "0")}` as Hex;
}

/** ABI-encode one event log (topics + data) the way the chain would emit it. */
export function mkLog(
  abi: readonly unknown[],
  eventName: string,
  args: Record<string, unknown>,
  at: { address: Address; blockNumber: bigint; logIndex: number; transactionHash?: Hex },
): RawLog {
  const ev = (abi as Abi).find((x) => x.type === "event" && x.name === eventName) as AbiEvent | undefined;
  if (ev === undefined) throw new Error(`no event ${eventName}`);
  const topics = encodeEventTopics({ abi: [ev], eventName, args: args as never }) as Hex[];
  const nonIndexed = ev.inputs.filter((i) => i.indexed !== true);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as never);
  return { address: at.address, topics, data, blockNumber: at.blockNumber, transactionHash: at.transactionHash ?? txHash(), logIndex: at.logIndex };
}

export class MockChain implements IndexerChain {
  head = 1000n;
  logs: RawLog[] = [];
  getLogsCalls: Array<{ addresses: string[]; from: bigint; to: bigint }> = [];
  failGetLogs = 0;
  /** Fail getLogs when the range starts at this block (once each). */
  failFrom = new Set<bigint>();
  /** Provider-style block-range cap: getLogs over more blocks than this throws a range error. */
  rangeLimit: bigint | null = null;
  pending = new Map<bigint, PendingAgent>();
  instances = new Map<bigint, AgentInstance>();
  tokens = new Map<string, TokenInfo>();
  uris = new Map<bigint, string>();
  erc20 = new Map<string, bigint>();
  native = new Map<string, bigint>();
  revival = 604_800n;

  async blockNumber(): Promise<bigint> {
    return this.head;
  }

  async getLogs(addresses: readonly Address[], fromBlock: bigint, toBlock: bigint): Promise<RawLog[]> {
    this.getLogsCalls.push({ addresses: addresses.map((a) => a.toLowerCase()), from: fromBlock, to: toBlock });
    if (this.failGetLogs > 0) {
      this.failGetLogs--;
      throw new Error("mock getLogs failure");
    }
    if (this.rangeLimit !== null && toBlock - fromBlock + 1n > this.rangeLimit) {
      throw new Error(`eth_getLogs block range too large (${toBlock - fromBlock + 1n} > ${this.rangeLimit})`);
    }
    if (this.failFrom.has(fromBlock)) {
      this.failFrom.delete(fromBlock);
      throw new Error(`mock getLogs failure at ${fromBlock}`);
    }
    const set = new Set(addresses.map((a) => a.toLowerCase()));
    return this.logs.filter((l) => set.has(l.address.toLowerCase()) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
  }

  async blockTimestamp(n: bigint): Promise<bigint> {
    return BASE_TS + n;
  }

  async pendingAgent(agentId: bigint): Promise<PendingAgent> {
    return (
      this.pending.get(agentId) ?? { creator: ZERO, configHash: `0x${"0".repeat(64)}`, imageURI: "", name: "", symbol: "", genesisDeadline: 0n, feePaid: false }
    );
  }

  async instanceOf(agentId: bigint): Promise<AgentInstance> {
    return (
      this.instances.get(agentId) ?? { treasuryEOA: ZERO, actionEOA: ZERO, codeHash: `0x${"0".repeat(64)}`, attestationRef: "", lastHeartbeat: 0n, generation: 0 }
    );
  }

  async revivalWindow(): Promise<bigint> {
    return this.revival;
  }

  async tokenInfo(token: Address): Promise<TokenInfo> {
    const t = this.tokens.get(token.toLowerCase());
    if (t === undefined) throw new Error(`mock: unknown token ${token}`);
    return t;
  }

  async nftTokenURI(agentId: bigint): Promise<string> {
    return this.uris.get(agentId) ?? "";
  }

  async erc20Balance(token: Address, who: Address): Promise<bigint> {
    return this.erc20.get(`${token.toLowerCase()}:${who.toLowerCase()}`) ?? 0n;
  }

  async nativeBalance(who: Address): Promise<bigint> {
    return this.native.get(who.toLowerCase()) ?? 0n;
  }

  /** txHash (lowercase) → tx sender. Unknown tx ⇒ null (the node does not know it). */
  txSenders = new Map<string, string>();
  /** Throw on txFrom while > 0 (decremented per call); `Infinity` ⇒ always. */
  failTxFrom = 0;
  txFromCalls: string[] = [];

  async txFrom(txHash: Hex): Promise<string | null> {
    this.txFromCalls.push(txHash.toLowerCase());
    if (this.failTxFrom > 0) {
      this.failTxFrom--;
      throw new Error("mock txFrom failure");
    }
    return this.txSenders.get(txHash.toLowerCase())?.toLowerCase() ?? null;
  }
}

export function fixedClock(now: bigint): { now: () => bigint; set: (v: bigint) => void } {
  let v = now;
  return { now: () => v, set: (x: bigint) => void (v = x) };
}
