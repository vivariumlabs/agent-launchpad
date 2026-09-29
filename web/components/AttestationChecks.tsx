import type { ReactNode } from "react";

import type { AttestationCheckName, AttestationChecks, CheckResult } from "@/lib/types";

/** ✅/❌/⏳/— per SPEC-M4B §3a. Only an indexer-run `pass` ever shows ✅ (R1). */
export const CHECK_ICON: Record<CheckResult, string> = {
  pass: "✅",
  fail: "❌",
  pending: "⏳",
  skip: "—",
};

const RESULT_TEXT: Record<CheckResult, string> = {
  pass: "pass",
  fail: "FAIL",
  pending: "pending",
  skip: "skipped",
};

const RESULT_STYLE: Record<CheckResult, string> = {
  pass: "text-emerald-400",
  fail: "text-red-400 font-semibold",
  pending: "text-amber-400",
  skip: "text-slate-500",
};

/** Human labels, in the indexer's evaluation order (SPEC-M4B §1b). */
export const CHECK_LABELS: Record<AttestationCheckName, string> = {
  refShape: "Attestation ref is an Arweave item id",
  itemFound: "Attestation report found on Arweave",
  reportParses: "Report is a well-formed attestation report",
  eoasMatch: "Report EOAs = registry EOAs",
  configHashMatch: "Report config hash = factory-anchored config hash",
  imageIdMatch: "Report image-id = registered code hash",
  releaseMatch: "Code hash is in a published runtime release",
};

export const CHECK_ORDER: AttestationCheckName[] = [
  "refShape",
  "itemFound",
  "reportParses",
  "eoasMatch",
  "configHashMatch",
  "imageIdMatch",
  "releaseMatch",
];

/** Why a check is skipped — bounded honesty, never a guess beyond what the verdicts imply. */
function skipReason(name: AttestationCheckName, checks: AttestationChecks): string {
  if (checks.refShape === "skip") return "local ref (drill)";
  if (name === "releaseMatch") return "no release table";
  return "not applicable";
}

function pendingReason(): string {
  return "not yet verifiable (Arweave unreachable or not yet checked)";
}

export function CheckRow({
  icon,
  label,
  result,
  resultStyle,
  note,
  detail,
}: {
  icon: string;
  label: string;
  result: string;
  resultStyle: string;
  note?: string | null;
  detail?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 text-sm">
      <span className="w-6 shrink-0 text-center text-base leading-5" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="text-slate-200">{label}</span>
          <span className={`text-xs uppercase tracking-wide ${resultStyle}`}>{result}</span>
        </div>
        {note ? <p className="mt-0.5 text-xs text-slate-500">{note}</p> : null}
        {detail ? <div className="mt-1 text-xs text-slate-400">{detail}</div> : null}
      </div>
    </li>
  );
}

/** The seven indexer checks plus the R1 quote-signature row (never ✅ this slice). */
export function AttestationCheckList({
  checks,
  reasons,
  details,
}: {
  checks: AttestationChecks;
  /** Indexer-provided reason per non-pass check, shown instead of the generic note. */
  reasons: Partial<Record<AttestationCheckName, string>>;
  details: Partial<Record<AttestationCheckName, ReactNode>>;
}) {
  return (
    <ul className="flex flex-col divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/40">
      {CHECK_ORDER.map((name) => {
        const result = checks[name];
        const reason = result !== "pass" ? (reasons[name] ?? null) : null;
        const note = result === "pending" ? (reason ?? pendingReason()) : reason;
        return (
          <CheckRow
            key={name}
            icon={CHECK_ICON[result]}
            label={CHECK_LABELS[name]}
            result={`${RESULT_TEXT[result]}${result === "skip" ? ` — ${skipReason(name, checks)}` : ""}`}
            resultStyle={RESULT_STYLE[result]}
            note={note}
            detail={details[name]}
          />
        );
      })}
      <CheckRow
        icon="—"
        label="TEE quote signature (AWS Nitro root)"
        result="not re-verified here"
        resultStyle="text-slate-500"
        note="This site does not re-verify the raw attestation quote signature — use “Verify it yourself” below."
      />
    </ul>
  );
}
