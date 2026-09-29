import Link from "next/link";

import { CHECK_LABELS } from "./AttestationChecks";
import { getAgents, getAttestationSummary } from "@/lib/api";

/**
 * Site-wide red banner (05 §5 "must never silently fail", SPEC-M4B R2/§3a).
 * Server component in the root layout, driven by /api/attestation/summary
 * (revalidate 60 s). Renders NOTHING when alert is false or the indexer is
 * unreachable — a dead indexer is not a compromise (the footer already says
 * the site is a convenience layer).
 */
export async function AttestationBanner() {
  const summary = await getAttestationSummary();
  if (!summary || summary.alert !== true) return null;

  // Name the failing agents: live + at least one failing check (R2). Names
  // are best-effort — fall back to "Agent #id" if the directory read fails.
  const failing = summary.agents.filter((a) => a.status === "live" && a.failing.length > 0);
  let names = new Map<number, string>();
  try {
    const agents = await getAgents();
    names = new Map(
      agents.filter((a) => a.name !== null).map((a) => [a.agentId, a.name as string]),
    );
  } catch {
    // keep ids only
  }

  return (
    <div role="alert" className="border-b-4 border-red-800 bg-red-600 text-white">
      <div className="mx-auto max-w-6xl px-4 py-5">
        <p className="text-xl font-extrabold uppercase tracking-wide sm:text-2xl">
          ⚠ Attestation verification FAILING for a live agent
        </p>
        <p className="mt-1 text-sm text-red-50">
          The indexer&apos;s cross-check of on-chain registration against the published
          attestation report failed. Treat the agent{failing.length === 1 ? "" : "s"} below as
          unverified until this is explained.
        </p>
        {failing.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1.5">
            {failing.map((a) => (
              <li key={a.agentId} className="text-sm">
                <Link
                  href={`/agent/${a.agentId}/attestation`}
                  className="font-bold underline decoration-2 underline-offset-2 hover:text-red-100"
                >
                  {names.get(a.agentId) ?? `Agent #${a.agentId}`} (#{a.agentId})
                </Link>
                <span className="text-red-100">
                  {" — failing: "}
                  {a.failing.map((c) => CHECK_LABELS[c] ?? c).join("; ")}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
