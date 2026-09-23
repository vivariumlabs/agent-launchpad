// SPEC-M2B §6 — runPulse(deps). Steps:
//   (0) tier gate: Dormant/Evicted ⇒ no pulse (status "skipped", no LLM call).
//       First pulse of each UTC day: one canary per candidate endpoint (§5c), paid +
//       budgeted under the pulse category like any other inference call.
//   (1) deterministic context bundle (context.ts) at the budget-pressure level.
//   (2) maxCostUsd = ceil(promptChars/4 × entry price × 1.5), ≤ maxPerCallUsd (checks.ts).
//   (3) execute({kind:"inference", category:"pulse", ...}) — the execute gate comes BEFORE
//       any LLM call; deny ⇒ recorded (actions table) + pulse ends + reschedule (RUNWAY /
//       INFERENCE_BUDGET ⇒ stretch). The K3-signed auth is handed to the x402 transport.
//   (4) LLM call via EndpointManager (price ceiling check on the quote first); contract
//       check; ONE retry on the next fallback endpoint per pulse (each attempt passes its
//       own inference gate).
//   (5) parse `{toolCalls?, diary?, journal?, posts?}`; first cfg.toolCallCap (K=5) toolCalls
//       processed, the rest dropped + logged.
//   (5b) dedup: within one pulse, a tool call whose derived action (canonicalEncode — for a
//       swap, the actionSwap it builds) equals an earlier one's is dropped BEFORE evaluation
//       and logged like an over-K drop (verdict "dropped"). Prevents the K1 same-hash +
//       same-issuedAt replay throw and wasted budget. Dedup runs within the K taken calls
//       (duplicates still consume K slots).
//   (6) each toolCall → tool table (tools.ts) → execute()/swapExactIn(); unknown tool / bad
//       args ⇒ logged skip, pulse continues. A response whose known-tool calls carry bad
//       args counts as a contract failure for the endpoint (valid calls still run, no retry).
//   (7) diary → memory kv; journal → journalWrite execute; posts → castPost execute.
//   (8) heartbeat via execute.
//   (9) persist ledger (+ every ExecResult was logged to `actions` as it happened).
// runPulse never throws: unexpected errors are collected in `result.errors`.

import { bytesToString, type Hex } from "viem";
import { execute, swapExactIn, type CastSink, type ExecDeps, type ExecResult, type JournalSink } from "../exec/execute.js";
import { x402Nonce, type X402AuthInput } from "../keyring/keyring.js";
import { CANARY_MAX_TOKENS, CANARY_SYSTEM, canaryFor, scoreCanary, type CanaryId } from "../llm/canaries.js";
import { contractCheck, estimateMaxCostUsd, type PulseOutput } from "../llm/checks.js";
import type { EndpointManager } from "../llm/endpoints.js";
import type { LlmClient, LlmMessage, LlmRequest, ToolSpec, X402Transport } from "../llm/types.js";
import type { X402AllowlistEntry } from "../config/schema.js";
import { insertAction, insertJournal, insertPost, insertTrade, kvSet, saveLedger, type MemoryDb } from "../memory/db.js";
import { actionHash, canonicalEncode } from "../policy/approval.js";
import { runwayDays } from "../policy/runway.js";
import type { DenyCode, ProposedAction, UnixSeconds } from "../policy/types.js";
import { buildContext, buildPrompt, promptChars, type ContextLevel, type ContextSources } from "./context.js";
import { budgetPressure, STRETCH_DENY_CODES, type TierTransition } from "./scheduler.js";
import { pulsesEnabled, tierOf, type Tier } from "./tier.js";
import { contentAction, mapToolCall, toolSchemaFor } from "./tools.js";

/** Primary + ONE retry on the next fallback endpoint per pulse (DEFAULT). */
export const MAX_LLM_ATTEMPTS = 2;
/** Pulse response token budget (contract check: chars ≤ 4 × this). */
export const PULSE_MAX_TOKENS = 2048;
/** EIP-3009 validity window used for x402 auths (K3 allows ≤ 3600 s). */
export const X402_VALIDITY_SEC = 600n;

