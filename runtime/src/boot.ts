// SPEC-M2C §3 — composition root. boot(opts) assembles the whole runtime from a
// config file alone (plus optional test/ops overrides) and returns Runtime{start,stop}.
//
//   (1) config — two layouts (SPEC-M3 §3b):
//       SPLIT (opts.runtimeConfigPath): agent.json = FROZEN { platform, agent } + runtime.json = ops
//         (loadSplitConfig); configHash = frozenHash = keccak256(canonicalEncode(agent.json));
//         opts.expectedHash is checked against it; relative ops paths resolve against runtime.json.
//       LEGACY single file { platform, agent, runtime } (tests/dev): configHash over the WHOLE file
//         (opts.expectedHash checked against it, as before); frozenHash over its { platform, agent }.
//       Then Oyster init-param cross-checks, all BEFORE the KMS is touched:
//       - <initParamsDir>/agent-id (attested) present ⇒ MUST equal "agent-<agent.agentId>";
//       - <initParamsDir>/config-hash (attested; part of the image-id ⇒ keys bind to
//         (codeHash, agentId, configHash)) present ⇒ MUST equal frozenHash; ABSENT with
//         runtime.tee ⇒ refuse (no unbound TEE boots).
//   (2) keyring: createKeyring (withRetry inside) over opts.kms ?? (runtime.tee ? NautilusKms(runtime.kmsUrl)
//       : MockKms(runtime.mockKms)) → resolveConfig with the derived OwnAddresses →
//       [tee: fetch attestation (withRetry) → buildReport → sink.upload → cfg.registration =
//       {codeHash: runtime.imageId, attestationRef}] (SPEC-M3 §2) → attachConfig.
//   (3) memory: open dbPath; missing or corrupt AND snapshots exist ⇒ restoreLatest (03 §7).
//       A corrupt file is moved aside (never deleted). Corrupt with no snapshot, or snapshots
//       present but none restorable ⇒ throw (a fresh ledger would reset daily caps).
//   (4) ExecDeps: log → insertAction (every ExecResult, allow + deny: verdict / deny_code /
//       tx_hash / error); ledger store → loadLedger on boot (else emptyLedger), saveLedger on
//       EVERY set (budget consumption is persisted before any side effect); clock; chain
//       (override, else RealChainClient when runtime.rpc urls are configured, else
//       MockChainClient); getState from ChainClient reads — SPEC-M3C §4: NEVER throws; per-chain
//       degradation (cached-else-zero balances, LOUD warning, WalletState.staleChains ⇒ the engine's
//       G5 gate denies STATE_STALE for spends touching a stale chain).
//   (5) EndpointManager; paid inference: runtime.x402.enabled ⇒ X402HttpInference over
//       FetchHttpClient (or overrides.http / overrides.paidInference) handed to pulse + chat, else
//       the overrides.x402 + overrides.llm mocks; chat server (createChatServer, enabled iff cfg.chatDomain is set;
//       dual balance readers over two independent RealChainClients on cfg.chatRpc, or
//       overrides.chatReaders); pulse + daemon schedulers as
//       start/stop-able setTimeout loops driven by nextPulse / nextTickAt (timers injectable),
//       serialized by one mutex (no concurrent nonce use). Tier changes: ONE shared kv tier
//       store for both detectors, and announcements deduped by (from,to,dayKey) in kv.
//   (6) Runtime.stop(): timers off → TLS issuance loop off → chat close → wait for in-flight
//       tick/pulse → FINAL snapshot (03 §7 "before planned shutdowns") → db close.
//   SPEC-M3B §2 TLS ingress (runtime.tls.enabled; DEFAULT off): domain a<agentId>.<platform.agentDnsRoot>
//       (frozen); placeholder cert from KMS derive("tls") + persisted issued cert loaded at boot; chat
//       listens with TLS (DEFAULT :443, 0.0.0.0) and the ACME first-issuance loop starts in the
//       background (placeholder served meanwhile); daemon step 10 renews (< 30 d). GET /attestation =
//       boot report + served-cert SPKI sha256 (provider wired iff a tee report or TLS exists).
//   SPEC-M3B §3 Turbo (runtime.arweave.enabled; DEFAULT off): TurboArweaveSink over the in-house
//       TurboHttpUploader (ANS-104 data items signed by the treasury turboSigner) replaces LocalDirSink for attestation AND snapshots; LocalDirSink kept as a mirror
//       (runtime.arweave.localMirror DEFAULT true); restore reads [turbo, local].
//   SPEC-M3D §2 Turbo self-top-up (runtime.arweave.enabled AND runtime.turboTopUp.enabled, DEFAULT true then):
//       daemon step 12 over the uploader's TurboPayment seam (daemon/turboTopUp.ts).
//   SPEC-M3D §3c/§3d Farcaster (platform.farcaster present AND runtime.tee; absent ⇒ module disabled): castSink =
//       fcSink (memoryCastSink mirror first, then the frozen hub allowlist via HubClient; overrides.castSink wins)
//       and daemon step 13 (social/fcOnboard.ts: FID register → key add → DISPLAY user data).
//   SPEC-M3B §4 signed allowlist updates: after (3) memory and BEFORE any deps/pulse exist, the newest
//       adopted signed allowlist in kv is re-verified and applied onto the genesis cfg (reapplyAdoptedAllowlist).
//       cfg is then MUTABLE in exactly one way: applyCfg(next) swaps the single cfg object on every ExecDeps
//       view (baseExec / exec / daemonDeps; pulse + chat derive theirs per call), the keyring's K3 allowlist
//       and the EndpointManager (reload). Daemon step 11 (fetchAndAdopt) is wired ONLY when the agent opted
//       in at genesis (frozen agent.adoptAllowlistUpdates, DEFAULT true) AND runtime.allowlistUpdateUrl AND
//       the frozen platform.allowlistUpdateSigner are set; opted out ⇒ no fetcher is ever constructed.
//   Boot auto-registration (tee + cfg.registration): at the END of boot (after keyring + attestation +
//       every component, before start() arms the schedulers) read registry.instanceOf(agentId); unregistered
//       OR stale (now − lastHeartbeat > the contract's REVIVAL_WINDOW: a REVIVED instance ⇒ generation++ and
//       the new attestationRef) ⇒ execute({kind:"registerInstance"}) through the normal deps (engine T1 →
//       keyring K2). Registered + fresh ⇒ skip (logged). Read or send failure (incl. a THROWING execute, SPEC-M3C §5) ⇒ LOUD warning and boot continues (heartbeats keep failing
//       visibly; the genesis orchestrator watches registration and owns retry/timeout).
//       SPEC-M3C §10: before that send (genesis AND revival), when the chain client is a NativeBalanceSource
//       and the treasury's rh balance < REGISTRATION_GAS_FLOOR_WEI, poll it every 10 s (clock + injectable
//       sleep) up to runtime.registrationGasWaitSec (DEFAULT 600) for the orchestrator's preGas; timeout ⇒
//       attempt anyway with a LOUD warning. Read errors = "not yet funded" (warned once). Never throws.
//       SPEC-M3C §11: step (7) runs ensureRegistered in a bounded retry loop (ensureRegisteredWithRetry):
//       readFailed/sendFailed ⇒ sleep runtime.registrationRetryDelaySec (DEFAULT 30) and retry until
//       runtime.registrationRetrySec (DEFAULT 900) has elapsed; registered/revived/alreadyRegistered/
//       keyMismatch ⇒ stop. Retries use a 60 s §10 gas wait. LOUD warning on give-up; never throws.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Address, Hex } from "viem";
import { parseAbi } from "viem";
import { z } from "zod";
import type { BalanceReader, Holdings } from "./chat/gate.js";
import { createChatServer, TLS_DEFAULT_PORT, type AttestationPayload, type ChatServer } from "./chat/server.js";
import { systemClock, type Clock } from "./clock.js";
import {
  adoptsAllowlistUpdates,
  AgentConfigSchema,
  ConfigHashMismatchError,
  configHash,
  frozenConfigHash,
  loadSplitConfig,
  PlatformConfigSchema,
  resolveConfig,
  RuntimeOpsConfigSchema,
  type ResolvedConfig,
  type RuntimeOpsConfig,
} from "./config/schema.js";
import {
  kvTierStore,
  KV_LAST_SNAPSHOT_AT,
  tick,
  type AllowlistUpdateHook,
  type ChainReader,
  type DaemonDeps,
  type DaemonStepHook,
  type TickReport,
  type TierStore,
} from "./daemon/daemon.js";
import { DEFAULT_TURBO_LOW_WATERMARK_WINC, DEFAULT_TURBO_TOPUP_AMOUNT_WEI, runTurboTopUp, turboTopUpDue } from "./daemon/turboTopUp.js";
import { nextTickAt } from "./daemon/scheduler.js";
import { agentRegistryAbi, erc20Abi, feeSplitHookAbi } from "./exec/abi.js";
import { MockChainClient, type ChainClient } from "./exec/chain.js";
import { execute, type CastSink, type ExecDeps, type ExecResult, type LedgerStore } from "./exec/execute.js";
import { RealChainClient } from "./exec/chainViem.js";
import { createKeyring, type Keyring } from "./keyring/keyring.js";
import { withRetry, type KmsClient, type WithRetryOptions } from "./keyring/kms.js";
import { MockKms } from "./keyring/mockKms.js";
import { assertLocalhostUrl, DEFAULT_KMS_URL, NautilusKms } from "./keyring/nautilusKms.js";
import {
  buildReport,
  DEFAULT_ATTESTATION_URL,
  fetchAttestation,
  LocalDirSink as AttestationDirSink,
  type AttestationSink,
} from "./attestation/attestation.js";
import { MirroredAttestationSink, MirroredSnapshotSink, TurboArweaveSink, type TurboPayment, type TurboUploader } from "./attestation/turbo.js";
import { createHttpTurboUploader, DEFAULT_TURBO_UPLOAD_URL } from "./attestation/turboHttp.js";
import { agentDomain, LETS_ENCRYPT_PRODUCTION, type AcmeApi } from "./tls/acme.js";
import { acmeAccountKeyPem, ed25519KeyFromSeed } from "./tls/keys.js";
import { CertStore, placeholderMaterial, TlsManager } from "./tls/server.js";
import { dayKeyOf, emptyLedger } from "./ledger/ledger.js";
import { EndpointManager } from "./llm/endpoints.js";
import { FetchAllowlistSource } from "./llm/allowlistFetch.js";
import {
  ALLOWLIST_CHECK_INTERVAL_SEC,
  allowlistCheckDue,
  reapplyAdoptedAllowlist,
  runAllowlistCheck,
  type AllowlistSource,
  type AllowlistUpdateDeps,
} from "./llm/allowlistUpdate.js";
import { FetchHttpClient } from "./llm/httpFetch.js";
import type { HttpClient, LlmClient, X402Transport } from "./llm/types.js";
import { X402HttpInference, type PaidInferenceClient } from "./llm/x402Http.js";
import { kvGet, kvSet, loadLedger, openMemory, saveLedger, type MemoryDb } from "./memory/db.js";
import { LocalDirSink, restoreLatest, writeSnapshot, type SnapshotSink } from "./memory/snapshot.js";
import { runwayDays } from "./policy/runway.js";
import type { BudgetLedger, Chain, OwnAddresses, UnixSeconds, WalletBalances, WalletState } from "./policy/types.js";
import { tierOf } from "./pulse/tier.js";
import type { ContextSources } from "./pulse/context.js";
import { annotateExecResult, memoryCastSink, memoryJournalSink, recordExecResult, runPulse, type PulseResult } from "./pulse/pulse.js";
import { announceTierTransition, budgetPressure, nextPulse, planNext, type TierTransition } from "./pulse/scheduler.js";
import { pulsesEnabled, PULSE_INTERVAL_SEC, type Tier } from "./pulse/tier.js";
import { contentAction } from "./pulse/tools.js";
import { fcSink } from "./social/fcSink.js";
import { fcOnboardDue, readFcFid, runFcOnboard } from "./social/fcOnboard.js";
import { HubClient, type HubSubmitter } from "./social/hubClient.js";

