// SPEC-M2B §3 executors.
//
// execute(action, deps, extras?):
//   1. evaluate(action, state, ledger, cfg, now)  — deny ⇒ return the recorded deny
//   2. applyApproved FIRST (budget consumed even if the tx later fails — conservative)
//   3. by kind:
//        tx kinds         ⇒ buildTx → nonce/fill from chain → keyring K2 → sendRaw
//        inference        ⇒ keyring K3 (returns the signed EIP-3009 auth; no tx) — or, with
//                            extras.meterOnly (free x402 endpoint), approval + ledger + log ONLY:
//                            nothing is signed and no x402Auth is required
//        castPost/Reply   ⇒ keyring K4 (ed25519 over messageBytes) → castSink
//        journalWrite     ⇒ bytes checked vs contentHash/sizeBytes → journalSink (memory write)
//   4. ExecResult {action, verdict, txHash?, error?, ...} — always passed to deps.log.
// actionLp throws NotImplementedError before evaluation (no modifyLiquidityRouter
// in the deployments manifest; the tool is absent from the LLM schema).
//
// Composite swaps: swapExactIn = actionApprove(amountIn) then actionSwap;
// treasurySwapExactIn = treasuryApprove(amountIn) then treasurySwap. Each step is
// an independent evaluate→execute with its own approval; a first-step deny (or
// failure) aborts.

import { keccak256, type Address, type Hex } from "viem";
import type { ResolvedConfig } from "../config/schema.js";
import type { Keyring, SignedX402Auth, X402AuthInput } from "../keyring/keyring.js";
import { applyApproved } from "../ledger/ledger.js";
import { evaluate } from "../policy/engine.js";
import {
  walletForAction,
  type Approval,
  type BudgetLedger,
  type ProposedAction,
  type UnixSeconds,
  type Verdict,
  type WalletState,
} from "../policy/types.js";
import { buildTx, NotImplementedError } from "./build.js";
import type { ChainClient } from "./chain.js";

export interface LedgerStore {
  get(): BudgetLedger;
  set(ledger: BudgetLedger): void;
}

export interface CastSink {
  publish(action: ProposedAction, messageBytes: Uint8Array, signature: Hex): Promise<void>;
}

export interface JournalSink {
  /** Persists the journal entry; returns a reference (e.g. Arweave txid / row id). */
  write(action: ProposedAction, bytes: Uint8Array): Promise<string>;
}

export interface ExecDeps {
  cfg: ResolvedConfig;
  keyring: Keyring;
  chain: ChainClient;
  getState(): WalletState | Promise<WalletState>;
  ledger: LedgerStore;
  /** Injected clock (unix seconds). */
  clock(): UnixSeconds;
  /** Memory log sink — every ExecResult (allow and deny) is passed here. */
  log?(result: ExecResult): void | Promise<void>;
  /**
   * Post-hoc annotation of an ALREADY-LOGGED ExecResult (same action) with info that only exists
   * after execute() returned — today the x402 settlement (X-PAYMENT-RESPONSE), which arrives on the
   * paid retry, after the approval row was written. Updates that row; never adds one.
   */
  annotate?(result: ExecResult): void | Promise<void>;
  castSink?: CastSink;
  journalSink?: JournalSink;
}

export interface ExecExtras {
  /** castPost/castReply: exact bytes whose keccak256 is action.contentHash. */
  messageBytes?: Uint8Array;
  /** journalWrite: exact bytes (keccak256 == contentHash, length == sizeBytes). */
  journalBytes?: Uint8Array;
  /** inference: EIP-3009 auth fields from the x402 quote. */
  x402Auth?: X402AuthInput;
  /**
   * inference only: METER-ONLY (free endpoint answered 200 without a 402). The engine approval,
   * ledger consumption and log happen exactly as for a paid call; K3 is NOT invoked and no
   * x402Auth is required (passing one together with meterOnly is a programming error ⇒ throws).
   */
  meterOnly?: boolean;
}

/**
 * x402 settlement info decoded from an X-PAYMENT-RESPONSE header (x402 spec v1) — SANITIZED fields
 * only (the header is endpoint-controlled and the actions log feeds the pulse context).
 */
export interface X402SettlementInfo {
  success?: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
}

export interface ExecResult {
  action: ProposedAction;
  verdict: Verdict;
  txHash?: Hex;
  error?: string;
  x402?: SignedX402Auth;
  /** Paid inference: settlement from X-PAYMENT-RESPONSE (set post-hoc via ExecDeps.annotate). */
  x402Settlement?: X402SettlementInfo;
  castSignature?: Hex;
  journalRef?: string;
}

