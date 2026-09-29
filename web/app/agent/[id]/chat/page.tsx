import { notFound } from "next/navigation";

import { ChatTab } from "@/components/chat/ChatTab";
import { getAgent } from "@/lib/api";
import { defaultEndpoint } from "@/lib/chat";
import { FIXTURES_MODE } from "@/lib/config";

export const revalidate = 30;

/**
 * Chat tab (05 §1/§4, D9, SPEC-M4C §2). The server only renders the shell +
 * the indexer-derived agent facts; every chat request is browser → enclave
 * (R2 — no Next route proxies /nonce, /session or /chat). Endpoint override:
 * `?endpoint=` (R3), component state only.
 */
export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const agent = await getAgent(id);
  if (!agent) notFound();

  if (!agent.instance) {
    return (
      <section className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-8 text-center">
        <p className="mx-auto max-w-md text-sm text-slate-400">
          Not yet deployed — no enclave has registered for this agent, so there is no chat
          endpoint to talk to yet.
        </p>
      </section>
    );
  }

  const endpointParam = typeof sp.endpoint === "string" && sp.endpoint.trim() !== "" ? sp.endpoint.trim() : null;

  return (
    <ChatTab
      agent={{
        agentId: agent.agentId,
        name: agent.name ?? `Agent #${agent.agentId}`,
        symbol: agent.symbol,
        token: agent.token,
        totalSupply: agent.market.totalSupply,
        status: agent.status,
      }}
      fixtures={FIXTURES_MODE}
      defaultEndpoint={defaultEndpoint(agent.agentId)}
      endpointParam={endpointParam}
    />
  );
}
