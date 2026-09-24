// SPEC-M2 §3 G1: shape validation of ProposedAction with zod BEFORE any rule
// logic. Unknown kind, missing/extra fields, non-bigint or <= 0n amounts, and
// non-address strings ⇒ MALFORMED.
//
// Field-level decisions:
// - Every amount field must be a bigint > 0n: treasuryTransfer.amount,
//   allowance.amount, treasurySwap.amountIn, treasurySwap.minOut (T5 requires
//   minOut > 0), inference.maxCostUsd, actionTransfer.amount,
//   actionSwap.amountIn, actionLp.usdgAmount, actionLp.tokenAmount,
//   actionMint.value.
// - actionSwap.minOut must be a bigint >= 0n (A4: "minOut >= 0 accepted as given").
// - actionLp.pool must be a 32-byte hex string (Uniswap-v4 PoolId).
// - Addresses validated with viem isAddress (mixed-case must be a valid checksum).
// - `recipient` on a treasuryTransfer whose purpose is not acrossBridge is an
//   extra field ⇒ MALFORMED.
// SPEC-M2B §1/§3 (additive):
// - `destChain` is REQUIRED for acrossBridge, forbidden for every other purpose,
//   and must differ from the source `chain` ⇒ else MALFORMED.
// - castPost/castReply: contentHash (and parentHash) 32-byte hex.
// - journalWrite: contentHash 32-byte hex, sizeBytes bigint > 0n.
// - actionApprove/treasuryApprove: token/spender addresses, amount bigint > 0n.
// SPEC-M3 §3 (additive):
// - inference.salt: OPTIONAL, exactly 16 bytes hex when present; forbidden on every other
//   kind (strict objects). Passed through untouched (hashed via canonicalEncode).
// SPEC-M3D §3d (additive):
// - fcRegister: priceWei bigint > 0n. No target field (K2 hardcodes the frozen idGateway) —
//   a caller-supplied target / to is an extra field ⇒ MALFORMED.
// - fcAddKey: key 32-byte hex (ed25519 pubkey), metadata non-empty even-length hex.
// - fcUserData: contentHash 32-byte hex, sizeBytes bigint > 0n.

import type { Hex } from "viem";
import { z } from "zod";
import { addressSchema, chainSchema } from "../config/schema.js";
import type { ProposedAction, UnixSeconds } from "./types.js";

const positive = z.bigint().refine((v) => v > 0n, { message: "must be > 0" });
const nonNegative = z.bigint().refine((v) => v >= 0n, { message: "must be >= 0" });
const bytes32 = z.custom<Hex>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v), {
  message: "must be 32-byte hex",
});
const hexBytes = z.custom<Hex>((v) => typeof v === "string" && /^0x([0-9a-fA-F]{2})+$/.test(v), {
  message: "must be non-empty even-length hex",
});
const bytes16 = z.custom<Hex>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{32}$/.test(v), {
  message: "must be 16-byte hex",
});

const purposeSchema = z.enum(["oysterRental", "acrossBridge", "arweaveFunding", "gasTopUp", "x402Data"]);

const actionAssetSchema = z.union([z.literal("USDG"), z.literal("ETH"), addressSchema]);
const swapTokenSchema = z.union([z.literal("USDG"), addressSchema]);

export const ProposedActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heartbeat") }).strict(),
  z.object({ kind: z.literal("registerInstance") }).strict(),
  z.object({ kind: z.literal("distribute") }).strict(),
  z
    .object({
      kind: z.literal("treasuryTransfer"),
      purpose: purposeSchema,
      chain: chainSchema,
      asset: z.enum(["USDG", "USDC", "ETH"]),
      to: addressSchema,
      amount: positive,
      recipient: addressSchema.optional(),
      destChain: chainSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("allowance"), amount: positive }).strict(),
  z.object({ kind: z.literal("treasurySwap"), tokenIn: addressSchema, amountIn: positive, minOut: positive }).strict(),
  z
    .object({
      kind: z.literal("inference"),
      category: z.enum(["pulse", "chat", "social"]),
      endpointId: z.string(),
      maxCostUsd: positive,
      salt: bytes16.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("actionTransfer"), asset: actionAssetSchema, to: addressSchema, amount: positive }).strict(),
  z
    .object({
      kind: z.literal("actionSwap"),
      tokenIn: swapTokenSchema,
      tokenOut: swapTokenSchema,
      amountIn: positive,
      minOut: nonNegative,
    })
    .strict(),
  z
    .object({
      kind: z.literal("actionLp"),
      pool: bytes32,
      usdgAmount: positive,
      tokenAmount: positive,
      token: addressSchema,
    })
    .strict(),
  z.object({ kind: z.literal("actionMint"), target: addressSchema, value: positive }).strict(),
  // SPEC-M2B §1
  z.object({ kind: z.literal("castPost"), contentHash: bytes32 }).strict(),
  z.object({ kind: z.literal("castReply"), contentHash: bytes32, parentHash: bytes32 }).strict(),
  z.object({ kind: z.literal("journalWrite"), contentHash: bytes32, sizeBytes: positive }).strict(),
  z.object({ kind: z.literal("actionApprove"), token: addressSchema, spender: addressSchema, amount: positive }).strict(),
  z.object({ kind: z.literal("treasuryApprove"), token: addressSchema, spender: addressSchema, amount: positive }).strict(),
  // SPEC-M3D §3d
  z.object({ kind: z.literal("fcRegister"), priceWei: positive }).strict(),
  z.object({ kind: z.literal("fcAddKey"), key: bytes32, metadata: hexBytes }).strict(),
  z.object({ kind: z.literal("fcUserData"), contentHash: bytes32, sizeBytes: positive }).strict(),
]);

export type ValidationResult = { ok: true; action: ProposedAction } | { ok: false; detail: string };

/** G1. Returns a freshly-built, validated copy of the action (rules evaluate and hash this copy). */
export function validateAction(input: unknown): ValidationResult {
  const r = ProposedActionSchema.safeParse(input);
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first !== undefined && first.path.length > 0 ? first.path.join(".") : "(root)";
    return { ok: false, detail: `G1: ${where}: ${first?.message ?? "invalid action"}` };
  }
  const a: ProposedAction = r.data;
  if (a.kind === "treasuryTransfer" && a.purpose !== "acrossBridge" && "recipient" in a && a.recipient !== undefined) {
    return { ok: false, detail: `G1: recipient is only permitted for acrossBridge (purpose=${a.purpose})` };
  }
  if (a.kind === "treasuryTransfer") {
    const hasDest = "destChain" in a && a.destChain !== undefined;
    if (a.purpose === "acrossBridge") {
      if (!hasDest) return { ok: false, detail: `G1: destChain is required for acrossBridge` };
      if (a.destChain === a.chain) return { ok: false, detail: `G1: destChain must differ from source chain (${a.chain})` };
    } else if (hasDest) {
      return { ok: false, detail: `G1: destChain is only permitted for acrossBridge (purpose=${a.purpose})` };
    }
  }
  return { ok: true, action: a };
}

/** `now` must be a non-negative bigint. */
export function validNow(now: unknown): now is UnixSeconds {
  return typeof now === "bigint" && now >= 0n;
}
