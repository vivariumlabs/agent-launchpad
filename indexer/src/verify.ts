// SPEC-M4B §1b verify.ts — attestation verification job (own loop, every verifySec DEFAULT 300).
//
// R1 (honest checkmarks): ONLY what public data can prove — Arweave report ↔ chain cross-checks,
// release-table membership and (SPEC-M4D) the report's raw NSM quote, re-verified in-house
// (COSE_Sign1/ES384 + x509 chain → the pinned AWS Nitro root, nsm/quote.ts). The API's "verify
// yourself" panel still carries the independent-verification commands.
// R2: a transport failure (GraphQL / gateway unreachable, HTTP error, not indexed yet) leaves the
// affected checks `pending` — never `fail` — and is warned LOUDLY. Only a property of the published
// data (oversize item, unparseable report, mismatched value, unknown image-id) is a `fail`.
//
// Per agent with an instances row (the chain's current struct):
//   1 refShape        attestationRef is a 43-char base64url Arweave id. Anything else (drill-style
//                     local ref such as "attestation-1790597593.json", or no ref) ⇒ `skip` and every
//                     downstream check `skip` ("local ref (drill)") — never `fail`.
//   2 itemFound       GraphQL lookup by id returns the item (owner recorded) AND the gateway GET (one
//                     redirect to *.arweave.net, the turboHttp rule — HttpArweaveClient.download)
//                     returns ≤ 256 KiB. Oversize ⇒ fail; unknown to GraphQL / 404 / transport ⇒ pending.
//   3 reportParses    JSON object, kind == "agent-launchpad.attestation-report", has eoas{treasury,
//                     action}, configHash, imageId (strings).
//   4 eoasMatch       report.eoas.{treasury,action} == instances row EOAs (case-insensitive).
//   5 configHashMatch report.configHash == agents.configHash (the factory-anchored value); pending
//                     while the agent's AgentRequested row is not indexed.
//   6 imageIdMatch    report.imageId == instances.codeHash (0x-stripped, case-insensitive).
//   7 releaseMatch    §1a membership of instances.codeHash (+ releaseVersion); `skip` "no release
//                     table" when releasesDir is unset.
//   8 quoteValid      SPEC-M4D R3: report.quote (quoteEncoding "base64") verifies per nsm/quote.ts
//                     (parse + COSE + chain at the doc timestamp + root pin). Missing / oversize /
//                     undecodable quote or any verification failure ⇒ fail (R2: a data property).
//   9 measurementMatch the quote's TRUE image-id (from its PCRs) == instances.codeHash (0x-/case-
//                     insensitive); `skip` unless quoteValid passed. Catches a runtime that
//                     self-reports a stale imageId (agent 10), which 4–6 cannot see.
// When the report bytes are unavailable because of a `fail` upstream, 3–6 are `skip` (not
// evaluable); when unavailable because of transport, they are `pending`. 8–9 run on bytes already
// fetched (no transport of their own, R2) so they are never `pending` after a pass: `skip` whenever
// the report is unavailable (either cause) or unparseable, like every other upstream cascade.

import type { Clock } from "./clock.js";
import { CHECK_NAMES, type AttestationCheckRow, type CheckName, type CheckStatus, type IndexerDb, type InstanceRow } from "./db.js";
import { ArweaveTooLargeError, isArweaveId } from "./enrich.js";
import { errMsg, type Logger } from "./log.js";
import { verifyQuote } from "./nsm/quote.js";
import { matchRelease, normHex, type ReleaseTable } from "./releases.js";

export const REPORT_KIND = "agent-launchpad.attestation-report";
/** §1b itemFound size bound. */
export const MAX_REPORT_BYTES = 256 * 1024;
export const VERIFY_LAST_RUN_KEY = "verify.lastRun";
/** SPEC-M4D R2 quote size bound (decoded bytes). DEFAULT — a real NSM document is ~4.5 KiB. */
export const MAX_QUOTE_BYTES = 32 * 1024;

/** The Arweave seam (HttpArweaveClient in production). */
export interface AttestationArweave {
  /** Owner of item `id` (Arweave or Ethereum address form), or null when GraphQL does not know it (yet). */
  itemOwner(id: string): Promise<string | null>;
  /** Item data; throws ArweaveTooLargeError when larger than `maxBytes`. */
  download(id: string, maxBytes: number): Promise<Uint8Array>;
}

export interface ReportFields {
  treasury: string | null;
  action: string | null;
  configHash: string | null;
  imageId: string | null;
}

