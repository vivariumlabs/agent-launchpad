// M2 scaffold spec item 4. zod schemas for AgentConfig (docs/03-AGENT-RUNTIME.md §10)
// and PlatformConfig (SPEC-M2 §2, §3 DEFAULTs), plus a config-hash helper reusing
// approval.ts's canonical encoding.
//
// SPEC NOTE (flagged, not resolved here — see final report): SPEC-M2's rule text
// references `cfg.poolManager`, `cfg.registry`, `cfg.feeSplitHook`, `cfg.usdg` and
// the caps (e.g. `cfg.minRunwayDays`) as flat, chain-less fields, but this file's
// task spec explicitly calls for "per-chain addresses: registry, feeSplitHook,
// poolManager, usdg" and a nested `caps` object. Implemented exactly as instructed;
// `resolveConfig()` flattens `caps` onto the top level of `ResolvedConfig` to keep
// `cfg.minRunwayDays`-style access working, but `cfg.poolManager` etc. resolve to
// per-chain maps (`cfg.poolManager.rh`), not bare addresses. The engine author
// should confirm this against SPEC-M2's usage before wiring rules to it.

import { isAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { z } from "zod";
import { canonicalEncode } from "../policy/approval.js";
import type { OwnAddresses } from "../policy/types.js";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const chainSchema = z.enum(["rh", "base", "arbitrum", "optimism"]);

export const addressSchema = z.custom<Address>((v) => typeof v === "string" && isAddress(v), {
  message: "invalid address",
});

/** zod can't validate bigint from JSON directly — accept string|number|bigint and coerce. */
export const bigintCoerce = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((v): bigint => (typeof v === "bigint" ? v : BigInt(v)));

const chainAddressMapSchema = z.object({
  rh: addressSchema,
  base: addressSchema,
  arbitrum: addressSchema,
  optimism: addressSchema,
});

export const bytes32Schema = z.custom<Hex>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v), {
  message: "must be 32-byte hex",
});

const GWEI = 1_000_000_000n;

/** Per-chain bigint map with an `rh` default and a shared default for the other chains. */
function chainBigintMapSchema(rhDefault: bigint, otherDefault: bigint) {
  return z
    .object({
      rh: bigintCoerce.default(rhDefault),
      base: bigintCoerce.default(otherDefault),
      arbitrum: bigintCoerce.default(otherDefault),
      optimism: bigintCoerce.default(otherDefault),
    })
    .default({});
}

// ---------------------------------------------------------------------------
// AgentConfig — docs/03-AGENT-RUNTIME.md §10
// ---------------------------------------------------------------------------

export const AgentConfigSchema = z.object({
  agentId: z.number().int().positive(),
  name: z.string(),
  symbol: z.string(),
  archetype: z.enum(["trader", "artist", "poster", "degen", "sage"]),
  persona: z.string().max(2000),
  models: z.object({
    primary: z.string(),
    fallbacks: z.array(z.string()),
    chatTier: z.string(),
  }),
  // Partial overrides within platform-defined bounds only (03 §10); shape of
  // individual overrides is not further specified in SPEC-M2 — kept as an
  // open record of unknown values, validated/bounded by the engine, not here.
  budgets: z.record(z.string(), z.unknown()).default({}),
  social: z.object({
    postsPerDay: z.number().int().nonnegative(),
    repliesPerDay: z.number().int().nonnegative(),
  }),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ---------------------------------------------------------------------------
// PlatformConfig — SPEC-M2 §2 ("Platform constants include: ...") and §3 (caps DEFAULTs)
// ---------------------------------------------------------------------------

export const X402AllowlistEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(["inference", "data"]),
  operator: z.string(),
  url: z.string(),
  payTo: addressSchema,
  model: z.string(),
  tier: z.enum(["cheap", "standard"]),
  maxPricePerMTokUsd: bigintCoerce,
  attested: z.boolean(),
});

export type X402AllowlistEntry = z.infer<typeof X402AllowlistEntrySchema>;

