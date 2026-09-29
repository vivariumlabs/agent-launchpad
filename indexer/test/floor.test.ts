// SPEC-M4G §3 — dual-stack watcher (disjoint agents from both factories, curve discovery per
// factory), floor-vault inflow classification (hook / curve / donation) + Redeemed / StrayBurned,
// floor_flows reorg idempotency, stack-coverage warning, floor refresher, GET /api/floor golden
// (incl. S = 0), the agent `stack` field, platformLeg, and migration v5 → v6.

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { agentFactoryAbi, agentNftAbi, agentRegistryAbi, bondingCurveAbi, erc20Abi, feeSplitHookAbi, floorVaultAbi } from "../src/abi.js";
import { IndexerApi, type AgentView, type FloorView } from "../src/api.js";
import { IndexerDb, MIGRATIONS, type FloorFlowRow } from "../src/db.js";
import { floorPriceX18 } from "../src/derive.js";
import { FLOOR_KV, FloorRefresher } from "../src/floor.js";
import { memoryLogger } from "../src/log.js";
import { CURSOR_KEY, STACKS_COVERED_KEY, Watcher } from "../src/watcher.js";
import { ADDR, ADDR2, BASE_TS, dualContracts, fixedClock, MockChain, mkLog, stackV1, stackV2, txHash, ZERO } from "./helpers/mockChain.js";

const CREATOR: Address = getAddress("0xcc00000000000000000000000000000000000001");
const DONOR: Address = getAddress("0xd000000000000000000000000000000000000001");
const REDEEMER: Address = getAddress("0xe000000000000000000000000000000000000001");
const TREAS: Address = getAddress("0xaa00000000000000000000000000000000000101");
const ACTION: Address = getAddress("0xbb00000000000000000000000000000000000101");
const T2: Address = getAddress("0x2200000000000000000000000000000000000002");
const C2: Address = getAddress("0xc200000000000000000000000000000000000002");
const T101: Address = getAddress("0x3300000000000000000000000000000000000101");
const C101: Address = getAddress("0xc100000000000000000000000000000000000101");
const P101 = `0x${"a1".repeat(32)}` as Hex;
const P102 = `0x${"a2".repeat(32)}` as Hex;
const CFG = `0x${"ab".repeat(32)}` as Hex;
const CODE = `0x${"c0de".repeat(16)}` as Hex;
const NOW = Number(BASE_TS + 2000n);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(db = new IndexerDb(":memory:"), chain = new MockChain()) {
  const log = memoryLogger();
  const w = new Watcher(db, chain, { contracts: dualContracts(100n, 500n), reorgWindowBlocks: 30, maxBlockRange: 10_000 }, fixedClock(BASE_TS + 2000n), log);
  return { chain, db, log, w };
}

const usdgTo = (from: Address, to: Address, value: bigint, blockNumber: bigint, logIndex: number, tx?: Hex) =>
  mkLog(erc20Abi, "Transfer", { from, to, value }, { address: ADDR.usdg, blockNumber, logIndex, ...(tx === undefined ? {} : { transactionHash: tx }) });

