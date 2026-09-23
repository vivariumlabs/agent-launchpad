// Shared fixtures for policy/ledger unit tests. Not a test file (no .test.ts).

import type { Address } from "viem";
import { resolveConfig, type ResolvedConfig } from "../../src/config/schema.js";
import { emptyLedger } from "../../src/ledger/ledger.js";
import { evaluate } from "../../src/policy/engine.js";
import type { BudgetLedger, DenyCode, ProposedAction, Verdict, WalletBalances, WalletState } from "../../src/policy/types.js";
import { expect } from "vitest";

/** 20-byte lowercase address from an 8-hex prefix (first 4 bytes) and 8-hex suffix (last 4 bytes). */
export function addr(prefix8: string, suffix8: string, middle = "0"): Address {
  if (prefix8.length !== 8 || suffix8.length !== 8) throw new Error("addr: need 8 hex chars each side");
  return `0x${prefix8}${middle.repeat(24)}${suffix8}` as Address;
}

// Own EOAs
export const TREASURY = addr("aa000001", "000000a1");
export const ACTION = addr("aa000002", "000000a2");
// Platform
export const MARLIN_PAY = addr("bb000001", "000000b1");
export const MARLIN_PAY2 = addr("bb000002", "000000b2");
export const SPOKE = {
  rh: addr("cc000001", "000000c1"),
  base: addr("cc000002", "000000c2"),
  arbitrum: addr("cc000003", "000000c3"),
  optimism: addr("cc000004", "000000c4"),
} as const;
export const ARWEAVE = addr("dd000001", "000000d1");
export const PAYTO_INF_CHEAP = addr("ee000001", "000000e1");
export const PAYTO_INF_STD = addr("ee000002", "000000e2");
export const PAYTO_DATA = addr("ee000003", "000000e3");
export const USDG_RH = addr("f4000001", "000000f4");
// Counterparties / tokens
export const CP = addr("12345678", "87654321");
export const CP2 = addr("23456789", "98765432");
export const TOKEN_X = addr("7070aaaa", "7070bbbb");
export const TOKEN_Y = addr("7171aaaa", "7171bbbb");
// SPEC-M2B §9 fixture addresses
export const SWAP_ROUTER = addr("5a000001", "000005a1");
export const USDC = {
  rh: addr("5c000001", "000005c1"),
  base: addr("5c000002", "000005c2"),
  arbitrum: addr("5c000003", "000005c3"),
  optimism: addr("5c000004", "000005c4"),
} as const;
export const WETH = {
  rh: addr("5e000001", "000005e1"),
  base: addr("5e000002", "000005e2"),
  arbitrum: addr("5e000003", "000005e3"),
  optimism: addr("5e000004", "000005e4"),
} as const;
export const USDC_BASE_DOMAIN = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC.base } as const;
export const AGENT_TOKEN = TOKEN_X;
export const AGENT_POOL_ID = `0x${"9d".repeat(32)}` as `0x${string}`;
export const CODE_HASH = `0x${"c0de".repeat(16)}` as `0x${string}`;

export const DAY = 86_400n;
/** 2026-09-23T00:00:00Z */
export const DAY0 = 1_790_121_600n;
/** 2026-09-23T12:00:00Z */
export const NOW = DAY0 + 43_200n;

export const E6 = 1_000_000n;
export const E18 = 10n ** 18n;

function chainMap(p: string): Record<"rh" | "base" | "arbitrum" | "optimism", Address> {
  return {
    rh: addr(p + "01", "000000" + "01"),
    base: addr(p + "02", "000000" + "02"),
    arbitrum: addr(p + "03", "000000" + "03"),
    optimism: addr(p + "04", "000000" + "04"),
  };
}

export function platformJson(capsOverride: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    registry: chainMap("f10000"),
    feeSplitHook: chainMap("f20000"),
    poolManager: chainMap("f30000"),
    usdg: { rh: USDG_RH, base: addr("f4000002", "000000f5"), arbitrum: addr("f4000003", "000000f6"), optimism: addr("f4000004", "000000f7") },
    across: { spokePool: SPOKE },
    marlin: { paymentAddresses: [MARLIN_PAY, MARLIN_PAY2] },
    arweaveFundingAddress: ARWEAVE,
    x402Allowlist: [
      { id: "inf-cheap", kind: "inference", operator: "op", url: "https://a", payTo: PAYTO_INF_CHEAP, model: "m1", tier: "cheap", maxPricePerMTokUsd: "1000000", attested: false },
      { id: "inf-std", kind: "inference", operator: "op", url: "https://b", payTo: PAYTO_INF_STD, model: "m2", tier: "standard", maxPricePerMTokUsd: "5000000", attested: false },
      { id: "data-1", kind: "data", operator: "op", url: "https://c", payTo: PAYTO_DATA, model: "search", tier: "cheap", maxPricePerMTokUsd: "1000000", attested: false },
    ],
    caps: capsOverride,
    // SPEC-M2B §9
    usdc: USDC,
    weth: WETH,
    chainIds: { rh: 46630 },
    swapRouter: { rh: SWAP_ROUTER },
    usdcDomain: { base: USDC_BASE_DOMAIN },
    agentTokenAddress: AGENT_TOKEN,
    agentPoolId: AGENT_POOL_ID,
    registration: { codeHash: CODE_HASH, attestationRef: "mock-attestation" },
  };
}

