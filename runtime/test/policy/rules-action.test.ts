// SPEC-M2 §3 Action-wallet rules A1–A4 (+ G3).

import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { lookalikeOf, protectedAddresses } from "../../src/policy/rules/action.js";
import type { ProposedAction } from "../../src/policy/types.js";
import { ProposedActionSchema } from "../../src/policy/validate.js";
import {
  ACTION, ARWEAVE, CP, CP2, E18, E6, MARLIN_PAY, MARLIN_PAY2, PAYTO_DATA, PAYTO_INF_CHEAP, PAYTO_INF_STD,
  SPOKE, TOKEN_X, TOKEN_Y, TREASURY, USDG_RH, addr,
  cfg, ev, expectAllow, expectDeny, mkLedger, mkState,
} from "./helpers.js";

type AT = Extract<ProposedAction, { kind: "actionTransfer" }>;
const xfer = (asset: AT["asset"], to: Address, amount: bigint): AT => ({ kind: "actionTransfer", asset, to, amount });
const POOL = `0x${"ab".repeat(32)}` as const;

// Ledger with a 1000 USDG allowance today ⇒ A2 USDG cap per counterparty = 300 USDG.
const withAllowance = (over: Parameters<typeof mkLedger>[0] = {}) => mkLedger({ allowanceAmountToday: 1000n * E6, ...over });

// ---------------------------------------------------------------------------
// A1 per-tx cap (20% of that asset's action-wallet balance)
// ---------------------------------------------------------------------------

describe("A1: per-tx cap, per-asset basis", () => {
  // Default action wallet: 1000 USDG, 1 ETH, 500 TOKEN_X, 500 TOKEN_Y.
  const rows: Array<[string, AT["asset"], bigint]> = [
    ["USDG (1000 ⇒ 200)", "USDG", 200n * E6],
    ["ETH (1 ⇒ 0.2)", "ETH", E18 / 5n],
    ["token (500 ⇒ 100)", TOKEN_X, 100n * E18],
  ];
  for (const [name, asset, cap] of rows) {
    it(`A1: actionTransfer ${name}: amount == cap ⇒ allow`, () => {
      expectAllow(ev(xfer(asset, CP, cap), { ledger: withAllowance() }));
    });
    it(`A1: actionTransfer ${name}: amount == cap + 1 ⇒ PER_TX_CAP`, () => {
      expectDeny(ev(xfer(asset, CP, cap + 1n), { ledger: withAllowance() }), "PER_TX_CAP");
    });
  }
  it("A1: cap floors (balance 999 ⇒ cap 199)", () => {
    const s = mkState();
    s.action.rh = { ...s.action.rh, native: 999n };
    expectAllow(ev(xfer("ETH", CP, 199n), { state: s }));
    expectDeny(ev(xfer("ETH", CP, 200n), { state: s }), "PER_TX_CAP");
  });
  it("A1: perTxPctBps comes from config", () => {
    const c = { ...cfg, perTxPctBps: 1000 };
    expectAllow(ev(xfer("ETH", CP, E18 / 10n), { cfg: c }));
    expectDeny(ev(xfer("ETH", CP, E18 / 10n + 1n), { cfg: c }), "PER_TX_CAP");
  });
  it("A1: per-asset — a large ETH balance does not raise the token cap", () => {
    const s = mkState();
    s.action.rh = { ...s.action.rh, native: 1_000_000n * E18 };
    expectDeny(ev(xfer(TOKEN_X, CP, 100n * E18 + 1n), { state: s }), "PER_TX_CAP");
  });

  it("A1: actionSwap amountIn vs tokenIn balance (USDG 200 allow, 200+1 deny)", () => {
    expectAllow(ev({ kind: "actionSwap", tokenIn: "USDG", tokenOut: TOKEN_X, amountIn: 200n * E6, minOut: 0n }));
    expectDeny(ev({ kind: "actionSwap", tokenIn: "USDG", tokenOut: TOKEN_X, amountIn: 200n * E6 + 1n, minOut: 0n }), "PER_TX_CAP");
  });
  it("A1: actionSwap token→USDG amountIn vs token balance", () => {
    expectAllow(ev({ kind: "actionSwap", tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: 100n * E18, minOut: 1n }));
    expectDeny(ev({ kind: "actionSwap", tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: 100n * E18 + 1n, minOut: 1n }), "PER_TX_CAP");
  });
  it("A1: actionLp each leg vs its own balance", () => {
    const lp = (usdg: bigint, tok: bigint): ProposedAction => ({ kind: "actionLp", pool: POOL, usdgAmount: usdg, tokenAmount: tok, token: TOKEN_X });
    expectAllow(ev(lp(200n * E6, 100n * E18)));
    expectDeny(ev(lp(200n * E6 + 1n, 100n * E18)), "PER_TX_CAP");
    expectDeny(ev(lp(200n * E6, 100n * E18 + 1n)), "PER_TX_CAP");
  });
  it("A1/A4: actionMint value ≤ 20% of native (0.2 ETH allow, +1 wei PER_TX_CAP)", () => {
    expectAllow(ev({ kind: "actionMint", target: CP, value: E18 / 5n }));
    expectDeny(ev({ kind: "actionMint", target: CP, value: E18 / 5n + 1n }), "PER_TX_CAP");
  });
});

