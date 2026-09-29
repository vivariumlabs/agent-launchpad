import Link from "next/link";

import { AgentAvatar } from "./AgentAvatar";
import { LegacyBadge } from "./LegacyBadge";
import { StatusBadge } from "./StatusBadge";
import { formatCompactUsd, formatOrDash, formatUsdg } from "@/lib/format";
import { LEGACY_STACK_COPY, agentStack } from "@/lib/stack";
import type { AgentView } from "@/lib/types";

export function AgentCard({ agent }: { agent: AgentView }) {
  const legacy = agentStack(agent)?.legacy === true;
  return (
    <Link
      href={`/agent/${agent.agentId}`}
      className="group flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4 transition hover:border-slate-700 hover:bg-slate-900"
    >
      <div className="flex items-center gap-3">
        <AgentAvatar
          agentId={agent.agentId}
          imageURI={agent.imageURI}
          name={agent.name}
          size={44}
          className="shrink-0 rounded-lg"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-medium text-slate-100 group-hover:text-white">
              {agent.name ?? `Agent #${agent.agentId}`}
            </h3>
            <span className="shrink-0 font-mono text-xs text-slate-500">
              {agent.symbol ?? "—"}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            {agent.instance ? `gen ${agent.instance.generation}` : "not yet deployed"}
          </p>
        </div>
        <StatusBadge status={agent.status} />
      </div>

      <dl className="grid grid-cols-3 gap-2 text-sm">
        <Stat label="Mcap" value={formatOrDash(agent.market.mcapUsdg, formatCompactUsd)} />
        <Stat label="24h vol" value={formatCompactUsd(agent.market.volume24hUsdg)} />
        <Stat
          label="Treasury"
          value={formatOrDash(agent.balances?.treasuryUsdg ?? null, (v) => `${formatUsdg(v)} USDG`)}
          mono
        />
      </dl>

      {legacy ? (
        <div className="-mt-1 flex flex-wrap items-center gap-2">
          <LegacyBadge />
          <span className="text-[11px] text-slate-500">{LEGACY_STACK_COPY.replace(/^legacy stack — /, "")}</span>
        </div>
      ) : null}
    </Link>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd
        className={`truncate text-slate-200 ${mono ? "font-mono text-xs" : "text-sm font-medium"}`}
      >
        {value}
      </dd>
    </div>
  );
}
