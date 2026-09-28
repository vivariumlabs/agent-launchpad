// SPEC-M4A §1 watcher.ts — viem getLogs poller (genesis/src/watcher.ts discipline).
//
// One address-set getLogs per chunk: factory, registry, hook, distributor, treasuryBuyback,
// poolManager, nft + every known bonding-curve clone. Cursor (next block to scan) in the `cursor`
// table. Each poll re-scans a trailing window of `reorgWindowBlocks` (DEFAULT 30) below the cursor,
// then walks to head in `maxBlockRange` (DEFAULT 10k) chunks — the same path is the historical
// backfill from startBlock (= manifest deployedAtBlock). A range-limited RPC (getLogs error naming
// the block range / result size) halves the chunk for an immediate retry of the same range, down to
// a floor of 100 blocks (then the error propagates); the chunk resets to maxBlockRange on success. Rows are keyed (txHash, logIndex) and
// written INSERT OR IGNORE; agent state / heartbeat / generation only move forward — so re-ingest is
// idempotent. Per chunk: an async phase (decode in (block, logIndex) order, RPC reads, block
// timestamps) builds the writes, then ONE sqlite transaction applies them + advances the cursor.
//
// Curve discovery mid-chunk: an AgentLive in a chunk names a curve the chunk's getLogs did not
// include, so the chunk is re-queried for the new curve addresses and merged (dedup by tx+logIndex).
// Swap ingestion: only poolIds registered by the hook (pools table or earlier in the same chunk).
//
// The loop (run) never throws: per-poll try/catch, LOUD warn, exponential backoff (cap 60 s).

import { decodeEventLog, encodeEventTopics, getAddress, type Abi, type Address, type Hex } from "viem";
import {
  agentFactoryAbi,
  agentNftAbi,
  agentRegistryAbi,
  bondingCurveAbi,
  feeSplitHookAbi,
  poolManagerAbi,
  royaltyDistributorAbi,
  treasuryBuybackAbi,
} from "./abi.js";
import { ZERO_ADDRESS, type IndexerChain, type RawLog } from "./chain.js";
import type { Clock } from "./clock.js";
import type { ContractsCfg } from "./config.js";
import type { IndexerDb, PoolRow } from "./db.js";
import { errMsg, type Logger } from "./log.js";

export const CURSOR_KEY = "watcher.nextBlock";
export const HEAD_KEY = "watcher.head";
export const LAST_POLL_KEY = "watcher.lastPollAt";
export const REVIVAL_WINDOW_KEY = "meta.revivalWindow";

export interface WatcherOpts {
  contracts: ContractsCfg;
  reorgWindowBlocks: number;
  maxBlockRange: number;
}

const SWAP_TOPIC = encodeEventTopics({ abi: poolManagerAbi, eventName: "Swap" })[0] as Hex;

/** Floor for the halved getLogs chunk on range-limited RPCs. */
export const MIN_BLOCK_RANGE = 100n;

/** Provider messages for "range / result set too large" on eth_getLogs (Alchemy, Infura, QuickNode, geth, Blockscout…). */
const RANGE_ERROR_RE = /range|more than \d+ results|too many (results|logs|blocks)|response size|limit exceeded|is limited to/i;

/** A getLogs failure whose message says the block range / result set is too large. */
export class GetLogsRangeError extends Error {
  constructor(readonly cause: unknown) {
    super(`getLogs range error: ${errMsg(cause)}`);
  }
}

export function isRangeError(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur !== undefined && cur !== null; i++) {
    const o = cur as { message?: unknown; details?: unknown; cause?: unknown };
    if ((typeof o.message === "string" && RANGE_ERROR_RE.test(o.message)) || (typeof o.details === "string" && RANGE_ERROR_RE.test(o.details))) return true;
    cur = o.cause;
  }
  return false;
}

/** JSON with bigints as base-10 strings (the API edge rule, applied at storage for event payloads). */
export function jsonData(o: Record<string, unknown>): string {
  return JSON.stringify(o, (_k, v: unknown) => (typeof v === "bigint" ? v.toString(10) : v));
}

function safeAgentId(v: bigint): number | null {
  return v > 0n && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
}

interface Decoded {
  eventName: string;
  args: Record<string, unknown>;
}

function decode(abi: Abi, l: RawLog): Decoded | null {
  if (l.topics.length === 0) return null;
  try {
    const d = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: true });
    return { eventName: String(d.eventName), args: (d.args ?? {}) as Record<string, unknown> };
  } catch {
    return null; // an event of that contract the indexer does not track (e.g. PlatformFeeRecipientSet)
  }
}