/** v1 agent 2 (legacy factory) + v2 agent 101 (primary factory) + every kind of vault flow. */
function scenario(chain: MockChain): { distTx: Hex; curveTx: Hex } {
  chain.pending.set(2n, { creator: CREATOR, configHash: CFG, imageURI: "ar://2", name: "Two", symbol: "TWO", genesisDeadline: 9n, feePaid: true });
  chain.pending.set(101n, { creator: CREATOR, configHash: CFG, imageURI: "ar://101", name: "Hundred One", symbol: "H101", genesisDeadline: 9n, feePaid: true });
  chain.tokens.set(T2.toLowerCase(), { name: "Two", symbol: "TWO", totalSupply: 10n ** 27n });
  chain.tokens.set(T101.toLowerCase(), { name: "Hundred One", symbol: "H101", totalSupply: 10n ** 27n });
  const L = chain.logs;
  // v1 (legacy) stack.
  L.push(mkLog(agentFactoryAbi, "AgentRequested", { agentId: 2n, configHash: CFG, creator: CREATOR }, { address: ADDR.factory, blockNumber: 110n, logIndex: 0 }));
  L.push(mkLog(agentFactoryAbi, "AgentLive", { agentId: 2n, token: T2, curve: C2 }, { address: ADDR.factory, blockNumber: 120n, logIndex: 0 }));
  L.push(mkLog(agentNftAbi, "Transfer", { from: ZERO, to: CREATOR, tokenId: 2n }, { address: ADDR.nft, blockNumber: 120n, logIndex: 1 }));
  L.push(mkLog(bondingCurveAbi, "Bought", { buyer: CREATOR, usdgIn: 1_000_000n, tokensOut: 10n ** 18n, fee: 10_000n }, { address: C2, blockNumber: 130n, logIndex: 0 }));
  // A (hypothetical) v1-curve USDG transfer to the vault is not a v2 curve fee ⇒ donation.
  L.push(usdgTo(C2, ADDR2.floorVault, 7n, 130n, 1));
  // v2 (primary) stack.
  L.push(mkLog(agentFactoryAbi, "AgentRequested", { agentId: 101n, configHash: CFG, creator: CREATOR }, { address: ADDR2.factory, blockNumber: 510n, logIndex: 1 }));
  L.push(mkLog(agentRegistryAbi, "GenesisOpened", { agentId: 101n, deadline: 999n }, { address: ADDR2.registry, blockNumber: 510n, logIndex: 0 }));
  L.push(mkLog(agentRegistryAbi, "InstanceRegistered", { agentId: 101n, treasuryEOA: TREAS, actionEOA: ACTION, codeHash: CODE, generation: 1 }, { address: ADDR2.registry, blockNumber: 515n, logIndex: 0 }));
  L.push(mkLog(agentFactoryAbi, "AgentLive", { agentId: 101n, token: T101, curve: C101 }, { address: ADDR2.factory, blockNumber: 520n, logIndex: 2 }));
  L.push(mkLog(agentNftAbi, "Transfer", { from: ZERO, to: CREATOR, tokenId: 101n }, { address: ADDR2.nft, blockNumber: 520n, logIndex: 1 }));
  const curveTx = txHash();
  L.push(mkLog(bondingCurveAbi, "Bought", { buyer: CREATOR, usdgIn: 3_000_000n, tokensOut: 10n ** 18n, fee: 30_000n }, { address: C101, blockNumber: 530n, logIndex: 0, transactionHash: curveTx }));
  L.push(usdgTo(C101, ADDR2.floorVault, 10_000n, 530n, 1, curveTx)); // curve fee third → vault
  L.push(mkLog(feeSplitHookAbi, "PoolRegistered", { poolId: P101, agentId: 101n, agentToken: T101 }, { address: ADDR2.hook, blockNumber: 540n, logIndex: 0 }));
  const distTx = txHash();
  L.push(usdgTo(ADDR2.hook, ADDR2.floorVault, 20_000n, 550n, 0, distTx)); // hook floor leg precedes Distributed
  L.push(mkLog(feeSplitHookAbi, "Distributed", { poolId: P101, floorLeg: 20_000n, treasuryLeg: 20_000n, royaltyLeg: 20_000n, converted: 0n }, { address: ADDR2.hook, blockNumber: 550n, logIndex: 1, transactionHash: distTx }));
  L.push(usdgTo(DONOR, ADDR2.floorVault, 1_000_000n, 560n, 0)); // donation
  L.push(usdgTo(DONOR, CREATOR, 5n, 560n, 1)); // not to the vault ⇒ never fetched
  L.push(mkLog(floorVaultAbi, "Redeemed", { redeemer: REDEEMER, tokensBurned: 5n * 10n ** 18n, usdgPaid: 5_000n }, { address: ADDR2.floorVault, blockNumber: 570n, logIndex: 0 }));
  L.push(mkLog(floorVaultAbi, "StrayBurned", { caller: DONOR, amount: 2n * 10n ** 18n }, { address: ADDR2.floorVault, blockNumber: 580n, logIndex: 0 }));
  return { distTx, curveTx };
}

