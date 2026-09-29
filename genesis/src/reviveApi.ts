// SPEC-M4F §1 — the launch-helper's revive endpoints (R1/R2/R7/R8). SECRET-FREE: it READS the payment
// tx (Arbitrum One receipt) and the genesis db, and queues a revival row into that db (WAL, shared
// with the orchestrator, which drives it). It never holds a key and never sends a transaction —
// queueing a revival spends nothing itself.
//
//   GET  /api/revive/quote/:agentId
//        200 { agentId, revivable, reason?, detail?, quote?, gate: { lastHeartbeat, revivalWindow, evictableAt, chainNow, generation },
//              history: [{ revivalId, generation, payer, startedAt, state }] }
//        quote (only when revivable) = { rateUsdcMicroPerHour, durationMin, hostingUsdcMicro, gasSeedUsdMicro, totalUsdcMicro,
//              payTo, token, chainId, decimals: 6 }  (µ amounts as decimal strings; token/chainId = USDC on Arbitrum One)
//        400 bad agentId · 502 { error, stage: "rpc", reason }
//   POST /api/revive   body { agentId, payer, paymentTx }
//        verifies R1 on the receipt: status success, a USDC (tokens.arbUsdc) Transfer from `payer` to payTo
//        summing ≥ quote.totalUsdcMicro, txHash never used before (revival_payments PK) — then revive().
//        200 { revivalId, agentId, paymentTx, amount }
//        402 { error: payment_not_found | payment_reverted | wrong_recipient | payer_mismatch | short_amount | payment_reused, detail }
//        409 { error: "revival_refused", reason, detail, refund }   (gate / config refusal AFTER payment: refund_due, manual on testnet)
//        400 malformed · 502 { error, stage: "arbitrum-rpc" | "revive", reason } (claim released: resubmit the same tx)
//   GET  /api/revive/status/:agentId
//        200 { agentId, revivals: [...revival rows, progress fields only], payments: [...] }
//   All three: 503 { error: "manual mode", manual } when the helper has no genesisDb / revivalPayTo / chains.arbitrum.

