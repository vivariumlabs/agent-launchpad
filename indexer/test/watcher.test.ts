import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import {
  agentFactoryAbi,
  agentNftAbi,
  agentRegistryAbi,
  bondingCurveAbi,
  feeSplitHookAbi,
  poolManagerAbi,
  royaltyDistributorAbi,
  treasuryBuybackAbi,
} from "../src/abi.js";
import { BalanceRefresher } from "../src/balances.js";
import { IndexerDb } from "../src/db.js";
import { memoryLogger } from "../src/log.js";
import { CURSOR_KEY, HEAD_KEY, isRangeError, REVIVAL_WINDOW_KEY, Watcher } from "../src/watcher.js";
import { ADDR, BASE_TS, contracts, fixedClock, MockChain, mkLog, ZERO } from "./helpers/mockChain.js";

const T2: Address = getAddress("0x2000000000000000000000000000000000000002"); // < USDG ⇒ currency0
const C2: Address = getAddress("0xc200000000000000000000000000000000000002");
const T7: Address = getAddress("0x9000000000000000000000000000000000000007"); // > USDG ⇒ currency1
const C7: Address = getAddress("0xc700000000000000000000000000000000000007");
const TREAS: Address = getAddress("0xaa00000000000000000000000000000000000001");
const ACTION: Address = getAddress("0xbb00000000000000000000000000000000000001");
const CREATOR: Address = getAddress("0xcc00000000000000000000000000000000000001");
const P2 = `0x${"2".repeat(64)}` as Hex;
const P7 = `0x${"7".repeat(64)}` as Hex;
const FOREIGN = `0x${"f".repeat(64)}` as Hex;
const CODE = `0x${"c0de".repeat(16)}` as Hex;
const CFG = `0x${"ab".repeat(32)}` as Hex;

function setup(startBlock = 100n) {
  const chain = new MockChain();
  const db = new IndexerDb(":memory:");
  const log = memoryLogger();
  const clock = fixedClock(BASE_TS + 2000n);
  const w = new Watcher(db, chain, { contracts: contracts(startBlock), reorgWindowBlocks: 30, maxBlockRange: 10_000 }, clock, log);
  return { chain, db, log, clock, w };
}