export interface PulseDeps {
  exec: ExecDeps;
  db: MemoryDb;
  llm: LlmClient;
  x402: X402Transport;
  endpoints: EndpointManager;
  sources?: ContextSources;
  /** Current tier from the scheduler; computed from runway (with prevTier hysteresis) if absent. */
  tier?: Tier;
  prevTier?: Tier;
  /** Context level override; default from budgetPressure(). */
  level?: ContextLevel;
  maxTokens?: number;
}

export type AttemptOutcome = "ok" | "contract" | "price" | "denied" | "payError" | "llmError" | "quoteError";

export interface PulseAttempt {
  endpointId: string;
  outcome: AttemptOutcome;
  detail?: string;
}

export interface PulseSkip {
  tool: string;
  reason: string;
  badArgs: boolean;
}

export interface PulseResult {
  status: "completed" | "skipped" | "inferenceDenied" | "noResponse";
  tier: Tier;
  level: ContextLevel;
  canaries: Array<{ endpointId: string; canary: CanaryId; outcome: AttemptOutcome; pass: boolean }>;
  attempts: PulseAttempt[];
  endpointUsed?: string;
  inferenceDeny?: DenyCode;
  toolCallsReceived: number;
  toolCallsProcessed: number;
  /** Tool calls dropped for exceeding cfg.toolCallCap (K). */
  dropped: number;
  /** Tool calls (within K) dropped as duplicates of an earlier derived action this pulse. */
  deduped: number;
  skips: PulseSkip[];
  /** Every ExecResult produced during this pulse (also logged to `actions`). */
  results: ExecResult[];
  stretch: boolean;
  /** Unexpected internal errors (should always be empty). */
  errors: string[];
}

// ---------------------------------------------------------------------------
// memory logging + sinks
// ---------------------------------------------------------------------------

export function recordExecResult(db: MemoryDb, r: ExecResult, ts: UnixSeconds): void {
  const kind: unknown = (r.action as { kind?: unknown }).kind;
  insertAction(db, {
    ts,
    kind: typeof kind === "string" ? kind : "unknown",
    json: canonicalEncode(r.action),
    verdict: r.verdict.allow ? "allow" : "deny",
    denyCode: r.verdict.allow ? null : r.verdict.code,
    txHash: r.txHash ?? null,
    error: r.error ?? null,
  });
}

/** Non-engine log rows: tool skips, K-cap drops, tier transitions. */
export function recordNote(db: MemoryDb, ts: UnixSeconds, kind: string, verdict: "skip" | "dropped" | "info", payload: unknown, reason: string): void {
  insertAction(db, { ts, kind, json: canonicalEncode(payload), verdict, denyCode: null, txHash: null, error: reason });
}

export function recordTierTransition(db: MemoryDb, t: TierTransition, ts: UnixSeconds): void {
  recordNote(db, ts, "tierTransition", "info", t, `${t.from} -> ${t.to}`);
}

export function memoryCastSink(db: MemoryDb, clock: () => UnixSeconds): CastSink {
  return {
    async publish(action: ProposedAction, messageBytes: Uint8Array, _signature: Hex): Promise<void> {
      const hash = action.kind === "castPost" || action.kind === "castReply" ? action.contentHash : null;
      insertPost(db, { ts: clock(), kind: action.kind, content: bytesToString(messageBytes), castHash: hash });
    },
  };
}

export function memoryJournalSink(db: MemoryDb, clock: () => UnixSeconds): JournalSink {
  return {
    async write(_action: ProposedAction, bytes: Uint8Array): Promise<string> {
      const id = insertJournal(db, { ts: clock(), content: bytesToString(bytes), arweaveTxid: null });
      return `journal:${id}`;
    },
  };
}

/** ExecDeps whose log writes every ExecResult to the `actions` table (then chains the original log). */
export function memoryExecDeps(exec: ExecDeps, db: MemoryDb, sink?: ExecResult[]): ExecDeps {
  return {
    ...exec,
    log: async (r: ExecResult) => {
      recordExecResult(db, r, exec.clock());
      if (sink !== undefined) sink.push(r);
      if (exec.log !== undefined) await exec.log(r);
    },
    castSink: exec.castSink ?? memoryCastSink(db, exec.clock),
    journalSink: exec.journalSink ?? memoryJournalSink(db, exec.clock),
  };
}

