import { TxLink } from "./TxLink";
import { humanizeActivity } from "@/lib/activity";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format";
import type { ActivityItem } from "@/lib/types";

/** `kind` is a free-form string (see lib/activity.ts) — unrecognized kinds fall back to bg-slate-400. */
const KIND_DOT: Record<string, string> = {
  swap: "bg-sky-400",
  curve_buy: "bg-violet-400",
  curve_sell: "bg-violet-400",
  curve_graduated: "bg-violet-400",
  requested: "bg-slate-400",
  live: "bg-slate-400",
  cancelled: "bg-red-400",
  graduated: "bg-violet-400",
  genesis_opened: "bg-slate-400",
  registered: "bg-slate-400",
  heartbeat: "bg-emerald-400",
  pool_registered: "bg-sky-400",
  fee_collected: "bg-amber-400",
  distributed: "bg-amber-400",
  royalty_credited: "bg-amber-400",
  royalty_claimed: "bg-amber-400",
  emancipated: "bg-red-400",
  buyback_poked: "bg-amber-400",
  nft_transfer: "bg-slate-400",
};

export function ActivityFeed({ events }: { events: ActivityItem[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-slate-500">No activity recorded yet.</p>;
  }

  const sorted = [...events].sort((a, b) => b.ts - a.ts);

  return (
    <ul className="flex flex-col divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/40">
      {sorted.map((event) => (
        <li key={event.id} className="flex items-center gap-3 px-4 py-3 text-sm">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${KIND_DOT[event.kind] ?? "bg-slate-400"}`}
            aria-hidden
          />
          <span className="flex-1 text-slate-300">{humanizeActivity(event)}</span>
          <TxLink txHash={event.txHash} />
          <span
            className="w-16 shrink-0 text-right text-xs text-slate-500"
            title={formatAbsoluteTime(event.ts)}
          >
            {formatRelativeTime(event.ts)}
          </span>
        </li>
      ))}
    </ul>
  );
}
