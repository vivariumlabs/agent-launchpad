// SPEC-M4B §2 / R4 — launch-helper: a small, SECRET-FREE JSON service that predicts everything a
// creator must pin in `createAgent` BEFORE paying: the frozen agent.json, its configHash (the
// runtime's own canonicalEncode + keccak via canonical.ts — single-sourced), the enclave image-id
// (`oyster-cvm compute-image-id`, injected Exec) and the KMS-derived treasury / action EOAs (public
// KMS derive endpoint, kmsDerive.ts). NO wallet, NO key, NO spend path: it never reads walletKeyPath
// and never signs or sends a transaction (the web's wagmi flow does, from the creator's wallet).
//
//   GET  /api/launch/template  → { platform, defaults: { archetypes, models, creationFeeUsdg, social, chatTier },
//                                  composeVersion, rubricVersion }
//   POST /api/launch/prepare   body { agent: { name, symbol, archetype, persona, models: { primary, fallbacks, chatTier? } } }
//        400 { error, issues }         malformed body / unknown model
//        422 { error, rubricVersion, violations }   R5 moderation (appended to <dataDir>/launch-helper/moderation-rejections.jsonl)
//        502 { error, stage, reason }  RPC / compute-image-id / KMS failure — NEVER a partial prediction
//        200 { predicted: true, note, agentId, agentJson, agentJsonText, configHash, imageId, expectedTreasuryEOA, actionEOA,
//              createArgs: { factory, usdg, fee }, composeVersion, rubricVersion }
//        agentJsonText (SPEC-M4E §1b) = the EXACT file text whose frozenConfigHash is configHash — the
//        client round-trips these bytes to /publish (never re-serializes the object).
//   POST /api/launch/publish   body { agentJsonText, configHash? }   (SPEC-M4E §1b / R3)
//        uploads the exact text to Arweave (arweavePublish.ts: ephemeral key, free < 100 KiB, §1a tags)
//        400 malformed body · 413 text over the free-upload limit · 422 { error: config_invalid |
//        config_hash_mismatch | moderation } · 502 { error, stage: "arweave-upload", reason } ·
//        503 publishing not configured · 200 { txId, ref: "ar://<txId>", configHash }
//        One JSONL line per upload attempt → <dataDir>/launch-helper/publishes.jsonl.
//   GET  /api/revive/quote/:agentId · POST /api/revive · GET /api/revive/status/:agentId   (SPEC-M4F §1)
//        see src/reviveApi.ts. Enabled when the config has launchHelper.genesisDb + launchHelper.revivalPayTo
//        + chains.arbitrum; otherwise 503 "manual mode" with the orchestrator-less revival instructions.
//
// Race honesty: agentId = factory agentCount() + 1 at prepare time. A concurrent createAgent can take
// that id; configHash, imageId and both EOAs all bind to agentId, so the UI MUST compare the
// AgentRequested(agentId) of its receipt and re-prepare on mismatch (`predicted: true`).
//
// The platform section = platformTemplate's `platform` (per-agent keys stripped) overlaid with the
// genesis config's contract addresses (deployment manifest) and, when configured, the allowlist file.
//
// The node:http listener lives in bin/launch-helper.ts (genesis/src is network-module-free by the
// hygiene test); everything testable is here, behind injected seams (Exec via Oyster, HttpClient via
// KmsDeriver, FactoryReader, RejectionSink, Clock).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAddress, type Address } from "viem";
import { z } from "zod";
import { ConfigInvalid, createEphemeralUploader, frozenTextHash, MAX_CONFIG_TEXT_BYTES, publishFrozenConfig } from "./arweavePublish.js";
import { frozenConfigHash } from "./canonical.js";
import { systemClock, type Clock } from "./clock.js";
import type { GenesisConfig, LaunchHelperCfg } from "./config.js";
import { buildConfigSource, type ArweaveReader } from "./configSource.js";
import { GenesisDb } from "./db.js";
import { errMsg } from "./errors.js";
import { nodeExec } from "./exec.js";
import { fetchHttp, type HttpClient } from "./http.js";
import { PublicKmsDeriver, type KmsDeriver } from "./kmsDerive.js";
import type { Logger } from "./log.js";
import { moderateAgent, MODERATION_RUBRIC_VERSION, type Violation } from "./moderation.js";
import { OysterCli, type Oyster } from "./oyster.js";
import type { TurboUploader } from "./runtimeArweave.js";
import {
  MANUAL_REVIVAL,
  parseAgentId,
  REVIVE_PATH,
  REVIVE_QUOTE_PREFIX,
  REVIVE_STATUS_PREFIX,
  revivalQuote,
  ReviveService,
  type Launchpad,
  type ReceiptReader,
} from "./reviveApi.js";

