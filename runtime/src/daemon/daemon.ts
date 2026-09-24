// SPEC-M2B §7 — treasury-ops daemon (deterministic survival loop, 03 §8).
//
// tick(deps, now): NO LLM. Pure decision logic + execute() calls, in this order:
//   1 rental  2 gas  3 inferenceRefill  4 distribute  5 convert  6 allowance
//   7 heartbeat  8 snapshot  9 tier recompute (+ transition announcements)
//   10 tlsRenewal (SPEC-M3B §2; ONLY when deps.tlsRenewal is wired, i.e. runtime.tls.enabled):
//      renew the in-enclave ACME cert when < 30 d remain. Not a spend ⇒ no policy action; runs in
//      every tier (the chat ingress outlives treasury tiers).
//   11 allowlistUpdate (SPEC-M3B §4; ONLY when deps.allowlistUpdate is wired, i.e. the agent opted in
//      at genesis AND an update URL + frozen signer exist): once per interval (DEFAULT daily) fetch the
//      platform-signed allowlist and adopt it iff every §4 gate passes (src/llm/allowlistUpdate.ts).
//      Not a spend ⇒ no policy action for the fetch; the adoption journal goes through execute() (J1).
//      Runs in every tier (endpoint churn matters most when the agent needs to wake).
//   12 turboTopUp (SPEC-M3D §2; ONLY when deps.turboTopUp is wired, i.e. runtime.arweave.enabled AND
//      runtime.turboTopUp.enabled): daily, after snapshots — Turbo balance < low watermark ⇒ verify the
//      payment service's base-eth address against the FROZEN arweaveFundingAddress ⇒ arweaveFunding
//      transfer through execute() ⇒ POST {tx_id} (daemon/turboTopUp.ts). Runs in every tier (it keeps
//      snapshot publishing alive; T2/T3 bound the spend).
//   13 fcOnboard (SPEC-M3D §3d; ONLY when deps.fcOnboard is wired, i.e. platform.farcaster AND runtime.tee):
//      FID register → key add → DISPLAY user data (social/fcOnboard.ts), each through execute(). Runs in
//      every tier; every failure = warn + retry next tick.
// Every chain-touching step goes through execute() / treasurySwapExactIn() —
// never the raw ChainClient — so the policy engine re-checks every amount the
// daemon computes. execute() logs every ExecResult (allow AND deny) via
// deps.log. Each step runs inside its own try/catch: a deny, a failed tx or a
// thrown reader never aborts the remaining steps.
//
// Tier gating (01 §6): the tier governing THIS tick is recomputed from the
// state at tick start with the stored tier as hysteresis input. Dormant ⇒
// steps 1,2,4,5,7,8 (refill 3 and allowance 6 skipped; 4+5 = "check for fee
// income", 01 §6). Evicted ⇒ steps 1,2,7,8 only. Step 9 always runs, since it
// is the only way to wake. Allowance (step 6) only when Active.
//
// Clock: the `now` argument drives every daemon decision; execute() evaluates
// under deps.clock() (the same clock in production).

import { keccak256, stringToBytes, type Address } from "viem";
import type { ResolvedConfig } from "../config/schema.js";
import { execute, treasurySwapExactIn, type ExecDeps, type ExecResult } from "../exec/execute.js";
import { dayKeyOf, rollLedger } from "../ledger/ledger.js";
import { deserializeLedger, kvGet, kvSet, type MemoryDb } from "../memory/db.js";
import { writeSnapshot, type SnapshotSink } from "../memory/snapshot.js";
import { allowanceMax } from "../policy/rules/treasury.js";
import { runwayDays } from "../policy/runway.js";
import { buildCastAddData } from "../social/fcMessage.js";
import { readFcFid } from "../social/fcOnboard.js";
import type { BudgetLedger, Chain, ProposedAction, UnixSeconds, WalletState } from "../policy/types.js";
import { applyBps, floorDiv, lower, minBig, SECONDS_PER_DAY, sameAddress } from "../policy/util.js";
import { nextTickAt } from "./scheduler.js";
import { isSurvivalOnly, tierOf, type Tier } from "./tier.js";

