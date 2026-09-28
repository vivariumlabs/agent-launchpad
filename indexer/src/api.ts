// SPEC-M4A §1 api.ts — node:http JSON API (no framework), read-only.
//
//   GET /api/agents                          { agents: AgentView[] }                (agentId ascending)
//   GET /api/agents/:id                      AgentView
//   GET /api/agents/:id/activity?limit=N     { agentId, events: ActivityItem[] }    (newest first; N DEFAULT 50, max 200)
//   GET /api/agents/:id/journal?limit=N      { agentId, pinnedOwner, entries: JournalEntry[] } (newest first; same limit rule)
//   GET /api/status                          StatusView
//
// Units (see derive.ts): every bigint is a base-10 STRING — USDG amounts in USDG base units (6 dec),
// native balances in wei, agent-token amounts in token base units (18 dec); `price` is a decimal
// string of USDG per whole token (priceE18 is the same value × 1e18, integer string). Block numbers,
// log indexes, unix-second timestamps and generations are JSON numbers.
// Errors: 400 {error} for a malformed id / limit, 404 {error} for an unknown agent or route, 405 for
// non-GET. CORS: Access-Control-Allow-Origin * on every response (GET-only API).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Clock } from "./clock.js";
import type { AgentRow, IndexerDb } from "./db.js";
import {
  DAY_SEC,
  DEFAULT_REVIVAL_WINDOW,
  derivePrice,
  feeTotals,
  formatFixed,
  mcapUsdg,
  PRICE_DECIMALS,
  status,
  TOKEN_DECIMALS,
  USDG_DECIMALS,
  volume24h,
  type Status,
} from "./derive.js";
import { errMsg, type Logger } from "./log.js";
import { CURSOR_KEY, HEAD_KEY, LAST_POLL_KEY, REVIVAL_WINDOW_KEY } from "./watcher.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface ApiOpts {
  staleAfterSec: number;
  startBlock: bigint;
  /** Arweave gateway base for journal item links. */
  gatewayUrl: string;
}

export interface AgentView {
  agentId: number;
  name: string | null;
  symbol: string | null;
  imageURI: string | null;
  creator: string | null;
  configHash: string | null;
  token: string | null;
  curve: string | null;
  poolId: string | null;
  state: AgentRow["state"];
  requestTx: string | null;
  requestBlock: number | null;
  createdAt: number | null;
  status: Status;
  instance: {
    treasuryEOA: string;
    actionEOA: string;
    codeHash: string;
    attestationRef: string | null;
    lastHeartbeat: number;
    generation: number;
  } | null;
  market: {
    price: string | null;
    priceE18: string | null;
    priceSource: "pool" | "curve" | null;
    totalSupply: string | null;
    mcapUsdg: string | null;
    volume24hUsdg: string;
  };
  balances: {
    treasuryUsdg: string;
    treasuryRhEth: string;
    actionUsdg: string;
    actionRhEth: string;
    actionToken: string | null;
    updatedAt: number;
  } | null;
  fees: { buybackLeg: string; treasuryLeg: string; royaltyLeg: string; converted: string; count: number };
}

export interface ActivityItem {
  id: number;
  kind: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  ts: number;
  data: Record<string, unknown>;
}

export interface JournalEntry {
  itemId: string;
  ts: number;
  kind: string;
  text: string;
  owner: string;
  unverified: boolean;
  blockHeight: number | null;
  fetchedAt: number;
  url: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ID_RE = /^[1-9][0-9]{0,15}$/;

function parseId(s: string): number {
  if (!ID_RE.test(s)) throw new HttpError(400, `bad agent id ${JSON.stringify(s.slice(0, 32))}`);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new HttpError(400, "bad agent id");
  return n;
}

function parseLimit(v: string | null): number {
  if (v === null || v === "") return DEFAULT_LIMIT;
  if (!/^[0-9]{1,6}$/.test(v)) throw new HttpError(400, "bad limit");
  const n = Number(v);
  if (n < 1) throw new HttpError(400, "bad limit");
  return Math.min(n, MAX_LIMIT);
}

export class IndexerApi {
  constructor(
    private readonly db: IndexerDb,
    private readonly clock: Clock,
    private readonly opts: ApiOpts,
    private readonly log: Logger,
  ) {}

