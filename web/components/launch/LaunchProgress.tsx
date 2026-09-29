"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { CopyButton } from "../CopyButton";
import { ARWEAVE_GATEWAY, LAUNCH_TIMEOUT_SECONDS, ORCHESTRATOR_TRUST_BOUNDARY } from "@/lib/config";
import { truncateAddress } from "@/lib/format";
import type { AttestationChecks, LaunchStatus } from "@/lib/types";

type StepState = "done" | "active" | "waiting" | "failed" | "skipped";

const STEP_ICON: Record<StepState, string> = {
  done: "✅",
  active: "⏳",
  waiting: "○",
  failed: "❌",
  skipped: "—",
};

const STEP_STYLE: Record<StepState, string> = {
  done: "text-slate-200",
  active: "text-accent",
  waiting: "text-slate-500",
  failed: "text-red-300",
  skipped: "text-slate-400",
};

function checksVerdict(
  checks: AttestationChecks | null,
): "none" | "green" | "fail" | "pending" | "unverifiable" {
  if (!checks) return "none";
  const values = Object.values(checks);
  if (values.includes("fail")) return "fail";
  // Local (drill-style) ref: nothing was verified — never render it as ✅ (R1).
  if (checks.refShape === "skip") return "unverifiable";
  if (values.includes("pending")) return "pending";
  // "green" = nothing failing or pending; a skipped releaseMatch (no release table) is allowed.
  return "green";
}

function isTerminal(s: LaunchStatus | null): boolean {
  return s?.state === "live" || s?.state === "graduated" || s?.state === "cancelled";
}

/** Poll interval: fixtures simulate a ~30 s timeline; live genesis takes minutes. */
function pollMs(fixtures: boolean): number {
  return fixtures ? 2000 : 10000;
}

/**
 * Launch progress tracker (SPEC-M4B §3b), polling the web's
 * /api/launch/status/:id (which reads the indexer server-side). Steps:
 * Requested (row exists) → TEE booted & attested (instance row) → checks
 * green (attestation endpoint) → Live (factory state).
 */
