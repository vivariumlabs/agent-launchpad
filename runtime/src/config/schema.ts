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
