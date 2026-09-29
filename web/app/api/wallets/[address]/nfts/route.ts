/**
 * GET /api/wallets/:address/nfts — server-side proxy to the indexer's
 * endpoint of the same path (SPEC-M4E §2/§3). The browser never talks to the
 * indexer directly (SPEC-M4A §2); the dashboard learns the address
 * client-side (wallet connect), hence this route rather than a server fetch.
 *
 *   fixtures mode -> the demo wallet gets fixtures/wallet-nfts.json (2 NFTs),
 *                    any other wallet — or `?scenario=empty` — gets [].
 *   live mode     -> forward, normalize tolerantly (web/lib/nfts.ts), and
 *                    best-effort enrich emancipated rows that lack a swept
 *                    amount from the agent's `emancipated` activity event.
 *   both modes    -> SPEC-M4G dual-stack: rows without a `stack` get their
 *                    agent's `stack` from the agent list (claim/burn target
 *                    addresses are per agent, never the primary manifest's).
 *
 * Response: WalletNftsResponse (normalized) | 400 | 502 {error}.
 */
import { DEMO_WALLET } from "@/lib/chatFixtures";
import { FIXTURES_MODE, INDEXER_URL } from "@/lib/config";
import { isAddress } from "@/lib/factory";
import { fixtureAgents, fixtureWalletNftsRaw } from "@/lib/fixtures";
import { sameHex } from "@/lib/format";
import { normalizeWalletNfts } from "@/lib/nfts";
import { agentStack } from "@/lib/stack";
import type { ActivityResponse, AgentStack, AgentView, AgentsResponse, WalletNft, WalletNftsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 5000;
/** Indexer activity max page (indexer/src/api.ts: limit max 200). */
const ACTIVITY_SCAN = 200;

async function sweptFromActivity(agentId: number): Promise<string | null> {
  try {
    const res = await fetch(`${INDEXER_URL}/api/agents/${agentId}/activity?limit=${ACTIVITY_SCAN}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<ActivityResponse>;
    if (!Array.isArray(body.events)) return null;
    const ev = body.events.find((e) => e?.kind === "emancipated");
    const v = ev?.data?.sweptToTreasury;
    return typeof v === "string" && /^\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

function stacksById(agents: AgentView[]): Map<number, AgentStack> {
  const m = new Map<number, AgentStack>();
  for (const a of agents) {
    const s = agentStack(a);
    if (s) m.set(a.agentId, s);
  }
  return m;
}

function withStacks(nfts: WalletNft[], stacks: Map<number, AgentStack>): WalletNft[] {
  return nfts.map((n) => (n.stack !== null ? n : { ...n, stack: stacks.get(n.agentId) ?? null }));
}

/** Agent list stacks (best effort — a failure leaves stack null, which disables claim/burn for that card). */
async function liveStacks(): Promise<Map<number, AgentStack>> {
  try {
    const res = await fetch(`${INDEXER_URL}/api/agents`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return new Map();
    const body = (await res.json()) as Partial<AgentsResponse>;
    return Array.isArray(body.agents) ? stacksById(body.agents) : new Map();
  } catch {
    return new Map();
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ address: string }> },
): Promise<Response> {
  const { address } = await params;
  if (!isAddress(address)) return Response.json({ error: "bad address" }, { status: 400 });

  if (FIXTURES_MODE) {
    const scenario = new URL(req.url).searchParams.get("scenario");
    const empty: WalletNftsResponse = { address, nfts: [] };
    if (scenario === "empty" || !sameHex(address, DEMO_WALLET)) return Response.json(empty);
    await new Promise((r) => setTimeout(r, 400)); // make the loading state visible
    const parsed = normalizeWalletNfts(fixtureWalletNftsRaw, address);
    if (!parsed) return Response.json(empty);
    return Response.json({ address: parsed.address, nfts: withStacks(parsed.nfts, stacksById(fixtureAgents)) } satisfies WalletNftsResponse);
  }

  let raw: unknown;
  try {
    const res = await fetch(`${INDEXER_URL}/api/wallets/${address}/nfts`, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return Response.json({ error: `indexer answered ${res.status}` }, { status: 502 });
    raw = await res.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `indexer unreachable: ${reason}` }, { status: 502 });
  }

  const parsed = normalizeWalletNfts(raw, address);
  if (!parsed) return Response.json({ error: "indexer returned an unexpected shape" }, { status: 502 });

  const stacks = parsed.nfts.some((n) => n.stack === null) ? await liveStacks() : new Map<number, AgentStack>();
  const nfts: WalletNft[] = await Promise.all(
    withStacks(parsed.nfts, stacks).map(async (n) =>
      n.emancipated && n.sweptToTreasury === null ? { ...n, sweptToTreasury: await sweptFromActivity(n.agentId) } : n,
    ),
  );
  return Response.json({ address: parsed.address, nfts } satisfies WalletNftsResponse);
}
