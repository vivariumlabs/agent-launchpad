// SPEC-M3B §1 config.ts — zod-validated orchestrator config. Chain RPCs, factory/registry/usdg
// addresses (from the contracts deployment manifest via configFromDeployment), walletKeyPath,
// release compose path, the seed table (04 §2) with profiles, oyster + turbo settings, timing and
// retry caps. Every `DEFAULT` below is a config parameter. Relative paths resolve against the
// config file's directory. SPEC-M3C §7: oyster.enclaveMemoryMb / oyster.bandwidthKbps (optional deploy flags).

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { getAddress, type Address } from "viem";
import { z } from "zod";
import type { ChainKey } from "./chain.js";

// ---------------------------------------------------------------------------
// Seed table (04 §2)
// ---------------------------------------------------------------------------

export const LEG_IDS = ["rh.usdg", "rh.eth", "optimism.eth", "base.eth", "base.usdc", "arbitrum.eth", "arweave"] as const;
export type LegId = (typeof LEG_IDS)[number];
export type LegMode = "required" | "conditional" | "disabled";

export interface LegDef {
  id: LegId;
  chain: ChainKey;
  asset: "native" | "erc20" | "turbo";
  /** "usdg" / "baseUsdc" → token address resolved from config; undefined for native/turbo. */
  token?: "usdg" | "baseUsdc";
  /** µUSD (1e-6 USD); "remainder" = creation fee − Σ other non-disabled legs. */
  usdMicro: bigint | "remainder";
}

/** 04 §2 table, amounts `DEFAULT`. */
export const LEG_DEFS: Record<LegId, LegDef> = {
  "rh.usdg": { id: "rh.usdg", chain: "rh", asset: "erc20", token: "usdg", usdMicro: "remainder" }, // Treasury EOA (RH) USDG: remainder
  "rh.eth": { id: "rh.eth", chain: "rh", asset: "native", usdMicro: 2_000_000n }, // Treasury gas (RH ETH) $2
  "optimism.eth": { id: "optimism.eth", chain: "optimism", asset: "native", usdMicro: 5_000_000n }, // OP (Farcaster reg + rent) $5
  "base.eth": { id: "base.eth", chain: "base", asset: "native", usdMicro: 2_000_000n }, // Base gas buffer $2
  "base.usdc": { id: "base.usdc", chain: "base", asset: "erc20", token: "baseUsdc", usdMicro: 15_000_000n }, // Base inference seed $15
  "arbitrum.eth": { id: "arbitrum.eth", chain: "arbitrum", asset: "native", usdMicro: 1_000_000n }, // Arb One gas $1
  "arweave": { id: "arweave", chain: "rh", asset: "turbo", usdMicro: 3_000_000n }, // Arweave (Turbo credits) $3
};

/**
 * Profiles (SPEC-M3B §1). testnet (`DEFAULT`): RH-USDG (Mock) remainder, RH ETH, skip OP (Farcaster
 * deferred until funded), Base ETH+USDC only if the funding wallet holds them, Arb ETH, Arweave =
 * Turbo top-up skipped (loudly) when Turbo is unfunded. mainnet: every leg required.
 * conditional = skipped (recorded + logged loudly) when the funding wallet / Turbo cannot fund it or
 * the chain is not configured; a skipped leg does not block finalize. required = blocks finalize.
 */
export const PROFILES: Record<"testnet" | "mainnet", Record<LegId, LegMode>> = {
  testnet: {
    "rh.usdg": "required",
    "rh.eth": "required",
    "optimism.eth": "disabled",
    "base.eth": "conditional",
    "base.usdc": "conditional",
    "arbitrum.eth": "required",
    "arweave": "conditional",
  },
  mainnet: {
    "rh.usdg": "required",
    "rh.eth": "required",
    "optimism.eth": "required",
    "base.eth": "required",
    "base.usdc": "required",
    "arbitrum.eth": "required",
    "arweave": "required",
  },
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const bigintLike = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative(), z.bigint().nonnegative()])
  .transform((v) => BigInt(v));

const addressLike = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "invalid address")
  .transform((a) => getAddress(a));

const ChainCfgSchema = z
  .object({
    rpc: z.string().url(),
    chainId: z.number().int().positive(),
    /** Fee caps: a tx whose baseFee + priority exceeds maxFeePerGasWei is NOT broadcast (waits). */
    maxFeePerGasWei: bigintLike,
    maxPriorityFeePerGasWei: bigintLike,
    /** Native balance the funding wallet keeps for gas when judging a conditional leg (DEFAULT 1e14). */
    gasReserveWei: bigintLike.default(100_000_000_000_000n),
  })
  .strict();

