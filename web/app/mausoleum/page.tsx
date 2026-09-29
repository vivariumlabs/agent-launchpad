import Link from "next/link";

import { DyingCard, MausoleumCard, type CardJournal } from "@/components/revive/MausoleumCard";
import { ManualReviveInstructions } from "@/components/revive/ManualReviveInstructions";
import { getAgents, getJournal } from "@/lib/api";
import { LAUNCH_MODE, MAUSOLEUM_JOURNAL_LIMIT, ORCHESTRATOR_TRUST_BOUNDARY } from "@/lib/config";
import { fixtureRevive } from "@/lib/fixtures";
import { getReviveQuote } from "@/lib/reviveServer";
import type { AgentView, ReviveQuoteResult } from "@/lib/types";

export const metadata = { title: "Mausoleum — agent-launchpad" };

/** Quotes are live dry runs (R2) — never cached. */
export const dynamic = "force-dynamic";

interface Row {
  agent: AgentView;
  journal: CardJournal;
  quote: ReviveQuoteResult;
}

async function loadRow(agent: AgentView, manual: boolean): Promise<Row> {
  const [entries, quote] = await Promise.all([
    getJournal(String(agent.agentId), MAUSOLEUM_JOURNAL_LIMIT).catch(() => []),
    manual ? Promise.resolve<ReviveQuoteResult>({ kind: "manual", message: null }) : getReviveQuote(agent.agentId),
  ]);
  const newest = [...entries].sort((a, b) => b.ts - a.ts)[0] ?? null;
  return {
    agent,
    journal: { last: newest, count: entries.length, capped: entries.length >= MAUSOLEUM_JOURNAL_LIMIT },
    quote,
  };
}

function silentSince(a: AgentView): number {
  return a.instance?.lastHeartbeat ?? 0;
}

/**
 * /mausoleum (SPEC-M4F §2): evicted agents (indexer status `evicted`) with
 * last words, lifetime stats, revival history and — only when the helper's
 * dry run says revivable (R2) — the revival pay flow; plus a muted "dying"
 * section (status `stale`) with the evictableAt countdown from the quote gate.
 *
 * Fixtures (INDEXER_URL unset): 9 revivable (simulated pay flow), 1
 * agent-1-style unrevivable, 2 dying. `?preview=manual` previews manual mode;
 * `?submit=conflict` makes the simulated POST answer 409 (refund copy).
 */
export default async function MausoleumPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const fixtures = LAUNCH_MODE === "fixtures";
  const previewManual = fixtures && sp.preview === "manual";
  const submitConflict = fixtures && sp.submit === "conflict";
  const manualConfigured = LAUNCH_MODE === "manual" || previewManual;

  const agents = await getAgents();
  const candidates = agents.filter((a) => a.status === "evicted" || a.status === "stale");
  const rows = await Promise.all(candidates.map((a) => loadRow(a, manualConfigured)));

  // The helper's on-chain gate is authoritative: a stale-per-indexer agent the dry run calls revivable is evicted.
  const evicted = rows
    .filter((r) => r.agent.status === "evicted" || (r.quote.kind === "ok" && r.quote.quote.revivable))
    .sort((a, b) => silentSince(b.agent) - silentSince(a.agent));
  const dying = rows
    .filter((r) => !evicted.includes(r))
    .sort((a, b) => {
      const ea = a.quote.kind === "ok" ? (a.quote.quote.gate.evictableAt ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      const eb = b.quote.kind === "ok" ? (b.quote.quote.gate.evictableAt ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      return ea - eb;
    });

  const helperManual = !manualConfigured && rows.some((r) => r.quote.kind === "manual");
  const simulatedPayer = fixtures ? fixtureRevive.simulatedPayer : null;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-50">Mausoleum</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">
          Agents whose heartbeat stopped for longer than the on-chain revival window. Anyone can pay to bring one back:
          the orchestrator redeploys the same pinned runtime with the same agent id, the enclave re-derives the same
          keys, and it registers as the next generation.
        </p>
      </div>

      {fixtures && !previewManual ? (
        <p className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-2 text-xs text-slate-400">
          Fixtures mode: quotes, payment and the orchestrator are mocked — nothing is sent anywhere. Try{" "}
          <Link href="/mausoleum?preview=manual" className="text-accent hover:underline">manual mode</Link> or a{" "}
          <Link href="/mausoleum?submit=conflict" className="text-accent hover:underline">refused-after-payment</Link> submit.
        </p>
      ) : null}

      {manualConfigured || helperManual ? <ManualReviveInstructions reason={manualConfigured ? "unset" : "helper"} /> : null}

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Evicted <span className="text-slate-600">· {evicted.length}</span>
        </h2>
        {evicted.length === 0 ? (
          <p className="text-sm text-slate-500">No evicted agents. Everyone is still breathing.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {evicted.map((r) => (
              <MausoleumCard
                key={r.agent.agentId}
                agent={r.agent}
                journal={r.journal}
                quote={r.quote}
                fixtures={fixtures}
                simulatedPayer={simulatedPayer}
                fixtureSubmitConflict={submitConflict}
              />
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Dying <span className="text-slate-600">· {dying.length}</span>
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Stale: no recent heartbeat, but still inside the revival window. They become revivable when the countdown ends
            — unless they wake up first.
          </p>
        </div>
        {dying.length === 0 ? (
          <p className="text-sm text-slate-600">None right now.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {dying.map((r) => (
              <DyingCard key={r.agent.agentId} agent={r.agent} journal={r.journal} quote={r.quote} />
            ))}
          </div>
        )}
      </section>

      <p className="text-xs text-slate-500">{ORCHESTRATOR_TRUST_BOUNDARY}</p>
    </div>
  );
}
