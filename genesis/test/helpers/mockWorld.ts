// In-memory multi-chain world implementing the orchestrator's Launchpad + ChainClient interfaces:
// factory/registry semantics mirror contracts/src/{AgentFactory,AgentRegistry}.sol (createAgent →
// openGenesis, registerInstance genesis/revival rules, finalize requires pending + registered),
// ERC-20 + native transfers with Transfer logs, nonces, receipts, and failure injection
// (revert / drop / crash / reorg) for the idempotence scenarios.

import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  stringToHex,
  hexToString,
  type Address,
  type Hex,
} from "viem";
import { agentFactoryAbi, erc20Abi } from "../../src/abi.js";
import type { AgentInstance, ChainClient, ChainKey, Launchpad, PendingAgent, RequestedLog, SignedTx, TxReceipt, TxRequest } from "../../src/chain.js";
import { ZERO_ADDRESS } from "../../src/chain.js";
import { NonceConsumed } from "../../src/errors.js";

export const FACTORY: Address = getAddress("0x00000000000000000000000000000000000FAC70");
export const REGISTRY: Address = getAddress("0x0000000000000000000000000000000000000BEE");
export const USDG: Address = getAddress("0x00000000000000000000000000000000000005D6");
export const BASE_USDC: Address = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
export const E18 = 10n ** 18n;

interface MockTx {
  chain: ChainKey;
  hash: Hex;
  from: Address;
  to: Address;
  value: bigint;
  data: Hex;
  nonce: number;
}

export interface ExecutedTx extends MockTx {
  status: "success" | "reverted";
  index: number;
  kind: "native" | "erc20" | "finalize" | "other";
  erc20?: { token: Address; to: Address; amount: bigint };
}

export type BroadcastDecision = "ok" | "revert" | "drop" | "pending" | "crash-before" | "crash-after";

export interface WorldHooks {
  /** Decide what happens to a broadcast tx (default ok = mined immediately). */
  onBroadcast?: (tx: MockTx) => BroadcastDecision | undefined;
  /** Called when waitReceipt returns a receipt; may throw (simulated crash) or reorg the tx. */
  onWaitReceipt?: (tx: ExecutedTx) => void;
}

const k = (...p: Array<string | bigint | number>): string => p.map((x) => String(x).toLowerCase()).join(":");

export class MockWorld {
  blockNumber = 100n;
  timestamp = 1_900_000_000n;
  creationFee = 75_000_000n;
  revivalWindow = 7n * 86_400n;
  agentCount = 0n;
  readonly pending = new Map<bigint, PendingAgent>();
  readonly tokenOf = new Map<bigint, Address>();
  readonly instances = new Map<bigint, AgentInstance>();
  readonly expected = new Map<bigint, Address>();
  readonly deadlines = new Map<bigint, bigint>();
  readonly logs: RequestedLog[] = [];
  readonly blockTs = new Map<bigint, bigint>();
  readonly native = new Map<string, bigint>();
  readonly erc20 = new Map<string, bigint>();
  readonly executed: ExecutedTx[] = [];
  readonly receipts = new Map<string, TxReceipt>();
  readonly mempool = new Map<string, MockTx>();
  readonly nonces = new Map<string, number>();
  readonly finalizeCalls: bigint[] = [];
  hooks: WorldHooks = {};
  private seq = 0;

  mine(seconds = 12n): void {
    this.blockNumber += 1n;
    this.timestamp += seconds;
    this.blockTs.set(this.blockNumber, this.timestamp);
  }

  setNative(chain: ChainKey, who: Address, v: bigint): void {
    this.native.set(k(chain, who), v);
  }
  getNative(chain: ChainKey, who: Address): bigint {
    return this.native.get(k(chain, who)) ?? 0n;
  }
  setErc20(chain: ChainKey, token: Address, who: Address, v: bigint): void {
    this.erc20.set(k(chain, token, who), v);
  }
  getErc20(chain: ChainKey, token: Address, who: Address): bigint {
    return this.erc20.get(k(chain, token, who)) ?? 0n;
  }

  // ---- contract semantics ----

  createAgent(configHash: Hex, creator: Address, expectedTreasury: Address): bigint {
    const id = ++this.agentCount;
    this.mine();
    const deadline = this.timestamp + 86_400n;
    this.pending.set(id, { creator, configHash, imageURI: "ar://img", name: `A${id}`, symbol: `A${id}`, genesisDeadline: deadline, feePaid: true });
    this.expected.set(id, expectedTreasury);
    this.deadlines.set(id, deadline);
    this.logs.push({ agentId: id, configHash, creator, blockNumber: this.blockNumber, txHash: keccak256(stringToHex(`create-${id}`)), logIndex: 0 });
    return id;
  }

