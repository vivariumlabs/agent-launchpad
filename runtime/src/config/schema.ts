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

import { readFileSync } from "node:fs";
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
  /**
   * SPEC-M3B §4 (ADDITIVE, Job M): adopt newer platform-signed allowlists (04 §4 opt-in, chosen by the
   * creator at genesis ⇒ FROZEN). DEFAULT true — optional so an absent field (every pre-M3B agent.json)
   * keeps its frozen hash; read it ONLY through adoptsAllowlistUpdates(). false ⇒ never fetches.
   */
  adoptAllowlistUpdates: z.boolean().optional(),
});

/** SPEC-M3B §4: DEFAULT true (absent ⇒ opted in); only an explicit `false` opts out. */
export function adoptsAllowlistUpdates(agent: Pick<AgentConfig, "adoptAllowlistUpdates">): boolean {
  return agent.adoptAllowlistUpdates !== false;
}

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
    // ---- SPEC-M2C §1 chat server (ADDITIVE, Job E; all DEFAULTs Juan-revisable) ----
    /** HTTP port of the chat server (TLS terminates in-enclave from M3). */
    chatPort: z.number().int().min(0).max(65_535).default(8420),
    /** Max chars (UTF-16 units) of one chat message. */
    chatMaxChars: z.number().int().positive().default(2000),
    /** D9 gate: pass iff agentTokenBal ≥ agentSupply × this / 10000 (0.1%) … */
    chatAgentGateBps: z.number().int().nonnegative().max(10_000).default(10),
    /** … OR platformTokenBal ≥ platformSupply × this / 10000 (1%). */
    chatPlatformGateBps: z.number().int().nonnegative().max(10_000).default(100),
    /** Per-wallet rate limits: sliding hour + UTC day (counted from `chats` dir 'in'). */
    chatPerHour: z.number().int().nonnegative().default(20),
    chatPerDay: z.number().int().nonnegative().default(100),
    /** Chat context: last N exchanges of THIS wallet's history. */
    chatHistoryMax: z.number().int().nonnegative().default(10),
    /** Session token lifetime (exp = now + this). */
    chatSessionTtlSec: bigintCoerce.default(3_600n),
    /** SIWE nonce lifetime (single-use). */
    chatNonceTtlSec: bigintCoerce.default(300n),
    /** Dual-RPC balance read timeout (both reads), ms. */
    chatGateTimeoutMs: z.number().int().positive().default(3000),
    // ---- SPEC-M3 §3 x402 HTTP transport (ADDITIVE, Job J) ----
    /** Per-request timeout of the x402 inference HTTP transport, ms (30 s DEFAULT). */
    x402HttpTimeoutMs: z.number().int().positive().default(30_000),
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
  // ---- SPEC-M2C §1 chat server (ADDITIVE, Job E) ----
  /** SIWE domain the chat server accepts (EIP-4361 `domain`). Required to construct the chat server. */
  chatDomain: z.string().min(1).optional(),
  /** Two INDEPENDENT RPC endpoints for the dual balance read (D9). */
  chatRpc: z.array(z.string().min(1)).length(2).optional(),
  /** Platform token ($TOKEN) address on RH — second leg of the D9 chat gate. */
  platformTokenAddress: addressSchema.optional(),
  // ---- SPEC-M3 §3b (ADDITIVE, rev 1) ----
  /**
   * Platform signer for 04 §4 signed allowlist updates (SPEC-M3B §4; renamed from allowlistUpdatePubkey —
   * it is an ADDRESS). Lives in the FROZEN config, so it is covered by the attested config-hash binding.
   * Verification = EIP-191 personal_sign recovery (viem recoverMessageAddress) over canonicalEncode(payload)
   * — src/llm/allowlistUpdate.ts. Absent ⇒ no update can ever be adopted.
   */
  allowlistUpdateSigner: addressSchema.optional(),
  // ---- SPEC-M3B §2 (ADDITIVE, Job L) ----
  /**
   * DNS root of agent chat endpoints: the agent serves TLS as `a<agentId>.<agentDnsRoot>` (in-enclave
   * ACME). FROZEN — the domain an agent answers on is spend-adjacent identity (holders sign SIWE to it).
   * Required when runtime.tls.enabled; otherwise unused.
   */
  agentDnsRoot: z
    .string()
    .regex(/^(?=.{1,240}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, "must be a lowercase hostname")
    .optional(),
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

// ---------------------------------------------------------------------------
// SPEC-M3 §3b — config split: FROZEN identity config (agent.json) + mutable ops config (runtime.json)
// ---------------------------------------------------------------------------
//
// agent.json = { platform, agent } — everything money/authority-bearing: addresses, x402 allowlist,
// caps, agent identity/persona/models/social/adoptAllowlistUpdates, allowlistUpdateSigner. Its frozenHash =
// keccak256(canonicalEncode(file JSON)) is passed as the ATTESTED Oyster init param `config-hash`, so
// the KMS keys bind to (codeHash, agentId, configHash); boot refuses when the file hashes differently.
// runtime.json = the ops section (RPC urls, ports, dirs, KMS/attestation urls, x402 toggle, hosting
// stand-in, dbPath…): unattested, not hash-bound, and must carry NO spend authority — a hostile
// runtime.json can lie about chain state (waste/denial) but cannot redirect funds.

const optionalUrl = z.string().url().optional();

/** runtime.json — mutable ops config (was the `runtime` section of the single-file config). */
export const RuntimeOpsConfigSchema = z
  .object({
    /** M2 MockKms derivation inputs (fixture). Real Nautilus KMS = M3; opts.kms overrides. */
    mockKms: z.object({ imageId: z.string().min(1), agentId: z.string().min(1) }).strict().optional(),
    /** Memory DB path, relative to the ops config file (DEFAULT "memory.sqlite"); opts.dbPath overrides. */
    dbPath: z.string().min(1).optional(),
    /** Snapshot dir (mock Arweave), relative to the ops config file (DEFAULT "snapshots"). */
    snapshotDir: z.string().min(1).optional(),
    /** Per-chain RPC urls. Any set ⇒ RealChainClient (src/exec/chainViem.ts) over those chains. */
    rpc: z.object({ rh: optionalUrl, base: optionalUrl, arbitrum: optionalUrl, optimism: optionalUrl }).strict().default({}),
    /**
     * M2 stand-in for the Oyster rental reader (no Marlin reads in ChainClient yet):
     * current rental expiry (unix s) + live rate (USDC(6)/day). Absent ⇒ rate 0 (infinite runway).
     */
    hosting: z.object({ paidUntil: bigintCoerce, ratePerDay: bigintCoerce }).strict().optional(),
    /** Chat server bind address (DEFAULT "127.0.0.1"; the enclave passes its ingress address). */
    chatHost: z.string().min(1).optional(),
    // ---- SPEC-M3 §2 (ADDITIVE, Job I) ----
    /** true ⇒ NautilusKms + boot attestation → cfg.registration (DEFAULT false: MockKms, no attestation). */
    tee: z.boolean().default(false),
    /** Nautilus KMS base URL (DEFAULT http://127.0.0.1:1100); localhost only (constructor refuses others). */
    kmsUrl: z.string().url().optional(),
    /** Raw attestation URL (DEFAULT http://127.0.0.1:1300/attestation/raw); localhost only. */
    attestationUrl: z.string().url().optional(),
    /**
     * Enclave image id (32-byte hex) = the registry codeHash. REQUIRED when tee: true. Supplied by
     * the deployer (scripts/compute-image-id.sh): the enclave cannot self-derive its own
     * measurement before attestation, and parsing the quote in-enclave is out of scope (§2).
     */
    imageId: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 32-byte hex").optional(),
    /** Container image digest (e.g. "sha256:…") recorded in the attestation report (04 §5). */
    imageDigest: z.string().min(1).optional(),
    /** Attestation report dir (LocalDirSink), relative to the ops config file (DEFAULT "attestations"). */
    attestationDir: z.string().min(1).optional(),
    // ---- M3 s1 review (ADDITIVE) ----
    /**
     * Oyster init-params dir (DEFAULT "/init-params"; relative ⇒ to the ops config file). If
     * <dir>/agent-id exists, boot refuses unless it equals "agent-<agent.agentId>"; <dir>/config-hash
     * must equal the frozen config hash (REQUIRED when tee: true — SPEC-M3 §3b). tee: true ⇒ must be
     * unset (or "/init-params"): this file is unattested and may not relocate the attested params.
     */
    initParamsDir: z.string().min(1).optional(),
    /**
     * Real x402 HTTP transport (SPEC-M3 §3). DEFAULT disabled ⇒ overrides.x402/llm (mocks).
     * allowInsecureHttp: permit http:// endpoint URLs (local testing ONLY; DEFAULT false).
     */
    x402: z.object({ enabled: z.boolean(), allowInsecureHttp: z.boolean().optional() }).strict().default({ enabled: false }),
    // ---- SPEC-M3B §2 (ADDITIVE, Job L) ----
    /**
     * In-enclave TLS ingress (DEFAULT disabled ⇒ plain-HTTP chat as before). enabled ⇒ chat listens
     * with TLS on `port` (DEFAULT 443; host DEFAULT "0.0.0.0" unless chatHost is set), serving
     * a<agentId>.<platform.agentDnsRoot> via ACME TLS-ALPN-01 against acmeDirectoryUrl (DEFAULT
     * Let's Encrypt production); certs under `dir` (DEFAULT <dir of dbPath>/tls ⇒ /data/tls).
     */
    tls: z
      .object({
        enabled: z.boolean().default(false),
        acmeDirectoryUrl: z.string().url().optional(),
        port: z.number().int().min(0).max(65_535).optional(),
        dir: z.string().min(1).optional(),
        /** Seconds between failed first-issuance attempts (DEFAULT 300). */
        retrySec: z.number().int().positive().optional(),
      })
      .strict()
      .default({ enabled: false }),
    // ---- SPEC-M3B §3 (ADDITIVE, Job L) ----
    /**
     * Turbo/Arweave publishing (DEFAULT disabled ⇒ LocalDirSink only). enabled ⇒ TurboArweaveSink for
     * BOTH attestation reports and snapshots; localMirror (DEFAULT true) keeps the LocalDirSink copies.
     */
    arweave: z
      .object({
        enabled: z.boolean().default(false),
        localMirror: z.boolean().default(true),
        /** DEFAULT https://upload.ardrive.io/v1/tx (attestation/turboHttp.ts). */
        uploadUrl: z.string().url().optional(),
        /** Turbo payment service (balance / price reads). DEFAULT https://payment.ardrive.io/v1. */
        paymentUrl: z.string().url().optional(),
        /** Arweave gateway (GraphQL list + data reads). DEFAULT https://arweave.net. */
        gatewayUrl: z.string().url().optional(),
      })
      .strict()
      .default({ enabled: false, localMirror: true }),
    // ---- SPEC-M3B §4 (ADDITIVE, Job M) ----
    /**
     * Where the daemon fetches the platform-signed allowlist update (https; transport UNTRUSTED — only
     * the signature by the FROZEN platform.allowlistUpdateSigner counts). Unset ⇒ no update checks.
     */
    allowlistUpdateUrl: z.string().url().optional(),
    /** Seconds between update checks (daemon step 11; DEFAULT 86 400 = once per day). */
    allowlistUpdateIntervalSec: z.number().int().positive().optional(),
    // ---- SPEC-M3C §10 (ADDITIVE) ----
    /**
     * Max seconds boot waits for the treasury's rh gas (orchestrator preGas) before sending
     * registerInstance (DEFAULT 600; 0 ⇒ no wait). Liveness knob only — no spend authority.
     */
    registrationGasWaitSec: z.number().int().nonnegative().optional(),
  })
  .strict()
  .default({});

export type RuntimeOpsConfig = z.infer<typeof RuntimeOpsConfigSchema>;

/** agent.json envelope — exactly { platform, agent } (strict: no ops keys, no extras). */
export const FrozenConfigFileSchema = z.object({ platform: z.unknown(), agent: z.unknown() }).strict();

/** Validated frozen config (defaults applied). */
export interface FrozenConfig {
  platform: PlatformConfig;
  agent: AgentConfig;
}

/**
 * keccak256(canonicalEncode(frozen JSON)) over the RAW parsed file (before zod defaults), so the
 * value is independent of whitespace and key order and reproducible by anyone holding the file.
 * In legacy single-file mode it is computed over { platform, agent } of that file — the same value
 * the split agent.json of identical content yields.
 */
export function frozenConfigHash(frozenJson: { platform: unknown; agent: unknown }): Hex {
  return configHash({ platform: frozenJson.platform, agent: frozenJson.agent });
}

/** Refuse-to-boot on a config hash mismatch (03 §10). Legacy: whole file; split: the frozen agent.json. */
export class ConfigHashMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: Hex,
  ) {
    super(`config hash mismatch: expected ${expected}, file hashes to ${actual} — refusing to boot (03 §10)`);
    this.name = "ConfigHashMismatchError";
  }
}

