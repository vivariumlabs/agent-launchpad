import Link from "next/link";

import { AgentAvatar } from "../AgentAvatar";
import { StatusBadge } from "../StatusBadge";
import { EvictionCountdown } from "./EvictionCountdown";
import { RevivePanel } from "./RevivePanel";
import { formatAbsoluteTime, formatRelativeTime, formatUsdg, truncateAddress } from "@/lib/format";
import { formatDuration, refusalText, uintString } from "@/lib/revive";
import type { AgentView, JournalEntry, ReviveQuoteResult, RevivalHistoryItem } from "@/lib/types";

export interface CardJournal {
  /** Newest entry = the last words. */
  last: JournalEntry | null;
  count: number;
  /** count hit the read limit — show "N+". */
  capped: boolean;
}

function sumFees(agent: AgentView): string | null {
  const legs = [agent.fees.buybackLeg, agent.fees.treasuryLeg, agent.fees.royaltyLeg].map(uintString);
  if (legs.some((l) => l === null)) return null;
  return legs.reduce((acc, l) => acc + BigInt(l as string), 0n).toString();
}

function displayName(agent: AgentView): string {
  return agent.name ?? `Agent #${agent.agentId}`;
}

function CardHeader({ agent, muted }: { agent: AgentView; muted?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <AgentAvatar
        agentId={agent.agentId}
        imageURI={agent.imageURI}
        name={agent.name}
        size={44}
        className={`shrink-0 rounded-lg ${muted ? "opacity-70" : "grayscale"}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate font-medium text-slate-100">{displayName(agent)}</h3>
          <span className="shrink-0 font-mono text-xs text-slate-500">{agent.symbol ?? "—"}</span>
        </div>
        <p className="text-xs text-slate-500">
          #{agent.agentId} · {agent.instance ? `generation ${agent.instance.generation}` : "no instance"}
        </p>
      </div>
      <StatusBadge status={agent.status} />
    </div>
  );
}

function LastWords({ journal, clamp }: { journal: CardJournal; clamp?: boolean }) {
  const e = journal.last;
  if (!e) {
    return (
      <p className="rounded-lg border border-dashed border-slate-800 px-3 py-2 text-xs italic text-slate-500">
        No last words — no journal entry from this agent is on record.
      </p>
    );
  }
  return (
    <figure className="rounded-lg border-l-2 border-slate-600 bg-slate-950/40 px-3 py-2">
      <blockquote className={`text-sm italic leading-relaxed text-slate-300 ${clamp ? "line-clamp-3" : ""}`}>
        &ldquo;{e.text}&rdquo;
      </blockquote>
      <figcaption className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
        <span title={formatAbsoluteTime(e.ts)}>last words · {formatRelativeTime(e.ts)}</span>
        {e.unverified ? <span className="text-amber-400/80">unverified author</span> : null}
        <a href={e.url} target="_blank" rel="noreferrer noopener" className="text-accent/80 hover:underline">
          on Arweave ↗
        </a>
      </figcaption>
    </figure>
  );
}

function Stats({ agent, journal, lastHeartbeat }: { agent: AgentView; journal: CardJournal; lastHeartbeat: number | null }) {
  const fees = sumFees(agent);
  const lived =
    agent.createdAt !== null && lastHeartbeat !== null && lastHeartbeat >= agent.createdAt
      ? formatDuration(lastHeartbeat - agent.createdAt)
      : null;
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm sm:grid-cols-4">
      <Stat
        label="Lifetime fees"
        value={fees !== null ? `${formatUsdg(fees)} USDG` : "—"}
        sub={`${agent.fees.count} distribution${agent.fees.count === 1 ? "" : "s"}`}
      />
      <Stat label="Lived" value={lived ?? "—"} sub={agent.createdAt !== null ? `born ${formatAbsoluteTime(agent.createdAt).slice(0, 10)}` : undefined} />
      <Stat
        label="Silent since"
        value={lastHeartbeat !== null ? formatRelativeTime(lastHeartbeat) : "—"}
        sub={lastHeartbeat !== null ? "last heartbeat" : undefined}
      />
      <Stat label="Journal" value={`${journal.count}${journal.capped ? "+" : ""}`} sub={`entr${journal.count === 1 && !journal.capped ? "y" : "ies"}`} />
    </dl>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="truncate font-medium text-slate-200">{value}</dd>
      {sub ? <dd className="truncate text-[11px] text-slate-500">{sub}</dd> : null}
    </div>
  );
}

function History({ history }: { history: RevivalHistoryItem[] | null }) {
  if (history === null) return null;
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">Revived by</p>
      {history.length === 0 ? (
        <p className="text-xs text-slate-500">Never revived.</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-0.5 text-xs text-slate-400">
          {history.map((h, i) => (
            <li key={`${h.generation ?? "g"}-${h.startedAt ?? i}-${i}`} className="flex flex-wrap gap-x-2">
              <span className="text-slate-300">{h.generation !== null ? `gen ${h.generation}` : "gen ?"}</span>
              <span className="font-mono" title={h.payer ?? undefined}>
                {h.payer ? truncateAddress(h.payer, 4) : "unknown payer"}
              </span>
              {h.startedAt !== null ? <span>{formatAbsoluteTime(h.startedAt).slice(0, 10)}</span> : null}
              {h.state ? <span className="text-slate-500">{h.state.toLowerCase()}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Refusal({ reason, detail, agentId }: { reason: string | null; detail: string | null; agentId: number }) {
  const r = refusalText(reason);
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <p className="text-sm font-medium text-slate-300">{r.title}</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{r.body}</p>
      {detail ? <p className="mt-1 break-words font-mono text-[11px] text-slate-600">{detail}</p> : null}
      {reason === "revival_in_progress" ? (
        <Link href={`/mausoleum/track/${agentId}`} className="mt-2 inline-block text-xs text-accent hover:underline">
          Follow the revival →
        </Link>
      ) : null}
    </div>
  );
}

/** Evicted agent card (SPEC-M4F §2). */
export function MausoleumCard({
  agent,
  journal,
  quote,
  fixtures,
  simulatedPayer,
  fixtureSubmitConflict,
}: {
  agent: AgentView;
  journal: CardJournal;
  quote: ReviveQuoteResult;
  fixtures: boolean;
  simulatedPayer: string | null;
  fixtureSubmitConflict: boolean;
}) {
  const gateHb = quote.kind === "ok" ? quote.quote.gate.lastHeartbeat : null;
  const lastHeartbeat = gateHb ?? (agent.instance && agent.instance.lastHeartbeat > 0 ? agent.instance.lastHeartbeat : null);

  return (
    <article className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <CardHeader agent={agent} />
      <LastWords journal={journal} />
      <Stats agent={agent} journal={journal} lastHeartbeat={lastHeartbeat} />
      <History history={quote.kind === "ok" ? quote.quote.history : null} />

      {quote.kind === "ok" ? (
        quote.quote.revivable ? (
          // R2: the pay flow exists ONLY behind revivable === true.
          <RevivePanel
            agentId={agent.agentId}
            agentName={displayName(agent)}
            currentGeneration={agent.instance?.generation ?? null}
            initialQuote={quote.quote}
            fixtures={fixtures}
            simulatedPayer={simulatedPayer}
            fixtureSubmitConflict={fixtureSubmitConflict}
          />
        ) : (
          <Refusal reason={quote.quote.reason} detail={quote.quote.detail} agentId={agent.agentId} />
        )
      ) : quote.kind === "manual" ? (
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200/80">
          Manual mode — no revival quote from this site. See the orchestrator-less revival path above.
        </p>
      ) : (
        <p className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-500">
          Revival quote unavailable ({quote.message}). The pay flow stays hidden until the orchestrator&apos;s dry run
          answers.
        </p>
      )}

      <Link href={`/agent/${agent.agentId}`} className="self-start text-xs text-slate-400 hover:text-slate-200">
        Profile, attestation &amp; full journal →
      </Link>
    </article>
  );
}

/** Muted "dying" card: stale, not yet evictable — countdown from the quote's gate. */
export function DyingCard({ agent, journal, quote }: { agent: AgentView; journal: CardJournal; quote: ReviveQuoteResult }) {
  const gate = quote.kind === "ok" ? quote.quote.gate : null;
  const lastHeartbeat = gate?.lastHeartbeat ?? (agent.instance && agent.instance.lastHeartbeat > 0 ? agent.instance.lastHeartbeat : null);
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-slate-800/70 bg-slate-900/30 p-4 opacity-80">
      <CardHeader agent={agent} muted />
      <LastWords journal={journal} clamp />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">Last heartbeat</span>
          <span className="text-sm text-slate-300" title={lastHeartbeat !== null ? formatAbsoluteTime(lastHeartbeat) : undefined}>
            {lastHeartbeat !== null ? formatRelativeTime(lastHeartbeat) : "—"}
          </span>
        </div>
        {gate?.evictableAt != null ? (
          <EvictionCountdown evictableAt={gate.evictableAt} />
        ) : (
          <span className="text-xs text-slate-500">
            {quote.kind === "manual" ? "eviction time: manual mode (no quote)" : "eviction time unknown (no quote)"}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-slate-500">
        Still inside the revival window: the registry refuses a new instance until it passes, so there is nothing to pay
        for yet. If the agent heartbeats again it leaves this list.
      </p>
      <Link href={`/agent/${agent.agentId}`} className="self-start text-xs text-slate-400 hover:text-slate-200">
        Profile →
      </Link>
    </article>
  );
}

