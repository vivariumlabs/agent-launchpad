// Test harness for SPEC-M2B §7 daemon tests. Not a test file (no .test.ts).
// Pattern follows test/exec/execute.test.ts: real keyring (MockKms), real engine,
// MockChainClient, in-memory SQLite memory, in-memory snapshot sink.

import type { Address, Hex } from "viem";
import { resolveConfig, type ResolvedConfig } from "../../src/config/schema.js";
import type { ChainReader, DaemonDeps, TierStore } from "../../src/daemon/daemon.js";
import type { Tier } from "../../src/daemon/tier.js";
import { MockChainClient, type MockChainClientOptions } from "../../src/exec/chain.js";
import type { ExecResult } from "../../src/exec/execute.js";
import { createKeyring, type Keyring } from "../../src/keyring/keyring.js";
import { MockKms } from "../../src/keyring/mockKms.js";
import { emptyLedger } from "../../src/ledger/ledger.js";
import { insertAction, kvSet, openMemory, saveLedger, type MemoryDb } from "../../src/memory/db.js";
import type { SnapshotSink } from "../../src/memory/snapshot.js";
import type { BudgetLedger, WalletState } from "../../src/policy/types.js";
import { agentJson, DAY, E18, E6, mkLedger, mkState, NOW, platformJson, TOKEN_X } from "../policy/helpers.js";

export class MemSink implements SnapshotSink {
  readonly files = new Map<string, Uint8Array>();
  async write(data: Uint8Array, now: bigint): Promise<string> {
    const id = `snapshot-${now}.bin`;
    this.files.set(id, data);
    return id;
  }
  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }
  async read(id: string): Promise<Uint8Array> {
    const d = this.files.get(id);
    if (d === undefined) throw new Error(`no ${id}`);
    return d;
  }
}

export class MemTierStore implements TierStore {
  constructor(public tier: Tier | undefined) {}
  sets: Tier[] = [];
  get(): Tier | undefined {
    return this.tier;
  }
  set(t: Tier): void {
    this.tier = t;
    this.sets.push(t);
  }
}

export interface ScriptedReader extends ChainReader {
  accruedCalls: number[];
  quoteCalls: Array<{ token: Address; amount: bigint }>;
}

export function scriptedReader(opts: { accrued?: bigint | Error; quotes?: Record<string, bigint> } = {}): ScriptedReader {
  const r: ScriptedReader = {
    accruedCalls: [],
    quoteCalls: [],
    async accruedFees(agentId: number): Promise<bigint> {
      r.accruedCalls.push(agentId);
      if (opts.accrued instanceof Error) throw opts.accrued;
      return opts.accrued ?? 0n;
    },
    async quoteToUsdg(token: Address, amount: bigint): Promise<bigint> {
      r.quoteCalls.push({ token, amount });
      return opts.quotes?.[token.toLowerCase()] ?? 0n;
    },
  };
  return r;
}

export interface DaemonHarness {
  deps: DaemonDeps;
  cfg: ResolvedConfig;
  kr: Keyring;
  chain: MockChainClient;
  db: MemoryDb;
  sink: MemSink;
  tiers: MemTierStore;
  reader: ScriptedReader;
  logs: ExecResult[];
  ledger(): BudgetLedger;
  journal: Uint8Array[];
  casts: Array<{ bytes: Uint8Array; sig: Hex }>;
}

export interface HarnessOpts {
  state?: WalletState;
  ledger?: BudgetLedger;
  tier?: Tier;
  reader?: { accrued?: bigint | Error; quotes?: Record<string, bigint> };
  chain?: MockChainClientOptions;
  /** Inference totals (USD 6dp) for complete days before NOW: index 0 = yesterday. */
  history?: bigint[];
  /** kv lastSnapshotAt (unset ⇒ snapshot due). */
  lastSnapshotAt?: bigint;
  /** execute() clock; default = NOW. */
  clock?: () => bigint;
  caps?: Record<string, unknown>;
}

