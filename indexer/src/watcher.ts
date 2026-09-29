// SPEC-M4A §1 watcher.ts — viem getLogs poller (genesis/src/watcher.ts discipline).
//
// One address-set getLogs per chunk: every stack's factory, registry, hook, distributor, nft
// (SPEC-M4G §3 dual-stack: the legacy v1 stack + the primary v2 stack, disjoint agent-id ranges R2)
// + the shared poolManager + the floor vault (D18) + every known bonding-curve clone. Plus, per
// chunk, one topic-filtered getLogs for USDG Transfers TO the vault (inflow classification:
// any stack's hook ⇒ fee_pool, a v2 curve ⇒ fee_curve, anything else ⇒ donation → floor_flows).
// The v1 TreasuryBuyback is not indexed (SPEC-M4G R7). Cursor (next block to scan) in the `cursor`
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
// Action-swap attribution (M4A debt (a)): the v4 Swap `sender` is the shared router, so each swap's
// TRANSACTION sender (chain.txFrom, per-chunk cache) is matched against every instance's action /
// treasury EOA; a match adds an "actionSwap" event for the ACTING agent on the same (txHash,
// logIndex). Best-effort: a txFrom failure leaves the swap senderResolved = 0 for the per-poll
// backfill (backfillSenders, oldest first, senderBackfillPerPoll DEFAULT 25), never blocks ingest.
//
// Stack coverage (SPEC-M4G §3): the scan starts at min(stack startBlock). A stack added to an
// EXISTING db is fully covered only if its startBlock ≥ the poll's first `from`; otherwise its
// history below the cursor was never scanned — a LOUD warning (no auto-rescan). Covered stacks are
// remembered in kv (by factory); a pre-M4G db's stack counts as covered when the db already holds
// an agent in its id range.
//
// The loop (run) never throws: per-poll try/catch, LOUD warn, exponential backoff (cap 60 s).

import { decodeEventLog, encodeEventTopics, getAddress, type Abi, type Address, type Hex } from "viem";
import {
  agentFactoryAbi,
  agentNftAbi,
  agentRegistryAbi,
  bondingCurveAbi,
  erc20Abi,
  feeSplitHookAbi,
  floorVaultAbi,
  poolManagerAbi,
  royaltyDistributorAbi,
} from "./abi.js";
import { ERC20_TRANSFER_TOPIC, ZERO_ADDRESS, type IndexerChain, type RawLog } from "./chain.js";
import type { Clock } from "./clock.js";
import { stackForAgent, type ChainContracts, type StackCfg } from "./config.js";
import type { FloorFlowKind, IndexerDb, PoolRow } from "./db.js";
import { errMsg, type Logger } from "./log.js";

export const CURSOR_KEY = "watcher.nextBlock";
export const HEAD_KEY = "watcher.head";
export const LAST_POLL_KEY = "watcher.lastPollAt";
export const REVIVAL_WINDOW_KEY = "meta.revivalWindow";
/** JSON array of lowercase factory addresses whose stack history this db fully covers. */
export const STACKS_COVERED_KEY = "watcher.stacksCovered";

export interface WatcherOpts {
  /** SPEC-M4G §3: every stack (primary first) + shared usdg / poolManager + the floor vault. */
  contracts: ChainContracts;
  reorgWindowBlocks: number;
  maxBlockRange: number;
  /** Unresolved swap senders resolved per poll (M4A debt (a) backfill) DEFAULT 25. */
  senderBackfillPerPoll?: number;
}

export const DEFAULT_SENDER_BACKFILL_PER_POLL = 25;

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

interface Role {
  name: "factory" | "registry" | "hook" | "distributor" | "nft" | "poolManager" | "vault";
  abi: Abi;
  /** The stack the contract belongs to (null for shared / platform-wide contracts). */
  stack: StackCfg | null;
}

export class Watcher {
  private readonly roles: Map<string, Role>;
  private failures = 0;
  /** Uncovered stacks already warned about in this process (by factory). */
  private readonly warnedStacks = new Set<string>();

