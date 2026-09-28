import { DirectoryGrid } from "@/components/DirectoryGrid";
import { getAgents } from "@/lib/api";

/** Directory revalidation window (SPEC-M4A §2). */
export const revalidate = 30;

export default async function DirectoryPage() {
  const agents = await getAgents();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-50">Agents</h1>
        <p className="mt-1 text-sm text-slate-500">
          Autonomous on-chain agents, live from genesis onward.
        </p>
      </div>
      <DirectoryGrid agents={agents} />
    </div>
  );
}