function scenario(chain: MockChain): void {
  chain.pending.set(2n, { creator: CREATOR, configHash: CFG, imageURI: "ar://img2", name: "Two", symbol: "TWO", genesisDeadline: 9n, feePaid: true });
  chain.instances.set(2n, { treasuryEOA: TREAS, actionEOA: ACTION, codeHash: CODE, attestationRef: "attRef2", lastHeartbeat: BASE_TS + 130n, generation: 1 });
  chain.tokens.set(T2.toLowerCase(), { name: "Two Token", symbol: "TWO", totalSupply: 1_000_000_000n * 10n ** 18n });
  chain.tokens.set(T7.toLowerCase(), { name: "Seven", symbol: "AGENT1", totalSupply: 1_000_000_000n * 10n ** 18n });
  chain.uris.set(2n, "ar://img2");
  const L = chain.logs;
  L.push(mkLog(agentFactoryAbi, "AgentRequested", { agentId: 2n, configHash: CFG, creator: CREATOR }, { address: ADDR.factory, blockNumber: 110n, logIndex: 1 }));
  L.push(mkLog(agentRegistryAbi, "GenesisOpened", { agentId: 2n, deadline: 999n }, { address: ADDR.registry, blockNumber: 110n, logIndex: 0 }));
  L.push(mkLog(agentFactoryAbi, "AgentRequested", { agentId: 3n, configHash: CFG, creator: CREATOR }, { address: ADDR.factory, blockNumber: 111n, logIndex: 0 }));
  L.push(
    mkLog(agentRegistryAbi, "InstanceRegistered", { agentId: 2n, treasuryEOA: TREAS, actionEOA: ACTION, codeHash: CODE, generation: 1 }, { address: ADDR.registry, blockNumber: 120n, logIndex: 0 }),
  );
  L.push(mkLog(agentRegistryAbi, "Heartbeat", { agentId: 2n, timestamp: BASE_TS + 130n }, { address: ADDR.registry, blockNumber: 130n, logIndex: 0 }));
  L.push(mkLog(agentFactoryAbi, "AgentLive", { agentId: 2n, token: T2, curve: C2 }, { address: ADDR.factory, blockNumber: 140n, logIndex: 5 }));
  L.push(mkLog(agentNftAbi, "Transfer", { from: ZERO, to: CREATOR, tokenId: 2n }, { address: ADDR.nft, blockNumber: 140n, logIndex: 3 }));
  // A curve trade in the SAME chunk as AgentLive (the curve address is not in the chunk's first query).
  L.push(mkLog(bondingCurveAbi, "Bought", { buyer: CREATOR, usdgIn: 1_000_000n, tokensOut: 2_000_000n * 10n ** 18n, fee: 10_000n }, { address: C2, blockNumber: 150n, logIndex: 0 }));
  L.push(mkLog(feeSplitHookAbi, "PoolRegistered", { poolId: P2, agentId: 2n, agentToken: T2 }, { address: ADDR.hook, blockNumber: 160n, logIndex: 0 }));
  L.push(
    mkLog(
      poolManagerAbi,
      "Swap",
      { id: P2, sender: CREATOR, amount0: -2_204_007n * 10n ** 15n, amount1: 1_000_000n, sqrtPriceX96: 1771595571142957102961n, liquidity: 5n, tick: -1, fee: 30_000 },
      { address: ADDR.poolManager, blockNumber: 170n, logIndex: 1 },
    ),
  );
  L.push(
    mkLog(poolManagerAbi, "Swap", { id: FOREIGN, sender: CREATOR, amount0: 1n, amount1: -1n, sqrtPriceX96: 1n << 96n, liquidity: 1n, tick: 0, fee: 3000 }, { address: ADDR.poolManager, blockNumber: 170n, logIndex: 2 }),
  );
  L.push(mkLog(feeSplitHookAbi, "FeeCollected", { poolId: P2, currency: ADDR.usdg, amount: 30_000n }, { address: ADDR.hook, blockNumber: 170n, logIndex: 3 }));
  L.push(mkLog(feeSplitHookAbi, "Distributed", { poolId: P2, buybackLeg: 10n, treasuryLeg: 10n, royaltyLeg: 10n, converted: 4n }, { address: ADDR.hook, blockNumber: 180n, logIndex: 0 }));
  L.push(mkLog(royaltyDistributorAbi, "Credited", { agentId: 2n, amount: 10n }, { address: ADDR.distributor, blockNumber: 180n, logIndex: 1 }));
  L.push(mkLog(treasuryBuybackAbi, "Poked", { caller: CREATOR, usdgIn: 5n, tokensBurned: 6n, callerReward: 1n }, { address: ADDR.treasuryBuyback, blockNumber: 185n, logIndex: 0 }));
  L.push(mkLog(agentFactoryAbi, "AgentCancelled", { agentId: 3n }, { address: ADDR.factory, blockNumber: 190n, logIndex: 0 }));
}