import { decodeEventLog, getAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { erc20Abi } from "./abi.js";
import type { Launchpad, TxReceipt } from "./chain.js";
import type { Clock } from "./clock.js";
import type { FlowRow, GenesisDb, PaymentRow } from "./db.js";
import { errMsg } from "./errors.js";
import type { Logger } from "./log.js";
import { checkRevivable, revivalQuote, revive, RevivalRefused, type RevivalDeps, type RevivalQuote } from "./revival.js";

export type { Launchpad, TxReceipt };

/** Arbitrum One receipt reader (bin/launch-helper.ts: a key-less viem PublicClient; tests: in-memory). */
export interface ReceiptReader {
  receipt(hash: Hex): Promise<TxReceipt | null>;
  /** Unix seconds of `blockNumber` (M4F rev 1: payment max-age). */
  blockTimestamp(blockNumber: bigint): Promise<bigint>;
}

export const REVIVE_PATH = "/api/revive";
export const REVIVE_QUOTE_PREFIX = "/api/revive/quote/";
export const REVIVE_STATUS_PREFIX = "/api/revive/status/";

const REPO_URL = "https://github.com/vivariumlabs/agent-launchpad";

/** 04 §6 decentralization backstop — what a helper without an orchestrator connection answers (503). */
export const MANUAL_REVIVAL = {
  summary:
    "This service is not connected to a revival orchestrator. Revival never depends on one (04 §6 orchestrator-less revival): the runtime image, the deploy scripts and the instructions are public, and anyone with a funded wallet can redeploy an evicted agent.",
  steps: [
    "Read the agent's registered codeHash, configHash and heartbeat on-chain (AgentRegistry.instanceOf / AgentRequested).",
    "Pick the runtime/releases/<version>.yml whose image-id family matches the registered codeHash (releases/<version>.json imageIds) — a different compose derives different keys.",
    "Fetch the frozen agent.json (its Arweave copy) and check it hashes to the configHash.",
    "Deploy with oyster-cvm using the same agent-id + config-hash init params; once the heartbeat is stale beyond REVIVAL_WINDOW the enclave re-registers (generation + 1).",
  ],
  links: {
    repo: REPO_URL,
    reproducibleBuild: `${REPO_URL}/blob/master/runtime/docs/REPRODUCIBLE-BUILD.md`,
    revivalFlow: `${REPO_URL}/blob/master/docs/04-GENESIS.md#6-revival-flow-orchestrator-side`,
  },
} as const;

export const REFUND_NOTE =
  "Your payment was verified but the revival could not be queued (see reason). The fee will be returned by the operator — manually on testnet — to the paying address.";

export interface ApiReply {
  status: number;
  body: unknown;
}

// ---------------------------------------------------------------------------
// R1 payment verification (pure)
// ---------------------------------------------------------------------------

export type PaymentProblem = "payment_not_found" | "payment_reverted" | "wrong_recipient" | "payer_mismatch" | "short_amount" | "payment_reused" | "bad_signature" | "payment_too_old";

export type PaymentCheck = { ok: true; amount: bigint } | { ok: false; problem: PaymentProblem; detail: string };

/**
 * A receipt pays the revival iff it succeeded and carries ERC-20 Transfer logs EMITTED BY `token`
 * with to == payTo and from == payer whose values sum to ≥ minAmount.
 */
export function verifyRevivalPayment(rc: TxReceipt | null, o: { token: Address; payTo: Address; payer: Address; minAmount: bigint }): PaymentCheck {
  if (rc === null) return { ok: false, problem: "payment_not_found", detail: "no receipt for this tx on Arbitrum One (not mined yet, or not an Arbitrum One tx) — retry once it is mined" };
  if (rc.status !== "success") return { ok: false, problem: "payment_reverted", detail: `payment tx reverted in block ${rc.blockNumber}` };
  const toPayTo: Array<{ from: Address; value: bigint }> = [];
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== o.token.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]], eventName: "Transfer" });
      if (ev.args.to.toLowerCase() === o.payTo.toLowerCase()) toPayTo.push({ from: ev.args.from, value: ev.args.value });
    } catch {
      // not a Transfer log
    }
  }
  if (toPayTo.length === 0) return { ok: false, problem: "wrong_recipient", detail: `no USDC (${o.token}) Transfer to the revival pay-to ${o.payTo} in this tx` };
  const mine = toPayTo.filter((t) => t.from.toLowerCase() === o.payer.toLowerCase());
  if (mine.length === 0) {
    return { ok: false, problem: "payer_mismatch", detail: `the USDC transfer to ${o.payTo} is from ${[...new Set(toPayTo.map((t) => t.from))].join(", ")}, not ${o.payer}` };
  }
  const amount = mine.reduce((a, t) => a + t.value, 0n);
  if (amount < o.minAmount) return { ok: false, problem: "short_amount", detail: `paid ${amount} µUSDC, the revival quote is ${o.minAmount} µUSDC` };
  return { ok: true, amount };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ReviveServiceDeps {
  /** checkRevivable / revive deps (db = the genesis sqlite, READ-WRITE). */
  revival: RevivalDeps;
  receipts: ReceiptReader;
  quote: RevivalQuote;
  clock: Clock;
  /** M4F rev 1 payment max-age override (DEFAULT_PAYMENT_MAX_AGE_SEC). */
  paymentMaxAgeSec?: bigint;
  log: Logger;
}

const PayBody = z
  .object({
    agentId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    payer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    paymentTx: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    /** M4F rev 1: EIP-191 signature by `payer` over reviveIntentMessage(agentId, paymentTx). */
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  })
  .strict();

/**
 * M4F rev 1 (Fable, payment-binding fix): the canonical intent the PAYER signs. Binds the payment
 * tx to ONE agentId chosen by the payer — without it, anyone seeing a pending payment could submit
 * it first for a DIFFERENT stale agent (POST is unauthenticated by design; the signature is the
 * auth). EOA signatures only (recoverMessageAddress — no EIP-1271; documented v1 limit).
 */
export function reviveIntentMessage(agentId: number, paymentTx: string): string {
  return `vivarium revive: agent ${agentId}, payment ${paymentTx.toLowerCase()}`;
}

