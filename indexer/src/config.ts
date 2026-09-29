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
    /** v1 only (SPEC-M4G R7: retired; kept in the v1 manifest for the as-built record, not indexed). */
    treasuryBuyback: addressLike.optional(),
    /** SPEC-M4G: v2 floor vault + platform token (D18). */
    floorVault: addressLike.optional(),
    platformToken: addressLike.optional(),
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
    /**
     * SPEC-M4G §3: older stacks that stay indexed (dual-stack), each a deployments manifest path
     * relative to the config file. `deploymentManifest` is the PRIMARY (newest) stack.
     */
    legacyManifests: z.array(z.string().min(1)).optional(),
    /** Explicit addresses (must equal the primary manifest's when both are given). */
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
    /** M4A debt (a): unresolved swap tx senders resolved per watcher poll DEFAULT 25. */
    senderBackfillPerPoll: z.number().int().positive().default(25),
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

/** The PRIMARY stack's addresses (+ shared usdg / poolManager). */
export interface ContractsCfg {
  factory: Address;
  registry: Address;
  hook: Address;
  distributor: Address;
  /** v1 only (SPEC-M4G R7). */
  treasuryBuyback?: Address;
  floorVault?: Address;
  platformToken?: Address;
  poolManager: Address;
  nft: Address;
  usdg: Address;
  startBlock: bigint;
}

/**
 * SPEC-M4G §3 — one deployed contract stack. Stacks share USDG + the v4 PoolManager and issue
 * disjoint agent-id ranges (R2: v1 = 1.., v2 = 101..), so an agentId names its stack.
 */
export interface StackCfg {
  /** manifest `stackVersion` (DEFAULT 1 when absent). */
  version: number;
  /** manifest `legacy` (DEFAULT false). */
  legacy: boolean;
  factory: Address;
  registry: Address;
  hook: Address;
  distributor: Address;
  nft: Address;
  /** manifest deployedAtBlock. */
  startBlock: bigint;
  /** manifest `firstAgentId` (DEFAULT 1). */
  firstAgentId: number;
}

/** SPEC-M4G §3 the floor vault (D18) + the platform token it redeems — from the primary manifest. */
export interface FloorCfg {
  vault: Address;
  token: Address;
}

/** Everything the watcher indexes: every stack (primary first) + the shared contracts + the floor. */
export interface ChainContracts {
  stacks: StackCfg[];
  usdg: Address;
  poolManager: Address;
  floor: FloorCfg | null;
}

/**
 * The stack an agentId belongs to (R2 disjoint ranges): the stack with the greatest
 * firstAgentId ≤ agentId. undefined when agentId is below every stack's range.
 */
export function stackForAgent<S extends { firstAgentId: number }>(stacks: readonly S[], agentId: number): S | undefined {
  let best: S | undefined;
  for (const s of stacks) if (s.firstAgentId <= agentId && (best === undefined || s.firstAgentId > best.firstAgentId)) best = s;
  return best;
}

/** GET /api/contracts `stacks[]` entry (StackCfg with JSON-number startBlock). */
export interface StackView {
  version: number;
  legacy: boolean;
  factory: string;
  registry: string;
  hook: string;
  distributor: string;
  nft: string;
  startBlock: number;
  firstAgentId: number;
}

export function stackViewOf(s: StackCfg): StackView {
  return {
    version: s.version,
    legacy: s.legacy,
    factory: s.factory,
    registry: s.registry,
    hook: s.hook,
    distributor: s.distributor,
    nft: s.nft,
    startBlock: Number(s.startBlock),
    firstAgentId: s.firstAgentId,
  };
}

/**
 * SPEC-M4E §2 / R5 — GET /api/contracts body: chainId + every address the deployments manifest
 * carries (checksummed; non-address keys such as hookSalt / deployedAtBlock omitted), or the
 * explicit `contracts` addresses when the config names no manifest. Web carries NO hardcoded addresses.
 */
export type ContractsView = { chainId: number; stacks?: StackView[] } & Record<string, string | number | StackView[]>;

