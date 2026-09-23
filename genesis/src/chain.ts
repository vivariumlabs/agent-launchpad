// Chain access for the orchestrator: a per-chain tx client (fee-capped, nonce-managed, sign →
// persist → broadcast → receipt) and the RH launchpad reads (factory + registry). Interfaces here;
// viem implementations below; test/helpers/mockChain.ts implements the same interfaces in memory.

import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  keccak256,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { agentFactoryAbi, agentRegistryAbi, erc20Abi } from "./abi.js";
import { FeeCapExceeded, NonceConsumed } from "./errors.js";

export type ChainKey = "rh" | "base" | "arbitrum" | "optimism";
export const CHAIN_KEYS: readonly ChainKey[] = ["rh", "base", "arbitrum", "optimism"];

export interface TxRequest {
  to: Address;
  data?: Hex | undefined;
  value?: bigint | undefined;
}

export interface SignedTx {
  hash: Hex;
  raw: Hex;
  nonce: number;
}

export interface TxLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

export interface TxReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  logs: readonly TxLog[];
}

export interface ChainClient {
  readonly key: ChainKey;
  readonly sender: Address;
  nativeBalance(who: Address): Promise<bigint>;
  erc20Balance(token: Address, who: Address): Promise<bigint>;
  /** Estimate gas + fees (refuses above the per-chain cap), take the pending nonce, sign. No broadcast. */
  prepare(req: TxRequest): Promise<SignedTx>;
  /** Broadcast a signed raw tx. "already known" is success; a consumed nonce throws NonceConsumed. */
  broadcast(raw: Hex): Promise<void>;
  receipt(hash: Hex): Promise<TxReceipt | null>;
  /** The node knows the tx (mempool or mined). */
  known(hash: Hex): Promise<boolean>;
  waitReceipt(hash: Hex, timeoutMs: number): Promise<TxReceipt | null>;
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

export interface RequestedLog {
  agentId: bigint;
  configHash: Hex;
  creator: Address;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
}

/** RH-chain reads of the launchpad contracts (writes go through ChainClient with finalizeCalldata). */
export interface Launchpad {
  readonly factory: Address;
  readonly registry: Address;
  readonly usdg: Address;
  latestBlock(): Promise<{ number: bigint; timestamp: bigint }>;
  blockTimestamp(n: bigint): Promise<bigint>;
  requestedLogs(fromBlock: bigint, toBlock: bigint, agentId?: bigint): Promise<RequestedLog[]>;
  pendingAgent(agentId: bigint): Promise<PendingAgent>;
  tokenOf(agentId: bigint): Promise<Address>;
  creationFee(): Promise<bigint>;
  isRegistered(agentId: bigint): Promise<boolean>;
  instanceOf(agentId: bigint): Promise<AgentInstance>;
  expectedTreasuryEOA(agentId: bigint): Promise<Address>;
  genesisDeadline(agentId: bigint): Promise<bigint>;
  revivalWindow(): Promise<bigint>;
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export function finalizeCalldata(agentId: bigint): Hex {
  return encodeFunctionData({ abi: agentFactoryAbi, functionName: "finalize", args: [agentId] });
}

export function erc20TransferCalldata(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
}

/** True iff the receipt carries an ERC-20 Transfer(from → to, value) emitted by `token`. */
export function hasTransferLog(rc: TxReceipt, token: Address, from: Address, to: Address, value: bigint): boolean {
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== token.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]], eventName: "Transfer" });
      if (
        ev.args.from.toLowerCase() === from.toLowerCase() &&
        ev.args.to.toLowerCase() === to.toLowerCase() &&
        ev.args.value === value
      ) {
        return true;
      }
    } catch {
      // not a Transfer log
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// viem implementations
// ---------------------------------------------------------------------------

export interface FeeCaps {
  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint;
}

export class ViemChainClient implements ChainClient {
  readonly sender: Address;
  private readonly pub: PublicClient;
  private chainChecked = false;

  constructor(
    readonly key: ChainKey,
    private readonly opts: { rpc: string; chainId: number; caps: FeeCaps; pollingMs?: number },
    private readonly account: LocalAccount,
  ) {
    this.sender = account.address;
    this.pub = createPublicClient({ transport: http(opts.rpc), pollingInterval: opts.pollingMs ?? 1000 });
  }

  get publicClient(): PublicClient {
    return this.pub;
  }

  private async checkChain(): Promise<void> {
    if (this.chainChecked) return;
    const id = await this.pub.getChainId();
    if (id !== this.opts.chainId) throw new Error(`${this.key}: RPC serves chainId ${id}, expected ${this.opts.chainId} — refusing`);
    this.chainChecked = true;
  }

  async nativeBalance(who: Address): Promise<bigint> {
    await this.checkChain();
    return this.pub.getBalance({ address: who });
  }

  async erc20Balance(token: Address, who: Address): Promise<bigint> {
    await this.checkChain();
    return this.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  }

  async prepare(req: TxRequest): Promise<SignedTx> {
    await this.checkChain();
    const block = await this.pub.getBlock({ blockTag: "latest" });
    const baseFee = block.baseFeePerGas ?? 0n;
    const suggestedPrio = await this.pub.estimateMaxPriorityFeePerGas();
    const prio = suggestedPrio < this.opts.caps.maxPriorityFeePerGasWei ? suggestedPrio : this.opts.caps.maxPriorityFeePerGasWei;
    const needed = baseFee + prio;
    if (needed > this.opts.caps.maxFeePerGasWei) {
      throw new FeeCapExceeded(`${this.key}: baseFee ${baseFee} + prio ${prio} > cap ${this.opts.caps.maxFeePerGasWei} wei`);
    }
    const headroom = 2n * baseFee + prio;
    const maxFee = headroom < this.opts.caps.maxFeePerGasWei ? headroom : this.opts.caps.maxFeePerGasWei;
    const nonce = await this.pub.getTransactionCount({ address: this.sender, blockTag: "pending" });
    const gas = await this.pub.estimateGas({ account: this.sender, to: req.to, data: req.data, value: req.value ?? 0n });
    const raw = await this.account.signTransaction({
      type: "eip1559",
      chainId: this.opts.chainId,
      nonce,
      to: req.to,
      data: req.data,
      value: req.value ?? 0n,
      gas,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: prio,
    });
    return { hash: keccak256(raw), raw, nonce };
  }

  async broadcast(raw: Hex): Promise<void> {
    await this.checkChain();
    try {
      await this.pub.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) {
      const msg = e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ""}` : String(e);
      if (/already known|known transaction|already imported|AlreadyKnown/i.test(msg)) return;
      if (/nonce too low|nonce is too low|NonceTooLow|nonce has already been used/i.test(msg)) throw new NonceConsumed(`${this.key}: ${msg.slice(0, 200)}`);
      throw e;
    }
  }

  async receipt(hash: Hex): Promise<TxReceipt | null> {
    await this.checkChain();
    try {
      const rc = await this.pub.getTransactionReceipt({ hash });
      return { status: rc.status, blockNumber: rc.blockNumber, logs: rc.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) };
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) return null;
      throw e;
    }
  }

  async known(hash: Hex): Promise<boolean> {
    await this.checkChain();
    try {
      await this.pub.getTransaction({ hash });
      return true;
    } catch (e) {
      if (e instanceof TransactionNotFoundError) return false;
      throw e;
    }
  }

  async waitReceipt(hash: Hex, timeoutMs: number): Promise<TxReceipt | null> {
    await this.checkChain();
    try {
      const rc = await this.pub.waitForTransactionReceipt({ hash, timeout: timeoutMs });
      return { status: rc.status, blockNumber: rc.blockNumber, logs: rc.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) };
    } catch (e) {
      if (e instanceof WaitForTransactionReceiptTimeoutError) return null;
      throw e;
    }
  }
}

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