/** M4F rev 1: payments older than this are refused (stops old top-up transfers being claimed). */
export const DEFAULT_PAYMENT_MAX_AGE_SEC = 86_400n;

export function quoteJson(q: RevivalQuote): Record<string, unknown> {
  return {
    rateUsdcMicroPerHour: q.rateUsdcMicroPerHour.toString(),
    durationMin: q.durationMin,
    hostingUsdcMicro: q.hostingUsdcMicro.toString(),
    gasSeedUsdMicro: q.gasSeedUsdMicro.toString(),
    totalUsdcMicro: q.totalUsdcMicro.toString(),
    payTo: q.payTo,
    token: q.token,
    chainId: q.chainId,
    decimals: 6,
  };
}

function history(rows: readonly FlowRow[]): Array<Record<string, unknown>> {
  return rows.map((r) => ({ revivalId: r.id, generation: (r.startGeneration ?? 0) + 1, payer: r.payer, startedAt: r.startedAt, state: r.state }));
}

function paymentJson(p: PaymentRow): Record<string, unknown> {
  return { txHash: p.txHash, payer: p.payer, amount: p.amount, status: p.status, revivalId: p.revivalId, note: p.note, at: p.at };
}

/** Parses the positive agentId path segment; null ⇒ 400. */
export function parseAgentId(seg: string): number | null {
  if (!/^[1-9]\d{0,15}$/.test(seg)) return null;
  const n = Number(seg);
  return Number.isSafeInteger(n) ? n : null;
}

export class ReviveService {
  constructor(private readonly d: ReviveServiceDeps) {}

  private get db(): GenesisDb {
    return this.d.revival.db;
  }

  /** GET /api/revive/quote/:agentId — R2 full dry-run; a quote only when revivable. */
  async quote(agentId: number): Promise<ApiReply> {
    let c;
    try {
      c = await checkRevivable(this.d.revival, agentId);
    } catch (e) {
      this.d.log.warn(`launch-helper: revive quote for agent ${agentId} FAILED (502): ${errMsg(e)}`);
      return { status: 502, body: { error: "upstream failure", stage: "rpc", reason: errMsg(e) } };
    }
    const g = c.gate;
    const body: Record<string, unknown> = {
      agentId,
      revivable: c.revivable,
      ...(c.revivable ? { quote: quoteJson(this.d.quote) } : { reason: c.reason, detail: c.detail }),
      gate: {
        lastHeartbeat: Number(g.lastHeartbeat),
        revivalWindow: Number(g.revivalWindow),
        evictableAt: g.evictableAt === null ? null : Number(g.evictableAt),
        chainNow: Number(g.chainNow),
        generation: g.generation,
      },
      history: history(this.db.revivalsOf(agentId)),
    };
    return { status: 200, body };
  }

