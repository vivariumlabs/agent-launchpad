import { notFound } from "next/navigation";

import { AttestationCheckList, CHECK_ICON } from "@/components/AttestationChecks";
import { CopyButton } from "@/components/CopyButton";
import { StatusBadge } from "@/components/StatusBadge";
import { TxLink } from "@/components/TxLink";
import { VerifyYourself } from "@/components/VerifyYourself";
import { getAgent, getAttestation } from "@/lib/api";
import { ARWEAVE_GATEWAY, isArweaveItemId, runtimeReleaseUrl } from "@/lib/config";
import {
  formatAbsoluteTime,
  formatRelativeTime,
  sameHex,
  truncateAddress,
} from "@/lib/format";
import type {
  AgentInstance,
  AgentView,
  AttestationChecks,
  AttestationReportFields,
  AttestationView,
  CheckResult,
  GenerationRecord,
} from "@/lib/types";

export const revalidate = 30;

/** Attestation tab — the credibility product (05 §5, SPEC-M4B §3a). */
export default async function AttestationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const agent = await getAgent(id);
  if (!agent) notFound();

  const instance = agent.instance;
  if (!instance) {
    return (
      <section className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-8 text-center">
        <p className="mx-auto max-w-md text-sm text-slate-400">
          Not yet deployed — no enclave has registered for this agent, so there is nothing to
          attest yet.
        </p>
      </section>
    );
  }

  const attestation = await getAttestation(id);

  return (
    <div className="flex flex-col gap-8">
      <section>
        <SectionHeading title="Verification" />
        {attestation ? (
          <>
            <VerdictLine attestation={attestation} />
            <AttestationCheckList
              checks={attestation.checks}
              reasons={attestation.checkDetails}
              details={checkDetails(agent, instance, attestation)}
            />
          </>
        ) : (
          <p className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-6 text-sm text-slate-400">
            Attestation results are unavailable — the indexer has not published a verification
            for this agent, or it is unreachable. No verdict is shown rather than a guess.
          </p>
        )}
      </section>

      <section>
        <SectionHeading title="Wallet EOAs" />
        <EoaComparison
          instance={instance}
          history={attestation?.generationHistory ?? []}
          report={attestation?.report ?? null}
          eoasMatch={attestation?.checks.eoasMatch ?? null}
        />
      </section>

      <section>
        <SectionHeading title="Heartbeat freshness" />
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm">
          <StatusBadge status={agent.status} />
          <span className="text-slate-300" title={formatAbsoluteTime(instance.lastHeartbeat)}>
            last heartbeat {formatRelativeTime(instance.lastHeartbeat)}
          </span>
          <span className="text-xs text-slate-500">
            status is derived from the on-chain heartbeat age, not from the agent&apos;s own
            report
          </span>
        </div>
      </section>

      <section>
        <SectionHeading title="Generation history" />
        <GenerationHistory history={attestation?.generationHistory ?? []} />
      </section>

      <section>
        <SectionHeading title="Verify it yourself" />
        <VerifyYourself
          imageId={attestation?.verifyYourself.imageId ?? stripHex(instance.codeHash)}
          commands={attestation?.verifyYourself.commands ?? []}
        />
      </section>
    </div>
  );
}

function SectionHeading({ title }: { title: string }) {
  return <h2 className="mb-3 text-lg font-semibold text-slate-100">{title}</h2>;
}

function stripHex(v: string): string {
  return v.replace(/^0x/i, "");
}

function countBy(checks: AttestationChecks, result: CheckResult): number {
  return Object.values(checks).filter((r) => r === result).length;
}

