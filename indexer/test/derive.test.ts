import { describe, expect, it } from "vitest";
import {
  derivePrice,
  feeTotals,
  formatFixed,
  mcapUsdg,
  priceFromCurveTrade,
  priceFromSqrtPriceX96,
  status,
  volume24h,
} from "../src/derive.js";

const WINDOW = 604_800n;
const STALE = 1800n;
const NOW = 1_790_000_000n;

describe("status", () => {
  it("pending without an instance (or an unregistered zero struct)", () => {
    expect(status(null, NOW, WINDOW, STALE)).toBe("pending");
    expect(status(undefined, NOW, WINDOW, STALE)).toBe("pending");
    expect(status({ lastHeartbeat: 0 }, NOW, WINDOW, STALE)).toBe("pending");
  });
  it("live ≤ staleAfterSec, stale ≤ REVIVAL_WINDOW, evicted beyond (boundaries inclusive like the registry)", () => {
    expect(status({ lastHeartbeat: NOW }, NOW, WINDOW, STALE)).toBe("live");
    expect(status({ lastHeartbeat: NOW - STALE }, NOW, WINDOW, STALE)).toBe("live");
    expect(status({ lastHeartbeat: NOW - STALE - 1n }, NOW, WINDOW, STALE)).toBe("stale");
    expect(status({ lastHeartbeat: Number(NOW - WINDOW) }, NOW, WINDOW, STALE)).toBe("stale");
    expect(status({ lastHeartbeat: NOW - WINDOW - 1n }, NOW, WINDOW, STALE)).toBe("evicted");
  });
  it("a heartbeat in the future (clock skew) is live", () => {
    expect(status({ lastHeartbeat: NOW + 60n }, NOW, WINDOW, STALE)).toBe("live");
  });
});

describe("price from sqrtPriceX96 (golden values, independently computed)", () => {
  it("sqrtP = 2^96 ⇒ raw price 1 ⇒ 1e12 USDG per whole token (18 vs 6 decimals), either side", () => {
    const one = 1n << 96n;
    expect(priceFromSqrtPriceX96(one, true)).toBe(10n ** 30n);
    expect(priceFromSqrtPriceX96(one, false)).toBe(10n ** 30n);
  });
  it("agent token = currency0: price = sqrtP² × 1e30 / 2^192", () => {
    // isqrt(2^192 × 5e-16) — 0.0005 USDG/token, floor-rounded through the integer sqrt.
    const p = priceFromSqrtPriceX96(1771595571142957102961n, true)!;
    expect(p).toBe(499_999_999_999_999n);
    expect(formatFixed(p, 18)).toBe("0.000499999999999999");
  });
  it("agent token = currency1: price = 2^192 × 1e30 / sqrtP²", () => {
    // isqrt(2^192 × 2e15) — 2e15 raw tokens per raw USDG = 0.0005 USDG/token.
    const p = priceFromSqrtPriceX96(3543191142285914205922034323214520130n, false)!;
    expect(p).toBe(500_000_000_000_000n);
    expect(formatFixed(p, 18)).toBe("0.0005");
  });
  it("zero price ⇒ null", () => {
    expect(priceFromSqrtPriceX96(0n, true)).toBeNull();
  });
});

describe("curve price + precedence", () => {
  it("usdg / tokens (1 USDG → 2204.007 tokens)", () => {
    expect(priceFromCurveTrade(1_000_000n, 2_204_007_000_000_000_000_000n)).toBe(453_719_067_135_449n);
    expect(priceFromCurveTrade(1n, 0n)).toBeNull();
  });
  it("latest pool swap wins; curve trade is the fallback; neither ⇒ null", () => {
    const swap = { sqrtPriceX96: 1n << 96n, agentIsCurrency0: true };
    const trade = { usdg: 1_000_000n, tokens: 2_000_000_000_000_000_000_000n };
    expect(derivePrice(swap, trade)).toEqual({ priceE18: 10n ** 30n, source: "pool" });
    expect(derivePrice(null, trade)).toEqual({ priceE18: 500_000_000_000_000n, source: "curve" });
    expect(derivePrice({ sqrtPriceX96: 0n, agentIsCurrency0: true }, trade)?.source).toBe("curve");
    expect(derivePrice(undefined, undefined)).toBeNull();
  });
});

describe("volume24h", () => {
  it("sums |USDG side| of swaps (side by pool ordering) + curve USDG legs inside (now−24h, now]", () => {
    const swaps = [
      { ts: NOW - 10n, amount0: -2_204_007_000_000_000_000_000n, amount1: 1_000_000n, agentIsCurrency0: true }, // USDG = amount1
      { ts: NOW - 20n, amount0: -3_000_000n, amount1: 5n, agentIsCurrency0: false }, // USDG = amount0 (abs)
      { ts: NOW - 86_400n, amount0: 0n, amount1: 999_999_999n, agentIsCurrency0: true }, // exactly 24h old: out
      { ts: NOW + 1n, amount0: 0n, amount1: 999n, agentIsCurrency0: true }, // future: out
    ];
    const trades = [
      { ts: NOW - 86_399n, usdg: 7_000_000n },
      { ts: NOW - 90_000n, usdg: 1n },
    ];
    expect(volume24h(swaps, trades, NOW)).toBe(1_000_000n + 3_000_000n + 7_000_000n);
    expect(volume24h([], [], NOW)).toBe(0n);
  });
});

describe("mcap + fee totals + formatting", () => {
  it("mcap = priceE18 × totalSupply → USDG base units", () => {
    // 0.0005 USDG × 1e9 tokens = 500 000 USDG = 5e11 base units.
    expect(mcapUsdg(500_000_000_000_000n, 1_000_000_000n * 10n ** 18n)).toBe(500_000n * 10n ** 6n);
  });
  it("feeTotals sums each leg", () => {
    expect(
      feeTotals([
        { buybackLeg: 1n, treasuryLeg: 2n, royaltyLeg: 3n, converted: 4n },
        { buybackLeg: 10n, treasuryLeg: 20n, royaltyLeg: 30n, converted: 40n },
      ]),
    ).toEqual({ buybackLeg: 11n, treasuryLeg: 22n, royaltyLeg: 33n, converted: 44n, count: 2 });
  });
  it("formatFixed trims trailing zeros", () => {
    expect(formatFixed(1_500_000n, 6)).toBe("1.5");
    expect(formatFixed(2_000_000n, 6)).toBe("2");
    expect(formatFixed(5n, 6)).toBe("0.000005");
    expect(formatFixed(-1_500_000n, 6)).toBe("-1.5");
  });
});