export function LaunchProgress({
  agentId,
  since,
  predicted,
  tx,
  configTxId = null,
  fixtures,
}: {
  agentId: number;
  since: number | null;
  predicted: number | null;
  tx: string | null;
  /** SPEC-M4E R3: the published config's Arweave item id, when known (from the launch flow). */
  configTxId?: string | null;
  fixtures: boolean;
}) {
  const [start, setStart] = useState<number | null>(since);
  const [now, setNow] = useState<number | null>(null);
  const [status, setStatus] = useState<LaunchStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  // No `since` in the URL => start the clock at first client render (avoids SSR/CSR mismatch).
  useEffect(() => {
    if (start === null) setStart(Math.floor(Date.now() / 1000));
  }, [start]);

  useEffect(() => {
    if (start === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      setNow(Math.floor(Date.now() / 1000));
      try {
        const res = await fetch(`/api/launch/status/${agentId}?since=${start}`, { cache: "no-store" });
        const body: unknown = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          const e = (body as { error?: unknown } | null)?.error;
          setPollError(typeof e === "string" ? e : `status ${res.status}`);
        } else {
          setPollError(null);
          const s = body as LaunchStatus;
          setStatus(s);
          if (isTerminal(s)) return; // stop polling
        }
      } catch (err) {
        if (!cancelled) setPollError(err instanceof Error ? err.message : String(err));
      }
      if (!cancelled) timer = setTimeout(poll, pollMs(fixtures));
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agentId, start, fixtures]);

  const verdict = checksVerdict(status?.checks ?? null);
  const live = status?.state === "live" || status?.state === "graduated";
  const cancelledLaunch = status?.state === "cancelled";

  const s1: StepState = status?.exists ? "done" : "active";
  const s2: StepState = status?.hasInstance ? "done" : s1 === "done" ? "active" : "waiting";
  const s3: StepState =
    verdict === "fail"
      ? "failed"
      : verdict === "green"
        ? "done"
        : verdict === "unverifiable"
          ? "skipped"
          : s2 === "done"
          ? "active"
          : "waiting";
  const s4: StepState = live ? "done" : s3 === "done" || s3 === "skipped" ? "active" : "waiting";

  const steps: { state: StepState; label: string; detail: string }[] = [
    {
      state: s1,
      label: "Requested",
      detail: "createAgent landed; the factory escrows your fee and opens the genesis window.",
    },
    {
      state: s2,
      label: "TEE booted & attested",
      detail: "The orchestrator deployed the pinned runtime; the enclave derived its keys and registered on-chain.",
    },
    {
      state: s3,
      label: "Attestation checks green",
      detail:
        verdict === "fail"
          ? "A check FAILED — see the attestation tab. Do not treat this agent as verified."
          : verdict === "unverifiable"
            ? "Local attestation ref (drill) — no Arweave report to check."
            : "The indexer cross-checks the Arweave attestation report against the chain.",
    },
    {
      state: s4,
      label: "Live",
      detail: "finalize(): token + curve deployed, agent NFT minted to you.",
    },
  ];

  const elapsed = start !== null && now !== null ? now - start : null;
  const timedOut = !live && !cancelledLaunch && elapsed !== null && elapsed > LAUNCH_TIMEOUT_SECONDS;

  return (
    <div className="flex flex-col gap-5">
      {predicted !== null && predicted !== agentId ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          Another launch landed first: your agent was assigned id #{agentId}, not the predicted #
          {predicted}. The frozen config names #{predicted}, so genesis is expected to reject it
          (config-hash mismatch). If no instance registers within 24 h you can reclaim the fee via{" "}
          <span className="font-mono">cancel({agentId})</span>.
        </div>
      ) : null}

      {tx ? (
        <p className="flex items-center gap-1 text-xs text-slate-500">
          createAgent tx <span className="font-mono text-slate-300">{truncateAddress(tx, 8)}</span>
          <CopyButton value={tx} label="transaction hash" />
        </p>
      ) : null}

      <p className="text-xs text-slate-500">
        {configTxId ? (
          <>
            Config published to Arweave:{" "}
            <a
              href={`${ARWEAVE_GATEWAY}/${configTxId}`}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-accent hover:underline"
            >
              ar://{truncateAddress(configTxId, 6)} ↗
            </a>{" "}
            <CopyButton value={`ar://${configTxId}`} label="Arweave ref" />
            {" "}— the orchestrator discovers it by its configHash tag. Arweave indexing can lag a few minutes, so
            &ldquo;TEE booted&rdquo; may wait on it; that is expected, not a failure.
          </>
        ) : (
          <>
            Genesis needs your config to be discoverable on Arweave (the launch flow publishes it before the
            transaction). Arweave indexing can lag a few minutes after publishing, so &ldquo;TEE booted&rdquo; may wait
            on it.
          </>
        )}
      </p>

      <ol className="flex flex-col divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/40">
        {steps.map((step) => (
          <li key={step.label} className="flex items-start gap-3 px-4 py-3">
            <span className="w-6 shrink-0 text-center leading-5" aria-hidden>
              {STEP_ICON[step.state]}
            </span>
            <div>
              <p className={`text-sm font-medium ${STEP_STYLE[step.state]}`}>{step.label}</p>
              <p className="text-xs text-slate-500">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>

      {cancelledLaunch ? (
        <p className="rounded-md border border-slate-700 bg-slate-900/60 p-3 text-sm text-slate-300">
          This launch was cancelled and the USDG creation fee refunded to the creator.
        </p>
      ) : null}

      {live ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
          {status?.name ?? `Agent #${agentId}`} is live.{" "}
          {fixtures ? (
            <span className="text-emerald-300/70">(Fixtures: the simulated agent has no profile page.)</span>
          ) : (
            <Link href={`/agent/${agentId}`} className="font-medium underline">
              Open its profile →
            </Link>
          )}
        </div>
      ) : null}

      {timedOut ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          This is taking longer than expected ({Math.floor((elapsed ?? 0) / 60)} min). Genesis usually
          completes within about 10 minutes; the orchestrator retries on its own. If no enclave
          registers within 24 h of your createAgent, you can call{" "}
          <span className="font-mono">cancel({agentId})</span> on the factory to reclaim the USDG
          creation fee (the optional ETH gas contribution is not refundable).
        </div>
      ) : null}

      {pollError ? (
        <p className="text-xs text-amber-400">
          Could not read progress right now ({pollError}) — retrying. The launch itself is on-chain
          and does not depend on this page.
        </p>
      ) : status === null ? (
        <p className="text-xs text-slate-500">Reading progress…</p>
      ) : null}

      <p className="text-xs text-slate-500">{ORCHESTRATOR_TRUST_BOUNDARY}</p>
    </div>
  );
}