function VerdictLine({ attestation }: { attestation: AttestationView }) {
  const { checks } = attestation;
  const failing = countBy(checks, "fail");
  const pending = countBy(checks, "pending");
  const skipped = countBy(checks, "skip");
  const total = Object.keys(checks).length;

  let text: string;
  let style: string;
  if (failing > 0) {
    text = `${CHECK_ICON.fail} ${failing} check${failing === 1 ? "" : "s"} FAILING`;
    style = "border-red-500/40 bg-red-500/10 text-red-300";
  } else if (checks.refShape === "skip") {
    text = `${CHECK_ICON.skip} Local ref (drill) — this agent's attestation is not published on Arweave, so it cannot be checked here`;
    style = "border-slate-700 bg-slate-900/60 text-slate-300";
  } else if (pending > 0) {
    text = `${CHECK_ICON.pending} ${pending} check${pending === 1 ? "" : "s"} pending`;
    style = "border-amber-500/30 bg-amber-500/10 text-amber-300";
  } else if (skipped > 0) {
    text = `${CHECK_ICON.pass} ${total - skipped} of ${total} checks pass (${skipped} skipped)`;
    style = "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  } else {
    text = `${CHECK_ICON.pass} All ${total} indexer checks pass`;
    style = "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  }

  const verifiedTs = attestation.verifiedAt;

  return (
    <div className={`mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-2.5 text-sm ${style}`}>
      <span>{text}</span>
      <span className="text-xs text-slate-400">
        {verifiedTs !== null ? (
          <span title={formatAbsoluteTime(verifiedTs)}>
            last verified {formatRelativeTime(verifiedTs)}
          </span>
        ) : (
          "not yet verified"
        )}
      </span>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent hover:underline"
    >
      {children}
    </a>
  );
}

function Mono({ value, title }: { value: string; title?: string }) {
  return (
    <span className="font-mono text-slate-300" title={title ?? value}>
      {truncateAddress(value, 8)}
    </span>
  );
}

function checkDetails(
  agent: AgentView,
  instance: AgentInstance,
  attestation: AttestationView,
): Partial<Record<keyof AttestationChecks, React.ReactNode>> {
  const ref = attestation.attestationRef ?? instance.attestationRef;
  const arweaveUrl =
    attestation.arweaveUrl ?? (ref && isArweaveItemId(ref) ? `${ARWEAVE_GATEWAY}/${ref}` : null);

  return {
    refShape: ref ? (
      <span className="flex flex-wrap items-center gap-1.5">
        attestationRef{" "}
        {arweaveUrl ? (
          <ExternalLink href={arweaveUrl}>
            <span className="font-mono">{truncateAddress(ref, 8)}</span> ↗
          </ExternalLink>
        ) : (
          <span className="font-mono text-slate-300">{ref}</span>
        )}
        <CopyButton value={ref} label="attestation ref" />
      </span>
    ) : (
      "no attestationRef recorded on-chain"
    ),
    itemFound: arweaveUrl ? (
      <ExternalLink href={arweaveUrl}>open the report on Arweave ↗</ExternalLink>
    ) : null,
    configHashMatch: agent.configHash ? (
      <span className="flex flex-wrap gap-x-3">
        <span>
          factory configHash <Mono value={agent.configHash} />
        </span>
        {attestation.report?.configHash ? (
          <span>
            report <Mono value={attestation.report.configHash} />
          </span>
        ) : null}
      </span>
    ) : null,
    imageIdMatch: (
      <span className="flex flex-wrap gap-x-3">
        <span>
          registered codeHash <Mono value={instance.codeHash} />
        </span>
        {attestation.report?.imageId ? (
          <span>
            report <Mono value={attestation.report.imageId} />
          </span>
        ) : null}
      </span>
    ),
    releaseMatch: attestation.releaseVersion ? (
      <ExternalLink href={runtimeReleaseUrl(attestation.releaseVersion)}>
        runtime v{attestation.releaseVersion.replace(/^v/, "")} release ↗
        {attestation.releaseCommit ? ` (commit ${attestation.releaseCommit.slice(0, 7)})` : ""}
      </ExternalLink>
    ) : null,
  };
}

const EOAS_MATCH_TEXT: Record<CheckResult, string> = {
  pass: "✅ the Arweave attestation report names these same EOAs",
  fail: "❌ the Arweave attestation report names DIFFERENT EOAs",
  pending: "⏳ the report's EOAs have not been checked yet",
  skip: "— local ref (drill): no Arweave report to compare",
};

function Compared({ value, against }: { value: string | null; against: string }) {
  if (value === null) return <span className="text-slate-600">—</span>;
  const same = sameHex(value, against);
  return (
    <span className="flex items-center gap-1.5">
      <Mono value={value} />
      <span className={same ? "text-emerald-400" : "text-red-400"}>{same ? "= same" : "≠ differs"}</span>
    </span>
  );
}

/**
 * Registry values side-by-side with (a) the latest InstanceRegistered event
 * and (b) the Arweave report's own EOAs when the indexer exposes them. The
 * eoasMatch verdict (the indexer's check) is stated below either way.
 */
function EoaComparison({
  instance,
  history,
  report,
  eoasMatch,
}: {
  instance: AgentInstance;
  history: GenerationRecord[];
  report: AttestationReportFields | null;
  eoasMatch: CheckResult | null;
}) {
  const latest = [...history].sort((a, b) => b.generation - a.generation)[0] ?? null;
  const showReport = report !== null && (report.treasury !== null || report.action !== null);
  const rows: { role: string; registry: string; event: string | null; report: string | null }[] = [
    {
      role: "Treasury",
      registry: instance.treasuryEOA,
      event: latest?.treasuryEOA ?? null,
      report: report?.treasury ?? null,
    },
    {
      role: "Action",
      registry: instance.actionEOA,
      event: latest?.actionEOA ?? null,
      report: report?.action ?? null,
    },
  ];

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="text-[11px] uppercase tracking-wide text-slate-500">
            <tr className="border-b border-slate-800">
              <th className="px-4 py-2 font-normal">EOA</th>
              <th className="px-4 py-2 font-normal">Registry (instanceOf)</th>
              <th className="px-4 py-2 font-normal">
                Registration event{latest ? ` (gen ${latest.generation})` : ""}
              </th>
              {showReport ? <th className="px-4 py-2 font-normal">Attestation report</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              return (
                <tr key={row.role} className="border-b border-slate-800 last:border-0">
                  <td className="px-4 py-2 text-slate-400">{row.role}</td>
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-1">
                      <Mono value={row.registry} />
                      <CopyButton value={row.registry} label={`${row.role} EOA`} />
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <Compared value={row.event} against={row.registry} />
                  </td>
                  {showReport ? (
                    <td className="px-4 py-2">
                      <Compared value={row.report} against={row.registry} />
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-slate-800 px-4 py-2 text-xs text-slate-400">
        {eoasMatch === null
          ? "Attestation report comparison unavailable."
          : EOAS_MATCH_TEXT[eoasMatch]}
      </p>
    </div>
  );
}

function GenerationHistory({ history }: { history: GenerationRecord[] }) {
  if (history.length === 0) {
    return <p className="text-sm text-slate-500">No registrations recorded yet.</p>;
  }
  const sorted = [...history].sort((a, b) => b.generation - a.generation);
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/40">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="text-[11px] uppercase tracking-wide text-slate-500">
          <tr className="border-b border-slate-800">
            <th className="px-4 py-2 font-normal">Gen</th>
            <th className="px-4 py-2 font-normal">Treasury</th>
            <th className="px-4 py-2 font-normal">Action</th>
            <th className="px-4 py-2 font-normal">Code hash</th>
            <th className="px-4 py-2 font-normal">When</th>
            <th className="px-4 py-2 font-normal">Tx</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((g) => (
            <tr key={`${g.generation}-${g.txHash}`} className="border-b border-slate-800 last:border-0">
              <td className="px-4 py-2 text-slate-300">
                {g.generation}
                {g.generation <= 1 ? (
                  <span className="ml-1.5 text-xs text-slate-500">genesis</span>
                ) : (
                  <span className="ml-1.5 text-xs text-slate-500">revival</span>
                )}
              </td>
              <td className="px-4 py-2"><Mono value={g.treasuryEOA} /></td>
              <td className="px-4 py-2"><Mono value={g.actionEOA} /></td>
              <td className="px-4 py-2"><Mono value={g.codeHash} /></td>
              <td className="px-4 py-2 text-xs text-slate-500" title={formatAbsoluteTime(g.ts)}>
                {formatRelativeTime(g.ts)}
              </td>
              <td className="px-4 py-2"><TxLink txHash={g.txHash} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