// ---------------------------------------------------------------------------
// Config file envelope. The ops ("runtime") section schema now lives in config/schema.ts as
// RuntimeOpsConfigSchema (= runtime.json in the split layout, SPEC-M3 §3b); aliases kept.
// ---------------------------------------------------------------------------

export const RuntimeSectionSchema = RuntimeOpsConfigSchema;
export type RuntimeSection = RuntimeOpsConfig;
export { ConfigHashMismatchError };

/** LEGACY single-file layout { platform, agent, runtime } (tests/dev). */
export const RuntimeConfigFileSchema = z
  .object({
    platform: z.unknown(),
    agent: z.unknown(),
    runtime: RuntimeSectionSchema,
  })
  .strict();

/** DEFAULT Oyster init-params mount (docs.marlin.org "Initialization parameters"; compose mounts it ro). */
export const DEFAULT_INIT_PARAMS_DIR = "/init-params";

export class InitParamAgentIdMismatchError extends Error {
  constructor(
    readonly path: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `init param ${path} = ${JSON.stringify(actual.slice(0, 64))} but config agent.agentId ⇒ ${JSON.stringify(expected)} — ` +
        "refusing to boot (the attested agent-id binds the KMS keys; config and deployment disagree)",
    );
    this.name = "InitParamAgentIdMismatchError";
  }
}

/**
 * Oyster init-param cross-check. `<dir>/agent-id` absent ⇒ "absent" (not an Oyster deployment, or
 * the param was not passed). Present ⇒ must equal "agent-<agentId>" (canonical decimal, no
 * padding; a single trailing newline is tolerated), else InitParamAgentIdMismatchError.
 */
export function checkInitParamAgentId(dir: string, agentId: number): "absent" | "match" {
  const path = resolve(dir, "agent-id");
  if (!existsSync(path)) return "absent";
  const raw = readFileSync(path, "utf8");
  const actual = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const expected = `agent-${agentId.toString(10)}`;
  if (actual !== expected) throw new InitParamAgentIdMismatchError(path, expected, actual);
  return "match";
}

export class InitParamConfigHashMismatchError extends Error {
  constructor(
    readonly path: string,
    readonly expected: Hex,
    readonly actual: string,
  ) {
    super(
      `init param ${path} = ${JSON.stringify(actual.slice(0, 80))} but the frozen agent config hashes to ${expected} — ` +
        "refusing to boot (the attested config-hash binds the KMS keys; agent.json is not the one this enclave was deployed for)",
    );
    this.name = "InitParamConfigHashMismatchError";
  }
}

export class UnboundTeeBootError extends Error {
  constructor(readonly path: string) {
    super(
      `runtime.tee: no attested config-hash init param at ${path} — refusing to boot (no unbound TEE boots: ` +
        "deploy with --init-params config-hash:1:0:utf8:0x<frozen config hash>, SPEC-M3 §3b)",
    );
    this.name = "UnboundTeeBootError";
  }
}

/**
 * Oyster init-param config-hash check (SPEC-M3 §3b). `<dir>/config-hash` absent ⇒ "absent" (the
 * caller refuses when runtime.tee). Present ⇒ must be EXACTLY the lowercase 0x-hex frozenHash (a
 * single trailing newline is tolerated; the utf8 bytes are part of the image-id, so no other
 * spelling is canonical), else InitParamConfigHashMismatchError.
 */
export function checkInitParamConfigHash(dir: string, frozenHash: Hex): "absent" | "match" {
  const path = resolve(dir, "config-hash");
  if (!existsSync(path)) return "absent";
  const raw = readFileSync(path, "utf8");
  const actual = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const expected = frozenHash.toLowerCase() as Hex;
  if (actual !== expected) throw new InitParamConfigHashMismatchError(path, expected, actual);
  return "match";
}

// ---------------------------------------------------------------------------
// Options / Runtime
// ---------------------------------------------------------------------------

/** Injectable timer primitives (default: global setTimeout/clearTimeout). */
export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const nodeTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface BootLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Wallet-state source for ExecDeps.getState. */
export type StateReader = () => Promise<WalletState>;

/** Optional native-balance extension a ChainClient may implement (RealChainClient). */
export interface NativeBalanceSource {
  getBalance(chain: Chain, address: Address): Promise<bigint>;
}

/** ADDITIVE (Job F): overrides beyond the spec'd kms/clock — tests and ops wiring. */
export interface BootOverrides {
  chain?: ChainClient;
  llm?: LlmClient;
  x402?: X402Transport;
  state?: StateReader;
  chainReader?: ChainReader;
  snapshotSink?: SnapshotSink;
  timers?: TimerApi;
  sources?: ContextSources;
  logger?: BootLogger;
  /** Chat D9 dual balance readers (default: two RealChainClients over cfg.chatRpc). */
  chatReaders?: readonly [BalanceReader, BalanceReader];
  /** Chat listen port override (e.g. 0 = ephemeral in tests; DEFAULT cfg.chatPort). */
  chatPort?: number;
  /** SPEC-M3 §2: attestation report sink (DEFAULT LocalDirSink(runtime.attestationDir)). tee: true only. */
  attestationSink?: AttestationSink;
  /** Paid-inference client used by pulse + chat regardless of runtime.x402 (tests). */
  paidInference?: PaidInferenceClient;
  /** HttpClient for the real x402 transport when runtime.x402.enabled (DEFAULT FetchHttpClient). */
  http?: HttpClient;
  /** SPEC-M3B §3: Turbo uploader used when runtime.arweave.enabled (DEFAULT TurboHttpUploader — in-house ANS-104, attestation/turboHttp.ts). */
  turboUploader?: TurboUploader;
  /** SPEC-M3B §2: acme-client seam for runtime.tls (DEFAULT the real acme-client). */
  acme?: AcmeApi;
  /** SPEC-M3B §4: signed-allowlist transport (DEFAULT FetchAllowlistSource(runtime.allowlistUpdateUrl)). */
  allowlistSource?: AllowlistSource;
  /** SPEC-M3D §2: Turbo payment seam for daemon step 12 (DEFAULT the uploader, when it implements TurboPayment). */
  turboPayment?: TurboPayment;
  /** SPEC-M3D §3c: cast sink override — wins over fcSink / memoryCastSink. */
  castSink?: CastSink;
  /** SPEC-M3D §3c: hub seam for fcSink (DEFAULT HubClient over the frozen platform.farcaster.hubs). */
  hubClient?: HubSubmitter;
}

export interface BootOptions {
  /** Legacy single-file config, or — with runtimeConfigPath — the FROZEN agent.json (SPEC-M3 §3b). */
  configPath: string;
  /** SPEC-M3 §3b: mutable ops config (runtime.json). Given ⇒ split layout; absent ⇒ legacy single file. */
  runtimeConfigPath?: string;
  dbPath?: string;
  snapshotDir?: string;
  /** keccak256 of the canonical config JSON (split: of agent.json = frozenHash; legacy: whole file); mismatch ⇒ throw (03 §10). */
  expectedHash?: string;
  kms?: KmsClient;
  clock?: Clock;
  /** withRetry options for boot-time KMS derives. */
  kmsRetry?: WithRetryOptions;
  /**
   * Oyster init-params dir override (tests / non-Oyster harnesses; main.ts never sets it). With
   * runtime.tee the dir is NOT configurable from the (unattested) runtime config: it is this, else
   * DEFAULT_INIT_PARAMS_DIR — see boot step (1b).
   */
  initParamsDir?: string;
  overrides?: BootOverrides;
}


export interface PulseCycle {
  result: PulseResult;
  tier: Tier;
  transition: TierTransition | null;
  /** Announcement ExecResults (null: no transition, or deduped). */
  announcement: ExecResult[] | null;
  nextPulseAt: UnixSeconds | null;
}

export interface Runtime {
  start(): Promise<void>;
  stop(): Promise<void>;
  // ---- ADDITIVE (Job F): introspection + manual drive (tests / ops) ----
  /** Current effective config (genesis cfg, or with an adopted signed allowlist — SPEC-M3B §4). */
  readonly cfg: ResolvedConfig;
  readonly configHash: Hex;
  readonly db: MemoryDb;
  readonly keyring: Keyring;
  readonly endpoints: EndpointManager;
  readonly exec: ExecDeps;
  /** Snapshot id the memory DB was restored from at boot, or null. */
  readonly restoredFrom: string | null;
  /** SPEC-M3 §3b: keccak256(canonicalEncode({platform, agent})) — the value the attested config-hash init param binds. */
  readonly frozenHash: Hex;
  /** SPEC-M3 §2: attestation report ref (sink id) when booted with runtime.tee, else null. */
  readonly attestationRef: string | null;
  /** Chat server (null ⇒ disabled: cfg.chatDomain not set). */
  readonly chat: ChatServer | null;
  /** Bound chat address once start() has listened, else null. */
  chatAddress(): { host: string; port: number } | null;
  /** SPEC-M3B §2: TLS ingress manager (null ⇒ runtime.tls disabled). */
  readonly tls: TlsManager | null;
  /** One daemon tick now (serialized with the loops). */
  daemonTick(): Promise<TickReport>;
  /** One pulse cycle now: tier detection (+announce) → runPulse → reschedule data. */
  pulse(): Promise<PulseCycle>;
  /** Deduped (from,to,dayKey) tier announcement: journal + castPost drafts via the engine. */
  announceTierTransition(t: TierTransition): Promise<ExecResult[] | null>;
  tier(): Tier | undefined;
  /** Resolves when all queued/in-flight daemon/pulse work has finished. */
  idle(): Promise<void>;
}