describe("watcher: event batch → rows", () => {
  it("ingests every tracked event with its agentId, in (block, logIndex) order", async () => {
    const { chain, db, w } = setup();
    scenario(chain);
    await w.poll();

    expect(db.agent(2)).toMatchObject({
      state: "live",
      name: "Two",
      symbol: "TWO",
      imageURI: "ar://img2",
      creator: CREATOR,
      configHash: CFG,
      token: T2,
      curve: C2,
      poolId: P2,
      totalSupply: (1_000_000_000n * 10n ** 18n).toString(),
      requestBlock: 110,
      createdAt: Number(BASE_TS + 110n),
    });
    expect(db.agent(3)?.state).toBe("cancelled");
    expect(db.instance(2)).toMatchObject({ treasuryEOA: TREAS, actionEOA: ACTION, codeHash: CODE, attestationRef: "attRef2", generation: 1, lastHeartbeat: Number(BASE_TS + 130n) });
    expect(db.pools()).toEqual([{ poolId: P2, agentId: 2, agentToken: T2, agentIsCurrency0: 1 }]);

    const swaps = db.swapsSince(2, 0);
    expect(swaps).toHaveLength(1); // the foreign-pool swap is ignored
    expect(swaps[0]).toMatchObject({ poolId: P2, amount0: (-2_204_007n * 10n ** 15n).toString(), amount1: "1000000", sqrtPriceX96: "1771595571142957102961" });
    expect(db.latestCurveTrade(2)).toMatchObject({ side: "buy", usdg: "1000000", tokens: (2_000_000n * 10n ** 18n).toString(), fee: "10000", trader: CREATOR });
    expect(db.fees(2)).toEqual([expect.objectContaining({ buybackLeg: "10", treasuryLeg: "10", royaltyLeg: "10", converted: "4", poolId: P2 })]);

    const kinds = db.activity(2, 200).map((e) => e.kind).reverse();
    expect(kinds).toEqual([
      "genesis_opened",
      "requested",
      "registered",
      "heartbeat",
      "nft_transfer",
      "live",
      "curve_buy",
      "pool_registered",
      "swap",
      "fee_collected",
      "distributed",
      "royalty_credited",
    ]);
    const swapEv = db.activity(2, 200).find((e) => e.kind === "swap")!;
    expect(JSON.parse(swapEv.data)).toMatchObject({ amount1: "1000000", sqrtPriceX96: "1771595571142957102961", agentIsCurrency0: true });
    expect(db.counts().events).toBe(12 + 2 /* agent 3 */ + 1 /* poked, agentId null */);
    expect(db.kvGet(CURSOR_KEY)).toBe("1001");
    expect(db.kvGet(HEAD_KEY)).toBe("1000");
    expect(db.kvGet(REVIVAL_WINDOW_KEY)).toBe("604800");

    // The AgentLive chunk was re-queried for the newly born curve only.
    expect(chain.getLogsCalls).toHaveLength(2);
    expect(chain.getLogsCalls[1]).toEqual({ addresses: [C2.toLowerCase()], from: 100n, to: 1000n });
  });

  it("curve address → agentId resolution survives across polls (curve joins the address set)", async () => {
    const { chain, db, w } = setup();
    scenario(chain);
    await w.poll();
    chain.head = 1100n;
    chain.logs.push(mkLog(bondingCurveAbi, "Sold", { seller: CREATOR, tokensIn: 10n ** 18n, usdgOut: 400n, fee: 4n }, { address: C2, blockNumber: 1050n, logIndex: 0 }));
    await w.poll();
    expect(chain.getLogsCalls.at(-1)!.addresses).toContain(C2.toLowerCase());
    expect(db.latestCurveTrade(2)).toMatchObject({ side: "sell", usdg: "400", tokens: (10n ** 18n).toString() });
  });

  it("agent token as currency1 is recorded per pool; name/symbol/image fall back to the token + NFT at AgentLive", async () => {
    const { chain, db, w } = setup();
    // Finalized before the indexer saw the request: pendingAgent is the zero struct.
    chain.uris.set(7n, "ar://img7");
    chain.tokens.set(T7.toLowerCase(), { name: "Seven", symbol: "AGENT1", totalSupply: 5n });
    chain.logs.push(mkLog(agentFactoryAbi, "AgentRequested", { agentId: 7n, configHash: CFG, creator: CREATOR }, { address: ADDR.factory, blockNumber: 200n, logIndex: 0 }));
    chain.logs.push(mkLog(agentFactoryAbi, "AgentLive", { agentId: 7n, token: T7, curve: C7 }, { address: ADDR.factory, blockNumber: 201n, logIndex: 0 }));
    chain.logs.push(mkLog(agentFactoryAbi, "AgentGraduated", { agentId: 7n, poolUsdg: 1n, poolTokens: 2n, burned: 3n }, { address: ADDR.factory, blockNumber: 202n, logIndex: 0 }));
    chain.logs.push(mkLog(feeSplitHookAbi, "PoolRegistered", { poolId: P7, agentId: 7n, agentToken: T7 }, { address: ADDR.hook, blockNumber: 203n, logIndex: 0 }));
    await w.poll();
    expect(db.agent(7)).toMatchObject({ state: "graduated", name: "Seven", symbol: "AGENT1", imageURI: "ar://img7", totalSupply: "5", poolId: P7 });
    expect(db.pool(P7)?.agentIsCurrency0).toBe(0);
  });

  it("ignores an out-of-range agentId loudly", async () => {
    const { chain, db, w, log } = setup();
    chain.logs.push(mkLog(agentFactoryAbi, "AgentCancelled", { agentId: 2n ** 60n }, { address: ADDR.factory, blockNumber: 150n, logIndex: 0 }));
    await w.poll();
    expect(db.counts().agents).toBe(0);
    expect(log.lines.some((l) => l.startsWith("ERROR") && l.includes("out-of-range"))).toBe(true);
  });
});

