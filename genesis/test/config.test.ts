import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildConfig, configFromDeployment, describeRental, effectiveLegModes, loadConfig, projectedRentalMicroUsdc } from "../src/config.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = join(REPO, "contracts", "deployments", "testnet-46630.json");

function fixtureDir(composeText?: string): string {
  const d = mkdtempSync(join(tmpdir(), "genesis-cfg-"));
  writeFileSync(join(d, "rel.yml"), composeText ?? `services:\n  agent:\n    image: ghcr.io/x/r@sha256:${"cd".repeat(32)}\n`);
  return d;
}

const chain = (chainId: number): Record<string, unknown> => ({ rpc: "https://rpc.example", chainId, maxFeePerGasWei: "1000000000", maxPriorityFeePerGasWei: "0" });

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataDir: "data",
    walletKeyPath: "k.key",
    deploymentManifest: MANIFEST,
    chains: { rh: chain(46630), arbitrum: chain(42161) },
    release: { composePath: "rel.yml" },
    configInboxDir: "inbox",
    ...extra,
  };
}

describe("configFromDeployment", () => {
  it("reads the committed testnet manifest", () => {
    const m = configFromDeployment(MANIFEST);
    expect(m.chainId).toBe(46630);
    expect(m.contracts.factory).toBe("0x7b257abd9BDf3377Af03DD67e2D67a8D5717b118");
    expect(m.contracts.registry).toBe("0xDBA9680C0F1958Af7Bc34a225863D93df2B92f59");
    expect(m.contracts.usdg).toBe("0xe6f7E5832991f5af335C2A21d4F35cea3d47ccAb");
    expect(m.contracts.startBlock).toBe(11_758_253n);
  });
});

