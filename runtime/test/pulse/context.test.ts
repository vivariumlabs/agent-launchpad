// SPEC-M2B §6 step 1: deterministic context bundle, full/trimmed/minimal levels.

import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { insertAction, insertChat, insertTrade, kvSet, openMemory, rollingSummarySet, type MemoryDb } from "../../src/memory/db.js";
import { CONTEXT_LIMITS, buildContext, buildPrompt, renderContext, type ContextLevel, type ContextSources } from "../../src/pulse/context.js";
import { toolSchemaFor } from "../../src/pulse/tools.js";
import { E6, NOW, TOKEN_X, TOKEN_Y, addr, cfg, mkLedger, mkState } from "../policy/helpers.js";

const WATCH: Address[] = Array.from({ length: 10 }, (_, i) => addr(`abcd00${i.toString().padStart(2, "0")}`, `0000ab${i.toString().padStart(2, "0")}`));

function seed(): MemoryDb {
  const db = openMemory(":memory:");
  for (let i = 0; i < 30; i++) {
    insertAction(db, { ts: NOW - 1000n + BigInt(i), kind: "actionTransfer", json: `{"i":${i}}`, verdict: i % 2 === 0 ? "allow" : "deny", denyCode: i % 2 === 0 ? null : "PER_TX_CAP", error: null });
  }
  for (let i = 0; i < 8; i++) insertChat(db, { ts: NOW - 500n + BigInt(i), wallet: CPW, dir: "summary", content: `summary ${i}` });
  insertChat(db, { ts: NOW, wallet: CPW, dir: "in", content: "raw chat, not a summary" });
  insertTrade(db, { ts: NOW - 10n, token: TOKEN_X, side: "buy", amountIn: 5n * E6, amountOut: 1n, pnlUsdg: 2n * E6 });
  insertTrade(db, { ts: NOW - 5n, token: TOKEN_X, side: "sell", amountIn: 1n, amountOut: 1n, pnlUsdg: -1n * E6 });
  kvSet(db, "watchlist", JSON.stringify(WATCH));
  rollingSummarySet(db, "I am a test agent.");
  return db;
}
const CPW = "0x1111111111111111111111111111111111111111";

const sources: ContextSources = {
  market: { snapshot: async (tokens) => [...tokens].reverse().map((t, i) => ({ token: t, priceUsdg: BigInt(i + 1), volume24hUsdg: 10n })) },
  mentions: {
    unread: async () =>
      Array.from({ length: 12 }, (_, i) => ({ hash: `0x${i.toString(16).padStart(2, "0")}`, author: "@bob", text: `hey ${i}`, ts: NOW - BigInt(100 - i) })).reverse(),
  },
  registry: { recent: async () => [{ name: "Heartbeat", ts: NOW - 1n, data: "{}" }] },
};

async function ctx(db: MemoryDb, level: ContextLevel) {
  return buildContext({ db, state: mkState(), ledger: mkLedger({ inferenceSpent: { pulse: 3n * E6, chat: 0n, social: 0n } }), cfg, now: NOW, tier: "Active", level, sources });
}

describe("context bundle", () => {
  it("deterministic: same inputs ⇒ byte-identical render (independent DBs, repeated builds)", async () => {
    const a = renderContext(await ctx(seed(), "full"));
    const b = renderContext(await ctx(seed(), "full"));
    expect(a).toBe(b);
    const db = seed();
    expect(renderContext(await ctx(db, "full"))).toBe(renderContext(await ctx(db, "full")));
    const t = toolSchemaFor("Active");
    expect(buildPrompt(cfg, await ctx(db, "full"), t)).toEqual(buildPrompt(cfg, await ctx(db, "full"), t));
  });

  for (const level of ["full", "trimmed", "minimal"] as const) {
    it(`${level}: limits actions/watchlist/chat summaries = ${JSON.stringify(CONTEXT_LIMITS[level])}`, async () => {
      const b = await ctx(seed(), level);
      const lim = CONTEXT_LIMITS[level];
      expect(b.level).toBe(level);
      expect(b.recentActions).toHaveLength(lim.actions);
      expect(b.recentActions.at(-1)!.json).toBe('{"i":29}'); // trailing = most recent
      expect(b.watchlist).toEqual(WATCH.slice(0, lim.watchlist).map((w) => w.toLowerCase()));
      expect(b.chatSummaries).toEqual(Array.from({ length: 8 }, (_, i) => `summary ${i}`).slice(8 - lim.chats));
      // market = own token + watchlist (level-limited)
      expect(b.market).toHaveLength(1 + lim.watchlist);
    });
  }

  it("limits: 20/8/3, 10/3/0, 5/2/0", () => {
    expect(CONTEXT_LIMITS).toEqual({
      full: { actions: 20, watchlist: 10, chats: 5 },
      trimmed: { actions: 8, watchlist: 3, chats: 2 },
      minimal: { actions: 3, watchlist: 0, chats: 0 },
    });
  });

  it("content: budget, runway, positions + P&L, deny reasons, mentions (≤10, oldest dropped), self-summary", async () => {
    const b = await ctx(seed(), "full");
    expect(b.budget).toEqual({ pulseBudget: "15000000", pulseSpent: "3000000", pulseRemaining: "12000000" });
    expect(BigInt(b.runwayDays) > 45n).toBe(true);
    const x = b.positions.find((p) => p.token === TOKEN_X.toLowerCase())!;
    expect(x).toEqual({ token: TOKEN_X.toLowerCase(), balance: (500n * 10n ** 18n).toString(), trades: 2, pnlUsdg: "1000000" });
    expect(b.positions.find((p) => p.token === TOKEN_Y.toLowerCase())?.trades).toBe(0);
    expect(b.recentActions.some((a) => a.denyCode === "PER_TX_CAP")).toBe(true);
    expect(b.mentions).toHaveLength(10);
    expect(b.mentions[0]!.text).toBe("hey 2");
    expect(b.selfSummary).toBe("I am a test agent.");
    expect(b.registryEvents).toEqual([{ name: "Heartbeat", ts: (NOW - 1n).toString(), data: "{}" }]);
    expect(b.market.map((m) => m.token)).toEqual([...b.market.map((m) => m.token)].sort());
  });

  it("minimal context renders shorter than full (cheaper pulse under budget pressure)", async () => {
    const db = seed();
    expect(renderContext(await ctx(db, "minimal")).length).toBeLessThan(renderContext(await ctx(db, "trimmed")).length);
    expect(renderContext(await ctx(db, "trimmed")).length).toBeLessThan(renderContext(await ctx(db, "full")).length);
  });
});
