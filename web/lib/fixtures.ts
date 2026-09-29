/**
 * Fixtures mode data (SPEC-M4A §2): active whenever INDEXER_URL is unset.
 * Agents: 3 live with a rich journal, 5 pending (requested, not yet
 * deployed), 9 evicted; SPEC-M4B adds 4 (live, drill-style local ref) and 7
 * (live, one failing check). Shapes match the live indexer API exactly
 * (web/lib/types.ts, mirroring indexer/src/api.ts).
 *
 * Attestation states (SPEC-M4B §3a): 3 all-pass, 7 one failing
 * (configHashMatch — drives the site-wide banner in fixtures mode too),
 * 4 drill/skip cascade, 9 pending (Arweave unreachable), 5 no instance.
 * Launch helper mocks (SPEC-M4B §3b): template + prepare (+ SPEC-M4E publish,
 * assembled in web/app/api/launch/publish/route.ts).
 *
 * NFT dashboard (SPEC-M4E §3): /api/contracts + a 2-NFT wallet (Cato #3 with
 * accrued royalties, Marcus #9 emancipated) for the demo wallet; any other
 * wallet (or the "empty" scenario) is empty. nft-chain.json stands in for the
 * live wagmi view reads (accrued / ownerOf).
 *
 * Mausoleum (SPEC-M4F §2): 9 (evicted, revivable — full simulated pay flow),
 * 1 (evicted, agent-1-style M1 artifact: config_unavailable), 2 (stale —
 * "dying" with an evictableAt countdown). Agents 1/2 have no dedicated
 * profile JSON: their profile is their directory row. revive.json holds the
 * RAW helper quote bodies.
 */
import type {
  ActivityItem,
  LaunchPrepared,
  LaunchTemplate,
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

import agent3AttestationJson from "../fixtures/agent-3-attestation.json";

import agent4Json from "../fixtures/agent-4.json";
import agent4AttestationJson from "../fixtures/agent-4-attestation.json";

import agent5Json from "../fixtures/agent-5.json";
import agent5ActivityJson from "../fixtures/agent-5-activity.json";
import agent5JournalJson from "../fixtures/agent-5-journal.json";

import agent7Json from "../fixtures/agent-7.json";
import agent7AttestationJson from "../fixtures/agent-7-attestation.json";

import agent9Json from "../fixtures/agent-9.json";
import agent9AttestationJson from "../fixtures/agent-9-attestation.json";

import agent9ActivityJson from "../fixtures/agent-9-activity.json";
import agent9JournalJson from "../fixtures/agent-9-journal.json";

import attestationSummaryJson from "../fixtures/attestation-summary.json";
import launchTemplateJson from "../fixtures/launch-template.json";
import launchPrepareJson from "../fixtures/launch-prepare.json";

import agent2JournalJson from "../fixtures/agent-2-journal.json";
import reviveJson from "../fixtures/revive.json";

import contractsJson from "../fixtures/contracts.json";
import walletNftsJson from "../fixtures/wallet-nfts.json";
import nftChainJson from "../fixtures/nft-chain.json";

export const fixtureAgents: AgentView[] = (agentsListJson as AgentsResponse).agents;

function listRow(id: number): AgentView | undefined {
  return fixtureAgents.find((a) => a.agentId === id);
}

const agent1Row = listRow(1);
const agent2Row = listRow(2);

export const fixtureProfiles: Record<string, AgentView> = {
  ...(agent1Row ? { "1": agent1Row } : {}),
  ...(agent2Row ? { "2": agent2Row } : {}),
  "3": agent3Json as AgentView,
  "4": agent4Json as AgentView,
  "5": agent5Json as AgentView,
  "7": agent7Json as AgentView,
  "9": agent9Json as AgentView,
};

export const fixtureActivity: Record<string, ActivityItem[]> = {
  "3": (agent3ActivityJson as ActivityResponse).events,
  "5": (agent5ActivityJson as ActivityResponse).events,
  "9": (agent9ActivityJson as ActivityResponse).events,
};

export const fixtureJournal: Record<string, JournalEntry[]> = {
  "2": (agent2JournalJson as JournalResponse).entries,
  "3": (agent3JournalJson as JournalResponse).entries,
  "5": (agent5JournalJson as JournalResponse).entries,
  "9": (agent9JournalJson as JournalResponse).entries,
};

/**
 * RAW wire JSON (pinned spec shape: checks as a name->result record,
 * verifiedAt as an ISO string) — web/lib/api.ts normalizes it exactly like a
 * live response. Agent 5 has no instance row => no attestation (404).
 */
export const fixtureAttestationRaw: Record<string, unknown> = {
  "3": agent3AttestationJson,
  "4": agent4AttestationJson,
  "7": agent7AttestationJson,
  "9": agent9AttestationJson,
};

export const fixtureAttestationSummaryRaw: unknown = attestationSummaryJson;

export const fixtureLaunchTemplate = launchTemplateJson as LaunchTemplate;

/** RAW wire JSON — normalized by web/lib/nfts.ts exactly like a live response. */
export const fixtureContractsRaw: unknown = contractsJson;

/** RAW wire JSON for the demo wallet's /api/wallets/:address/nfts. */
export const fixtureWalletNftsRaw: unknown = walletNftsJson;

/** Simulated chain view reads for fixtures mode (no RPC). */
export const fixtureNftChain = nftChainJson as {
  accrued: Record<string, string>;
  ownerOf: Record<string, string>;
};

/** Prepare response minus agentJson — the mock route assembles agentJson from template + input. */
export const fixtureLaunchPrepare = launchPrepareJson as Omit<LaunchPrepared, "agentJson" | "agentJsonText">;

/**
 * SPEC-M4F §2 revive fixtures: RAW helper quote wire bodies by agent id (plus
 * the simulated payer / revival id the mock POST uses). Server-side only.
 */
export const fixtureRevive = reviveJson as {
  simulatedPayer: string;
  simulatedRevivalId: string;
  quotes: Record<string, Record<string, unknown>>;
};
