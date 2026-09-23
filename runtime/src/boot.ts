// SPEC-M2C §3 — composition root. boot(opts) assembles the whole runtime from a
// config file alone (plus optional test/ops overrides) and returns Runtime{start,stop}.
//
//   (1) config: read JSON (node:fs) → configHash over the WHOLE file (canonicalEncode) →
//       if opts.expectedHash is given it MUST match, else throw (03 §10 refuse-to-boot) →
//       zod-validate (file envelope strict; platform + agent via their schemas).
//   (2) keyring: createKeyring (withRetry inside) over opts.kms ?? MockKms(runtime.mockKms)
//       (real Nautilus KMS = M3) → resolveConfig with the derived OwnAddresses → attachConfig.
//   (3) memory: open dbPath; missing or corrupt AND snapshots exist ⇒ restoreLatest (03 §7).
//       A corrupt file is moved aside (never deleted). Corrupt with no snapshot, or snapshots
//       present but none restorable ⇒ throw (a fresh ledger would reset daily caps).
//   (4) ExecDeps: log → insertAction (every ExecResult, allow + deny: verdict / deny_code /
//       tx_hash / error); ledger store → loadLedger on boot (else emptyLedger), saveLedger on
//       EVERY set (budget consumption is persisted before any side effect); clock; chain
//       (override, else RealChainClient when runtime.rpc urls are configured, else
//       MockChainClient); getState from ChainClient reads.
//   (5) EndpointManager; chat server (createChatServer, enabled iff cfg.chatDomain is set;
//       dual balance readers over two independent RealChainClients on cfg.chatRpc, or
//       overrides.chatReaders); pulse + daemon schedulers as
//       start/stop-able setTimeout loops driven by nextPulse / nextTickAt (timers injectable),
//       serialized by one mutex (no concurrent nonce use). Tier changes: ONE shared kv tier
//       store for both detectors, and announcements deduped by (from,to,dayKey) in kv.
//   (6) Runtime.stop(): timers off → chat close → wait for in-flight tick/pulse → FINAL
//       snapshot (03 §7 "before planned shutdowns") → db close.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Address, Hex } from "viem";
import { parseAbi } from "viem";
import { z } from "zod";
import type { BalanceReader, Holdings } from "./chat/gate.js";
import { createChatServer, type ChatServer } from "./chat/server.js";
import { systemClock, type Clock } from "./clock.js";
import {
  AgentConfigSchema,
  bigintCoerce,
  configHash,
  PlatformConfigSchema,
  resolveConfig,
  type ResolvedConfig,
} from "./config/schema.js";
import { kvTierStore, KV_LAST_SNAPSHOT_AT, tick, type ChainReader, type DaemonDeps, type TickReport, type TierStore } from "./daemon/daemon.js";
import { nextTickAt } from "./daemon/scheduler.js";
import { erc20Abi, feeSplitHookAbi } from "./exec/abi.js";
import { MockChainClient, type ChainClient } from "./exec/chain.js";
import { execute, type ExecDeps, type ExecResult, type LedgerStore } from "./exec/execute.js";
import { RealChainClient } from "./exec/chainViem.js";
import { createKeyring, type Keyring } from "./keyring/keyring.js";
import type { KmsClient, WithRetryOptions } from "./keyring/kms.js";
import { MockKms } from "./keyring/mockKms.js";
import { dayKeyOf, emptyLedger } from "./ledger/ledger.js";
import { EndpointManager } from "./llm/endpoints.js";
import type { LlmClient, X402Transport } from "./llm/types.js";
import { kvGet, kvSet, loadLedger, openMemory, saveLedger, type MemoryDb } from "./memory/db.js";
import { LocalDirSink, restoreLatest, writeSnapshot, type SnapshotSink } from "./memory/snapshot.js";
import { runwayDays } from "./policy/runway.js";
import type { BudgetLedger, Chain, UnixSeconds, WalletBalances, WalletState } from "./policy/types.js";
import { tierOf } from "./pulse/tier.js";
import type { ContextSources } from "./pulse/context.js";
import { memoryCastSink, memoryJournalSink, recordExecResult, runPulse, type PulseResult } from "./pulse/pulse.js";
import { announceTierTransition, budgetPressure, nextPulse, planNext, type TierTransition } from "./pulse/scheduler.js";
import { pulsesEnabled, PULSE_INTERVAL_SEC, type Tier } from "./pulse/tier.js";
import { contentAction } from "./pulse/tools.js";

// ---------------------------------------------------------------------------
// Config file envelope (ADDITIVE, boot-owned; platform/agent schemas untouched)
// ---------------------------------------------------------------------------

