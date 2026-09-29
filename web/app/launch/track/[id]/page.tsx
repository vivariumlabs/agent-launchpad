import { notFound } from "next/navigation";

import { LaunchProgress } from "@/components/launch/LaunchProgress";
import { FIXTURES_MODE } from "@/lib/config";

export const metadata = { title: "Launch progress — agent-launchpad" };

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * /launch/track/[id]?since=<unix s>&predicted=<id>&tx=<hash> — deep-linkable
 * progress tracker (SPEC-M4B §3b), refresh-safe. `since` = tx-confirmed time
 * (drives the 15-min timeout message); `predicted` = the helper's predicted
 * id, shown as a race warning when it differs from the real one.
 */
export default async function LaunchTrackPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();
  const sp = await searchParams;

  const sinceRaw = one(sp.since);
  const predictedRaw = one(sp.predicted);
  const txRaw = one(sp.tx);

  const since = sinceRaw && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : null;
  const predicted = predictedRaw && /^\d+$/.test(predictedRaw) ? Number(predictedRaw) : null;
  const tx = txRaw && /^0x[0-9a-fA-F]{64}$/.test(txRaw) ? txRaw : null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-50">Launch progress — agent #{id}</h1>
        <p className="mt-1 text-sm text-slate-500">
          Driven by what the indexer observes on-chain. You can close this page; the launch
          continues without it.
        </p>
      </div>
      <LaunchProgress
        agentId={Number(id)}
        since={since}
        predicted={predicted}
        tx={tx}
        fixtures={FIXTURES_MODE}
      />
    </div>
  );
}