describe("buildConfig", () => {
  it("applies DEFAULTs and resolves relative paths against the config dir", () => {
    const d = fixtureDir();
    const c = buildConfig(base(), d);
    expect(c.dataDir).toBe(join(d, "data"));
    expect(c.walletKeyPath).toBe(join(d, "k.key"));
    expect(c.oyster.walletKeyFile).toBe(join(d, "k.key"));
    expect(c.contracts.factory).toBe("0x7b257abd9BDf3377Af03DD67e2D67a8D5717b118");
    expect(c.timing).toMatchObject({ pollSec: 15, resumeSec: 60, timeoutSec: 86_400 });
    expect(c.retries).toEqual({ deploy: 3, verify: 3, seeding: 5, reconcile: 5, finalize: 5 });
    expect(c.seeding.profile).toBe("testnet");
    expect(c.seeding.revivalGasSeedUsdMicro).toBe(2_000_000n);
    expect(c.oyster).toMatchObject({ bin: "oyster-cvm", deployment: "arb", arch: "arm64", preset: "blue", durationMin: 180, rateUsdcMicroPerHour: 51_200n });
    expect(c.seeding.preRegistrationGasWei).toBe(333_333_333_333_333n); // $1 at $3000/ETH
    expect(c.legModes).toEqual({ "rh.usdg": "required", "rh.eth": "required", "optimism.eth": "disabled", "base.eth": "conditional", "base.usdc": "conditional", "arbitrum.eth": "required", "arweave": "conditional" });
    expect(c.chains.rh.gasReserveWei).toBe(10n ** 14n);
  });

  it("refuses the unsubstituted compose TEMPLATE", () => {
    const d = fixtureDir("services:\n  agent:\n    image: IMAGE_REPO@sha256:PLACEHOLDER\n");
    expect(() => buildConfig(base(), d)).toThrow(/unsubstituted compose template/);
    const real = join(REPO, "runtime", "docker-compose.oyster.yml");
    expect(() => buildConfig(base({ release: { composePath: real } }), fixtureDir())).toThrow(/template/);
  });

  it("refuses a required leg whose chain is not configured, and mainnet without turbo", () => {
    const d = fixtureDir();
    expect(() => buildConfig(base({ chains: { rh: chain(46630) } }), d)).toThrow(/arbitrum.eth is required but chains.arbitrum/);
    expect(() => buildConfig(base({ seeding: { profile: "mainnet" } }), d)).toThrow(/required/);
    // overriding a leg to disabled lifts the requirement
    expect(buildConfig(base({ chains: { rh: chain(46630) }, seeding: { legs: { "arbitrum.eth": { mode: "disabled" } } } }), d).legModes["arbitrum.eth"]).toBe("disabled");
  });

  it("manifest chainId must match chains.rh, explicit contracts must match the manifest", () => {
    const d = fixtureDir();
    expect(() => buildConfig(base({ chains: { rh: chain(4663), arbitrum: chain(42161) } }), d)).toThrow(/chainId 46630/);
    expect(() =>
      buildConfig(base({ contracts: { factory: "0x0000000000000000000000000000000000000001", registry: "0xDBA9680C0F1958Af7Bc34a225863D93df2B92f59", usdg: "0xe6f7E5832991f5af335C2A21d4F35cea3d47ccAb", startBlock: "1" } }), d),
    ).toThrow(/contracts.factory/);
  });

  it("rejects unknown keys (strict) and bad addresses", () => {
    const d = fixtureDir();
    expect(() => buildConfig(base({ privateKey: "0x" }), d)).toThrow();
    expect(() => buildConfig(base({ tokens: { baseUsdc: "0x123" } }), d)).toThrow();
  });

  it("loadConfig reads a file (paths relative to it)", () => {
    const d = fixtureDir();
    writeFileSync(join(d, "genesis.json"), JSON.stringify(base()));
    expect(loadConfig(join(d, "genesis.json")).release.composePath).toBe(join(d, "rel.yml"));
  });

  it("oyster durationMin DEFAULT per profile (testnet 180 min, mainnet 30 d); explicit value wins; projected rental", () => {
    const d = fixtureDir();
    const t = buildConfig(base(), d);
    expect(t.oyster.durationMin).toBe(180);
    expect(projectedRentalMicroUsdc(t.oyster)).toBe(153_600n);
    expect(describeRental(t.oyster)).toBe("durationMin 180 × 0.0512 USDC/h ⇒ projected rental 0.1536 USDC");
    const m = buildConfig(base({ seeding: { profile: "mainnet", legs: Object.fromEntries(["optimism.eth", "base.eth", "base.usdc", "arweave"].map((k) => [k, { mode: "disabled" }])) } }), d);
    expect(m.oyster.durationMin).toBe(43_200);
    expect(describeRental(m.oyster)).toBe("durationMin 43200 × 0.0512 USDC/h ⇒ projected rental 36.864 USDC");
    expect(buildConfig(base({ oyster: { durationMin: 60 } }), d).oyster.durationMin).toBe(60);
    expect(buildConfig(base({ seeding: { preRegistrationGasWei: "1000" } }), d).seeding.preRegistrationGasWei).toBe(1000n);
    expect(buildConfig(base({ seeding: { ethUsdMicro: "2000000000" } }), d).seeding.preRegistrationGasWei).toBe(500_000_000_000_000n);
    expect(() => buildConfig(base({ seeding: { ethUsdMicro: "0" } }), d)).toThrow();
  });

  it("M3C: oyster.enclaveMemoryMb / oyster.bandwidthKbps parse as positive safe ints (optional, no DEFAULT); bad values rejected", () => {
    const d = fixtureDir();
    const unset = buildConfig(base(), d);
    expect(unset.oyster.enclaveMemoryMb).toBeUndefined();
    expect(unset.oyster.bandwidthKbps).toBeUndefined();
    const set = buildConfig(base({ oyster: { enclaveMemoryMb: 3072, bandwidthKbps: 250 } }), d);
    expect(set.oyster.enclaveMemoryMb).toBe(3072);
    expect(set.oyster.bandwidthKbps).toBe(250);
    for (const bad of [0, -1, 1.5, "3072", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => buildConfig(base({ oyster: { enclaveMemoryMb: bad } }), d), `enclaveMemoryMb ${String(bad)}`).toThrow();
      expect(() => buildConfig(base({ oyster: { bandwidthKbps: bad } }), d), `bandwidthKbps ${String(bad)}`).toThrow();
    }
  });

  it("mainnet profile: every leg required", () => {
    expect(Object.values(effectiveLegModes({ seeding: { profile: "mainnet", legs: {}, ethUsdMicro: 1n, revivalGasSeedUsdMicro: 1n } }))).toEqual(Array(7).fill("required"));
  });
});