// ---------------------------------------------------------------------------
// G3 for action kinds
// ---------------------------------------------------------------------------

describe("G3: action-wallet balances", () => {
  it("G3: actionTransfer amount > balance ⇒ INSUFFICIENT_BALANCE", () => {
    expectDeny(ev(xfer("USDG", CP, 1000n * E6 + 1n), { ledger: withAllowance() }), "INSUFFICIENT_BALANCE");
  });
  it("G3: actionTransfer token not held ⇒ INSUFFICIENT_BALANCE", () => {
    expectDeny(ev(xfer(addr("99999999", "99999999"), CP, 1n)), "INSUFFICIENT_BALANCE");
  });
  it("G3: USDG missing from action wallet ⇒ INSUFFICIENT_BALANCE", () => {
    const s = mkState();
    s.action.rh = { native: E18 };
    expectDeny(ev(xfer("USDG", CP, 1n), { state: s, ledger: withAllowance() }), "INSUFFICIENT_BALANCE");
  });
  it("G3: actionSwap tokenIn not held ⇒ INSUFFICIENT_BALANCE", () => {
    expectDeny(ev({ kind: "actionSwap", tokenIn: addr("99999999", "99999999"), tokenOut: "USDG", amountIn: 1n, minOut: 0n }), "INSUFFICIENT_BALANCE");
  });
  it("G3: actionLp token leg not held ⇒ INSUFFICIENT_BALANCE", () => {
    expectDeny(ev({ kind: "actionLp", pool: POOL, usdgAmount: E6, tokenAmount: 1n, token: addr("99999999", "99999999") }), "INSUFFICIENT_BALANCE");
  });
  it("G3: actionMint value > native ⇒ INSUFFICIENT_BALANCE", () => {
    expectDeny(ev({ kind: "actionMint", target: CP, value: E18 + 1n }), "INSUFFICIENT_BALANCE");
  });
  it("G3: balances on other chains of the action wallet are ignored (RH only)", () => {
    const s = mkState();
    s.action.rh = { native: 0n };
    s.action.base = { native: 100n * E18, USDG: 1_000_000n * E6 };
    expectDeny(ev(xfer("ETH", CP, 1n), { state: s }), "INSUFFICIENT_BALANCE");
  });
});

// ---------------------------------------------------------------------------
// A2 per-counterparty daily cap (actionTransfer only)
// ---------------------------------------------------------------------------

