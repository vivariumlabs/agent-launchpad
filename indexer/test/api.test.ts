import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IndexerApi, type AgentView } from "../src/api.js";
import { IndexerDb } from "../src/db.js";
import { memoryLogger } from "../src/log.js";
import { CURSOR_KEY, HEAD_KEY, LAST_POLL_KEY, REVIVAL_WINDOW_KEY } from "../src/watcher.js";

const NOW = 1_790_000_000;
let dir: string;
let db: IndexerDb;
let server: Server;
let base: string;

const P7 = `0x${"7".repeat(64)}`;

function seed(d: IndexerDb): void {
  d.kvSet(CURSOR_KEY, "1001");
  d.kvSet(HEAD_KEY, "1010");
  d.kvSet(LAST_POLL_KEY, String(NOW - 2));
  d.kvSet(REVIVAL_WINDOW_KEY, "604800");
  // agent 7: live, graduated pool (agent token = currency0), fresh heartbeat
  d.upsertAgentRequested({ agentId: 7, configHash: "0xcfg", creator: "0xCreator", requestTx: "0xreq7", requestBlock: 100, createdAt: NOW - 86_400, name: "Seven", symbol: "AGENT1", imageURI: "ar://7" });
  d.markAgentLive({ agentId: 7, token: "0xToken7", curve: "0xCurve7", totalSupply: (1_000_000_000n * 10n ** 18n).toString(), name: null, symbol: null, imageURI: null });
  d.upsertPool({ poolId: P7, agentId: 7, agentToken: "0xToken7", agentIsCurrency0: 1 });
  d.setAgentPool(7, P7);
  d.upsertInstanceRegistered({ agentId: 7, treasuryEOA: "0xTreas7", actionEOA: "0xAction7", codeHash: "0xcode", generation: 1, attestationRef: "att7", registeredAt: NOW - 600 });
  d.insertSwap({ txHash: "0xswap", logIndex: 1, poolId: P7, agentId: 7, ts: NOW - 60, blockNumber: 990, amount0: "-2204007000000000000000", amount1: "1000000", sqrtPriceX96: "1771595571142957102961" });
  d.insertCurveTrade({ txHash: "0xbuy", logIndex: 0, agentId: 7, side: "buy", trader: "0xT", usdg: "5000000", tokens: "1", fee: "0", ts: NOW - 3600, blockNumber: 500 });
  d.insertFee({ txHash: "0xfee", logIndex: 0, agentId: 7, poolId: P7, buybackLeg: "10", treasuryLeg: "11", royaltyLeg: "12", converted: "3", ts: NOW - 30, blockNumber: 995 });
  d.upsertBalances({ agentId: 7, treasuryUsdg: "12345678", treasuryRhEth: "1000", actionUsdg: "4275000", actionRhEth: "2000", actionToken: "2204007000000000000000", updatedAt: NOW - 5 });
  for (let i = 0; i < 250; i++) d.insertEvent({ agentId: 7, kind: "heartbeat", txHash: `0xhb${i}`, logIndex: 0, blockNumber: 100 + i, ts: NOW - 1000 + i, data: JSON.stringify({ timestamp: String(NOW - 1000 + i) }) });
  d.insertJournal({ itemId: "a".repeat(43), agentId: 7, ts: NOW - 100, kind: "journal", text: "older", raw: "{}", fetchedAt: NOW, owner: "OWNER", unverified: 0, blockHeight: 10 });
  d.insertJournal({ itemId: "b".repeat(43), agentId: 7, ts: NOW - 10, kind: "journal", text: "newer", raw: "{}", fetchedAt: NOW, owner: "OWNER", unverified: 1, blockHeight: null });
  // agent 5: cancelled, never registered
  d.upsertAgentRequested({ agentId: 5, configHash: "0xcfg5", creator: "0xCreator", requestTx: "0xreq5", requestBlock: 90, createdAt: NOW - 90_000, name: "Five", symbol: "FIVE", imageURI: null });
  d.advanceState(5, "cancelled");
  // agent 3: live on the curve only, heartbeat 8 days old ⇒ evicted
  d.markAgentLive({ agentId: 3, token: "0xToken3", curve: "0xCurve3", totalSupply: (10n ** 27n).toString(), name: "Three", symbol: "THR", imageURI: null });
  d.upsertInstanceRegistered({ agentId: 3, treasuryEOA: "0xTreas3", actionEOA: "0xAction3", codeHash: "0xcode", generation: 1, attestationRef: null, registeredAt: NOW - 8 * 86_400 });
  d.insertCurveTrade({ txHash: "0xbuy3", logIndex: 0, agentId: 3, side: "buy", trader: "0xT", usdg: "1000000", tokens: "2204007000000000000000", fee: "0", ts: NOW - 100_000, blockNumber: 50 });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "indexer-api-"));
  db = new IndexerDb(join(dir, "api.sqlite"));
  seed(db);
  const api = new IndexerApi(db, { now: () => BigInt(NOW) }, { staleAfterSec: 1800, startBlock: 90n, gatewayUrl: "https://arweave.net/" }, memoryLogger());
  server = api.server();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string, init?: RequestInit): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text), headers: res.headers };
}

