// SPEC-M4E §2 — NFT ownership (nft_owners, migration v5 backfill), GET /api/wallets/:address/nfts,
// GET /api/contracts. tokenId == agentId (AgentNFT.sol:9); burn = Transfer to 0x0 ⇒ no owner row;
// the burner keeps seeing its emancipated agent (Fable ruling).

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, type Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { agentFactoryAbi, agentNftAbi, royaltyDistributorAbi } from "../src/abi.js";
import { IndexerApi } from "../src/api.js";
import { buildConfig } from "../src/config.js";
import { IndexerDb, MIGRATIONS } from "../src/db.js";
import { memoryLogger } from "../src/log.js";
import { CURSOR_KEY, Watcher } from "../src/watcher.js";
import { ADDR, ADDR2, BASE_TS, contracts, fixedClock, MockChain, mkLog, ZERO } from "./helpers/mockChain.js";

const here = dirname(fileURLToPath(import.meta.url));
const CREATOR: Address = getAddress("0xcc00000000000000000000000000000000000001");
const BUYER: Address = getAddress("0xdd000000000000000000000000000000000000Ab");
const STRANGER: Address = getAddress("0xee00000000000000000000000000000000000001");
const CFG = `0x${"ab".repeat(32)}` as const;
const NOW = Number(BASE_TS + 2000n);

function setup() {
  const chain = new MockChain();
  const db = new IndexerDb(":memory:");
  const w = new Watcher(db, chain, { contracts: contracts(100n), reorgWindowBlocks: 30, maxBlockRange: 10_000 }, fixedClock(BASE_TS + 2000n), memoryLogger());
  return { chain, db, w };
}

const nftT = (from: Address, to: Address, id: bigint, blockNumber: bigint, logIndex = 0) => mkLog(agentNftAbi, "Transfer", { from, to, tokenId: id }, { address: ADDR.nft, blockNumber, logIndex });

/**
 * Agents 2 and 4 minted to CREATOR (block 110); 2 claimed twice then sold to BUYER (block 150);
 * 4 burned by CREATOR (block 160) with Emancipated. Heads: 115 → 155 → 200.
 */
async function story(chain: MockChain, db: IndexerDb, w: Watcher): Promise<Array<ReturnType<IndexerDb["nftOwners"]>>> {
  for (const id of [2n, 4n]) chain.pending.set(id, { creator: CREATOR, configHash: CFG, imageURI: "", name: `Agent${id}`, symbol: `AG${id}`, genesisDeadline: 9n, feePaid: true });
  const L = chain.logs;
  L.push(mkLog(agentFactoryAbi, "AgentRequested", { agentId: 2n, configHash: CFG, creator: CREATOR }, { address: ADDR.factory, blockNumber: 105n, logIndex: 0 }));
  L.push(mkLog(agentFactoryAbi, "AgentRequested", { agentId: 4n, configHash: CFG, creator: CREATOR }, { address: ADDR.factory, blockNumber: 105n, logIndex: 1 }));
  L.push(nftT(ZERO, CREATOR, 2n, 110n, 0));
  L.push(nftT(ZERO, CREATOR, 4n, 110n, 1));
  const snaps: Array<ReturnType<IndexerDb["nftOwners"]>> = [];
  chain.head = 115n;
  await w.poll();
  snaps.push(db.nftOwners());

  L.push(mkLog(royaltyDistributorAbi, "Claimed", { agentId: 2n, to: CREATOR, amount: 1_500_000n }, { address: ADDR.distributor, blockNumber: 120n, logIndex: 0 }));
  L.push(mkLog(royaltyDistributorAbi, "Claimed", { agentId: 2n, to: CREATOR, amount: 2_250_001n }, { address: ADDR.distributor, blockNumber: 130n, logIndex: 0 }));
  L.push(mkLog(royaltyDistributorAbi, "Claimed", { agentId: 4n, to: CREATOR, amount: 7n }, { address: ADDR.distributor, blockNumber: 130n, logIndex: 1 }));
  L.push(nftT(CREATOR, BUYER, 2n, 150n));
  chain.head = 155n;
  await w.poll();
  snaps.push(db.nftOwners());

  // Burn: AgentNFT._burn emits Transfer(owner, 0x0) and the distributor's Emancipated in the same tx.
  L.push(nftT(CREATOR, ZERO, 4n, 160n, 0));
  L.push(mkLog(royaltyDistributorAbi, "Emancipated", { agentId: 4n, sweptToTreasury: 33n }, { address: ADDR.distributor, blockNumber: 160n, logIndex: 1 }));
  chain.head = 200n;
  await w.poll();
  snaps.push(db.nftOwners());
  return snaps;
}

const T = (b: bigint): number => Number(BASE_TS + b);

