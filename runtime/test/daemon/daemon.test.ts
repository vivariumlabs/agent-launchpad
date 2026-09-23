// SPEC-M2B §7 treasury daemon: per-branch scripted states, golden tick, tier gating,
// deny-never-aborts, rental / refill math, snapshot cadence, tier announcements.

import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import {
  KV_LAST_SNAPSHOT_AT,
  kvTierStore,
  refillAmount,
  rentalAmount,
  snapshotDue,
  tick,
  trailingBurn,
  type StepName,
  type StepReport,
  type TickReport,
} from "../../src/daemon/daemon.js";
import type { ExecResult } from "../../src/exec/execute.js";
import { emptyLedger } from "../../src/ledger/ledger.js";
import { kvGet, kvSet, listActions, openMemory, saveLedger } from "../../src/memory/db.js";
import { restoreLatest } from "../../src/memory/snapshot.js";
import type { ProposedAction } from "../../src/policy/types.js";
import { DAY, E18, E6, MARLIN_PAY, mkCfg, mkLedger, mkState, NOW, SPOKE, SWAP_ROUTER, TOKEN_X } from "../policy/helpers.js";
import { daemonHarness, GOLDEN_QUOTES, goldenState, type DaemonHarness } from "./harness.js";

const STEP_ORDER: StepName[] = ["rental", "gas", "inferenceRefill", "distribute", "convert", "allowance", "heartbeat", "snapshot", "tier"];

function step(r: TickReport, name: StepName): StepReport {
  const s = r.steps.find((x) => x.step === name);
  if (s === undefined) throw new Error(`no step ${name}`);
  return s;
}

function kinds(rs: ExecResult[]): string[] {
  return rs.map((r) => r.action.kind);
}

/** Every ExecResult of the tick was passed to deps.log AND landed in the memory actions table. */
function expectAllLogged(h: DaemonHarness, r: TickReport): void {
  expect(h.logs).toEqual(r.actions);
  const rows = listActions(h.db);
  expect(rows.map((x) => x.kind)).toEqual(kinds(r.actions));
  expect(rows.map((x) => x.denyCode)).toEqual(r.actions.map((a) => (a.verdict.allow ? null : a.verdict.code)));
}

function allOk(rs: ExecResult[]): void {
  for (const r of rs) {
    if (!r.verdict.allow) throw new Error(`${r.action.kind} denied ${r.verdict.code}: ${r.verdict.detail}`);
    expect(r.error, r.action.kind).toBeUndefined();
  }
}

// ---------------------------------------------------------------------------
// Golden
// ---------------------------------------------------------------------------