// ---------------------------------------------------------------------------
// constants / kv keys
// ---------------------------------------------------------------------------

export const KV_DAEMON_NEXT_AT = "sched:daemonNextAt";
export const KV_PULSE_NEXT_AT = "sched:pulseNextAt";
export const KV_TIER_ANNOUNCED_PREFIX = "tierAnnounced:";
/** Retry delay after a loop iteration throws (e.g. RPC down at tick start). */
export const LOOP_RETRY_SEC = 300n;
/** setTimeout max delay (2^31−1 ms); longer waits re-arm. */
const MAX_TIMER_MS = 2_147_483_647n;

export function tierAnnounceKey(t: TierTransition, now: UnixSeconds): string {
  return `${KV_TIER_ANNOUNCED_PREFIX}${t.from}:${t.to}:${dayKeyOf(now)}`;
}

const consoleLogger: BootLogger = {
  info: (m) => console.log(`[boot] ${m}`),
  warn: (m) => console.warn(`[boot] ${m}`),
  error: (m) => console.error(`[boot] ${m}`),
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// (1) config
// ---------------------------------------------------------------------------

export interface LoadedConfig {
  json: unknown;
  /** Runtime.configHash: legacy = whole file; split = frozenHash. */
  hash: Hex;
  /** keccak256(canonicalEncode({platform, agent})) — compared with the attested config-hash init param. */
  frozenHash: Hex;
  platform: unknown;
  agent: unknown;
  runtime: RuntimeSection;
  /** Base dir for relative ops paths (legacy: the config file's dir; split: runtime.json's dir). */
  baseDir: string;
  layout: "legacy" | "split";
}

/** Legacy single-file layout { platform, agent, runtime }. */
export function loadConfigFile(configPath: string, expectedHash?: string): LoadedConfig {
  const text = readFileSync(configPath, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`config ${configPath}: invalid JSON: ${errMsg(e)}`);
  }
  const hash = configHash(json);
  if (expectedHash !== undefined && expectedHash.toLowerCase() !== hash.toLowerCase()) {
    throw new ConfigHashMismatchError(expectedHash, hash);
  }
  const file = RuntimeConfigFileSchema.parse(json);
  // Validate platform + agent BEFORE touching the KMS (fail fast on a bad file).
  PlatformConfigSchema.parse(file.platform);
  AgentConfigSchema.parse(file.agent);
  return {
    json,
    hash,
    frozenHash: frozenConfigHash({ platform: file.platform, agent: file.agent }),
    platform: file.platform,
    agent: file.agent,
    runtime: file.runtime,
    baseDir: dirname(resolve(configPath)),
    layout: "legacy",
  };
}

/** SPEC-M3 §3b split layout: agent.json (frozen) + runtime.json (ops). expectedHash is checked against frozenHash. */
export function loadSplitConfigFiles(agentPath: string, runtimePath: string, expectedHash?: string): LoadedConfig {
  const split = loadSplitConfig({ agentPath, runtimePath, ...(expectedHash !== undefined ? { expectedHash } : {}) });
  return {
    json: split.frozenJson,
    hash: split.frozenHash,
    frozenHash: split.frozenHash,
    platform: split.frozenJson.platform,
    agent: split.frozenJson.agent,
    runtime: split.ops,
    baseDir: dirname(resolve(runtimePath)),
    layout: "split",
  };
}

// ---------------------------------------------------------------------------
// (3) memory open-or-restore
// ---------------------------------------------------------------------------

async function sinkHasSnapshots(sinks: readonly SnapshotSink[]): Promise<boolean> {
  for (const s of sinks) {
    try {
      if ((await s.list()).length > 0) return true;
    } catch {
      // unreadable sink: treated as empty here; restoreLatest logs it
    }
  }
  return false;
}

function moveAside(path: string, suffix: string): string | null {
  if (!existsSync(path)) return null;
  const to = `${path}.${suffix}`;
  renameSync(path, to);
  return to;
}

export interface OpenedMemory {
  db: MemoryDb;
  restoredFrom: string | null;
  corruptMovedTo: string | null;
}

export async function openOrRestoreMemory(
  dbPath: string,
  sinks: readonly SnapshotSink[],
  memKey: Hex,
  now: UnixSeconds,
  logger: BootLogger,
): Promise<OpenedMemory> {
  const inMemory = dbPath === ":memory:";
  let corruptMovedTo: string | null = null;
  if (!inMemory && existsSync(dbPath)) {
    let db: MemoryDb | undefined;
    try {
      db = openMemory(dbPath);
      const check: unknown = db.pragma("quick_check", { simple: true });
      if (check !== "ok") throw new Error(`quick_check: ${String(check)}`);
      return { db, restoredFrom: null, corruptMovedTo: null };
    } catch (e) {
      try {
        db?.close();
      } catch {
        // already unusable
      }
      const suffix = `corrupt-${now.toString(10)}`;
      corruptMovedTo = moveAside(dbPath, suffix);
      moveAside(`${dbPath}-journal`, suffix);
      logger.warn(`memory db ${dbPath} is corrupt (${errMsg(e)}); moved to ${corruptMovedTo ?? "?"}`);
    }
  } else if (!inMemory) {
    // A stray hot journal next to a missing db must not be replayed into a restored file.
    moveAside(`${dbPath}-journal`, `orphan-${now.toString(10)}`);
  }

  if (!(await sinkHasSnapshots(sinks))) {
    if (corruptMovedTo !== null) {
      throw new Error(`memory db ${dbPath} corrupt and no snapshot to restore from — refusing to boot with an empty ledger`);
    }
    return { db: openMemory(dbPath), restoredFrom: null, corruptMovedTo };
  }

  const restored = await restoreLatest([...sinks], memKey);
  if (restored === null) {
    throw new Error("snapshots present but none restorable under this memKey — refusing to boot");
  }
  logger.info(`memory restored from snapshot ${restored.meta.id} (createdAt ${restored.meta.createdAt})`);
  if (inMemory) return { db: restored.db, restoredFrom: restored.meta.id, corruptMovedTo };
  const bytes = restored.db.serialize();
  restored.db.close();
  writeFileSync(dbPath, bytes);
  return { db: openMemory(dbPath), restoredFrom: restored.meta.id, corruptMovedTo };
}

// ---------------------------------------------------------------------------
// (4) chain-backed readers
// ---------------------------------------------------------------------------

/** SPEC-M3D §2: does this uploader also expose the Turbo payment seam (TurboHttpUploader does)? */
function isTurboPayment(u: TurboUploader): u is TurboUploader & TurboPayment {
  return "paymentAddress" in u && typeof u.paymentAddress === "function" && "submitFundTx" in u && typeof u.submitFundTx === "function";
}

function hasNativeBalance(c: ChainClient): c is ChainClient & NativeBalanceSource {
  return "getBalance" in c && typeof c.getBalance === "function";
}

const CHAINS: readonly Chain[] = ["rh", "base", "arbitrum", "optimism"];

function asBigint(v: unknown, what: string): bigint {
  if (typeof v !== "bigint") throw new Error(`${what}: expected bigint, got ${typeof v}`);
  return v;
}

type ChainBalances = WalletBalances[Chain];

/** SPEC-M3C §4: one chain's slice of a WalletState (treasury + action balances on that chain). */
interface ChainSlice {
  treasury: ChainBalances;
  action: ChainBalances;
}

function cloneBalances(b: ChainBalances): ChainBalances {
  return {
    native: b.native,
    ...(b.USDG !== undefined ? { USDG: b.USDG } : {}),
    ...(b.USDC !== undefined ? { USDC: b.USDC } : {}),
    ...(b.tokens !== undefined ? { tokens: { ...b.tokens } } : {}),
  };
}

function cloneSlice(s: ChainSlice): ChainSlice {
  return { treasury: cloneBalances(s.treasury), action: cloneBalances(s.action) };
}

export interface ChainStateReaderOptions {
  /** LOUD per-chain degradation warnings (DEFAULT console). */
  logger?: BootLogger;
  /** Cache-age source for the warning (DEFAULT systemClock). */
  clock?: Clock;
}

/**
 * WalletState from ChainClient reads. Treasury: native + USDC on every chain, USDG + agent token on
 * rh. Action EOA: rh only (native, USDG, agent token); other chains are 0 (never read).
 * Native balances need a ChainClient implementing NativeBalanceSource; otherwise 0.
 * Hosting (Oyster) comes from the runtime.hosting config stand-in.
 *
 * SPEC-M3C §4 — NEVER throws. Reads are grouped per chain; ALL of a chain's reads share ONE
 * try/catch, so a chain is fresh only if every read on it succeeded (no half-fresh chains). Each
 * success refreshes this reader's in-memory per-chain cache. A failed chain is LOUDLY warned, served
 * from the cache (else zeros) and listed in `staleChains` — cached values STILL mark it stale (the
 * engine's G5 gate keeps spends touching it closed; the cache only keeps runway/tier from cratering
 * spuriously). `staleChains` is present ONLY when non-empty. Recovery is automatic on the next read.
 */
export function chainStateReader(
  chain: ChainClient,
  cfg: ResolvedConfig,
  hosting: RuntimeSection["hosting"],
  opts: ChainStateReaderOptions = {},
): StateReader {
  const logger = opts.logger ?? consoleLogger;
  const clock = opts.clock ?? systemClock;
  const native = async (c: Chain, a: Address): Promise<bigint> => (hasNativeBalance(chain) ? chain.getBalance(c, a) : 0n);
  const erc20 = async (c: Chain, token: Address, owner: Address): Promise<bigint> =>
    asBigint(await chain.readContract(c, { address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }), `balanceOf(${token})@${c}`);
  const tokens = async (owner: Address): Promise<Record<Address, bigint> | undefined> => {
    const t = cfg.agentTokenAddress;
    if (t === undefined) return undefined;
    return { [t]: await erc20("rh", t, owner) };
  };

  /** All of chain c's reads, in the original order; throws on the first failed read. */
  const readChain = async (c: Chain): Promise<ChainSlice> => {
    const treasury: ChainBalances = { native: await native(c, cfg.treasury), USDC: await erc20(c, cfg.usdc[c], cfg.treasury) };
    if (c !== "rh") return { treasury, action: { native: 0n } };
    treasury.USDG = await erc20("rh", cfg.usdg.rh, cfg.treasury);
    const tt = await tokens(cfg.treasury);
    if (tt !== undefined) treasury.tokens = tt;
    const action: ChainBalances = { native: await native("rh", cfg.action), USDG: await erc20("rh", cfg.usdg.rh, cfg.action) };
    const at = await tokens(cfg.action);
    if (at !== undefined) action.tokens = at;
    return { treasury, action };
  };

  /** Same shape as a successful read of c, every balance 0. */
  const zeroSlice = (c: Chain): ChainSlice => {
    const t = cfg.agentTokenAddress;
    if (c !== "rh") return { treasury: { native: 0n, USDC: 0n }, action: { native: 0n } };
    return {
      treasury: { native: 0n, USDC: 0n, USDG: 0n, ...(t !== undefined ? { tokens: { [t]: 0n } } : {}) },
      action: { native: 0n, USDG: 0n, ...(t !== undefined ? { tokens: { [t]: 0n } } : {}) },
    };
  };

  const cache = new Map<Chain, { slice: ChainSlice; at: UnixSeconds }>();

  return async (): Promise<WalletState> => {
    const treasury = {} as WalletBalances;
    const action = {} as WalletBalances;
    const staleChains: Chain[] = [];
    for (const c of CHAINS) {
      let slice: ChainSlice;
      try {
        slice = await readChain(c);
        cache.set(c, { slice: cloneSlice(slice), at: clock() });
      } catch (e) {
        const cached = cache.get(c);
        let using: string;
        if (cached !== undefined) {
          const now = clock();
          const age = now > cached.at ? now - cached.at : 0n;
          using = `cached values (age ${age.toString(10)}s)`;
          slice = cloneSlice(cached.slice);
        } else {
          using = "zeros";
          slice = zeroSlice(c);
        }
        logger.warn(`!!! getState: ${c} reads FAILED (${errMsg(e)}) — using ${using}; spends touching ${c} deny STATE_STALE !!!`);
        staleChains.push(c);
      }
      treasury[c] = slice.treasury;
      action[c] = slice.action;
    }

    return {
      treasury,
      action,
      hostingPaidUntil: hosting?.paidUntil ?? 0n,
      hostingRatePerDay: hosting?.ratePerDay ?? 0n,
      ...(staleChains.length > 0 ? { staleChains } : {}),
    };
  };
}

