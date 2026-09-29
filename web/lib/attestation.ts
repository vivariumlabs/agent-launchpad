/**
 * Wire -> view normalization for the indexer's attestation endpoints
 * (SPEC-M4B §1c). The pinned contract left `checks` / `verifiedAt` shapes
 * open; the indexer serves `checks` as [{name, status, detail}] and
 * `verifiedAt` as unix seconds, the spec sketch as a name->result record and
 * a string. Accept both, strictly: anything unrecognized degrades to
 * "pending" (never "pass" — R1) or null (never NaN).
 */
import { parseTimestamp } from "./format";
import type {
  AgentStatus,
  AttestationCheckName,
  AttestationChecks,
  AttestationReportFields,
  AttestationSummary,
  AttestationSummaryAgent,
  AttestationView,
  CheckResult,
  GenerationRecord,
} from "./types";

export const CHECK_NAMES: AttestationCheckName[] = [
  "refShape",
  "itemFound",
  "reportParses",
  "eoasMatch",
  "configHashMatch",
  "imageIdMatch",
  "releaseMatch",
  // SPEC-M4D R3 — known names, so the indexer's verdicts are shown (an unknown name is ignored and
  // an absent one stays "pending", e.g. against a pre-M4D indexer).
  "quoteValid",
  "measurementMatch",
];

const RESULTS: readonly CheckResult[] = ["pass", "fail", "pending", "skip"];
const STATUSES: readonly AgentStatus[] = ["live", "stale", "evicted", "pending"];

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function result(v: unknown): CheckResult {
  return typeof v === "string" && (RESULTS as readonly string[]).includes(v)
    ? (v as CheckResult)
    : "pending";
}

function isCheckName(v: unknown): v is AttestationCheckName {
  return typeof v === "string" && (CHECK_NAMES as string[]).includes(v);
}

/** unix seconds from a number or a timestamp string; null otherwise. */
export function toUnixSeconds(v: unknown): number | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v >= 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  }
  if (typeof v === "string") return parseTimestamp(v);
  return null;
}

function normalizeChecks(raw: unknown): {
  checks: AttestationChecks;
  checkDetails: Partial<Record<AttestationCheckName, string>>;
} {
  const checks = Object.fromEntries(CHECK_NAMES.map((n) => [n, "pending"])) as AttestationChecks;
  const checkDetails: Partial<Record<AttestationCheckName, string>> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isObj(item) || !isCheckName(item.name)) continue;
      checks[item.name] = result(item.status ?? item.result);
      const d = str(item.detail);
      if (d) checkDetails[item.name] = d;
    }
  } else if (isObj(raw)) {
    for (const n of CHECK_NAMES) checks[n] = result(raw[n]);
  }
  return { checks, checkDetails };
}

function normalizeHistory(raw: unknown): GenerationRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: GenerationRecord[] = [];
  for (const g of raw) {
    if (!isObj(g)) continue;
    const generation = typeof g.generation === "number" && Number.isFinite(g.generation) ? g.generation : null;
    const treasuryEOA = str(g.treasuryEOA);
    const actionEOA = str(g.actionEOA);
    const codeHash = str(g.codeHash);
    const txHash = str(g.txHash);
    const ts = toUnixSeconds(g.ts);
    if (generation === null || !treasuryEOA || !actionEOA || !codeHash || !txHash || ts === null) continue;
    out.push({ generation, treasuryEOA, actionEOA, codeHash, ts, txHash });
  }
  return out;
}

function normalizeReport(raw: unknown): AttestationReportFields | null {
  if (!isObj(raw)) return null;
  return {
    treasury: str(raw.treasury),
    action: str(raw.action),
    configHash: str(raw.configHash),
    imageId: str(raw.imageId),
  };
}

export function normalizeAttestation(raw: unknown): AttestationView | null {
  if (!isObj(raw)) return null;
  const { checks, checkDetails } = normalizeChecks(raw.checks);
  const vy = isObj(raw.verifyYourself) ? raw.verifyYourself : {};
  const commands = Array.isArray(vy.commands)
    ? vy.commands.filter((c): c is string => typeof c === "string")
    : [];
  return {
    checks,
    checkDetails,
    verifiedAt: toUnixSeconds(raw.verifiedAt),
    releaseVersion: str(raw.releaseVersion),
    releaseCommit: str(raw.releaseCommit),
    attestationRef: str(raw.attestationRef),
    arweaveUrl: str(raw.arweaveUrl),
    generationHistory: normalizeHistory(raw.generationHistory),
    verifyYourself: { imageId: str(vy.imageId), enclaveIpHint: str(vy.enclaveIpHint), commands },
    report: normalizeReport(raw.report),
  };
}

export function normalizeSummary(raw: unknown): AttestationSummary | null {
  if (!isObj(raw) || typeof raw.alert !== "boolean" || !Array.isArray(raw.agents)) return null;
  const agents: AttestationSummaryAgent[] = [];
  for (const a of raw.agents) {
    if (!isObj(a) || typeof a.agentId !== "number") continue;
    const status =
      typeof a.status === "string" && (STATUSES as readonly string[]).includes(a.status)
        ? (a.status as AgentStatus)
        : "pending";
    const failing = Array.isArray(a.failing) ? a.failing.filter(isCheckName) : [];
    agents.push({ agentId: a.agentId, status, worst: result(a.worst), failing });
  }
  const v = raw.verifiedAt;
  return {
    alert: raw.alert,
    agents,
    verifiedAt: typeof v === "string" || typeof v === "number" ? v : null,
  };
}