/** SPEC-M4D R3 — recorded once quoteValid passed. */
export interface QuoteDetail {
  /** The image-id computed from the quote's own PCRs (lowercase hex, no 0x). */
  trueImageId: string;
  timestampMs: number;
  moduleId: string;
  rootKeyOk: true;
  /** instances.codeHash as registered. */
  registeredCodeHash: string;
  /** report.imageId as self-reported by the runtime. */
  reportImageId: string;
  /** true ⇔ the self-reported imageId ALSO differs from the quote's true image-id. */
  reportImageIdDiverges: boolean;
}

/** Stored as attestation_checks.detail (JSON). */
export interface VerifyDetail {
  /** Human-readable reason per non-pass check. */
  reasons: Partial<Record<CheckName, string>>;
  owner: string | null;
  itemBytes: number | null;
  releaseCommit: string | null;
  /** The report's cross-checked fields (null until a report parsed). */
  report: ReportFields | null;
  /** SPEC-M4D: the verified quote's facts (null unless quoteValid passed). */
  quote: QuoteDetail | null;
}

export type Checks = Record<CheckName, CheckStatus>;

const RANK: Record<CheckStatus, number> = { pass: 0, skip: 1, pending: 2, fail: 3 };

/** fail > pending > skip > pass. */
export function worstStatus(statuses: readonly CheckStatus[]): CheckStatus {
  let w: CheckStatus = "pass";
  for (const s of statuses) if (RANK[s] > RANK[w]) w = s;
  return w;
}

export function checksOf(r: AttestationCheckRow): Checks {
  return {
    refShape: r.refShape,
    itemFound: r.itemFound,
    reportParses: r.reportParses,
    eoasMatch: r.eoasMatch,
    configHashMatch: r.configHashMatch,
    imageIdMatch: r.imageIdMatch,
    releaseMatch: r.releaseMatch,
    quoteValid: r.quoteValid,
    measurementMatch: r.measurementMatch,
  };
}

/** SPEC-M4D: the report's raw NSM quote fields (as published; null when absent / not a string). */
export interface ReportQuote {
  quote: string | null;
  quoteEncoding: string | null;
}

type Parsed =
  | { ok: true; fields: { treasury: string; action: string; configHash: string; imageId: string }; quote: ReportQuote }
  | { ok: false; reason: string; fields: ReportFields | null; quote: ReportQuote | null };

/** SPEC-M4D §2: report.quote → NSM document bytes, or the fail reason. */
export function decodeReportQuote(q: ReportQuote): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
  if (q.quote === null || q.quote === "") return { ok: false, reason: "no quote in report" };
  if (q.quoteEncoding !== "base64") return { ok: false, reason: `quoteEncoding ${JSON.stringify(q.quoteEncoding)} ≠ "base64"` };
  if (q.quote.length > Math.ceil(MAX_QUOTE_BYTES / 3) * 4) return { ok: false, reason: `quote exceeds ${MAX_QUOTE_BYTES} bytes` };
  if (q.quote.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(q.quote)) return { ok: false, reason: "quote is not valid base64" };
  const bytes = Buffer.from(q.quote, "base64");
  if (bytes.toString("base64") !== q.quote) return { ok: false, reason: "quote is not canonical base64" };
  if (bytes.byteLength > MAX_QUOTE_BYTES) return { ok: false, reason: `quote exceeds ${MAX_QUOTE_BYTES} bytes` };
  return { ok: true, bytes: new Uint8Array(bytes) };
}

/** §1b check 3 (pure). */
export function parseReport(bytes: Uint8Array): Parsed {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, reason: "report is not UTF-8 JSON", fields: null, quote: null };
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: "report is not a JSON object", fields: null, quote: null };
  const o = v as Record<string, unknown>;
  const eoas = o.eoas !== null && typeof o.eoas === "object" && !Array.isArray(o.eoas) ? (o.eoas as Record<string, unknown>) : null;
  const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
  const fields: ReportFields = {
    treasury: str(eoas?.treasury),
    action: str(eoas?.action),
    configHash: str(o.configHash),
    imageId: str(o.imageId),
  };
  const quote: ReportQuote = { quote: str(o.quote), quoteEncoding: str(o.quoteEncoding) };
  if (o.kind !== REPORT_KIND) return { ok: false, reason: `kind ${JSON.stringify(o.kind)} ≠ ${JSON.stringify(REPORT_KIND)}`, fields, quote };
  if (eoas === null) return { ok: false, reason: "report has no eoas object", fields, quote };
  const missing = (Object.keys(fields) as Array<keyof ReportFields>).filter((k) => fields[k] === null);
  if (missing.length > 0) return { ok: false, reason: `report lacks ${missing.join(", ")}`, fields, quote };
  return { ok: true, fields: fields as { treasury: string; action: string; configHash: string; imageId: string }, quote };
}

