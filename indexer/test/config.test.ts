import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildConfig, loadConfig } from "../src/config.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("config", () => {
  it("the committed testnet config resolves the deployments manifest and paths relative to itself", () => {
    const cfg = loadConfig(resolve(here, "../e2e/testnet.json"));
    expect(cfg.chain).toEqual({ rpc: ["https://rpc.testnet.chain.robinhood.com"], chainId: 46630 });
    expect(cfg.contracts).toEqual({
      factory: "0x7b257abd9BDf3377Af03DD67e2D67a8D5717b118",
      registry: "0xDBA9680C0F1958Af7Bc34a225863D93df2B92f59",
      hook: "0x40053E41fa0Bcdcd2EB127954Ce624323e9aa044",
      distributor: "0x25138BDF01F7b7E0e7ea6761ef54Ac8e8250d53B",
      treasuryBuyback: "0xD10097D4692bF94f123Df5892CaCf9DbacaEA67D",
      poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
      nft: "0x08024EDD43dcc639d2b99f17f85b4E527301B1A5",
      usdg: "0xe6f7E5832991f5af335C2A21d4F35cea3d47ccAb",
      startBlock: 11758253n,
    });
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
