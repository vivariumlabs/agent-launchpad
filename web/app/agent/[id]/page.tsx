import { notFound } from "next/navigation";

import { ActivityFeed } from "@/components/ActivityFeed";
import { JournalFeed } from "@/components/JournalFeed";
import { getActivity, getAgent, getJournal } from "@/lib/api";
import { formatCompactUsd, formatEth, formatOrDash, formatUsdg } from "@/lib/format";

export const revalidate = 30;

/** Overview tab: stat row, journal (the centerpiece, D17), activity. Header lives in layout.tsx. */
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

  const { market, balances, fees } = agent;

  return (
    <>
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
    </>
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
