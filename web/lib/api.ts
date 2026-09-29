/**
 * Server-side data access for the Directory and Profile pages.
 *
 * INDEXER_URL unset => fixtures mode (web/fixtures/*.json). Otherwise fetch
 * from the indexer's node:http API (indexer/src/api.ts): GET /api/agents,
 * /api/agents/:id, /api/agents/:id/activity, /api/agents/:id/journal.
 *
 * Only ever called from server components (page.tsx files) — the browser
 * never talks to the indexer directly (no client CORS dependence, per
 * SPEC-M4A §2). Not marked with the `server-only` package to avoid adding a
 * dependency beyond the spec's allowed list (SPEC-M4A §5 item 4).
 *
 * SPEC-M4B additions: GET /api/agents/:id/attestation, /api/attestation/summary
 * (indexer) and GET /api/launch/template (launch-helper, LAUNCH_HELPER_URL —
 * also server-side only, R4).
 *
 * Route params arrive as strings (Next.js dynamic segments); AgentView.agentId
 * itself is a number per the indexer's canonical shape.
 */
import { normalizeAttestation, normalizeSummary } from "./attestation";
import { normalizeContracts } from "./nfts";
import { normalizeFloor, type FloorScenario } from "./floor";
import { FIXTURES_MODE, INDEXER_URL, LAUNCH_HELPER_URL } from "./config";
import {
  fixtureActivity,
  fixtureAgents,
  fixtureAttestationRaw,
  fixtureAttestationSummaryRaw,
  fixtureContractsRaw,
  fixtureFloorRaw,
  fixtureJournal,
  fixtureLaunchTemplate,
  fixtureProfiles,
} from "./fixtures";
import type {
  ActivityItem,
  ActivityResponse,
  AgentView,
  AgentsResponse,
  AttestationSummary,
  AttestationView,
  ContractsResponse,
  FloorResult,
  JournalEntry,
  JournalResponse,
  LaunchTemplate,
} from "./types";

/** Directory revalidation window (SPEC-M4A §2). */
const DIRECTORY_REVALIDATE_SECONDS = 30;

export async function getAgents(): Promise<AgentView[]> {
  if (FIXTURES_MODE) return fixtureAgents;
  const res = await fetchIndexer("/api/agents");
  if (!res.ok) return [];
  const body = (await res.json()) as AgentsResponse;
  return body.agents;
}

export async function getAgent(agentId: string): Promise<AgentView | null> {
  if (FIXTURES_MODE) return fixtureProfiles[agentId] ?? null;
  const res = await fetchIndexer(`/api/agents/${encodeURIComponent(agentId)}`);
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return (await res.json()) as AgentView;
}