/**
 * Daemon ChainReader over ChainClient reads of FeeSplitHook (contracts/src/FeeSplitHook.sol):
 * accruedFees = pendingFees(pool, USDG) + quoteAgentToUsdg(pool, pendingFees(pool, agentToken));
 * quoteToUsdg(agentToken, x) = quoteAgentToUsdg(pool, x); any other token quotes 0 (no quoter
 * in M2 ⇒ step 5 skips it). No agentPoolId configured ⇒ 0 fees.
 */
export function chainFeeReader(chain: ChainClient, cfg: ResolvedConfig): ChainReader {
  const hook = cfg.feeSplitHook.rh;
  const quoteAgent = async (poolId: Hex, amount: bigint): Promise<bigint> =>
    amount === 0n
      ? 0n
      : asBigint(
          await chain.readContract("rh", { address: hook, abi: feeSplitHookAbi, functionName: "quoteAgentToUsdg", args: [poolId, amount] }),
          "quoteAgentToUsdg",
        );
  const pending = async (poolId: Hex, currency: Address): Promise<bigint> =>
    asBigint(
      await chain.readContract("rh", { address: hook, abi: feeSplitHookAbi, functionName: "pendingFees", args: [poolId, currency] }),
      "pendingFees",
    );
  return {
    async accruedFees(_agentId: number): Promise<bigint> {
      const poolId = cfg.agentPoolId;
      if (poolId === undefined) return 0n;
      let total = await pending(poolId, cfg.usdg.rh);
      if (cfg.agentTokenAddress !== undefined) total += await quoteAgent(poolId, await pending(poolId, cfg.agentTokenAddress));
      return total;
    },
    async quoteToUsdg(token: Address, amount: bigint): Promise<bigint> {
      const poolId = cfg.agentPoolId;
      const agentToken = cfg.agentTokenAddress;
      if (poolId === undefined || agentToken === undefined) return 0n;
      if (token.toLowerCase() !== agentToken.toLowerCase()) return 0n;
      return quoteAgent(poolId, amount);
    },
  };
}

const unconfiguredLlm: LlmClient = {
  async complete(): Promise<never> {
    throw new Error("boot: no LLM client configured (real client = M3)");
  },
};

const unconfiguredX402: X402Transport = {
  async quote(endpointId: string): Promise<never> {
    throw new Error(`boot: no x402 transport configured (real transport = M3); cannot quote ${endpointId}`);
  },
  async pay(endpointId: string): Promise<never> {
    throw new Error(`boot: no x402 transport configured (real transport = M3); cannot pay ${endpointId}`);
  },
};

const erc20SupplyAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

/**
 * D9 BalanceReader over ONE ChainClient (one RPC endpoint): agent token + platform token
 * balance and supply on RH, read on the same call. An unset token reads as 0/0 (that leg
 * cannot pass). Two of these over independent endpoints = the chat gate's dual read.
 */
export function chainBalanceReader(chain: ChainClient, cfg: ResolvedConfig): BalanceReader {
  const read = async (token: Address | undefined, fn: "balanceOf" | "totalSupply", args: readonly unknown[]): Promise<bigint> => {
    if (token === undefined) return 0n;
    return asBigint(await chain.readContract("rh", { address: token, abi: erc20SupplyAbi, functionName: fn, args }), `${fn}(${token})`);
  };
  return {
    async holdings(wallet: Address): Promise<Holdings> {
      const [agentBal, agentSupply, platformBal, platformSupply] = await Promise.all([
        read(cfg.agentTokenAddress, "balanceOf", [wallet]),
        read(cfg.agentTokenAddress, "totalSupply", []),
        read(cfg.platformTokenAddress, "balanceOf", [wallet]),
        read(cfg.platformTokenAddress, "totalSupply", []),
      ]);
      return { agentBal, agentSupply, platformBal, platformSupply };
    },
  };
}

function definedUrls(rpc: RuntimeSection["rpc"]): Partial<Record<Chain, string>> {
  const out: Partial<Record<Chain, string>> = {};
  for (const c of CHAINS) {
    const u = rpc[c];
    if (u !== undefined) out[c] = u;
  }
  return out;
}

function hostingLapsed(s: WalletState, now: UnixSeconds): boolean {
  return s.hostingRatePerDay > 0n && s.hostingPaidUntil <= now;
}

// ---------------------------------------------------------------------------
// (5) loops
// ---------------------------------------------------------------------------

/** A start/stop-able setTimeout loop; `run` returns the next due time (null ⇒ idle). */
class Loop {
  private handle: unknown = undefined;
  private running = false;
  private active = false;

  constructor(
    private readonly name: string,
    private readonly timers: TimerApi,
    private readonly clock: Clock,
    private readonly run: () => Promise<UnixSeconds | null>,
    private readonly logger: BootLogger,
  ) {}

  start(at: UnixSeconds | null): void {
    this.active = true;
    this.scheduleAt(at);
  }

  stop(): void {
    this.active = false;
    this.cancel();
  }

  /** True iff active with nothing scheduled and nothing running. */
  idle(): boolean {
    return this.active && this.handle === undefined && !this.running;
  }

  scheduleAt(at: UnixSeconds | null): void {
    this.cancel();
    if (!this.active || at === null) return;
    const now = this.clock();
    let ms = at <= now ? 0n : (at - now) * 1000n;
    if (ms > MAX_TIMER_MS) ms = MAX_TIMER_MS; // fires early, run() re-derives the due time
    this.handle = this.timers.set(() => {
      this.handle = undefined;
      void this.fire();
    }, Number(ms));
  }

  private cancel(): void {
    if (this.handle !== undefined) {
      this.timers.clear(this.handle);
      this.handle = undefined;
    }
  }

  private async fire(): Promise<void> {
    if (!this.active) return;
    this.running = true;
    let next: UnixSeconds | null;
    try {
      next = await this.run();
    } catch (e) {
      this.logger.error(`${this.name} loop iteration failed: ${errMsg(e)}; retry in ${LOOP_RETRY_SEC}s`);
      next = this.clock() + LOOP_RETRY_SEC;
    }
    this.running = false;
    this.scheduleAt(next);
  }
}

function kvBigint(db: MemoryDb, key: string): UnixSeconds | undefined {
  const v = kvGet(db, key);
  return v !== undefined && /^\d+$/.test(v) ? BigInt(v) : undefined;
}

// ---------------------------------------------------------------------------
// (7) boot auto-registration
// ---------------------------------------------------------------------------

export type RegistrationOutcome = "registered" | "revived" | "alreadyRegistered" | "keyMismatch" | "readFailed" | "sendFailed";

/** Parsed registry.instanceOf(agentId) (contracts/src/interfaces/ILaunchpad.sol:11-18). */
interface RegistryInstance {
  treasuryEOA: Address;
  actionEOA: Address;
  codeHash: Hex;
  lastHeartbeat: bigint;
  generation: number;
}