const LegOverrideSchema = z
  .object({
    mode: z.enum(["required", "conditional", "disabled"]).optional(),
    usdMicro: bigintLike.optional(),
  })
  .strict();

/**
 * Oyster rental duration per profile (`oyster.durationMin` DEFAULT): testnet 180 min (3 h — a test
 * CVM, never a month of paid hosting by accident), mainnet 30 days (first month's rental, 04 §2).
 */
export const PROFILE_DURATION_MIN: Record<"testnet" | "mainnet", number> = { testnet: 180, mainnet: 43_200 };

/** Pre-registration gas leg DEFAULT: $1 of RH ETH (converted at seeding.ethUsdMicro). */
export const PRE_REGISTRATION_GAS_USD_MICRO = 1_000_000n;

/** Base mainnet native USDC (Circle). */
const BASE_USDC_DEFAULT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** oyster-cvm deploy --operator default on Arbitrum (cli/oyster-cvm/README.md). */
const OYSTER_OPERATOR_DEFAULT = "0xe10fa12f580e660ecd593ea4119cebc90509d642";

export const GenesisConfigFileSchema = z
  .object({
    /** Orchestrator state dir: sqlite db + per-agent agent.json/runtime.json work files. */
    dataDir: z.string().min(1),
    /** Funding/operational wallet key file (.secrets/ pattern). Read once, never logged. */
    walletKeyPath: z.string().min(1),
    /** contracts/deployments/<net>.json — the source of factory/registry/usdg + start block. */
    deploymentManifest: z.string().min(1).optional(),
    /** Explicit addresses (must equal the manifest's when both are given). */
    contracts: z
      .object({ factory: addressLike, registry: addressLike, usdg: addressLike, startBlock: bigintLike })
      .strict()
      .optional(),
    chains: z
      .object({ rh: ChainCfgSchema, base: ChainCfgSchema.optional(), arbitrum: ChainCfgSchema.optional(), optimism: ChainCfgSchema.optional() })
      .strict(),
    tokens: z.object({ baseUsdc: addressLike.default(BASE_USDC_DEFAULT) }).strict().default({}),
    /** releases/<version>.yml written by runtime/scripts/release.sh (digest-substituted). */
    release: z.object({ composePath: z.string().min(1) }).strict(),
    /** Frozen configs delivered off-chain by the website (02 §1): <dir>/<configHash>.json. */
    configInboxDir: z.string().min(1),
    /** Arweave gateway for `ar://<txid>` config refs (revival path). */
    arweaveGateway: z.string().url().optional(),
    /** runtime.json template (ops config, unattested); the orchestrator sets tee + imageId. */
    runtimeOps: z.record(z.string(), z.unknown()).default({}),
    seeding: z
      .object({
        profile: z.enum(["testnet", "mainnet"]).default("testnet"),
        /** Static ETH price for $-denominated gas legs, µUSD per ETH (DEFAULT $3000). */
        ethUsdMicro: bigintLike.refine((v) => v > 0n, "ethUsdMicro must be > 0").default(3_000_000_000n),
        legs: z.record(z.enum(LEG_IDS), LegOverrideSchema).default({}),
        /** Revival gas-only leg (04 §6): RH ETH, µUSD (DEFAULT $2). */
        revivalGasSeedUsdMicro: bigintLike.default(2_000_000n),
        /**
         * Pre-registration gas leg "preGas": RH ETH sent to registry.expectedTreasuryEOA(agentId) once
         * the attestation verified, BEFORE the enclave registers (registerInstance costs gas the
         * brand-new treasury does not have). DEFAULT = wei-equivalent of $1 at ethUsdMicro.
         */
        preRegistrationGasWei: bigintLike.optional(),
      })
      .strict()
      .default({}),
    oyster: z
      .object({
        bin: z.string().min(1).default("oyster-cvm"),
        /** Raw-hex key file for `--wallet-private-key-file` (DEFAULT walletKeyPath). Same wallet. */
        walletKeyFile: z.string().min(1).optional(),
        deployment: z.string().min(1).default("arb"),
        arch: z.enum(["arm64", "amd64"]).default("arm64"),
        preset: z.string().min(1).default("blue"),
        region: z.string().min(1).default("ap-south-1"),
        operator: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default(OYSTER_OPERATOR_DEFAULT),
        instanceType: z.string().min(1).optional(),
        rpc: z.string().url().optional(),
        /** SPEC-M3C §7: `deploy --enclave-memory <MB>`; unset ⇒ omitted (CLI default). Our image REQUIRES 3072. */
        enclaveMemoryMb: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
        /** SPEC-M3C §7: `deploy --bandwidth <KBps>` (CLI 5.0.1: KBps, default 10); unset ⇒ omitted. */
        bandwidthKbps: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
        /** Rental per deploy, minutes. DEFAULT per profile: testnet 180, mainnet 43_200 (30 d, 04 §2). */
        durationMin: z.number().int().positive().optional(),
        /** Rental rate for the projected-cost log, µUSDC per hour (DEFAULT 51_200 = 0.0512 USDC/h, M0 RESULTS). */
        rateUsdcMicroPerHour: bigintLike.default(51_200n),
        indexerUrl: z.string().url().default("https://indexer.oyster.marlin.org/graphql"),
        cpUrl: z.string().url().optional(),
        deployTimeoutSec: z.number().int().positive().default(900),
        verifyTimeoutSec: z.number().int().positive().default(120),
        cliTimeoutSec: z.number().int().positive().default(120),
        httpTimeoutSec: z.number().int().positive().default(20),
      })
      .strict()
      .default({}),
    turbo: z.object({ enabled: z.boolean().default(false) }).strict().default({}),
    timing: z
      .object({
        pollSec: z.number().int().positive().default(15),
        resumeSec: z.number().int().positive().default(60),
        /**
         * Per-launch timeout → FAILED(timeout) (DEFAULT 24h), measured from the request. Applies ONLY
         * up to and including AWAITING_REGISTER; post-registration steps never time out (operator
         * `redrive` instead).
         */
        timeoutSec: z.number().int().positive().default(86_400),
        confirmations: z.number().int().nonnegative().default(2),
        maxBlockRange: z.number().int().positive().default(5_000),
        receiptTimeoutSec: z.number().int().positive().default(180),
        /** After an interrupted deploy, how long to wait for an orphan job to appear in `list`. */
        deployOrphanGraceSec: z.number().int().nonnegative().default(600),
      })
      .strict()
      .default({}),
    retries: z
      .object({
        deploy: z.number().int().positive().default(3),
        verify: z.number().int().positive().default(3),
        seeding: z.number().int().positive().default(5),
        reconcile: z.number().int().positive().default(5),
        finalize: z.number().int().positive().default(5),
      })
      .strict()
      .default({}),
  })
  .strict();