const flows = (db: IndexerDb) => db.floorFlows(100).map((f) => [f.blockNumber, f.kind, f.account, f.usdg, f.tokens, f.agentId]);

describe("M4G §3 watcher over two stacks", () => {
  it("disjoint agents from both factories land; curves are discovered per factory; roles cover both stacks + the vault, never the buyback", async () => {
    const { chain, db, w, log } = setup();
    scenario(chain);
    await w.poll();

    expect(db.agent(2)).toMatchObject({ state: "live", name: "Two", token: T2, curve: C2 });
    expect(db.agent(101)).toMatchObject({ state: "live", name: "Hundred One", symbol: "H101", token: T101, curve: C101, poolId: P101 });
    expect(db.instance(101)).toMatchObject({ treasuryEOA: TREAS, actionEOA: ACTION, generation: 1 });
    expect(db.nftOwner(2)?.owner).toBe(CREATOR.toLowerCase());
    expect(db.nftOwner(101)?.owner).toBe(CREATOR.toLowerCase());
    expect(db.latestCurveTrade(2)).toMatchObject({ usdg: "1000000" });
    expect(db.latestCurveTrade(101)).toMatchObject({ usdg: "3000000" });
    expect(db.fees(101)).toEqual([expect.objectContaining({ buybackLeg: "20000", poolId: P101 })]);
    expect(db.activity(101, 50).map((e) => e.kind).reverse()).toEqual(["genesis_opened", "requested", "registered", "nft_transfer", "live", "curve_buy", "pool_registered", "distributed"]);

    const first = chain.getLogsCalls[0]!;
    const expected = [ADDR.factory, ADDR.registry, ADDR.hook, ADDR.distributor, ADDR.nft, ADDR2.factory, ADDR2.registry, ADDR2.hook, ADDR2.distributor, ADDR2.nft, ADDR.poolManager, ADDR2.floorVault];
    expect([...first.addresses].sort()).toEqual(expected.map((a) => a.toLowerCase()).sort());
    expect(first).toMatchObject({ from: 100n, to: 1000n }); // scan start = min(startBlock)
    expect(chain.getLogsCalls[1]!.addresses.sort()).toEqual([C2.toLowerCase(), C101.toLowerCase()].sort()); // AgentLive from BOTH factories
    expect(chain.transferCalls).toEqual([{ token: ADDR.usdg.toLowerCase(), to: ADDR2.floorVault.toLowerCase(), from: 100n, toBlock: 1000n }]);
    expect(log.lines.filter((l) => l.startsWith("WARN"))).toEqual([]);
    expect(JSON.parse(db.kvGet(STACKS_COVERED_KEY)!)).toEqual([ADDR.factory.toLowerCase(), ADDR2.factory.toLowerCase()].sort());
  });

  it("inflow classification: any stack's hook ⇒ fee_pool (agent via the same-tx Distributed), a v2 curve ⇒ fee_curve, else donation; Redeemed / StrayBurned rows", async () => {
    const { chain, db, w } = setup();
    scenario(chain);
    await w.poll();
    expect(flows(db).reverse()).toEqual([
      [130, "donation", C2, "7", "0", null], // v1 curve: not a v2 curve fee
      [530, "fee_curve", C101, "10000", "0", 101],
      [550, "fee_pool", ADDR2.hook, "20000", "0", 101],
      [560, "donation", DONOR, "1000000", "0", null],
      [570, "redeem", REDEEMER, "5000", (5n * 10n ** 18n).toString(), null],
      [580, "stray_burn", DONOR, "0", (2n * 10n ** 18n).toString(), null],
    ]);
    expect(db.floorTotals()).toEqual({ feePool: 20_000n, feeCurve: 10_000n, donations: 1_000_007n, redeemedUsdg: 5_000n, burnedTokens: 5n * 10n ** 18n, strayBurned: 2n * 10n ** 18n, redemptions: 1 });
  });

  it("fee_pool: several Distributed in one tx resolve by floorLeg; an ambiguous / missing Distributed leaves agentId null; the legacy hook also counts as fee_pool", async () => {
    const { chain, db, w } = setup();
    chain.logs.push(mkLog(feeSplitHookAbi, "PoolRegistered", { poolId: P101, agentId: 101n, agentToken: T101 }, { address: ADDR2.hook, blockNumber: 600n, logIndex: 0 }));
    chain.logs.push(mkLog(feeSplitHookAbi, "PoolRegistered", { poolId: P102, agentId: 102n, agentToken: T101 }, { address: ADDR2.hook, blockNumber: 600n, logIndex: 1 }));
    const tx = txHash();
    chain.logs.push(usdgTo(ADDR2.hook, ADDR2.floorVault, 11n, 610n, 0, tx));
    chain.logs.push(mkLog(feeSplitHookAbi, "Distributed", { poolId: P101, floorLeg: 11n, treasuryLeg: 11n, royaltyLeg: 11n, converted: 0n }, { address: ADDR2.hook, blockNumber: 610n, logIndex: 1, transactionHash: tx }));
    chain.logs.push(usdgTo(ADDR2.hook, ADDR2.floorVault, 22n, 610n, 2, tx));
    chain.logs.push(mkLog(feeSplitHookAbi, "Distributed", { poolId: P102, floorLeg: 22n, treasuryLeg: 22n, royaltyLeg: 22n, converted: 0n }, { address: ADDR2.hook, blockNumber: 610n, logIndex: 3, transactionHash: tx }));
    const amb = txHash();
    chain.logs.push(usdgTo(ADDR2.hook, ADDR2.floorVault, 5n, 620n, 0, amb));
    chain.logs.push(mkLog(feeSplitHookAbi, "Distributed", { poolId: P101, floorLeg: 5n, treasuryLeg: 5n, royaltyLeg: 5n, converted: 0n }, { address: ADDR2.hook, blockNumber: 620n, logIndex: 1, transactionHash: amb }));
    chain.logs.push(mkLog(feeSplitHookAbi, "Distributed", { poolId: P102, floorLeg: 5n, treasuryLeg: 5n, royaltyLeg: 5n, converted: 0n }, { address: ADDR2.hook, blockNumber: 620n, logIndex: 2, transactionHash: amb }));
    chain.logs.push(usdgTo(ADDR2.hook, ADDR2.floorVault, 9n, 630n, 0)); // no Distributed in the tx
    chain.logs.push(usdgTo(ADDR.hook, ADDR2.floorVault, 3n, 640n, 0)); // the legacy stack's hook
    await w.poll();
    expect(flows(db).reverse()).toEqual([
      [610, "fee_pool", ADDR2.hook, "11", "0", 101],
      [610, "fee_pool", ADDR2.hook, "22", "0", 102],
      [620, "fee_pool", ADDR2.hook, "5", "0", null],
      [630, "fee_pool", ADDR2.hook, "9", "0", null],
      [640, "fee_pool", ADDR.hook, "3", "0", null],
    ]);
  });

  it("reorg window re-scan and a full re-scan from startBlock are idempotent for floor_flows", async () => {
    const { chain, db, w } = setup();
    scenario(chain);
    chain.logs.push(usdgTo(DONOR, ADDR2.floorVault, 42n, 990n, 0)); // inside the trailing window
    await w.poll();
    const before = { counts: db.counts(), flows: flows(db), totals: db.floorTotals() };
    chain.head = 1005n;
    chain.transferCalls = [];
    await w.poll();
    expect(chain.transferCalls[0]).toMatchObject({ from: 971n, toBlock: 1005n });
    expect({ counts: db.counts(), flows: flows(db), totals: db.floorTotals() }).toEqual(before);
    // A second watcher replays everything from startBlock over the same db.
    db.kvSet(CURSOR_KEY, "100");
    const again = new Watcher(db, chain, { contracts: dualContracts(100n, 500n), reorgWindowBlocks: 30, maxBlockRange: 10_000 }, fixedClock(BASE_TS + 2000n), memoryLogger());
    await again.poll();
    expect({ counts: db.counts(), flows: flows(db), totals: db.floorTotals() }).toEqual(before);
  });

  it("the transfer getLogs shares the range-error halving", async () => {
    const { chain, db, w } = setup();
    chain.head = 3_099n;
    const orig = chain.getTransferLogsTo.bind(chain);
    let failed = false;
    chain.getTransferLogsTo = async (t, to, f, tb) => {
      if (!failed) {
        failed = true;
        throw new Error("query returned more than 10000 results");
      }
      return orig(t, to, f, tb);
    };
    await w.poll();
    expect(chain.getLogsCalls.map((c) => [c.from, c.to])).toEqual([
      [100n, 3_099n],
      [100n, 3_099n], // retried with a 5000-block chunk (clipped at head)
    ]);
    expect(db.kvGet(CURSOR_KEY)).toBe("3100");
  });

  it("an agentId outside the emitting stack's id range is warned LOUDLY (R2)", async () => {
    const { chain, w, log } = setup();
    chain.logs.push(mkLog(agentFactoryAbi, "AgentCancelled", { agentId: 150n }, { address: ADDR.factory, blockNumber: 150n, logIndex: 0 }));
    await w.poll();
    expect(log.lines.some((l) => l.startsWith("WARN STACK ID RANGE VIOLATION") && l.includes("agent 150"))).toBe(true);
  });
});

