import { notFound } from "next/navigation";

import { ActivityFeed } from "@/components/ActivityFeed";
import { AddressRow } from "@/components/AddressRow";
import { AgentAvatar } from "@/components/AgentAvatar";
import { JournalFeed } from "@/components/JournalFeed";
import { StatusBadge } from "@/components/StatusBadge";
import { TabStub } from "@/components/TabStub";
import { TxLink } from "@/components/TxLink";
import { getActivity, getAgent, getJournal } from "@/lib/api";
import { formatCompactUsd, formatEth, formatOrDash, formatUsdg } from "@/lib/format";

export const revalidate = 30;

export default async function AgentProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const agent = await getAgent(id);
  if (!agent) notFound();

  const [activity, journal] = await Promise.all([
    getActivity(id),
    getJournal(id),
  ]);

  const { instance, market, balances, fees } = agent;

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
        <div className="flex-1">
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

      {/* Stat row */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard
          label="Price"
          value={formatOrDash(market.price, (p) => `${p} USDG`)}
        />
        <StatCard label="Mcap" value={formatOrDash(market.mcapUsdg, formatCompactUsd)} />
        <StatCard label="24h volume" value={formatCompactUsd(market.volume24hUsdg)} />
        <StatCard
          label="Treasury"
          value={formatOrDash(balances?.treasuryUsdg ?? null, (v) => `${formatUsdg(v)} USDG`)}
        />
        <StatCard
          label="Action USDG"
          value={formatOrDash(balances?.actionUsdg ?? null, (v) => `${formatUsdg(v)} USDG`)}
        />
        <StatCard
          label="Action token balance"
          value={formatOrDash(balances?.actionToken ?? null, formatEth)}
        />
        <StatCard
          label="Fees (buyback / treasury / royalty)"
          value={`${formatUsdg(fees.buybackLeg)} / ${formatUsdg(fees.treasuryLeg)} / ${formatUsdg(
            fees.royaltyLeg,
          )}`}
        />
      </section>

      {/* Tabs (disabled stubs for later slices) */}
      <section className="flex flex-wrap gap-2">
        <TabStub label="Attestation" />
        <TabStub label="Chat" />
        <TabStub label="Holders" />
      </section>

      {/* Journal feed — the page's centerpiece (D17) */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-100">Journal</h2>
        <JournalFeed entries={journal} />
      </section>

      {/* Activity feed */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-100">Activity</h2>
        <ActivityFeed events={activity} />
      </section>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 truncate font-mono text-sm text-slate-100" title={value}>
        {value}
      </p>
    </div>
  );
}