  private revivalWindow(): bigint {
    const v = this.db.kvGet(REVIVAL_WINDOW_KEY);
    return v === undefined ? DEFAULT_REVIVAL_WINDOW : BigInt(v);
  }

  agentView(a: AgentRow, now: bigint): AgentView {
    const inst = this.db.instance(a.agentId);
    const pools = new Map(this.db.pools().map((p) => [p.poolId, p.agentIsCurrency0 === 1]));
    const latestSwap = this.db.latestSwap(a.agentId);
    const latestTrade = this.db.latestCurveTrade(a.agentId);
    const price = derivePrice(
      latestSwap === undefined ? null : { sqrtPriceX96: BigInt(latestSwap.sqrtPriceX96), agentIsCurrency0: pools.get(latestSwap.poolId) ?? false },
      latestTrade === undefined ? null : { usdg: BigInt(latestTrade.usdg), tokens: BigInt(latestTrade.tokens) },
    );
    const since = Number(now - DAY_SEC);
    const vol = volume24h(
      this.db.swapsSince(a.agentId, since).map((s) => ({ ts: s.ts, amount0: BigInt(s.amount0), amount1: BigInt(s.amount1), agentIsCurrency0: pools.get(s.poolId) ?? false })),
      this.db.curveTradesSince(a.agentId, since).map((c) => ({ ts: c.ts, usdg: BigInt(c.usdg) })),
      now,
    );
    const fees = feeTotals(
      this.db.fees(a.agentId).map((f) => ({ buybackLeg: BigInt(f.buybackLeg), treasuryLeg: BigInt(f.treasuryLeg), royaltyLeg: BigInt(f.royaltyLeg), converted: BigInt(f.converted) })),
    );
    const bal = this.db.balances(a.agentId);
    const mcap = price !== null && a.totalSupply !== null ? mcapUsdg(price.priceE18, BigInt(a.totalSupply)) : null;
    return {
      agentId: a.agentId,
      name: a.name,
      symbol: a.symbol,
      imageURI: a.imageURI,
      creator: a.creator,
      configHash: a.configHash,
      token: a.token,
      curve: a.curve,
      poolId: a.poolId,
      state: a.state,
      requestTx: a.requestTx,
      requestBlock: a.requestBlock,
      createdAt: a.createdAt,
      status: status(inst === undefined ? null : { lastHeartbeat: inst.lastHeartbeat }, now, this.revivalWindow(), BigInt(this.opts.staleAfterSec)),
      instance:
        inst === undefined
          ? null
          : {
              treasuryEOA: inst.treasuryEOA,
              actionEOA: inst.actionEOA,
              codeHash: inst.codeHash,
              attestationRef: inst.attestationRef,
              lastHeartbeat: inst.lastHeartbeat,
              generation: inst.generation,
            },
      market: {
        price: price === null ? null : formatFixed(price.priceE18, PRICE_DECIMALS),
        priceE18: price === null ? null : price.priceE18.toString(),
        priceSource: price === null ? null : price.source,
        totalSupply: a.totalSupply,
        mcapUsdg: mcap === null ? null : mcap.toString(),
        volume24hUsdg: vol.toString(),
      },
      balances:
        bal === undefined
          ? null
          : {
              treasuryUsdg: bal.treasuryUsdg,
              treasuryRhEth: bal.treasuryRhEth,
              actionUsdg: bal.actionUsdg,
              actionRhEth: bal.actionRhEth,
              actionToken: bal.actionToken,
              updatedAt: bal.updatedAt,
            },
      fees: {
        buybackLeg: fees.buybackLeg.toString(),
        treasuryLeg: fees.treasuryLeg.toString(),
        royaltyLeg: fees.royaltyLeg.toString(),
        converted: fees.converted.toString(),
        count: fees.count,
      },
    };
  }

