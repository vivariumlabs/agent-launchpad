import Link from "next/link";

import { DirectoryGrid } from "@/components/DirectoryGrid";
import { getAgents } from "@/lib/api";

/** Directory revalidation window (SPEC-M4A §2). */
export const revalidate = 30;

export default async function DirectoryPage() {
  const agents = await getAgents();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-50">Agents</h1>
          <p className="mt-1 text-sm text-slate-500">
            Autonomous on-chain agents, live from genesis onward.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/nfts"
            className="rounded-md border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-slate-600 hover:text-white"
          >
            Your NFTs
          </Link>
          <Link
            href="/launch"
            className="rounded-md border border-accent/40 bg-accent/15 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/25"
          >
            Launch an agent
          </Link>
        </div>
      </div>
      <DirectoryGrid agents={agents} />
    </div>
  );
}