function parseInstance(v: unknown): RegistryInstance {
  const o = (v !== null && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const { treasuryEOA, actionEOA, codeHash, lastHeartbeat, generation } = o;
  if (typeof treasuryEOA !== "string" || typeof actionEOA !== "string" || typeof codeHash !== "string") throw new Error("instanceOf: malformed record");
  if (typeof lastHeartbeat !== "bigint") throw new Error(`instanceOf: lastHeartbeat is ${typeof lastHeartbeat}, expected bigint`);
  if (typeof generation !== "number" && typeof generation !== "bigint") throw new Error("instanceOf: malformed generation");
  return { treasuryEOA: treasuryEOA as Address, actionEOA: actionEOA as Address, codeHash: codeHash as Hex, lastHeartbeat, generation: Number(generation) };
}

// ---------------------------------------------------------------------------
// SPEC-M3C §10 — registration gas wait (e2e finding 2026-09-24: the enclave can boot BEFORE the
// orchestrator's preGas confirms; a single unfunded registerInstance attempt ⇒ AWAITING_REGISTER deadlock).
// ---------------------------------------------------------------------------

/** 0.0001 ETH: real registerInstance cost ≈ 2e14 max at the 1-gwei cap; preGas sends 3.33e14. */
export const REGISTRATION_GAS_FLOOR_WEI = 100_000_000_000_000n;
/** DEFAULT runtime.registrationGasWaitSec. */
export const DEFAULT_REGISTRATION_GAS_WAIT_SEC = 600;
/** Balance poll interval while waiting. */
export const REGISTRATION_GAS_POLL_SEC = 10n;
/** Info-log cadence while waiting. */
export const REGISTRATION_GAS_LOG_SEC = 30n;

/** Awaitable sleep (injectable so tests drive a fake clock instantly). */
export type SleepFn = (ms: number) => Promise<void>;
export const realSleep: SleepFn = (ms) => new Promise<void>((res) => setTimeout(res, ms));

export interface RegistrationGasWaitOptions {
  /** Max wait in seconds (DEFAULT DEFAULT_REGISTRATION_GAS_WAIT_SEC). */
  waitSec?: number;
  /** DEFAULT systemClock. */
  clock?: Clock;
  /** DEFAULT realSleep. */
  sleep?: SleepFn;
}

/**
 * SPEC-M3C §10: wait until the treasury's rh native balance ≥ REGISTRATION_GAS_FLOOR_WEI, polling every
 * REGISTRATION_GAS_POLL_SEC up to waitSec. No NativeBalanceSource ⇒ returns at once (mock chain). A read
 * error counts as "not yet funded" (warned once). Timeout ⇒ LOUD warning and return (the caller attempts
 * anyway; the send surfaces the real error). Resolves "funded" | "timeout" | "noBalanceSource".
 */
export async function waitForRegistrationGas(
  chain: ChainClient,
  treasury: Address,
  agentId: number,
  logger: BootLogger,
  opts: RegistrationGasWaitOptions = {},
): Promise<"funded" | "timeout" | "noBalanceSource"> {
  if (!hasNativeBalance(chain)) return "noBalanceSource";
  const clock = opts.clock ?? systemClock;
  const sleep = opts.sleep ?? realSleep;
  const waitSec = BigInt(opts.waitSec ?? DEFAULT_REGISTRATION_GAS_WAIT_SEC);
  const start = clock();
  let readWarned = false;
  let lastLogAt: bigint | null = null;
  let lastBalance: bigint | null = null;
  for (;;) {
    try {
      const b: unknown = await chain.getBalance("rh", treasury);
      lastBalance = asBigint(b, `getBalance(${treasury})@rh`);
    } catch (e) {
      lastBalance = null;
      if (!readWarned) {
        readWarned = true;
        logger.warn(`!!! registration: treasury rh balance read FAILED (${errMsg(e)}) — treating as not yet funded; still polling !!!`);
      }
    }
    const now = clock();
    const elapsed = now - start;
    if (lastBalance !== null && lastBalance >= REGISTRATION_GAS_FLOOR_WEI) {
      if (lastLogAt !== null || readWarned) logger.info(`registration: treasury ${treasury} funded on rh (${lastBalance} wei) after ${elapsed}s — proceeding`);
      return "funded";
    }
    if (elapsed >= waitSec) {
      logger.warn(
        `!!! registration: treasury ${treasury} rh balance ${lastBalance === null ? "unreadable" : `${lastBalance} wei`} < floor ${REGISTRATION_GAS_FLOOR_WEI} wei after ${elapsed}s ` +
          `(registrationGasWaitSec ${waitSec}) — attempting registerInstance for agent ${agentId} ANYWAY !!!`,
      );
      return "timeout";
    }
    if (lastLogAt === null || now - lastLogAt >= REGISTRATION_GAS_LOG_SEC) {
      lastLogAt = now;
      logger.info(
        `registration: waiting for preGas … treasury ${treasury} rh balance ${lastBalance === null ? "unreadable" : `${lastBalance} wei`} < ${REGISTRATION_GAS_FLOOR_WEI} wei ` +
          `(${elapsed}s / ${waitSec}s)`,
      );
    }
    const remaining = waitSec - elapsed;
    const stepSec = remaining < REGISTRATION_GAS_POLL_SEC ? remaining : REGISTRATION_GAS_POLL_SEC;
    await sleep(Number(stepSec) * 1000);
  }
}

/**
 * Boot registration gate (revival-aware). Reads registry.instanceOf(agentId) on rh
 * (lastHeartbeat == 0 ⇔ unregistered, = the contract's isRegistered):
 *   - unregistered                                     ⇒ registerInstance (genesis; generation := 1)
 *   - registered AND now − lastHeartbeat > REVIVAL_WINDOW ⇒ registerInstance (REVIVAL: the contract bumps
 *     generation and replaces attestationRef with this boot's report; AgentRegistry.sol:96-105)
 *   - registered and fresh                             ⇒ skip (normal restart; a send would revert
 *     RevivalWindowNotElapsed and burn gas)
 * REVIVAL_WINDOW is read from the contract's public constant (AgentRegistry.sol:13, 7 days) — never
 * assumed — and the comparison is the contract's own (strictly greater). A stale record whose pinned
 * (treasury, action, codeHash) differ from ours would revert MismatchedRevivalKeys ⇒ LOUD warning, nothing
 * sent. Registration goes through the normal deps (engine T1 → keyring K2 rebuilds the tx from its attached
 * cfg). Never throws (SPEC-M3C §5: a throwing execute ⇒ "sendFailed"): a failed read or send is a LOUD warning and boot continues (heartbeats will keep
 * failing visibly; the genesis orchestrator / reviver watches registration). A failed read sends nothing.
 * SPEC-M3C §10: right before the send (genesis and revival only — never on skip / keyMismatch), waits for
 * the treasury's rh gas via waitForRegistrationGas (`wait`: DEFAULT 600 s, systemClock, real sleep).
 */
export async function ensureRegistered(
  cfg: ResolvedConfig,
  agentId: number,
  chain: ChainClient,
  exec: ExecDeps,
  logger: BootLogger,
  now: UnixSeconds,
  wait: RegistrationGasWaitOptions = {},
): Promise<RegistrationOutcome> {
  let inst: RegistryInstance;
  let windowSec: bigint | null = null;
  try {
    inst = parseInstance(
      await chain.readContract("rh", { address: cfg.registry.rh, abi: agentRegistryAbi, functionName: "instanceOf", args: [BigInt(agentId)] }),
    );
    if (inst.lastHeartbeat !== 0n) {
      const w = await chain.readContract("rh", { address: cfg.registry.rh, abi: agentRegistryAbi, functionName: "REVIVAL_WINDOW", args: [] });
      if (typeof w !== "bigint" || w <= 0n) throw new Error(`REVIVAL_WINDOW returned ${typeof w === "bigint" ? w.toString(10) : typeof w}, expected a positive uint64`);
      windowSec = w;
    }
  } catch (e) {
    logger.warn(`!!! registration: registry.instanceOf(${agentId}) / REVIVAL_WINDOW read FAILED (${errMsg(e)}) — NOT registering at boot; heartbeats will fail until the instance is registered !!!`);
    return "readFailed";
  }

  let revival = false;
  if (windowSec !== null) {
    const age = now - inst.lastHeartbeat;
    if (age <= windowSec) {
      logger.info(`registration: agent ${agentId} already registered (generation ${inst.generation}, heartbeat ${age}s ago ≤ revival window ${windowSec}s) — skipping registerInstance`);
      return "alreadyRegistered";
    }
    const own = keyringAddresses(exec);
    const reg = cfg.registration;
    if (
      own === null ||
      reg === undefined ||
      inst.treasuryEOA.toLowerCase() !== own.treasury.toLowerCase() ||
      inst.actionEOA.toLowerCase() !== own.action.toLowerCase() ||
      inst.codeHash.toLowerCase() !== reg.codeHash.toLowerCase()
    ) {
      logger.warn(
        `!!! registration: agent ${agentId} is registered to a DIFFERENT instance (treasury ${inst.treasuryEOA}, codeHash ${inst.codeHash}) and stale — ` +
          "revival requires identical pinned keys + codeHash (MismatchedRevivalKeys); NOT sending !!!",
      );
      return "keyMismatch";
    }
    revival = true;
    logger.info(`registration: agent ${agentId} heartbeat stale (${age}s > revival window ${windowSec}s) — REVIVING (generation ${inst.generation} → ${inst.generation + 1})`);
  }

  // SPEC-M3C §10: a registerInstance send is about to happen — wait (bounded) for the preGas.
  try {
    await waitForRegistrationGas(chain, cfg.treasury, agentId, logger, wait);
  } catch (e) {
    logger.warn(`!!! registration: gas wait FAILED unexpectedly (${errMsg(e)}) — attempting registerInstance anyway !!!`);
  }

  // SPEC-M3C §5: execute can still throw (chain.getNonce / sendRaw, or a throwing getState) — honor
  // "never throws" here too.
  let r: ExecResult;
  try {
    r = await execute({ kind: "registerInstance" }, exec);
  } catch (e) {
    logger.warn(
      `!!! registration: registerInstance THREW for agent ${agentId}${revival ? " (revival)" : ""} (${errMsg(e)}) — boot continues UNREGISTERED; heartbeats will fail visibly !!!`,
    );
    return "sendFailed";
  }
  if (r.verdict.allow && r.error === undefined) {
    logger.info(`registration: registerInstance sent for agent ${agentId}${revival ? " (revival)" : ""} (tx ${r.txHash ?? "?"})`);
    return revival ? "revived" : "registered";
  }
  const why = r.verdict.allow ? (r.error ?? "unknown error") : `${r.verdict.code}: ${r.verdict.detail}`;
  logger.warn(`!!! registration: registerInstance FAILED for agent ${agentId}${revival ? " (revival)" : ""} (${why}) — boot continues UNREGISTERED; heartbeats will fail visibly !!!`);
  return "sendFailed";
}

// ---------------------------------------------------------------------------
// SPEC-M3C §11 — registration retry loop (second e2e finding 2026-09-24: a one-shot boot registration
// died to a transient — instanceOf read flake ⇒ "readFailed", or a transient rh RPC failure inside
// getState ⇒ G5 STATE_STALE ⇒ "sendFailed"). Every variant gets the same cure: bounded RETRY.
// ---------------------------------------------------------------------------

/** DEFAULT runtime.registrationRetrySec — total retry budget (SPEC-M3C §11). */
export const DEFAULT_REGISTRATION_RETRY_SEC = 900;
/** DEFAULT runtime.registrationRetryDelaySec — sleep between attempts (SPEC-M3C §11). */
export const DEFAULT_REGISTRATION_RETRY_DELAY_SEC = 30;
/** §10 gas-wait budget passed on RETRIES so the loop's cadence dominates (SPEC-M3C §11). */
export const REGISTRATION_RETRY_GAS_WAIT_SEC = 60;

export interface RegistrationRetryOptions {
  /** Total retry budget in seconds, measured from the first attempt (DEFAULT DEFAULT_REGISTRATION_RETRY_SEC). */
  retrySec?: number;
  /** Delay between attempts in seconds (DEFAULT DEFAULT_REGISTRATION_RETRY_DELAY_SEC); the last sleep is clamped to the deadline. */
  retryDelaySec?: number;
  /** §10 gas-wait budget for the FIRST attempt (DEFAULT DEFAULT_REGISTRATION_GAS_WAIT_SEC); retries use REGISTRATION_RETRY_GAS_WAIT_SEC. */
  waitSec?: number;
  /** DEFAULT systemClock. */
  clock?: Clock;
  /** DEFAULT realSleep (same injectable SleepFn as §10). */
  sleep?: SleepFn;
}

const REGISTRATION_TERMINAL: ReadonlySet<RegistrationOutcome> = new Set<RegistrationOutcome>(["registered", "revived", "alreadyRegistered", "keyMismatch"]);

/**
 * SPEC-M3C §11: boot step (7) — ensureRegistered in a bounded retry loop.
 *   - "registered" | "revived" | "alreadyRegistered" | "keyMismatch" ⇒ stop (keyMismatch is permanent).
 *   - "readFailed" | "sendFailed" ⇒ sleep retryDelaySec (clamped to the deadline) and retry, until
 *     retrySec has elapsed since the first attempt (clock-measured, so §10 gas waits count toward it).
 *     Each attempt re-reads instanceOf first (ensureRegistered does), so a send whose receipt was lost
 *     converges to "alreadyRegistered" instead of double-sending.
 *   - First attempt: §10 waitSec as configured (DEFAULT 600); retries: REGISTRATION_RETRY_GAS_WAIT_SEC.
 * LOUD warning on final give-up. NEVER throws (a throwing clock/sleep/attempt ⇒ warn + return the last
 * outcome); boot continues either way.
 */
export async function ensureRegisteredWithRetry(
  cfg: ResolvedConfig,
  agentId: number,
  chain: ChainClient,
  exec: ExecDeps,
  logger: BootLogger,
  opts: RegistrationRetryOptions = {},
): Promise<RegistrationOutcome> {
  const clock = opts.clock ?? systemClock;
  const sleep = opts.sleep ?? realSleep;
  const budgetSec = BigInt(opts.retrySec ?? DEFAULT_REGISTRATION_RETRY_SEC);
  const delaySec = BigInt(opts.retryDelaySec ?? DEFAULT_REGISTRATION_RETRY_DELAY_SEC);
  const firstWaitSec = opts.waitSec ?? DEFAULT_REGISTRATION_GAS_WAIT_SEC;
  let outcome: RegistrationOutcome = "readFailed";
  let attempts = 0;
  try {
    const start = clock();
    for (;;) {
      const waitSec = attempts === 0 ? firstWaitSec : REGISTRATION_RETRY_GAS_WAIT_SEC;
      attempts++;
      try {
        outcome = await ensureRegistered(cfg, agentId, chain, exec, logger, clock(), { waitSec, clock, sleep });
      } catch (e) {
        // ensureRegistered never throws by contract; defense in depth (SPEC-M3C §11 "never throws").
        logger.warn(`!!! registration: attempt ${attempts} THREW unexpectedly (${errMsg(e)}) — treating as sendFailed !!!`);
        outcome = "sendFailed";
      }
      if (REGISTRATION_TERMINAL.has(outcome)) {
        if (attempts > 1) logger.info(`registration: agent ${agentId} ${outcome} on attempt ${attempts}`);
        return outcome;
      }
      const elapsed = clock() - start;
      if (elapsed >= budgetSec) {
        logger.warn(
          `!!! registration: GIVING UP for agent ${agentId} after ${attempts} attempt(s) / ${elapsed}s (registrationRetrySec ${budgetSec}; last outcome ${outcome}) — ` +
            "boot continues UNREGISTERED; heartbeats will fail visibly !!!",
        );
        return outcome;
      }
      const remaining = budgetSec - elapsed;
      const stepSec = remaining < delaySec ? remaining : delaySec;
      logger.info(`registration: attempt ${attempts} ${outcome} — retrying in ${stepSec}s (${elapsed}s / ${budgetSec}s)`);
      await sleep(Number(stepSec) * 1000);
    }
  } catch (e) {
    logger.warn(
      `!!! registration: retry loop FAILED unexpectedly for agent ${agentId} after ${attempts} attempt(s) (${errMsg(e)}; last outcome ${outcome}) — ` +
        "boot continues UNREGISTERED !!!",
    );
    return outcome;
  }
}

function keyringAddresses(exec: ExecDeps): OwnAddresses | null {
  try {
    return exec.keyring.addresses();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

export async function boot(opts: BootOptions): Promise<Runtime> {
  const clock = opts.clock ?? systemClock;
  const ov = opts.overrides ?? {};
  const logger = ov.logger ?? consoleLogger;
  const timers = ov.timers ?? nodeTimers;

  // (1) config
  const loaded =
    opts.runtimeConfigPath !== undefined
      ? loadSplitConfigFiles(opts.configPath, opts.runtimeConfigPath, opts.expectedHash)
      : loadConfigFile(opts.configPath, opts.expectedHash);
  const baseDir = loaded.baseDir;
  const rt = loaded.runtime;

  // (1b) Oyster init-param cross-checks (before the KMS: a mismatched deployment derives nothing).
  const agentId = AgentConfigSchema.parse(loaded.agent).agentId;
  // tee: runtime.json is UNATTESTED — letting it relocate the init-params dir would let an operator
  // point boot at a forged config-hash file (e.g. an extra unattested init param) while the REAL attested
  // hash keeps deriving the real keys. So under tee the dir is fixed (compose mounts /init-params, measured).
  if (rt.tee && rt.initParamsDir !== undefined && resolve(baseDir, rt.initParamsDir) !== DEFAULT_INIT_PARAMS_DIR) {
    throw new Error(
      `boot: runtime.tee forbids runtime.initParamsDir (${rt.initParamsDir}) — the attested init params are read only from ${DEFAULT_INIT_PARAMS_DIR}`,
    );
  }
  const initParamsDir = resolve(baseDir, opts.initParamsDir ?? rt.initParamsDir ?? DEFAULT_INIT_PARAMS_DIR);
  const initParam = checkInitParamAgentId(initParamsDir, agentId);
  if (initParam === "match") logger.info(`init param agent-id matches config (agent-${agentId})`);
  else if (rt.tee) logger.warn(`runtime.tee: no ${resolve(initParamsDir, "agent-id")} — deployed without the attested agent-id init param?`);
  // SPEC-M3 §3b: the attested config-hash binds keys to (codeHash, agentId, configHash).
  const hashParam = checkInitParamConfigHash(initParamsDir, loaded.frozenHash);
  if (hashParam === "match") logger.info(`init param config-hash matches the frozen config (${loaded.frozenHash})`);
  else if (rt.tee) throw new UnboundTeeBootError(resolve(initParamsDir, "config-hash"));

  // (1c) SPEC-M3B §2 TLS config checks (before the KMS).
  let tlsDomain: string | undefined;
  if (rt.tls.enabled) {
    const root = PlatformConfigSchema.parse(loaded.platform).agentDnsRoot;
    if (root === undefined) throw new Error("boot: runtime.tls.enabled requires platform.agentDnsRoot (frozen) — the agent's domain is a<agentId>.<agentDnsRoot>");
    tlsDomain = agentDomain(agentId, root);
  }

  // (2) keyring
  // tee: validate everything that can fail fast BEFORE touching the KMS (no retry loop on a bad config).
  let teeImageId: Hex | undefined;
  let attestationUrl = DEFAULT_ATTESTATION_URL;
  if (rt.tee) {
    if (rt.imageId === undefined) throw new Error("boot: runtime.tee requires runtime.imageId (enclave image id = registry codeHash)");
    teeImageId = rt.imageId.toLowerCase() as Hex;
    attestationUrl = rt.attestationUrl ?? DEFAULT_ATTESTATION_URL;
    assertLocalhostUrl(attestationUrl);
    if (rt.mockKms !== undefined) logger.warn("runtime.tee: runtime.mockKms is ignored (NautilusKms in use)");
  }
  let kms = opts.kms;
  if (kms === undefined) {
    if (rt.tee) {
      kms = new NautilusKms(rt.kmsUrl ?? DEFAULT_KMS_URL); // throws on a non-localhost URL
    } else {
      if (rt.mockKms === undefined) throw new Error("boot: no KMS — pass opts.kms, set runtime.mockKms, or runtime.tee");
      kms = new MockKms(rt.mockKms.imageId, rt.mockKms.agentId);
    }
  }
  const keyring = await createKeyring(kms, opts.kmsRetry !== undefined ? { retry: opts.kmsRetry } : undefined);
  const resolved = resolveConfig({ platform: loaded.platform, agent: loaded.agent, ownAddresses: keyring.addresses() });

  // (2a) SPEC-M3B §3 Turbo/Arweave sink (treasury-signed via keyring.turboSigner; no raw key leaves the keyring).
  let turboSink: TurboArweaveSink | null = null;
  let turboPayment: TurboPayment | null = null;
  if (rt.arweave.enabled) {
    const uploader =
      ov.turboUploader ??
      createHttpTurboUploader(keyring.turboSigner(), {
        ...(rt.arweave.uploadUrl !== undefined ? { uploadUrl: rt.arweave.uploadUrl } : {}),
        ...(rt.arweave.paymentUrl !== undefined ? { paymentUrl: rt.arweave.paymentUrl } : {}),
        ...(rt.arweave.gatewayUrl !== undefined ? { gatewayUrl: rt.arweave.gatewayUrl } : {}),
      });
    turboSink = new TurboArweaveSink({ uploader, agentId, owner: keyring.addresses().treasury, logger });
    turboPayment = ov.turboPayment ?? (isTurboPayment(uploader) ? uploader : null);
    logger.info(
      `arweave: Turbo sink enabled for attestation + snapshots (owner ${keyring.addresses().treasury}; ` +
        `uploader ${ov.turboUploader !== undefined ? "override" : (rt.arweave.uploadUrl ?? DEFAULT_TURBO_UPLOAD_URL)}; local mirror ${rt.arweave.localMirror ? "on" : "off"})`,
    );
  }

  // (2b) SPEC-M3 §2 attestation: quote → report → sink → cfg.registration (real registerInstance values,
  // replacing any fixture registration from the platform config).
  let attestationRef: string | null = null;
  let attestationReport: string | null = null;
  let registration = resolved.registration;
  if (teeImageId !== undefined) {
    const quote = await withRetry(() => fetchAttestation(attestationUrl), opts.kmsRetry);
    const now = clock();
    const report = buildReport({
      quote,
      imageId: teeImageId,
      imageDigest: rt.imageDigest ?? null,
      configHash: loaded.frozenHash, // = the attested config-hash init param (SPEC-M3 §3b)
      ownAddresses: keyring.addresses(),
      generation: null, // assigned by AgentRegistry.registerInstance; unknown pre-registration
      now,
    });
    const localAtt = new AttestationDirSink(resolve(baseDir, rt.attestationDir ?? "attestations"));
    const sink: AttestationSink =
      ov.attestationSink ??
      (turboSink === null ? localAtt : rt.arweave.localMirror ? new MirroredAttestationSink(turboSink, [localAtt], logger) : turboSink);
    if (sink instanceof AttestationDirSink) {
      logger.warn(
        "!!! attestationRef is a LOCAL file — not publishable on-chain; wire Turbo (s2) before registering for real !!!",
      );
    }
    attestationRef = await sink.upload(report, now);
    attestationReport = report;
    registration = { codeHash: teeImageId, attestationRef };
    logger.info(`attestation report published: ${attestationRef} (imageId ${teeImageId})`);
  }
  const genesisCfg: ResolvedConfig = teeImageId !== undefined ? { ...resolved, registration } : resolved;
  keyring.attachConfig(genesisCfg);

  // (3) memory
  const dbPath = opts.dbPath ?? (rt.dbPath === ":memory:" ? ":memory:" : resolve(baseDir, rt.dbPath ?? "memory.sqlite"));
  const localSnapshots = new LocalDirSink(opts.snapshotDir ?? resolve(baseDir, rt.snapshotDir ?? "snapshots"));
  let snapshotSink: SnapshotSink;
  let restoreSinks: SnapshotSink[];
  if (ov.snapshotSink !== undefined) {
    snapshotSink = ov.snapshotSink;
    restoreSinks = [ov.snapshotSink];
  } else if (turboSink !== null) {
    // SPEC-M3B §3: Turbo first (wins createdAt ties), local mirror second.
    snapshotSink = rt.arweave.localMirror ? new MirroredSnapshotSink(turboSink, [localSnapshots], logger) : turboSink;
    restoreSinks = rt.arweave.localMirror ? [turboSink, localSnapshots] : [turboSink];
  } else {
    snapshotSink = localSnapshots;
    restoreSinks = [localSnapshots];
  }
  const opened = await openOrRestoreMemory(dbPath, restoreSinks, keyring.memKeyForMemoryModule(), clock(), logger);
  const db = opened.db;

  // (3b) SPEC-M3B §4: re-apply the newest adopted signed allowlist (fully re-verified) BEFORE any
  // deps / endpoints / pulse exist. `cfg` is the ONE mutable config slot from here on (applyCfg).
  const allowlistOptedIn = adoptsAllowlistUpdates(genesisCfg.agent);
  const allowlistSigner = genesisCfg.allowlistUpdateSigner;
  let cfg: ResolvedConfig = genesisCfg;
  const reapplied = await reapplyAdoptedAllowlist({ optedIn: allowlistOptedIn, signer: allowlistSigner, db, base: genesisCfg, logger });
  if (reapplied !== null) {
    cfg = reapplied.cfg;
    keyring.updateAllowlist(cfg.x402Allowlist);
  }

  // (4) ExecDeps
  const rpcUrls = definedUrls(rt.rpc);
  const chain: ChainClient =
    ov.chain ?? (Object.keys(rpcUrls).length > 0 ? new RealChainClient({ rpcUrls, chainIds: cfg.chainIds }) : new MockChainClient());
  if (ov.chain === undefined && Object.keys(rpcUrls).length === 0) {
    logger.warn("no runtime.rpc configured: using MockChainClient (M2 mock chain — nothing reaches a real network)");
  }
  const getState: StateReader = ov.state ?? chainStateReader(chain, cfg, rt.hosting, { logger, clock });

  let ledgerCache: BudgetLedger = loadLedger(db) ?? emptyLedger(clock());
  const ledger: LedgerStore = {
    get: () => ledgerCache,
    set: (l) => {
      ledgerCache = l;
      saveLedger(db, l, clock());
    },
  };

  // SPEC-M3D §3c: platform.farcaster AND runtime.tee ⇒ fcSink (memory mirror first, then the hubs); else
  // memoryCastSink as before; overrides.castSink wins.
  const fcCfg = cfg.farcaster;
  const farcasterOn = fcCfg !== undefined && rt.tee;
  let castSink: CastSink = memoryCastSink(db, clock);
  if (ov.castSink !== undefined) {
    castSink = ov.castSink;
  } else if (farcasterOn) {
    castSink = fcSink({
      mirror: castSink,
      hub: ov.hubClient ?? new HubClient({ hubs: fcCfg.hubs }),
      signerPublicKey: keyring.farcasterPublicKey(),
      fid: () => readFcFid(db),
      logger,
    });
    logger.info(`farcaster: fcSink enabled (${fcCfg.hubs.length} hub(s): ${fcCfg.hubs.map((h) => h.id).join(", ")}); fid ${readFcFid(db)?.toString(10) ?? "pending"}`);
  } else if (fcCfg !== undefined) {
    logger.info("farcaster: platform.farcaster present but runtime.tee is off — module disabled (casts stay local drafts)");
  }

  /** Base deps WITHOUT log: runPulse wraps it with memoryExecDeps (which logs), avoiding double rows. */
  const baseExec: ExecDeps = {
    cfg,
    keyring,
    chain,
    getState,
    ledger,
    clock,
    castSink,
    journalSink: memoryJournalSink(db, clock),
  };
  /** Logged deps: every ExecResult → actions row. Daemon, announcements, chat. */
  const exec: ExecDeps = { ...baseExec, log: (r) => recordExecResult(db, r, clock()), annotate: (r) => annotateExecResult(db, r) };

  // (5) components
  const endpoints = new EndpointManager(cfg);
  const llm = ov.llm ?? unconfiguredLlm;
  const x402 = ov.x402 ?? unconfiguredX402;
  // SPEC-M3 §3 real transport. Pulse + chat pass their own memory-logged ExecDeps per call; `exec`
  // (logged) is only the client's default.
  let paidInference: PaidInferenceClient | undefined = ov.paidInference;
  if (paidInference === undefined && rt.x402.enabled) {
    const insecure = rt.x402.allowInsecureHttp ?? false;
    if (insecure) logger.warn("runtime.x402.allowInsecureHttp: plain http:// inference endpoints permitted — local testing ONLY");
    const http = ov.http ?? new FetchHttpClient({ allowInsecureHttp: insecure });
    paidInference = new X402HttpInference({ http, exec, endpoints });
    logger.info("x402: real HTTP transport enabled for pulse + chat inference");
  }
  const chainReader = ov.chainReader ?? chainFeeReader(chain, cfg);

  const sharedTiers = kvTierStore(db);
  /** Daemon view of the shared tier store: records the (from,to,dayKey) dedupe key on its transitions
   *  (daemon step 9 posts its own journal+cast drafts). */
  const daemonTiers: TierStore = {
    get: () => sharedTiers.get(),
    set: (next) => {
      const prev = sharedTiers.get();
      sharedTiers.set(next);
      if (prev !== undefined && prev !== next) {
        const key = tierAnnounceKey({ from: prev, to: next }, clock());
        if (kvGet(db, key) === undefined) kvSet(db, key, "daemon");
      }
    },
  };
  // (5b) SPEC-M3B §2 TLS ingress: placeholder (KMS-derived Ed25519, deterministic) + persisted cert.
  let tlsManager: TlsManager | null = null;
  if (tlsDomain !== undefined) {
    if (cfg.chatDomain === undefined) {
      db.close();
      throw new Error("boot: runtime.tls.enabled requires the chat server (platform.chatDomain) — TLS ingress fronts chat");
    }
    const tlsDir = rt.tls.dir !== undefined ? resolve(baseDir, rt.tls.dir) : dbPath === ":memory:" ? resolve(baseDir, "tls") : resolve(dirname(dbPath), "tls");
    const placeholder = placeholderMaterial(tlsDomain, ed25519KeyFromSeed(await keyring.tlsPlaceholderKey()));
    const store = new CertStore({ domain: tlsDomain, dir: tlsDir, placeholder });
    const loadedCert = store.loadPersisted(clock(), logger);
    tlsManager = new TlsManager({
      store,
      directoryUrl: rt.tls.acmeDirectoryUrl ?? LETS_ENCRYPT_PRODUCTION,
      accountKeyPem: async () => acmeAccountKeyPem(await keyring.acmeAccountKey()),
      clock,
      timers,
      logger,
      ...(ov.acme !== undefined ? { acme: ov.acme } : {}),
      ...(rt.tls.retrySec !== undefined ? { retrySec: BigInt(rt.tls.retrySec) } : {}),
    });
    logger.info(`tls: ${tlsDomain} — ${loadedCert ? "persisted certificate loaded" : "placeholder until first issuance"} (spki ${store.current().spkiSha256}, dir ${tlsDir})`);
  }
  const tls = tlsManager;

  /**
   * SPEC-M3B §4 single cfg swap: every long-lived ExecDeps view gets the SAME new object (pulse and chat
   * build their memory-logged views from baseExec per call), plus keyring K3 + EndpointManager reload.
   */
  function applyCfg(next: ResolvedConfig): void {
    keyring.updateAllowlist(next.x402Allowlist);
    cfg = next;
    baseExec.cfg = next;
    exec.cfg = next;
    daemonDeps.cfg = next;
    endpoints.reload(next);
  }

  // SPEC-M3B §4 daemon step 11 (opted-in agents only; opted out ⇒ no fetcher is ever constructed).
  let allowlistHook: AllowlistUpdateHook | undefined;
  if (!allowlistOptedIn) {
    logger.info("allowlist updates: opted out at genesis (frozen agent.adoptAllowlistUpdates=false) — never fetching");
  } else if (allowlistSigner === undefined) {
    logger.warn("allowlist updates: no frozen platform.allowlistUpdateSigner — signed updates cannot be verified; not checking");
  } else if (ov.allowlistSource === undefined && rt.allowlistUpdateUrl === undefined) {
    logger.info("allowlist updates: runtime.allowlistUpdateUrl unset — not checking");
  } else {
    const source = ov.allowlistSource ?? new FetchAllowlistSource(rt.allowlistUpdateUrl!);
    const intervalSec = rt.allowlistUpdateIntervalSec !== undefined ? BigInt(rt.allowlistUpdateIntervalSec) : ALLOWLIST_CHECK_INTERVAL_SEC;
    const updateDeps: AllowlistUpdateDeps = {
      optedIn: allowlistOptedIn,
      signer: allowlistSigner,
      source,
      db,
      clock,
      cfg: () => cfg,
      apply: applyCfg,
      journal: async (text) => {
        const j = contentAction("journalWrite", text, cfg);
        return j.ok ? execute(j.action, exec, j.extras) : null;
      },
    };
    allowlistHook = { due: (now) => allowlistCheckDue(db, now, intervalSec), run: (now) => runAllowlistCheck(updateDeps, now) };
    logger.info(`allowlist updates: checking every ${intervalSec}s (signer ${allowlistSigner})`);
  }

  // SPEC-M3D §2 daemon step 12: Turbo self-top-up (arweave enabled AND turboTopUp.enabled, DEFAULT true then).
  let turboTopUpHook: DaemonStepHook | undefined;
  if (rt.arweave.enabled && (rt.turboTopUp?.enabled ?? true)) {
    const payment = turboPayment;
    if (payment === null) {
      logger.warn("turbo top-up: the Turbo uploader has no payment seam — daemon step 12 disabled");
    } else {
      const lowWatermarkWinc = rt.turboTopUp?.lowWatermarkWinc ?? DEFAULT_TURBO_LOW_WATERMARK_WINC;
      const amountWei = rt.turboTopUp?.amountWei ?? DEFAULT_TURBO_TOPUP_AMOUNT_WEI;
      turboTopUpHook = {
        due: (now) => turboTopUpDue(db, now),
        run: (now) => runTurboTopUp({ payment, exec, db, lowWatermarkWinc, amountWei, logger, sleep: realSleep }, now),
      };
      logger.info(`turbo top-up: daily; watermark ${lowWatermarkWinc} winc, amount ${amountWei} wei → frozen ${cfg.arweaveFundingAddress}`);
    }
  }

  // SPEC-M3D §3d daemon step 13: Farcaster on-chain onboarding (platform.farcaster AND runtime.tee).
  const fcOnboardHook: DaemonStepHook | undefined = farcasterOn
    ? { due: () => fcOnboardDue(db), run: (now) => runFcOnboard({ exec, db, logger }, now) }
    : undefined;

  const daemonDeps: DaemonDeps = {
    ...exec,
    chainReader,
    memory: db,
    snapshotSink,
    tierStore: daemonTiers,
    ...(tls !== null ? { tlsRenewal: tls } : {}),
    ...(allowlistHook !== undefined ? { allowlistUpdate: allowlistHook } : {}),
    ...(turboTopUpHook !== undefined ? { turboTopUp: turboTopUpHook } : {}),
    ...(fcOnboardHook !== undefined ? { fcOnboard: fcOnboardHook } : {}),
  };

  /** SPEC-M3B §2 GET /attestation (wired iff there is a tee report or a TLS cert to pin). */
  const attestationProvider =
    attestationReport !== null || tls !== null
      ? async (): Promise<AttestationPayload> => {
          const cur = tls?.store.current();
          return {
            report: attestationReport,
            attestationRef,
            certSpkiSha256: cur?.spkiSha256 ?? null,
            certKind: cur?.kind ?? null,
            domain: tls?.store.domain ?? null,
          };
        }
      : undefined;

  let chat: ChatServer | null = null;
  if (cfg.chatDomain !== undefined) {
    let readers = ov.chatReaders;
    if (readers === undefined) {
      const urls = cfg.chatRpc;
      if (urls === undefined) {
        db.close();
        throw new Error("boot: cfg.chatDomain set but cfg.chatRpc (two independent RPC urls) missing — chat gate cannot fail closed");
      }
      const rh = { rh: cfg.chainIds.rh };
      readers = [
        chainBalanceReader(new RealChainClient({ rpcUrls: { rh: urls[0] }, chainIds: rh }), cfg),
        chainBalanceReader(new RealChainClient({ rpcUrls: { rh: urls[1] }, chainIds: rh }), cfg),
      ];
    }
    // baseExec (no log): createChatServer wraps it with memoryExecDeps, which logs to `actions`.
    chat = createChatServer({
      exec: baseExec,
      db,
      llm,
      x402,
      ...(paidInference !== undefined ? { paidInference } : {}),
      endpoints,
      readers,
      tier: async () => sharedTiers.get() ?? tierOf(runwayDays(await getState(), clock(), undefined, cfg.bridgeHaircutBps)),
      ...(attestationProvider !== undefined ? { attestation: attestationProvider } : {}),
    });
  }

  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = tail.then(() => {
      if (closed) throw new Error("runtime stopped");
      return fn();
    });
    tail = p.catch(() => undefined);
    return p;
  }

  async function announceOnce(t: TierTransition, source: "pulse" | "manual"): Promise<ExecResult[] | null> {
    const now = clock();
    const key = tierAnnounceKey(t, now);
    if (kvGet(db, key) !== undefined) return null;
    kvSet(db, key, source);
    const out: ExecResult[] = [];
    const j = contentAction("journalWrite", `[pulse] tier transition ${t.from} -> ${t.to} at ${now}.`, cfg);
    if (j.ok) out.push(await execute(j.action, exec, j.extras));
    const fid = readFcFid(db); // SPEC-M3D §3e ruling: fid injection on the announcement cast too
    const c = await announceTierTransition(t, exec, fid !== undefined ? { fid, now } : undefined);
    if (c !== null) out.push(c);
    return out;
  }

  async function daemonTickInner(): Promise<TickReport> {
    const report = await tick(daemonDeps, clock());
    saveLedger(db, ledger.get(), clock()); // ≥ 1 history row per tick (burn calc), even when idle
    kvSet(db, KV_DAEMON_NEXT_AT, report.nextTickAt.toString(10));
    return report;
  }

  async function pulseInner(): Promise<PulseCycle> {
    const now = clock();
    // Provisional next time FIRST: a crash mid-pulse must not cause a paid-pulse storm on restart.
    const provisional = PULSE_INTERVAL_SEC.Active ?? 1_800n;
    kvSet(db, KV_PULSE_NEXT_AT, (now + provisional).toString(10));

    const prev = sharedTiers.get();
    const state = await getState();
    const days = runwayDays(state, now, undefined, cfg.bridgeHaircutBps);
    const pressure = budgetPressure(ledger.get(), cfg, now, days >= BigInt(cfg.minRunwayDays));
    const plan = planNext(
      { tier: prev ?? "Active", nextPulseAt: null, stretch: false },
      { runwayDays: days, hostingLapsed: hostingLapsed(state, now), pressure, now },
    );
    const tierNow = plan.state.tier;
    let transition: TierTransition | null = null;
    let announcement: ExecResult[] | null = null;
    if (prev === undefined) {
      sharedTiers.set(tierNow);
    } else if (plan.transition !== null) {
      transition = plan.transition;
      sharedTiers.set(tierNow);
      announcement = await announceOnce(transition, "pulse");
    }

    const result = await runPulse({
      exec: baseExec,
      db,
      llm,
      x402,
      ...(paidInference !== undefined ? { paidInference } : {}),
      endpoints,
      tier: tierNow,
      prevTier: prev,
      sources: ov.sources,
    });
    saveLedger(db, ledger.get(), clock());
    const nextPulseAt = nextPulse(tierNow, result.stretch, clock());
    kvSet(db, KV_PULSE_NEXT_AT, nextPulseAt === null ? "" : nextPulseAt.toString(10));
    return { result, tier: tierNow, transition, announcement, nextPulseAt };
  }

  const daemonLoop = new Loop("daemon", timers, clock, async () => {
    try {
      await exclusive(daemonTickInner);
    } finally {
      // Dormant → awake: the pulse loop is idle (no pulses scheduled) until the daemon wakes it.
      const t = sharedTiers.get();
      if (!closed && t !== undefined && pulsesEnabled(t) && pulseLoop.idle()) {
        pulseLoop.scheduleAt(kvBigint(db, KV_PULSE_NEXT_AT) ?? clock());
      }
    }
    return kvBigint(db, KV_DAEMON_NEXT_AT) ?? nextTickAt(clock(), cfg);
  }, logger);

  const pulseLoop: Loop = new Loop("pulse", timers, clock, async () => (await exclusive(pulseInner)).nextPulseAt, logger);

  let started = false;
  let chatAddr: { host: string; port: number } | null = null;
  let stopping: Promise<void> | null = null;

  // (7) Boot auto-registration (tee + cfg.registration), after every component exists and before start().
  // SPEC-M3C §11: bounded retry loop (readFailed/sendFailed ⇒ retry); never throws; chat/schedulers start after.
  if (teeImageId !== undefined && cfg.registration !== undefined) {
    await ensureRegisteredWithRetry(cfg, agentId, chain, exec, logger, {
      waitSec: rt.registrationGasWaitSec ?? DEFAULT_REGISTRATION_GAS_WAIT_SEC,
      retrySec: rt.registrationRetrySec ?? DEFAULT_REGISTRATION_RETRY_SEC,
      retryDelaySec: rt.registrationRetryDelaySec ?? DEFAULT_REGISTRATION_RETRY_DELAY_SEC,
      clock,
      sleep: realSleep,
    });
  }

  const runtime: Runtime = {
    get cfg(): ResolvedConfig {
      return cfg;
    },
    configHash: loaded.hash,
    frozenHash: loaded.frozenHash,
    db,
    keyring,
    endpoints,
    exec,
    restoredFrom: opened.restoredFrom,
    attestationRef,
    chat,
    chatAddress: () => chatAddr,
    tls,

    async start(): Promise<void> {
      if (closed) throw new Error("runtime stopped");
      if (started) return;
      started = true;
      if (chat !== null && tls !== null) {
        const addr = await chat.listen({
          tls: tls.listenMode(),
          port: ov.chatPort ?? rt.tls.port ?? TLS_DEFAULT_PORT,
          host: rt.chatHost ?? "0.0.0.0",
        });
        chatAddr = addr;
        logger.info(`chat listening with TLS on ${addr.host}:${addr.port} (${tls.store.domain})`);
        tls.start(); // background first issuance (placeholder served meanwhile)
      } else if (chat !== null) {
        const addr = await chat.listen({
          ...(ov.chatPort !== undefined ? { port: ov.chatPort } : {}),
          ...(rt.chatHost !== undefined ? { host: rt.chatHost } : {}),
        });
        chatAddr = addr;
        logger.info(`chat listening on ${addr.host}:${addr.port}`);
      }
      daemonLoop.start(kvBigint(db, KV_DAEMON_NEXT_AT) ?? clock());
      const storedPulse = kvGet(db, KV_PULSE_NEXT_AT);
      const t = sharedTiers.get();
      // "" ⇒ last plan said no pulses (Dormant/Evicted): wait for the daemon to wake us.
      const pulseAt = storedPulse === "" && t !== undefined && !pulsesEnabled(t) ? null : kvBigint(db, KV_PULSE_NEXT_AT) ?? clock();
      pulseLoop.start(pulseAt);
      logger.info(`runtime started (agent ${cfg.agent.agentId}, config ${loaded.hash})`);
    },

    stop(): Promise<void> {
      if (stopping !== null) return stopping;
      stopping = (async () => {
        daemonLoop.stop();
        pulseLoop.stop();
        const errors: string[] = [];
        if (tls !== null) await tls.stop();
        if (chat !== null) {
          try {
            await chat.close();
            chatAddr = null;
          } catch (e) {
            errors.push(`chat close: ${errMsg(e)}`);
          }
        }
        await tail; // in-flight tick/pulse finishes before the db goes away
        closed = true;
        try {
          const now = clock();
          const snap = await writeSnapshot(db, keyring.memKeyForMemoryModule(), snapshotSink, now, cfg.agent.agentId);
          kvSet(db, KV_LAST_SNAPSHOT_AT, now.toString(10));
          logger.info(`final snapshot ${snap.id}`);
        } catch (e) {
          errors.push(`final snapshot: ${errMsg(e)}`);
        } finally {
          db.close();
        }
        if (errors.length > 0) throw new Error(`runtime stop: ${errors.join("; ")}`);
      })();
      return stopping;
    },

    daemonTick: () => exclusive(daemonTickInner),
    pulse: () => exclusive(pulseInner),
    announceTierTransition: (t) => exclusive(() => announceOnce(t, "manual")),
    tier: () => (closed ? undefined : sharedTiers.get()),
    idle: async () => {
      await tail;
    },
  };
  return runtime;
}
