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

/**
 * Optional native-balance extension a ChainClient may implement. SPEC-M3F §1b: moved here from boot.ts
 * (boot re-exports it). RealChainClient implements it (SPEC-M3F §1a); MockChainClient only when
 * constructed with `balances` or after `setBalance` (see its class comment).
 */
export interface NativeBalanceSource {
  getBalance(chain: Chain, address: Address): Promise<bigint>;
}

/** Does this ChainClient also expose native balances (NativeBalanceSource)? */
export function hasNativeBalance(c: ChainClient): c is ChainClient & NativeBalanceSource {
  return "getBalance" in c && typeof c.getBalance === "function";
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
  /**
   * SPEC-M3F §1b: native balance per `${chain}:${lowercase address}` (same key shape as nonces); a
   * missing key reads 0n. PRESENT (even `{}`) ⇒ this mock implements NativeBalanceSource.
   */
  balances?: Record<string, bigint>;
}

export const DEFAULT_MOCK_FILL: FeeFill = {
  gasLimit: 200_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 100_000_000n,
};

function nonceKey(chain: Chain, address: string): string {
  return `${chain}:${address.toLowerCase()}`;
}

/**
 * SPEC-M3F §1b: the optional NativeBalanceSource member, declared (optional) so tests can call
 * `mock.getBalance?.(…)` without a cast. It is an OWN instance property assigned only by
 * enableBalances() — never a prototype method.
 */
export interface MockChainClient {
  getBalance?(chain: Chain, address: Address): Promise<bigint>;
}

/**
 * INVARIANT (SPEC-M3F §1b): a MockChainClient constructed WITHOUT `balances` and never `setBalance`d has
 * NO `getBalance` member, so hasNativeBalance() is false for it and every existing "no
 * NativeBalanceSource (mock chain)" path (0n native fallback, M3C §10 "noBalanceSource") is unchanged.
 * Passing `balances` (even `{}`) or calling setBalance turns it into a NativeBalanceSource.
 */
export class MockChainClient implements ChainClient {
  /** Every sendRaw attempt, in order. */
  readonly sent: SentTx[] = [];
  /** Every estimateFill request, in order. */
  readonly estimates: TxRequest[] = [];
  private readonly nonces = new Map<string, number>();
  private readonly outcomes: ScriptedOutcome[];
  private readonly opts: MockChainClientOptions;
  /** SPEC-M3F §1b: native balances; null until `balances` was passed or setBalance was called. */
  private balances: Map<string, bigint> | null = null;

  constructor(opts: MockChainClientOptions = {}) {
    this.opts = opts;
    this.outcomes = [...(opts.outcomes ?? [])];
    for (const [k, v] of Object.entries(opts.nonces ?? {})) this.nonces.set(k.toLowerCase(), v);
    if (opts.balances !== undefined) {
      const m = this.enableBalances();
      for (const [k, v] of Object.entries(opts.balances)) m.set(k.toLowerCase(), v);
    }
  }

  /** SPEC-M3F §1b: create the balance map and assign the own `getBalance` member (idempotent). */
  private enableBalances(): Map<string, bigint> {
    if (this.balances !== null) return this.balances;
    const m = new Map<string, bigint>();
    this.balances = m;
    this.getBalance = async (chain: Chain, address: Address): Promise<bigint> => m.get(nonceKey(chain, address)) ?? 0n;
    return m;
  }

  /** SPEC-M3F §1b: set a native balance (makes this mock a NativeBalanceSource from now on). */
  setBalance(chain: Chain, address: Address, v: bigint): void {
    this.enableBalances().set(nonceKey(chain, address), v);
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