const optionalUrl = z.string().url().optional();

export const RuntimeSectionSchema = z
  .object({
    /** M2 MockKms derivation inputs (fixture). Real Nautilus KMS = M3; opts.kms overrides. */
    mockKms: z.object({ imageId: z.string().min(1), agentId: z.string().min(1) }).strict().optional(),
    /** Memory DB path, relative to the config file (DEFAULT "memory.sqlite"); opts.dbPath overrides. */
    dbPath: z.string().min(1).optional(),
    /** Snapshot dir (mock Arweave), relative to the config file (DEFAULT "snapshots"). */
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
  })
  .strict()
  .default({});

export type RuntimeSection = z.infer<typeof RuntimeSectionSchema>;

export const RuntimeConfigFileSchema = z
  .object({
    platform: z.unknown(),
    agent: z.unknown(),
    runtime: RuntimeSectionSchema,
  })
  .strict();

export class ConfigHashMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: Hex,
  ) {
    super(`config hash mismatch: expected ${expected}, file hashes to ${actual} — refusing to boot (03 §10)`);
    this.name = "ConfigHashMismatchError";
  }
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
}

export interface BootOptions {
  configPath: string;
  dbPath?: string;
  snapshotDir?: string;
  /** keccak256 of the canonical config JSON; mismatch ⇒ throw (03 §10). */
  expectedHash?: string;
  kms?: KmsClient;
  clock?: Clock;
  /** withRetry options for boot-time KMS derives. */
  kmsRetry?: WithRetryOptions;
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
  readonly cfg: ResolvedConfig;
  readonly configHash: Hex;
  readonly db: MemoryDb;
  readonly keyring: Keyring;
  readonly endpoints: EndpointManager;
  readonly exec: ExecDeps;
  /** Snapshot id the memory DB was restored from at boot, or null. */
  readonly restoredFrom: string | null;
  /** Chat server (null ⇒ disabled: cfg.chatDomain not set). */
  readonly chat: ChatServer | null;
  /** Bound chat address once start() has listened, else null. */
  chatAddress(): { host: string; port: number } | null;
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
  hash: Hex;
  platform: unknown;
  agent: unknown;
  runtime: RuntimeSection;
}

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
  return { json, hash, platform: file.platform, agent: file.agent, runtime: file.runtime };
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

function hasNativeBalance(c: ChainClient): c is ChainClient & NativeBalanceSource {
  return "getBalance" in c && typeof c.getBalance === "function";
}

const CHAINS: readonly Chain[] = ["rh", "base", "arbitrum", "optimism"];

function asBigint(v: unknown, what: string): bigint {
  if (typeof v !== "bigint") throw new Error(`${what}: expected bigint, got ${typeof v}`);
  return v;
}

/**
 * WalletState from ChainClient reads (M2: mock-backed). Treasury: native + USDC on every
 * chain, USDG + agent token on rh. Action EOA: rh only (native, USDG, agent token).
 * Native balances need a ChainClient implementing NativeBalanceSource; otherwise 0.
 * Hosting (Oyster) comes from the runtime.hosting config stand-in.
 */