// ---------------------------------------------------------------------------
// Deps / report types
// ---------------------------------------------------------------------------

export interface ChainReader {
  /** FeeSplitHook accrued (undistributed) fees for the agent's own pool, USDG(6). */
  accruedFees(agentId: number): Promise<bigint>;
  /** Quoted USDG(6) output for swapping `amount` of `token` into USDG on RH (mock quoter in M2). */
  quoteToUsdg(token: Address, amount: bigint): Promise<bigint>;
}

export interface TierStore {
  get(): Tier | undefined;
  set(tier: Tier): void;
}

export interface DaemonDeps extends ExecDeps {
  chainReader: ChainReader;
  memory: MemoryDb;
  snapshotSink: SnapshotSink;
  tierStore: TierStore;
  /** SPEC-M3B §2 step 10 hook (src/tls/server.ts TlsManager). Absent ⇒ no step 10. */
  tlsRenewal?: TlsRenewalHook;
  /** SPEC-M3B §4 step 11 hook (boot wires it only when the agent opted in). Absent ⇒ no step 11. */
  allowlistUpdate?: AllowlistUpdateHook;
  /** SPEC-M3D §2 step 12 hook (boot wires it only when runtime.arweave + turboTopUp are enabled). Absent ⇒ no step 12. */
  turboTopUp?: DaemonStepHook;
  /** SPEC-M3D §3d step 13 hook (boot wires it only with platform.farcaster AND runtime.tee). Absent ⇒ no step 13. */
  fcOnboard?: DaemonStepHook;
}

/**
 * SPEC-M3D §2/§3d steps 12/13: due check + one run. run() resolves to `skip` (routine: nothing to do) or
 * ran (results = the ExecResults it produced); it THROWS on a failed read (⇒ step error, retried next tick).
 */
export interface DaemonStepHook {
  due(now: UnixSeconds): boolean;
  run(now: UnixSeconds): Promise<{ skip?: string; notes: string[]; results: ExecResult[] }>;
}

/**
 * SPEC-M3B §4 step 11: due check + one check. run() resolves to `skip` (routine: nothing newer) or ran
 * (adopted; results = the adoption journal ExecResult); it THROWS on a rejected/failed update.
 */
export interface AllowlistUpdateHook {
  due(now: UnixSeconds): boolean;
  run(now: UnixSeconds): Promise<{ skip?: string; notes: string[]; results: ExecResult[] }>;
}

/** SPEC-M3B §2: the tlsRenewalDue hook — due check + one renewal (resolves to a note; throws on failure). */
export interface TlsRenewalHook {
  renewalDue(now: UnixSeconds): boolean;
  renew(): Promise<string>;
}

export type StepName =
  | "rental"
  | "gas"
  | "inferenceRefill"
  | "distribute"
  | "convert"
  | "allowance"
  | "heartbeat"
  | "snapshot"
  | "tier"
  | "tlsRenewal"
  | "allowlistUpdate"
  | "turboTopUp"
  | "fcOnboard";

export type StepReport =
  | { step: StepName; status: "skipped"; reason: string }
  | { step: StepName; status: "ran"; results: ExecResult[]; notes: string[] }
  /** A step threw (reader failure, executor throw). Partial results are kept. Later steps still run. */
  | { step: StepName; status: "error"; error: string; results: ExecResult[]; notes: string[] };

