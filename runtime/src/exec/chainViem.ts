// SPEC-M2C §4. RealChainClient: the ChainClient interface (chain.ts) over viem's
// http transport, one public client per configured chain.
//
// Scope and trust boundary:
//   * This client never signs. It only supplies nonce + fee/gas fill (bounds-checked
//     by keyring K2) and relays already-signed transactions.
//   * On first use of a chain the node's eth_chainId must equal the configured
//     chain id; a mis-pointed RPC url throws instead of estimating/relaying against
//     the wrong network (the signature is chain-bound anyway — this fails earlier
//     and louder).
//   * Fees are whatever the node suggests (viem estimateFeesPerGas, EIP-1559). No
//     clamping here: an out-of-bounds suggestion must reach K2 and fail there.
//
// No Date.now / process.env / fetch( here (hygiene test covers src/exec): viem owns
// the transport; urls and chain ids are constructor inputs.

import { createPublicClient, defineChain, http, type Abi, type Chain as ViemChain, type Hex, type PublicClient, type Transport } from "viem";
import type { Chain } from "../policy/types.js";
import type { ChainClient, FeeFill, ReadContractRequest, SendReceipt, TxRequest } from "./chain.js";

export interface RealChainClientOptions {
  /** RPC url per chain. Only chains present here are usable; others throw. */
  rpcUrls: Partial<Record<Chain, string>>;
  /** Expected EVM chain id per chain (cfg.chainIds). Required for every chain in rpcUrls. */
  chainIds: Partial<Record<Chain, number>>;
  /** gasLimit = estimateGas × (10000 + bps) / 10000. DEFAULT 2000 (+20%). */
  gasHeadroomBps?: number;
  /** waitForTransactionReceipt timeout. DEFAULT 60_000 ms. */
  receiptTimeoutMs?: number;
  /** Receipt polling interval. DEFAULT 250 ms. */
  pollingIntervalMs?: number;
  /** Per-request http timeout. DEFAULT 15_000 ms. */
  httpTimeoutMs?: number;
}

export const DEFAULT_GAS_HEADROOM_BPS = 2000;
const BPS = 10_000n;

export class RealChainClient implements ChainClient {
  private readonly clients = new Map<Chain, PublicClient<Transport, ViemChain>>();
  private readonly verified = new Set<Chain>();
  private readonly opts: RealChainClientOptions;
  private readonly headroomBps: bigint;

  constructor(opts: RealChainClientOptions) {
    this.opts = opts;
    const h = opts.gasHeadroomBps ?? DEFAULT_GAS_HEADROOM_BPS;
    if (!Number.isInteger(h) || h < 0) throw new Error(`RealChainClient: gasHeadroomBps must be a non-negative integer, got ${h}`);
    this.headroomBps = BigInt(h);
    for (const [chain, url] of Object.entries(opts.rpcUrls) as Array<[Chain, string | undefined]>) {
      if (url === undefined) continue;
      const id = opts.chainIds[chain];
      if (id === undefined) throw new Error(`RealChainClient: no chain id configured for "${chain}"`);
      const def = defineChain({
        id,
        name: chain,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [url] } },
      });
      this.clients.set(
        chain,
        createPublicClient({
          chain: def,
          transport: http(url, { timeout: opts.httpTimeoutMs ?? 15_000, retryCount: 0 }),
          pollingInterval: opts.pollingIntervalMs ?? 250,
        }),
      );
    }
  }

  /** The viem client for `chain`, after a one-time eth_chainId check. */
  private async client(chain: Chain): Promise<PublicClient<Transport, ViemChain>> {
    const c = this.clients.get(chain);
    if (c === undefined) throw new Error(`RealChainClient: no RPC url configured for chain "${chain}"`);
    if (!this.verified.has(chain)) {
      const want = this.opts.chainIds[chain];
      const got = await c.getChainId();
      if (got !== want) throw new Error(`RealChainClient: ${chain} RPC reports chainId ${got}, expected ${want}`);
      this.verified.add(chain);
    }
    return c;
  }

  async getNonce(chain: Chain, address: `0x${string}`): Promise<number> {
    const c = await this.client(chain);
    // "pending": the executor waits for each receipt, but a tx still in the pool
    // (e.g. after a receipt timeout) must not have its nonce reused.
    return c.getTransactionCount({ address, blockTag: "pending" });
  }

  async estimateFill(chain: Chain, tx: TxRequest): Promise<FeeFill> {
    if (tx.chain !== chain) throw new Error(`RealChainClient: tx.chain ${tx.chain} != ${chain}`);
    if (tx.chainId !== this.opts.chainIds[chain]) {
      throw new Error(`RealChainClient: tx.chainId ${tx.chainId} != configured ${chain} chainId ${this.opts.chainIds[chain]}`);
    }
    const c = await this.client(chain);
    const gas = await c.estimateGas({ account: tx.from, to: tx.to, value: tx.value, data: tx.data });
    const fees = await c.estimateFeesPerGas({ type: "eip1559" });
    return {
      gasLimit: (gas * (BPS + this.headroomBps)) / BPS,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
  }

  async sendRaw(chain: Chain, signedTx: Hex): Promise<SendReceipt> {
    const c = await this.client(chain);
    const hash = await c.sendRawTransaction({ serializedTransaction: signedTx });
    const receipt = await c.waitForTransactionReceipt({
      hash,
      timeout: this.opts.receiptTimeoutMs ?? 60_000,
      pollingInterval: this.opts.pollingIntervalMs ?? 250,
    });
    return { hash, status: receipt.status };
  }

  async readContract(chain: Chain, req: ReadContractRequest): Promise<unknown> {
    const c = await this.client(chain);
    const abi: Abi = req.abi;
    return c.readContract({ address: req.address, abi, functionName: req.functionName, args: req.args ?? [] });
  }
}