describe("watcher: cursor, backfill chunks, reorg re-scan", () => {
  it("backfills from startBlock in maxBlockRange chunks and commits the cursor per chunk", async () => {
    const { chain, db, w } = setup(100n);
    chain.head = 25_099n;
    await w.poll();
    expect(chain.getLogsCalls.map((c) => [c.from, c.to])).toEqual([
      [100n, 10_099n],
      [10_100n, 20_099n],
      [20_100n, 25_099n],
    ]);
    expect(db.kvGet(CURSOR_KEY)).toBe("25100");
  });

  it("each poll re-scans the trailing 30 blocks; re-ingest is idempotent", async () => {
    const { chain, db, w } = setup();
    scenario(chain);
    chain.logs.push(mkLog(agentRegistryAbi, "Heartbeat", { agentId: 2n, timestamp: BASE_TS + 990n }, { address: ADDR.registry, blockNumber: 990n, logIndex: 0 }));
    await w.poll();
    const before = db.counts();
    chain.head = 1005n;
    chain.getLogsCalls = [];
    await w.poll();
    expect(chain.getLogsCalls[0]).toMatchObject({ from: 971n, to: 1005n });
    expect(db.counts()).toEqual(before);
    expect(db.instance(2)?.lastHeartbeat).toBe(Number(BASE_TS + 990n));
    expect(db.kvGet(CURSOR_KEY)).toBe("1006");
  });

  it("a new Watcher on the same db resumes from the stored cursor (minus the window)", async () => {
    const first = setup();
    first.chain.head = 500n;
    await first.w.poll();
    const chain2 = new MockChain();
    chain2.head = 600n;
    const w2 = new Watcher(first.db, chain2, { contracts: contracts(100n), reorgWindowBlocks: 30, maxBlockRange: 10_000 }, first.clock, memoryLogger());
    expect(w2.cursor()).toBe(501n);
    await w2.poll();
    expect(chain2.getLogsCalls[0]).toMatchObject({ from: 471n, to: 600n });
  });

  it("never lets the window reach below startBlock", async () => {
    const { chain, w } = setup(100n);
    chain.head = 110n;
    await w.poll();
    chain.head = 115n;
    await w.poll();
    expect(chain.getLogsCalls.map((c) => c.from)).toEqual([100n, 100n]);
  });
});

describe("watcher: failures never escape the loop", () => {
  it("pollSafe warns LOUDLY, backs off, keeps the last committed chunk, and recovers", async () => {
    const { chain, db, w, log } = setup(100n);
    chain.head = 25_099n;
    chain.failFrom.add(10_100n);
    const delay = await w.pollSafe(3000);
    expect(delay).toBe(6000);
    expect(log.lines.some((l) => l.startsWith("WARN WATCHER POLL FAILED"))).toBe(true);
    expect(db.kvGet(CURSOR_KEY)).toBe("10100"); // chunk 1 committed, chunk 2 not

    chain.failGetLogs = 1;
    expect(await w.pollSafe(3000)).toBe(12_000); // consecutive failure ⇒ longer backoff
    expect(await w.pollSafe(3000)).toBe(3000);
    expect(db.kvGet(CURSOR_KEY)).toBe("25100");
  });

  it("a failing RPC read inside a chunk aborts the whole chunk (no partial rows)", async () => {
    const { chain, db, w } = setup();
    chain.logs.push(mkLog(agentFactoryAbi, "AgentRequested", { agentId: 4n, configHash: CFG, creator: CREATOR }, { address: ADDR.factory, blockNumber: 150n, logIndex: 0 }));
    chain.logs.push(mkLog(agentFactoryAbi, "AgentLive", { agentId: 4n, token: T2, curve: C2 }, { address: ADDR.factory, blockNumber: 151n, logIndex: 0 })); // token unknown to the mock ⇒ throws
    expect(await w.pollSafe(1000)).toBeGreaterThan(1000);
    expect(db.counts().agents).toBe(0);
    expect(db.kvGet(CURSOR_KEY)).toBeUndefined();
  });
});