describe("golden tick (healthy Active state)", () => {
  it("due-everything Active state ⇒ exact ordered action list, all allowed and sent from the treasury", async () => {
    const h = await daemonHarness({
      state: goldenState(),
      tier: "Active",
      history: [6n * E6, 6n * E6, 6n * E6],
      reader: { accrued: 75n * E6, quotes: GOLDEN_QUOTES },
    });
    const treasury = h.cfg.treasury;
    const r = await tick(h.deps, NOW);

    const expected: ProposedAction[] = [
      { kind: "treasuryTransfer", purpose: "oysterRental", chain: "arbitrum", asset: "USDC", to: MARLIN_PAY, amount: 51n * E6 },
      { kind: "treasuryTransfer", purpose: "gasTopUp", chain: "rh", asset: "ETH", to: h.cfg.action, amount: 2_500_000_000_000_000n },
      {
        kind: "treasuryTransfer", purpose: "acrossBridge", chain: "base", asset: "ETH", to: SPOKE.base,
        amount: 9_000_000_000_000_000n, recipient: treasury, destChain: "optimism",
      },
      {
        kind: "treasuryTransfer", purpose: "acrossBridge", chain: "rh", asset: "USDG", to: SPOKE.rh,
        amount: 50n * E6, recipient: treasury, destChain: "base",
      },
      { kind: "distribute" },
      { kind: "treasuryApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: 1000n * E18 },
      { kind: "treasurySwap", tokenIn: TOKEN_X, amountIn: 1000n * E18, minOut: 24_500_000n },
      { kind: "allowance", amount: 500n * E6 },
      { kind: "heartbeat" },
    ];
    expect(r.actions.map((a) => a.action)).toEqual(expected);
    allOk(r.actions);
    expect(r.steps.map((s) => s.step)).toEqual(STEP_ORDER);
    expect(r.tier).toBe("Active");
    expect(r.tierAfter).toBe("Active");
    expect(step(r, "tier").status).toBe("skipped");
    expect(step(r, "snapshot").status).toBe("ran");
    expect(r.snapshotId).toBe(`snapshot-${NOW}.bin`);
    expect(r.nextTickAt).toBe(NOW + 21_600n);

    // chain: 9 txs, every one from the treasury EOA, on the expected chains
    expect(h.chain.sent.map((s) => s.chain)).toEqual(["arbitrum", "rh", "base", "rh", "rh", "rh", "rh", "rh", "rh"]);
    expect(h.chain.sentFrom(treasury)).toHaveLength(9);
    expect(r.actions.map((a) => a.txHash)).toEqual(h.chain.sent.map((s) => s.hash));

    // ledger consumed per T3/T4
    const L = h.ledger();
    expect(L.treasurySpent).toEqual({
      oysterRental: 51n * E6,
      "gasTopUp:rh": 2_500_000_000_000_000n,
      "gasTopUp:base": 9_000_000_000_000_000n,
      acrossBridge: 50n * E6,
    });
    expect(L.lastAllowanceAt).toBe(NOW);
    expect(h.reader.accruedCalls).toEqual([1]);
    expect(h.reader.quoteCalls).toEqual([{ token: TOKEN_X, amount: 1000n * E18 }]);
    expectAllLogged(h, r);
  });

  it("fully healthy, nothing due ⇒ heartbeat only; every other step skipped with a reason", async () => {
    const s = mkState({ hostingPaidUntil: NOW + 50n * DAY });
    s.treasury.rh = { ...s.treasury.rh, tokens: {} };
    const h = await daemonHarness({
      state: s,
      tier: "Active",
      history: [6n * E6, 6n * E6, 6n * E6],
      reader: { accrued: 50n * E6 }, // == threshold ⇒ not >
      ledger: mkLedger({ lastAllowanceAt: NOW - 3_600n }),
      lastSnapshotAt: NOW - 3_600n,
    });
    const r = await tick(h.deps, NOW);
    expect(kinds(r.actions)).toEqual(["heartbeat"]);
    allOk(r.actions);
    for (const name of STEP_ORDER.filter((n) => n !== "heartbeat")) {
      const st = step(r, name);
      expect(st.status, name).toBe("skipped");
      if (st.status === "skipped") expect(st.reason.length, name).toBeGreaterThan(0);
    }
    expect(h.chain.sent).toHaveLength(1);
    expectAllLogged(h, r);
  });
});

// ---------------------------------------------------------------------------
// Tier gating
// ---------------------------------------------------------------------------

describe("tier gating", () => {
  it("Conserving tick ⇒ NO allowance (entitlement > 0, none pulled today); other steps still run", async () => {
    // rate 100/d, paid 5d, rh USDG 1000 ⇒ runway 5 + floor(995/100) = 14 ⇒ Conserving
    const s = mkState({ hostingPaidUntil: NOW + 5n * DAY, hostingRatePerDay: 100n * E6 });
    s.treasury.arbitrum = { native: E18 / 10n, USDC: 0n };
    s.treasury.rh = { ...s.treasury.rh, USDG: 1000n * E6 };
    const h = await daemonHarness({ state: s, tier: "Conserving", reader: { accrued: 75n * E6, quotes: GOLDEN_QUOTES } });
    const r = await tick(h.deps, NOW);
    expect(r.runwayDaysAtStart).toBe(14n);
    expect(r.tier).toBe("Conserving");
    expect(kinds(r.actions)).not.toContain("allowance");
    const al = step(r, "allowance");
    expect(al.status).toBe("skipped");
    if (al.status === "skipped") expect(al.reason).toMatch(/Conserving/);
    // distribute + convert still run in Conserving
    expect(kinds(r.actions)).toEqual(["distribute", "treasuryApprove", "treasurySwap", "heartbeat"]);
    expect(h.ledger().lastAllowanceAt).toBe(0n);
    expectAllLogged(h, r);
  });

  it("Dormant tick ⇒ steps 1,2,4,5,7,8 act (refill 3 + allowance 6 skipped; fee-income check runs, 01 §6)", async () => {
    // paid 1d, arb USDC 1, rh USDG 0 ⇒ runway 1 ⇒ Dormant
    const s = mkState({ hostingPaidUntil: NOW + DAY });
    s.treasury.arbitrum = { native: E18 / 10n, USDC: 1n * E6 };
    s.treasury.rh = { ...s.treasury.rh, USDG: 0n };
    s.treasury.optimism = { native: E18 / 1000n }; // below floor ⇒ step 2 acts
    s.treasury.base = { native: E18 / 10n, USDC: 0n }; // would trigger refill if not gated
    const h = await daemonHarness({ state: s, tier: "Dormant", reader: { accrued: 500n * E6, quotes: GOLDEN_QUOTES } });
    const r = await tick(h.deps, NOW);
    expect(r.tier).toBe("Dormant");
    expect(kinds(r.actions)).toEqual(["treasuryTransfer", "treasuryTransfer", "distribute", "treasuryApprove", "treasurySwap", "heartbeat"]);
    expect(step(r, "rental").status).toBe("ran");
    expect(step(r, "gas").status).toBe("ran");
    expect(step(r, "distribute").status).toBe("ran");
    expect(step(r, "convert").status).toBe("ran");
    for (const n of ["inferenceRefill", "allowance"] as const) {
      const st = step(r, n);
      expect(st.status, n).toBe("skipped");
      if (st.status === "skipped") expect(st.reason).toMatch(/Dormant: daemon runs steps 1,2,4,5,7,8 only/);
    }
    expect(step(r, "heartbeat").status).toBe("ran");
    expect(step(r, "snapshot").status).toBe("ran");
    expect(step(r, "tier").status).toBe("skipped"); // Dormant → Dormant
    expect(h.reader.accruedCalls).toEqual([1]);
    expect(h.reader.quoteCalls.length).toBeGreaterThan(0);
    // rental: min(59 × 1.7, cap 100, arb 1) = 1 USDC (T0-exempt ⇒ allowed)
    expect(r.actions[0]!.action).toMatchObject({ purpose: "oysterRental", amount: 1n * E6 });
    // gas ETH bridge is T0-exempt (rev 2): allowed at 1d runway
    const gas = r.actions[1]!;
    expect(gas.action).toMatchObject({ purpose: "acrossBridge", asset: "ETH", destChain: "optimism" });
    allOk(r.actions);
    expectAllLogged(h, r);
  });

  it("Dormant with runway 5d stays Dormant (hysteresis); 6d wakes to Conserving with announcement", async () => {
    const mk = (days: bigint) => {
      const s = mkState({ hostingPaidUntil: NOW + days * DAY });
      s.treasury.arbitrum = { native: E18 / 10n, USDC: 0n };
      s.treasury.rh = { native: E18 / 10n, USDG: 0n, tokens: {} };
      return s;
    };
    const h5 = await daemonHarness({ state: mk(5n), tier: "Dormant" });
    const r5 = await tick(h5.deps, NOW);
    expect(r5.tier).toBe("Dormant");
    expect(r5.tierAfter).toBe("Dormant");
    expect(h5.tiers.sets).toEqual([]);
    expect(kinds(r5.actions)).toEqual(["heartbeat"]);

    const h6 = await daemonHarness({ state: mk(6n), tier: "Dormant" });
    const r6 = await tick(h6.deps, NOW);
    expect(r6.tier).toBe("Conserving");
    expect(r6.tierAfter).toBe("Conserving");
    expect(h6.tiers.sets).toEqual(["Conserving"]);
    expect(kinds(r6.actions)).toEqual(["heartbeat", "journalWrite", "castPost"]);
  });

  it("hosting lapsed ⇒ Evicted: survival subset only; rental still attempted", async () => {
    const s = mkState({ hostingPaidUntil: NOW - DAY });
    const h = await daemonHarness({ state: s, tier: "Active", reader: { accrued: 500n * E6 } });
    const r = await tick(h.deps, NOW);
    expect(r.tier).toBe("Evicted");
    expect(r.tierAfter).toBe("Evicted");
    expect(kinds(r.actions)).toEqual(["treasuryTransfer", "heartbeat", "journalWrite", "castPost"]);
    // paidDays = −1 ⇒ cost 61 × 1.7 = 103.7, capped at the 100 USDC daily cap
    expect(r.actions[0]!.action).toMatchObject({ purpose: "oysterRental", amount: 100n * E6 });
    expect(h.reader.accruedCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Deny never aborts
// ---------------------------------------------------------------------------

describe("denies / failures never abort later steps", () => {
  it("EVERY step's action denied (broken execute clock ⇒ MALFORMED) ⇒ all 9 steps run and report", async () => {
    const h = await daemonHarness({
      state: goldenState(),
      tier: "Conserving", // ⇒ step 9 transition to Active ⇒ announcements (also denied)
      history: [6n * E6, 6n * E6, 6n * E6],
      reader: { accrued: 75n * E6, quotes: GOLDEN_QUOTES },
      clock: () => -1n,
    });
    const r = await tick(h.deps, NOW);
    expect(r.steps.map((s) => s.step)).toEqual(STEP_ORDER);
    for (const s of r.steps) expect(s.status, s.step).toBe("ran");
    expect(kinds(r.actions)).toEqual([
      "treasuryTransfer", // rental
      "treasuryTransfer", // gasTopUp rh
      "treasuryTransfer", // ETH bridge → optimism
      "treasuryTransfer", // USDG refill
      "distribute",
      "treasurySwap", // dry-run deny: no approve attempted
      "allowance",
      "heartbeat",
      "journalWrite",
      "castPost",
    ]);
    for (const a of r.actions) expect(a.verdict.allow ? "allow" : a.verdict.code).toBe("MALFORMED");
    expect(h.chain.sent).toHaveLength(0);
    expect(h.sink.files.size).toBe(1); // snapshot is not an engine action
    expect(r.tierAfter).toBe("Active");
    expectAllLogged(h, r);
    expect(listActions(h.db).every((row) => row.verdict === "deny")).toBe(true);
  });

  it("a throwing reader ⇒ that step reports error; later steps run", async () => {
    const h = await daemonHarness({
      state: goldenState(),
      tier: "Active",
      history: [6n * E6, 6n * E6, 6n * E6],
      reader: { accrued: new Error("rpc down"), quotes: GOLDEN_QUOTES },
    });
    const r = await tick(h.deps, NOW);
    const d = step(r, "distribute");
    expect(d.status).toBe("error");
    if (d.status === "error") expect(d.error).toBe("rpc down");
    expect(kinds(step(r, "convert").status === "ran" ? r.actions : [])).toContain("treasurySwap");
    expect(kinds(r.actions)).toContain("allowance");
    expect(kinds(r.actions).at(-1)).toBe("heartbeat");
    expect(step(r, "snapshot").status).toBe("ran");
  });

  it("reverted / dropped txs are recorded and the tick continues", async () => {
    const h = await daemonHarness({
      state: goldenState(),
      tier: "Active",
      history: [6n * E6, 6n * E6, 6n * E6],
      reader: { accrued: 75n * E6, quotes: GOLDEN_QUOTES },
      chain: { outcomes: ["reverted", new Error("dropped")] },
    });
    const r = await tick(h.deps, NOW);
    expect(r.actions).toHaveLength(9);
    expect(r.actions[0]!.error).toMatch(/reverted/);
    expect(r.actions[1]!.error).toBe("dropped");
    expect(r.actions.slice(2).every((a) => a.error === undefined && a.verdict.allow)).toBe(true);
    expectAllLogged(h, r);
  });
});

// ---------------------------------------------------------------------------
// Step 1: rental math
// ---------------------------------------------------------------------------

describe("step 1 rental", () => {
  it("boundary: paid 44.9d ⇒ rent (60 − 44) × 1.7 = 27.2 USDC; paid 45.1d ⇒ skip", async () => {
    const at = (tenths: bigint) => mkState({ hostingPaidUntil: NOW + (tenths * DAY) / 10n });
    const h1 = await daemonHarness({ state: at(449n), tier: "Active" });
    const r1 = await tick(h1.deps, NOW);
    expect(r1.actions[0]!.action).toEqual({
      kind: "treasuryTransfer", purpose: "oysterRental", chain: "arbitrum", asset: "USDC", to: MARLIN_PAY, amount: 27_200_000n,
    });
    expect(r1.actions[0]!.verdict.allow).toBe(true);

    const h2 = await daemonHarness({ state: at(451n), tier: "Active" });
    const r2 = await tick(h2.deps, NOW);
    const st = step(r2, "rental");
    expect(st.status).toBe("skipped");
    if (st.status === "skipped") expect(st.reason).toMatch(/paid ahead 45d/);
  });

  it("bounded by T3 daily-cap headroom and by arb USDC balance", () => {
    const cfg = mkCfg();
    const s = mkState({ hostingPaidUntil: NOW }); // cost 60 × 1.7 = 102
    expect(rentalAmount(s, mkLedger(), cfg, NOW).amount).toBe(100n * E6); // cap 100
    expect(rentalAmount(s, mkLedger({ treasurySpent: { oysterRental: 90n * E6 } }), cfg, NOW).amount).toBe(10n * E6);
    expect(rentalAmount(s, mkLedger({ treasurySpent: { oysterRental: 100n * E6 } }), cfg, NOW).amount).toBe(0n);
    const poor = mkState({ hostingPaidUntil: NOW });
    poor.treasury.arbitrum = { native: 0n, USDC: 7n * E6 };
    expect(rentalAmount(poor, mkLedger(), cfg, NOW).amount).toBe(7n * E6);
  });

  it("tick: yesterday's oysterRental spend does not reduce today's headroom (ledger rolled)", async () => {
    const stale = { ...mkLedger({ treasurySpent: { oysterRental: 100n * E6 } }), dayKey: "2026-09-22" };
    const h = await daemonHarness({ state: mkState({ hostingPaidUntil: NOW }), tier: "Active", ledger: stale, lastSnapshotAt: NOW });
    const r = await tick(h.deps, NOW);
    expect(r.actions[0]!.action).toMatchObject({ purpose: "oysterRental", amount: 100n * E6 });
    expect(r.actions[0]!.verdict.allow).toBe(true);
    // same-day spend DOES reduce it
    const h2 = await daemonHarness({
      state: mkState({ hostingPaidUntil: NOW }), tier: "Active", lastSnapshotAt: NOW,
      ledger: mkLedger({ treasurySpent: { oysterRental: 100n * E6 } }),
    });
    const st = step(await tick(h2.deps, NOW), "rental");
    expect(st.status).toBe("skipped");
    if (st.status === "skipped") expect(st.reason).toMatch(/cap headroom 0/);
  });

  it("zero hosting rate ⇒ skip", () => {
    expect(rentalAmount(mkState({ hostingRatePerDay: 0n }), mkLedger(), mkCfg(), NOW)).toMatchObject({ amount: 0n });
  });
});

// ---------------------------------------------------------------------------
// Step 2: gas
// ---------------------------------------------------------------------------

describe("step 2 gas floors", () => {
  it("treasury short on base, arbitrum richest ⇒ bridge from arbitrum; source never drops below its target", async () => {
    const s = mkState({ hostingPaidUntil: NOW + 50n * DAY });
    s.treasury.base = { native: 0n, USDC: 50n * E6 };
    s.treasury.arbitrum = { native: 15n * 10n ** 15n, USDC: 200n * E6 }; // 0.015: surplus 0.005 above 0.01 target
    s.treasury.rh = { ...s.treasury.rh, native: 5n * 10n ** 15n }; // 0.005: surplus 0.002
    s.treasury.optimism = { native: 12n * 10n ** 15n }; // 0.012: surplus 0.002
    const h = await daemonHarness({ state: s, tier: "Active", lastSnapshotAt: NOW });
    const r = await tick(h.deps, NOW);
    const g = step(r, "gas");
    if (g.status !== "ran") throw new Error("gas should run");
    expect(g.results.map((x) => x.action)).toEqual([
      {
        kind: "treasuryTransfer", purpose: "acrossBridge", chain: "arbitrum", asset: "ETH", to: SPOKE.arbitrum,
        amount: 5n * 10n ** 15n, recipient: h.cfg.treasury, destChain: "base",
      },
    ]);
    allOk(g.results);
  });

  it("no chain above target ⇒ skipped with reason, nothing executed", async () => {
    const s = mkState({ hostingPaidUntil: NOW + 50n * DAY });
    for (const c of ["rh", "base", "arbitrum", "optimism"] as const) s.treasury[c] = { ...s.treasury[c], native: 0n };
    s.action.rh = { ...s.action.rh, native: 0n };
    const h = await daemonHarness({ state: s, tier: "Active", lastSnapshotAt: NOW });
    const r = await tick(h.deps, NOW);
    const g = step(r, "gas");
    expect(g.status).toBe("skipped");
    if (g.status === "skipped") {
      expect(g.reason).toMatch(/no chain above target/);
      expect(g.reason).toMatch(/action rh native 0 < floor; treasury rh has no surplus/);
    }
  });

  it("two short chains never double-spend one source's surplus", async () => {
    const s = mkState({ hostingPaidUntil: NOW + 50n * DAY });
    s.treasury.rh = { ...s.treasury.rh, native: 13n * 10n ** 15n }; // surplus 0.010 above 0.003
    s.treasury.base = { native: 0n, USDC: 50n * E6 };
    s.treasury.arbitrum = { native: 0n, USDC: 200n * E6 };
    s.treasury.optimism = { native: 0n };
    const h = await daemonHarness({ state: s, tier: "Active", lastSnapshotAt: NOW, caps: { gasTopUpDailyCapWeiPerChain: (10n ** 17n).toString() } });
    const r = await tick(h.deps, NOW);
    const g = step(r, "gas");
    if (g.status !== "ran") throw new Error("gas should run");
    // base takes the full 0.010 surplus of rh; arbitrum/optimism find no source left
    expect(g.results.map((x) => x.action)).toEqual([
      expect.objectContaining({ chain: "rh", destChain: "base", amount: 10n * 10n ** 15n }),
    ]);
    expect(g.notes.join(";")).toMatch(/treasury arbitrum native 0 < floor; no chain above target/);
  });
});

// ---------------------------------------------------------------------------
// Step 3: inference refill math
// ---------------------------------------------------------------------------

describe("step 3 inference refill", () => {
  it("trailingBurn: per-day max of the last 3 complete days; today's rows and older days ignored", () => {
    const db = openMemory(":memory:");
    const row = (ts: bigint, total: bigint) => saveLedger(db, { ...emptyLedger(ts), inferenceSpent: { pulse: total, chat: 0n, social: 0n } }, ts);
    row(NOW - 4n * DAY, 100n * E6); // 4th day back: outside the window
    row(NOW - 3n * DAY, 3n * E6);
    row(NOW - 2n * DAY - 3_600n, 2n * E6);
    row(NOW - 2n * DAY, 6n * E6); // same day, later ⇒ day total 6
    row(NOW - DAY, 9n * E6);
    row(NOW, 50n * E6); // today (incomplete) ignored
    const b = trailingBurn(db, NOW);
    expect(b.days).toBe(3);
    expect(b.dayTotals.map((d) => d.total)).toEqual([9n * E6, 6n * E6, 3n * E6]);
    expect(b.burn).toBe(6n * E6);
  });

  it("fewer than 3 days ⇒ burn = max(avg, 1 USDG); none ⇒ 1 USDG", () => {
    const db = openMemory(":memory:");
    expect(trailingBurn(db, NOW)).toMatchObject({ burn: E6, days: 0 });
    saveLedger(db, { ...emptyLedger(NOW - DAY), inferenceSpent: { pulse: 400_000n, chat: 0n, social: 0n } }, NOW - DAY);
    expect(trailingBurn(db, NOW)).toMatchObject({ burn: E6, days: 1 });
    saveLedger(db, { ...emptyLedger(NOW - 2n * DAY), inferenceSpent: { pulse: 5n * E6, chat: 0n, social: 0n } }, NOW - 2n * DAY);
    expect(trailingBurn(db, NOW)).toMatchObject({ burn: 2_700_000n, days: 2 });
  });

  it("refillAmount: threshold max(3×burn, 15), target max(10×burn, 15) − balance, bounded by bridge headroom", () => {
    const cfg = mkCfg();
    const L = mkLedger();
    // burn 6: threshold 18
    expect(refillAmount(18n * E6, 6n * E6, L, cfg).amount).toBe(0n);
    expect(refillAmount(18n * E6 - 1n, 6n * E6, L, cfg).amount).toBe(42n * E6 + 1n);
    // burn 2: threshold = 15 floor; target 20
    expect(refillAmount(14n * E6, 2n * E6, L, cfg).amount).toBe(6n * E6);
    expect(refillAmount(15n * E6, 2n * E6, L, cfg).amount).toBe(0n);
    // headroom: 1000 cap − 990 spent = 10
    expect(refillAmount(0n, 6n * E6, mkLedger({ treasurySpent: { acrossBridge: 990n * E6 } }), cfg).amount).toBe(10n * E6);
    expect(refillAmount(0n, 6n * E6, mkLedger({ treasurySpent: { acrossBridge: 1000n * E6 } }), cfg).amount).toBe(0n);
    // burn 1 ⇒ threshold 15, target max(10, 15) = 15 ⇒ balance 12 refills to 15 (never a zero refill)
    expect(refillAmount(12n * E6, E6, L, cfg).amount).toBe(3n * E6);
    expect(refillAmount(15n * E6 - 1n, E6, L, cfg).amount).toBe(1n);
    // burn 0 (degenerate) ⇒ still floored to the 15 USDG minimum
    expect(refillAmount(0n, 0n, L, cfg).amount).toBe(15n * E6);
  });

  it("tick: no history ⇒ burn 1 USDG; base USDC 5 < 15 ⇒ bridge max(10, 15) − 5 = 10 USDG rh→base", async () => {
    const s = mkState({ hostingPaidUntil: NOW + 50n * DAY });
    s.treasury.base = { native: E18 / 10n, USDC: 5n * E6 };
    const h = await daemonHarness({ state: s, tier: "Active", lastSnapshotAt: NOW });
    const r = await tick(h.deps, NOW);
    const st = step(r, "inferenceRefill");
    if (st.status !== "ran") throw new Error("refill should run");
    expect(st.results.map((x) => x.action)).toEqual([
      {
        kind: "treasuryTransfer", purpose: "acrossBridge", chain: "rh", asset: "USDG", to: SPOKE.rh,
        amount: 10n * E6, recipient: h.cfg.treasury, destChain: "base",
      },
    ]);
    allOk(st.results);
    expect(st.notes[0]).toBe(`burn ${E6}/d over 0d`);
  });

  it("tick: burn 1 USDG, base USDC 12 ⇒ refill to 15 (3 USDG bridged)", async () => {
    const s = mkState({ hostingPaidUntil: NOW + 50n * DAY });
    s.treasury.base = { native: E18 / 10n, USDC: 12n * E6 };
    const h = await daemonHarness({ state: s, tier: "Active", lastSnapshotAt: NOW });
    const r = await tick(h.deps, NOW);
    const st = step(r, "inferenceRefill");
    if (st.status !== "ran") throw new Error("refill should run");
    expect(st.results.map((x) => x.action)).toMatchObject([{ purpose: "acrossBridge", asset: "USDG", amount: 3n * E6, destChain: "base" }]);
    allOk(st.results);
  });
});

// ---------------------------------------------------------------------------
// Steps 4–6
// ---------------------------------------------------------------------------

describe("steps 4–6", () => {
  it("distribute only when accrued > threshold (strict)", async () => {
    const base = { state: mkState({ hostingPaidUntil: NOW + 50n * DAY }), tier: "Active" as const, lastSnapshotAt: NOW };
    const hEq = await daemonHarness({ ...base, reader: { accrued: 50n * E6 } });
    expect(step(await tick(hEq.deps, NOW), "distribute").status).toBe("skipped");
    const hGt = await daemonHarness({ ...base, reader: { accrued: 50n * E6 + 1n } });
    const r = await tick(hGt.deps, NOW);
    expect(kinds(r.actions)).toContain("distribute");
    expect(hGt.reader.accruedCalls).toEqual([1]);
  });

  it("convert: quote < 1 USDG skipped; minOut = quote × 9800/10000; USDG-by-address never converted", async () => {
    const s = mkState({ hostingPaidUntil: NOW + 50n * DAY });
    const TOKEN_Z = "0x7272aaaa000000000000000000000000007272bb" as const;
    s.treasury.rh = { ...s.treasury.rh, tokens: { [TOKEN_X]: 10n * E18, [TOKEN_Z]: 5n * E18, [mkCfg().usdg.rh]: 99n * E6 } };
    const h = await daemonHarness({
      state: s, tier: "Active", lastSnapshotAt: NOW,
      reader: { quotes: { [TOKEN_X.toLowerCase()]: E6 - 1n, [TOKEN_Z.toLowerCase()]: 3n * E6 } },
    });
    const r = await tick(h.deps, NOW);
    const st = step(r, "convert");
    if (st.status !== "ran") throw new Error("convert should run");
    expect(st.results.map((x) => x.action)).toEqual([
      { kind: "treasuryApprove", token: TOKEN_Z, spender: SWAP_ROUTER, amount: 5n * E18 },
      { kind: "treasurySwap", tokenIn: TOKEN_Z, amountIn: 5n * E18, minOut: 2_940_000n },
    ]);
    expect(st.notes.join(";")).toMatch(/quote 999999 < 1 USDG/);
    expect(h.reader.quoteCalls.map((q) => q.token.toLowerCase()).sort()).toEqual([TOKEN_X.toLowerCase(), TOKEN_Z.toLowerCase()].sort());
  });

  it("allowance: pulled < 24h ago ⇒ skip; ≥ 24h ago ⇒ pull min(5%, 500)", async () => {
    const s = mkState({ hostingPaidUntil: NOW + 50n * DAY });
    s.treasury.rh = { ...s.treasury.rh, USDG: 4000n * E6 }; // 5% = 200
    const today = await daemonHarness({ state: s, tier: "Active", lastSnapshotAt: NOW, ledger: mkLedger({ lastAllowanceAt: NOW - 3_600n }) });
    const r1 = await tick(today.deps, NOW);
    const a1 = step(r1, "allowance");
    expect(a1.status).toBe("skipped");
    if (a1.status === "skipped") expect(a1.reason).toMatch(/pulled 3600s ago/);

    // No ALLOWANCE_EARLY noise across UTC midnight: pulled yesterday 23:00, tick today 01:00 ⇒ skip (not a deny).
    const DAY0 = NOW - 43_200n;
    const mid = await daemonHarness({ state: s, tier: "Active", lastSnapshotAt: DAY0, ledger: mkLedger({ lastAllowanceAt: DAY0 - 3_600n }) });
    const rm = await tick(mid.deps, DAY0 + 3_600n);
    expect(step(rm, "allowance").status).toBe("skipped");
    expect(rm.actions.some((x) => !x.verdict.allow && x.verdict.code === "ALLOWANCE_EARLY")).toBe(false);

    // boundary: exactly 86400s ⇒ pull; 86399s ⇒ skip
    const exact = await daemonHarness({ state: s, tier: "Active", lastSnapshotAt: NOW, ledger: mkLedger({ lastAllowanceAt: NOW - DAY }) });
    const re = step(await tick(exact.deps, NOW), "allowance");
    if (re.status !== "ran") throw new Error("allowance should run at exactly 24h");
    allOk(re.results);
    const early = await daemonHarness({ state: s, tier: "Active", lastSnapshotAt: NOW, ledger: mkLedger({ lastAllowanceAt: NOW - DAY + 1n }) });
    expect(step(await tick(early.deps, NOW), "allowance").status).toBe("skipped");

    const yday = await daemonHarness({ state: s, tier: "Active", lastSnapshotAt: NOW, ledger: mkLedger({ lastAllowanceAt: NOW - DAY - 1n }) });
    const r2 = await tick(yday.deps, NOW);
    const a2 = step(r2, "allowance");
    if (a2.status !== "ran") throw new Error("allowance should run");
    expect(a2.results.map((x) => x.action)).toEqual([{ kind: "allowance", amount: 200n * E6 }]);
    allOk(a2.results);
  });
});

// ---------------------------------------------------------------------------
// Step 8: snapshot cadence
// ---------------------------------------------------------------------------

describe("step 8 snapshot", () => {
  it("due iff no record or now − last ≥ 24h", () => {
    const db = openMemory(":memory:");
    expect(snapshotDue(db, NOW)).toBe(true);
    kvSet(db, KV_LAST_SNAPSHOT_AT, (NOW - DAY + 1n).toString());
    expect(snapshotDue(db, NOW)).toBe(false);
    kvSet(db, KV_LAST_SNAPSHOT_AT, (NOW - DAY).toString());
    expect(snapshotDue(db, NOW)).toBe(true);
    kvSet(db, KV_LAST_SNAPSHOT_AT, (NOW - DAY - 1n).toString());
    expect(snapshotDue(db, NOW)).toBe(true);
    kvSet(db, KV_LAST_SNAPSHOT_AT, "garbage");
    expect(snapshotDue(db, NOW)).toBe(true);
  });

  it("due ⇒ encrypted snapshot written + kv updated + restorable under memKey; next tick (6h) not due", async () => {
    const h = await daemonHarness({ state: mkState({ hostingPaidUntil: NOW + 50n * DAY }), tier: "Active" });
    const r = await tick(h.deps, NOW);
    expect(r.snapshotId).toBe(`snapshot-${NOW}.bin`);
    expect(kvGet(h.db, KV_LAST_SNAPSHOT_AT)).toBe(NOW.toString());
    const restored = await restoreLatest([h.sink], h.kr.memKeyForMemoryModule());
    expect(restored?.meta.agentId).toBe(1);
    expect(restored?.meta.createdAt).toBe(NOW);

    const r2 = await tick(h.deps, NOW + 21_600n);
    expect(step(r2, "snapshot").status).toBe("skipped");
    expect(r2.snapshotId).toBeUndefined();
    expect(h.sink.files.size).toBe(1);

    // 6h cadence lands on exactly 24h after the last snapshot ⇒ due (≥), snapshots
    for (const dt of [43_200n, 64_800n]) expect(step(await tick(h.deps, NOW + dt), "snapshot").status).toBe("skipped");
    const r24 = await tick(h.deps, NOW + DAY);
    expect(step(r24, "snapshot").status).toBe("ran");
    expect(r24.snapshotId).toBe(`snapshot-${NOW + DAY}.bin`);
    expect(h.sink.files.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Step 9: tier transition announcements
// ---------------------------------------------------------------------------

describe("step 9 tier recompute", () => {
  it("Active → Conserving ⇒ tierStore updated, journalWrite + castPost executed through the engine", async () => {
    const s = mkState({ hostingPaidUntil: NOW + 5n * DAY, hostingRatePerDay: 100n * E6 });
    s.treasury.arbitrum = { native: E18 / 10n, USDC: 0n };
    s.treasury.rh = { ...s.treasury.rh, USDG: 1000n * E6, tokens: {} };
    const h = await daemonHarness({ state: s, tier: "Active", lastSnapshotAt: NOW });
    const r = await tick(h.deps, NOW);
    expect(r.tier).toBe("Conserving"); // tick already gated as Conserving
    expect(r.tierAfter).toBe("Conserving");
    expect(h.tiers.tier).toBe("Conserving");
    const st = step(r, "tier");
    if (st.status !== "ran") throw new Error("tier step should run");
    expect(kinds(st.results)).toEqual(["journalWrite", "castPost"]);
    allOk(st.results);
    expect(h.journal).toHaveLength(1);
    expect(h.casts).toHaveLength(1);
    const jText = new TextDecoder().decode(h.journal[0]);
    expect(jText).toBe(`[daemon] tier transition Active -> Conserving at ${NOW} (runway 14d).`);
    const j = st.results[0]!.action;
    if (j.kind !== "journalWrite") throw new Error("journal expected");
    expect(j.contentHash).toBe(keccak256(h.journal[0]!));
    expect(j.sizeBytes).toBe(BigInt(h.journal[0]!.length));
    expect(h.ledger().journalToday).toBe(1n);
    expect(h.ledger().castPostsToday).toBe(1n);
    expect(kinds(r.actions)).not.toContain("allowance");
  });

  it("announcement castPost subject to pace cap (S1) — deny logged, journal still written", async () => {
    const s = mkState({ hostingPaidUntil: NOW + 5n * DAY, hostingRatePerDay: 100n * E6 });
    s.treasury.arbitrum = { native: E18 / 10n, USDC: 0n };
    s.treasury.rh = { ...s.treasury.rh, USDG: 1000n * E6, tokens: {} };
    const h = await daemonHarness({ state: s, tier: "Active", lastSnapshotAt: NOW, ledger: mkLedger({ castPostsToday: 1n }) });
    const r = await tick(h.deps, NOW);
    const st = step(r, "tier");
    if (st.status !== "ran") throw new Error("tier step should run");
    expect(st.results[0]!.verdict.allow).toBe(true);
    const c = st.results[1]!;
    expect(c.verdict.allow ? "allow" : c.verdict.code).toBe("PACE_CAP");
    expect(h.tiers.tier).toBe("Conserving");
    expectAllLogged(h, r);
  });

  it("first tick (no stored tier) initializes without announcing", async () => {
    const h = await daemonHarness({ state: mkState({ hostingPaidUntil: NOW + 50n * DAY }), lastSnapshotAt: NOW });
    const r = await tick(h.deps, NOW);
    expect(h.tiers.sets).toEqual(["Active"]);
    const st = step(r, "tier");
    expect(st.status).toBe("skipped");
    if (st.status === "skipped") expect(st.reason).toMatch(/initialized: Active/);
  });

  it("kvTierStore round-trips and ignores garbage", () => {
    const db = openMemory(":memory:");
    const ts = kvTierStore(db);
    expect(ts.get()).toBeUndefined();
    ts.set("Dormant");
    expect(ts.get()).toBe("Dormant");
    kvSet(db, "daemonTier", "Bogus");
    expect(ts.get()).toBeUndefined();
  });
});