describe("A2: per-counterparty daily cap", () => {
  it("A2: USDG — spent 150 + 150 == 30% × allowanceAmountToday(1000) ⇒ allow", () => {
    const L = withAllowance({ counterpartySpent: { [CP]: { USDG: 150n * E6 } } });
    expectAllow(ev(xfer("USDG", CP, 150n * E6), { ledger: L }));
  });
  it("A2: USDG — spent 150 + 150.000001 ⇒ COUNTERPARTY_CAP", () => {
    const L = withAllowance({ counterpartySpent: { [CP]: { USDG: 150n * E6 } } });
    expectDeny(ev(xfer("USDG", CP, 150n * E6 + 1n), { ledger: L }), "COUNTERPARTY_CAP");
  });
  it("A2: USDG — another counterparty has its own bucket", () => {
    const L = withAllowance({ counterpartySpent: { [CP]: { USDG: 300n * E6 } } });
    expectDeny(ev(xfer("USDG", CP, 1n), { ledger: L }), "COUNTERPARTY_CAP");
    expectAllow(ev(xfer("USDG", CP2, 200n * E6), { ledger: L }));
  });
  it("A2: USDG — allowanceAmountToday = 0 ⇒ any USDG transfer is COUNTERPARTY_CAP", () => {
    expectDeny(ev(xfer("USDG", CP, 1n), { ledger: mkLedger({ allowanceAmountToday: 0n }) }), "COUNTERPARTY_CAP");
  });
  it("A2: USDG — stale dayKey resets allowanceAmountToday to 0 ⇒ COUNTERPARTY_CAP until today's allowance", () => {
    const L = withAllowance({ dayKey: "2026-09-22" });
    expectDeny(ev(xfer("USDG", CP, 1n), { ledger: L }), "COUNTERPARTY_CAP");
  });
  it("A2: USDG — counterparty key lookup is case-insensitive", () => {
    const L = withAllowance({ counterpartySpent: { [getAddress(CP)]: { USDG: 300n * E6 } } });
    expectDeny(ev(xfer("USDG", CP, 1n), { ledger: L }), "COUNTERPARTY_CAP");
    expectDeny(ev(xfer("USDG", getAddress(CP), 1n), { ledger: withAllowance({ counterpartySpent: { [CP]: { USDG: 300n * E6 } } }) }), "COUNTERPARTY_CAP");
  });
  it("A2: counterpartyPctBps comes from config", () => {
    const c = { ...cfg, counterpartyPctBps: 1000 };
    expectAllow(ev(xfer("USDG", CP, 100n * E6), { cfg: c, ledger: withAllowance() }));
    expectDeny(ev(xfer("USDG", CP, 100n * E6 + 1n), { cfg: c, ledger: withAllowance() }), "COUNTERPARTY_CAP");
  });

  it("A2: ETH without snapshot — denominator = current balance (1 ETH ⇒ 0.3): 0.2 + 0.1 allow, +1 wei deny", () => {
    const L0 = mkLedger({ counterpartySpent: { [CP]: { ETH: 2n * 10n ** 17n } } });
    expectAllow(ev(xfer("ETH", CP, 10n ** 17n), { ledger: L0 }));
    expectDeny(ev(xfer("ETH", CP, 10n ** 17n + 1n), { ledger: L0 }), "COUNTERPARTY_CAP");
  });
  it("A2: ETH with snapshot — denominator = snapshot (0.5 ETH ⇒ 0.15) even though balance is 1 ETH", () => {
    const L = mkLedger({ counterpartySpent: { [CP]: { ETH: 10n ** 17n, "ETH:denom": 5n * 10n ** 17n } } });
    expectAllow(ev(xfer("ETH", CP, 5n * 10n ** 16n), { ledger: L }));
    expectDeny(ev(xfer("ETH", CP, 5n * 10n ** 16n + 1n), { ledger: L }), "COUNTERPARTY_CAP");
  });
  it("A2: token — asset key is the lowercased token address; snapshot honoured", () => {
    const k = TOKEN_X.toLowerCase();
    const L = mkLedger({ counterpartySpent: { [CP]: { [k]: 10n * E18, [`${k}:denom`]: 100n * E18 } } });
    // cap = 30% × 100 = 30 ⇒ 10 spent + 20 allow, +1 deny
    expectAllow(ev(xfer(TOKEN_X, CP, 20n * E18), { ledger: L }));
    expectDeny(ev(xfer(TOKEN_X, CP, 20n * E18 + 1n), { ledger: L }), "COUNTERPARTY_CAP");
    expectDeny(ev(xfer(getAddress(TOKEN_X), CP, 20n * E18 + 1n), { ledger: L }), "COUNTERPARTY_CAP");
  });
  it("A2: token without snapshot — denominator = current token balance (500 ⇒ 150)", () => {
    const k = TOKEN_X.toLowerCase();
    const L = mkLedger({ counterpartySpent: { [CP]: { [k]: 60n * E18 } } });
    expectAllow(ev(xfer(TOKEN_X, CP, 90n * E18), { ledger: L }));
    expectDeny(ev(xfer(TOKEN_X, CP, 90n * E18 + 1n), { ledger: L }), "COUNTERPARTY_CAP");
  });
  it("A2: buckets are per asset (ETH spent does not count against TOKEN_Y)", () => {
    const L = mkLedger({ counterpartySpent: { [CP]: { ETH: 3n * 10n ** 17n } } });
    expectDeny(ev(xfer("ETH", CP, 1n), { ledger: L }), "COUNTERPARTY_CAP");
    expectAllow(ev(xfer(TOKEN_Y, CP, 100n * E18), { ledger: L }));
  });
  it("A2: stale dayKey — yesterday's ETH spend and snapshot are ignored", () => {
    const L = mkLedger({ dayKey: "2026-09-22", counterpartySpent: { [CP]: { ETH: 3n * 10n ** 17n, "ETH:denom": 1n } } });
    expectAllow(ev(xfer("ETH", CP, 2n * 10n ** 17n), { ledger: L }));
  });
  it("A2: swaps / LP / mints are exempt (huge counterparty spend recorded, still allowed)", () => {
    const big = { USDG: 10n ** 30n, ETH: 10n ** 30n, [TOKEN_X.toLowerCase()]: 10n ** 30n };
    const L = mkLedger({ counterpartySpent: { [CP]: big, [cfg.poolManager.rh.toLowerCase()]: big } });
    expectAllow(ev({ kind: "actionSwap", tokenIn: "USDG", tokenOut: TOKEN_X, amountIn: E6, minOut: 0n }, { ledger: L }));
    expectAllow(ev({ kind: "actionLp", pool: POOL, usdgAmount: E6, tokenAmount: E18, token: TOKEN_X }, { ledger: L }));
    expectAllow(ev({ kind: "actionMint", target: CP, value: 1n }, { ledger: L }));
  });
});