  /** AgentRegistry.registerInstance semantics (the ENCLAVE calls this, never the orchestrator). */
  registerInstance(agentId: bigint, treasury: Address, action: Address, codeHash: Hex, attestationRef = "ar://att"): void {
    const inst = this.instances.get(agentId);
    this.mine();
    if (inst === undefined || inst.lastHeartbeat === 0n) {
      const d = this.deadlines.get(agentId) ?? 0n;
      if (d === 0n) throw new Error("GenesisNotOpened");
      if (this.timestamp > d) throw new Error("GenesisClosed");
      if (treasury !== this.expected.get(agentId)) throw new Error("UnexpectedTreasury");
      this.instances.set(agentId, { treasuryEOA: treasury, actionEOA: action, codeHash, attestationRef, lastHeartbeat: this.timestamp, generation: 1 });
      return;
    }
    if (this.timestamp - inst.lastHeartbeat <= this.revivalWindow) throw new Error("RevivalWindowNotElapsed");
    if (inst.treasuryEOA !== treasury || inst.actionEOA !== action || inst.codeHash !== codeHash) throw new Error("MismatchedRevivalKeys");
    this.instances.set(agentId, { ...inst, attestationRef, generation: inst.generation + 1, lastHeartbeat: this.timestamp });
  }

  heartbeat(agentId: bigint): void {
    const inst = this.instances.get(agentId);
    if (inst === undefined) throw new Error("NotRegistered");
    this.mine();
    this.instances.set(agentId, { ...inst, lastHeartbeat: this.timestamp });
  }

  private finalize(agentId: bigint): boolean {
    const p = this.pending.get(agentId);
    if (p === undefined || p.creator === ZERO_ADDRESS) return false;
    if (this.instances.get(agentId) === undefined) return false;
    this.pending.delete(agentId);
    this.tokenOf.set(agentId, getAddress(`0x${(0xa0000n + agentId).toString(16).padStart(40, "0")}`));
    this.finalizeCalls.push(agentId);
    return true;
  }

  // ---- tx execution ----

  private nonceOf(chain: ChainKey, who: Address): number {
    return this.nonces.get(k(chain, who)) ?? 0;
  }

  private pendingNonce(chain: ChainKey, who: Address): number {
    let n = this.nonceOf(chain, who);
    for (const t of this.mempool.values()) if (t.chain === chain && t.from === who && t.nonce >= n) n = t.nonce + 1;
    return n;
  }

  private encodeRaw(t: Omit<MockTx, "hash">): Hex {
    return stringToHex(JSON.stringify({ ...t, value: t.value.toString() }));
  }

  private decodeRaw(raw: Hex): MockTx {
    const o = JSON.parse(hexToString(raw)) as Omit<MockTx, "hash" | "value"> & { value: string };
    return { ...o, value: BigInt(o.value), hash: keccak256(raw) };
  }

  sign(chain: ChainKey, from: Address, req: TxRequest): SignedTx {
    const nonce = this.pendingNonce(chain, from);
    const raw = this.encodeRaw({ chain, from, to: req.to, value: req.value ?? 0n, data: req.data ?? "0x", nonce });
    return { hash: keccak256(raw), raw, nonce };
  }

