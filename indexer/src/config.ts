// SPEC-M4A §1 config.ts — zod-validated indexer config. Chain RPC URL(s), the contract set (from the
// contracts deployments manifest, genesis/src/config.ts pattern), dbPath, API port, loop cadences,
// Arweave endpoints. Every `DEFAULT` below is a config parameter. Relative paths resolve against the
// config file's directory. No secrets: the indexer reads public chain + public Arweave only.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { getAddress, type Address } from "viem";
import { z } from "zod";

const bigintLike = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative(), z.bigint().nonnegative()])
  .transform((v) => BigInt(v));

const addressLike = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "invalid address")
  .transform((a) => getAddress(a));

const ContractsSchema = z
  .object({
    factory: addressLike,
    registry: addressLike,
    hook: addressLike,
    distributor: addressLike,
    treasuryBuyback: addressLike,
    poolManager: addressLike,
    nft: addressLike,
    usdg: addressLike,
    startBlock: bigintLike,
  })
  .strict();

export const IndexerConfigFileSchema = z
  .object({
    chain: z
      .object({
        /** One URL or several (viem fallback transport, in order). */
        rpc: z.union([z.string().url(), z.array(z.string().url()).min(1)]),
        chainId: z.number().int().positive(),
      })
      .strict(),
    /** contracts/deployments/<net>.json — addresses + startBlock (= deployedAtBlock). */
    deploymentManifest: z.string().min(1).optional(),
    /** Explicit addresses (must equal the manifest's when both are given). */
    contracts: ContractsSchema.optional(),
    dbPath: z.string().min(1),
    /** API port DEFAULT 8425 (SPEC-M4A §4). */
    port: z.number().int().min(0).max(65_535).default(8425),
    /** API bind host DEFAULT 127.0.0.1 (the web server fetches server-side). */
    host: z.string().min(1).default("127.0.0.1"),
    pollMs: z.number().int().positive().default(3000),
    balanceRefreshSec: z.number().int().positive().default(300),
    enrichSec: z.number().int().positive().default(120),
    staleAfterSec: z.number().int().positive().default(1800),
    /**
     * SPEC-M4B §1a: runtime/releases/ (every v*.json release record). DEFAULT unset ⇒ releaseMatch
     * renders "no release table" (skip). Relative to the config file's directory.
     */
    releasesDir: z.string().min(1).optional(),
    /** SPEC-M4B §1b attestation verify loop cadence DEFAULT 300 s. */
    verifySec: z.number().int().positive().default(300),
    /** Trailing re-scan window each poll (reorg tolerance) DEFAULT 30 blocks. */
    reorgWindowBlocks: z.number().int().nonnegative().default(30),
    /** getLogs chunk (backfill + catch-up) DEFAULT 10k blocks; halved per retry on RPC range errors (floor 100). */
    maxBlockRange: z.number().int().positive().default(10_000),
    arweave: z
      .object({
        graphqlUrl: z.string().url().default("https://arweave.net/graphql"),
        gatewayUrl: z.string().url().default("https://arweave.net"),
        enabled: z.boolean().default(true),
      })
      .strict()
      .default({}),
  })
  .strict();

export type IndexerConfigFile = z.infer<typeof IndexerConfigFileSchema>;

export interface ContractsCfg {
  factory: Address;
  registry: Address;
  hook: Address;
  distributor: Address;
  treasuryBuyback: Address;
  poolManager: Address;
  nft: Address;
  usdg: Address;
  startBlock: bigint;
}

export type IndexerConfig = Omit<IndexerConfigFile, "contracts" | "deploymentManifest" | "chain"> & {
  chain: { rpc: string[]; chainId: number };
  contracts: ContractsCfg;
};

const ManifestSchema = z
  .object({
    chainId: z.number().int().positive(),
    deployedAtBlock: bigintLike,
    factory: addressLike,
    registry: addressLike,
    hook: addressLike,
    distributor: addressLike,
    treasuryBuyback: addressLike,
    poolManager: addressLike,
    nft: addressLike,
    usdg: addressLike,
  })
  .passthrough();

const CONTRACT_KEYS = ["factory", "registry", "hook", "distributor", "treasuryBuyback", "poolManager", "nft", "usdg"] as const;

/** Reads contracts/deployments/<net>.json → addresses + scan start block + chain id. */
export function configFromDeployment(manifestPath: string): { chainId: number; contracts: ContractsCfg } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(`deployment manifest ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const m = ManifestSchema.parse(raw);
  return {
    chainId: m.chainId,
    contracts: {
      factory: m.factory,
      registry: m.registry,
      hook: m.hook,
      distributor: m.distributor,
      treasuryBuyback: m.treasuryBuyback,
      poolManager: m.poolManager,
      nft: m.nft,
      usdg: m.usdg,
      startBlock: m.deployedAtBlock,
    },
  };
}

function abs(base: string, p: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

/** Parse + resolve + cross-check a config object whose relative paths resolve against `baseDir`. */
export function buildConfig(rawJson: unknown, baseDir: string): IndexerConfig {
  const f = IndexerConfigFileSchema.parse(rawJson);
  let contracts = f.contracts;
  if (f.deploymentManifest !== undefined) {
    const m = configFromDeployment(abs(baseDir, f.deploymentManifest));
    if (m.chainId !== f.chain.chainId) throw new Error(`deployment manifest chainId ${m.chainId} ≠ chain.chainId ${f.chain.chainId}`);
    if (contracts !== undefined) {
      for (const k of CONTRACT_KEYS) {
        if (contracts[k] !== m.contracts[k]) throw new Error(`contracts.${k} ${contracts[k]} ≠ manifest ${m.contracts[k]}`);
      }
    }
    contracts = contracts ?? m.contracts;
  }
  if (contracts === undefined) throw new Error("config needs deploymentManifest (preferred) or contracts");
  const { deploymentManifest: _m, contracts: _c, ...rest } = f;
  return {
    ...rest,
    chain: { rpc: typeof f.chain.rpc === "string" ? [f.chain.rpc] : f.chain.rpc, chainId: f.chain.chainId },
    dbPath: f.dbPath === ":memory:" ? f.dbPath : abs(baseDir, f.dbPath),
    ...(f.releasesDir === undefined ? {} : { releasesDir: abs(baseDir, f.releasesDir) }),
    contracts,
  };
}

export function loadConfig(path: string): IndexerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`indexer config ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return buildConfig(raw, dirname(resolve(path)));
}
