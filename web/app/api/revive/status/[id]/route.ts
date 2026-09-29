/**
 * GET /api/revive/status/:id?since=<unix s>&sim=fail — revival tracker poll
 * (SPEC-M4F §2). Joins, server-side, the launch-helper's revival rows
 * (GET /api/revive/status/:id) with the indexer's instance row (the
 * generation bump is the visible proof). Returns the web-internal
 * ReviveStatus shape; either source may be down independently.
 *
 * Fixtures mode: the fixture agent's past revivals (from its quote history)
 * plus — when `since` is given and the fixture quote is revivable — a
 * SIMULATED new revival walking REQUESTED → DEPLOYING → AWAITING_REGISTER →
 * SEEDING (generation +1 on the indexer) → RECONCILING → LIVE over ~30 s.
 * `sim=fail` stops it at DEPLOYING with a failure, to walk the failed state.
 */
import { getAgentFresh } from "@/lib/api";
import { FIXTURES_MODE } from "@/lib/config";
import { fixtureProfiles, fixtureRevive } from "@/lib/fixtures";
import { parseReviveQuote } from "@/lib/revive";
import { getRevivalRows } from "@/lib/reviveServer";
import type { ReviveStatus, RevivalRow } from "@/lib/types";

export const dynamic = "force-dynamic";

function simulateRow(since: number, now: number, startGeneration: number, fail: boolean, payer: string): RevivalRow {
  const e = now - since;
  let state: string;
  if (e < 5) state = "REQUESTED";
  else if (fail) state = e < 9 ? "DEPLOYING" : "FAILED";
  else if (e < 12) state = "DEPLOYING";
  else if (e < 18) state = "AWAITING_REGISTER";
  else if (e < 24) state = "SEEDING";
  else if (e < 29) state = "RECONCILING";
  else state = "LIVE";
  return {
    revivalId: fixtureRevive.simulatedRevivalId,
    state,
    startedAt: since,
    payer,
    startGeneration,
    failReason: state === "FAILED" ? "deploy_failed" : null,
    lastError: state === "FAILED" ? "simulated: Oyster job did not come up after 3 attempts (fixtures)" : null,
    updatedAt: now,
  };
}

function fixtureStatus(agentId: number, since: number | null, fail: boolean, now: number): ReviveStatus {
  const agent = fixtureProfiles[String(agentId)] ?? null;
  const quote = parseReviveQuote(fixtureRevive.quotes[String(agentId)] ?? null, agentId);
  const baseGen = agent?.instance?.generation ?? null;
  const rows: RevivalRow[] = (quote?.history ?? []).map((h, i) => ({
    revivalId: String(i + 1),
    state: h.state,
    startedAt: h.startedAt,
    payer: h.payer,
    startGeneration: h.generation !== null ? h.generation - 1 : null,
    failReason: null,
    lastError: null,
    updatedAt: h.startedAt,
  }));
  let generation = baseGen;
  let status = agent?.status ?? null;
  let lastHeartbeat = agent?.instance?.lastHeartbeat ?? null;
  if (since !== null && quote?.revivable === true && baseGen !== null) {
    const row = simulateRow(since, now, baseGen, fail, fixtureRevive.simulatedPayer);
    rows.push(row);
    if (row.state === "SEEDING" || row.state === "RECONCILING" || row.state === "LIVE") {
      generation = baseGen + 1;
      lastHeartbeat = now;
      status = "live";
    }
  }
  return {
    agentId,
    helper: "ok",
    helperError: null,
    revivals: rows,
    indexer: agent ? "ok" : "unreachable",
    generation,
    lastHeartbeat,
    status,
    observedAt: now,
  };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!/^\d{1,9}$/.test(id)) return Response.json({ error: "bad agent id" }, { status: 400 });
  const agentId = Number(id);
  const now = Math.floor(Date.now() / 1000);
  const sp = new URL(req.url).searchParams;

  if (FIXTURES_MODE) {
    const sinceRaw = sp.get("since") ?? "";
    const since = /^\d{1,12}$/.test(sinceRaw) ? Number(sinceRaw) : null;
    return Response.json(fixtureStatus(agentId, since, sp.get("sim") === "fail", now));
  }

  const [helper, indexer] = await Promise.all([
    getRevivalRows(agentId),
    getAgentFresh(id).then(
      (v) => ({ ok: true as const, agent: v.agent }),
      () => ({ ok: false as const, agent: null }),
    ),
  ]);

  const body: ReviveStatus = {
    agentId,
    helper: helper.kind === "ok" ? "ok" : helper.kind === "manual" ? "manual" : "unreachable",
    helperError: helper.kind === "ok" ? null : helper.message,
    revivals: helper.kind === "ok" ? helper.rows : [],
    indexer: indexer.ok ? "ok" : "unreachable",
    generation: indexer.agent?.instance?.generation ?? null,
    lastHeartbeat: indexer.agent?.instance?.lastHeartbeat ?? null,
    status: indexer.agent?.status ?? null,
    observedAt: now,
  };
  return Response.json(body);
}