  constructor(
    private readonly db: IndexerDb,
    private readonly chain: IndexerChain,
    private readonly opts: WatcherOpts,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {
    const c = opts.contracts;
    if (c.stacks.length === 0) throw new Error("watcher: no stacks configured");
    this.roles = new Map<string, Role>();
    const add = (a: Address, r: Role): void => {
      const k = a.toLowerCase();
      if (this.roles.has(k)) throw new Error(`watcher: address ${a} has two roles (${this.roles.get(k)!.name}, ${r.name})`);
      this.roles.set(k, r);
    };
    for (const st of c.stacks) {
      add(st.factory, { name: "factory", abi: agentFactoryAbi as unknown as Abi, stack: st });
      add(st.registry, { name: "registry", abi: agentRegistryAbi as unknown as Abi, stack: st });
      add(st.hook, { name: "hook", abi: feeSplitHookAbi as unknown as Abi, stack: st });
      add(st.distributor, { name: "distributor", abi: royaltyDistributorAbi as unknown as Abi, stack: st });
      add(st.nft, { name: "nft", abi: agentNftAbi as unknown as Abi, stack: st });
    }
    add(c.poolManager, { name: "poolManager", abi: poolManagerAbi as unknown as Abi, stack: null });
    if (c.floor !== null) add(c.floor.vault, { name: "vault", abi: floorVaultAbi as unknown as Abi, stack: null });
  }

  /** Scan start = min(stack startBlock). */
  startBlock(): bigint {
    let m = this.opts.contracts.stacks[0]!.startBlock;
    for (const st of this.opts.contracts.stacks) if (st.startBlock < m) m = st.startBlock;
    return m;
  }

  /** Next block to scan. */
  cursor(): bigint {
    const v = this.db.kvGet(CURSOR_KEY);
    return v === undefined ? this.startBlock() : BigInt(v);
  }

  private staticAddresses(): Address[] {
    return [...this.roles.keys()].map((a) => getAddress(a));
  }

  /** Agent-id range [firstAgentId, next stack's firstAgentId) of a stack (hi null = unbounded). */
  private idRange(st: StackCfg): { lo: number; hi: number | null } {
    let hi: number | null = null;
    for (const o of this.opts.contracts.stacks) if (o.firstAgentId > st.firstAgentId && (hi === null || o.firstAgentId < hi)) hi = o.firstAgentId;
    return { lo: st.firstAgentId, hi };
  }

  /**
   * SPEC-M4G §3 stack coverage check (see header). `from` = this poll's first scanned block.
   * Never rescans; an uncovered stack is a LOUD warning once per process.
   */
  private checkStackCoverage(from: bigint): void {
    const raw = this.db.kvGet(STACKS_COVERED_KEY);
    const covered = new Set<string>(raw === undefined ? [] : (JSON.parse(raw) as string[]));
    const before = covered.size;
    const cur = this.cursor();
    for (const st of this.opts.contracts.stacks) {
      const f = st.factory.toLowerCase();
      if (covered.has(f)) continue;
      const r = this.idRange(st);
      if (st.startBlock >= from || this.db.hasAgentInRange(r.lo, r.hi)) {
        covered.add(f);
        continue;
      }
      if (this.warnedStacks.has(f)) continue;
      this.warnedStacks.add(f);
      this.log.warn(
        `STACK NOT BACKFILLED: stack v${st.version} (factory ${st.factory}) startBlock ${st.startBlock} < cursor ${cur} and this db has never seen its factory — ` +
          `blocks [${st.startBlock}, ${from}) were NOT scanned for it (no auto-rescan; re-index from a fresh db to backfill)`,
      );
    }
    if (covered.size !== before) this.db.kvSet(STACKS_COVERED_KEY, JSON.stringify([...covered].sort()));
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
    const start = this.startBlock();
    const cur = this.cursor();
    const window = BigInt(this.opts.reorgWindowBlocks);
    let from = cur - window > start ? cur - window : start;
    const firstFrom = from;
    this.checkStackCoverage(firstFrom);
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
    await this.backfillSenders();
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

  /**
   * A txHash → tx sender lookup with its own in-memory cache (one per chunk / backfill pass). A
   * failure (RPC error, or the node not knowing the tx) is warned LOUDLY and yields null — the swap
   * stays senderResolved = 0 and the backfill retries it on a later poll.
   */
  private txFromResolver(): (txHash: string, logIndex: number) => Promise<string | null> {
    const cache = new Map<string, string | null>();
    return async (txHash, logIndex) => {
      if (cache.has(txHash)) return cache.get(txHash)!;
      let from: string | null;
      try {
        from = await this.chain.txFrom(txHash as Hex);
        if (from === null) this.log.warn(`SWAP SENDER UNRESOLVED (tx ${txHash}, log ${logIndex}): node does not know the tx — backfill will retry`);
      } catch (e) {
        from = null;
        this.log.warn(`SWAP SENDER UNRESOLVED (tx ${txHash}, log ${logIndex}): txFrom failed — backfill will retry: ${errMsg(e)}`);
      }
      from = from === null ? null : from.toLowerCase();
      cache.set(txHash, from);
      return from;
    };
  }

  /**
   * M4A debt (a) rule, applied once per swap (sync; call inside a db transaction): match the tx
   * sender against every instance's actionEOA / treasuryEOA; store the sender columns; on a match
   * insert the ACTING agent's "actionSwap" event on the same (txHash, logIndex). No-op when the
   * swap is already resolved (or unknown).
   */
  private attributeSwap(s: { txHash: string; logIndex: number; blockNumber: number; ts: number; poolId: string; agentId: number; amount0: string; amount1: string; agentIsCurrency0: number }, from: string): void {
    const m = this.db.agentByWallet(from);
    if (!this.db.setSwapSender(s.txHash, s.logIndex, from, m?.agentId ?? null, m?.wallet ?? null)) return;
    if (m === null) return;
    this.db.insertEvent({
      agentId: m.agentId,
      kind: "actionSwap",
      txHash: s.txHash,
      logIndex: s.logIndex,
      blockNumber: s.blockNumber,
      ts: s.ts,
      data: jsonData({ poolId: s.poolId, poolAgentId: s.agentId, wallet: m.wallet, amount0: s.amount0, amount1: s.amount1, agentIsCurrency0: s.agentIsCurrency0 === 1 }),
    });
  }

  /**
   * Backfill: resolve up to `senderBackfillPerPoll` (DEFAULT 25) unresolved swaps, oldest first,
   * with the same rule as ingest. Covers pre-migration rows and transient txFrom failures.
   * Returns the number resolved.
   */
  async backfillSenders(): Promise<number> {
    const rows = this.db.unresolvedSwaps(this.opts.senderBackfillPerPoll ?? DEFAULT_SENDER_BACKFILL_PER_POLL);
    if (rows.length === 0) return 0;
    const txFromOf = this.txFromResolver();
    let resolved = 0;
    for (const r of rows) {
      const from = await txFromOf(r.txHash, r.logIndex);
      if (from === null) continue;
      this.db.tx(() => this.attributeSwap(r, from));
      resolved++;
    }
    return resolved;
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

    // Curves born inside this chunk (AgentLive from ANY stack's factory): re-query the chunk for them.
    const fresh = new Set<string>();
    for (const l of logs) {
      if (this.roles.get(l.address.toLowerCase())?.name !== "factory") continue;
      const d = decode(agentFactoryAbi as unknown as Abi, l);
      if (d?.eventName !== "AgentLive") continue;
      const c = String(d.args.curve).toLowerCase();
      if (!curves.has(c)) fresh.add(c);
    }
    if (fresh.size > 0) {
      const extra = await getLogs([...fresh].map((a) => getAddress(a)));
      logs = [...logs, ...extra];
    }
    // SPEC-M4G §3 vault inflows: USDG Transfer logs with topic2 = vault over the same range.
    const floor = this.opts.contracts.floor;
    if (floor !== null) {
      try {
        logs = [...logs, ...(await this.chain.getTransferLogsTo(this.opts.contracts.usdg, floor.vault, from, to))];
      } catch (e) {
        throw isRangeError(e) ? new GetLogsRangeError(e) : e;
      }
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
    const txFromOf = this.txFromResolver();
    const stacks = this.opts.contracts.stacks;
    const vault = this.opts.contracts.floor?.vault.toLowerCase() ?? null;
    const vaultTopic = vault === null ? null : `0x${vault.slice(2).padStart(64, "0")}`;
    // fee_pool attribution: every hook Distributed in this chunk, by tx (the hook's USDG transfer to
    // the vault precedes its Distributed event in the same tx, FeeSplitHook.sol:374-380).
    const distributedByTx = new Map<string, Array<{ hook: string; poolId: string; floorLeg: bigint }>>();
    for (const l of logs) {
      const r = this.roles.get(l.address.toLowerCase());
      if (r?.name !== "hook") continue;
      const d = decode(r.abi, l);
      if (d?.eventName !== "Distributed") continue;
      const k = l.transactionHash.toLowerCase();
      const list = distributedByTx.get(k) ?? [];
      list.push({ hook: l.address.toLowerCase(), poolId: String(d.args.poolId).toLowerCase(), floorLeg: d.args.floorLeg as bigint });
      distributedByTx.set(k, list);
    }

    for (const l of logs) {
      const addr = l.address.toLowerCase();
      const txHash = l.transactionHash.toLowerCase();
      const base = { txHash, logIndex: l.logIndex, blockNumber: Number(l.blockNumber) };
      const event = (agentId: number | null, kind: string, t: number, data: Record<string, unknown>): Op => {
        const row = { ...base, agentId, kind, ts: t, data: jsonData(data) };
        return () => void this.db.insertEvent(row);
      };

      // SPEC-M4G §3 floor-vault USDG inflow (from the topic-filtered getLogs).
      if (addr === usdg) {
        if (vaultTopic === null || l.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase() || l.topics[2]?.toLowerCase() !== vaultTopic) continue;
        const d = decode(erc20Abi as unknown as Abi, l);
        if (d === null) continue;
        const sender = getAddress(String(d.args.from));
        const value = d.args.value as bigint;
        const s = sender.toLowerCase();
        let kind: FloorFlowKind = "donation";
        let agentId: number | null = null;
        if (this.roles.get(s)?.name === "hook") {
          kind = "fee_pool";
          let cands = (distributedByTx.get(txHash) ?? []).filter((x) => x.hook === s);
          if (cands.length > 1) cands = cands.filter((x) => x.floorLeg === value);
          if (cands.length === 1) agentId = poolOf(cands[0]!.poolId)?.agentId ?? null;
        } else {
          const ca = curves.get(s);
          if (ca !== undefined && (stackForAgent(stacks, ca)?.version ?? 0) >= 2) {
            kind = "fee_curve";
            agentId = ca;
          }
        }
        const row = { ...base, kind, account: sender, usdg: value.toString(10), tokens: "0", agentId, ts: await ts(l.blockNumber) };
        ops.push(() => void this.db.upsertFloorFlow(row));
        continue;
      }

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
        // Action-swap attribution (M4A debt (a)): best-effort, never blocks the swap row. Matching
        // runs at apply time, so an InstanceRegistered earlier in this chunk is already visible.
        const from = this.db.swapSenderResolved(txHash, l.logIndex) ? null : await txFromOf(txHash, l.logIndex);
        const agentIsCurrency0 = pool.agentIsCurrency0;
        ops.push(() => {
          this.db.insertSwap(swap);
          if (from !== null) this.attributeSwap({ ...swap, agentIsCurrency0 }, from);
        });
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
        else if (role?.stack != null && stackForAgent(stacks, id) !== role.stack) {
          // R2 disjoint ranges violated (a stack issued an id inside another stack's range): per-agent
          // reads route by id, so this agent's contract reads may hit the wrong stack.
          this.log.warn(`STACK ID RANGE VIOLATION: ${role.name} of stack v${role.stack.version} emitted ${d.eventName} for agent ${id} outside its id range (tx ${txHash})`);
        }
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
              buybackLeg: String(a.floorLeg), // db column keeps its v1 name (SPEC-M4G §3); API: platformLeg
              treasuryLeg: String(a.treasuryLeg),
              royaltyLeg: String(a.royaltyLeg),
              converted: String(a.converted),
              ts: t,
            };
            ops.push(() => void this.db.insertFee(fee));
          }
          ops.push(event(pool?.agentId ?? null, "distributed", t, { poolId, platformLeg: a.floorLeg, treasuryLeg: a.treasuryLeg, royaltyLeg: a.royaltyLeg, converted: a.converted }));
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
        case "vault.Redeemed": {
          // Platform-wide (D18): no agent.
          const row = { ...base, kind: "redeem" as const, account: getAddress(String(a.redeemer)), usdg: String(a.usdgPaid), tokens: String(a.tokensBurned), agentId: null, ts: await ts(l.blockNumber) };
          ops.push(() => void this.db.upsertFloorFlow(row));
          break;
        }
        case "vault.StrayBurned": {
          const row = { ...base, kind: "stray_burn" as const, account: getAddress(String(a.caller)), usdg: "0", tokens: String(a.amount), agentId: null, ts: await ts(l.blockNumber) };
          ops.push(() => void this.db.upsertFloorFlow(row));
          break;
        }
        case "nft.Transfer": {
          const id = idArg("tokenId");
          if (id === null) break;
          ops.push(event(id, "nft_transfer", await ts(l.blockNumber), { from: a.from, to: a.to }));
          // SPEC-M4E §2: re-derive the current owner from the stored transfers (idempotent, order-independent).
          ops.push(() => this.db.refreshNftOwner(id));
          break;
        }
        default:
          break;
      }
    }
    return ops;
  }
}
