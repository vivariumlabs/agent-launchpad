"use client";

import { useMemo, useState } from "react";

import { AgentCard } from "./AgentCard";
import type { AgentView } from "@/lib/types";

type SortKey = "newest" | "mcap" | "volume";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "mcap", label: "Mcap" },
  { key: "volume", label: "24h volume" },
];

function bigOrZero(value: string | null): bigint {
  if (value === null) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function sortAgents(agents: AgentView[], key: SortKey): AgentView[] {
  const copy = [...agents];
  switch (key) {
    case "mcap":
      return copy.sort((a, b) => {
        const diff = bigOrZero(b.market.mcapUsdg) - bigOrZero(a.market.mcapUsdg);
        return diff > 0n ? 1 : diff < 0n ? -1 : 0;
      });
    case "volume":
      return copy.sort((a, b) => {
        const diff = bigOrZero(b.market.volume24hUsdg) - bigOrZero(a.market.volume24hUsdg);
        return diff > 0n ? 1 : diff < 0n ? -1 : 0;
      });
    case "newest":
    default:
      // Null createdAt (a freshly-requested agent whose creation hasn't been
      // observed yet) sorts as "unknown", not "oldest" — treat it as newest
      // so it doesn't get buried, without pretending to know its real time.
      return copy.sort((a, b) => {
        if (a.createdAt === null && b.createdAt === null) return 0;
        if (a.createdAt === null) return -1;
        if (b.createdAt === null) return 1;
        return b.createdAt - a.createdAt;
      });
  }
}

export function DirectoryGrid({ agents }: { agents: AgentView[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const sorted = useMemo(() => sortAgents(agents, sortKey), [agents, sortKey]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-slate-500">Sort</span>
        <div className="flex gap-1 rounded-lg border border-slate-800 bg-slate-900 p-1">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setSortKey(opt.key)}
              className={`rounded-md px-3 py-1 text-sm transition ${
                sortKey === opt.key
                  ? "bg-accent/20 text-accent"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-slate-500">No agents yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((agent) => (
            <AgentCard key={agent.agentId} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}