describe("M4E §2: nft_owners derivation", () => {
  it("M4E §2: owner derivation follows transfers — mint (from 0x0) ⇒ owner, transfer ⇒ new owner, burn (to 0x0) ⇒ row removed", async () => {
    const { chain, db, w } = setup();
    const [afterMint, afterSale, afterBurn] = await story(chain, db, w);
    const lc = CREATOR.toLowerCase();
    expect(afterMint!.map((r) => [r.agentId, r.owner, r.since])).toEqual([
      [2, lc, T(110n)],
      [4, lc, T(110n)],
    ]);
    expect(afterSale!.map((r) => [r.agentId, r.owner, r.since])).toEqual([
      [2, BUYER.toLowerCase(), T(150n)],
      [4, lc, T(110n)],
    ]);
    expect(afterBurn!.map((r) => [r.agentId, r.owner])).toEqual([[2, BUYER.toLowerCase()]]);
    expect(db.nftOwner(4)).toBeUndefined();
    expect(db.nftOwner(2)!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(db.counts().nft_owners).toBe(1);
  });

  it("M4E §2: idempotent re-ingest — a full re-scan from startBlock (and a stale older transfer re-applied) never changes or regresses owners", async () => {
    const { chain, db, w } = setup();
    await story(chain, db, w);
    const owners = db.nftOwners();
    const counts = db.counts();
    db.kvSet(CURSOR_KEY, "100");
    await w.poll();
    await w.poll();
    expect(db.nftOwners()).toEqual(owners);
    expect(db.counts()).toEqual(counts);
    // Order independence: refreshing after the older mint row is (re)seen keeps the latest transfer's owner.
    db.refreshNftOwner(2);
    db.refreshNftOwner(4);
    db.refreshNftOwner(99); // unknown agent: no row
    expect(db.nftOwners()).toEqual(owners);
  });
});

// ---------------------------------------------------------------------------
// migration v5 backfill
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("M4E §2: migration v5", () => {
  it("M4E §2: backfill on migration — a v4 db with ingested nft_transfer events gets nft_owners derived by the same rule as ingest", () => {
    const d = mkdtempSync(join(tmpdir(), "indexer-m4e-"));
    dirs.push(d);
    const p = join(d, "v4.sqlite");
    const raw = new Database(p);
    for (const m of MIGRATIONS.slice(0, 4)) raw.exec(m);
    raw.pragma("user_version = 4");
    const ins = raw.prepare(`INSERT INTO events (agentId, kind, txHash, logIndex, blockNumber, ts, data) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const tr = (from: string, to: string): string => JSON.stringify({ from, to });
    // agent 8: minted then transferred (rows inserted OUT of chain order — the rule orders by block/log)
    ins.run(8, "nft_transfer", "0xb", 0, 300, 3000, tr(CREATOR, BUYER));
    ins.run(8, "nft_transfer", "0xa", 2, 200, 2000, tr(ZERO, CREATOR));
    // agent 9: minted, burned ⇒ no row; agent 10: minted only; agent 11: two transfers in ONE block (logIndex decides)
    ins.run(9, "nft_transfer", "0xc", 0, 200, 2000, tr(ZERO, CREATOR));
    ins.run(9, "nft_transfer", "0xd", 0, 400, 4000, tr(CREATOR, ZERO));
    ins.run(10, "nft_transfer", "0xe", 1, 200, 2000, tr(ZERO, STRANGER));
    ins.run(11, "nft_transfer", "0xf", 5, 500, 5000, tr(ZERO, CREATOR));
    ins.run(11, "nft_transfer", "0xf", 6, 500, 5000, tr(CREATOR, BUYER));
    ins.run(8, "heartbeat", "0x1", 0, 350, 3500, "{}");
    raw.close();

    const db = new IndexerDb(p);
    expect(db.schemaVersion()).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(5); // v5 = nft_owners (later migrations append)
    const backfilled = db.nftOwners();
    expect(backfilled).toEqual([
      { agentId: 8, owner: BUYER.toLowerCase(), since: 3000, txHash: "0xb" },
      { agentId: 10, owner: STRANGER.toLowerCase(), since: 2000, txHash: "0xe" },
      { agentId: 11, owner: BUYER.toLowerCase(), since: 5000, txHash: "0xf" },
    ]);
    // Same rule as ingest: recomputing every agent via refreshNftOwner is a no-op.
    for (const id of [8, 9, 10, 11]) db.refreshNftOwner(id);
    expect(db.nftOwners()).toEqual(backfilled);
    db.close();
    const again = new IndexerDb(p); // reopen: no re-run
    expect(again.nftOwners()).toEqual(backfilled);
    again.close();
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

describe("M4E §2: API", () => {
  it("M4E §2: GET /api/wallets/:address/nfts — owned + burned-by-wallet (emancipated), lifetimeClaimed = Σ Claimed, case-insensitive; empty wallet; 400/404", async () => {
    const { chain, db, w } = setup();
    await story(chain, db, w);
    const api = new IndexerApi(db, { now: () => BigInt(NOW) }, { staleAfterSec: 1800, startBlock: 100n, gatewayUrl: "https://arweave.net" }, memoryLogger());
    const get = (p: string): unknown => api.route(p, new URLSearchParams());

    // BUYER owns agent 2 (bought at block 150); the creator's claims before the sale still count as lifetime.
    expect(get(`/api/wallets/${BUYER}/nfts`)).toEqual({
      address: BUYER.toLowerCase(),
      nfts: [{ agentId: 2, name: "Agent2", symbol: "AG2", since: T(150n), emancipated: false, sweptToTreasury: null, lifetimeClaimed: "3750001" }],
    });
    expect(get(`/api/wallets/${BUYER.toLowerCase()}/nfts`)).toEqual(get(`/api/wallets/${BUYER.toUpperCase().replace("0X", "0x")}/nfts`));
    // CREATOR sold 2 (gone) and BURNED 4: the burner keeps seeing its emancipated agent.
    expect(get(`/api/wallets/${CREATOR}/nfts`)).toEqual({
      address: CREATOR.toLowerCase(),
      nfts: [{ agentId: 4, name: "Agent4", symbol: "AG4", since: T(110n), emancipated: true, sweptToTreasury: "33", lifetimeClaimed: "7" }],
    });
    // Empty wallet.
    expect(get(`/api/wallets/${STRANGER}/nfts`)).toEqual({ address: STRANGER.toLowerCase(), nfts: [] });
    expect(() => get("/api/wallets/0x1234/nfts")).toThrow(/bad wallet address/);
    expect(() => get(`/api/wallets/${BUYER}`)).toThrow(/not found/);
    expect(() => get(`/api/wallets/${BUYER}/nfts/extra`)).toThrow(/not found/);

    // Over HTTP: status codes + JSON.
    const server = api.server();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const ok = await fetch(`${base}/api/wallets/${BUYER}/nfts`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe("*");
      expect(((await ok.json()) as { nfts: unknown[] }).nfts).toHaveLength(1);
      expect((await fetch(`${base}/api/wallets/nope/nfts`)).status).toBe(400);
      expect((await fetch(`${base}/api/wallets/${BUYER}/tokens`)).status).toBe(404);
      expect((await fetch(`${base}/api/contracts`)).status).toBe(404); // not configured on this api
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("M4E §2 / M4G §3: GET /api/contracts — chainId + every address the PRIMARY manifest carries (checksummed; non-address keys omitted) + stacks; explicit-contracts configs expose theirs", () => {
    const cfg = buildConfig({ chain: { rpc: "https://a.example", chainId: 31337 }, deploymentManifest: "v2.json", legacyManifests: ["v1.json"], dbPath: "x" }, resolve(here, "fixtures/manifests"));
    const stackViews = [
      { version: 2, legacy: false, factory: ADDR2.factory, registry: ADDR2.registry, hook: ADDR2.hook, distributor: ADDR2.distributor, nft: ADDR2.nft, startBlock: 500, firstAgentId: 101 },
      { version: 1, legacy: true, factory: ADDR.factory, registry: ADDR.registry, hook: ADDR.hook, distributor: ADDR.distributor, nft: ADDR.nft, startBlock: 100, firstAgentId: 1 },
    ];
    expect(cfg.contractsView).toEqual({
      chainId: 31337,
      deployer: "0x1000000000000000000000000000000000000099",
      distributor: ADDR2.distributor,
      factory: ADDR2.factory,
      floorVault: ADDR2.floorVault,
      hook: ADDR2.hook,
      hookDeployer: getAddress("0x200000000000000000000000000000000000000a"),
      locker: getAddress("0x200000000000000000000000000000000000000b"),
      nft: ADDR2.nft,
      platformToken: ADDR2.platformToken,
      poolManager: ADDR.poolManager,
      registry: ADDR2.registry,
      usdg: ADDR.usdg,
      stacks: stackViews,
    });
    const db = new IndexerDb(":memory:");
    const api = new IndexerApi(db, { now: () => BigInt(NOW) }, { staleAfterSec: 1800, startBlock: 1n, gatewayUrl: "https://arweave.net", contracts: cfg.contractsView }, memoryLogger());
    expect(api.route("/api/contracts", new URLSearchParams())).toEqual(cfg.contractsView);
    db.close();

    const explicit = buildConfig({ chain: { rpc: "https://a.example", chainId: 31337 }, contracts: { ...ADDR, startBlock: 1 }, dbPath: "x" }, "/base");
    expect(explicit.contractsView).toEqual({
      chainId: 31337,
      ...Object.fromEntries(Object.entries(ADDR).map(([k, v]) => [k, getAddress(v)])),
      stacks: [{ version: 1, legacy: false, factory: ADDR.factory, registry: ADDR.registry, hook: ADDR.hook, distributor: ADDR.distributor, nft: ADDR.nft, startBlock: 1, firstAgentId: 1 }],
    });
  });
});