// ---------------------------------------------------------------------------
// A3 look-alike guard
// ---------------------------------------------------------------------------

describe("A3: look-alike guard", () => {
  const PROTECTED: Array<[string, Address]> = [
    ["own treasury EOA", TREASURY],
    ["marlin payment #1", MARLIN_PAY],
    ["marlin payment #2", MARLIN_PAY2],
    ["spokePool rh", SPOKE.rh],
    ["spokePool base", SPOKE.base],
    ["spokePool arbitrum", SPOKE.arbitrum],
    ["spokePool optimism", SPOKE.optimism],
    ["arweave funding", ARWEAVE],
    ["x402 inference payTo (cheap)", PAYTO_INF_CHEAP],
    ["x402 inference payTo (standard)", PAYTO_INF_STD],
    ["x402 data payTo", PAYTO_DATA],
  ];

  it("A3: protected set = T2 destinations + treasury + spokePools + marlin + payTos, excluding own action EOA", () => {
    const set = protectedAddresses(cfg);
    for (const [, p] of PROTECTED) expect(set).toContain(p.toLowerCase());
    expect(set).not.toContain(ACTION.toLowerCase());
    expect(set.length).toBe(PROTECTED.length);
  });

  for (const [name, p] of PROTECTED) {
    it(`A3: actionTransfer exact ${name} ⇒ LOOKALIKE`, () => {
      expectDeny(ev(xfer("ETH", p, 1n)), "LOOKALIKE");
    });
    it(`A3: actionTransfer checksummed ${name} ⇒ LOOKALIKE`, () => {
      expectDeny(ev(xfer("ETH", getAddress(p), 1n)), "LOOKALIKE");
    });
    it(`A3: actionMint target exact ${name} ⇒ LOOKALIKE`, () => {
      expectDeny(ev({ kind: "actionMint", target: p, value: 1n }), "LOOKALIKE");
    });
  }

  // MARLIN_PAY = 0xbb000001 …(24 zeros)… 000000b1
  const prefixOnly = addr("bb000001", "deadbeef", "5");
  const suffixOnly = addr("deadbeef", "000000b1", "5");
  const prefix3 = addr("bb000099", "deadbeef", "5"); // first 3 bytes equal, 4th differs
  const suffix3 = addr("deadbeef", "990000b1", "5"); // last 3 bytes equal, 4th-from-last differs
  const nearMissPrefix = addr("bb000000", "deadbeef", "5"); // differs only in the 8th hex char
  const nearMissSuffix = addr("deadbeef", "100000b1", "5"); // differs only in the 1st hex char of the last 4 bytes

  const lookalikes: Array<[string, Address]> = [
    ["prefix-only (first 4 bytes of marlin payment)", prefixOnly],
    ["suffix-only (last 4 bytes of marlin payment)", suffixOnly],
    ["prefix-only, checksummed", getAddress(prefixOnly)],
    ["prefix of own treasury", addr("aa000001", "deadbeef", "5")],
    ["suffix of spokePool.optimism", addr("deadbeef", "000000c4", "5")],
  ];
  for (const [name, a] of lookalikes) {
    it(`A3: actionTransfer ${name} ⇒ LOOKALIKE`, () => expectDeny(ev(xfer("ETH", a, 1n)), "LOOKALIKE"));
    it(`A3: actionMint target ${name} ⇒ LOOKALIKE`, () => expectDeny(ev({ kind: "actionMint", target: a, value: 1n }), "LOOKALIKE"));
  }

  const safe: Array<[string, Address]> = [
    ["3-byte prefix match", prefix3],
    ["3-byte suffix match", suffix3],
    ["near-miss prefix (7 of 8 hex chars)", nearMissPrefix],
    ["near-miss suffix (7 of 8 hex chars)", nearMissSuffix],
    ["unrelated counterparty", CP],
  ];
  for (const [name, a] of safe) {
    it(`A3: actionTransfer ${name} ⇒ allow`, () => expectAllow(ev(xfer("ETH", a, 1n))));
    it(`A3: actionMint target ${name} ⇒ allow`, () => expectAllow(ev({ kind: "actionMint", target: a, value: 1n })));
  }

  it("A3: lookalikeOf reports the colliding protected address", () => {
    expect(lookalikeOf(prefixOnly, protectedAddresses(cfg))).toBe(MARLIN_PAY.toLowerCase());
    expect(lookalikeOf(prefix3, protectedAddresses(cfg))).toBeNull();
  });
  it("A3: own action EOA self-send is allowed when caps pass", () => {
    expectAllow(ev(xfer("ETH", ACTION, 1n)));
    expectAllow(ev(xfer("USDG", ACTION, E6), { ledger: withAllowance() }));
  });
  it("A3: LOOKALIKE is reported before balance/cap checks", () => {
    expectDeny(ev(xfer("ETH", TREASURY, 100n * E18)), "LOOKALIKE");
  });
});

