// SPEC-M3 §3 — real x402 inference transport (exact scheme, x402 spec v1) over the injected
// HttpClient. No network code here (httpFetch.ts is the only network file).
//
// One paid call = X402HttpInference.call(input, exec?):
//   (0)  Dormant gate: a PURE evaluate() dry-run of the inference action (estimate + salt). Deny
//        with code RUNWAY ⇒ logged + "denied", and NO HTTP at all (a Dormant agent must not even
//        solicit a quote). Any other deny code does NOT abort: budget is settled quote-aware at (3).
//   (1)  POST entry.url, OpenAI-style chat-completions JSON, NO payment header.
//   (2a) 200 directly (free endpoint) ⇒ the call is still METERED: execute({kind:"inference",
//        maxCostUsd: estimate, salt}, {meterOnly: true}) — approval + ledger + log, no K3 signature,
//        nothing paid. A deny ⇒ the response is DISCARDED and the call reports "denied".
//   (2b) 402 ⇒ parse the payment-required body {x402Version: 1, accepts[]}; pick the FIRST
//        requirement with scheme "exact", network == Base USDC domain chain (cfg.usdcDomain.base
//        .chainId; "base" | "base-sepolia" | "eip155:<id>"), asset == Base USDC
//        (usdcDomain.base.verifyingContract; extra.name/version, when present, must match the
//        EIP-712 domain K3 signs with). REQUIRE payTo == allowlist entry.payTo and
//        0 < maxAmountRequired ≤ estimate (≤ maxPerCallUsd by construction). Any failure ⇒
//        endpoint unhealthy ("price" cooldown — SPEC-M2 §7.1's real hook) + caller rotates; no
//        execute, no payment.
//   (3)  execute({kind:"inference", category, endpointId, maxCostUsd: min(estimate, quoted), salt})
//        — the engine approval happens HERE, per call, quote-aware; budget is consumed at approval
//        (unchanged, conservative). Deny ⇒ "denied", no retry.
//   (4)  K3 (via execute extras.x402Auth) signs the EIP-3009 auth over the quoted amount;
//        X-PAYMENT = base64(JSON {x402Version: 1, scheme: "exact", network, payload: {signature,
//        authorization}}) (bigints as decimal strings).
//   (5)  retry the POST ONCE with the header. 402 again / non-200 / transport error ⇒ contract
//        failure counted, NO second payment for this call.
//   (6)  contract-check the chat-completions envelope (choices[0].message.content: non-empty
//        string, ≤ maxTokens × 4 chars); settlement info from X-PAYMENT-RESPONSE if present is
//        decoded (sanitized) and persisted onto the call's actions row via exec.annotate.
// Failures this module detects itself feed the EndpointManager (quote ⇒ markUnhealthy "price";
// transport/envelope/post-payment ⇒ recordContractFailure). Success is NOT recorded here: the
// caller owns the schema-level check (pulse contractCheck / chat reply check) and records
// success/failure for it — callers must not re-record this module's failures.

import { isAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { execute, type ExecDeps, type X402SettlementInfo } from "../exec/execute.js";
import { x402Nonce, type SignedX402Auth, type X402AuthInput } from "../keyring/keyring.js";
import { actionHash } from "../policy/approval.js";
import { evaluate } from "../policy/engine.js";
import type { DenyCode, ProposedAction, UnixSeconds } from "../policy/types.js";
import { sameAddress } from "../policy/util.js";
import { withinMaxTokens } from "./checks.js";
import type { EndpointManager } from "./endpoints.js";
import type { HttpClient, HttpResponse, LlmMessage } from "./types.js";

/** EIP-3009 validity window for x402 auths (validBefore = now + this; K3 allows ≤ 3600 s). */
export const X402_VALIDITY_SEC = 600n;
/** validAfter = now − this (USDC requires block.timestamp > validAfter; tolerates clock skew). */
export const X402_VALID_AFTER_SKEW_SEC = 60n;
export const X402_VERSION = 1;
export const X_PAYMENT = "x-payment";
export const X_PAYMENT_RESPONSE = "x-payment-response";

// ---------------------------------------------------------------------------
// salt (SPEC-M3 §3) — deterministic, no randomness
// ---------------------------------------------------------------------------

/** salt = keccak256(utf8(parts.join(":")))[0..16] — 16 bytes, lowercase hex. */
export function inferenceSalt(...parts: ReadonlyArray<string | bigint | number>): Hex {
  const h = keccak256(stringToBytes(parts.map((p) => (typeof p === "string" ? p : p.toString(10))).join(":")));
  return h.slice(0, 34) as Hex;
}

// ---------------------------------------------------------------------------
// wire formats
// ---------------------------------------------------------------------------

export interface X402Requirement {
  scheme: "exact";
  network: string;
  maxAmountRequired: bigint;
  payTo: Address;
  asset: Address;
  maxTimeoutSeconds?: number;
  resource?: string;
}

/** Decoded X-PAYMENT-RESPONSE: sanitized fields (persisted) + the raw header (returned only, never logged). */
export interface X402Settlement extends X402SettlementInfo {
  /** Raw header value (base64). */
  raw: string;
}

/** x402 network string → EVM chain id (undefined if unknown). */
export function networkChainId(network: string): number | undefined {
  if (network === "base") return 8453;
  if (network === "base-sepolia") return 84532;
  const m = /^eip155:([1-9][0-9]{0,15})$/.exec(network);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export type QuoteCheck = { ok: true; req: X402Requirement } | { ok: false; detail: string };

/**
 * (2b) Parse + validate a 402 payment-required body against the allowlist entry, the Base USDC
 * EIP-712 domain and the caller's estimate. Pure.
 */
export function checkQuote(
  body: string,
  entryPayTo: Address,
  usdc: { name: string; version: string; chainId: number; verifyingContract: Address },
  estimateUsd: bigint,
  maxPerCallUsd: bigint,
): QuoteCheck {
  const j = parseJson(body);
  if (!isRecord(j)) return { ok: false, detail: "402 body is not a JSON object" };
  if (j["x402Version"] !== X402_VERSION) return { ok: false, detail: `unsupported x402Version ${String(j["x402Version"])}` };
  const accepts = j["accepts"];
  if (!Array.isArray(accepts)) return { ok: false, detail: "402 body has no accepts[]" };
  const pick = accepts.find(
    (a): a is Record<string, unknown> =>
      isRecord(a) &&
      a["scheme"] === "exact" &&
      typeof a["network"] === "string" &&
      networkChainId(a["network"]) === usdc.chainId &&
      typeof a["asset"] === "string" &&
      isAddress(a["asset"], { strict: false }) &&
      sameAddress(a["asset"], usdc.verifyingContract),
  );
  if (pick === undefined) return { ok: false, detail: `no accepts[] entry with scheme exact, chain ${usdc.chainId}, asset USDC` };
  const extra = pick["extra"];
  if (isRecord(extra)) {
    if (extra["name"] !== undefined && extra["name"] !== usdc.name) return { ok: false, detail: `quote EIP-712 name ${String(extra["name"])} != ${usdc.name}` };
    if (extra["version"] !== undefined && extra["version"] !== usdc.version) {
      return { ok: false, detail: `quote EIP-712 version ${String(extra["version"])} != ${usdc.version}` };
    }
  }
  const payTo = pick["payTo"];
  if (typeof payTo !== "string" || !isAddress(payTo, { strict: false })) return { ok: false, detail: "quote payTo is not an address" };
  if (!sameAddress(payTo, entryPayTo)) return { ok: false, detail: `quote payTo ${payTo} != allowlist payTo ${entryPayTo}` };
  const amt = pick["maxAmountRequired"];
  if (typeof amt !== "string" || !/^[0-9]{1,30}$/.test(amt)) return { ok: false, detail: "quote maxAmountRequired is not a decimal string" };
  const quoted = BigInt(amt);
  if (quoted <= 0n) return { ok: false, detail: "quote maxAmountRequired is 0" };
  if (quoted > maxPerCallUsd) return { ok: false, detail: `PER_CALL_CAP: quoted ${quoted} > maxPerCallUsd ${maxPerCallUsd}` };
  if (quoted > estimateUsd) return { ok: false, detail: `price ceiling: quoted ${quoted} > maxCostUsd ${estimateUsd}` };
  const mts = pick["maxTimeoutSeconds"];
  const res = pick["resource"];
  return {
    ok: true,
    req: {
      scheme: "exact",
      network: pick["network"] as string,
      maxAmountRequired: quoted,
      payTo: payTo as Address,
      asset: pick["asset"] as Address,
      ...(typeof mts === "number" ? { maxTimeoutSeconds: mts } : {}),
      ...(typeof res === "string" ? { resource: res } : {}),
    },
  };
}

/** (4) X-PAYMENT header value: base64(JSON) per x402 v1 exact scheme (EVM). */
export function encodePaymentHeader(network: string, signed: SignedX402Auth): string {
  const a = signed.authorization;
  const payload = {
    x402Version: X402_VERSION,
    scheme: "exact",
    network,
    payload: {
      signature: signed.signature,
      authorization: {
        from: a.from,
        to: a.to,
        value: a.value.toString(10),
        validAfter: a.validAfter.toString(10),
        validBefore: a.validBefore.toString(10),
        nonce: a.nonce,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/**
 * X-PAYMENT-RESPONSE (base64 JSON) → settlement info; malformed ⇒ raw only. The header is
 * endpoint-controlled and the sanitized fields land in the actions log (which feeds the pulse
 * context), so every field is shape-checked: transaction = 32-byte hex, network = short token,
 * payer = address; anything else is dropped.
 */
export function decodeSettlement(raw: string): X402Settlement {
  const j = parseJson(Buffer.from(raw, "base64").toString("utf8"));
  const out: X402Settlement = { raw };
  if (!isRecord(j)) return out;
  const tx = j["transaction"];
  const net = j["network"];
  const payer = j["payer"];
  if (typeof j["success"] === "boolean") out.success = j["success"];
  if (typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx)) out.transaction = tx.toLowerCase();
  if (typeof net === "string" && /^[A-Za-z0-9:_-]{1,64}$/.test(net)) out.network = net;
  if (typeof payer === "string" && isAddress(payer, { strict: false })) out.payer = payer.toLowerCase();
  return out;
}

/** The persisted (sanitized) part of a settlement: no raw header. */
export function settlementInfo(s: X402Settlement): X402SettlementInfo {
  const { raw: _raw, ...info } = s;
  return info;
}

export type EnvelopeCheck = { ok: true; text: string } | { ok: false; detail: string };

/** (6) OpenAI chat-completions envelope → choices[0].message.content (non-empty, ≤ maxTokens × 4). */
export function checkEnvelope(body: string, maxTokens: number): EnvelopeCheck {
  const j = parseJson(body);
  if (!isRecord(j)) return { ok: false, detail: "response is not a JSON object" };
  const choices = j["choices"];
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const msg = isRecord(first) ? first["message"] : undefined;
  const content = isRecord(msg) ? msg["content"] : undefined;
  if (typeof content !== "string") return { ok: false, detail: "response has no choices[0].message.content string" };
  if (content.trim().length === 0) return { ok: false, detail: "empty response" };
  if (!withinMaxTokens(content, maxTokens)) return { ok: false, detail: `response ${content.length} chars exceeds maxTokens ${maxTokens} (×4 chars)` };
  return { ok: true, text: content };
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

export interface X402HttpDeps {
  http: HttpClient;
  /** DEFAULT memory-logged exec deps (every ExecResult is recorded by its log); call() may override per call. */
  exec: ExecDeps;
  endpoints: EndpointManager;
  /** Per-request timeout; DEFAULT cfg.x402HttpTimeoutMs (30 000). */
  timeoutMs?: number;
}

export interface PaidInferenceInput {
  endpointId: string;
  category: "pulse" | "chat" | "social";
  /** Caller's maxCostUsd estimate (price ceiling for the quote; ≤ maxPerCallUsd). */
  estimateUsd: bigint;
  /** 16-byte deterministic salt (inferenceSalt). */
  salt: Hex;
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
}

export type PaidInferenceResult =
  | {
      kind: "ok";
      text: string;
      /** false = free endpoint (2a): metered, nothing signed or paid. */
      paid: boolean;
      action: ProposedAction;
      auth?: SignedX402Auth;
      settlement?: X402Settlement;
    }
  | { kind: "denied"; code: DenyCode; detail: string; action: ProposedAction }
  /** Quote failed validation ⇒ endpoint marked unhealthy (price); nothing executed or paid. */
  | { kind: "quoteRejected"; detail: string }
  /** First POST failed (transport / unexpected status) ⇒ contract failure counted. */
  | { kind: "httpError"; detail: string }
  /** execute() allowed but K3/auth failed ⇒ nothing sent. */
  | { kind: "payError"; detail: string; action: ProposedAction }
  /** Paid retry failed (402 again / non-200 / transport) ⇒ contract failure counted, no second payment. */
  | { kind: "paymentRejected"; detail: string; action: ProposedAction; auth: SignedX402Auth }
  /** Response envelope failed the contract check ⇒ contract failure counted. */
  | { kind: "contract"; detail: string; paid: boolean; action: ProposedAction; auth?: SignedX402Auth };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The paid-inference seam pulse (paidCall) and chat (step 3) use when the real transport is enabled
 * (boot: runtime.x402.enabled). `exec` = the caller's memory-logged deps (its log/annotate write the
 * actions rows); omitted ⇒ the client's default.
 */
export interface PaidInferenceClient {
  call(input: PaidInferenceInput, exec?: ExecDeps): Promise<PaidInferenceResult>;
}

export class X402HttpInference implements PaidInferenceClient {
  private readonly deps: X402HttpDeps;

  constructor(deps: X402HttpDeps) {
    this.deps = deps;
  }

  async call(input: PaidInferenceInput, execOverride?: ExecDeps): Promise<PaidInferenceResult> {
    const { endpoints, http } = this.deps;
    const exec = execOverride ?? this.deps.exec;
    const now = (): UnixSeconds => exec.clock();
    const cfg = exec.cfg;
    const timeoutMs = this.deps.timeoutMs ?? cfg.x402HttpTimeoutMs;
    const entry = cfg.x402Allowlist.find((e) => e.id === input.endpointId && e.kind === "inference");
    if (entry === undefined) return { kind: "httpError", detail: `endpoint "${input.endpointId}" is not an allowlisted inference endpoint` };

    const body = JSON.stringify({
      model: entry.model,
      messages: [{ role: "system", content: input.system }, ...input.messages.map((m) => ({ role: m.role, content: m.content }))],
      max_tokens: input.maxTokens,
      stream: false,
    });
    const baseHeaders: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    const estimateAction: ProposedAction = { kind: "inference", category: input.category, endpointId: entry.id, maxCostUsd: input.estimateUsd, salt: input.salt };

    // (0) Dormant gate: pure dry-run; RUNWAY ⇒ no HTTP at all. Other deny codes are settled at (3).
    const pre = evaluate(estimateAction, await exec.getState(), exec.ledger.get(), cfg, now());
    if (!pre.allow && pre.code === "RUNWAY") {
      if (exec.log !== undefined) await exec.log({ action: estimateAction, verdict: pre });
      return { kind: "denied", code: pre.code, detail: pre.detail, action: estimateAction };
    }

    // (1) unauthenticated POST
    let first: HttpResponse;
    try {
      first = await http.request({ method: "POST", url: entry.url, headers: baseHeaders, body, timeoutMs });
    } catch (e) {
      endpoints.recordContractFailure(entry.id, now());
      return { kind: "httpError", detail: `POST: ${errMsg(e)}` };
    }

    // (2a) free endpoint: metered (approval + ledger + log), nothing signed
    if (first.status === 200) {
      const action = estimateAction;
      const r = await execute(action, exec, { meterOnly: true });
      if (!r.verdict.allow) return { kind: "denied", code: r.verdict.code, detail: r.verdict.detail, action };
      if (r.error !== undefined) return { kind: "payError", detail: r.error, action };
      const env = checkEnvelope(first.body, input.maxTokens);
      if (!env.ok) {
        endpoints.recordContractFailure(entry.id, now());
        return { kind: "contract", detail: env.detail, paid: false, action };
      }
      return { kind: "ok", text: env.text, paid: false, action };
    }

    if (first.status !== 402) {
      endpoints.recordContractFailure(entry.id, now());
      return { kind: "httpError", detail: `POST: unexpected status ${first.status}` };
    }

    // (2b) quote validation
    const q = checkQuote(first.body, entry.payTo, cfg.usdcDomain.base, input.estimateUsd, cfg.maxPerCallUsd);
    if (!q.ok) {
      endpoints.markUnhealthy(entry.id, "price", now());
      return { kind: "quoteRejected", detail: q.detail };
    }
    const quoted = q.req.maxAmountRequired;

    // (3) engine approval, quote-aware (budget consumed here)
    const maxCostUsd = quoted < input.estimateUsd ? quoted : input.estimateUsd;
    const action: ProposedAction = { kind: "inference", category: input.category, endpointId: entry.id, maxCostUsd, salt: input.salt };
    const t = now();
    const auth: X402AuthInput = {
      from: exec.keyring.addresses().treasury,
      to: q.req.payTo,
      value: maxCostUsd,
      validAfter: t > X402_VALID_AFTER_SKEW_SEC ? t - X402_VALID_AFTER_SKEW_SEC : 0n,
      validBefore: t + X402_VALIDITY_SEC,
      nonce: x402Nonce(actionHash(action)),
    };
    const r = await execute(action, exec, { x402Auth: auth });
    if (!r.verdict.allow) return { kind: "denied", code: r.verdict.code, detail: r.verdict.detail, action };
    if (r.error !== undefined || r.x402 === undefined) return { kind: "payError", detail: r.error ?? "no x402 auth", action };
    const signed = r.x402;

    // (4)+(5) paid retry, exactly once
    const header = encodePaymentHeader(q.req.network, signed);
    let second: HttpResponse;
    try {
      second = await http.request({ method: "POST", url: entry.url, headers: { ...baseHeaders, [X_PAYMENT]: header }, body, timeoutMs });
    } catch (e) {
      endpoints.recordContractFailure(entry.id, now());
      return { kind: "paymentRejected", detail: `paid POST: ${errMsg(e)}`, action, auth: signed };
    }
    if (second.status !== 200) {
      endpoints.recordContractFailure(entry.id, now());
      const why = second.status === 402 ? "402 again after payment" : `unexpected status ${second.status} after payment`;
      return { kind: "paymentRejected", detail: why, action, auth: signed };
    }

    // (6) settlement info (persisted onto this call's actions row) + contract check
    const settleRaw = second.headers[X_PAYMENT_RESPONSE];
    const settlement = settleRaw !== undefined ? decodeSettlement(settleRaw) : undefined;
    if (settlement !== undefined && exec.annotate !== undefined) {
      await exec.annotate({ ...r, x402Settlement: settlementInfo(settlement) });
    }
    const env = checkEnvelope(second.body, input.maxTokens);
    if (!env.ok) {
      endpoints.recordContractFailure(entry.id, now());
      return { kind: "contract", detail: env.detail, paid: true, action, auth: signed };
    }
    return { kind: "ok", text: env.text, paid: true, action, auth: signed, ...(settlement !== undefined ? { settlement } : {}) };
  }
}
