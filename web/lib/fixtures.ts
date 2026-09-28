/**
 * Fixtures mode data (SPEC-M4A §2): active whenever INDEXER_URL is unset.
 * Three agents: one live with a rich journal, one pending (requested, not
 * yet deployed), one evicted. Shapes match the live indexer API exactly
 * (web/lib/types.ts, mirroring indexer/src/api.ts).
 */
import type {
  ActivityItem,
  ActivityResponse,
  AgentView,
  AgentsResponse,
  JournalEntry,
  JournalResponse,
} from "./types";

import agentsListJson from "../fixtures/agents.json";

import agent3Json from "../fixtures/agent-3.json";
import agent3ActivityJson from "../fixtures/agent-3-activity.json";
import agent3JournalJson from "../fixtures/agent-3-journal.json";

import agent5Json from "../fixtures/agent-5.json";
import agent5ActivityJson from "../fixtures/agent-5-activity.json";
import agent5JournalJson from "../fixtures/agent-5-journal.json";

import agent9Json from "../fixtures/agent-9.json";
import agent9ActivityJson from "../fixtures/agent-9-activity.json";
import agent9JournalJson from "../fixtures/agent-9-journal.json";

export const fixtureAgents: AgentView[] = (agentsListJson as AgentsResponse).agents;

export const fixtureProfiles: Record<string, AgentView> = {
  "3": agent3Json as AgentView,
  "5": agent5Json as AgentView,
  "9": agent9Json as AgentView,
};

export const fixtureActivity: Record<string, ActivityItem[]> = {
  "3": (agent3ActivityJson as ActivityResponse).events,
  "5": (agent5ActivityJson as ActivityResponse).events,
  "9": (agent9ActivityJson as ActivityResponse).events,
};

export const fixtureJournal: Record<string, JournalEntry[]> = {
  "3": (agent3JournalJson as JournalResponse).entries,
  "5": (agent5JournalJson as JournalResponse).entries,
  "9": (agent9JournalJson as JournalResponse).entries,
};
