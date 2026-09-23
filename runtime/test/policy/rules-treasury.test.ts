// SPEC-M2 §3 Treasury rules T0–T5 + runway helper.

import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { fundable, RUNWAY_INFINITE_DAYS, runwayDays } from "../../src/policy/runway.js";
import type { Chain, ProposedAction, TreasuryPurpose } from "../../src/policy/types.js";
import {
  ACTION, ARWEAVE, CP, DAY, E18, E6, MARLIN_PAY, MARLIN_PAY2, NOW, PAYTO_DATA, PAYTO_INF_CHEAP, PAYTO_INF_STD,
  SPOKE, TOKEN_X, TREASURY, USDG_RH,
  cfg, ev, expectAllow, expectDeny, mkLedger, mkRunwayState, mkState, raw,
} from "./helpers.js";

type TT = Extract<ProposedAction, { kind: "treasuryTransfer" }>;
const CHAINS: Chain[] = ["rh", "base", "arbitrum", "optimism"];

function tt(purpose: TreasuryPurpose, chain: Chain, asset: TT["asset"], to: `0x${string}`, amount: bigint, recipient?: `0x${string}`): TT {
  const a: TT = { kind: "treasuryTransfer", purpose, chain, asset, to, amount };
  if (recipient !== undefined) a.recipient = recipient;
  return a;
}

// ---------------------------------------------------------------------------
// Runway helper
// ---------------------------------------------------------------------------