  /** Execute (mine) a tx. */
  private execute(t: MockTx, forceRevert: boolean): ExecutedTx {
    this.mine(2n);
    this.nonces.set(k(t.chain, t.from), t.nonce + 1);
    this.mempool.delete(t.hash);
    let status: "success" | "reverted" = "success";
    let kind: ExecutedTx["kind"] = "other";
    let erc20: ExecutedTx["erc20"];
    const logs: TxReceipt["logs"][number][] = [];
    if (forceRevert) status = "reverted";
    else if (t.data === "0x") {
      kind = "native";
      const bal = this.getNative(t.chain, t.from);
      if (bal < t.value) status = "reverted";
      else {
        this.setNative(t.chain, t.from, bal - t.value);
        this.setNative(t.chain, t.to, this.getNative(t.chain, t.to) + t.value);
      }
    } else if (t.chain === "rh" && t.to === FACTORY) {
      kind = "finalize";
      const d = decodeFunctionData({ abi: agentFactoryAbi, data: t.data });
      if (d.functionName !== "finalize" || !this.finalize(d.args[0] as bigint)) status = "reverted";
    } else {
      kind = "erc20";
      const d = decodeFunctionData({ abi: erc20Abi, data: t.data });
      if (d.functionName !== "transfer") status = "reverted";
      else {
        const [to, amount] = d.args as [Address, bigint];
        erc20 = { token: t.to, to, amount };
        const bal = this.getErc20(t.chain, t.to, t.from);
        if (bal < amount) status = "reverted";
        else {
          this.setErc20(t.chain, t.to, t.from, bal - amount);
          this.setErc20(t.chain, t.to, to, this.getErc20(t.chain, t.to, to) + amount);
          logs.push({
            address: t.to,
            topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: t.from, to } }) as Hex[],
            data: encodeAbiParameters([{ type: "uint256" }], [amount]),
          });
        }
      }
    }
    const ex: ExecutedTx = { ...t, status, index: this.seq++, kind, erc20 };
    this.executed.push(ex);
    this.receipts.set(t.hash, { status, blockNumber: this.blockNumber, logs });
    return ex;
  }

  /** Simulated reorg: the tx never happened (effects reversed, receipt + knowledge gone). */
  reorgOut(hash: Hex): void {
    const i = this.executed.findIndex((t) => t.hash === hash);
    if (i < 0) throw new Error("reorgOut: unknown tx");
    const t = this.executed[i]!;
    this.executed.splice(i, 1);
    this.receipts.delete(hash);
    if (t.status === "success") {
      if (t.kind === "native") {
        this.setNative(t.chain, t.from, this.getNative(t.chain, t.from) + t.value);
        this.setNative(t.chain, t.to, this.getNative(t.chain, t.to) - t.value);
      } else if (t.kind === "erc20" && t.erc20 !== undefined) {
        this.setErc20(t.chain, t.erc20.token, t.from, this.getErc20(t.chain, t.erc20.token, t.from) + t.erc20.amount);
        this.setErc20(t.chain, t.erc20.token, t.erc20.to, this.getErc20(t.chain, t.erc20.token, t.erc20.to) - t.erc20.amount);
      }
    }
    // Nonce model: the slot stays consumed (in reality a replacement fills it); later txs keep theirs.
  }

  /** Mine a tx previously left pending in the mempool. */
  minePending(hash: Hex): void {
    const t = this.mempool.get(hash);
    if (t === undefined) throw new Error("minePending: not in mempool");
    this.execute(t, false);
  }

  broadcast(chain: ChainKey, raw: Hex): void {
    const t = this.decodeRaw(raw);
    if (t.chain !== chain) throw new Error("wrong chain");
    if (this.receipts.has(t.hash) || this.mempool.has(t.hash)) return; // already known
    if (t.nonce < this.nonceOf(chain, t.from)) throw new NonceConsumed(`nonce ${t.nonce} < ${this.nonceOf(chain, t.from)}`);
    const d = this.hooks.onBroadcast?.(t) ?? "ok";
    if (d === "crash-before") throw new Error("simulated crash before broadcast reached the node");
    if (d === "drop") return; // node accepted then forgot it
    if (d === "pending") {
      this.mempool.set(t.hash, t);
      return;
    }
    this.execute(t, d === "revert");
    if (d === "crash-after") throw new Error("simulated crash after broadcast");
  }

  // ---- interface views ----

  launchpad(): Launchpad {
    const w = this;
    return {
      factory: FACTORY,
      registry: REGISTRY,
      usdg: USDG,
      latestBlock: async () => ({ number: w.blockNumber, timestamp: w.timestamp }),
      blockTimestamp: async (n) => w.blockTs.get(n) ?? w.timestamp,
      requestedLogs: async (from, to, agentId) =>
        w.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to && (agentId === undefined || l.agentId === agentId)),
      pendingAgent: async (id) =>
        w.pending.get(id) ?? { creator: ZERO_ADDRESS, configHash: `0x${"0".repeat(64)}`, imageURI: "", name: "", symbol: "", genesisDeadline: 0n, feePaid: false },
      tokenOf: async (id) => w.tokenOf.get(id) ?? ZERO_ADDRESS,
      creationFee: async () => w.creationFee,
      isRegistered: async (id) => (w.instances.get(id)?.lastHeartbeat ?? 0n) !== 0n,
      instanceOf: async (id) =>
        w.instances.get(id) ?? { treasuryEOA: ZERO_ADDRESS, actionEOA: ZERO_ADDRESS, codeHash: `0x${"0".repeat(64)}`, attestationRef: "", lastHeartbeat: 0n, generation: 0 },
      expectedTreasuryEOA: async (id) => w.expected.get(id) ?? ZERO_ADDRESS,
      genesisDeadline: async (id) => w.deadlines.get(id) ?? 0n,
      revivalWindow: async () => w.revivalWindow,
    };
  }

  client(chain: ChainKey, sender: Address): ChainClient {
    const w = this;
    return {
      key: chain,
      sender,
      nativeBalance: async (who) => w.getNative(chain, who),
      erc20Balance: async (token, who) => w.getErc20(chain, token, who),
      prepare: async (req) => w.sign(chain, sender, req),
      broadcast: async (raw) => w.broadcast(chain, raw),
      receipt: async (hash) => w.receipts.get(hash) ?? null,
      known: async (hash) => w.receipts.has(hash) || w.mempool.has(hash),
      waitReceipt: async (hash) => {
        const rc = w.receipts.get(hash) ?? null;
        if (rc !== null) {
          const ex = w.executed.find((t) => t.hash === hash);
          if (ex !== undefined) w.hooks.onWaitReceipt?.(ex);
        }
        return rc;
      },
    };
  }

  /** Transactions to `target` (native value or ERC-20 transfer) that are currently in effect. */
  txsTo(target: Address): ExecutedTx[] {
    return this.executed.filter((t) => t.status === "success" && (t.to === target || t.erc20?.to === target));
  }
}