/** contracts/src/AgentFactory.sol:74 CREATION_FEE = 75e6 (USDG base units). */
export const CREATION_FEE_USDG = "75000000";
/** Mirrors runtime AgentConfigSchema.archetype (runtime/src/config/schema.ts:69). */
export const ARCHETYPES = ["trader", "artist", "poster", "degen", "sage"] as const;
/** Agent `social` DEFAULT (every drilled agent: 4/4). */
export const DEFAULT_SOCIAL = { postsPerDay: 4, repliesPerDay: 4 } as const;
export const DEFAULT_CHAT_TIER = "cheap";
/** Platform keys that belong to ONE agent (set at genesis) — never carried over from the template. */
export const PER_AGENT_PLATFORM_KEYS = ["agentTokenAddress", "agentPoolId"] as const;
/** runtime PlatformConfigSchema required keys (runtime/src/config/schema.ts:236). */
export const REQUIRED_PLATFORM_KEYS = [
  "registry",
  "feeSplitHook",
  "poolManager",
  "usdg",
  "across",
  "marlin",
  "arweaveFundingAddress",
  "x402Allowlist",
  "caps",
  "usdc",
  "swapRouter",
  "usdcDomain",
] as const;
/**
 * SPEC-M4D §3 (agent-9 lesson): keys every PRODUCTION platform section must carry although the
 * runtime schema leaves them optional — TLS-enabled boot throws without agentDnsRoot. Enforced where
 * the launch-helper loads its platformTemplate (createLaunchHelper), not in buildPlatform, so the
 * golden fixtures (agent 8's historical frozen config, which predates the key) keep their meaning.
 */
export const LAUNCH_REQUIRED_PLATFORM_KEYS = ["agentDnsRoot"] as const;

/** Throws when a launch-helper platform section lacks a LAUNCH_REQUIRED_PLATFORM_KEYS key (non-empty string). */
export function assertLaunchPlatform(platform: Record<string, unknown>): void {
  const missing = LAUNCH_REQUIRED_PLATFORM_KEYS.filter((k) => typeof platform[k] !== "string" || (platform[k] as string).trim() === "");
  if (missing.length > 0) throw new Error(`platformTemplate lacks launch-required platform keys: ${missing.join(", ")} (TLS-enabled boot throws without agentDnsRoot)`);
}

/** POST body cap (bin/launch-helper.ts enforces it while reading). */
export const MAX_BODY_BYTES = 64 * 1024;
/**
 * SPEC-M4E §1b: /api/launch/publish body cap — the JSON-escaped agentJsonText of a config at the
 * free-upload limit exceeds MAX_BODY_BYTES; the handler's own size check answers 413 for the text.
 */
export const MAX_PUBLISH_BODY_BYTES = 256 * 1024;
export const PUBLISH_PATH = "/api/launch/publish";
export const REJECTIONS_FILE = "moderation-rejections.jsonl";
export const PUBLISHES_FILE = "publishes.jsonl";
export const PREDICTION_NOTE =
  "agentId is PREDICTED (factory agentCount()+1 at prepare time). A concurrent createAgent can take it; configHash, imageId and both EOAs bind to agentId — check AgentRequested(agentId) in the createAgent receipt and re-prepare on mismatch.";

type Json = Record<string, unknown>;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ---------------------------------------------------------------------------
// Platform section (pure)
// ---------------------------------------------------------------------------

/** Mirrors runtime X402AllowlistEntrySchema (runtime/src/config/schema.ts:103), strict. */
const AllowlistEntrySchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["inference", "data"]),
    operator: z.string().min(1),
    url: z.string().url(),
    payTo: z.string().regex(ADDRESS_RE),
    model: z.string().min(1),
    tier: z.enum(["cheap", "standard"]),
    maxPricePerMTokUsd: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
    attested: z.boolean(),
  })
  .strict();