export type IndexerConfig = Omit<IndexerConfigFile, "contracts" | "deploymentManifest" | "legacyManifests" | "chain"> & {
  chain: { rpc: string[]; chainId: number };
  /** The PRIMARY stack (+ shared usdg / poolManager). */
  contracts: ContractsCfg;
  /** SPEC-M4G §3: every stack, primary first. */
  stacks: StackCfg[];
  /** Shared across stacks (asserted equal). */
  usdg: Address;
  poolManager: Address;
  /** From the primary manifest; null when it names no floorVault (v1-only config). */
  floor: FloorCfg | null;
  contractsView: ContractsView;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** ContractsView from the resolved contracts + (optionally) the raw manifest's other address-valued keys. */
export function contractsViewOf(chainId: number, contracts: ContractsCfg, manifestRaw: unknown, stacks?: readonly StackCfg[]): ContractsView {
  const view: ContractsView = { chainId };
  if (manifestRaw !== null && typeof manifestRaw === "object" && !Array.isArray(manifestRaw)) {
    for (const [k, v] of Object.entries(manifestRaw as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (k !== "chainId" && typeof v === "string" && ADDRESS_RE.test(v)) view[k] = getAddress(v);
    }
  }
  for (const k of CONTRACT_KEYS) {
    const v = contracts[k];
    if (v !== undefined) view[k] = v;
  }
  if (stacks !== undefined) view.stacks = stacks.map(stackViewOf);
  return view;
}

const ManifestSchema = z
  .object({
    chainId: z.number().int().positive(),
    deployedAtBlock: bigintLike,
    factory: addressLike,
    registry: addressLike,
    hook: addressLike,
    distributor: addressLike,
    /** v1 only (SPEC-M4G R7). */
    treasuryBuyback: addressLike.optional(),
    poolManager: addressLike,
    nft: addressLike,
    usdg: addressLike,
    /** SPEC-M4G v2 keys. */
    floorVault: addressLike.optional(),
    platformToken: addressLike.optional(),
    firstAgentId: z.number().int().positive().optional(),
    stackVersion: z.number().int().positive().optional(),
    legacy: z.boolean().optional(),
  })
  .passthrough();

const CONTRACT_KEYS = ["factory", "registry", "hook", "distributor", "treasuryBuyback", "floorVault", "platformToken", "poolManager", "nft", "usdg"] as const;

export interface DeploymentCfg {
  chainId: number;
  contracts: ContractsCfg;
  stack: StackCfg;
}

/** Reads contracts/deployments/<net>.json → addresses + scan start block + chain id + its stack. */
export function configFromDeployment(manifestPath: string): DeploymentCfg {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(`deployment manifest ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let m: z.infer<typeof ManifestSchema>;
  try {
    m = ManifestSchema.parse(raw);
  } catch (e) {
    throw new Error(`deployment manifest ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if ((m.floorVault === undefined) !== (m.platformToken === undefined)) {
    throw new Error(`deployment manifest ${manifestPath}: floorVault and platformToken must be given together`);
  }
  return {
    chainId: m.chainId,
    contracts: {
      factory: m.factory,
      registry: m.registry,
      hook: m.hook,
      distributor: m.distributor,
      ...(m.treasuryBuyback === undefined ? {} : { treasuryBuyback: m.treasuryBuyback }),
      ...(m.floorVault === undefined ? {} : { floorVault: m.floorVault }),
      ...(m.platformToken === undefined ? {} : { platformToken: m.platformToken }),
      poolManager: m.poolManager,
      nft: m.nft,
      usdg: m.usdg,
      startBlock: m.deployedAtBlock,
    },
    stack: stackOf(
      { factory: m.factory, registry: m.registry, hook: m.hook, distributor: m.distributor, nft: m.nft, startBlock: m.deployedAtBlock },
      { version: m.stackVersion, legacy: m.legacy, firstAgentId: m.firstAgentId },
    ),
  };
}

function stackOf(
  c: Pick<ContractsCfg, "factory" | "registry" | "hook" | "distributor" | "nft" | "startBlock">,
  meta: { version?: number | undefined; legacy?: boolean | undefined; firstAgentId?: number | undefined },
): StackCfg {
  return {
    version: meta.version ?? 1,
    legacy: meta.legacy ?? false,
    factory: c.factory,
    registry: c.registry,
    hook: c.hook,
    distributor: c.distributor,
    nft: c.nft,
    startBlock: c.startBlock,
    firstAgentId: meta.firstAgentId ?? 1,
  };
}

function abs(base: string, p: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

/** Parse + resolve + cross-check a config object whose relative paths resolve against `baseDir`. */
export function buildConfig(rawJson: unknown, baseDir: string): IndexerConfig {
  const f = IndexerConfigFileSchema.parse(rawJson);
  let contracts = f.contracts;
  let manifestRaw: unknown = null;
  let primary: StackCfg | undefined;
  if (f.deploymentManifest !== undefined) {
    const m = configFromDeployment(abs(baseDir, f.deploymentManifest));
    manifestRaw = JSON.parse(readFileSync(abs(baseDir, f.deploymentManifest), "utf8")) as unknown;
    if (m.chainId !== f.chain.chainId) throw new Error(`deployment manifest chainId ${m.chainId} ≠ chain.chainId ${f.chain.chainId}`);
    if (contracts !== undefined) {
      for (const k of CONTRACT_KEYS) {
        if (contracts[k] !== m.contracts[k]) throw new Error(`contracts.${k} ${String(contracts[k])} ≠ manifest ${String(m.contracts[k])}`);
      }
    }
    contracts = contracts ?? m.contracts;
    primary = m.stack;
  }
  if (contracts === undefined) throw new Error("config needs deploymentManifest (preferred) or contracts");
  if ((contracts.floorVault === undefined) !== (contracts.platformToken === undefined)) {
    throw new Error("contracts: floorVault and platformToken must be given together");
  }
  primary ??= stackOf(contracts, {});

  // SPEC-M4G §3 legacy stacks: same chain, same USDG + PoolManager (R1), distinct contracts.
  const stacks: StackCfg[] = [primary];
  for (const p of f.legacyManifests ?? []) {
    const m = configFromDeployment(abs(baseDir, p));
    if (m.chainId !== f.chain.chainId) throw new Error(`legacy manifest ${p}: chainId ${m.chainId} ≠ chain.chainId ${f.chain.chainId}`);
    if (m.contracts.usdg !== contracts.usdg) throw new Error(`legacy manifest ${p}: usdg ${m.contracts.usdg} ≠ primary usdg ${contracts.usdg} (stacks must share USDG)`);
    if (m.contracts.poolManager !== contracts.poolManager) {
      throw new Error(`legacy manifest ${p}: poolManager ${m.contracts.poolManager} ≠ primary poolManager ${contracts.poolManager} (stacks must share the PoolManager)`);
    }
    stacks.push(m.stack);
  }
  const seen = new Set<string>();
  for (const s of stacks) {
    for (const a of [s.factory, s.registry, s.hook, s.distributor, s.nft]) {
      if (seen.has(a)) throw new Error(`stack v${s.version}: address ${a} appears in more than one stack (duplicate manifest?)`);
      seen.add(a);
    }
  }
  const ids = new Set<number>();
  for (const s of stacks) {
    if (ids.has(s.firstAgentId)) throw new Error(`two stacks share firstAgentId ${s.firstAgentId} — agent-id ranges must be disjoint (SPEC-M4G R2)`);
    ids.add(s.firstAgentId);
  }

  const floor: FloorCfg | null = contracts.floorVault !== undefined && contracts.platformToken !== undefined ? { vault: contracts.floorVault, token: contracts.platformToken } : null;
  const { deploymentManifest: _m, legacyManifests: _l, contracts: _c, ...rest } = f;
  return {
    ...rest,
    chain: { rpc: typeof f.chain.rpc === "string" ? [f.chain.rpc] : f.chain.rpc, chainId: f.chain.chainId },
    dbPath: f.dbPath === ":memory:" ? f.dbPath : abs(baseDir, f.dbPath),
    ...(f.releasesDir === undefined ? {} : { releasesDir: abs(baseDir, f.releasesDir) }),
    contracts,
    stacks,
    usdg: contracts.usdg,
    poolManager: contracts.poolManager,
    floor,
    contractsView: contractsViewOf(f.chain.chainId, contracts, manifestRaw, stacks),
  };
}

/** The watcher's contract set from a resolved config. */
export function chainContractsOf(cfg: Pick<IndexerConfig, "stacks" | "usdg" | "poolManager" | "floor">): ChainContracts {
  return { stacks: cfg.stacks, usdg: cfg.usdg, poolManager: cfg.poolManager, floor: cfg.floor };
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
