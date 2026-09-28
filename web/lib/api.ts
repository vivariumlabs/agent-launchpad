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
 * Route params arrive as strings (Next.js dynamic segments); AgentView.agentId
 * itself is a number per the indexer's canonical shape.
 */
import { FIXTURES_MODE, INDEXER_URL } from "./config";
import {
  fixtureActivity,
  fixtureAgents,
  fixtureJournal,
  fixtureProfiles,
} from "./fixtures";
import type {
  ActivityItem,
  ActivityResponse,
  AgentView,
  AgentsResponse,
  JournalEntry,
  JournalResponse,
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

async function fetchIndexer(path: string): Promise<Response> {
  return fetch(`${INDEXER_URL}${path}`, {
    next: { revalidate: DIRECTORY_REVALIDATE_SECONDS },
  });
}
