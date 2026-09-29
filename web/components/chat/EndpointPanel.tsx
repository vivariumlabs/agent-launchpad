"use client";

import { useState } from "react";

import { parseEndpoint, type EndpointCheck, type HealthResult } from "@/lib/chat";
import type { AgentStatus } from "@/lib/types";

export type HealthState = { kind: "probing" } | HealthResult;

/**
 * Endpoint (R3) + health probe (05 §4). The override is component state only —
 * no storage; `?endpoint=` seeds it. Non-TLS endpoints are labeled
 * "unencrypted (drill)".
 */
export function EndpointPanel({
  endpoint,
  inputInitial,
  defaultEndpoint,
  onApply,
  health,
  onRetry,
  status,
  fixtures,
}: {
  endpoint: EndpointCheck;
  inputInitial: string;
  defaultEndpoint: string;
  onApply: (raw: string) => void;
  health: HealthState | null;
  onRetry: () => void;
  status: AgentStatus;
  fixtures: boolean;
}) {
  const [input, setInput] = useState(inputInitial);
  const draft = parseEndpoint(input);
  const isDefault = endpoint.ok && endpoint.origin === defaultEndpoint;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs uppercase tracking-wide text-slate-500">Agent endpoint</span>
        {endpoint.ok ? (
          <>
            <span className="break-all font-mono text-slate-200">{endpoint.origin}</span>
            {endpoint.secure ? (
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400">
                TLS
              </span>
            ) : (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-400">
                unencrypted (drill)
              </span>
            )}
            {!isDefault ? <span className="text-xs text-slate-500">override</span> : null}
          </>
        ) : (
          <span className="text-red-300">{endpoint.error}</span>
        )}
      </div>

      <HealthLine endpoint={endpoint} health={health} onRetry={onRetry} status={status} fixtures={fixtures} />

      <details className="text-sm" open={!endpoint.ok}>
        <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-200">Advanced: override the endpoint</summary>
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.ok) onApply(draft.origin);
          }}
        >
          <p className="text-xs text-slate-500">
            For drill agents and self-verifiers. Default: <span className="font-mono">{defaultEndpoint}</span>. Kept in
            this page only (also settable with <span className="font-mono">?endpoint=</span>). The SIWE domain you sign
            is this endpoint&apos;s host, so it must match the agent&apos;s frozen chat domain.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-sm text-slate-200 outline-none focus:border-accent/60"
              aria-label="Agent endpoint"
            />
            <button
              type="submit"
              disabled={!draft.ok}
              className="rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={() => {
                setInput(defaultEndpoint);
                onApply(defaultEndpoint);
              }}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-600"
            >
              Reset
            </button>
          </div>
          {!draft.ok && input.trim() !== "" ? <p className="text-xs text-red-300">{draft.error}</p> : null}
          {draft.ok && !draft.secure ? (
            <p className="text-xs text-amber-300/80">
              Unencrypted (drill): messages and your session token travel in clear text. Browsers also block http://
              requests from an https:// page (mixed content).
            </p>
          ) : null}
        </form>
      </details>
    </section>
  );
}

function HealthLine({
  endpoint,
  health,
  onRetry,
  status,
  fixtures,
}: {
  endpoint: EndpointCheck;
  health: HealthState | null;
  onRetry: () => void;
  status: AgentStatus;
  fixtures: boolean;
}) {
  if (!endpoint.ok || health === null) return null;
  const retry = (
    <button type="button" onClick={onRetry} className="text-xs text-accent hover:underline">
      Retry
    </button>
  );

  if (health.kind === "probing") {
    return <p className="text-sm text-slate-400">Checking {endpoint.origin}/health…</p>;
  }
  if (health.kind === "ok") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
        <span className="h-2 w-2 rounded-full bg-emerald-400" />
        Reachable · tier <span className="font-medium text-slate-100">{health.tier}</span>
        <span className="text-xs text-slate-500">(reported by the agent)</span>
      </p>
    );
  }
  if (health.kind === "unhealthy") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-amber-300">
        Reachable, but /health answered {health.status}: {health.detail} {retry}
      </p>
    );
  }

  // Unreachable — tier-appropriate copy per 05 §4, keyed on the INDEXER status.
  const dormant = status === "stale" || status === "evicted";
  return (
    <div className="flex flex-col gap-1 rounded-md border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm">
      {dormant ? (
        <p className="text-slate-200">Dormant — holding ≥0.1% will be honored when it wakes.</p>
      ) : status === "pending" ? (
        <p className="text-slate-200">Not yet deployed — there is no enclave to chat with yet.</p>
      ) : (
        <p className="text-slate-200">
          Unreachable — the agent&apos;s heartbeat is fresh, but {endpoint.origin} did not answer.
        </p>
      )}
      <p className="text-xs text-slate-500">
        Indexer status: {status}. Probe error: {health.detail}.{" "}
        {!dormant && !fixtures
          ? "If this is a drill agent, set its endpoint under Advanced. Runtimes before v0.1.7 send no CORS headers, so browsers cannot reach them."
          : null}{" "}
        {retry}
      </p>
    </div>
  );
}