async function finish(deps: ExecDeps, r: ExecResult): Promise<ExecResult> {
  if (deps.log !== undefined) await deps.log(r);
  return r;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function sendTx(action: ProposedAction, approval: Approval, deps: ExecDeps): Promise<Hex> {
  const wallet = walletForAction(action.kind);
  const own = deps.keyring.addresses();
  const from: Address = wallet === "treasury" ? own.treasury : own.action;
  const built = buildTx(action, deps.cfg, approval.issuedAt);
  const nonce = await deps.chain.getNonce(built.chain, from);
  const fee = await deps.chain.estimateFill(built.chain, { ...built, from });
  const signed = await deps.keyring.signTxApproved(action, approval, { nonce, ...fee }, deps.clock());
  const receipt = await deps.chain.sendRaw(built.chain, signed);
  if (receipt.status !== "success") {
    throw Object.assign(new Error(`tx ${receipt.hash} ${receipt.status}`), { txHash: receipt.hash });
  }
  return receipt.hash;
}

export async function execute(action: ProposedAction, deps: ExecDeps, extras: ExecExtras = {}): Promise<ExecResult> {
  const kind: unknown = (action as { kind?: unknown } | null | undefined)?.kind;
  if (kind === "actionLp") {
    throw new NotImplementedError("actionLp: no modifyLiquidityRouter in the deployments manifest");
  }
  if (extras.meterOnly === true) {
    if (kind !== "inference") throw new Error(`execute: meterOnly is for inference only (got ${String(kind)})`);
    if (extras.x402Auth !== undefined) throw new Error("execute: meterOnly and x402Auth are mutually exclusive");
  }

  const now = deps.clock();
  const state = await deps.getState();
  const ledger = deps.ledger.get();
  const verdict = evaluate(action, state, ledger, deps.cfg, now);
  if (!verdict.allow) return finish(deps, { action, verdict });

  // Budget consumed BEFORE any side effect (conservative; a failed send still counts).
  deps.ledger.set(applyApproved(ledger, action, now, state));

  const result: ExecResult = { action, verdict };
  const approval = verdict.approval;
  try {
    switch (action.kind) {
      case "inference": {
        if (extras.meterOnly === true) break; // free endpoint: metered (approval + ledger + log), nothing signed
        if (extras.x402Auth === undefined) throw new Error("inference: x402Auth required");
        result.x402 = await deps.keyring.signX402AuthApproved(action, approval, extras.x402Auth, deps.clock());
        break;
      }
      case "castPost":
      case "castReply": {
        const bytes = extras.messageBytes;
        if (bytes === undefined) throw new Error(`${action.kind}: messageBytes required`);
        const sig = await deps.keyring.signCastApproved(action, approval, bytes, deps.clock());
        result.castSignature = sig;
        if (deps.castSink !== undefined) await deps.castSink.publish(action, bytes, sig);
        break;
      }
      case "journalWrite": {
        const bytes = extras.journalBytes;
        if (bytes === undefined) throw new Error("journalWrite: journalBytes required");
        if (keccak256(bytes) !== action.contentHash.toLowerCase()) throw new Error("journalWrite: keccak256(bytes) != contentHash");
        if (BigInt(bytes.length) !== action.sizeBytes) throw new Error("journalWrite: byte length != sizeBytes");
        if (deps.journalSink === undefined) throw new Error("journalWrite: no journal sink");
        result.journalRef = await deps.journalSink.write(action, bytes);
        break;
      }
      default:
        result.txHash = await sendTx(action, approval, deps);
    }
  } catch (e) {
    result.error = errMsg(e);
    if (e instanceof Error && "txHash" in e && typeof e.txHash === "string") result.txHash = e.txHash as Hex;
  }
  return finish(deps, result);
}

// ---------------------------------------------------------------------------
// Composite swap executors
// ---------------------------------------------------------------------------

export interface SwapIntent {
  tokenIn: Address | "USDG";
  tokenOut: Address | "USDG";
  amountIn: bigint;
  minOut: bigint;
}

function stepOk(r: ExecResult): boolean {
  return r.verdict.allow && r.error === undefined;
}

/** Action-wallet exact-in swap: actionApprove(tokenIn, swapRouter, amountIn) → actionSwap.
 *  Dry-runs the swap verdict FIRST (evaluate is pure) so a swap that policy would
 *  deny never strands an on-chain approve (M2 s2 review). */
export async function swapExactIn(intent: SwapIntent, deps: ExecDeps): Promise<ExecResult[]> {
  const swapAction: ProposedAction = {
    kind: "actionSwap", tokenIn: intent.tokenIn, tokenOut: intent.tokenOut, amountIn: intent.amountIn, minOut: intent.minOut,
  };
  const pre = evaluate(swapAction, await deps.getState(), deps.ledger.get(), deps.cfg, deps.clock());
  if (!pre.allow) {
    const r: ExecResult = { action: swapAction, verdict: pre };
    if (deps.log !== undefined) await deps.log(r);
    return [r];
  }
  const token: Address = intent.tokenIn === "USDG" ? deps.cfg.usdg.rh : intent.tokenIn;
  const approve = await execute({ kind: "actionApprove", token, spender: deps.cfg.swapRouter.rh, amount: intent.amountIn }, deps);
  if (!stepOk(approve)) return [approve];
  const swap = await execute(
    { kind: "actionSwap", tokenIn: intent.tokenIn, tokenOut: intent.tokenOut, amountIn: intent.amountIn, minOut: intent.minOut },
    deps,
  );
  return [approve, swap];
}

export interface TreasurySwapIntent {
  tokenIn: Address;
  amountIn: bigint;
  minOut: bigint;
}

/** Treasury income conversion: treasuryApprove(tokenIn, swapRouter, amountIn) → treasurySwap.
 *  Same dry-run-first pattern as swapExactIn: no stranded treasury approve. */
export async function treasurySwapExactIn(intent: TreasurySwapIntent, deps: ExecDeps): Promise<ExecResult[]> {
  const swapAction: ProposedAction = { kind: "treasurySwap", tokenIn: intent.tokenIn, amountIn: intent.amountIn, minOut: intent.minOut };
  const pre = evaluate(swapAction, await deps.getState(), deps.ledger.get(), deps.cfg, deps.clock());
  if (!pre.allow) {
    const r: ExecResult = { action: swapAction, verdict: pre };
    if (deps.log !== undefined) await deps.log(r);
    return [r];
  }
  const approve = await execute(
    { kind: "treasuryApprove", token: intent.tokenIn, spender: deps.cfg.swapRouter.rh, amount: intent.amountIn },
    deps,
  );
  if (!stepOk(approve)) return [approve];
  const swap = await execute(
    { kind: "treasurySwap", tokenIn: intent.tokenIn, amountIn: intent.amountIn, minOut: intent.minOut },
    deps,
  );
  return [approve, swap];
}