export const agentJson = {
  agentId: 1,
  name: "Test Agent",
  symbol: "TEST",
  archetype: "trader",
  persona: "test",
  models: { primary: "m1", fallbacks: [], chatTier: "cheap" },
  social: { postsPerDay: 1, repliesPerDay: 1 },
};

export function mkCfg(capsOverride: Record<string, unknown> = {}): ResolvedConfig {
  return resolveConfig({
    platform: platformJson(capsOverride),
    agent: agentJson,
    ownAddresses: { treasury: TREASURY, action: ACTION },
  });
}

function emptyWallet(): WalletBalances {
  return {
    rh: { native: 0n },
    base: { native: 0n },
    arbitrum: { native: 0n },
    optimism: { native: 0n },
  };
}

/**
 * Default: treasury 10_000 USDG on rh, 200 USDC arbitrum, 50 USDC base,
 * 0.1 ETH on every chain, 1000 TOKEN_X on rh; action wallet 1000 USDG,
 * 1 ETH, 500 TOKEN_X, 500 TOKEN_Y on rh; hosting $1.70/day paid 30d ahead.
 */
export function mkState(over: Partial<WalletState> = {}): WalletState {
  const t = emptyWallet();
  t.rh = { native: E18 / 10n, USDG: 10_000n * E6, tokens: { [TOKEN_X]: 1000n * E18 } };
  t.arbitrum = { native: E18 / 10n, USDC: 200n * E6 };
  t.base = { native: E18 / 10n, USDC: 50n * E6 };
  t.optimism = { native: E18 / 10n };
  const a = emptyWallet();
  a.rh = { native: E18, USDG: 1000n * E6, tokens: { [TOKEN_X]: 500n * E18, [TOKEN_Y]: 500n * E18 } };
  return {
    treasury: t,
    action: a,
    hostingPaidUntil: NOW + 30n * DAY,
    hostingRatePerDay: 1_700_000n,
    ...over,
  };
}

/** State with runway configurable precisely: all fundable in arbitrum USDC, 0 rh USDG, paidUntil = now. */
export function mkRunwayState(arbUsdc: bigint, rhUsdg = 0n, paidUntil = NOW, rate = 1_700_000n): WalletState {
  const s = mkState({ hostingPaidUntil: paidUntil, hostingRatePerDay: rate });
  s.treasury.arbitrum = { ...s.treasury.arbitrum, USDC: arbUsdc };
  s.treasury.rh = { ...s.treasury.rh, USDG: rhUsdg };
  return s;
}

/** Default ledger: today, no spend, feeIncome7d = 7 × 100 USDG ⇒ I1 budget B = 25 USDG. */
export function mkLedger(over: Partial<BudgetLedger> = {}): BudgetLedger {
  return { ...emptyLedger(NOW), feeIncome7d: Array.from({ length: 7 }, () => 100n * E6), ...over };
}

export const cfg = mkCfg();

export function ev(
  action: ProposedAction,
  opts: { state?: WalletState; ledger?: BudgetLedger; cfg?: ResolvedConfig; now?: bigint } = {},
): Verdict {
  return evaluate(action, opts.state ?? mkState(), opts.ledger ?? mkLedger(), opts.cfg ?? cfg, opts.now ?? NOW);
}

export function expectAllow(v: Verdict): void {
  if (!v.allow) throw new Error(`expected allow, got deny ${v.code}: ${v.detail}`);
  expect(v.allow).toBe(true);
}

export function expectDeny(v: Verdict, code: DenyCode): void {
  if (v.allow) throw new Error(`expected deny ${code}, got allow`);
  expect(v.code, v.detail).toBe(code);
  expect(v.detail.length).toBeGreaterThan(0);
}

/** Cast helper for deliberately malformed inputs (tests only). */
export function raw(x: unknown): ProposedAction {
  return x as ProposedAction;
}