// ---------------------------------------------------------------------------
// one paid LLM call: quote → price ceiling → inference execute gate (K3) → pay → complete
// ---------------------------------------------------------------------------

type PaidCall =
  | { kind: "ok"; text: string }
  | { kind: "denied"; code: DenyCode; detail: string }
  | { kind: "price" | "payError" | "llmError" | "quoteError"; detail: string };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function paidCall(
  deps: PulseDeps,
  ex: ExecDeps,
  ep: X402AllowlistEntry,
  base: { system: string; messages: LlmMessage[]; toolSchema: ToolSpec[]; maxTokens: number },
): Promise<PaidCall> {
  const cfg = ex.cfg;
  const now = ex.clock();
  let quoted: bigint;
  try {
    quoted = (await deps.x402.quote(ep.id)).pricePerMTokUsd;
  } catch (e) {
    return { kind: "quoteError", detail: errMsg(e) };
  }
  if (!deps.endpoints.checkPrice(ep.id, quoted, now)) {
    return { kind: "price", detail: `quoted ${quoted} > ceiling ${ep.maxPricePerMTokUsd} per MTok` };
  }
  const chars = promptChars(base.system, base.messages, base.toolSchema);
  const maxCostUsd = estimateMaxCostUsd(chars, ep.maxPricePerMTokUsd, cfg.maxPerCallUsd);
  const action: ProposedAction = { kind: "inference", category: "pulse", endpointId: ep.id, maxCostUsd };
  const auth: X402AuthInput = {
    to: ep.payTo,
    value: maxCostUsd,
    validAfter: now,
    validBefore: now + X402_VALIDITY_SEC,
    nonce: x402Nonce(actionHash(action)),
  };
  const r = await execute(action, ex, { x402Auth: auth });
  if (!r.verdict.allow) return { kind: "denied", code: r.verdict.code, detail: r.verdict.detail };
  if (r.error !== undefined || r.x402 === undefined) return { kind: "payError", detail: r.error ?? "no x402 auth" };
  try {
    await deps.x402.pay(ep.id, r.x402);
  } catch (e) {
    return { kind: "payError", detail: errMsg(e) };
  }
  const req: LlmRequest = { ...base, endpointId: ep.id, model: ep.model, maxCostUsd };
  try {
    const resp = await deps.llm.complete(req);
    return { kind: "ok", text: resp.text };
  } catch (e) {
    return { kind: "llmError", detail: errMsg(e) };
  }
}

// ---------------------------------------------------------------------------
// runPulse
// ---------------------------------------------------------------------------

function tsKey(ts: UnixSeconds): string {
  return ts.toString(10).padStart(12, "0");
}