export interface TickReport {
  now: UnixSeconds;
  runwayDaysAtStart: bigint;
  /** Tier governing this tick (recomputed at start, stored tier as hysteresis). */
  tier: Tier;
  /** Tier after step 9 (persisted to tierStore). */
  tierAfter: Tier;
  steps: StepReport[];
  /** Every ExecResult of the tick, in execution order. */
  actions: ExecResult[];
  snapshotId?: string;
  nextTickAt: UnixSeconds;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE_USDG = 1_000_000n;
/** §7 step 5: convert only tokens quoted at ≥ 1 USDG. */
export const CONVERT_MIN_QUOTE_USDG = ONE_USDG;
/** §7 step 3: trailing window (days with ledger history rows). */
export const BURN_WINDOW_DAYS = 3;
/** §7 step 3 (orchestrator note): with < BURN_WINDOW_DAYS days of history, burn = max(observed avg, 1 USDG). */
export const BURN_FLOOR_USDG = ONE_USDG;
/** kv key: last snapshot time (decimal unix seconds). */
export const KV_LAST_SNAPSHOT_AT = "lastSnapshotAt";
/** kv key used by kvTierStore. */
export const KV_DAEMON_TIER = "daemonTier";

const GAS_CHAINS: readonly Chain[] = ["rh", "base", "arbitrum", "optimism"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function positive(x: bigint): bigint {
  return x > 0n ? x : 0n;
}

function hostingLapsed(s: WalletState, now: UnixSeconds): boolean {
  return s.hostingRatePerDay > 0n && s.hostingPaidUntil <= now;
}

function runwayNow(s: WalletState, now: UnixSeconds, cfg: ResolvedConfig): bigint {
  return runwayDays(s, now, undefined, cfg.bridgeHaircutBps);
}

/** Ledger view as the engine will see it on `now`'s UTC day (G4 forward-only roll). */
function ledgerView(deps: DaemonDeps, now: UnixSeconds): BudgetLedger {
  return rollLedger(deps.ledger.get(), now);
}

interface StepCtx {
  results: ExecResult[];
  notes: string[];
}

/** A step body returns a skip reason (nothing to do / gated) or undefined (ran). */
type StepBody = (ctx: StepCtx) => Promise<string | undefined>;

async function runStep(step: StepName, body: StepBody): Promise<StepReport> {
  const ctx: StepCtx = { results: [], notes: [] };
  try {
    const skip = await body(ctx);
    if (skip !== undefined && ctx.results.length === 0) return { step, status: "skipped", reason: skip };
    if (skip !== undefined) ctx.notes.push(skip);
    return { step, status: "ran", results: ctx.results, notes: ctx.notes };
  } catch (e) {
    return { step, status: "error", error: errMsg(e), results: ctx.results, notes: ctx.notes };
  }
}

// ---------------------------------------------------------------------------
// Step 1 — Oyster rental
// ---------------------------------------------------------------------------

/**
 * paidDays = floor((hostingPaidUntil − now) / 1d). If paidDays < cfg.minRunwayDays (45)
 * ⇒ rent min((rentalTargetDays − paidDays) × rate, T3 oysterRental headroom, arb USDC).
 * The 45-day trigger reuses cfg.minRunwayDays (no separate §9 field exists).
 */
export function rentalAmount(s: WalletState, L: BudgetLedger, cfg: ResolvedConfig, now: UnixSeconds): { amount: bigint; reason?: string } {
  if (s.hostingRatePerDay <= 0n) return { amount: 0n, reason: "hosting rate is 0 (infinite runway)" };
  const paidDays = floorDiv(s.hostingPaidUntil - now, SECONDS_PER_DAY);
  if (paidDays >= BigInt(cfg.minRunwayDays)) {
    return { amount: 0n, reason: `paid ahead ${paidDays}d >= ${cfg.minRunwayDays}d` };
  }
  const cost = positive(BigInt(cfg.rentalTargetDays) - paidDays) * s.hostingRatePerDay;
  const headroom = positive(cfg.oysterRentalDailyCapUsdc - (L.treasurySpent.oysterRental ?? 0n));
  const bal = s.treasury.arbitrum?.USDC ?? 0n;
  const amount = minBig(minBig(cost, headroom), bal);
  if (amount <= 0n) return { amount: 0n, reason: `rental due (paid ${paidDays}d) but amount 0: cost ${cost}, cap headroom ${headroom}, arb USDC ${bal}` };
  return { amount };
}

async function stepRental(deps: DaemonDeps, now: UnixSeconds, ctx: StepCtx): Promise<string | undefined> {
  const s = await deps.getState();
  const { amount, reason } = rentalAmount(s, ledgerView(deps, now), deps.cfg, now);
  if (amount === 0n) return reason;
  const to = deps.cfg.marlin.paymentAddresses[0];
  if (to === undefined) return "no Marlin payment address configured";
  // Oyster job id binding is not part of the action shape in M2 (flagged).
  ctx.results.push(
    await execute({ kind: "treasuryTransfer", purpose: "oysterRental", chain: "arbitrum", asset: "USDC", to, amount }, deps),
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// Step 2 — gas floors
// ---------------------------------------------------------------------------

/**
 * Per chain (rh, base, arbitrum, optimism):
 *  (a) treasury native < gasFloorWei[c] ⇒ need = gasTargetWei[c] − native. The treasury
 *      itself is the one short on c, so the ETH must come from another chain: source =
 *      the richest OTHER chain whose treasury native is above its own target (ties ⇒
 *      chain order), amount = min(need, source native − source target) so the source
 *      never drops below its target. acrossBridge(ETH, chain=source, destChain=c,
 *      recipient = own treasury).
 *      CAVEAT (flagged): Across ETH bridges arrive as WETH on the destination, not native
 *      gas — a WETH→ETH unwrap step is missing in M2. Same-chain top-ups are therefore
 *      preferred wherever source == dest (case b).
 *  (b) rh only (the action EOA lives on RH): action native < gasFloorWei.rh ⇒ same-chain
 *      gasTopUp treasury(rh) → action EOA for min(need, treasury rh native − target.rh).
 * In-tick source debits are tracked locally so two top-ups never double-spend a surplus.
 */
async function stepGas(deps: DaemonDeps, ctx: StepCtx): Promise<string | undefined> {
  const s = await deps.getState();
  const cfg = deps.cfg;
  const native: Record<Chain, bigint> = {
    rh: s.treasury.rh?.native ?? 0n,
    base: s.treasury.base?.native ?? 0n,
    arbitrum: s.treasury.arbitrum?.native ?? 0n,
    optimism: s.treasury.optimism?.native ?? 0n,
  };
  const surplus = (c: Chain): bigint => native[c] - cfg.gasTargetWei[c];

  for (const c of GAS_CHAINS) {
    // (a) treasury short on c ⇒ bridge from the richest other chain above target.
    if (native[c] < cfg.gasFloorWei[c]) {
      const need = cfg.gasTargetWei[c] - native[c];
      let src: Chain | undefined;
      for (const o of GAS_CHAINS) {
        if (o === c || surplus(o) <= 0n) continue;
        if (src === undefined || native[o] > native[src]) src = o;
      }
      if (src === undefined) {
        ctx.notes.push(`treasury ${c} native ${native[c]} < floor; no chain above target to source from`);
      } else {
        const amount = minBig(need, surplus(src));
        const a: ProposedAction = {
          kind: "treasuryTransfer",
          purpose: "acrossBridge",
          chain: src,
          asset: "ETH",
          to: cfg.across.spokePool[src],
          amount,
          recipient: cfg.treasury,
          destChain: c,
        };
        const r = await execute(a, deps);
        ctx.results.push(r);
        if (r.verdict.allow) native[src] -= amount;
      }
    }
    // (b) action EOA (RH only) ⇒ same-chain treasury → action gasTopUp.
    if (c === "rh") {
      const act = s.action.rh?.native ?? 0n;
      if (act < cfg.gasFloorWei.rh) {
        const need = cfg.gasTargetWei.rh - act;
        const avail = surplus("rh");
        if (avail <= 0n) {
          ctx.notes.push(`action rh native ${act} < floor; treasury rh has no surplus above target`);
        } else {
          const amount = minBig(need, avail);
          const r = await execute(
            { kind: "treasuryTransfer", purpose: "gasTopUp", chain: "rh", asset: "ETH", to: cfg.action, amount },
            deps,
          );
          ctx.results.push(r);
          if (r.verdict.allow) native.rh -= amount;
        }
      }
    }
  }
  if (ctx.results.length === 0 && ctx.notes.length === 0) return "all gas balances at or above floor";
  if (ctx.results.length === 0) return ctx.notes.join("; ");
  return undefined;
}

// ---------------------------------------------------------------------------
// Step 3 — inference refill
// ---------------------------------------------------------------------------

export interface BurnEstimate {
  burn: bigint;
  /** Complete UTC days observed (≤ BURN_WINDOW_DAYS). */
  days: number;
  /** Per-day totals used, newest first. */
  dayTotals: Array<{ dayKey: string; total: bigint }>;
}

/**
 * Trailing inference burn from `budget_ledger` history rows. inferenceSpent resets at
 * UTC rollover, so a day's total = the (max) pulse+chat+social of that day's rows.
 * Uses the most recent BURN_WINDOW_DAYS complete days (dayKey < today) that have rows.
 * burn = floor(sum / days); with fewer than BURN_WINDOW_DAYS days, burn = max(avg, 1 USDG)
 * (0 days ⇒ 1 USDG).
 */
export function trailingBurn(db: MemoryDb, now: UnixSeconds): BurnEstimate {
  const today = dayKeyOf(now);
  const totals = new Map<string, bigint>();
  const order: string[] = [];
  const stmt = db.prepare("SELECT json FROM budget_ledger ORDER BY id DESC");
  for (const row of stmt.iterate() as Iterable<{ json: string }>) {
    const L = deserializeLedger(row.json);
    if (L.dayKey >= today) continue;
    const total = L.inferenceSpent.pulse + L.inferenceSpent.chat + L.inferenceSpent.social;
    const prev = totals.get(L.dayKey);
    if (prev === undefined) {
      if (order.length >= BURN_WINDOW_DAYS) break;
      order.push(L.dayKey);
      totals.set(L.dayKey, total);
    } else if (total > prev) {
      totals.set(L.dayKey, total);
    }
  }
  const dayTotals = order.map((dayKey) => ({ dayKey, total: totals.get(dayKey) ?? 0n }));
  const days = dayTotals.length;
  const sum = dayTotals.reduce((acc, d) => acc + d.total, 0n);
  const avg = days === 0 ? 0n : sum / BigInt(days);
  const burn = days < BURN_WINDOW_DAYS ? (avg > BURN_FLOOR_USDG ? avg : BURN_FLOOR_USDG) : avg;
  return { burn, days, dayTotals };
}

/**
 * Base USDC < max(inferenceRefillDaysMin × burn, inferenceMinRefillUsd) ⇒ bridge USDG rh→base
 * for min(target − balance, acrossBridge T3 headroom), target = max(inferenceRefillDaysTarget ×
 * burn, inferenceMinRefillUsd) — so a triggered refill is never zero (target ≥ threshold > balance).
 */
export function refillAmount(balance: bigint, burn: bigint, L: BudgetLedger, cfg: ResolvedConfig): { amount: bigint; reason?: string } {
  const minDays = BigInt(cfg.inferenceRefillDaysMin);
  const threshold = burn * minDays > cfg.inferenceMinRefillUsd ? burn * minDays : cfg.inferenceMinRefillUsd;
  if (balance >= threshold) return { amount: 0n, reason: `base USDC ${balance} >= threshold ${threshold} (burn ${burn}/d)` };
  const byBurn = burn * BigInt(cfg.inferenceRefillDaysTarget);
  const target = byBurn > cfg.inferenceMinRefillUsd ? byBurn : cfg.inferenceMinRefillUsd;
  const want = target - balance;
  if (want <= 0n) {
    return { amount: 0n, reason: `base USDC ${balance} < threshold ${threshold} but refill target ${target} <= balance` };
  }
  const headroom = positive(cfg.acrossBridgeDailyCapUsd - (L.treasurySpent.acrossBridge ?? 0n));
  const amount = minBig(want, headroom);
  if (amount <= 0n) return { amount: 0n, reason: `refill ${want} wanted but acrossBridge cap headroom is 0` };
  return { amount };
}

async function stepRefill(deps: DaemonDeps, now: UnixSeconds, ctx: StepCtx): Promise<string | undefined> {
  const s = await deps.getState();
  const est = trailingBurn(deps.memory, now);
  ctx.notes.push(`burn ${est.burn}/d over ${est.days}d`);
  const bal = s.treasury.base?.USDC ?? 0n;
  const { amount, reason } = refillAmount(bal, est.burn, ledgerView(deps, now), deps.cfg);
  if (amount === 0n) return reason;
  // USDG(rh) bridges arrive as Base USDC (intended).
  ctx.results.push(
    await execute(
      {
        kind: "treasuryTransfer",
        purpose: "acrossBridge",
        chain: "rh",
        asset: "USDG",
        to: deps.cfg.across.spokePool.rh,
        amount,
        recipient: deps.cfg.treasury,
        destChain: "base",
      },
      deps,
    ),
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// Step 4 — distribute
// ---------------------------------------------------------------------------

async function stepDistribute(deps: DaemonDeps, ctx: StepCtx): Promise<string | undefined> {
  const fees = await deps.chainReader.accruedFees(deps.cfg.agent.agentId);
  if (fees <= deps.cfg.distributeThresholdUsdg) {
    return `accrued fees ${fees} <= threshold ${deps.cfg.distributeThresholdUsdg}`;
  }
  ctx.results.push(await execute({ kind: "distribute" }, deps));
  return undefined;
}

// ---------------------------------------------------------------------------
// Step 5 — convert non-USDG income
// ---------------------------------------------------------------------------

/**
 * For each non-USDG rh token held by the treasury (sorted by lowercase address; case
 * variants deduped, smallest balance wins): quote the FULL balance; quote ≥ 1 USDG ⇒
 * treasurySwapExactIn(amountIn = balance, minOut = quote × (10000 − swapSlippageBps) / 10000).
 * Slippage is advisory in M2 (router limitation, known debt).
 */
async function stepConvert(deps: DaemonDeps, ctx: StepCtx): Promise<string | undefined> {
  const s = await deps.getState();
  const tokens = s.treasury.rh?.tokens ?? {};
  const byLower = new Map<string, { token: Address; bal: bigint }>();
  for (const [k, v] of Object.entries(tokens)) {
    const token = k as Address;
    if (sameAddress(token, deps.cfg.usdg.rh)) continue;
    const key = lower(token);
    const prev = byLower.get(key);
    if (prev === undefined || v < prev.bal) byLower.set(key, { token, bal: v });
  }
  const keys = [...byLower.keys()].sort();
  for (const key of keys) {
    const { token, bal } = byLower.get(key)!;
    if (bal <= 0n) continue;
    const quote = await deps.chainReader.quoteToUsdg(token, bal);
    if (quote < CONVERT_MIN_QUOTE_USDG) {
      ctx.notes.push(`${token}: quote ${quote} < 1 USDG`);
      continue;
    }
    const minOut = applyBps(quote, 10_000 - deps.cfg.swapSlippageBps);
    ctx.results.push(...(await treasurySwapExactIn({ tokenIn: token, amountIn: bal, minOut }, deps)));
  }
  if (ctx.results.length === 0) return ctx.notes.length > 0 ? ctx.notes.join("; ") : "no non-USDG rh tokens";
  return undefined;
}

// ---------------------------------------------------------------------------
// Step 6 — allowance
// ---------------------------------------------------------------------------

async function stepAllowance(deps: DaemonDeps, now: UnixSeconds, tier: Tier, ctx: StepCtx): Promise<string | undefined> {
  if (tier !== "Active") return `tier ${tier}: allowance only in Active (01 §6)`;
  // Mirrors T4's ALLOWANCE_EARLY precondition (0n = never) so the daemon never
  // proposes an allowance the engine would deny as early.
  const L = deps.ledger.get();
  if (L.lastAllowanceAt !== 0n && now - L.lastAllowanceAt < SECONDS_PER_DAY) {
    return `allowance pulled ${now - L.lastAllowanceAt}s ago (< ${SECONDS_PER_DAY}s)`;
  }
  const s = await deps.getState();
  const amount = allowanceMax(s, deps.cfg);
  if (amount <= 0n) return "allowance entitlement is 0";
  ctx.results.push(await execute({ kind: "allowance", amount }, deps));
  return undefined;
}

// ---------------------------------------------------------------------------
// Step 8 — snapshot
// ---------------------------------------------------------------------------

/** Due iff no (parseable) lastSnapshotAt, or now − lastSnapshotAt ≥ 24h (so 6h ticks land on exactly 24h). */
export function snapshotDue(db: MemoryDb, now: UnixSeconds): boolean {
  const raw = kvGet(db, KV_LAST_SNAPSHOT_AT);
  if (raw === undefined || !/^\d+$/.test(raw)) return true;
  return now - BigInt(raw) >= SECONDS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Step 9 — tier recompute + announcements
// ---------------------------------------------------------------------------

function announcementTexts(prev: Tier, next: Tier, days: bigint, now: UnixSeconds): { journal: string; post: string } {
  return {
    journal: `[daemon] tier transition ${prev} -> ${next} at ${now} (runway ${days}d).`,
    post: `Runway update: moving from ${prev} to ${next} (runway ${days} days).`,
  };
}

async function stepTier(deps: DaemonDeps, now: UnixSeconds, ctx: StepCtx): Promise<{ skip: string | undefined; tier: Tier }> {
  const s = await deps.getState();
  const days = runwayNow(s, now, deps.cfg);
  const prev = deps.tierStore.get();
  const next = tierOf(days, prev, hostingLapsed(s, now));
  if (prev === next) return { skip: `tier unchanged: ${next} (runway ${days}d)`, tier: next };
  deps.tierStore.set(next);
  if (prev === undefined) return { skip: `tier initialized: ${next} (runway ${days}d)`, tier: next };
  ctx.notes.push(`tier ${prev} -> ${next} (runway ${days}d)`);
  const t = announcementTexts(prev, next, days, now);
  const jb = stringToBytes(t.journal);
  ctx.results.push(
    await execute({ kind: "journalWrite", contentHash: keccak256(jb), sizeBytes: BigInt(jb.length) }, deps, { journalBytes: jb }),
  );
  // SPEC-M3D §3e ruling: kv fc.fid present ⇒ serialized CastAdd MessageData (hub-publishable); else today's bytes.
  const fid = readFcFid(deps.memory);
  let pb: Uint8Array;
  try {
    pb = fid !== undefined ? buildCastAddData(t.post, fid, now) : stringToBytes(t.post);
  } catch (e) {
    ctx.notes.push(`tier announcement cast skipped: ${e instanceof Error ? e.message : String(e)}`);
    return { skip: undefined, tier: next };
  }
  ctx.results.push(await execute({ kind: "castPost", contentHash: keccak256(pb) }, deps, { messageBytes: pb }));
  return { skip: undefined, tier: next };
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

export async function tick(deps: DaemonDeps, now: UnixSeconds): Promise<TickReport> {
  const startState = await deps.getState();
  const runwayDaysAtStart = runwayNow(startState, now, deps.cfg);
  const tier = tierOf(runwayDaysAtStart, deps.tierStore.get(), hostingLapsed(startState, now));
  const survival = isSurvivalOnly(tier);
  // Dormant still checks for fee income (01 §6): steps 4+5 run; Evicted does not.
  const incomeGated = tier === "Evicted";
  const gated =
    tier === "Dormant"
      ? `tier Dormant: daemon runs steps 1,2,4,5,7,8 only (01 §6)`
      : `tier ${tier}: daemon runs steps 1,2,7,8 only (SPEC-M2B §7)`;

  const steps: StepReport[] = [];
  steps.push(await runStep("rental", (ctx) => stepRental(deps, now, ctx)));
  steps.push(await runStep("gas", (ctx) => stepGas(deps, ctx)));
  steps.push(await runStep("inferenceRefill", async (ctx) => (survival ? gated : stepRefill(deps, now, ctx))));
  steps.push(await runStep("distribute", async (ctx) => (incomeGated ? gated : stepDistribute(deps, ctx))));
  steps.push(await runStep("convert", async (ctx) => (incomeGated ? gated : stepConvert(deps, ctx))));
  steps.push(await runStep("allowance", async (ctx) => (survival ? gated : stepAllowance(deps, now, tier, ctx))));
  steps.push(
    await runStep("heartbeat", async (ctx) => {
      ctx.results.push(await execute({ kind: "heartbeat" }, deps));
      return undefined;
    }),
  );

  let snapshotId: string | undefined;
  steps.push(
    await runStep("snapshot", async (ctx) => {
      if (!snapshotDue(deps.memory, now)) return "last snapshot within 24h";
      const res = await writeSnapshot(deps.memory, deps.keyring.memKeyForMemoryModule(), deps.snapshotSink, now, deps.cfg.agent.agentId);
      kvSet(deps.memory, KV_LAST_SNAPSHOT_AT, now.toString(10));
      snapshotId = res.id;
      ctx.notes.push(`snapshot ${res.id}`);
      return undefined;
    }),
  );

  let tierAfter: Tier = deps.tierStore.get() ?? tier;
  steps.push(
    await runStep("tier", async (ctx) => {
      const r = await stepTier(deps, now, ctx);
      tierAfter = r.tier;
      return r.skip;
    }),
  );

  const tlsHook = deps.tlsRenewal;
  if (tlsHook !== undefined) {
    steps.push(
      await runStep("tlsRenewal", async (ctx) => {
        if (!tlsHook.renewalDue(now)) return "certificate valid for ≥ 30 days";
        ctx.notes.push(await tlsHook.renew());
        return undefined;
      }),
    );
  }

  const alHook = deps.allowlistUpdate;
  if (alHook !== undefined) {
    steps.push(
      await runStep("allowlistUpdate", async (ctx) => {
        if (!alHook.due(now)) return "allowlist update checked within the interval";
        const out = await alHook.run(now);
        ctx.results.push(...out.results);
        ctx.notes.push(...out.notes);
        return out.skip;
      }),
    );
  }

  // SPEC-M3D §2 step 12 / §3d step 13 (hook-wired; same due/run shape as step 11).
  const hooks: Array<[StepName, DaemonStepHook | undefined, string]> = [
    ["turboTopUp", deps.turboTopUp, "turbo top-up checked within the interval"],
    ["fcOnboard", deps.fcOnboard, "farcaster onboarding not due"],
  ];
  for (const [name, hook, notDue] of hooks) {
    if (hook === undefined) continue;
    steps.push(
      await runStep(name, async (ctx) => {
        if (!hook.due(now)) return notDue;
        const out = await hook.run(now);
        ctx.results.push(...out.results);
        ctx.notes.push(...out.notes);
        return out.skip;
      }),
    );
  }

  const report: TickReport = {
    now,
    runwayDaysAtStart,
    tier,
    tierAfter,
    steps,
    actions: steps.flatMap((s) => (s.status === "skipped" ? [] : s.results)),
    nextTickAt: nextTickAt(now, deps.cfg),
  };
  if (snapshotId !== undefined) report.snapshotId = snapshotId;
  return report;
}

// ---------------------------------------------------------------------------
// kv-backed TierStore (composition-root convenience)
// ---------------------------------------------------------------------------

const TIERS: readonly Tier[] = ["Active", "Conserving", "Dormant", "Evicted"];

export function kvTierStore(db: MemoryDb): TierStore {
  return {
    get(): Tier | undefined {
      const v = kvGet(db, KV_DAEMON_TIER);
      return TIERS.find((t) => t === v);
    },
    set(tier: Tier): void {
      kvSet(db, KV_DAEMON_TIER, tier);
    },
  };
}
