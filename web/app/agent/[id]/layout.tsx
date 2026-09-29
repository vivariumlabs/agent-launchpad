import { notFound } from "next/navigation";

import { AddressRow } from "@/components/AddressRow";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentTabs } from "@/components/AgentTabs";
import { StatusBadge } from "@/components/StatusBadge";
import { TxLink } from "@/components/TxLink";
import { getAgent } from "@/lib/api";

export const revalidate = 30;

/**
 * Shared profile chrome (header + tab bar) for /agent/[id] (Overview) and
 * /agent/[id]/attestation (SPEC-M4B §3a). getAgent is deduped with the
 * child page's call (same fetch URL/options; fixtures are in-memory).
 */
export default async function AgentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const agent = await getAgent(id);
  if (!agent) notFound();

  const { instance } = agent;

  return (
    <div className="flex flex-col gap-10">
      {/* Header */}
      <section className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5 sm:flex-row sm:items-start">
        <AgentAvatar
          agentId={agent.agentId}
          imageURI={agent.imageURI}
          name={agent.name}
          size={64}
          className="shrink-0 rounded-xl"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-slate-50">
              {agent.name ?? `Agent #${agent.agentId}`}
            </h1>
            <span className="font-mono text-sm text-slate-500">{agent.symbol ?? "—"}</span>
            <StatusBadge status={agent.status} />
            <span className="text-xs text-slate-500">
              {instance ? `gen ${instance.generation}` : "not yet deployed"}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            <AddressRow label="Creator" address={agent.creator} />
            <AddressRow label="Token" address={agent.token} />
            <AddressRow label="Curve" address={agent.curve} />
            <AddressRow label="Pool" address={agent.poolId} />
            <AddressRow label="Treasury EOA" address={instance?.treasuryEOA ?? null} />
            <AddressRow label="Action EOA" address={instance?.actionEOA ?? null} />
          </div>

          {agent.requestTx ? (
            <p className="mt-3 text-xs text-slate-500">
              Requested <TxLink txHash={agent.requestTx} />
              {agent.requestBlock !== null ? ` at block ${agent.requestBlock}` : null}
            </p>
          ) : null}
        </div>
      </section>

      <AgentTabs agentId={agent.agentId} />

      {children}
    </div>
  );
}
