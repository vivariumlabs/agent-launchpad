// SPEC-M3D §2 — Turbo self-top-up (daemon step 12; replaces the genesis "arweave" seed leg long-term).
//
// The Turbo payment service credits the SENDER of the payment tx, so genesis cannot top up the agent's
// account from the funding wallet: the agent tops itself up from its own base ETH. Once per interval
// (DEFAULT daily), when runtime.arweave is enabled (boot wires the hook only then):
//   0. balanceWinc() ≥ lowWatermarkWinc ⇒ idle.
//   1. GET <paymentUrl>/info → addresses["base-eth"]; ≠ the FROZEN cfg.arweaveFundingAddress ⇒ LOUD warn +
//      skip (fail closed: never pay an unverified dynamic address).
//   2. execute({kind:"treasuryTransfer", purpose:"arweaveFunding", chain:"base", asset:"ETH",
//      to: cfg.arweaveFundingAddress, amount: amountWei}) through the normal engine (T2/T3/G3 apply).
//   3. On success: POST <paymentUrl>/account/balance/base-eth {tx_id} — retried ≤ TURBO_FUND_ATTEMPTS ×
//      TURBO_FUND_RETRY_MS while the service waits for confirmations (200 credited / 202 accepted).
//      Logs the credited balance.
// All HTTP goes through the TurboPayment seam (attestation/turboHttp.ts). No clock (now is a parameter),
// no randomness; the retry sleep is injected.
//
// Due marker (kv KV_TURBO_TOPUP_AT): written whenever a DECISION was reached (idle, address-mismatch skip,
// or a transfer attempted — allowed or denied), so a paid-but-uncredited tx is never paid again within
// the interval. A thrown balance / info read writes nothing ⇒ retried on the next tick.

import type { Hex } from "viem";
import { TURBO_BASE_ETH_TOKEN, type TurboPayment } from "../attestation/turbo.js";
import { execute, type ExecDeps, type ExecResult } from "../exec/execute.js";
import { kvGet, kvSet, type MemoryDb } from "../memory/db.js";
import type { ProposedAction, UnixSeconds } from "../policy/types.js";
import { sameAddress, SECONDS_PER_DAY } from "../policy/util.js";

/** DEFAULT runtime.turboTopUp.lowWatermarkWinc. */
export const DEFAULT_TURBO_LOW_WATERMARK_WINC = 50_000_000_000n;
/** DEFAULT runtime.turboTopUp.amountWei (0.0005 ETH). */
export const DEFAULT_TURBO_TOPUP_AMOUNT_WEI = 500_000_000_000_000n;
/** POST {tx_id} attempts (SPEC-M3D §2: ≤ 5). */
export const TURBO_FUND_ATTEMPTS = 5;
/** Delay between POST {tx_id} attempts, ms (SPEC-M3D §2: 15 s). */
export const TURBO_FUND_RETRY_MS = 15_000;
/** kv key: last step-12 decision time (decimal unix seconds). */
export const KV_TURBO_TOPUP_AT = "turboTopUp.lastCheckAt";

export interface TurboTopUpLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface TurboTopUpDeps {
  payment: TurboPayment;
  /** Logged ExecDeps (the engine re-checks the transfer; its cfg supplies arweaveFundingAddress). */
  exec: ExecDeps;
  db: MemoryDb;
  lowWatermarkWinc: bigint;
  amountWei: bigint;
  logger: TurboTopUpLogger;
  sleep(ms: number): Promise<void>;
  /** DEFAULT TURBO_FUND_ATTEMPTS. */
  attempts?: number;
  /** DEFAULT TURBO_FUND_RETRY_MS. */
  retryMs?: number;
}

export interface TurboTopUpOutcome {
  skip?: string;
  notes: string[];
  results: ExecResult[];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Due iff no (parseable) marker, or now − marker ≥ intervalSec (DEFAULT daily). */
export function turboTopUpDue(db: MemoryDb, now: UnixSeconds, intervalSec: bigint = SECONDS_PER_DAY): boolean {
  const raw = kvGet(db, KV_TURBO_TOPUP_AT);
  if (raw === undefined || !/^\d+$/.test(raw)) return true;
  return now - BigInt(raw) >= intervalSec;
}

/** One step-12 run. Throws only when the balance / info read throws (⇒ step error, retried next tick). */
export async function runTurboTopUp(d: TurboTopUpDeps, now: UnixSeconds): Promise<TurboTopUpOutcome> {
  const notes: string[] = [];
  const results: ExecResult[] = [];
  const mark = (): void => kvSet(d.db, KV_TURBO_TOPUP_AT, now.toString(10));

  const balance = await d.payment.balanceWinc();
  if (balance >= d.lowWatermarkWinc) {
    mark();
    return { skip: `turbo balance ${balance} winc ≥ low watermark ${d.lowWatermarkWinc} winc`, notes, results };
  }
  notes.push(`turbo balance ${balance} winc < low watermark ${d.lowWatermarkWinc} winc`);

  const cfg = d.exec.cfg;
  const listed = await d.payment.paymentAddress(TURBO_BASE_ETH_TOKEN);
  if (listed === null || !sameAddress(listed, cfg.arweaveFundingAddress)) {
    mark();
    const msg =
      `!!! TURBO TOP-UP SKIPPED: payment service ${TURBO_BASE_ETH_TOKEN} address ${listed ?? "(none)"} != frozen arweaveFundingAddress ` +
      `${cfg.arweaveFundingAddress} — never paying an unverified address; snapshots stop publishing when credits run out !!!`;
    d.logger.warn(msg);
    notes.push(msg);
    return { skip: "payment address mismatch (fail closed)", notes, results };
  }

  const action: ProposedAction = {
    kind: "treasuryTransfer",
    purpose: "arweaveFunding",
    chain: "base",
    asset: "ETH",
    to: cfg.arweaveFundingAddress,
    amount: d.amountWei,
  };
  const r = await execute(action, d.exec);
  results.push(r);
  mark();
  if (!r.verdict.allow) {
    const msg = `turbo top-up denied: ${r.verdict.code}: ${r.verdict.detail}`;
    d.logger.warn(msg);
    notes.push(msg);
    return { notes, results };
  }
  const txHash: Hex | undefined = r.txHash;
  if (r.error !== undefined || txHash === undefined) {
    const msg = `!!! turbo top-up transfer FAILED (${r.error ?? "no tx hash"}) !!!`;
    d.logger.warn(msg);
    notes.push(msg);
    return { notes, results };
  }

  const attempts = d.attempts ?? TURBO_FUND_ATTEMPTS;
  const retryMs = d.retryMs ?? TURBO_FUND_RETRY_MS;
  let lastErr = "";
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await d.payment.submitFundTx(TURBO_BASE_ETH_TOKEN, txHash);
      notes.push(`turbo fund tx ${txHash} submitted (HTTP ${res.status}, attempt ${i})`);
      try {
        const after = await d.payment.balanceWinc();
        const msg = `turbo top-up: ${d.amountWei} wei paid (tx ${txHash}); credited balance ${after} winc (HTTP ${res.status})`;
        d.logger.info(msg);
        notes.push(msg);
      } catch (e) {
        notes.push(`turbo top-up: balance re-read failed (${errMsg(e)})`);
      }
      return { notes, results };
    } catch (e) {
      lastErr = errMsg(e);
      if (i < attempts) await d.sleep(retryMs);
    }
  }
  const msg = `!!! turbo top-up: tx ${txHash} PAID but NOT credited after ${attempts} attempts (${lastErr}) — submit tx_id manually !!!`;
  d.logger.warn(msg);
  notes.push(msg);
  return { notes, results };
}
