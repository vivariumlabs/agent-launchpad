// SPEC-M2B §3. ChainClient interface + MockChainClient (tests). The real viem
// implementation is session 3. No network code in this file.

import { keccak256, parseTransaction, recoverTransactionAddress, type Abi, type Address, type Hex } from "viem";
import type { Chain } from "../policy/types.js";

/** Unsigned tx as seen by the chain client for fee/gas estimation. */
export interface TxRequest {
  chain: Chain;
  chainId: number;
  from: Address;
  to: Address;
  value: bigint;
  data: Hex;
}

/** Chain-provided fee/gas fields (K2 bounds-checks every one of them). */
export interface FeeFill {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Everything the chain may contribute to a tx: nonce + fees. Never to/data/value/chainId. */
export interface TxFill extends FeeFill {
  nonce: number;
}

export type TxStatus = "success" | "reverted";

export interface SendReceipt {
  hash: Hex;
  status: TxStatus;
}

export interface ReadContractRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export interface ChainClient {
  getNonce(chain: Chain, address: Address): Promise<number>;
  estimateFill(chain: Chain, tx: TxRequest): Promise<FeeFill>;
  sendRaw(chain: Chain, signedTx: Hex): Promise<SendReceipt>;
  readContract(chain: Chain, req: ReadContractRequest): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// MockChainClient
// ---------------------------------------------------------------------------

/** One recorded sendRaw attempt (decoded + sender recovered from the signature). */
export interface SentTx {
  chain: Chain;
  raw: Hex;
  hash: Hex;
  from: Address;
  to: Address | undefined;
  value: bigint;
  data: Hex;
  nonce: number;
  chainId: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** "error" = the scripted send threw (tx not accepted by the node). */
  outcome: TxStatus | "error";
}

/** Scripted outcome for the next sendRaw: a status, or an Error to throw (dropped tx). */
export type ScriptedOutcome = TxStatus | Error;

export interface MockChainClientOptions {
  /** Starting nonce per `${chain}:${lowercase address}`; default 0. */
  nonces?: Record<string, number>;
  /** Fee fill returned by estimateFill (default: 200k gas, 1 gwei max, 0.1 gwei tip). */
  fill?: FeeFill;
  /** Per-chain fee fill overrides. */
  fillByChain?: Partial<Record<Chain, FeeFill>>;
  /** Queue of outcomes consumed by successive sendRaw calls; empty ⇒ "success". */
  outcomes?: ScriptedOutcome[];
  /** readContract responder. */
  reads?: (chain: Chain, req: ReadContractRequest) => unknown;
}

export const DEFAULT_MOCK_FILL: FeeFill = {
  gasLimit: 200_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 100_000_000n,
};

function nonceKey(chain: Chain, address: string): string {
  return `${chain}:${address.toLowerCase()}`;
}

export class MockChainClient implements ChainClient {
  /** Every sendRaw attempt, in order. */
  readonly sent: SentTx[] = [];
  /** Every estimateFill request, in order. */
  readonly estimates: TxRequest[] = [];
  private readonly nonces = new Map<string, number>();
  private readonly outcomes: ScriptedOutcome[];
  private readonly opts: MockChainClientOptions;

  constructor(opts: MockChainClientOptions = {}) {
    this.opts = opts;
    this.outcomes = [...(opts.outcomes ?? [])];
    for (const [k, v] of Object.entries(opts.nonces ?? {})) this.nonces.set(k.toLowerCase(), v);
  }

  /** Append outcomes for future sends. */
  script(...outcomes: ScriptedOutcome[]): void {
    this.outcomes.push(...outcomes);
  }

  async getNonce(chain: Chain, address: Address): Promise<number> {
    return this.nonces.get(nonceKey(chain, address)) ?? 0;
  }

  async estimateFill(chain: Chain, tx: TxRequest): Promise<FeeFill> {
    this.estimates.push(tx);
    return { ...(this.opts.fillByChain?.[chain] ?? this.opts.fill ?? DEFAULT_MOCK_FILL) };
  }

  async sendRaw(chain: Chain, signedTx: Hex): Promise<SendReceipt> {
    const parsed = parseTransaction(signedTx);
    const from = await recoverTransactionAddress({ serializedTransaction: signedTx as `0x02${string}` });
    const hash = keccak256(signedTx);
    const next = this.outcomes.shift() ?? "success";
    const outcome: SentTx["outcome"] = next instanceof Error ? "error" : next;
    this.sent.push({
      chain,
      raw: signedTx,
      hash,
      from,
      to: parsed.to ?? undefined,
      value: parsed.value ?? 0n,
      data: parsed.data ?? "0x",
      nonce: parsed.nonce ?? 0,
      chainId: parsed.chainId ?? 0,
      gasLimit: parsed.gas ?? 0n,
      maxFeePerGas: parsed.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: parsed.maxPriorityFeePerGas ?? 0n,
      outcome,
    });
    if (next instanceof Error) throw next;
    // Mined (success or revert) ⇒ the sender's nonce is consumed.
    const k = nonceKey(chain, from);
    this.nonces.set(k, (this.nonces.get(k) ?? 0) + 1);
    return { hash, status: next };
  }

  async readContract(chain: Chain, req: ReadContractRequest): Promise<unknown> {
    const r = this.opts.reads;
    if (r === undefined) throw new Error(`MockChainClient: no reads responder for ${req.functionName}`);
    return r(chain, req);
  }

  /** Sent txs whose recovered sender equals `from` (case-insensitive). */
  sentFrom(from: Address): SentTx[] {
    const f = from.toLowerCase();
    return this.sent.filter((t) => t.from.toLowerCase() === f);
  }
}