export interface LoadSplitConfigInput {
  /** Frozen identity config (agent.json). */
  agentPath: string;
  /** Mutable ops config (runtime.json). */
  runtimePath: string;
  /** Optional extra check (orchestrator convenience): must equal frozenHash, checked BEFORE schema validation. */
  expectedHash?: string;
}

export interface SplitConfig {
  /** Raw parsed agent.json (what frozenHash is computed over). */
  frozenJson: { platform: unknown; agent: unknown };
  frozen: FrozenConfig;
  ops: RuntimeOpsConfig;
  frozenHash: Hex;
  /**
   * ResolvedConfig (unchanged shape) for the KMS-derived OwnAddresses. A function rather than a value:
   * the addresses come from the KMS, which boot must not touch before the hash checks pass.
   */
  resolve(ownAddresses: OwnAddresses): ResolvedConfig;
}

function readJson(path: string, what: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} ${path}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Loads + validates agent.json (frozen) and runtime.json (ops). Throws on any invalid file or hash mismatch. */
export function loadSplitConfig(input: LoadSplitConfigInput): SplitConfig {
  const rawFrozen = readJson(input.agentPath, "agent config");
  const rawOps = readJson(input.runtimePath, "runtime config");
  const envelope = FrozenConfigFileSchema.safeParse(rawFrozen);
  if (!envelope.success) {
    throw new Error(`agent config ${input.agentPath}: must be exactly { platform, agent } (ops settings belong in runtime.json): ${envelope.error.message}`);
  }
  const frozenJson = { platform: envelope.data.platform, agent: envelope.data.agent };
  const frozenHash = frozenConfigHash(frozenJson);
  if (input.expectedHash !== undefined && input.expectedHash.toLowerCase() !== frozenHash.toLowerCase()) {
    throw new ConfigHashMismatchError(input.expectedHash, frozenHash);
  }
  const frozen: FrozenConfig = { platform: PlatformConfigSchema.parse(frozenJson.platform), agent: AgentConfigSchema.parse(frozenJson.agent) };
  const ops = RuntimeOpsConfigSchema.parse(rawOps);
  return {
    frozenJson,
    frozen,
    ops,
    frozenHash,
    resolve: (ownAddresses) => resolveConfig({ platform: frozenJson.platform, agent: frozenJson.agent, ownAddresses }),
  };
}