// ---------------------------------------------------------------------------
// A4 swap / LP / mint / chain
// ---------------------------------------------------------------------------

describe("A4: swaps, LP, mints, chain binding", () => {
  it("A4: USDG → token swap ⇒ allow (minOut 0 accepted as given)", () => {
    expectAllow(ev({ kind: "actionSwap", tokenIn: "USDG", tokenOut: TOKEN_X, amountIn: E6, minOut: 0n }));
  });
  it("A4: token → USDG swap ⇒ allow", () => {
    expectAllow(ev({ kind: "actionSwap", tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: E18, minOut: 5n }));
  });
  it("A4: token → token (both RH tokens) ⇒ allow", () => {
    expectAllow(ev({ kind: "actionSwap", tokenIn: TOKEN_X, tokenOut: TOKEN_Y, amountIn: E18, minOut: 0n }));
  });
  it("A4: tokenIn == tokenOut ⇒ NO_RULE (also across casing)", () => {
    expectDeny(ev({ kind: "actionSwap", tokenIn: TOKEN_X, tokenOut: getAddress(TOKEN_X), amountIn: E18, minOut: 0n }), "NO_RULE");
    expectDeny(ev({ kind: "actionSwap", tokenIn: "USDG", tokenOut: "USDG", amountIn: E6, minOut: 0n }), "NO_RULE");
  });
  it("A4: USDG referenced by token address in swap/LP/transfer ⇒ NO_RULE", () => {
    expectDeny(ev({ kind: "actionSwap", tokenIn: USDG_RH, tokenOut: TOKEN_X, amountIn: E6, minOut: 0n }), "NO_RULE");
    expectDeny(ev({ kind: "actionSwap", tokenIn: TOKEN_X, tokenOut: getAddress(USDG_RH), amountIn: E18, minOut: 0n }), "NO_RULE");
    expectDeny(ev({ kind: "actionLp", pool: POOL, usdgAmount: E6, tokenAmount: E6, token: USDG_RH }), "NO_RULE");
    const s = mkState();
    s.action.rh = { ...s.action.rh, tokens: { [USDG_RH]: 1000n * E6 } };
    expectDeny(ev(xfer(USDG_RH, CP, E6), { state: s, ledger: withAllowance() }), "NO_RULE");
  });
  it("A4: actionLp USDG/token ⇒ allow", () => {
    expectAllow(ev({ kind: "actionLp", pool: POOL, usdgAmount: E6, tokenAmount: E18, token: TOKEN_Y }));
  });
  it("A4: actionMint value within A1 cap and target passing A3 ⇒ allow", () => {
    expectAllow(ev({ kind: "actionMint", target: CP2, value: E18 / 10n }));
  });
  it("A4/CHAIN: no action-wallet kind can carry a chain (executors bind to RH); a chain field is MALFORMED", () => {
    for (const opt of ProposedActionSchema.options) {
      const kind = opt.shape.kind.value;
      if (kind.startsWith("action")) expect(Object.keys(opt.shape)).not.toContain("chain");
    }
    expectDeny(ev({ ...xfer("ETH", CP, 1n), chain: "base" } as unknown as ProposedAction), "MALFORMED");
  });
});