/** Writes one budget_ledger row for day `NOW − (i+1)d` with the given inference total. */
export function seedHistory(db: MemoryDb, totals: bigint[]): void {
  totals.forEach((total, i) => {
    const ts = NOW - BigInt(i + 1) * DAY;
    const L = emptyLedger(ts);
    // split across categories to exercise the sum
    const pulse = (total * 2n) / 3n;
    saveLedger(db, { ...L, inferenceSpent: { pulse, chat: total - pulse, social: 0n } }, ts);
  });
}

export async function daemonHarness(opts: HarnessOpts = {}): Promise<DaemonHarness> {
  const kr = await createKeyring(new MockKms("image-a", "agent-daemon"), { retry: { attempts: 3, delayMs: 1 } });
  const cfg = resolveConfig({ platform: platformJson(opts.caps ?? {}), agent: agentJson, ownAddresses: kr.addresses() });
  kr.attachConfig(cfg);
  const chain = new MockChainClient(opts.chain);
  const db = openMemory(":memory:");
  if (opts.history !== undefined) seedHistory(db, opts.history);
  if (opts.lastSnapshotAt !== undefined) kvSet(db, "lastSnapshotAt", opts.lastSnapshotAt.toString(10));
  const sink = new MemSink();
  const tiers = new MemTierStore(opts.tier);
  const reader = scriptedReader(opts.reader);
  let L = opts.ledger ?? mkLedger();
  const state = opts.state ?? mkState();
  const logs: ExecResult[] = [];
  const journal: Uint8Array[] = [];
  const casts: Array<{ bytes: Uint8Array; sig: Hex }> = [];
  const clock = opts.clock ?? (() => NOW);
  const deps: DaemonDeps = {
    cfg,
    keyring: kr,
    chain,
    getState: () => state,
    ledger: { get: () => L, set: (l) => (L = l) },
    clock,
    log: (r) => {
      logs.push(r);
      insertAction(db, {
        ts: clock(),
        kind: r.action.kind,
        json: JSON.stringify(r.action, (_k, v: unknown) => (typeof v === "bigint" ? v.toString(10) : v)),
        verdict: r.verdict.allow ? "allow" : "deny",
        denyCode: r.verdict.allow ? null : r.verdict.code,
        txHash: r.txHash ?? null,
        error: r.error ?? null,
      });
    },
    castSink: { publish: async (_a, bytes, sig) => void casts.push({ bytes, sig }) },
    journalSink: {
      write: async (_a, bytes) => {
        journal.push(bytes);
        return `journal-${journal.length}`;
      },
    },
    chainReader: reader,
    memory: db,
    snapshotSink: sink,
    tierStore: tiers,
  };
  return { deps, cfg, kr, chain, db, sink, tiers, reader, logs, ledger: () => L, journal, casts };
}

/**
 * "Healthy but due" Active state used by the golden test:
 *  - hosting paid 30d ahead at $1.70/d (rental due: 30 × 1.7 = 51 USDC)
 *  - action EOA rh native 0.0005 ETH (< 0.001 floor) ⇒ same-chain gasTopUp 0.0025 ETH
 *  - treasury optimism native 0.001 ETH (< 0.003 floor) ⇒ bridge 0.009 ETH from base
 *  - Base USDC 10 (< max(3×6, 15) = 18) ⇒ refill 10×6 − 10 = 50 USDG
 *  - 1000 TOKEN_X held on rh
 */
export function goldenState(): WalletState {
  const s = mkState();
  s.treasury.base = { native: E18 / 10n, USDC: 10n * E6 };
  s.treasury.optimism = { native: E18 / 1000n };
  s.action.rh = { ...s.action.rh, native: (E18 * 5n) / 10_000n };
  return s;
}

export const GOLDEN_QUOTE = 25n * E6;
export const GOLDEN_QUOTES = { [TOKEN_X.toLowerCase()]: GOLDEN_QUOTE };