type Op = () => void;

export class Watcher {
  private readonly roles: Map<string, { name: string; abi: Abi }>;
  private failures = 0;

  constructor(
    private readonly db: IndexerDb,
    private readonly chain: IndexerChain,
    private readonly opts: WatcherOpts,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {
    const c = opts.contracts;
    this.roles = new Map<string, { name: string; abi: Abi }>([
      [c.factory.toLowerCase(), { name: "factory", abi: agentFactoryAbi as unknown as Abi }],
      [c.registry.toLowerCase(), { name: "registry", abi: agentRegistryAbi as unknown as Abi }],
      [c.hook.toLowerCase(), { name: "hook", abi: feeSplitHookAbi as unknown as Abi }],
      [c.distributor.toLowerCase(), { name: "distributor", abi: royaltyDistributorAbi as unknown as Abi }],
      [c.treasuryBuyback.toLowerCase(), { name: "buyback", abi: treasuryBuybackAbi as unknown as Abi }],
      [c.poolManager.toLowerCase(), { name: "poolManager", abi: poolManagerAbi as unknown as Abi }],
      [c.nft.toLowerCase(), { name: "nft", abi: agentNftAbi as unknown as Abi }],
    ]);
  }

  /** Next block to scan. */
  cursor(): bigint {
    const v = this.db.kvGet(CURSOR_KEY);
    return v === undefined ? this.opts.contracts.startBlock : BigInt(v);
  }

  private staticAddresses(): Address[] {
    const c = this.opts.contracts;
    return [c.factory, c.registry, c.hook, c.distributor, c.treasuryBuyback, c.poolManager, c.nft];
  }

  /**
   * One poll: re-scan the trailing reorg window, then walk to head in chunks. Throws on any RPC /
   * decode failure (the chunk's writes are not applied; the cursor stays at the last good chunk).
   */
  async poll(): Promise<{ from: bigint; to: bigint; chunks: number }> {
    const head = await this.chain.blockNumber();
    this.db.kvSet(HEAD_KEY, head.toString());
    if (this.db.kvGet(REVIVAL_WINDOW_KEY) === undefined) {
      this.db.kvSet(REVIVAL_WINDOW_KEY, (await this.chain.revivalWindow()).toString());
    }
    const start = this.opts.contracts.startBlock;
    const cur = this.cursor();
    const window = BigInt(this.opts.reorgWindowBlocks);
    let from = cur - window > start ? cur - window : start;
    const firstFrom = from;
    const configured = BigInt(this.opts.maxBlockRange);
    let step = configured;
    let chunks = 0;
    while (from <= head) {
      const to = from + step - 1n < head ? from + step - 1n : head;
      try {
        await this.ingestRange(from, to);
      } catch (e) {
        // Range-limited RPC: halve the chunk (floor MIN_BLOCK_RANGE) and retry the same `from`.
        const floor = configured < MIN_BLOCK_RANGE ? configured : MIN_BLOCK_RANGE;
        if (!(e instanceof GetLogsRangeError) || step <= floor) throw e;
        const half = step / 2n;
        step = half < floor ? floor : half;
        this.log.warn(`watcher: getLogs range error on [${from}, ${to}] — retrying with ${step}-block chunks: ${errMsg(e.cause)}`);
        continue;
      }
      step = configured;
      chunks++;
      from = to + 1n;
    }
    this.db.kvSet(LAST_POLL_KEY, this.clock.now().toString());
    return { from: firstFrom, to: head, chunks };
  }

  /** poll() wrapped: never throws; LOUD warn on failure. Returns the backoff delay for the next poll. */
  async pollSafe(pollMs: number): Promise<number> {
    try {
      await this.poll();
      this.failures = 0;
      return pollMs;
    } catch (e) {
      this.failures++;
      const delay = Math.min(pollMs * 2 ** Math.min(this.failures, 10), 60_000);
      this.log.warn(`WATCHER POLL FAILED (#${this.failures} in a row, cursor ${this.cursor()}), retrying in ${delay} ms: ${errMsg(e)}`);
      return delay;
    }
  }

  /** Scan [from, to] and commit it (rows + cursor = max(cursor, to + 1)) in one transaction. */
  async ingestRange(from: bigint, to: bigint): Promise<void> {
    const curves = this.db.curveMap();
    const known = [...this.staticAddresses(), ...[...curves.keys()].map((a) => getAddress(a))];
    const getLogs = async (addrs: readonly Address[]): Promise<RawLog[]> => {
      try {
        return await this.chain.getLogs(addrs, from, to);
      } catch (e) {
        throw isRangeError(e) ? new GetLogsRangeError(e) : e;
      }
    };
    let logs = await getLogs(known);

    // Curves born inside this chunk: re-query the chunk for them.
    const fresh = new Set<string>();
    const factory = this.opts.contracts.factory.toLowerCase();
    for (const l of logs) {
      if (l.address.toLowerCase() !== factory) continue;
      const d = decode(agentFactoryAbi as unknown as Abi, l);
      if (d?.eventName !== "AgentLive") continue;
      const c = String(d.args.curve).toLowerCase();
      if (!curves.has(c)) fresh.add(c);
    }
    if (fresh.size > 0) {
      const extra = await getLogs([...fresh].map((a) => getAddress(a)));
      logs = [...logs, ...extra];
    }
    const seen = new Set<string>();
    logs = logs
      .filter((l) => {
        const k = `${l.transactionHash.toLowerCase()}:${l.logIndex}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));

    const ops = await this.buildOps(logs, curves);
    const newNext = to + 1n;
    this.db.tx(() => {
      for (const op of ops) op();
      if (newNext > this.cursor()) this.db.kvSet(CURSOR_KEY, newNext.toString());
    });
  }

  private async buildOps(logs: readonly RawLog[], curves: Map<string, number>): Promise<Op[]> {
    const ops: Op[] = [];
    const tsCache = new Map<bigint, number>();
    const ts = async (b: bigint): Promise<number> => {
      let t = tsCache.get(b);
      if (t === undefined) {
        t = Number(await this.chain.blockTimestamp(b));
        tsCache.set(b, t);
      }
      return t;
    };
    const batchPools = new Map<string, PoolRow>();
    const poolOf = (poolId: string): PoolRow | undefined => batchPools.get(poolId) ?? this.db.pool(poolId);
    const usdg = this.opts.contracts.usdg.toLowerCase();
    const poolManager = this.opts.contracts.poolManager.toLowerCase();

    for (const l of logs) {
      const addr = l.address.toLowerCase();
      const txHash = l.transactionHash.toLowerCase();
      const base = { txHash, logIndex: l.logIndex, blockNumber: Number(l.blockNumber) };
      const event = (agentId: number | null, kind: string, t: number, data: Record<string, unknown>): Op => {
        const row = { ...base, agentId, kind, ts: t, data: jsonData(data) };
        return () => void this.db.insertEvent(row);
      };

      // PoolManager: cheap pre-filter (shared contract — most Swaps belong to foreign pools).
      if (addr === poolManager) {
        if (l.topics[0]?.toLowerCase() !== SWAP_TOPIC.toLowerCase()) continue;
        const poolId = l.topics[1]?.toLowerCase();
        if (poolId === undefined) continue;
        const pool = poolOf(poolId);
        if (pool === undefined) continue;
        const d = decode(poolManagerAbi as unknown as Abi, l);
        if (d === null) continue;
        const t = await ts(l.blockNumber);
        const a = d.args as { sender: Address; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; tick: number; fee: number };
        const swap = {
          ...base,
          poolId,
          agentId: pool.agentId,
          ts: t,
          amount0: a.amount0.toString(),
          amount1: a.amount1.toString(),
          sqrtPriceX96: a.sqrtPriceX96.toString(),
        };
        ops.push(() => void this.db.insertSwap(swap));
        ops.push(event(pool.agentId, "swap", t, { poolId, sender: a.sender, amount0: a.amount0, amount1: a.amount1, sqrtPriceX96: a.sqrtPriceX96, liquidity: a.liquidity, tick: a.tick, fee: a.fee, agentIsCurrency0: pool.agentIsCurrency0 === 1 }));
        continue;
      }

      const role = this.roles.get(addr);
      const curveAgent = curves.get(addr);
      if (role === undefined && curveAgent === undefined) continue;
      const d = decode(role?.abi ?? (bondingCurveAbi as unknown as Abi), l);
      if (d === null) continue;
      const a = d.args;
      const idArg = (k: string): number | null => {
        const v = a[k];
        if (typeof v !== "bigint") return null;
        const id = safeAgentId(v);
        if (id === null) this.log.error(`watcher: ignoring ${d.eventName} with out-of-range ${k} ${v} (tx ${txHash})`);
        return id;
      };

      if (curveAgent !== undefined && role === undefined) {
        const t = await ts(l.blockNumber);
        if (d.eventName === "Bought" || d.eventName === "Sold") {
          const buy = d.eventName === "Bought";
          const trade = {
            ...base,
            agentId: curveAgent,
            side: buy ? ("buy" as const) : ("sell" as const),
            trader: String(buy ? a.buyer : a.seller),
            usdg: String(buy ? a.usdgIn : a.usdgOut),
            tokens: String(buy ? a.tokensOut : a.tokensIn),
            fee: String(a.fee),
            ts: t,
          };
          ops.push(() => void this.db.insertCurveTrade(trade));
          ops.push(event(curveAgent, buy ? "curve_buy" : "curve_sell", t, { trader: trade.trader, usdg: trade.usdg, tokens: trade.tokens, fee: trade.fee }));
        } else if (d.eventName === "Graduated") {
          ops.push(event(curveAgent, "curve_graduated", t, { usdgSwept: a.usdgSwept, tokensSwept: a.tokensSwept }));
        }
        continue;
      }

      switch (`${role!.name}.${d.eventName}`) {
        case "factory.AgentRequested": {
          const id = idArg("agentId");
          if (id === null) break;
          const t = await ts(l.blockNumber);
          const p = await this.chain.pendingAgent(BigInt(id), l.blockNumber);
          const has = p.creator !== ZERO_ADDRESS;
          const row = {
            agentId: id,
            configHash: String(a.configHash).toLowerCase(),
            creator: getAddress(String(a.creator)),
            requestTx: txHash,
            requestBlock: Number(l.blockNumber),
            createdAt: t,
            name: has && p.name !== "" ? p.name : null,
            symbol: has && p.symbol !== "" ? p.symbol : null,
            imageURI: has && p.imageURI !== "" ? p.imageURI : null,
          };
          ops.push(() => this.db.upsertAgentRequested(row));
          ops.push(event(id, "requested", t, { configHash: row.configHash, creator: row.creator }));
          break;
        }
        case "factory.AgentLive": {
          const id = idArg("agentId");
          if (id === null) break;
          const t = await ts(l.blockNumber);
          // token/curve straight from the event (= tokenOf/curveOf, set in the same tx, AgentFactory.sol:269-276).
          const token = getAddress(String(a.token));
          const curve = getAddress(String(a.curve));
          const info = await this.chain.tokenInfo(token);
          const uri = await this.chain.nftTokenURI(BigInt(id));
          curves.set(curve.toLowerCase(), id);
          const row = { agentId: id, token, curve, totalSupply: info.totalSupply.toString(), name: info.name || null, symbol: info.symbol || null, imageURI: uri || null };
          ops.push(() => this.db.markAgentLive(row));
          ops.push(event(id, "live", t, { token, curve }));
          break;
        }
        case "factory.AgentCancelled": {
          const id = idArg("agentId");
          if (id === null) break;
          const t = await ts(l.blockNumber);
          ops.push(() => this.db.advanceState(id, "cancelled"));
          ops.push(event(id, "cancelled", t, {}));
          break;
        }
        case "factory.AgentGraduated": {
          const id = idArg("agentId");
          if (id === null) break;
          const t = await ts(l.blockNumber);
          ops.push(() => this.db.advanceState(id, "graduated"));
          ops.push(event(id, "graduated", t, { poolUsdg: a.poolUsdg, poolTokens: a.poolTokens, burned: a.burned }));
          break;
        }
        case "registry.GenesisOpened": {
          const id = idArg("agentId");
          if (id === null) break;
          ops.push(event(id, "genesis_opened", await ts(l.blockNumber), { deadline: a.deadline }));
          break;
        }
        case "registry.InstanceRegistered": {
          const id = idArg("agentId");
          if (id === null) break;
          const t = await ts(l.blockNumber);
          const generation = Number(a.generation);
          // attestationRef is not in the event: read the current struct; use it only when it is the same generation.
          const cur = await this.chain.instanceOf(BigInt(id));
          const row = {
            agentId: id,
            treasuryEOA: getAddress(String(a.treasuryEOA)),
            actionEOA: getAddress(String(a.actionEOA)),
            codeHash: String(a.codeHash).toLowerCase(),
            generation,
            attestationRef: cur.generation === generation && cur.attestationRef !== "" ? cur.attestationRef : null,
            registeredAt: t,
          };
          ops.push(() => this.db.upsertInstanceRegistered(row));
          ops.push(event(id, "registered", t, { treasuryEOA: row.treasuryEOA, actionEOA: row.actionEOA, codeHash: row.codeHash, generation }));
          break;
        }
        case "registry.Heartbeat": {
          const id = idArg("agentId");
          if (id === null) break;
          const t = await ts(l.blockNumber);
          const hb = Number(a.timestamp);
          ops.push(() => {
            if (!this.db.heartbeat(id, hb)) this.log.warn(`watcher: Heartbeat for agent ${id} without an instance row (tx ${txHash}) — reconcile will fill it`);
          });
          ops.push(event(id, "heartbeat", t, { timestamp: a.timestamp }));
          break;
        }
        case "hook.PoolRegistered": {
          const id = idArg("agentId");
          if (id === null) break;
          const t = await ts(l.blockNumber);
          const poolId = String(a.poolId).toLowerCase();
          const agentToken = getAddress(String(a.agentToken));
          // v4 orders currencies ascending (currency0 < currency1); FeeSplitHook.registerPool
          // (FeeSplitHook.sol:255-262) requires {c0,c1} = {agentToken, usdg}, so the agent token is
          // currency0 iff its address sorts below USDG's (AgentFactory.sol:445-452 _poolKey).
          const pool: PoolRow = { poolId, agentId: id, agentToken, agentIsCurrency0: agentToken.toLowerCase() < usdg ? 1 : 0 };
          batchPools.set(poolId, pool);
          ops.push(() => {
            this.db.upsertPool(pool);
            this.db.setAgentPool(id, poolId);
          });
          ops.push(event(id, "pool_registered", t, { poolId, agentToken, agentIsCurrency0: pool.agentIsCurrency0 === 1 }));
          break;
        }
        case "hook.FeeCollected": {
          const poolId = String(a.poolId).toLowerCase();
          const pool = poolOf(poolId);
          ops.push(event(pool?.agentId ?? null, "fee_collected", await ts(l.blockNumber), { poolId, currency: a.currency, amount: a.amount }));
          break;
        }
        case "hook.Distributed": {
          const poolId = String(a.poolId).toLowerCase();
          const pool = poolOf(poolId);
          const t = await ts(l.blockNumber);
          if (pool === undefined) {
            this.log.warn(`watcher: Distributed for unknown pool ${poolId} (tx ${txHash}) — no fee row`);
          } else {
            const fee = {
              ...base,
              agentId: pool.agentId,
              poolId,
              buybackLeg: String(a.buybackLeg),
              treasuryLeg: String(a.treasuryLeg),
              royaltyLeg: String(a.royaltyLeg),
              converted: String(a.converted),
              ts: t,
            };
            ops.push(() => void this.db.insertFee(fee));
          }
          ops.push(event(pool?.agentId ?? null, "distributed", t, { poolId, buybackLeg: a.buybackLeg, treasuryLeg: a.treasuryLeg, royaltyLeg: a.royaltyLeg, converted: a.converted }));
          break;
        }
        case "distributor.Credited": {
          const id = idArg("agentId");
          if (id === null) break;
          ops.push(event(id, "royalty_credited", await ts(l.blockNumber), { amount: a.amount }));
          break;
        }
        case "distributor.Claimed": {
          const id = idArg("agentId");
          if (id === null) break;
          ops.push(event(id, "royalty_claimed", await ts(l.blockNumber), { to: a.to, amount: a.amount }));
          break;
        }
        case "distributor.Emancipated": {
          const id = idArg("agentId");
          if (id === null) break;
          ops.push(event(id, "emancipated", await ts(l.blockNumber), { sweptToTreasury: a.sweptToTreasury }));
          break;
        }
        case "buyback.Poked": {
          // Platform-wide buyback: no agent.
          ops.push(event(null, "buyback_poked", await ts(l.blockNumber), { caller: a.caller, usdgIn: a.usdgIn, tokensBurned: a.tokensBurned, callerReward: a.callerReward }));
          break;
        }
        case "nft.Transfer": {
          const id = idArg("tokenId");
          if (id === null) break;
          ops.push(event(id, "nft_transfer", await ts(l.blockNumber), { from: a.from, to: a.to }));
          break;
        }
        default:
          break;
      }
    }
    return ops;
  }
}
