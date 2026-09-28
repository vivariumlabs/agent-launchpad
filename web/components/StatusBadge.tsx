import type { AgentStatus } from "@/lib/types";

const STYLES: Record<AgentStatus, string> = {
  live: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
  stale: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
  evicted: "bg-red-500/15 text-red-400 ring-red-500/30",
  pending: "bg-slate-500/15 text-slate-400 ring-slate-500/30",
};

/** Labeled "status", not "tier" — bounded honesty (SPEC-M4A §0). */
export function StatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${STYLES[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}