export type AllowlistEntry = z.infer<typeof AllowlistEntrySchema>;

export interface ModelOption {
  id: string;
  model: string;
  operator: string;
  tier: "cheap" | "standard";
  attested: boolean;
}

export interface ManifestAddrs {
  chainId: number;
  registry: Address;
  usdg: Address;
  hook: Address | null;
  poolManager: Address | null;
  swapRouter: Address | null;
}

/** contracts/deployments/<net>.json → the addresses the platform section pins on RH. */
export function readManifestAddrs(path: string): ManifestAddrs {
  const m = JSON.parse(readFileSync(path, "utf8")) as Json;
  const addr = (k: string, required: boolean): Address | null => {
    const v = m[k];
    if (typeof v === "string" && ADDRESS_RE.test(v)) return getAddress(v);
    if (required) throw new Error(`deployment manifest ${path}: missing/invalid ${k}`);
    return null;
  };
  if (typeof m.chainId !== "number") throw new Error(`deployment manifest ${path}: missing chainId`);
  return {
    chainId: m.chainId,
    registry: addr("registry", true)!,
    usdg: addr("usdg", true)!,
    hook: addr("hook", false),
    poolManager: addr("poolManager", false),
    swapRouter: addr("swapRouter", false),
  };
}

/** Allowlist file: {entries:[…]} or […]. `_`-prefixed keys are comments (stripped); invalid entries are DROPPED and reported. */
export function parseAllowlistFile(raw: unknown): { entries: AllowlistEntry[]; dropped: string[] } {
  const list = Array.isArray(raw) ? raw : raw !== null && typeof raw === "object" ? (raw as Json).entries : undefined;
  if (!Array.isArray(list)) throw new Error("allowlist file must be an array or {entries: [...]}");
  const entries: AllowlistEntry[] = [];
  const dropped: string[] = [];
  for (const e of list) {
    const clean = e !== null && typeof e === "object" && !Array.isArray(e) ? Object.fromEntries(Object.entries(e as Json).filter(([k]) => !k.startsWith("_"))) : e;
    const p = AllowlistEntrySchema.safeParse(clean);
    const id = clean !== null && typeof clean === "object" && typeof (clean as Json).id === "string" ? String((clean as Json).id) : "?";
    if (p.success) entries.push(p.data);
    else dropped.push(`${id}: ${p.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  return { entries, dropped };
}

function setRh(platform: Json, key: string, value: unknown): void {
  const cur = platform[key];
  platform[key] = cur !== null && typeof cur === "object" && !Array.isArray(cur) ? { ...(cur as Json), rh: value } : { rh: value };
}

/**
 * The platform section genesis would freeze: template `platform` − per-agent keys, overlaid with the
 * genesis contract addresses (registry/usdg always; hook/poolManager/swapRouter/chainId from the
 * manifest when present) and, when given, the allowlist. Throws when a runtime-required key is
 * missing or a template allowlist entry is invalid (the template is operator-owned: fail closed).
 */
export function buildPlatform(o: { template: unknown; contracts: { registry: Address; usdg: Address }; manifest: ManifestAddrs | null; allowlist: AllowlistEntry[] | null }): Json {
  const t = o.template !== null && typeof o.template === "object" ? (o.template as Json).platform : undefined;
  if (t === null || typeof t !== "object" || Array.isArray(t)) throw new Error("platformTemplate must be an agent.json-shaped file with a `platform` object");
  const platform = JSON.parse(JSON.stringify(t)) as Json;
  for (const k of PER_AGENT_PLATFORM_KEYS) delete platform[k];
  setRh(platform, "registry", o.contracts.registry);
  setRh(platform, "usdg", o.contracts.usdg);
  if (o.manifest !== null) {
    if (getAddress(o.manifest.registry) !== getAddress(o.contracts.registry)) throw new Error("manifest registry ≠ config contracts.registry");
    if (o.manifest.hook !== null) setRh(platform, "feeSplitHook", o.manifest.hook);
    if (o.manifest.poolManager !== null) setRh(platform, "poolManager", o.manifest.poolManager);
    if (o.manifest.swapRouter !== null) setRh(platform, "swapRouter", o.manifest.swapRouter);
    setRh(platform, "chainIds", o.manifest.chainId);
  }
  if (o.allowlist !== null) {
    if (o.allowlist.length === 0) throw new Error("allowlist file has no valid entries");
    platform.x402Allowlist = o.allowlist;
  } else {
    const own = parseAllowlistFile(platform.x402Allowlist ?? null);
    if (own.dropped.length > 0) throw new Error(`platformTemplate x402Allowlist has invalid entries: ${own.dropped.join(" | ")}`);
  }
  const missing = REQUIRED_PLATFORM_KEYS.filter((k) => platform[k] === undefined);
  if (missing.length > 0) throw new Error(`platform section lacks runtime-required keys: ${missing.join(", ")}`);
  return platform;
}

/** Template `defaults.models`: the platform's inference allowlist entries. */
export function modelOptions(platform: Json): ModelOption[] {
  return parseAllowlistFile(platform.x402Allowlist ?? null)
    .entries.filter((e) => e.kind === "inference")
    .map((e) => ({ id: e.id, model: e.model, operator: e.operator, tier: e.tier, attested: e.attested }));
}

/** releasesTemplate (runtime/releases/<v>.json) → composeVersion, cross-checked against the compose + oyster settings. */
export function composeVersionOf(composePath: string, release: unknown, oyster: { arch: string; preset: string }): string {
  if (release === undefined) return basename(composePath).replace(/\.ya?ml$/, "");
  const r = release as { version?: unknown; composeFile?: unknown; oyster?: { arch?: unknown; preset?: unknown } };
  if (typeof r.version !== "string" || r.version === "") throw new Error("releasesTemplate: missing version");
  if (r.composeFile !== undefined && r.composeFile !== basename(composePath)) throw new Error(`releasesTemplate composeFile ${String(r.composeFile)} ≠ launchHelper compose ${basename(composePath)}`);
  if (r.oyster?.arch !== undefined && r.oyster.arch !== oyster.arch) throw new Error(`releasesTemplate oyster.arch ${String(r.oyster.arch)} ≠ oyster.arch ${oyster.arch}`);
  if (r.oyster?.preset !== undefined && r.oyster.preset !== oyster.preset) throw new Error(`releasesTemplate oyster.preset ${String(r.oyster.preset)} ≠ oyster.preset ${oyster.preset}`);
  return r.version;
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

export interface FactoryReader {
  agentCount(): Promise<bigint>;
}

// The viem-backed FactoryReader (factory.agentCount() view) lives in bin/launch-helper.ts: genesis/src's
// failure-table test pins the orchestrator's contract-call surface (its functionName allowlist), and
// this read belongs to the separate, key-less launch-helper process.

export type RejectionSink = (entry: Json) => void;

/** R5 "log rejections": one JSON object per line, appended. */
export function jsonlSink(path: string): RejectionSink {
  return (entry) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface LaunchHelperDeps {
  platform: Json;
  composePath: string;
  composeVersion: string;
  contracts: { factory: Address; usdg: Address };
  oyster: Pick<Oyster, "computeImageId">;
  kms: KmsDeriver;
  factory: FactoryReader;
  rejections: RejectionSink;
  corsOrigin: string;
  clock: Clock;
  log: Logger;
  /**
   * SPEC-M4E §1b: Arweave publication (createLaunchHelper: the runtime Turbo client over ONE ephemeral
   * key per process + publishes.jsonl). Absent ⇒ /api/launch/publish answers 503.
   */
  publisher?: { uploader: Pick<TurboUploader, "upload">; log: RejectionSink };
  /** SPEC-M4F §1 revive endpoints. Absent ⇒ they answer 503 "manual mode" (MANUAL_REVIVAL). */
  revive?: ReviveService;
}

export interface HelperRequest {
  method: string;
  url: string;
  /** Raw request body (null when none). */
  body: string | null;
}

export interface HelperResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const PrepareSchema = z
  .object({
    agent: z
      .object({
        name: z
          .string()
          .min(1)
          .max(32)
          .regex(/^\S(?:[^\u0000-\u001f\u007f]*\S)?$/, "no control characters, no leading/trailing whitespace"),
        symbol: z.string().regex(/^[A-Z0-9]{1,8}$/, "1–8 chars, A–Z / 0–9"),
        archetype: z.enum(ARCHETYPES),
        // Length is an R5 moderation rule (422), not a shape rule.
        persona: z.string().min(1),
        models: z
          .object({
            primary: z.string().min(1),
            fallbacks: z.array(z.string().min(1)).min(1).max(8),
            chatTier: z.enum(["cheap", "standard"]).optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const PublishSchema = z
  .object({
    agentJsonText: z.string().min(1),
    /** Optional client-side expectation (the prepare response's configHash): mismatch ⇒ 422. */
    configHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  })
  .strict();

class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

export class LaunchHelper {
  private readonly models: ModelOption[];

  constructor(private readonly d: LaunchHelperDeps) {
    this.models = modelOptions(d.platform);
  }

  template(): unknown {
    return {
      platform: this.d.platform,
      defaults: { archetypes: [...ARCHETYPES], models: this.models, creationFeeUsdg: CREATION_FEE_USDG, social: { ...DEFAULT_SOCIAL }, chatTier: DEFAULT_CHAT_TIER },
      composeVersion: this.d.composeVersion,
      rubricVersion: MODERATION_RUBRIC_VERSION,
    };
  }

  /** POST /api/launch/prepare. Never throws; every failure is a status. */
  async prepare(raw: unknown): Promise<Reply> {
    const p = PrepareSchema.safeParse(raw);
    if (!p.success) return new Reply(400, { error: "invalid request", issues: p.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const a = p.data.agent;

    const mod = moderateAgent({ name: a.name, persona: a.persona });
    if (!mod.ok) {
      this.reject(a, mod.violations);
      return new Reply(422, { error: "moderation", rubricVersion: mod.rubricVersion, violations: mod.violations });
    }

    const known = new Set(this.models.map((m) => m.model));
    const chosen = [a.models.primary, ...a.models.fallbacks];
    const issues: Array<{ path: string; message: string }> = [];
    chosen.forEach((m, i) => {
      if (!known.has(m)) issues.push({ path: i === 0 ? "agent.models.primary" : `agent.models.fallbacks.${i - 1}`, message: `model ${JSON.stringify(m)} is not on the platform allowlist` });
    });
    if (new Set(chosen).size !== chosen.length) issues.push({ path: "agent.models", message: "primary and fallbacks must be distinct" });
    if (issues.length > 0) return new Reply(400, { error: "invalid request", issues });

    let agentId: number;
    try {
      const count = await this.d.factory.agentCount();
      agentId = Number(count + 1n);
      if (!Number.isSafeInteger(agentId)) throw new Error(`agentCount ${count} out of range`);
    } catch (e) {
      return this.upstream("rpc", e);
    }

    const agent = {
      agentId,
      name: a.name,
      symbol: a.symbol,
      archetype: a.archetype,
      persona: a.persona,
      models: { primary: a.models.primary, fallbacks: a.models.fallbacks, chatTier: a.models.chatTier ?? DEFAULT_CHAT_TIER },
      social: { ...DEFAULT_SOCIAL },
    };
    const agentJson = { platform: this.d.platform, agent };
    const configHash = frozenConfigHash(agentJson).toLowerCase();
    // SPEC-M4E §1b: the exact file bytes (deployed byte-for-byte as agent.json and published to Arweave).
    const agentJsonText = `${JSON.stringify(agentJson, null, 2)}\n`;

    let imageId: string;
    try {
      imageId = await this.d.oyster.computeImageId({ composePath: this.d.composePath, agentId, configHash });
    } catch (e) {
      return this.upstream("compute-image-id", e);
    }
    let treasury: Address;
    let action: Address;
    try {
      treasury = await this.d.kms.deriveAddress(imageId, "treasury");
      action = await this.d.kms.deriveAddress(imageId, "action");
    } catch (e) {
      return this.upstream("kms-derive", e);
    }
    this.d.log.info(`launch-helper: prepared agent ${agentId} (predicted) configHash ${configHash} imageId ${imageId} treasury ${treasury}`);
    return new Reply(200, {
      predicted: true,
      note: PREDICTION_NOTE,
      agentId,
      agentJson,
      agentJsonText,
      configHash,
      imageId,
      expectedTreasuryEOA: treasury,
      actionEOA: action,
      createArgs: { factory: this.d.contracts.factory, usdg: this.d.contracts.usdg, fee: CREATION_FEE_USDG },
      composeVersion: this.d.composeVersion,
      rubricVersion: MODERATION_RUBRIC_VERSION,
    });
  }

  /** POST /api/launch/publish (SPEC-M4E §1b). Never throws; every failure is a status. */
  async publish(raw: unknown): Promise<Reply> {
    const p = PublishSchema.safeParse(raw);
    if (!p.success) return new Reply(400, { error: "invalid request", issues: p.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const text = p.data.agentJsonText;
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > MAX_CONFIG_TEXT_BYTES) return new Reply(413, { error: "config too large for the free Arweave upload path", bytes, maxBytes: MAX_CONFIG_TEXT_BYTES });

    let configHash: string;
    let agent: unknown;
    try {
      ({ configHash, agent } = frozenTextHash(text));
    } catch (e) {
      if (e instanceof ConfigInvalid) return new Reply(422, { error: e.code, reason: e.message });
      throw e;
    }
    if (p.data.configHash !== undefined && p.data.configHash.toLowerCase() !== configHash) {
      return new Reply(422, { error: "config_hash_mismatch", reason: `agentJsonText hashes to ${configHash}, not ${p.data.configHash.toLowerCase()}`, configHash });
    }
    const a = agent !== null && typeof agent === "object" && !Array.isArray(agent) ? (agent as Json) : null;
    if (a === null || typeof a.name !== "string" || typeof a.persona !== "string") {
      return new Reply(422, { error: "config_invalid", reason: "agent must be an object with string name and persona" });
    }
    const mod = moderateAgent({ name: a.name, persona: a.persona });
    if (!mod.ok) {
      this.reject({ name: a.name, symbol: String(a.symbol), archetype: String(a.archetype), persona: a.persona }, mod.violations);
      return new Reply(422, { error: "moderation", rubricVersion: mod.rubricVersion, violations: mod.violations });
    }

    const pub = this.d.publisher;
    if (pub === undefined) return new Reply(503, { error: "publishing not configured" });
    const agentId = typeof a.agentId === "number" ? a.agentId : null;
    const ts = Number(this.d.clock.now());
    let txId: string;
    try {
      ({ txId } = await publishFrozenConfig(text, { uploader: pub.uploader, clock: this.d.clock }));
    } catch (e) {
      const reason = errMsg(e);
      this.logPublish(pub.log, { ts, ok: false, configHash, agentId, bytes, reason });
      this.d.log.warn(`launch-helper: publish of ${configHash} FAILED (502): ${reason}`);
      return new Reply(502, { error: "upstream failure", stage: "arweave-upload", reason });
    }
    this.logPublish(pub.log, { ts, ok: true, configHash, agentId, bytes, txId });
    this.d.log.info(`launch-helper: published config ${configHash} (agent ${String(agentId)}, ${bytes} bytes) → ar://${txId}`);
    return new Reply(200, { txId, ref: `ar://${txId}`, configHash });
  }

  private logPublish(sink: RejectionSink, entry: Json): void {
    try {
      sink(entry);
    } catch (e) {
      this.d.log.warn(`launch-helper: publish log line NOT written: ${errMsg(e)}`);
    }
  }

  private upstream(stage: "rpc" | "compute-image-id" | "kms-derive", e: unknown): Reply {
    const reason = errMsg(e);
    this.d.log.warn(`launch-helper: prepare FAILED at ${stage} (502, no prediction returned): ${reason}`);
    return new Reply(502, { error: "upstream failure", stage, reason });
  }

  private reject(a: { name: string; symbol: string; archetype: string; persona: string }, violations: Violation[]): void {
    const entry = { ts: Number(this.d.clock.now()), rubricVersion: MODERATION_RUBRIC_VERSION, name: a.name, symbol: a.symbol, archetype: a.archetype, personaChars: a.persona.length, violations };
    try {
      this.d.rejections(entry);
    } catch (e) {
      this.d.log.warn(`launch-helper: moderation rejection NOT logged: ${errMsg(e)}`);
    }
    this.d.log.info(`launch-helper: moderation rejected ${JSON.stringify(a.name)}: ${violations.map((v) => `${v.rule}/${v.field}`).join(", ")}`);
  }

  private cors(): Record<string, string> {
    return {
      "access-control-allow-origin": this.d.corsOrigin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
  }

  /** SPEC-M4F §1: /api/revive* (405 → 503 manual mode → 400 → the service). */
  private async reviveRoute(req: HelperRequest, path: string, json: (status: number, body: unknown) => HelperResponse): Promise<HelperResponse> {
    const isPay = path === REVIVE_PATH;
    if (req.method !== (isPay ? "POST" : "GET")) return json(405, { error: "method not allowed" });
    const svc = this.d.revive;
    if (svc === undefined) return json(503, { error: "manual mode", manual: MANUAL_REVIVAL });
    if (isPay) {
      let body: unknown;
      try {
        body = JSON.parse(req.body ?? "");
      } catch {
        return json(400, { error: "body is not JSON" });
      }
      const r = await svc.pay(body);
      return json(r.status, r.body);
    }
    const quote = path.startsWith(REVIVE_QUOTE_PREFIX);
    const agentId = parseAgentId(path.slice((quote ? REVIVE_QUOTE_PREFIX : REVIVE_STATUS_PREFIX).length));
    if (agentId === null) return json(400, { error: "agentId must be a positive integer" });
    const r = quote ? await svc.quote(agentId) : svc.status(agentId);
    return json(r.status, r.body);
  }

  /** Transport-agnostic router (bin/launch-helper.ts feeds it from node:http). Never throws. */
  async handle(req: HelperRequest): Promise<HelperResponse> {
    const json = (status: number, body: unknown): HelperResponse => ({
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...this.cors() },
      body: JSON.stringify(body),
    });
    try {
      const path = new URL(req.url, "http://localhost").pathname.replace(/\/+$/, "");
      if (req.method === "OPTIONS") return { status: 204, headers: { ...this.cors(), "access-control-max-age": "86400" }, body: "" };
      if (path === "/api/launch/template") {
        if (req.method !== "GET") return json(405, { error: "method not allowed" });
        return json(200, this.template());
      }
      if (path === "/api/launch/prepare") {
        if (req.method !== "POST") return json(405, { error: "method not allowed" });
        let body: unknown;
        try {
          body = JSON.parse(req.body ?? "");
        } catch {
          return json(400, { error: "body is not JSON" });
        }
        const r = await this.prepare(body);
        return json(r.status, r.body);
      }
      if (path === REVIVE_PATH || path.startsWith(REVIVE_QUOTE_PREFIX) || path.startsWith(REVIVE_STATUS_PREFIX)) {
        return await this.reviveRoute(req, path, json);
      }
      if (path === PUBLISH_PATH) {
        if (req.method !== "POST") return json(405, { error: "method not allowed" });
        let body: unknown;
        try {
          body = JSON.parse(req.body ?? "");
        } catch {
          return json(400, { error: "body is not JSON" });
        }
        const r = await this.publish(body);
        return json(r.status, r.body);
      }
      return json(404, { error: "not found" });
    } catch (e) {
      this.d.log.error(`launch-helper: ${req.method} ${req.url}: ${errMsg(e)}`);
      return json(500, { error: "internal error" });
    }
  }
}

// ---------------------------------------------------------------------------
// Production wiring (config → seams). Reads NO key: walletKeyPath is never touched.
// ---------------------------------------------------------------------------

/** SPEC-M4F §1 chain seams of the revive endpoints (bin/launch-helper.ts: key-less viem readers). */
export interface ReviveSeams {
  /** RH launchpad reads (registry.instanceOf / REVIVAL_WINDOW, AgentRequested logs). */
  launchpad: Launchpad;
  /** Arbitrum One receipts (the USDC payment chain). */
  receipts: ReceiptReader;
  /** R4 Arweave tag discovery transport (DEFAULT fetchHttp) + gateway reader (DEFAULT the runtime one-redirect download). */
  http?: HttpClient;
  arweaveReader?: ArweaveReader;
}

/** True when the config enables the revive endpoints (genesisDb + revivalPayTo + chains.arbitrum). */
export function reviveConfigured(cfg: GenesisConfig): boolean {
  const lh = cfg.launchHelper;
  return lh?.genesisDb !== undefined && lh.revivalPayTo !== undefined && cfg.chains.arbitrum !== undefined;
}

export function createLaunchHelper(
  cfg: GenesisConfig,
  log: Logger,
  o: { factory: FactoryReader; clock?: Clock; uploader?: Pick<TurboUploader, "upload">; revive?: ReviveSeams },
): { helper: LaunchHelper; lh: LaunchHelperCfg } {
  const lh = cfg.launchHelper;
  if (lh === undefined) throw new Error("genesis config has no launchHelper section");
  const manifest = lh.deploymentManifestPath === null ? null : readManifestAddrs(lh.deploymentManifestPath);
  let allowlist: AllowlistEntry[] | null = null;
  if (lh.allowlistPath !== undefined) {
    const parsed = parseAllowlistFile(JSON.parse(readFileSync(lh.allowlistPath, "utf8")));
    for (const d of parsed.dropped) log.warn(`launch-helper: allowlist ${lh.allowlistPath}: DROPPED invalid entry ${d}`);
    allowlist = parsed.entries;
  }
  const platform = buildPlatform({ template: JSON.parse(readFileSync(lh.platformTemplate, "utf8")), contracts: cfg.contracts, manifest, allowlist });
  assertLaunchPlatform(platform);
  const release = lh.releasesTemplate === undefined ? undefined : (JSON.parse(readFileSync(lh.releasesTemplate, "utf8")) as unknown);
  const composeVersion = composeVersionOf(lh.composePath, release, cfg.oyster);
  const timeoutMs = lh.httpTimeoutSec * 1000;
  const clock = o.clock ?? systemClock;
  let revive: ReviveService | undefined;
  if (reviveConfigured(cfg) && o.revive === undefined) {
    log.warn("launch-helper: revive endpoints in MANUAL MODE (503) — configured, but no chain seams were wired (launchpad + Arbitrum receipts)");
  } else if (reviveConfigured(cfg) && o.revive !== undefined) {
    const dbPath = lh.genesisDb!;
    if (!existsSync(dbPath)) throw new Error(`launchHelper.genesisDb ${dbPath} does not exist (the orchestrator's genesis.sqlite)`);
    const configSource = buildConfigSource(cfg, { http: o.revive.http ?? fetchHttp, log, ...(o.revive.arweaveReader === undefined ? {} : { arweaveReader: o.revive.arweaveReader }) });
    revive = new ReviveService({
      revival: { db: new GenesisDb(dbPath), launchpad: o.revive.launchpad, cfg, log, configSource, configHashCache: new Map() },
      receipts: o.revive.receipts,
      quote: revivalQuote(cfg, lh.revivalPayTo!),
      clock,
      log,
    });
  } else if (lh.genesisDb !== undefined || lh.revivalPayTo !== undefined) {
    log.warn("launch-helper: revive endpoints in MANUAL MODE (503) — they need launchHelper.genesisDb + launchHelper.revivalPayTo + chains.arbitrum");
  }
  const helper = new LaunchHelper({
    platform,
    composePath: lh.composePath,
    composeVersion,
    contracts: { factory: cfg.contracts.factory, usdg: cfg.contracts.usdg },
    oyster: new OysterCli({ ...cfg.oyster, bin: lh.oysterBin }, nodeExec, fetchHttp),
    kms: new PublicKmsDeriver(lh.kmsEndpoint, lh.kmsVerificationKey, fetchHttp, timeoutMs),
    factory: o.factory,
    rejections: jsonlSink(join(cfg.dataDir, "launch-helper", REJECTIONS_FILE)),
    corsOrigin: lh.corsOrigin,
    clock,
    log,
    ...(revive === undefined ? {} : { revive }),
    // SPEC-M4E R2: ONE fresh ephemeral key for this process (never persisted; free uploads need no funds).
    publisher: {
      uploader: o.uploader ?? createEphemeralUploader({ ...(lh.turboUploadUrl === undefined ? {} : { uploadUrl: lh.turboUploadUrl }), timeoutMs }),
      log: jsonlSink(join(cfg.dataDir, "launch-helper", PUBLISHES_FILE)),
    },
  });
  return { helper, lh };
}