describe("runwayDays (SPEC §3 Runway)", () => {
  it("default fixture: 30 paid days + floor((200 + 10000×0.995)/1.7) = 30 + 5970", () => {
    const s = mkState();
    expect(fundable(s, 50)).toBe(200n * E6 + 9_950n * E6);
    expect(runwayDays(s, NOW, undefined, 50)).toBe(30n + 5970n);
  });
  it("haircut floors: 76_884_423 USDG(6) ⇒ 76_500_000 fundable (exactly 45d at $1.70), 76_884_422 ⇒ 44d", () => {
    expect(runwayDays(mkRunwayState(0n, 76_884_423n), NOW, undefined, 50)).toBe(45n);
    expect(runwayDays(mkRunwayState(0n, 76_884_422n), NOW, undefined, 50)).toBe(44n);
  });
  it("rh USDG spend reduces the haircutted leg", () => {
    const s = mkRunwayState(0n, 76_884_423n);
    expect(runwayDays(s, NOW, { chain: "rh", asset: "USDG", amount: 1n }, 50)).toBe(44n);
  });
  it("arbitrum USDC spend reduces the USDC leg", () => {
    const s = mkRunwayState(76_500_000n);
    expect(runwayDays(s, NOW, undefined, 50)).toBe(45n);
    expect(runwayDays(s, NOW, { chain: "arbitrum", asset: "USDC", amount: 1n }, 50)).toBe(44n);
  });
  it("other (chain, asset) spends leave fundable unchanged", () => {
    const s = mkRunwayState(76_500_000n);
    for (const sp of [
      { chain: "base", asset: "USDC", amount: 10n * E6 },
      { chain: "rh", asset: "USDC", amount: 10n * E6 },
      { chain: "arbitrum", asset: "USDG", amount: 10n * E6 },
      { chain: "arbitrum", asset: "ETH", amount: E18 },
    ] as const) {
      expect(runwayDays(s, NOW, sp, 50)).toBe(45n);
    }
  });
  it("hostingPaidUntil in the past floors negative: -1s ⇒ -1 day, -86400s ⇒ -1, -86401s ⇒ -2", () => {
    expect(runwayDays(mkRunwayState(0n, 0n, NOW - 1n), NOW, undefined, 50)).toBe(-1n);
    expect(runwayDays(mkRunwayState(0n, 0n, NOW - DAY), NOW, undefined, 50)).toBe(-1n);
    expect(runwayDays(mkRunwayState(0n, 0n, NOW - DAY - 1n), NOW, undefined, 50)).toBe(-2n);
  });
  it("paid days floor: +86399s ⇒ 0, +86400s ⇒ 1", () => {
    expect(runwayDays(mkRunwayState(0n, 0n, NOW + DAY - 1n), NOW, undefined, 50)).toBe(0n);
    expect(runwayDays(mkRunwayState(0n, 0n, NOW + DAY), NOW, undefined, 50)).toBe(1n);
  });
  it("hostingRatePerDay = 0 ⇒ RUNWAY_INFINITE_DAYS sentinel (10^9)", () => {
    expect(RUNWAY_INFINITE_DAYS).toBe(1_000_000_000n);
    expect(runwayDays(mkRunwayState(0n, 0n, NOW - 100n * DAY, 0n), NOW, undefined, 50)).toBe(RUNWAY_INFINITE_DAYS);
  });
  it("bridgeHaircutBps is honoured (0 bps ⇒ full USDG counts)", () => {
    expect(fundable(mkRunwayState(0n, 1000n), 0)).toBe(1000n);
    expect(fundable(mkRunwayState(0n, 1000n), 10_000)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// T1
// ---------------------------------------------------------------------------

describe("T1: heartbeat / registerInstance / distribute always allowed", () => {
  const broke = mkRunwayState(0n, 0n, NOW - 365n * DAY); // runway deeply negative, zero balances
  for (const kind of ["heartbeat", "registerInstance", "distribute"] as const) {
    it(`T1: ${kind} allowed (even with zero balances and negative runway)`, () => {
      expectAllow(ev({ kind }, { state: broke }));
    });
  }
});

// ---------------------------------------------------------------------------
// T2 matrix
// ---------------------------------------------------------------------------

describe("T2: destination/chain/asset matrix", () => {
  const allowCases: Array<[string, TT]> = [
    ["oysterRental → marlin payment #1", tt("oysterRental", "arbitrum", "USDC", MARLIN_PAY, 10n * E6)],
    ["oysterRental → marlin payment #2", tt("oysterRental", "arbitrum", "USDC", MARLIN_PAY2, 10n * E6)],
    ["oysterRental → checksummed marlin address (case-insensitive)", tt("oysterRental", "arbitrum", "USDC", getAddress(MARLIN_PAY), 10n * E6)],
    ["acrossBridge rh USDG → spokePool.rh, recipient treasury", tt("acrossBridge", "rh", "USDG", SPOKE.rh, 100n * E6, TREASURY)],
    ["acrossBridge arbitrum USDC → spokePool.arbitrum", tt("acrossBridge", "arbitrum", "USDC", SPOKE.arbitrum, 10n * E6, TREASURY)],
    ["acrossBridge base USDC → spokePool.base", tt("acrossBridge", "base", "USDC", SPOKE.base, 10n * E6, TREASURY)],
    ["acrossBridge base ETH → spokePool.base", tt("acrossBridge", "base", "ETH", SPOKE.base, E18 / 1000n, TREASURY)],
    ["acrossBridge optimism ETH → spokePool.optimism", tt("acrossBridge", "optimism", "ETH", SPOKE.optimism, E18 / 1000n, TREASURY)],
    ["acrossBridge recipient checksummed treasury", tt("acrossBridge", "rh", "USDG", SPOKE.rh, E6, getAddress(TREASURY))],
    ["arweaveFunding rh USDG → arweave", tt("arweaveFunding", "rh", "USDG", ARWEAVE, 5n * E6)],
    ["x402Data base USDC → data payTo", tt("x402Data", "base", "USDC", PAYTO_DATA, E6)],
    ...CHAINS.flatMap((c): Array<[string, TT]> => [
      [`gasTopUp ${c} ETH → own treasury`, tt("gasTopUp", c, "ETH", TREASURY, E18 / 1000n)],
      [`gasTopUp ${c} ETH → own action`, tt("gasTopUp", c, "ETH", ACTION, E18 / 1000n)],
    ]),
  ];
  for (const [name, a] of allowCases) {
    it(`T2: ${name} ⇒ allow`, () => expectAllow(ev(a)));
  }

  const whitelistDenies: Array<[string, TT]> = [
    ["oysterRental wrong chain (base)", tt("oysterRental", "base", "USDC", MARLIN_PAY, E6)],
    ["oysterRental wrong chain (rh)", tt("oysterRental", "rh", "USDC", MARLIN_PAY, E6)],
    ["oysterRental wrong asset (USDG)", tt("oysterRental", "arbitrum", "USDG", MARLIN_PAY, E6)],
    ["oysterRental wrong asset (ETH)", tt("oysterRental", "arbitrum", "ETH", MARLIN_PAY, E6)],
    ["oysterRental to spokePool", tt("oysterRental", "arbitrum", "USDC", SPOKE.arbitrum, E6)],
    ["oysterRental to own treasury", tt("oysterRental", "arbitrum", "USDC", TREASURY, E6)],
    ["oysterRental to random", tt("oysterRental", "arbitrum", "USDC", CP, E6)],
    ["acrossBridge to spokePool of another chain", tt("acrossBridge", "rh", "USDG", SPOKE.base, E6, TREASURY)],
    ["acrossBridge to random", tt("acrossBridge", "arbitrum", "USDC", CP, E6, TREASURY)],
    ["acrossBridge to own treasury", tt("acrossBridge", "arbitrum", "USDC", TREASURY, E6, TREASURY)],
    ["arweaveFunding wrong chain", tt("arweaveFunding", "base", "USDG", ARWEAVE, E6)],
    ["arweaveFunding wrong asset", tt("arweaveFunding", "rh", "USDC", ARWEAVE, E6)],
    ["arweaveFunding wrong to", tt("arweaveFunding", "rh", "USDG", CP, E6)],
    ["gasTopUp asset USDC", tt("gasTopUp", "base", "USDC", TREASURY, E6)],
    ["gasTopUp asset USDG", tt("gasTopUp", "rh", "USDG", ACTION, E6)],
    ["gasTopUp to random", tt("gasTopUp", "rh", "ETH", CP, E18 / 1000n)],
    ["gasTopUp to spokePool", tt("gasTopUp", "rh", "ETH", SPOKE.rh, E18 / 1000n)],
    ["x402Data to inference payTo (cheap)", tt("x402Data", "base", "USDC", PAYTO_INF_CHEAP, E6)],
    ["x402Data to inference payTo (standard)", tt("x402Data", "base", "USDC", PAYTO_INF_STD, E6)],
    ["x402Data to random", tt("x402Data", "base", "USDC", CP, E6)],
    ["x402Data wrong chain", tt("x402Data", "rh", "USDC", PAYTO_DATA, E6)],
    ["x402Data wrong asset", tt("x402Data", "base", "USDG", PAYTO_DATA, E6)],
  ];
  for (const [name, a] of whitelistDenies) {
    it(`T2: ${name} ⇒ WHITELIST`, () => expectDeny(ev(a), "WHITELIST"));
  }

  it("T2/G1 (rev 1): purpose \"x402Inference\" no longer exists ⇒ MALFORMED (inference is paid only via the `inference` kind)", () => {
    for (const to of [PAYTO_INF_CHEAP, PAYTO_INF_STD, PAYTO_DATA]) {
      expectDeny(ev(raw({ kind: "treasuryTransfer", purpose: "x402Inference", chain: "base", asset: "USDC", to, amount: E6 })), "MALFORMED");
    }
  });

  it("T2: acrossBridge without recipient ⇒ BRIDGE_RECIPIENT", () => {
    expectDeny(ev(tt("acrossBridge", "rh", "USDG", SPOKE.rh, E6)), "BRIDGE_RECIPIENT");
  });
  it("T2: acrossBridge recipient == own ACTION EOA ⇒ BRIDGE_RECIPIENT (only treasury is valid)", () => {
    expectDeny(ev(tt("acrossBridge", "rh", "USDG", SPOKE.rh, E6, ACTION)), "BRIDGE_RECIPIENT");
  });
  it("T2: acrossBridge recipient random ⇒ BRIDGE_RECIPIENT", () => {
    expectDeny(ev(tt("acrossBridge", "arbitrum", "USDC", SPOKE.arbitrum, E6, CP)), "BRIDGE_RECIPIENT");
  });
  it("T2: acrossBridge recipient == spokePool ⇒ BRIDGE_RECIPIENT", () => {
    expectDeny(ev(tt("acrossBridge", "rh", "USDG", SPOKE.rh, E6, SPOKE.rh)), "BRIDGE_RECIPIENT");
  });
  it("T2: wrong destination is reported before recipient (WHITELIST wins)", () => {
    expectDeny(ev(tt("acrossBridge", "rh", "USDG", CP, E6, CP)), "WHITELIST");
  });
  it("T2/G1: recipient on a non-bridge purpose ⇒ MALFORMED", () => {
    expectDeny(ev(tt("oysterRental", "arbitrum", "USDC", MARLIN_PAY, E6, TREASURY)), "MALFORMED");
  });
});

// ---------------------------------------------------------------------------
// G3 for treasuryTransfer
// ---------------------------------------------------------------------------

describe("G3: treasuryTransfer balances", () => {
  it("G3: amount == balance ⇒ allow (gasTopUp 0.005 ETH with exactly 0.005 ETH)", () => {
    const s = mkState();
    s.treasury.optimism = { native: 5n * 10n ** 15n };
    expectAllow(ev(tt("gasTopUp", "optimism", "ETH", ACTION, 5n * 10n ** 15n), { state: s }));
  });
  it("G3: amount == balance + 1 ⇒ INSUFFICIENT_BALANCE", () => {
    const s = mkState();
    s.treasury.optimism = { native: 5n * 10n ** 15n };
    expectDeny(ev(tt("gasTopUp", "optimism", "ETH", ACTION, 5n * 10n ** 15n + 1n), { state: s }), "INSUFFICIENT_BALANCE");
  });
  it("G3: asset missing on chain ⇒ INSUFFICIENT_BALANCE (USDG bridge from base)", () => {
    expectDeny(ev(tt("acrossBridge", "base", "USDG", SPOKE.base, E6, TREASURY)), "INSUFFICIENT_BALANCE");
  });
  it("G3: oysterRental more than arbitrum USDC ⇒ INSUFFICIENT_BALANCE", () => {
    const s = mkRunwayState(50n * E6, 10_000n * E6);
    expectDeny(ev(tt("oysterRental", "arbitrum", "USDC", MARLIN_PAY, 50n * E6 + 1n), { state: s }), "INSUFFICIENT_BALANCE");
  });
});

// ---------------------------------------------------------------------------
// T3 daily caps
// ---------------------------------------------------------------------------

describe("T3: per-purpose daily caps", () => {
  type Row = { name: string; action: (amt: bigint) => TT; key: string; cap: bigint; spent: bigint };
  const rows: Row[] = [
    { name: "oysterRental 100 USDC", action: (x) => tt("oysterRental", "arbitrum", "USDC", MARLIN_PAY, x), key: "oysterRental", cap: 100n * E6, spent: 60n * E6 },
    { name: "acrossBridge 1000 (USDG)", action: (x) => tt("acrossBridge", "rh", "USDG", SPOKE.rh, x, TREASURY), key: "acrossBridge", cap: 1000n * E6, spent: 900n * E6 },
    { name: "acrossBridge 1000 (USDC summed 1:1)", action: (x) => tt("acrossBridge", "arbitrum", "USDC", SPOKE.arbitrum, x, TREASURY), key: "acrossBridge", cap: 1000n * E6, spent: 900n * E6 },
    { name: "arweaveFunding 10 USDG", action: (x) => tt("arweaveFunding", "rh", "USDG", ARWEAVE, x), key: "arweaveFunding", cap: 10n * E6, spent: 3n * E6 },
    ...CHAINS.map((c): Row => ({ name: `gasTopUp 0.01 ETH on ${c}`, action: (x) => tt("gasTopUp", c, "ETH", ACTION, x), key: `gasTopUp:${c}`, cap: 10n ** 16n, spent: 9n * 10n ** 15n })),
    ...CHAINS.map((c): Row => ({ name: `acrossBridge ETH from ${c} counts against gasTopUp:${c}`, action: (x) => tt("acrossBridge", c, "ETH", SPOKE[c], x, TREASURY), key: `gasTopUp:${c}`, cap: 10n ** 16n, spent: 9n * 10n ** 15n })),
    { name: "x402Data 2 USDC", action: (x) => tt("x402Data", "base", "USDC", PAYTO_DATA, x), key: "x402Data", cap: 2n * E6, spent: E6 },
  ];
  for (const r of rows) {
    it(`T3: ${r.name}: spent + amount == cap ⇒ allow`, () => {
      const L = mkLedger({ treasurySpent: { [r.key]: r.spent } });
      expectAllow(ev(r.action(r.cap - r.spent), { ledger: L }));
    });
    it(`T3: ${r.name}: spent + amount == cap + 1 ⇒ DAILY_CAP`, () => {
      const L = mkLedger({ treasurySpent: { [r.key]: r.spent } });
      expectDeny(ev(r.action(r.cap - r.spent + 1n), { ledger: L }), "DAILY_CAP");
    });
    it(`T3: ${r.name}: single transfer of exactly cap from empty bucket ⇒ allow, cap+1 ⇒ DAILY_CAP`, () => {
      const s = mkState();
      // make sure balances cover cap+1 for this row
      s.treasury.arbitrum = { native: E18, USDC: 10_000n * E6 };
      s.treasury.base = { native: E18, USDC: 10_000n * E6 };
      expectAllow(ev(r.action(r.cap), { state: s }));
      expectDeny(ev(r.action(r.cap + 1n), { state: s }), "DAILY_CAP");
    });
  }

  it("T3: gasTopUp buckets are per chain (rh at cap does not block arbitrum)", () => {
    const L = mkLedger({ treasurySpent: { "gasTopUp:rh": 10n ** 16n } });
    expectDeny(ev(tt("gasTopUp", "rh", "ETH", ACTION, 1n), { ledger: L }), "DAILY_CAP");
    expectAllow(ev(tt("gasTopUp", "arbitrum", "ETH", ACTION, 10n ** 16n), { ledger: L }));
  });
  it("T3: ETH bridge is NOT counted against acrossBridge (acrossBridge at cap, ETH bridge still allowed)", () => {
    const L = mkLedger({ treasurySpent: { acrossBridge: 1000n * E6 } });
    expectAllow(ev(tt("acrossBridge", "base", "ETH", SPOKE.base, E18 / 1000n, TREASURY), { ledger: L }));
    expectDeny(ev(tt("acrossBridge", "base", "USDC", SPOKE.base, 1n, TREASURY), { ledger: L }), "DAILY_CAP");
  });
  it("T3: a bare `gasTopUp` ledger key is ignored (only gasTopUp:<chain> counts)", () => {
    const L = mkLedger({ treasurySpent: { gasTopUp: 10n ** 18n } });
    expectAllow(ev(tt("gasTopUp", "rh", "ETH", ACTION, 10n ** 16n), { ledger: L }));
  });
  it("T3: day rollover — yesterday's full bucket does not count today", () => {
    const L = mkLedger({ dayKey: "2026-09-22", treasurySpent: { arweaveFunding: 10n * E6 } });
    expectAllow(ev(tt("arweaveFunding", "rh", "USDG", ARWEAVE, 10n * E6), { ledger: L }));
  });
});

// ---------------------------------------------------------------------------
// T0 runway gate
// ---------------------------------------------------------------------------

describe("T0: runway gate on treasury outflows", () => {
  // Exactly 45 days of runway, all in arbitrum USDC (45 × 1.70 = 76.5 USDC), paidUntil = now.
  const at45 = (): ReturnType<typeof mkState> => {
    const s = mkRunwayState(76_500_000n);
    s.treasury.base = { native: E18, USDC: 50n * E6 };
    return s;
  };
  const at44 = (): ReturnType<typeof mkState> => {
    const s = mkRunwayState(76_499_999n);
    s.treasury.base = { native: E18, USDC: 50n * E6 };
    return s;
  };

  it("T0: gasTopUp (no fundable effect) at exactly 45d ⇒ allow; at 44d ⇒ RUNWAY", () => {
    expectAllow(ev(tt("gasTopUp", "base", "ETH", ACTION, 1n), { state: at45() }));
    expectDeny(ev(tt("gasTopUp", "base", "ETH", ACTION, 1n), { state: at44() }), "RUNWAY");
  });
  it("T0: x402Data (Base USDC, no fundable effect) at 45d ⇒ allow; at 44d ⇒ RUNWAY", () => {
    expectAllow(ev(tt("x402Data", "base", "USDC", PAYTO_DATA, E6), { state: at45() }));
    expectDeny(ev(tt("x402Data", "base", "USDC", PAYTO_DATA, E6), { state: at44() }), "RUNWAY");
  });
  it("T0: acrossBridge of arbitrum USDC that drops runway 45 → 44 ⇒ RUNWAY", () => {
    expectDeny(ev(tt("acrossBridge", "arbitrum", "USDC", SPOKE.arbitrum, 1n, TREASURY), { state: at45() }), "RUNWAY");
  });
  it("T0: acrossBridge of arbitrum USDC keeping runway at 45 ⇒ allow", () => {
    const s = mkRunwayState(76_500_000n + 1_700_000n); // 46 days
    expectAllow(ev(tt("acrossBridge", "arbitrum", "USDC", SPOKE.arbitrum, 1_700_000n, TREASURY), { state: s }));
    expectDeny(ev(tt("acrossBridge", "arbitrum", "USDC", SPOKE.arbitrum, 1_700_001n, TREASURY), { state: s }), "RUNWAY");
  });
  it("T0: arweaveFunding (rh USDG) respects the haircut boundary: 76_884_423 ⇒ spending 1 drops to 44d ⇒ RUNWAY", () => {
    expectDeny(ev(tt("arweaveFunding", "rh", "USDG", ARWEAVE, 1n), { state: mkRunwayState(0n, 76_884_423n) }), "RUNWAY");
  });
  it("T0: arweaveFunding with runway to spare ⇒ allow", () => {
    expectAllow(ev(tt("arweaveFunding", "rh", "USDG", ARWEAVE, 1n), { state: mkRunwayState(0n, 78_000_000n) }));
  });
  it("T0: oysterRental is exempt (runway negative, still allowed)", () => {
    const s = mkRunwayState(50n * E6, 0n, NOW - 10n * DAY);
    expect(runwayDays(s, NOW, undefined, 50)).toBeLessThan(45n);
    expectAllow(ev(tt("oysterRental", "arbitrum", "USDC", MARLIN_PAY, 50n * E6), { state: s }));
  });
  it("T0: hostingPaidUntil in the past counts negative (paid −1d + 46d funded = 45 ⇒ allow; −2d ⇒ RUNWAY)", () => {
    expectAllow(ev(tt("gasTopUp", "rh", "ETH", ACTION, 1n), { state: mkRunwayState(46n * 1_700_000n, 0n, NOW - 1n) }));
    expectDeny(ev(tt("gasTopUp", "rh", "ETH", ACTION, 1n), { state: mkRunwayState(46n * 1_700_000n, 0n, NOW - DAY - 1n) }), "RUNWAY");
  });
  it("T0: hostingRatePerDay = 0 ⇒ infinite runway ⇒ allow even with no fundable balance", () => {
    expectAllow(ev(tt("gasTopUp", "rh", "ETH", ACTION, 1n), { state: mkRunwayState(0n, 0n, 0n, 0n) }));
  });
  it("T0: minRunwayDays is read from config", () => {
    const s = mkRunwayState(76_500_000n);
    expectDeny(ev(tt("gasTopUp", "rh", "ETH", ACTION, 1n), { state: s, cfg: { ...cfg, minRunwayDays: 46 } }), "RUNWAY");
  });
});

// ---------------------------------------------------------------------------
// T4 allowance
// ---------------------------------------------------------------------------

describe("T4: allowance", () => {
  it("T4: never granted before (lastAllowanceAt = 0n) ⇒ allow", () => {
    expectAllow(ev({ kind: "allowance", amount: 100n * E6 }, { ledger: mkLedger({ lastAllowanceAt: 0n }) }));
  });
  it("T4: 86399s since last ⇒ ALLOWANCE_EARLY", () => {
    expectDeny(ev({ kind: "allowance", amount: E6 }, { ledger: mkLedger({ lastAllowanceAt: NOW - 86_399n }) }), "ALLOWANCE_EARLY");
  });
  it("T4: exactly 86400s since last ⇒ allow", () => {
    expectAllow(ev({ kind: "allowance", amount: E6 }, { ledger: mkLedger({ lastAllowanceAt: NOW - 86_400n }) }));
  });
  it("T4: lastAllowanceAt in the future (clock went back) ⇒ ALLOWANCE_EARLY", () => {
    expectDeny(ev({ kind: "allowance", amount: E6 }, { ledger: mkLedger({ lastAllowanceAt: NOW + 10n }) }), "ALLOWANCE_EARLY");
  });
  it("T4: 24h rule survives a UTC day rollover (granted 23:00 yesterday, now 12:00 today ⇒ EARLY)", () => {
    const L = mkLedger({ dayKey: "2026-09-22", lastAllowanceAt: NOW - 13n * 3600n });
    expectDeny(ev({ kind: "allowance", amount: E6 }, { ledger: L }), "ALLOWANCE_EARLY");
  });

  it("T4: 5% < 500 cap: treasury 8000 USDG ⇒ max 400; 400 allow, 400+1 ALLOWANCE_AMOUNT", () => {
    const s = mkState();
    s.treasury.rh = { ...s.treasury.rh, USDG: 8_000n * E6 };
    expectAllow(ev({ kind: "allowance", amount: 400n * E6 }, { state: s }));
    expectDeny(ev({ kind: "allowance", amount: 400n * E6 + 1n }, { state: s }), "ALLOWANCE_AMOUNT");
  });
  it("T4: 5% > 500 cap: treasury 20000 USDG ⇒ max 500; 500 allow, 500+1 ALLOWANCE_AMOUNT", () => {
    const s = mkState();
    s.treasury.rh = { ...s.treasury.rh, USDG: 20_000n * E6 };
    expectAllow(ev({ kind: "allowance", amount: 500n * E6 }, { state: s }));
    expectDeny(ev({ kind: "allowance", amount: 500n * E6 + 1n }, { state: s }), "ALLOWANCE_AMOUNT");
  });
  it("T4: 5% == 500 exactly (treasury 10000 USDG) ⇒ 500 allow, 500+1 deny", () => {
    expectAllow(ev({ kind: "allowance", amount: 500n * E6 }));
    expectDeny(ev({ kind: "allowance", amount: 500n * E6 + 1n }), "ALLOWANCE_AMOUNT");
  });
  it("T4: 5% floors (8000.000019 USDG ⇒ max 400.000000)", () => {
    const s = mkState();
    s.treasury.rh = { ...s.treasury.rh, USDG: 8_000_000_019n };
    expectAllow(ev({ kind: "allowance", amount: 400_000_000n }, { state: s }));
    expectDeny(ev({ kind: "allowance", amount: 400_000_001n }, { state: s }), "ALLOWANCE_AMOUNT");
  });
  it("T4: allowance caps come from config", () => {
    const c = { ...cfg, allowancePctBps: 100, allowanceCapUsdg: 50n * E6 };
    expectAllow(ev({ kind: "allowance", amount: 50n * E6 }, { cfg: c }));
    expectDeny(ev({ kind: "allowance", amount: 50n * E6 + 1n }, { cfg: c }), "ALLOWANCE_AMOUNT");
  });
  it("T4/G3: treasury rh USDG < amount ⇒ INSUFFICIENT_BALANCE", () => {
    const s = mkState();
    s.treasury.rh = { native: 0n };
    expectDeny(ev({ kind: "allowance", amount: E6 }, { state: s }), "INSUFFICIENT_BALANCE");
  });
  it("T4/T0: allowance that drops runway below 45d ⇒ RUNWAY; small one keeping 45d ⇒ allow", () => {
    // 1000 USDG, haircut 995, rate 22/day ⇒ 45d. 50 USDG ⇒ 945.25/22 = 42d.
    const s = mkRunwayState(0n, 1000n * E6, NOW, 22n * E6);
    expectDeny(ev({ kind: "allowance", amount: 50n * E6 }, { state: s }), "RUNWAY");
    expectAllow(ev({ kind: "allowance", amount: E6 }, { state: s }));
  });
  it("T4: ordering — EARLY is reported before AMOUNT", () => {
    expectDeny(ev({ kind: "allowance", amount: 10_000n * E6 }, { ledger: mkLedger({ lastAllowanceAt: NOW - 1n }) }), "ALLOWANCE_EARLY");
  });
});

// ---------------------------------------------------------------------------
// T5 treasurySwap
// ---------------------------------------------------------------------------

describe("T5: treasurySwap", () => {
  it("T5: held token, amountIn == balance ⇒ allow", () => {
    expectAllow(ev({ kind: "treasurySwap", tokenIn: TOKEN_X, amountIn: 1000n * E18, minOut: 1n }));
  });
  it("T5: amountIn > balance ⇒ INSUFFICIENT_BALANCE", () => {
    expectDeny(ev({ kind: "treasurySwap", tokenIn: TOKEN_X, amountIn: 1000n * E18 + 1n, minOut: 1n }), "INSUFFICIENT_BALANCE");
  });
  it("T5: token not held on RH ⇒ INSUFFICIENT_BALANCE", () => {
    expectDeny(ev({ kind: "treasurySwap", tokenIn: CP, amountIn: 1n, minOut: 1n }), "INSUFFICIENT_BALANCE");
  });
  it("T5: token held only on base (not RH) ⇒ INSUFFICIENT_BALANCE", () => {
    const s = mkState();
    s.treasury.rh = { ...s.treasury.rh, tokens: {} };
    s.treasury.base = { ...s.treasury.base, tokens: { [TOKEN_X]: 1000n * E18 } };
    expectDeny(ev({ kind: "treasurySwap", tokenIn: TOKEN_X, amountIn: 1n, minOut: 1n }, { state: s }), "INSUFFICIENT_BALANCE");
  });
  it("T5: tokenIn == USDG (by address, any casing) ⇒ NO_RULE", () => {
    const s = mkState();
    s.treasury.rh = { ...s.treasury.rh, tokens: { [USDG_RH]: 1000n * E6 } };
    expectDeny(ev({ kind: "treasurySwap", tokenIn: USDG_RH, amountIn: 1n, minOut: 1n }, { state: s }), "NO_RULE");
    expectDeny(ev({ kind: "treasurySwap", tokenIn: getAddress(USDG_RH), amountIn: 1n, minOut: 1n }, { state: s }), "NO_RULE");
  });
  it("T5/G1: minOut = 0 ⇒ MALFORMED", () => {
    expectDeny(ev({ kind: "treasurySwap", tokenIn: TOKEN_X, amountIn: 1n, minOut: 0n }), "MALFORMED");
  });
  it("T5: token lookup is case-insensitive (checksummed map key, lowercase action)", () => {
    const s = mkState();
    s.treasury.rh = { ...s.treasury.rh, tokens: { [getAddress(TOKEN_X)]: 10n } };
    expectAllow(ev({ kind: "treasurySwap", tokenIn: TOKEN_X, amountIn: 10n, minOut: 1n }, { state: s }));
  });
  it("T5: exempt from T0 (runway negative, still allowed)", () => {
    const s = mkRunwayState(0n, 0n, NOW - 100n * DAY);
    s.treasury.rh = { ...s.treasury.rh, tokens: { [TOKEN_X]: 10n } };
    expectAllow(ev({ kind: "treasurySwap", tokenIn: TOKEN_X, amountIn: 10n, minOut: 1n }, { state: s }));
  });
});