describe("watcher: getLogs chunk halving on RPC range errors", () => {
  const size = (c: { from: bigint; to: bigint }): bigint => c.to - c.from + 1n;

  it("halves the chunk for the retry of the same range, resets to maxBlockRange after each success", async () => {
    const { chain, db, w, log } = setup(100n);
    chain.head = 7_599n;
    chain.rangeLimit = 3_000n;
    await w.poll();
    expect(chain.getLogsCalls.map((c) => [c.from, size(c)])).toEqual([
      [100n, 7_500n], // clipped at head: fails
      [100n, 5_000n], // halved from 10k: fails
      [100n, 2_500n], // ok
      [2_600n, 5_000n], // reset to 10k (clipped at head: 5000): fails
      [2_600n, 5_000n], // halved 10k → 5000: fails again
      [2_600n, 2_500n], // ok
      [5_100n, 2_500n], // reset (clipped at head): ok
    ]);
    expect(db.kvGet(CURSOR_KEY)).toBe("7600");
    expect(log.lines.filter((l) => l.includes("getLogs range error"))).toHaveLength(4);
  });

  it("stops halving at the 100-block floor and lets the error reach pollSafe (cursor unchanged)", async () => {
    const { chain, db, w, log } = setup(100n);
    chain.head = 25_099n;
    chain.rangeLimit = 50n;
    expect(await w.pollSafe(3000)).toBe(6000);
    expect(chain.getLogsCalls.map(size)).toEqual([10_000n, 5_000n, 2_500n, 1_250n, 625n, 312n, 156n, 100n]);
    expect(log.lines.some((l) => l.startsWith("WARN WATCHER POLL FAILED") && l.includes("block range too large"))).toBe(true);
    expect(db.kvGet(CURSOR_KEY)).toBeUndefined();
  });

  it("a non-range getLogs error does not halve", async () => {
    const { chain, w } = setup(100n);
    chain.head = 25_099n;
    chain.failGetLogs = 1;
    await w.pollSafe(3000);
    expect(chain.getLogsCalls.map(size)).toEqual([10_000n]);
  });

  it("recognises range errors in nested causes / viem details", () => {
    expect(isRangeError(new Error("query returned more than 10000 results"))).toBe(true);
    expect(isRangeError({ message: "RPC Request failed.", details: "exceed maximum block range: 5000", cause: undefined })).toBe(true);
    expect(isRangeError(new Error("outer", { cause: new Error("Log response size exceeded.") }))).toBe(true);
    expect(isRangeError(new Error("HTTP request failed. Status: 503"))).toBe(false);
  });
});

describe("balance refresh", () => {
  it("reads treasury/action USDG + native + action agent token and reconciles the instance", async () => {
    const { chain, db, w, clock } = setup();
    scenario(chain);
    await w.poll();
    chain.erc20.set(`${ADDR.usdg.toLowerCase()}:${TREAS.toLowerCase()}`, 12_345_678n);
    chain.erc20.set(`${ADDR.usdg.toLowerCase()}:${ACTION.toLowerCase()}`, 4_275_000n);
    chain.erc20.set(`${T2.toLowerCase()}:${ACTION.toLowerCase()}`, 2_204_007n * 10n ** 15n);
    chain.native.set(TREAS.toLowerCase(), 10n ** 15n);
    chain.native.set(ACTION.toLowerCase(), 2n * 10n ** 15n);
    chain.instances.set(2n, { treasuryEOA: TREAS, actionEOA: ACTION, codeHash: CODE, attestationRef: "attRef2", lastHeartbeat: BASE_TS + 1500n, generation: 1 });
    const r = new BalanceRefresher(db, chain, ADDR.usdg, clock, memoryLogger());
    expect(await r.refreshAll()).toBe(1); // agent 3 has no instance
    expect(db.balances(2)).toEqual({
      agentId: 2,
      treasuryUsdg: "12345678",
      treasuryRhEth: (10n ** 15n).toString(),
      actionUsdg: "4275000",
      actionRhEth: (2n * 10n ** 15n).toString(),
      actionToken: (2_204_007n * 10n ** 15n).toString(),
      updatedAt: Number(clock.now()),
    });
    expect(db.instance(2)?.lastHeartbeat).toBe(Number(BASE_TS + 1500n));
    expect(db.balances(3)).toBeUndefined();
  });
});
