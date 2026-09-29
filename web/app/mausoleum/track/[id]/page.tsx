import Link from "next/link";
import { notFound } from "next/navigation";

import { RevivalTracker } from "@/components/revive/RevivalTracker";
import { FIXTURES_MODE } from "@/lib/config";

export const metadata = { title: "Revival progress — agent-launchpad" };

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * /mausoleum/track/[id]?since=<unix s>&tx=<payment hash>&rid=<revivalId>&gen=<generation before>
 * — deep-linkable, refresh-safe revival tracker (SPEC-M4F §2). Fixtures only:
 * `sim=fail` walks the failed state.
 */
export default async function RevivalTrackPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!/^\d{1,9}$/.test(id)) notFound();
  const sp = await searchParams;

  const sinceRaw = one(sp.since);
  const txRaw = one(sp.tx);
  const ridRaw = one(sp.rid);
  const genRaw = one(sp.gen);

  const since = sinceRaw && /^\d{1,12}$/.test(sinceRaw) ? Number(sinceRaw) : null;
  const tx = txRaw && /^0x[0-9a-fA-F]{64}$/.test(txRaw) ? txRaw : null;
  const revivalId = ridRaw && /^[A-Za-z0-9_-]{1,64}$/.test(ridRaw) ? ridRaw : null;
  const startGen = genRaw && /^\d{1,6}$/.test(genRaw) ? Number(genRaw) : null;
  const sim = FIXTURES_MODE && one(sp.sim) === "fail" ? "fail" : null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <Link href="/mausoleum" className="text-xs text-slate-500 hover:text-slate-300">
          ← Mausoleum
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-slate-50">Revival progress — agent #{id}</h1>
        <p className="mt-1 text-sm text-slate-500">
          Driven by the orchestrator&apos;s queue and what the indexer observes on-chain. You can close this page; the
          revival continues without it.
        </p>
      </div>
      {FIXTURES_MODE ? (
        <p className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-2 text-xs text-slate-400">
          Fixtures mode: the revival is simulated (~30 s).{" "}
          {sim ? null : since !== null ? (
            <Link
              href={`/mausoleum/track/${id}?${new URLSearchParams({ since: String(since), ...(revivalId ? { rid: revivalId } : {}), ...(startGen !== null ? { gen: String(startGen) } : {}), sim: "fail" }).toString()}`}
              className="text-accent hover:underline"
            >
              Walk the failed state instead
            </Link>
          ) : null}
        </p>
      ) : null}
      <RevivalTracker
        agentId={Number(id)}
        since={since}
        tx={tx}
        revivalId={revivalId}
        startGen={startGen}
        fixtures={FIXTURES_MODE}
        sim={sim}
      />
    </div>
  );
}
