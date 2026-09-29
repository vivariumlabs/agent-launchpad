"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { CopyButton } from "../CopyButton";
import { ORCHESTRATOR_TRUST_BOUNDARY } from "@/lib/config";
import { formatAbsoluteTime, truncateAddress } from "@/lib/format";
import { pickRevival, trackerSteps, type StepState, type TrackerStep } from "@/lib/revive";
import type { ReviveStatus } from "@/lib/types";

const STEP_ICON: Record<StepState, string> = { done: "✅", active: "⏳", waiting: "○", failed: "❌" };
const STEP_STYLE: Record<StepState, string> = {
  done: "text-slate-200",
  active: "text-accent",
  waiting: "text-slate-500",
  failed: "text-red-300",
};

function isStatus(v: unknown): v is ReviveStatus {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s.agentId === "number" && Array.isArray(s.revivals) && typeof s.helper === "string";
}

function stepText(key: TrackerStep["key"], newGen: number | null): { label: string; detail: string } {
  switch (key) {
    case "verified":
      return {
        label: "Payment verified",
        detail: "The launch helper read your USDC transfer on-chain: right recipient, enough, succeeded, never used before.",
      };
    case "queued":
      return { label: "Queued", detail: "Waiting for the orchestrator's deploy slot — it runs one deploy at a time." };
    case "deploying":
      return {
        label: "Deploying",
        detail: "Same pinned runtime (the release matching the registered code hash), same agent id, on Oyster.",
      };
    case "registered":
      return {
        label: newGen !== null ? `Registered — generation ${newGen}` : "Registered — next generation",
        detail: "The enclave re-derived its keys, restored its newest snapshot and called registerInstance. The generation bump on-chain is the proof.",
      };
    case "live":
      return { label: "Seeded & live", detail: "Gas seeded; heartbeats resume. It leaves the mausoleum." };
  }
}

/**
 * Revival tracker (SPEC-M4F §2; launch-tracker pattern): polls the web's
 * /api/revive/status/:id (helper revival rows + the indexer's instance row).
 */
export function RevivalTracker({
  agentId,
  since,
  tx,
  revivalId,
  startGen,
  fixtures,
  sim,
}: {
  agentId: number;
  since: number | null;
  tx: string | null;
  revivalId: string | null;
  startGen: number | null;
  fixtures: boolean;
  sim: "fail" | null;
}) {
  const [status, setStatus] = useState<ReviveStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const q = new URLSearchParams();
    if (since !== null) q.set("since", String(since));
    if (fixtures && sim) q.set("sim", sim);
    const qs = q.toString();

    async function poll() {
      try {
        const res = await fetch(`/api/revive/status/${agentId}${qs ? `?${qs}` : ""}`, { cache: "no-store" });
        const body: unknown = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !isStatus(body)) {
          const e = (body as { error?: unknown } | null)?.error;
          setPollError(typeof e === "string" ? e : `status ${res.status}`);
        } else {
          setPollError(null);
          setStatus(body);
          const row = pickRevival(body.revivals, revivalId, since);
          if (row?.state === "LIVE" || row?.state === "FAILED") return; // terminal: stop polling
        }
      } catch (err) {
        if (!cancelled) setPollError(err instanceof Error ? err.message : String(err));
      }
      if (!cancelled) timer = setTimeout(poll, fixtures ? 2000 : 10000);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agentId, since, revivalId, fixtures, sim]);

  const row = status ? pickRevival(status.revivals, revivalId, since) : null;
  const startGeneration = row?.startGeneration ?? startGen;
  const newGen = startGeneration !== null ? startGeneration + 1 : null;
  const { steps, live, failed } = trackerSteps({
    paymentAccepted: revivalId !== null || tx !== null,
    row,
    startGeneration,
    indexerGeneration: status?.generation ?? null,
    indexerStatus: status?.status ?? null,
  });
  const nothingToFollow = status !== null && status.helper === "ok" && row === null && revivalId === null && tx === null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        {tx ? (
          <span className="flex items-center gap-1">
            payment tx <span className="font-mono text-slate-300">{truncateAddress(tx, 8)}</span>
            <CopyButton value={tx} label="payment transaction hash" />
          </span>
        ) : null}
        {(row?.revivalId ?? revivalId) !== null ? <span>revival #{row?.revivalId ?? revivalId}</span> : null}
        {row?.payer ? (
          <span>
            reviver <span className="font-mono text-slate-300">{truncateAddress(row.payer, 4)}</span>
          </span>
        ) : null}
        {row?.startedAt != null ? <span>queued {formatAbsoluteTime(row.startedAt)}</span> : null}
        <span>
          on-chain generation{" "}
          <span className="font-mono text-slate-300">{status?.generation ?? "—"}</span>
          {startGeneration !== null ? <span className="text-slate-600"> (was {startGeneration})</span> : null}
        </span>
      </div>

      {nothingToFollow ? (
        <p className="rounded-md border border-slate-700 bg-slate-900/60 p-3 text-sm text-slate-300">
          No revival of this agent is on record.{" "}
          <Link href="/mausoleum" className="text-accent hover:underline">
            Back to the mausoleum
          </Link>
        </p>
      ) : (
        <ol className="flex flex-col divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/40">
          {steps.map((step) => {
            const t = stepText(step.key, newGen);
            return (
              <li key={step.key} className="flex items-start gap-3 px-4 py-3">
                <span className="w-6 shrink-0 text-center leading-5" aria-hidden>
                  {STEP_ICON[step.state]}
                </span>
                <div>
                  <p className={`text-sm font-medium ${STEP_STYLE[step.state]}`}>{t.label}</p>
                  <p className="text-xs text-slate-500">{t.detail}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {failed ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          The revival failed{row?.failReason ? ` (${row.failReason})` : ""}.
          {row?.lastError ? <span className="mt-1 block font-mono text-xs text-red-300/80">{row.lastError}</span> : null}
          <span className="mt-1 block text-xs">
            Your fee is returned by the operator (manual on testnet) — keep the payment transaction hash as your receipt.
          </span>
        </div>
      ) : null}

      {live ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
          Back from the dead{newGen !== null ? ` as generation ${newGen}` : ""}.{" "}
          <Link href={`/agent/${agentId}`} className="font-medium underline">
            Open its profile →
          </Link>
        </div>
      ) : null}

      {status?.helper === "manual" ? (
        <p className="text-xs text-amber-400">
          The revival service is in manual mode, so queue progress is not visible here — the on-chain generation above
          still is.
        </p>
      ) : status?.helper === "unreachable" ? (
        <p className="text-xs text-amber-400">
          Could not read queue progress ({status.helperError ?? "launch helper unreachable"}) — retrying. The on-chain
          generation above still updates.
        </p>
      ) : null}
      {status?.indexer === "unreachable" ? (
        <p className="text-xs text-amber-400">The indexer is unreachable — the on-chain generation cannot be shown right now.</p>
      ) : null}
      {pollError ? (
        <p className="text-xs text-amber-400">
          Could not read progress right now ({pollError}) — retrying. The revival does not depend on this page.
        </p>
      ) : status === null ? (
        <p className="text-xs text-slate-500">Reading progress…</p>
      ) : null}

      <p className="text-xs text-slate-500">{ORCHESTRATOR_TRUST_BOUNDARY}</p>
    </div>
  );
}
