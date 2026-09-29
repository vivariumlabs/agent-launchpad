import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfig, loadConfig, stackForAgent } from "../src/config.js";
import { ADDR, ADDR2 } from "./helpers/mockChain.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(here, "fixtures/manifests");
const V1 = join(FIX, "v1.json");
const V2 = join(FIX, "v2.json");
const CHAIN = { rpc: "https://a.example", chainId: 31337 };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A copy of a fixture manifest with keys overridden, in a temp dir; returns its path. */
function variant(src: string, patch: Record<string, unknown>): string {
  const d = mkdtempSync(join(tmpdir(), "indexer-cfg-"));
  dirs.push(d);
  const p = join(d, "m.json");
  const raw = { ...(JSON.parse(readFileSync(src, "utf8")) as Record<string, unknown>), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete raw[k];
  writeFileSync(p, JSON.stringify(raw));
  return p;
}

describe("config", () => {
  it("the committed testnet config names the v2 primary manifest + the v1 archive as legacy (SPEC-M4G §3)", () => {
    const raw = JSON.parse(readFileSync(resolve(here, "../e2e/testnet.json"), "utf8")) as Record<string, unknown>;
    expect(raw.deploymentManifest).toBe("../../contracts/deployments/testnet-46630.json");
    expect(raw.legacyManifests).toEqual(["../../contracts/deployments/testnet-46630.v1.json"]);
    expect(raw.dbPath).toBe("data/indexer.sqlite");
  });

  // Live manifests: runs once the v1 archive exists and the primary manifest is the v2 stack (SPEC-M4G §2).
  const v1Archive = resolve(here, "../../contracts/deployments/testnet-46630.v1.json");
  const primaryPath = resolve(here, "../../contracts/deployments/testnet-46630.json");
  const liveReady = existsSync(v1Archive) && existsSync(primaryPath) && (JSON.parse(readFileSync(primaryPath, "utf8")) as { stackVersion?: unknown }).stackVersion === 2;
  it.skipIf(!liveReady)("the committed testnet config resolves both live stacks (v2 primary ids 101+, v1 legacy ids 1+, shared USDG)", () => {
    const cfg = loadConfig(resolve(here, "../e2e/testnet.json"));
    expect(cfg.chain).toEqual({ rpc: ["https://rpc.testnet.chain.robinhood.com"], chainId: 46630 });
    expect(cfg.stacks).toHaveLength(2);
    expect(cfg.stacks[0]).toMatchObject({ version: 2, legacy: false, firstAgentId: 101 });
    expect(cfg.stacks[1]).toEqual({
      version: 1,
      legacy: true,
      factory: "0x7b257abd9BDf3377Af03DD67e2D67a8D5717b118",
      registry: "0xDBA9680C0F1958Af7Bc34a225863D93df2B92f59",
      hook: "0x40053E41fa0Bcdcd2EB127954Ce624323e9aa044",
      distributor: "0x25138BDF01F7b7E0e7ea6761ef54Ac8e8250d53B",
      nft: "0x08024EDD43dcc639d2b99f17f85b4E527301B1A5",
      startBlock: 11758253n,
      firstAgentId: 1,
    });
    expect(cfg.usdg).toBe("0xe6f7E5832991f5af335C2A21d4F35cea3d47ccAb");
    expect(cfg.poolManager).toBe("0x8366a39CC670B4001A1121B8F6A443A643e40951");
    expect(cfg.floor).not.toBeNull();
    expect(cfg.dbPath).toBe(resolve(here, "../e2e/data/indexer.sqlite"));
    expect(cfg).toMatchObject({ port: 8425, pollMs: 3000, balanceRefreshSec: 300, enrichSec: 120, staleAfterSec: 1800, reorgWindowBlocks: 30, maxBlockRange: 10_000 });
    expect(cfg.arweave).toEqual({ graphqlUrl: "https://arweave.net/graphql", gatewayUrl: "https://arweave.net", enabled: true });
  });

  it("defaults apply; a manifest chainId mismatch and a missing contract source are rejected", () => {
    const manifest = resolve(here, "../../contracts/deployments/testnet-46630.json");
    const c = buildConfig({ chain: { rpc: ["https://a.example", "https://b.example"], chainId: 46630 }, deploymentManifest: manifest, dbPath: "x.sqlite" }, "/base");
    expect(c.chain.rpc).toHaveLength(2);
    expect(c.dbPath).toBe("/base/x.sqlite");
    expect(c.port).toBe(8425);
    expect(() => buildConfig({ chain: { rpc: "https://a.example", chainId: 1 }, deploymentManifest: manifest, dbPath: "x" }, "/base")).toThrow(/chainId/);
    expect(() => buildConfig({ chain: { rpc: "https://a.example", chainId: 1 }, dbPath: "x" }, "/base")).toThrow(/deploymentManifest/);
    expect(() => buildConfig({ chain: { rpc: "https://a.example", chainId: 1 }, dbPath: "x", secret: 1 }, "/base")).toThrow();
  });
});

describe("config: multi-stack (SPEC-M4G §3)", () => {
  it("parses primary v2 + legacy v1 (relative to the config dir): stacks primary-first, shared usdg/poolManager, floor from the primary", () => {
    const cfg = buildConfig({ chain: CHAIN, deploymentManifest: "v2.json", legacyManifests: ["v1.json"], dbPath: "x" }, FIX);
    expect(cfg.stacks).toEqual([
      { version: 2, legacy: false, factory: ADDR2.factory, registry: ADDR2.registry, hook: ADDR2.hook, distributor: ADDR2.distributor, nft: ADDR2.nft, startBlock: 500n, firstAgentId: 101 },
      { version: 1, legacy: true, factory: ADDR.factory, registry: ADDR.registry, hook: ADDR.hook, distributor: ADDR.distributor, nft: ADDR.nft, startBlock: 100n, firstAgentId: 1 },
    ]);
    expect(cfg.usdg).toBe(ADDR.usdg);
    expect(cfg.poolManager).toBe(ADDR.poolManager);
    expect(cfg.floor).toEqual({ vault: ADDR2.floorVault, token: ADDR2.platformToken });
    expect(cfg.contracts).toMatchObject({ factory: ADDR2.factory, floorVault: ADDR2.floorVault, platformToken: ADDR2.platformToken, startBlock: 500n });
    expect(cfg.contracts.treasuryBuyback).toBeUndefined();
    // /api/contracts body: the primary manifest's addresses + stacks (JSON numbers).
    expect(cfg.contractsView).toMatchObject({ chainId: 31337, factory: ADDR2.factory, floorVault: ADDR2.floorVault, platformToken: ADDR2.platformToken, usdg: ADDR.usdg, locker: "0x200000000000000000000000000000000000000b" });
    expect(cfg.contractsView.treasuryBuyback).toBeUndefined();
    expect(cfg.contractsView.stacks).toEqual([
      { version: 2, legacy: false, factory: ADDR2.factory, registry: ADDR2.registry, hook: ADDR2.hook, distributor: ADDR2.distributor, nft: ADDR2.nft, startBlock: 500, firstAgentId: 101 },
      { version: 1, legacy: true, factory: ADDR.factory, registry: ADDR.registry, hook: ADDR.hook, distributor: ADDR.distributor, nft: ADDR.nft, startBlock: 100, firstAgentId: 1 },
    ]);
    expect(JSON.parse(JSON.stringify(cfg.contractsView))).toEqual(cfg.contractsView); // JSON-safe (no bigint)
  });

  it("a v1-only manifest (treasuryBuyback, no floorVault / stack keys) ⇒ one v1 stack, floor null", () => {
    const m = variant(V1, { stackVersion: undefined, firstAgentId: undefined, legacy: undefined });
    const cfg = buildConfig({ chain: CHAIN, deploymentManifest: m, dbPath: "x" }, "/base");
    expect(cfg.stacks).toEqual([expect.objectContaining({ version: 1, legacy: false, firstAgentId: 1, factory: ADDR.factory })]);
    expect(cfg.floor).toBeNull();
    expect(cfg.contracts.treasuryBuyback).toBe(ADDR.treasuryBuyback);
  });

  it("asserts shared USDG / PoolManager / chainId across stacks; rejects duplicate stacks and overlapping firstAgentId", () => {
    const base = { chain: CHAIN, deploymentManifest: V2, dbPath: "x" };
    expect(() => buildConfig({ ...base, legacyManifests: [variant(V1, { usdg: "0x5000000000000000000000000000000000000006" })] }, "/b")).toThrow(/usdg .* must share USDG/);
    expect(() => buildConfig({ ...base, legacyManifests: [variant(V1, { poolManager: "0x1000000000000000000000000000000000000066" })] }, "/b")).toThrow(/poolManager .* share the PoolManager/);
    expect(() => buildConfig({ ...base, legacyManifests: [variant(V1, { chainId: 1 })] }, "/b")).toThrow(/legacy manifest .*chainId 1/);
    expect(() => buildConfig({ ...base, legacyManifests: [V2] }, "/b")).toThrow(/more than one stack/);
    expect(() => buildConfig({ ...base, legacyManifests: [variant(V1, { firstAgentId: 101 })] }, "/b")).toThrow(/firstAgentId 101/);
    expect(() => buildConfig({ ...base, legacyManifests: [join(FIX, "missing.json")] }, "/b")).toThrow(/missing\.json/);
    expect(() => buildConfig({ ...base, deploymentManifest: variant(V2, { platformToken: undefined }) }, "/b")).toThrow(/floorVault and platformToken/);
  });

  it("the explicit contracts block still cross-checks the primary manifest", () => {
    const explicit = { factory: ADDR2.factory, registry: ADDR2.registry, hook: ADDR2.hook, distributor: ADDR2.distributor, floorVault: ADDR2.floorVault, platformToken: ADDR2.platformToken, poolManager: ADDR.poolManager, nft: ADDR2.nft, usdg: ADDR.usdg, startBlock: 500 };
    const ok = buildConfig({ chain: CHAIN, deploymentManifest: V2, legacyManifests: [V1], contracts: explicit, dbPath: "x" }, "/b");
    expect(ok.stacks.map((s) => s.version)).toEqual([2, 1]);
    expect(() => buildConfig({ chain: CHAIN, deploymentManifest: V2, contracts: { ...explicit, hook: ADDR.hook }, dbPath: "x" }, "/b")).toThrow(/contracts\.hook/);
    expect(() => buildConfig({ chain: CHAIN, deploymentManifest: V2, contracts: { ...explicit, floorVault: undefined }, dbPath: "x" }, "/b")).toThrow(/contracts\.floorVault/);
    // explicit-only (no manifest): one v1-default stack; floor from the block when given.
    const only = buildConfig({ chain: CHAIN, contracts: explicit, dbPath: "x" }, "/b");
    expect(only.stacks).toEqual([expect.objectContaining({ version: 1, legacy: false, firstAgentId: 1, factory: ADDR2.factory, startBlock: 500n })]);
    expect(only.floor).toEqual({ vault: ADDR2.floorVault, token: ADDR2.platformToken });
  });

  it("stackForAgent routes by the R2 disjoint id ranges", () => {
    const stacks = [
      { v: 2, firstAgentId: 101 },
      { v: 1, firstAgentId: 1 },
    ];
    expect(stackForAgent(stacks, 1)?.v).toBe(1);
    expect(stackForAgent(stacks, 11)?.v).toBe(1);
    expect(stackForAgent(stacks, 100)?.v).toBe(1);
    expect(stackForAgent(stacks, 101)?.v).toBe(2);
    expect(stackForAgent(stacks, 5000)?.v).toBe(2);
    expect(stackForAgent([{ v: 2, firstAgentId: 101 }], 7)).toBeUndefined();
  });
});