export async function runPulse(deps: PulseDeps): Promise<PulseResult> {
  const results: ExecResult[] = [];
  const errors: string[] = [];
  const ex = memoryExecDeps(deps.exec, deps.db, results);
  const cfg = ex.cfg;
  const db = deps.db;
  const now = ex.clock();

  let tier: Tier = deps.tier ?? "Active";
  let level: ContextLevel = deps.level ?? "full";
  const result: PulseResult = {
    status: "completed",
    tier,
    level,
    canaries: [],
    attempts: [],
    toolCallsReceived: 0,
    toolCallsProcessed: 0,
    dropped: 0,
    deduped: 0,
    skips: [],
    results,
    stretch: false,
    errors,
  };

  let floorApplies = true; // I1 rev 2: recomputed from runway below
  try {
    const state = await ex.getState();
    const rDays = runwayDays(state, now, undefined, cfg.bridgeHaircutBps);
    tier = deps.tier ?? tierOf(rDays, deps.prevTier);
    floorApplies = rDays >= BigInt(cfg.minRunwayDays);
    const pressure = budgetPressure(ex.ledger.get(), cfg, now, floorApplies);
    level = deps.level ?? pressure.level;
    result.tier = tier;
    result.level = level;
    result.stretch = pressure.stretch;

    // (0) tier gate
    if (!pulsesEnabled(tier)) {
      result.status = "skipped";
      return result;
    }

    // (0b) daily canaries
    if (deps.endpoints.canaryDue(now)) {
      deps.endpoints.markCanaryRound(now);
      for (const ep of deps.endpoints.candidates()) {
        const c = canaryFor(ep.id, now);
        const call = await paidCall(deps, ex, ep, {
          system: CANARY_SYSTEM,
          messages: [{ role: "user", content: c.prompt }],
          toolSchema: [],
          maxTokens: CANARY_MAX_TOKENS,
        });
        if (call.kind === "denied") {
          result.canaries.push({ endpointId: ep.id, canary: c.id, outcome: "denied", pass: false });
          break; // budget/runway: stop spending on canaries today
        }
        if (call.kind === "ok" || call.kind === "llmError") {
          const pass = call.kind === "ok" && scoreCanary(c, call.text);
          deps.endpoints.recordCanary(ep.id, pass, now);
          result.canaries.push({ endpointId: ep.id, canary: c.id, outcome: call.kind, pass });
        } else {
          result.canaries.push({ endpointId: ep.id, canary: c.id, outcome: call.kind, pass: false });
        }
      }
    }

    // (1) context + prompt
    const bundle = await buildContext({ db, state, ledger: ex.ledger.get(), cfg, now, tier, level, sources: deps.sources, floorApplies });
    const tools = toolSchemaFor(tier);
    const { system, messages } = buildPrompt(cfg, bundle, tools);
    const maxTokens = deps.maxTokens ?? PULSE_MAX_TOKENS;

    // (2)–(4) paid LLM call with ONE retry on the next fallback
    const tried = new Set<string>();
    let output: PulseOutput | undefined;
    for (let i = 0; i < MAX_LLM_ATTEMPTS && output === undefined; i++) {
      const ep = deps.endpoints.select(ex.clock(), { exclude: tried, cheapOnly: tier === "Conserving" });
      if (ep === undefined) break;
      tried.add(ep.id);
      const call = await paidCall(deps, ex, ep, { system, messages, toolSchema: tools, maxTokens });
      if (call.kind === "denied") {
        result.attempts.push({ endpointId: ep.id, outcome: "denied", detail: `${call.code}: ${call.detail}` });
        result.status = "inferenceDenied";
        result.inferenceDeny = call.code;
        if (STRETCH_DENY_CODES.has(call.code)) result.stretch = true;
        break;
      }
      if (call.kind === "ok") {
        const chk = contractCheck(call.text, maxTokens);
        if (chk.ok) {
          output = chk.output;
          result.endpointUsed = ep.id;
          result.attempts.push({ endpointId: ep.id, outcome: "ok" });
        } else {
          deps.endpoints.recordContractFailure(ep.id, ex.clock());
          result.attempts.push({ endpointId: ep.id, outcome: "contract", detail: chk.reason });
        }
        continue;
      }
      if (call.kind === "llmError" || call.kind === "quoteError") deps.endpoints.recordContractFailure(ep.id, ex.clock());
      result.attempts.push({ endpointId: ep.id, outcome: call.kind, detail: call.detail });
    }

    if (result.status === "inferenceDenied") {
      // record (already logged by execute) + reschedule; nothing else this pulse.
    } else {
      if (output === undefined) {
        result.status = "noResponse";
      } else {
        await processOutput(output, tier, ex, db, result, errors);
        if (result.endpointUsed !== undefined) {
          if (result.skips.some((s) => s.badArgs)) deps.endpoints.recordContractFailure(result.endpointUsed, ex.clock());
          else deps.endpoints.recordContractSuccess(result.endpointUsed);
        }
      }
      // (8) heartbeat
      await execute({ kind: "heartbeat" }, ex);
    }
  } catch (e) {
    errors.push(`pulse: ${errMsg(e)}`);
  }

  // (9) persist
  try {
    saveLedger(db, ex.ledger.get(), ex.clock());
    const after = budgetPressure(ex.ledger.get(), cfg, ex.clock(), floorApplies);
    result.stretch = result.stretch || after.stretch;
  } catch (e) {
    errors.push(`persist: ${errMsg(e)}`);
  }
  return result;
}

/** (5b) Dedup identity of a mapped tool call: canonicalEncode of the action it derives; null = not deduped. */
function dedupKey(plan: ReturnType<typeof mapToolCall>): string | null {
  switch (plan.type) {
    case "action":
      return canonicalEncode(plan.action);
    case "swap": {
      const i = plan.intent;
      const swap: ProposedAction = { kind: "actionSwap", tokenIn: i.tokenIn, tokenOut: i.tokenOut, amountIn: i.amountIn, minOut: i.minOut };
      return canonicalEncode(swap);
    }
    case "kv":
    case "skip":
      return null;
  }
}