export const InferenceCategoryWeightsSchema = z
  .object({
    pulse: z.number().int().nonnegative().default(6000),
    chat: z.number().int().nonnegative().default(2500),
    social: z.number().int().nonnegative().default(1500),
  })
  .default({ pulse: 6000, chat: 2500, social: 1500 });

export const CapsSchema = z
  .object({
    minRunwayDays: z.number().int().positive().default(45),
    /** I1 rev 2: runwayDays < this ⇒ inference deny(RUNWAY) (Dormant = no LLM calls, 01 §6). */
    dormantRunwayDays: bigintCoerce.default(3n),
    bridgeHaircutBps: z.number().int().nonnegative().default(50),
    allowancePctBps: z.number().int().nonnegative().default(500),
    allowanceCapUsdg: bigintCoerce.default(500_000000n),
    inferencePctBps: z.number().int().nonnegative().default(2500),
    inferenceFloorUsd: bigintCoerce.default(5_000000n),
    inferenceCapUsd: bigintCoerce.default(60_000000n),
    maxPerCallUsd: bigintCoerce.default(500000n),
    perTxPctBps: z.number().int().nonnegative().default(2000),
    counterpartyPctBps: z.number().int().nonnegative().default(3000),
    oysterRentalDailyCapUsdc: bigintCoerce.default(100_000000n),
    acrossBridgeDailyCapUsd: bigintCoerce.default(1000_000000n),
    arweaveDailyCapUsdg: bigintCoerce.default(10_000000n),
    gasTopUpDailyCapWeiPerChain: bigintCoerce.default(10n ** 16n),
    x402DataDailyCapUsdc: bigintCoerce.default(2_000000n),
    inferenceCategoryWeightsBps: InferenceCategoryWeightsSchema,
    // ---- SPEC-M2B §9 additions (all DEFAULTs Juan-revisable) ----
    /** §1 S1/S2: platform upper bounds on the agent's social.postsPerDay / repliesPerDay. */
    postsPerDayMax: z.number().int().nonnegative().default(8),
    repliesPerDayMax: z.number().int().nonnegative().default(30),
    /** §1 J1 */
    journalDailyCap: z.number().int().nonnegative().default(4),
    journalMaxBytes: bigintCoerce.default(65_536n),
    /** §2 K2 fill bounds */
    maxGasLimit: bigintCoerce.default(2_000_000n),
    maxFeePerGasWei: chainBigintMapSchema(GWEI, 10n * GWEI),
    /** §3 acrossBridge outputAmount = amount × (10000 − bps) / 10000 */
    bridgeMaxFeeBps: z.number().int().nonnegative().max(10_000).default(100),
    /** §6 pulse */
    toolCallCap: z.number().int().positive().default(5),
    stretchThresholdBps: z.number().int().nonnegative().default(2000),
    postMaxBytes: z.number().int().positive().default(320),
    /** §5 LLM endpoint health */
    contractFailureLimit: z.number().int().positive().default(3),
    unhealthyCooldownSec: z
      .object({
        price: bigintCoerce.default(21_600n),
        contract: bigintCoerce.default(3_600n),
        canary: bigintCoerce.default(86_400n),
      })
      .default({}),
    /** §7 daemon */
    rentalTargetDays: z.number().int().positive().default(60),
    inferenceRefillDaysMin: z.number().int().positive().default(3),
    inferenceRefillDaysTarget: z.number().int().positive().default(10),
    inferenceMinRefillUsd: bigintCoerce.default(15_000000n),
    distributeThresholdUsdg: bigintCoerce.default(50_000000n),
    swapSlippageBps: z.number().int().nonnegative().max(10_000).default(200),
    gasFloorWei: chainBigintMapSchema(10n ** 15n, 3n * 10n ** 15n),
    gasTargetWei: chainBigintMapSchema(3n * 10n ** 15n, 10n ** 16n),
    /** ADDITIVE (Job D): daemon tick interval, seconds (6 h DEFAULT). */
    daemonIntervalSec: bigintCoerce.default(21_600n),
  })
  .default({});