  private requireAgent(id: number): AgentRow {
    const a = this.db.agent(id);
    if (a === undefined) throw new HttpError(404, `unknown agent ${id}`);
    return a;
  }

  /** Route a GET path + query → JSON body. Throws HttpError. */
  route(path: string, query: URLSearchParams): unknown {
    const now = this.clock.now();
    const parts = path.split("/").filter((p) => p !== "");
    if (parts[0] !== "api") throw new HttpError(404, "not found");
    if (parts.length === 2 && parts[1] === "status") return this.statusView();
    if (parts[1] !== "agents") throw new HttpError(404, "not found");
    if (parts.length === 2) return { agents: this.db.agents().map((a) => this.agentView(a, now)) };
    const id = parseId(parts[2]!);
    if (parts.length === 3) return this.agentView(this.requireAgent(id), now);
    if (parts.length === 4 && parts[3] === "activity") {
      const limit = parseLimit(query.get("limit"));
      this.requireAgent(id);
      const events: ActivityItem[] = this.db.activity(id, limit).map((e) => ({
        id: e.id,
        kind: e.kind,
        txHash: e.txHash,
        logIndex: e.logIndex,
        blockNumber: e.blockNumber,
        ts: e.ts,
        data: JSON.parse(e.data) as Record<string, unknown>,
      }));
      return { agentId: id, events };
    }
    if (parts.length === 4 && parts[3] === "journal") {
      const limit = parseLimit(query.get("limit"));
      this.requireAgent(id);
      const gw = this.opts.gatewayUrl.replace(/\/+$/, "");
      const entries: JournalEntry[] = this.db.journal(id, limit).map((j) => ({
        itemId: j.itemId,
        ts: j.ts,
        kind: j.kind,
        text: j.text,
        owner: j.owner,
        unverified: j.unverified === 1,
        blockHeight: j.blockHeight,
        fetchedAt: j.fetchedAt,
        url: `${gw}/${j.itemId}`,
      }));
      return { agentId: id, pinnedOwner: this.db.journalOwner(id)?.owner ?? null, entries };
    }
    throw new HttpError(404, "not found");
  }

  statusView(): unknown {
    const next = this.db.kvGet(CURSOR_KEY);
    const head = this.db.kvGet(HEAD_KEY);
    const lastPoll = this.db.kvGet(LAST_POLL_KEY);
    const cursorBlock = next === undefined ? null : Number(BigInt(next) - 1n);
    const chainHead = head === undefined ? null : Number(head);
    return {
      startBlock: Number(this.opts.startBlock),
      cursorBlock,
      chainHead,
      lagBlocks: cursorBlock !== null && chainHead !== null ? Math.max(0, chainHead - cursorBlock) : null,
      lastPollAt: lastPoll === undefined ? null : Number(lastPoll),
      now: Number(this.clock.now()),
      revivalWindowSec: Number(this.revivalWindow()),
      staleAfterSec: this.opts.staleAfterSec,
      decimals: { usdg: USDG_DECIMALS, token: TOKEN_DECIMALS, price: PRICE_DECIMALS },
      counts: this.db.counts(),
    };
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const send = (code: number, body: unknown): void => {
      const text = JSON.stringify(body);
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "cache-control": "no-store",
      });
      res.end(text);
    };
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "86400" });
        res.end();
        return;
      }
      if (req.method !== "GET") {
        send(405, { error: "method not allowed" });
        return;
      }
      const u = new URL(req.url ?? "/", "http://localhost");
      send(200, this.route(u.pathname, u.searchParams));
    } catch (e) {
      if (e instanceof HttpError) {
        send(e.status, { error: e.message });
      } else {
        this.log.error(`api: ${req.method} ${req.url}: ${errMsg(e)}`);
        send(500, { error: "internal error" });
      }
    }
  }

  server(): Server {
    return createServer((req, res) => this.handle(req, res));
  }
}