async function processOutput(output: PulseOutput, tier: Tier, ex: ExecDeps, db: MemoryDb, result: PulseResult, errors: string[]): Promise<void> {
  const cfg = ex.cfg;
  const calls = output.toolCalls ?? [];
  result.toolCallsReceived = calls.length;
  const K = cfg.toolCallCap;
  const take = calls.slice(0, K);
  const drop = calls.slice(K);
  for (const d of drop) {
    recordNote(db, ex.clock(), "toolCall", "dropped", { tool: d.tool, args: d.args }, `dropped: toolCallCap ${K} exceeded`);
  }
  result.dropped = drop.length;

  // (6) tool calls
  const seen = new Set<string>();
  for (const call of take) {
    let counted = false;
    try {
      const plan = mapToolCall(call, tier, cfg);
      // (5b) dedup identical derived actions before evaluation.
      const key = dedupKey(plan);
      if (key !== null) {
        if (seen.has(key)) {
          result.deduped += 1;
          recordNote(db, ex.clock(), "toolCall", "dropped", { tool: call.tool, args: call.args }, "dropped: duplicate of an earlier tool call this pulse");
          continue;
        }
        seen.add(key);
      }
      result.toolCallsProcessed += 1;
      counted = true;
      switch (plan.type) {
        case "skip":
          result.skips.push({ tool: plan.tool, reason: plan.reason, badArgs: plan.badArgs });
          recordNote(db, ex.clock(), "toolCall", "skip", { tool: call.tool, args: call.args }, plan.reason);
          break;
        case "swap": {
          const rs = await swapExactIn(plan.intent, ex);
          const done = rs.length === 2 && rs.every((r) => r.verdict.allow && r.error === undefined);
          if (done) {
            const i = plan.intent;
            insertTrade(db, {
              ts: ex.clock(),
              token: i.tokenIn === "USDG" ? i.tokenOut : i.tokenIn,
              side: i.tokenIn === "USDG" ? "buy" : "sell",
              amountIn: i.amountIn,
              amountOut: i.minOut, // guaranteed minimum; real fill from the receipt = session 3
              pnlUsdg: 0n,
            });
          }
          break;
        }
        case "action":
          await execute(plan.action, ex, plan.extras);
          break;
        case "kv":
          kvSet(db, plan.key, plan.value);
          recordNote(db, ex.clock(), "toolCall", "info", { tool: plan.tool, key: plan.key, value: plan.value }, "kv write");
          break;
      }
    } catch (e) {
      const msg = errMsg(e);
      if (!counted) result.toolCallsProcessed += 1;
      errors.push(`toolCall ${call.tool}: ${msg}`);
      result.skips.push({ tool: call.tool, reason: `exception: ${msg}`, badArgs: false });
      recordNote(db, ex.clock(), "toolCall", "skip", { tool: call.tool, args: call.args }, `exception: ${msg}`);
    }
  }

  // (7) diary / journal / posts
  if (output.diary !== undefined && output.diary.length > 0) {
    kvSet(db, `diary:${tsKey(ex.clock())}`, output.diary);
    kvSet(db, "diary:last", output.diary);
  }
  if (output.journal !== undefined && output.journal.length > 0) {
    const j = contentAction("journalWrite", output.journal, cfg);
    if (j.ok) await execute(j.action, ex, j.extras);
    else {
      result.skips.push({ tool: "journal", reason: j.reason, badArgs: false });
      recordNote(db, ex.clock(), "journal", "skip", { bytes: j.reason }, j.reason);
    }
  }
  for (const post of output.posts ?? []) {
    if (post.length === 0) continue;
    const p = contentAction("castPost", post, cfg);
    if (p.ok) await execute(p.action, ex, p.extras);
    else {
      result.skips.push({ tool: "posts", reason: p.reason, badArgs: false });
      recordNote(db, ex.clock(), "post", "skip", { text: post.slice(0, 64) }, p.reason);
    }
  }
}