export type Caps = z.infer<typeof CapsSchema>;

export const PlatformConfigSchema = z.object({
  registry: chainAddressMapSchema,
  feeSplitHook: chainAddressMapSchema,
  poolManager: chainAddressMapSchema,
  usdg: chainAddressMapSchema,
  across: z.object({
    spokePool: chainAddressMapSchema,
  }),
  marlin: z.object({
    paymentAddresses: z.array(addressSchema),
  }),
  arweaveFundingAddress: addressSchema,
  x402Allowlist: z.array(X402AllowlistEntrySchema),
  caps: CapsSchema,
  // ---- SPEC-M2B §9 additions ----
  /** Per-chain USDC token addresses (treasuryTransfer USDC, acrossBridge). */
  usdc: chainAddressMapSchema,
  /**
   * ADDITIVE (Job A, flagged): per-chain wrapped-native token — Across depositV3
   * takes inputToken = WETH with msg.value for native ETH bridges. Optional:
   * buildTx throws for an ETH bridge when absent.
   */
  weth: chainAddressMapSchema.optional(),
  /** EVM chain ids; testnet overrides via config file. */
  chainIds: z
    .object({
      rh: z.number().int().positive().default(4663),
      base: z.number().int().positive().default(8453),
      arbitrum: z.number().int().positive().default(42161),
      optimism: z.number().int().positive().default(10),
    })
    .default({}),
  /** RH PoolSwapTest router (contracts/deployments/*.json "swapRouter"). */
  swapRouter: z.object({ rh: addressSchema }),
  /** Absent in contracts/deployments/testnet-46630.json ⇒ actionLp NotImplemented. */
  modifyLiquidityRouter: z.object({ rh: addressSchema.optional() }).default({}),
  /** contracts/script/support/LaunchpadScript.sol:28-29 (POOL_FEE = 0, TICK_SPACING = 60). */
  poolFee: z.number().int().nonnegative().max(1_000_000).default(0),
  tickSpacing: z.number().int().positive().max(32_767).default(60),
  /** EIP-712 domain of Base USDC (EIP-3009 TransferWithAuthorization, K3). */
  usdcDomain: z.object({
    base: z.object({
      name: z.string(),
      version: z.string(),
      chainId: z.number().int().positive(),
      verifyingContract: addressSchema,
    }),
  }),
  /** Set at genesis; test fixtures provide. */
  agentTokenAddress: addressSchema.optional(),
  agentPoolId: bytes32Schema.optional(),
  /**
   * ADDITIVE (Job A, flagged): AgentRegistry.registerInstance also takes
   * (codeHash, attestationRef) — contracts/src/AgentRegistry.sol:68. Optional;
   * buildTx(registerInstance) throws when absent.
   */
  registration: z.object({ codeHash: bytes32Schema, attestationRef: z.string() }).optional(),
});

export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;

// ---------------------------------------------------------------------------
// ResolvedConfig = platform + agent + OwnAddresses
// ---------------------------------------------------------------------------

export type ResolvedConfig = Omit<PlatformConfig, "caps"> &
  Caps & {
    agent: AgentConfig;
  } & OwnAddresses;

export interface ResolveConfigInput {
  platform: unknown;
  agent: unknown;
  ownAddresses: OwnAddresses;
}

/** Validates platform + agent JSON with defaults applied, merges with OwnAddresses. */
export function resolveConfig(input: ResolveConfigInput): ResolvedConfig {
  const platform = PlatformConfigSchema.parse(input.platform);
  const agent = AgentConfigSchema.parse(input.agent);
  const { caps, ...platformRest } = platform;
  return {
    ...platformRest,
    ...caps,
    agent,
    ...input.ownAddresses,
  };
}

/** Same canonical encoding as approval.ts, for hashing the stored config JSON. */
export function configHash(json: unknown): Hex {
  return keccak256(stringToBytes(canonicalEncode(json)));
}