describe("GET /api/agents", () => {
  it("lists every agent with derived stats; bigints are strings; CORS *", async () => {
    const r = await get("/api/agents");
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const agents = r.body.agents as AgentView[];
    expect(agents.map((a) => a.agentId)).toEqual([3, 5, 7]);
    const a7 = agents.find((a) => a.agentId === 7)!;
    expect(a7).toMatchObject({
      name: "Seven",
      symbol: "AGENT1",
      state: "live",
      status: "live",
      poolId: P7,
      instance: { treasuryEOA: "0xTreas7", actionEOA: "0xAction7", attestationRef: "att7", lastHeartbeat: NOW - 600, generation: 1 },
      market: {
        price: "0.000499999999999999",
        priceE18: "499999999999999",
        priceSource: "pool",
        totalSupply: "1000000000000000000000000000",
        mcapUsdg: "499999999999", // 0.000499999999999999 × 1e9 tokens ≈ 499 999.999999 USDG
        volume24hUsdg: "6000000", // swap 1 USDG + curve 5 USDG
      },
      balances: { treasuryUsdg: "12345678", actionUsdg: "4275000", actionToken: "2204007000000000000000", updatedAt: NOW - 5 },
      fees: { buybackLeg: "10", treasuryLeg: "11", royaltyLeg: "12", converted: "3", count: 1 },
    });
    const a5 = agents.find((a) => a.agentId === 5)!;
    expect(a5).toMatchObject({ state: "cancelled", status: "pending", instance: null, balances: null, market: { price: null, mcapUsdg: null, volume24hUsdg: "0" } });
    const a3 = agents.find((a) => a.agentId === 3)!;
    expect(a3).toMatchObject({ status: "evicted", market: { priceSource: "curve", price: "0.000453719067135449", volume24hUsdg: "0" } });
  });
});

describe("GET /api/agents/:id", () => {
  it("returns one agent", async () => {
    const r = await get("/api/agents/7");
    expect(r.status).toBe(200);
    expect(r.body.agentId).toBe(7);
    expect(r.body.market.priceSource).toBe("pool");
  });
  it("400 on malformed ids, 404 on unknown agent / route, 405 on non-GET, 204 on OPTIONS", async () => {
    for (const bad of ["abc", "0", "01", "-1", "1.5", "99999999999999999", "7x"]) {
      const r = await get(`/api/agents/${bad}`);
      expect([bad, r.status]).toEqual([bad, 400]);
      expect(r.body.error).toMatch(/bad agent id/);
    }
    expect((await get("/api/agents/42")).status).toBe(404);
    expect((await get("/api/agents/42/activity")).status).toBe(404);
    expect((await get("/api/agents/42/journal")).status).toBe(404);
    expect((await get("/api/agents/7/nope")).status).toBe(404);
    expect((await get("/nope")).status).toBe(404);
    expect((await get("/api/agents", { method: "POST", body: "{}" })).status).toBe(405);
    const o = await get("/api/agents", { method: "OPTIONS" });
    expect(o.status).toBe(204);
    expect(o.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("GET /api/agents/:id/activity", () => {
  it("newest first; limit DEFAULT 50, clamped to 200; bad limit ⇒ 400", async () => {
    const d = await get("/api/agents/7/activity");
    expect(d.status).toBe(200);
    expect(d.body.events).toHaveLength(50);
    expect(d.body.events[0]).toMatchObject({ kind: "heartbeat", txHash: "0xhb249", blockNumber: 349, data: { timestamp: String(NOW - 1000 + 249) } });
    expect((await get("/api/agents/7/activity?limit=5")).body.events).toHaveLength(5);
    expect((await get("/api/agents/7/activity?limit=1000")).body.events).toHaveLength(200);
    expect((await get("/api/agents/7/activity?limit=0")).status).toBe(400);
    expect((await get("/api/agents/7/activity?limit=abc")).status).toBe(400);
  });
});

describe("GET /api/agents/:id/journal", () => {
  it("newest first, unverified as boolean, permanent Arweave link", async () => {
    const r = await get("/api/agents/7/journal");
    expect(r.status).toBe(200);
    expect(r.body.pinnedOwner).toBeNull();
    expect(r.body.entries).toEqual([
      expect.objectContaining({ itemId: "b".repeat(43), text: "newer", unverified: true, blockHeight: null, url: `https://arweave.net/${"b".repeat(43)}` }),
      expect.objectContaining({ itemId: "a".repeat(43), text: "older", unverified: false, blockHeight: 10 }),
    ]);
    expect((await get("/api/agents/5/journal")).body.entries).toEqual([]);
    expect((await get("/api/agents/7/journal?limit=1")).body.entries).toHaveLength(1);
  });
});

describe("GET /api/status", () => {
  it("cursor block, chain head at last poll, lag, row counts", async () => {
    const r = await get("/api/status");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      startBlock: 90,
      cursorBlock: 1000,
      chainHead: 1010,
      lagBlocks: 10,
      lastPollAt: NOW - 2,
      revivalWindowSec: 604800,
      staleAfterSec: 1800,
      decimals: { usdg: 6, token: 18, price: 18 },
      counts: { agents: 3, instances: 2, events: 250, pools: 1, swaps: 1, trades_curve: 2, fees: 1, balances: 1, journal: 2, journal_owner: 0 },
    });
  });
});