describe("M4G §3 stack coverage on an existing db", () => {
  it("a stack whose startBlock < cursor and whose factory was never seen ⇒ LOUD warning once (no rescan); a pre-M4G db's stack with agents counts as seen", async () => {
    const db = new IndexerDb(":memory:");
    db.kvSet(CURSOR_KEY, "2000"); // pre-M4G single-stack db, cursor past the v2 startBlock (500)
    db.advanceState(2, "live");
    const { w, log, chain } = setup(db);
    chain.head = 2010n;
    await w.poll();
    const warns = log.lines.filter((l) => l.includes("STACK NOT BACKFILLED"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(`factory ${ADDR2.factory}`);
    expect(warns[0]).toContain("startBlock 500 < cursor 2000");
    expect(chain.getLogsCalls[0]).toMatchObject({ from: 1970n }); // no auto-rescan
    chain.head = 2020n;
    await w.poll();
    expect(log.lines.filter((l) => l.includes("STACK NOT BACKFILLED"))).toHaveLength(1); // once per process
    expect(JSON.parse(db.kvGet(STACKS_COVERED_KEY)!)).toEqual([ADDR.factory.toLowerCase()]);
  });

  it("a stack deployed after the cursor is picked up with no warning and remembered across restarts", async () => {
    const db = new IndexerDb(":memory:");
    db.kvSet(CURSOR_KEY, "400"); // pre-M4G db, cursor below the v2 startBlock
    db.advanceState(2, "live");
    const first = setup(db);
    first.chain.head = 1000n;
    await first.w.poll();
    expect(first.log.lines.filter((l) => l.startsWith("WARN"))).toEqual([]);
    const second = setup(db);
    second.chain.head = 1100n;
    await second.w.poll();
    expect(second.log.lines.filter((l) => l.startsWith("WARN"))).toEqual([]);
    expect(JSON.parse(db.kvGet(STACKS_COVERED_KEY)!)).toEqual([ADDR.factory.toLowerCase(), ADDR2.factory.toLowerCase()].sort());
  });
});

describe("M4G §3 floor refresher", () => {
  it("reads vault USDG + token supply every pass, name/symbol/decimals once; a failure warns and keeps the last values", async () => {
    const chain = new MockChain();
    const db = new IndexerDb(":memory:");
    const log = memoryLogger();
    const clock = fixedClock(BASE_TS);
    chain.tokens.set(ADDR2.platformToken.toLowerCase(), { name: "Vivarium Test Platform Token", symbol: "tVIV", totalSupply: 10n ** 27n });
    chain.supplies.set(ADDR2.platformToken.toLowerCase(), 10n ** 27n);
    chain.erc20.set(`${ADDR.usdg.toLowerCase()}:${ADDR2.floorVault.toLowerCase()}`, 1_000_000n);
    const r = new FloorRefresher(db, chain, ADDR.usdg, { vault: ADDR2.floorVault, token: ADDR2.platformToken }, clock, log);
    expect(await r.refresh()).toBe(true);
    expect([FLOOR_KV.vaultUsdg, FLOOR_KV.totalSupply, FLOOR_KV.tokenName, FLOOR_KV.tokenSymbol, FLOOR_KV.tokenDecimals, FLOOR_KV.updatedAt].map((k) => db.kvGet(k))).toEqual([
      "1000000",
      (10n ** 27n).toString(),
      "Vivarium Test Platform Token",
      "tVIV",
      "18",
      BASE_TS.toString(),
    ]);
    chain.tokens.delete(ADDR2.platformToken.toLowerCase()); // metadata is not re-read
    chain.supplies.set(ADDR2.platformToken.toLowerCase(), 10n ** 27n - 5n * 10n ** 18n);
    clock.set(BASE_TS + 300n);
    expect(await r.refresh()).toBe(true);
    expect(db.kvGet(FLOOR_KV.totalSupply)).toBe((10n ** 27n - 5n * 10n ** 18n).toString());
    chain.failErc20 = true;
    clock.set(BASE_TS + 600n);
    expect(await r.refresh()).toBe(false);
    expect(log.lines.some((l) => l.startsWith("WARN FLOOR REFRESH FAILED"))).toBe(true);
    expect(db.kvGet(FLOOR_KV.updatedAt)).toBe((BASE_TS + 300n).toString());
  });
});

function floorApi(db: IndexerDb, withFloor = true): IndexerApi {
  return new IndexerApi(
    db,
    { now: () => BigInt(NOW) },
    {
      staleAfterSec: 1800,
      startBlock: 100n,
      gatewayUrl: "https://arweave.net",
      stacks: [stackV2(500n), stackV1(100n, true)],
      floor: withFloor ? { vault: ADDR2.floorVault, token: ADDR2.platformToken, usdg: ADDR.usdg } : null,
    },
    memoryLogger(),
  );
}

describe("M4G §3 GET /api/floor", () => {
  it("floorPriceX18 = B·1e36/S (floor), 0 at S = 0 — golden", () => {
    expect(floorPriceX18(1_000_000n, 10n ** 27n)).toBe(10n ** 15n); // 1 USDG over 1e9 tokens (contracts golden)
    expect(floorPriceX18(1_234_567n, 999_999_999n * 10n ** 18n)).toBe(1_234_567_001_234_567n);
    expect(floorPriceX18(3_000_000n, 10n ** 27n - 5n * 10n ** 18n)).toBe(3_000_000_015_000_000n);
    expect(floorPriceX18(1n, 10n ** 27n)).toBe(10n ** 9n); // 1 base unit of USDG still shows (tiny, not 0)
    expect(floorPriceX18(1n, 10n ** 36n + 1n)).toBe(0n); // floor rounding
    expect(floorPriceX18(5n, 0n)).toBe(0n);
    expect(floorPriceX18(0n, 10n ** 27n)).toBe(0n);
  });

  it("{enabled:false} without a vault; fresh (never refreshed) ⇒ zeros + updatedAt null", () => {
    const db = new IndexerDb(":memory:");
    expect(floorApi(db, false).route("/api/floor", new URLSearchParams())).toEqual({ enabled: false });
    expect(new IndexerApi(db, { now: () => BigInt(NOW) }, { staleAfterSec: 1800, startBlock: 1n, gatewayUrl: "https://arweave.net" }, memoryLogger()).route("/api/floor", new URLSearchParams())).toEqual({ enabled: false });
    expect(floorApi(db).route("/api/floor", new URLSearchParams())).toEqual({
      enabled: true,
      vault: ADDR2.floorVault,
      token: { address: ADDR2.platformToken, name: null, symbol: null, decimals: 18, totalSupply: "0" },
      usdg: ADDR.usdg,
      vaultUsdg: "0",
      floorPriceX18: "0",
      totals: { feePool: "0", feeCurve: "0", donations: "0", redeemedUsdg: "0", burnedTokens: "0", strayBurned: "0", redemptions: 0 },
      recent: [],
      updatedAt: null,
    });
  });

  it("golden body from ingested flows + refreshed kv; recent ≤ 50 newest first; S = 0 ⇒ floorPriceX18 \"0\"", async () => {
    const { chain, db, w } = setup();
    scenario(chain);
    await w.poll();
    db.kvSet(FLOOR_KV.vaultUsdg, "1025007");
    db.kvSet(FLOOR_KV.totalSupply, (10n ** 27n - 7n * 10n ** 18n).toString());
    db.kvSet(FLOOR_KV.tokenName, "Vivarium Test Platform Token");
    db.kvSet(FLOOR_KV.tokenSymbol, "tVIV");
    db.kvSet(FLOOR_KV.tokenDecimals, "18");
    db.kvSet(FLOOR_KV.updatedAt, String(NOW - 10));
    const body = floorApi(db).route("/api/floor", new URLSearchParams()) as Extract<FloorView, { enabled: true }>;
    expect(body).toMatchObject({
      enabled: true,
      vault: ADDR2.floorVault,
      token: { address: ADDR2.platformToken, name: "Vivarium Test Platform Token", symbol: "tVIV", decimals: 18, totalSupply: "999999993000000000000000000" },
      usdg: ADDR.usdg,
      vaultUsdg: "1025007",
      floorPriceX18: ((1_025_007n * 10n ** 36n) / (10n ** 27n - 7n * 10n ** 18n)).toString(),
      totals: { feePool: "20000", feeCurve: "10000", donations: "1000007", redeemedUsdg: "5000", burnedTokens: "5000000000000000000", strayBurned: "2000000000000000000", redemptions: 1 },
      updatedAt: NOW - 10,
    });
    expect(body.floorPriceX18).toBe("1025007007175049");
    expect(body.recent.map((r) => r.kind)).toEqual(["stray_burn", "redeem", "donation", "fee_pool", "fee_curve", "donation"]);
    expect(body.recent[1]).toEqual({ txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), logIndex: 0, kind: "redeem", account: REDEEMER, usdg: "5000", tokens: "5000000000000000000", agentId: null, ts: Number(BASE_TS + 570n), blockNumber: 570 });
    for (let i = 0; i < 60; i++) db.upsertFloorFlow({ txHash: `0xd${i}`, logIndex: 0, kind: "donation", account: DONOR, usdg: "1", tokens: "0", agentId: null, ts: NOW, blockNumber: 2000 + i });
    const many = floorApi(db).route("/api/floor", new URLSearchParams()) as Extract<FloorView, { enabled: true }>;
    expect(many.recent).toHaveLength(50);
    expect(many.recent[0]).toMatchObject({ txHash: "0xd59", blockNumber: 2059 });
    expect(many.totals.donations).toBe("1000067");
    db.kvSet(FLOOR_KV.totalSupply, "0");
    expect((floorApi(db).route("/api/floor", new URLSearchParams()) as Extract<FloorView, { enabled: true }>).floorPriceX18).toBe("0");
  });
});

describe("M4G §3 agent payloads", () => {
  it("every agent (list + detail) carries its stack by id range; fees report platformLeg; old distributed rows read as platformLeg", async () => {
    const { chain, db, w } = setup();
    scenario(chain);
    await w.poll();
    // A pre-rename (v1) distributed row as stored before SPEC-M4G.
    db.insertEvent({ agentId: 2, kind: "distributed", txHash: "0xold", logIndex: 0, blockNumber: 125, ts: 1, data: JSON.stringify({ poolId: "0xp", buybackLeg: "7", treasuryLeg: "7", royaltyLeg: "7", converted: "0" }) });
    const api = floorApi(db);
    const list = (api.route("/api/agents", new URLSearchParams()) as { agents: AgentView[] }).agents;
    const v1 = { version: 1, legacy: true, factory: ADDR.factory, registry: ADDR.registry, hook: ADDR.hook, distributor: ADDR.distributor, nft: ADDR.nft };
    const v2 = { version: 2, legacy: false, factory: ADDR2.factory, registry: ADDR2.registry, hook: ADDR2.hook, distributor: ADDR2.distributor, nft: ADDR2.nft };
    expect(list.map((a) => [a.agentId, a.stack])).toEqual([
      [2, v1],
      [101, v2],
    ]);
    expect((api.route("/api/agents/101", new URLSearchParams()) as AgentView).stack).toEqual(v2);
    expect((api.route("/api/agents/2", new URLSearchParams()) as AgentView).stack).toEqual(v1);
    expect((api.route("/api/agents/101", new URLSearchParams()) as AgentView).fees).toEqual({ platformLeg: "20000", treasuryLeg: "20000", royaltyLeg: "20000", converted: "0", count: 1 });
    const act = api.route("/api/agents/2/activity", new URLSearchParams()) as { events: Array<{ kind: string; data: Record<string, unknown> }> };
    expect(act.events.find((e) => e.kind === "distributed")!.data).toEqual({ poolId: "0xp", platformLeg: "7", treasuryLeg: "7", royaltyLeg: "7", converted: "0" });
    const act101 = api.route("/api/agents/101/activity", new URLSearchParams()) as { events: Array<{ kind: string; data: Record<string, unknown> }> };
    expect(act101.events.find((e) => e.kind === "distributed")!.data).toMatchObject({ platformLeg: "20000" });
    // No stack config on the API ⇒ stack null.
    const bare = new IndexerApi(db, { now: () => BigInt(NOW) }, { staleAfterSec: 1800, startBlock: 1n, gatewayUrl: "https://arweave.net" }, memoryLogger());
    expect((bare.route("/api/agents/2", new URLSearchParams()) as AgentView).stack).toBeNull();
  });
});

describe("M4G §3 migration v5 → v6", () => {
  it("a v5 db (the live schema) migrates clean to floor_flows, keeping every existing row", () => {
    const d = mkdtempSync(join(tmpdir(), "indexer-v5-"));
    dirs.push(d);
    const p = join(d, "v5.sqlite");
    const raw = new Database(p);
    for (const m of MIGRATIONS.slice(0, 5)) raw.exec(m);
    raw.pragma("user_version = 5");
    raw.prepare(`INSERT INTO cursor (k, v) VALUES ('watcher.nextBlock', '12345')`).run();
    raw.prepare(`INSERT INTO agents (agentId, state) VALUES (2, 'live')`).run();
    raw.prepare(`INSERT INTO fees (txHash, logIndex, agentId, poolId, buybackLeg, treasuryLeg, royaltyLeg, converted, ts, blockNumber) VALUES ('0xf', 0, 2, '0xp', '9', '9', '9', '0', 1, 1)`).run();
    raw.prepare(`INSERT INTO nft_owners (agentId, owner, since, txHash) VALUES (2, '0xabc', 1, '0x1')`).run();
    raw.close();

    const db = new IndexerDb(p);
    expect(MIGRATIONS).toHaveLength(6);
    expect(db.schemaVersion()).toBe(6);
    expect(db.kvGet("watcher.nextBlock")).toBe("12345");
    expect(db.agent(2)?.state).toBe("live");
    expect(db.fees(2)).toEqual([expect.objectContaining({ buybackLeg: "9" })]);
    expect(db.nftOwner(2)?.owner).toBe("0xabc");
    expect(db.counts()).toMatchObject({ floor_flows: 0, agents: 1, fees: 1, nft_owners: 1 });
    const row: FloorFlowRow = { txHash: "0xa", logIndex: 1, kind: "donation", account: DONOR, usdg: "5", tokens: "0", agentId: null, ts: 1, blockNumber: 2 };
    expect(db.upsertFloorFlow(row)).toBe(true);
    expect(db.upsertFloorFlow({ ...row, kind: "fee_pool", agentId: 101 })).toBe(false); // re-classification rewrites the same key
    expect(db.upsertFloorFlow({ ...row, kind: "fee_pool", agentId: null })).toBe(false); // …and never clears a resolved agentId
    expect(db.floorFlows(10)).toEqual([{ ...row, kind: "fee_pool", agentId: 101 }]);
    db.close();
    const again = new IndexerDb(p);
    expect(again.schemaVersion()).toBe(6);
    expect(again.counts().floor_flows).toBe(1);
    again.close();
  });
});