export class Verifier {
  constructor(
    private readonly db: IndexerDb,
    /** null ⇒ arweave.enabled = false: checks 2–6 `skip`. */
    private readonly arweave: AttestationArweave | null,
    /** Re-read each pass; null ⇒ no releasesDir configured. May throw (unreadable dir ⇒ releaseMatch pending). */
    private readonly releases: () => ReleaseTable | null,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  /** One pass over every registered agent. Never throws. Returns rows written. */
  async runOnce(): Promise<number> {
    let table: ReleaseTable | null | "unreadable";
    try {
      table = this.releases();
    } catch (e) {
      this.log.warn(`VERIFY: release table unreadable — releaseMatch stays pending: ${errMsg(e)}`);
      table = "unreadable";
    }
    let n = 0;
    for (const inst of this.db.instances()) {
      try {
        this.db.upsertAttestationChecks(await this.verifyAgent(inst, table));
        n++;
      } catch (e) {
        this.log.warn(`VERIFY FAILED for agent ${inst.agentId} (no row written): ${errMsg(e)}`);
      }
    }
    this.db.kvSet(VERIFY_LAST_RUN_KEY, String(this.clock.now()));
    return n;
  }

  async verifyAgent(inst: InstanceRow, table: ReleaseTable | null | "unreadable"): Promise<AttestationCheckRow> {
    const agentId = inst.agentId;
    const checks: Checks = {
      refShape: "pending",
      itemFound: "pending",
      reportParses: "pending",
      eoasMatch: "pending",
      configHashMatch: "pending",
      imageIdMatch: "pending",
      releaseMatch: "pending",
      quoteValid: "pending",
      measurementMatch: "pending",
    };
    const detail: VerifyDetail = { reasons: {}, owner: null, itemBytes: null, releaseCommit: null, report: null, quote: null };
    let releaseVersion: string | null = null;
    const set = (k: CheckName, s: CheckStatus, reason?: string): void => {
      checks[k] = s;
      if (reason !== undefined) detail.reasons[k] = reason;
    };
    const row = (): AttestationCheckRow => ({ agentId, verifiedAt: Number(this.clock.now()), ...checks, releaseVersion, detail: JSON.stringify(detail) });

    // 1. refShape — non-Arweave ref ⇒ skip cascade (bounded honesty, never fail).
    const ref = inst.attestationRef;
    if (!isArweaveId(ref)) {
      const raw: string | null = inst.attestationRef; // (the type guard narrows `ref` to null here)
      const why = raw === null || raw === "" ? "no attestationRef registered" : `local ref (drill): ${raw.slice(0, 80)}`;
      for (const k of CHECK_NAMES) set(k, "skip", k === "refShape" ? why : "refShape skipped");
      return row();
    }
    set("refShape", "pass");

    // 7. releaseMatch — independent of Arweave.
    if (table === null) set("releaseMatch", "skip", "no release table");
    else if (table === "unreadable") set("releaseMatch", "pending", "release table unreadable");
    else {
      const m = matchRelease(table, inst.codeHash);
      if (m === null) set("releaseMatch", "fail", `codeHash ${inst.codeHash} is not in any published release (${table.releases.length} loaded)`);
      else {
        set("releaseMatch", "pass");
        releaseVersion = m.version;
        detail.releaseCommit = m.commit;
      }
    }

    const REPORT_CHECKS = ["reportParses", "eoasMatch", "configHashMatch", "imageIdMatch"] as const;
    const QUOTE_CHECKS = ["quoteValid", "measurementMatch"] as const;
    if (this.arweave === null) {
      set("itemFound", "skip", "arweave disabled in indexer config");
      for (const k of [...REPORT_CHECKS, ...QUOTE_CHECKS]) set(k, "skip", "arweave disabled in indexer config");
      return row();
    }

    // 2. itemFound — GraphQL owner AND gateway bytes ≤ 256 KiB.
    let ownerState: "ok" | "unknown" | "transport" = "ok";
    try {
      detail.owner = await this.arweave.itemOwner(ref);
      if (detail.owner === null) ownerState = "unknown";
    } catch (e) {
      ownerState = "transport";
      detail.reasons.itemFound = `GraphQL lookup failed: ${errMsg(e)}`;
    }
    let bytes: Uint8Array | null = null;
    let bytesState: "ok" | "too-large" | "transport" = "ok";
    try {
      bytes = await this.arweave.download(ref, MAX_REPORT_BYTES);
      detail.itemBytes = bytes.byteLength;
    } catch (e) {
      if (e instanceof ArweaveTooLargeError) bytesState = "too-large";
      else {
        bytesState = "transport";
        detail.reasons.itemFound = `gateway fetch failed: ${errMsg(e)}`;
      }
    }
    if (bytesState === "too-large") set("itemFound", "fail", `item exceeds ${MAX_REPORT_BYTES} bytes`);
    else if (bytesState === "transport" || ownerState === "transport") set("itemFound", "pending", detail.reasons.itemFound);
    else if (ownerState === "unknown") set("itemFound", "pending", "item not (yet) known to Arweave GraphQL");
    else set("itemFound", "pass");
    if (checks.itemFound === "pending") {
      this.log.warn(`VERIFY: agent ${agentId}: attestation item ${ref} not verifiable this pass (checks stay PENDING, not failed): ${detail.reasons.itemFound}`);
    }

    // 3–6 from the report bytes.
    if (bytes === null) {
      const s: CheckStatus = bytesState === "too-large" ? "skip" : "pending";
      for (const k of REPORT_CHECKS) set(k, s, bytesState === "too-large" ? "report unavailable (itemFound failed)" : "report not fetched (transport)");
      // R2: the quote checks have no transport of their own — never pending after a pass.
      for (const k of QUOTE_CHECKS) set(k, "skip", bytesState === "too-large" ? "report unavailable (itemFound failed)" : "report not fetched (transport)");
    } else {
      const p = parseReport(bytes);
      detail.report = p.fields;
      if (!p.ok) {
        set("reportParses", "fail", p.reason);
        for (const k of [...REPORT_CHECKS, ...QUOTE_CHECKS]) if (k !== "reportParses") set(k, "skip", "report unparseable");
      } else {
        set("reportParses", "pass");
        const r = p.fields;
        const treasuryOk = r.treasury.toLowerCase() === inst.treasuryEOA.toLowerCase();
        const actionOk = r.action.toLowerCase() === inst.actionEOA.toLowerCase();
        if (treasuryOk && actionOk) set("eoasMatch", "pass");
        else {
          const bad = [treasuryOk ? null : `treasury ${r.treasury} ≠ registry ${inst.treasuryEOA}`, actionOk ? null : `action ${r.action} ≠ registry ${inst.actionEOA}`].filter((x) => x !== null);
          set("eoasMatch", "fail", bad.join("; "));
        }
        const anchored = this.db.agent(agentId)?.configHash ?? null;
        if (anchored === null) set("configHashMatch", "pending", "factory configHash not indexed yet");
        else if (normHex(r.configHash) === normHex(anchored)) set("configHashMatch", "pass");
        else set("configHashMatch", "fail", `report configHash ${r.configHash} ≠ factory ${anchored}`);
        if (normHex(r.imageId) === normHex(inst.codeHash)) set("imageIdMatch", "pass");
        else set("imageIdMatch", "fail", `report imageId ${r.imageId} ≠ registry codeHash ${inst.codeHash}`);
        await this.quoteChecks(p.quote, r.imageId, inst, set, detail);
      }
    }

    const failing = CHECK_NAMES.filter((k) => checks[k] === "fail");
    if (failing.length > 0) {
      this.log.warn(`ATTESTATION CHECK FAILED: agent ${agentId}: ${failing.map((k) => `${k} (${detail.reasons[k] ?? "?"})`).join("; ")}`);
    }
    return row();
  }

  /** SPEC-M4D R3 — checks 8 (quoteValid) and 9 (measurementMatch). */
  private async quoteChecks(q: ReportQuote, reportImageId: string, inst: InstanceRow, set: (k: CheckName, s: CheckStatus, reason?: string) => void, detail: VerifyDetail): Promise<void> {
    const d = decodeReportQuote(q);
    if (!d.ok) {
      set("quoteValid", "fail", d.reason);
      set("measurementMatch", "skip", "quoteValid failed");
      return;
    }
    let v;
    try {
      v = await verifyQuote(d.bytes);
    } catch (e) {
      set("quoteValid", "fail", errMsg(e));
      set("measurementMatch", "skip", "quoteValid failed");
      return;
    }
    set("quoteValid", "pass");
    const reportImageIdDiverges = normHex(reportImageId) !== v.trueImageId;
    detail.quote = { ...v, registeredCodeHash: inst.codeHash, reportImageId, reportImageIdDiverges };
    if (v.trueImageId === normHex(inst.codeHash)) set("measurementMatch", "pass");
    else {
      set(
        "measurementMatch",
        "fail",
        `quote image-id ${v.trueImageId} ≠ registry codeHash ${inst.codeHash}; report self-reports imageId ${reportImageId} (${reportImageIdDiverges ? "also diverges from the quote" : "matches the quote"})`,
      );
    }
  }
}