export type GenesisConfigFile = z.infer<typeof GenesisConfigFileSchema>;
export type ChainCfg = z.infer<typeof ChainCfgSchema>;

export interface ContractsCfg {
  factory: Address;
  registry: Address;
  usdg: Address;
  startBlock: bigint;
}

export type GenesisConfig = Omit<GenesisConfigFile, "contracts" | "deploymentManifest" | "oyster" | "seeding"> & {
  contracts: ContractsCfg;
  oyster: Omit<GenesisConfigFile["oyster"], "walletKeyFile" | "durationMin"> & { walletKeyFile: string; durationMin: number };
  seeding: Omit<GenesisConfigFile["seeding"], "preRegistrationGasWei"> & { preRegistrationGasWei: bigint };
  /** Effective mode per leg (profile + overrides). */
  legModes: Record<LegId, LegMode>;
};

// ---------------------------------------------------------------------------
// Deployment manifest
// ---------------------------------------------------------------------------

const ManifestSchema = z
  .object({
    chainId: z.number().int().positive(),
    deployedAtBlock: bigintLike,
    factory: addressLike,
    registry: addressLike,
    usdg: addressLike,
  })
  .passthrough();

/** Reads contracts/deployments/<net>.json → the contract addresses + scan start block + chain id. */
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
    contracts: { factory: m.factory, registry: m.registry, usdg: m.usdg, startBlock: m.deployedAtBlock },
  };
}

// ---------------------------------------------------------------------------
// Load + validate
// ---------------------------------------------------------------------------

