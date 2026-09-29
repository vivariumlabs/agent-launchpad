/**
 * GET /api/launch/status/:id?since=<unix s> — launch progress tracker poll
 * (SPEC-M4B §3b). Server-side read of the indexer's /api/agents/:id (+ its
 * attestation), so the browser never talks to the indexer directly
 * (SPEC-M4A §2). Returns the web-internal LaunchStatus shape.
 *
 * Fixtures mode: a known fixture agent returns its real fixture state; any
 * other id is SIMULATED from `since` (the tx-confirmed time) so the whole
 * tracker is walkable without services.
 */
import { FIXTURES_MODE } from "@/lib/config";
import { getAgentFresh } from "@/lib/api";
import { normalizeAttestation } from "@/lib/attestation";
import { fixtureAttestationRaw, fixtureProfiles } from "@/lib/fixtures";
import type { AgentView, AttestationChecks, AttestationView, LaunchStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const ALL: AttestationChecks = {
  refShape: "pass",
  itemFound: "pass",
  reportParses: "pass",
  eoasMatch: "pass",
  configHashMatch: "pass",
  imageIdMatch: "pass",
  releaseMatch: "pass",
  quoteValid: "pass",
  measurementMatch: "pass",
};

function fromViews(
  agentId: number,
  agent: AgentView | null,
  attestation: AttestationView | null,
  now: number,
): LaunchStatus {
  return {
    agentId,
    exists: agent !== null,
    state: agent?.state ?? null,
    status: agent?.status ?? null,
    name: agent?.name ?? null,
    hasInstance: agent?.instance != null,
    checks: attestation?.checks ?? null,
    observedAt: now,
  };
}

/** Simulated timeline (seconds after `since`): indexer lag → requested → instance → checks → live. */
function simulate(agentId: number, since: number, now: number): LaunchStatus {
  const e = now - since;
  const base: LaunchStatus = {
    agentId,
    exists: false,
    state: null,
    status: null,
    name: null,
    hasInstance: false,
    checks: null,
    observedAt: now,
  };
  if (e < 4) return base;
  const requested: LaunchStatus = { ...base, exists: true, state: "requested", status: "pending" };
  if (e < 12) return requested;
  const pendingChecks = Object.fromEntries(
    Object.keys(ALL).map((k) => [k, "pending"]),
  ) as AttestationChecks;
  if (e < 20) return { ...requested, hasInstance: true, checks: pendingChecks };
  if (e < 28) return { ...requested, hasInstance: true, checks: ALL };
  return { ...requested, hasInstance: true, checks: ALL, state: "live", status: "live" };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "bad agent id" }, { status: 400 });
  const agentId = Number(id);
  const now = Math.floor(Date.now() / 1000);

  if (FIXTURES_MODE) {
    const fixture = fixtureProfiles[id];
    if (fixture) {
      return Response.json(fromViews(agentId, fixture, normalizeAttestation(fixtureAttestationRaw[id]), now));
    }
    const sinceRaw = new URL(req.url).searchParams.get("since") ?? "";
    const since = /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : now;
    return Response.json(simulate(agentId, since, now));
  }

  try {
    const { agent, attestation } = await getAgentFresh(id);
    return Response.json(fromViews(agentId, agent, attestation, now));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `indexer unreachable: ${reason}` }, { status: 502 });
  }
}