  /** POST /api/revive — R1 verification, single-use claim, then revive(). */
  async pay(raw: unknown): Promise<ApiReply> {
    const p = PayBody.safeParse(raw);
    if (!p.success) return { status: 400, body: { error: "invalid request", issues: p.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } };
    const { agentId } = p.data;
    const payer = getAddress(p.data.payer);
    const tx = p.data.paymentTx.toLowerCase() as Hex;
    const q = this.d.quote;

    // M4F rev 1: the payer's signed intent binds (agentId, paymentTx) — verified FIRST, offline.
    try {
      const signer = await recoverMessageAddress({ message: reviveIntentMessage(agentId, tx), signature: p.data.signature as Hex });
      if (signer.toLowerCase() !== payer.toLowerCase()) {
        this.d.log.info(`launch-helper: revive intent for agent ${agentId} signed by ${signer}, not payer ${payer} (402 bad_signature)`);
        return { status: 402, body: { error: "bad_signature", detail: `the intent signature recovers ${signer}, not the payer ${payer}` } };
      }
    } catch {
      return { status: 402, body: { error: "bad_signature", detail: "the intent signature is malformed" } };
    }

    const used = this.db.getPayment(tx);
    if (used !== undefined) return { status: 402, body: { error: "payment_reused", detail: `payment tx ${tx} was already used (agent ${used.agentId}, ${used.status})` } };

    let rc: TxReceipt | null;
    try {
      rc = await this.d.receipts.receipt(tx);
    } catch (e) {
      return { status: 502, body: { error: "upstream failure", stage: "arbitrum-rpc", reason: errMsg(e) } };
    }
    const v = verifyRevivalPayment(rc, { token: q.token, payTo: q.payTo, payer, minAmount: q.totalUsdcMicro });
    if (!v.ok) {
      this.d.log.info(`launch-helper: revive payment ${tx} for agent ${agentId} rejected (402 ${v.problem}): ${v.detail}`);
      return { status: 402, body: { error: v.problem, detail: v.detail } };
    }
    // M4F rev 1: payment max-age (stops historical transfers — incl. the operator's own top-ups —
    // being claimed as revival fees long after the fact).
    try {
      const ts = await this.d.receipts.blockTimestamp(rc!.blockNumber);
      const maxAge = this.d.paymentMaxAgeSec ?? DEFAULT_PAYMENT_MAX_AGE_SEC;
      const age = this.d.clock.now() - ts;
      if (age > maxAge) {
        this.d.log.info(`launch-helper: revive payment ${tx} for agent ${agentId} is ${age}s old > ${maxAge}s (402 payment_too_old)`);
        return { status: 402, body: { error: "payment_too_old", detail: `payment landed ${age}s ago; the limit is ${maxAge}s — send a fresh payment` } };
      }
    } catch (e) {
      return { status: 502, body: { error: "upstream failure", stage: "arbitrum-rpc", reason: errMsg(e) } };
    }
    const now = this.d.clock.now();
    if (!this.db.claimPayment({ txHash: tx, agentId, payer, amount: v.amount.toString(), at: Number(now) })) {
      return { status: 402, body: { error: "payment_reused", detail: `payment tx ${tx} was already used` } };
    }
    try {
      const revivalId = await revive(this.d.revival, agentId, { address: payer, ref: tx }, now);
      this.db.patchPayment(tx, { status: "queued", revivalId }, now);
      this.d.log.info(`launch-helper: revival ${revivalId} queued for agent ${agentId} — paid ${v.amount} µUSDC by ${payer} (tx ${tx})`);
      return { status: 200, body: { revivalId, agentId, paymentTx: tx, amount: v.amount.toString() } };
    } catch (e) {
      if (e instanceof RevivalRefused) {
        this.db.patchPayment(tx, { status: "refund_due", note: `${e.reason}: ${e.detail}`.slice(0, 500) }, now);
        this.d.log.warn(`!!! launch-helper: VERIFIED payment ${tx} (${v.amount} µUSDC from ${payer}) but revival of agent ${agentId} refused (${e.reason}) — REFUND DUE (manual)`);
        return { status: 409, body: { error: "revival_refused", reason: e.reason, detail: e.detail, refund: REFUND_NOTE, paymentTx: tx } };
      }
      this.db.releasePayment(tx);
      this.d.log.warn(`launch-helper: revive for agent ${agentId} failed transiently (claim released): ${errMsg(e)}`);
      return { status: 502, body: { error: "upstream failure", stage: "revive", reason: errMsg(e) } };
    }
  }

  /** GET /api/revive/status/:agentId — the revival rows (progress fields only) + payments, for the tracker. */
  status(agentId: number): ApiReply {
    const revivals = this.db.revivalsOf(agentId).map((r) => ({
      revivalId: r.id,
      state: r.state,
      startedAt: r.startedAt,
      updatedAt: r.updatedAt,
      payer: r.payer,
      paymentTx: r.payerRef,
      startGeneration: r.startGeneration,
      generation: (r.startGeneration ?? 0) + 1,
      deployJobId: r.deployJobId,
      cvmIp: r.cvmIp,
      attestationOk: r.attestationOk === 1,
      failReason: r.failReason,
      failStep: r.failStep,
      lastError: r.lastError,
    }));
    return { status: 200, body: { agentId, revivals, payments: this.db.paymentsOf(agentId).map(paymentJson) } };
  }
}

/** Quote for a configured helper (throws when chains.arbitrum is absent — callers treat that as manual mode). */
export { revivalQuote };