export async function getActivity(
  agentId: string,
  limit = 50,
): Promise<ActivityItem[]> {
  if (FIXTURES_MODE) return fixtureActivity[agentId] ?? [];
  const res = await fetchIndexer(
    `/api/agents/${encodeURIComponent(agentId)}/activity?limit=${limit}`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as ActivityResponse;
  return body.events;
}

/** Journal entries only — `pinnedOwner` is available on the raw response (JournalResponse) if a future slice needs it. */
export async function getJournal(
  agentId: string,
  limit = 50,
): Promise<JournalEntry[]> {
  if (FIXTURES_MODE) return fixtureJournal[agentId] ?? [];
  const res = await fetchIndexer(
    `/api/agents/${encodeURIComponent(agentId)}/journal?limit=${limit}`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as JournalResponse;
  return body.entries;
}

/**
 * Attestation checks for one agent (SPEC-M4B §1c). null = no attestation
 * available (404: no instance row) OR indexer unreachable — callers render
 * "unavailable", never a verdict.
 */
export async function getAttestation(agentId: string): Promise<AttestationView | null> {
  if (FIXTURES_MODE) return normalizeAttestation(fixtureAttestationRaw[agentId]);
  try {
    const res = await fetchIndexer(`/api/agents/${encodeURIComponent(agentId)}/attestation`);
    if (!res.ok) return null;
    return normalizeAttestation(await res.json());
  } catch {
    return null;
  }
}

/** Site-wide banner revalidation window (SPEC-M4B §3a DEFAULT 60 s). */
const SUMMARY_REVALIDATE_SECONDS = 60;
/** Never let the banner fetch hold up a page render. */
const SUMMARY_TIMEOUT_MS = 3000;

/**
 * Attestation summary for the site-wide red banner. Returns null when the
 * indexer is unreachable or answers garbage — a dead indexer is not a
 * compromise (SPEC-M4B §3a): the banner then renders nothing.
 */
export async function getAttestationSummary(): Promise<AttestationSummary | null> {
  if (FIXTURES_MODE) return normalizeSummary(fixtureAttestationSummaryRaw);
  try {
    const res = await fetch(`${INDEXER_URL}/api/attestation/summary`, {
      next: { revalidate: SUMMARY_REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return normalizeSummary(await res.json());
  } catch {
    return null;
  }
}

/** Launch template (SPEC-M4B §2). null = helper unset or unreachable. */
export async function getLaunchTemplate(): Promise<LaunchTemplate | null> {
  if (FIXTURES_MODE) return fixtureLaunchTemplate;
  if (LAUNCH_HELPER_URL === "") return null;
  try {
    const res = await fetch(`${LAUNCH_HELPER_URL}/api/launch/template`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as LaunchTemplate;
    if (!body?.defaults || !Array.isArray(body.defaults.models)) return null;
    return body;
  } catch {
    return null;
  }
}

/** Uncached agent + attestation read for the launch progress tracker (polling). */
export async function getAgentFresh(
  agentId: string,
): Promise<{ agent: AgentView | null; attestation: AttestationView | null }> {
  const base = `${INDEXER_URL}/api/agents/${encodeURIComponent(agentId)}`;
  const opts: RequestInit = { cache: "no-store", signal: AbortSignal.timeout(5000) };
  const agentRes = await fetch(base, opts);
  if (agentRes.status === 404) return { agent: null, attestation: null };
  if (!agentRes.ok) throw new Error(`indexer ${agentRes.status}`);
  const agent = (await agentRes.json()) as AgentView;
  let attestation: AttestationView | null = null;
  if (agent.instance) {
    try {
      const attRes = await fetch(`${base}/attestation`, opts);
      if (attRes.ok) attestation = normalizeAttestation(await attRes.json());
    } catch {
      attestation = null;
    }
  }
  return { agent, attestation };
}

/**
 * Deployment addresses + chainId from the indexer (SPEC-M4E R5 — the web's
 * ONLY source of contract addresses). null = indexer unreachable / garbage;
 * callers disable chain reads/writes rather than guess.
 */
export async function getContracts(): Promise<ContractsResponse | null> {
  if (FIXTURES_MODE) return normalizeContracts(fixtureContractsRaw);
  try {
    const res = await fetch(`${INDEXER_URL}/api/contracts`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return normalizeContracts(await res.json());
  } catch {
    return null;
  }
}

/**
 * $TOKEN floor (SPEC-M4G §3/§4). `scenario` applies in fixtures mode only.
 * Unreachable / garbage => "unavailable" (the page says so; never zeros).
 */
export async function getFloor(scenario: FloorScenario = "active"): Promise<FloorResult> {
  if (FIXTURES_MODE) return normalizeFloor(fixtureFloorRaw[scenario]);
  try {
    const res = await fetch(`${INDEXER_URL}/api/floor`, {
      next: { revalidate: 15 },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { kind: "unavailable", message: `indexer answered ${res.status}` };
    return normalizeFloor(await res.json());
  } catch (err) {
    return { kind: "unavailable", message: `indexer unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function fetchIndexer(path: string): Promise<Response> {
  return fetch(`${INDEXER_URL}${path}`, {
    next: { revalidate: DIRECTORY_REVALIDATE_SECONDS },
  });
}