export function chainStateReader(chain: ChainClient, cfg: ResolvedConfig, hosting: RuntimeSection["hosting"]): StateReader {
  const native = async (c: Chain, a: Address): Promise<bigint> => (hasNativeBalance(chain) ? chain.getBalance(c, a) : 0n);
  const erc20 = async (c: Chain, token: Address, owner: Address): Promise<bigint> =>
    asBigint(await chain.readContract(c, { address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }), `balanceOf(${token})@${c}`);
  const tokens = async (owner: Address): Promise<Record<Address, bigint> | undefined> => {
    const t = cfg.agentTokenAddress;
    if (t === undefined) return undefined;
    return { [t]: await erc20("rh", t, owner) };
  };
  return async (): Promise<WalletState> => {
    const treasury = {} as WalletBalances;
    for (const c of CHAINS) {
      treasury[c] = { native: await native(c, cfg.treasury), USDC: await erc20(c, cfg.usdc[c], cfg.treasury) };
    }
    treasury.rh.USDG = await erc20("rh", cfg.usdg.rh, cfg.treasury);
    const tt = await tokens(cfg.treasury);
    if (tt !== undefined) treasury.rh.tokens = tt;

    const action: WalletBalances = {
      rh: { native: await native("rh", cfg.action), USDG: await erc20("rh", cfg.usdg.rh, cfg.action) },
      base: { native: 0n },
      arbitrum: { native: 0n },
      optimism: { native: 0n },
    };
    const at = await tokens(cfg.action);
    if (at !== undefined) action.rh.tokens = at;

    return {
      treasury,
      action,
      hostingPaidUntil: hosting?.paidUntil ?? 0n,
      hostingRatePerDay: hosting?.ratePerDay ?? 0n,
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
// boot
// ---------------------------------------------------------------------------

export async function boot(opts: BootOptions): Promise<Runtime> {
  const clock = opts.clock ?? systemClock;
  const ov = opts.overrides ?? {};
  const logger = ov.logger ?? consoleLogger;
  const timers = ov.timers ?? nodeTimers;

  // (1) config
  const loaded = loadConfigFile(opts.configPath, opts.expectedHash);
  const baseDir = dirname(resolve(opts.configPath));
  const rt = loaded.runtime;

  // (2) keyring
  let kms = opts.kms;
  if (kms === undefined) {
    if (rt.mockKms === undefined) throw new Error("boot: no KMS — pass opts.kms or set runtime.mockKms (real Nautilus KMS = M3)");
    kms = new MockKms(rt.mockKms.imageId, rt.mockKms.agentId);
  }
  const keyring = await createKeyring(kms, opts.kmsRetry !== undefined ? { retry: opts.kmsRetry } : undefined);
  const cfg = resolveConfig({ platform: loaded.platform, agent: loaded.agent, ownAddresses: keyring.addresses() });
  keyring.attachConfig(cfg);

  // (3) memory
  const dbPath = opts.dbPath ?? (rt.dbPath === ":memory:" ? ":memory:" : resolve(baseDir, rt.dbPath ?? "memory.sqlite"));
  const snapshotSink = ov.snapshotSink ?? new LocalDirSink(opts.snapshotDir ?? resolve(baseDir, rt.snapshotDir ?? "snapshots"));
  const opened = await openOrRestoreMemory(dbPath, [snapshotSink], keyring.memKeyForMemoryModule(), clock(), logger);
  const db = opened.db;

  // (4) ExecDeps
  const rpcUrls = definedUrls(rt.rpc);
  const chain: ChainClient =
    ov.chain ?? (Object.keys(rpcUrls).length > 0 ? new RealChainClient({ rpcUrls, chainIds: cfg.chainIds }) : new MockChainClient());
  if (ov.chain === undefined && Object.keys(rpcUrls).length === 0) {
    logger.warn("no runtime.rpc configured: using MockChainClient (M2 mock chain — nothing reaches a real network)");
  }
  const getState: StateReader = ov.state ?? chainStateReader(chain, cfg, rt.hosting);

  let ledgerCache: BudgetLedger = loadLedger(db) ?? emptyLedger(clock());
  const ledger: LedgerStore = {
    get: () => ledgerCache,
    set: (l) => {
      ledgerCache = l;
      saveLedger(db, l, clock());
    },
  };

  /** Base deps WITHOUT log: runPulse wraps it with memoryExecDeps (which logs), avoiding double rows. */
  const baseExec: ExecDeps = {
    cfg,
    keyring,
    chain,
    getState,
    ledger,
    clock,
    castSink: memoryCastSink(db, clock),
    journalSink: memoryJournalSink(db, clock),
  };
  /** Logged deps: every ExecResult → actions row. Daemon, announcements, chat. */
  const exec: ExecDeps = { ...baseExec, log: (r) => recordExecResult(db, r, clock()) };

  // (5) components
  const endpoints = new EndpointManager(cfg);
  const llm = ov.llm ?? unconfiguredLlm;
  const x402 = ov.x402 ?? unconfiguredX402;
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
  const daemonDeps: DaemonDeps = { ...exec, chainReader, memory: db, snapshotSink, tierStore: daemonTiers };

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
      endpoints,
      readers,
      tier: async () => sharedTiers.get() ?? tierOf(runwayDays(await getState(), clock(), undefined, cfg.bridgeHaircutBps)),
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
    const c = await announceTierTransition(t, exec);
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

    const result = await runPulse({ exec: baseExec, db, llm, x402, endpoints, tier: tierNow, prevTier: prev, sources: ov.sources });
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

  const runtime: Runtime = {
    cfg,
    configHash: loaded.hash,
    db,
    keyring,
    endpoints,
    exec,
    restoredFrom: opened.restoredFrom,
    chat,
    chatAddress: () => chatAddr,

    async start(): Promise<void> {
      if (closed) throw new Error("runtime stopped");
      if (started) return;
      started = true;
      if (chat !== null) {
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