function abs(base: string, p: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

/** Throws unless `path` is a digest-substituted release compose (not the PLACEHOLDER template). */
export function assertReleaseCompose(path: string): void {
  if (!existsSync(path)) throw new Error(`release compose not found: ${path}`);
  const text = readFileSync(path, "utf8");
  if (/PLACEHOLDER|IMAGE_REPO/.test(text)) {
    throw new Error(`${path} is the unsubstituted compose template — use releases/<version>.yml from runtime/scripts/release.sh`);
  }
  if (!/image:\s*\S+@sha256:[0-9a-f]{64}\s*$/m.test(text)) throw new Error(`${path}: no digest-pinned image line`);
}

export function effectiveLegModes(file: Pick<GenesisConfigFile, "seeding">): Record<LegId, LegMode> {
  const modes = { ...PROFILES[file.seeding.profile] };
  for (const id of LEG_IDS) {
    const o = file.seeding.legs[id];
    if (o?.mode !== undefined) modes[id] = o.mode;
  }
  return modes;
}

/** Parse + resolve + cross-check a config object whose relative paths resolve against `baseDir`. */
export function buildConfig(rawJson: unknown, baseDir: string): GenesisConfig {
  const f = GenesisConfigFileSchema.parse(rawJson);
  let contracts = f.contracts;
  if (f.deploymentManifest !== undefined) {
    const m = configFromDeployment(abs(baseDir, f.deploymentManifest));
    if (m.chainId !== f.chains.rh.chainId) throw new Error(`deployment manifest chainId ${m.chainId} ≠ chains.rh.chainId ${f.chains.rh.chainId}`);
    if (contracts !== undefined) {
      for (const k of ["factory", "registry", "usdg"] as const) {
        if (contracts[k] !== m.contracts[k]) throw new Error(`contracts.${k} ${contracts[k]} ≠ manifest ${m.contracts[k]}`);
      }
    }
    contracts = contracts ?? m.contracts;
  }
  if (contracts === undefined) throw new Error("config needs deploymentManifest (preferred) or contracts");

  const legModes = effectiveLegModes(f);
  for (const id of LEG_IDS) {
    const def = LEG_DEFS[id];
    if (legModes[id] !== "required") continue;
    if (def.asset === "turbo") {
      if (!f.turbo.enabled) throw new Error(`seed leg ${id} is required but turbo is not enabled`);
    } else if (f.chains[def.chain] === undefined) {
      throw new Error(`seed leg ${id} is required but chains.${def.chain} is not configured`);
    }
  }

  const composePath = abs(baseDir, f.release.composePath);
  assertReleaseCompose(composePath);
  const walletKeyPath = abs(baseDir, f.walletKeyPath);
  return {
    ...f,
    dataDir: abs(baseDir, f.dataDir),
    walletKeyPath,
    configInboxDir: abs(baseDir, f.configInboxDir),
    release: { composePath },
    contracts,
    oyster: {
      ...f.oyster,
      walletKeyFile: f.oyster.walletKeyFile === undefined ? walletKeyPath : abs(baseDir, f.oyster.walletKeyFile),
      durationMin: f.oyster.durationMin ?? PROFILE_DURATION_MIN[f.seeding.profile],
    },
    seeding: {
      ...f.seeding,
      preRegistrationGasWei: f.seeding.preRegistrationGasWei ?? (PRE_REGISTRATION_GAS_USD_MICRO * 10n ** 18n) / f.seeding.ethUsdMicro,
    },
    legModes,
  };
}

/** Projected Oyster rental per deploy, µUSDC: durationMin × rate (rounded up). */
export function projectedRentalMicroUsdc(oyster: Pick<GenesisConfig["oyster"], "durationMin" | "rateUsdcMicroPerHour">): bigint {
  return (BigInt(oyster.durationMin) * oyster.rateUsdcMicroPerHour + 59n) / 60n;
}

/** "durationMin 180 × 0.0512 USDC/h ⇒ projected rental 0.1536 USDC" */
export function describeRental(oyster: Pick<GenesisConfig["oyster"], "durationMin" | "rateUsdcMicroPerHour">): string {
  const usd = (micro: bigint): string => {
    const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return `${micro / 1_000_000n}${frac === "" ? "" : `.${frac}`}`;
  };
  return `durationMin ${oyster.durationMin} × ${usd(oyster.rateUsdcMicroPerHour)} USDC/h ⇒ projected rental ${usd(projectedRentalMicroUsdc(oyster))} USDC`;
}

export function loadConfig(path: string): GenesisConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`genesis config ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return buildConfig(raw, dirname(resolve(path)));
}
