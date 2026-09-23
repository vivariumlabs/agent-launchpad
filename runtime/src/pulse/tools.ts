// SPEC-M2B §6 — THE tool table: the ONLY LLM → action mapping. No treasury-kind tool
// exists. `TOOL_TABLE` is exported as data so tests can assert that no entry maps to a
// treasury kind (walletForAction(kind) ∈ {action, fc, journal} for every `mapsTo`).
//
//   trade.swap                tokenIn, tokenOut, amountIn, minOut → swapExactIn (actionApprove + actionSwap)
//   wallet.transfer           asset, to, amount                   → actionTransfer
//   nft.mint                  target, value                       → actionMint
//   social.post / .reply      text (+parentHash)                  → castPost / castReply (contentHash runtime-side)
//   journal.write             text                                → journalWrite
//   watchlist.set             tokens[] (≤ 10)                     → kv write (no engine action)
//
// trade.lp does NOT exist (actionLp is NotImplemented — no modifyLiquidityRouter).
// Conserving tier: only social.post, social.reply, journal.write are offered AND mappable.
// Arg validation: strict zod (extra fields ⇒ bad args); amounts are decimal strings or safe
// integers ⇒ bigint (> 0; minOut ≥ 0). Content caps: post text ≤ cfg.postMaxBytes UTF-8
// bytes, journal text ≤ cfg.journalMaxBytes bytes.

import { keccak256, stringToBytes, type Address } from "viem";
import { z } from "zod";
import { addressSchema, bytes32Schema, type ResolvedConfig } from "../config/schema.js";
import type { SwapIntent, ExecExtras } from "../exec/execute.js";
import type { ToolCall } from "../llm/checks.js";
import type { ToolSpec } from "../llm/types.js";
import type { ProposedAction } from "../policy/types.js";
import type { Tier } from "./tier.js";

// ---------------------------------------------------------------------------
// arg primitives
// ---------------------------------------------------------------------------

const uintLike = z.union([
  z.string().regex(/^[0-9]{1,78}$/, "must be a base-10 integer string"),
  z
    .number()
    .int()
    .nonnegative()
    .refine((n) => Number.isSafeInteger(n), "must be a safe integer (use a decimal string)"),
]);

const positiveAmount = uintLike.transform((v) => BigInt(v)).refine((v) => v > 0n, "must be > 0");
const nonNegativeAmount = uintLike.transform((v) => BigInt(v));

const swapToken = z.union([z.literal("USDG"), addressSchema]);
const transferAsset = z.union([z.literal("USDG"), z.literal("ETH"), addressSchema]);
const text = z.string().min(1);

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

export type ToolName =
  | "trade.swap"
  | "wallet.transfer"
  | "nft.mint"
  | "social.post"
  | "social.reply"
  | "journal.write"
  | "watchlist.set";

export interface ToolDef {
  name: ToolName;
  description: string;
  args: Record<string, string>;
  /** Engine action kinds this tool can produce ([] = no engine action). */
  mapsTo: readonly ProposedAction["kind"][];
  /** Tiers in which the tool is offered and mappable. */
  tiers: readonly Tier[];
  schema: z.ZodTypeAny;
}

const ACTIVE: readonly Tier[] = ["Active"];
const ACTIVE_CONSERVING: readonly Tier[] = ["Active", "Conserving"];

export const TOOL_TABLE: readonly ToolDef[] = [
  {
    name: "trade.swap",
    description: "Swap on the RH TOKEN/USDG pool from the action wallet (one leg must be USDG).",
    args: { tokenIn: '"USDG" | token address', tokenOut: '"USDG" | token address', amountIn: "base-unit integer string", minOut: "base-unit integer string (≥ 0)" },
    mapsTo: ["actionApprove", "actionSwap"],
    tiers: ACTIVE,
    schema: z.object({ tokenIn: swapToken, tokenOut: swapToken, amountIn: positiveAmount, minOut: nonNegativeAmount }).strict(),
  },
  {
    name: "wallet.transfer",
    description: "Transfer from the action wallet on RH.",
    args: { asset: '"USDG" | "ETH" | token address', to: "address", amount: "base-unit integer string" },
    mapsTo: ["actionTransfer"],
    tiers: ACTIVE,
    schema: z.object({ asset: transferAsset, to: addressSchema, amount: positiveAmount }).strict(),
  },
  {
    name: "nft.mint",
    description: "Call mint() on an NFT contract from the action wallet, sending `value` wei.",
    args: { target: "address", value: "wei integer string" },
    mapsTo: ["actionMint"],
    tiers: ACTIVE,
    schema: z.object({ target: addressSchema, value: positiveAmount }).strict(),
  },
  {
    name: "social.post",
    description: "Publish a Farcaster post.",
    args: { text: "string (≤ postMaxBytes UTF-8 bytes)" },
    mapsTo: ["castPost"],
    tiers: ACTIVE_CONSERVING,
    schema: z.object({ text }).strict(),
  },
  {
    name: "social.reply",
    description: "Reply to a Farcaster cast.",
    args: { text: "string (≤ postMaxBytes UTF-8 bytes)", parentHash: "32-byte hex" },
    mapsTo: ["castReply"],
    tiers: ACTIVE_CONSERVING,
    schema: z.object({ text, parentHash: bytes32Schema }).strict(),
  },
  {
    name: "journal.write",
    description: "Append a public journal entry (Arweave).",
    args: { text: "string (≤ journalMaxBytes UTF-8 bytes)" },
    mapsTo: ["journalWrite"],
    tiers: ACTIVE_CONSERVING,
    schema: z.object({ text }).strict(),
  },
  {
    name: "watchlist.set",
    description: "Replace the market-data watchlist (≤ 10 token addresses).",
    args: { tokens: "address[] (≤ 10)" },
    mapsTo: [],
    tiers: ACTIVE,
    schema: z.object({ tokens: z.array(addressSchema).max(10) }).strict(),
  },
];

export function toolDef(name: string): ToolDef | undefined {
  return TOOL_TABLE.find((t) => t.name === name);
}

/** The tool schema offered to the LLM for a tier (Dormant/Evicted: none). */
export function toolSchemaFor(tier: Tier): ToolSpec[] {
  return TOOL_TABLE.filter((t) => t.tiers.includes(tier)).map((t) => ({ name: t.name, description: t.description, args: { ...t.args } }));
}

// ---------------------------------------------------------------------------
// mapping
// ---------------------------------------------------------------------------

export type ToolPlan =
  | { type: "swap"; tool: ToolName; intent: SwapIntent }
  | { type: "action"; tool: ToolName; action: ProposedAction; extras: ExecExtras; content?: string }
  | { type: "kv"; tool: ToolName; key: string; value: string }
  | { type: "skip"; tool: string; reason: string; badArgs: boolean };

export const WATCHLIST_KV_KEY = "watchlist";

export type ToolConfig = Pick<ResolvedConfig, "postMaxBytes" | "journalMaxBytes">;

export function utf8(s: string): Uint8Array {
  return stringToBytes(s);
}

/** castPost/castReply/journalWrite from a text: contentHash = keccak256(utf8 bytes), computed runtime-side. */
export function contentAction(
  kind: "castPost" | "journalWrite",
  body: string,
  cfg: ToolConfig,
): { ok: true; action: ProposedAction; extras: ExecExtras } | { ok: false; reason: string } {
  const bytes = utf8(body);
  if (kind === "castPost") {
    if (bytes.length > cfg.postMaxBytes) return { ok: false, reason: `post ${bytes.length} bytes > postMaxBytes ${cfg.postMaxBytes}` };
    return { ok: true, action: { kind: "castPost", contentHash: keccak256(bytes) }, extras: { messageBytes: bytes } };
  }
  if (BigInt(bytes.length) > cfg.journalMaxBytes) {
    return { ok: false, reason: `journal ${bytes.length} bytes > journalMaxBytes ${cfg.journalMaxBytes}` };
  }
  return {
    ok: true,
    action: { kind: "journalWrite", contentHash: keccak256(bytes), sizeBytes: BigInt(bytes.length) },
    extras: { journalBytes: bytes },
  };
}

function skip(tool: string, reason: string, badArgs: boolean): ToolPlan {
  return { type: "skip", tool, reason, badArgs };
}

/** Maps one LLM tool call to a plan. Never throws. */
export function mapToolCall(call: ToolCall, tier: Tier, cfg: ToolConfig): ToolPlan {
  const def = toolDef(call.tool);
  if (def === undefined) return skip(call.tool, `unknown tool "${call.tool}"`, false);
  if (!def.tiers.includes(tier)) return skip(call.tool, `tool "${call.tool}" not offered in tier ${tier}`, false);
  const parsed = def.schema.safeParse(call.args);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first !== undefined && first.path.length > 0 ? first.path.join(".") : "(args)";
    return skip(call.tool, `bad args: ${where}: ${first?.message ?? "invalid"}`, true);
  }
  const a: unknown = parsed.data;
  switch (def.name) {
    case "trade.swap": {
      const x = a as { tokenIn: Address | "USDG"; tokenOut: Address | "USDG"; amountIn: bigint; minOut: bigint };
      return { type: "swap", tool: def.name, intent: { tokenIn: x.tokenIn, tokenOut: x.tokenOut, amountIn: x.amountIn, minOut: x.minOut } };
    }
    case "wallet.transfer": {
      const x = a as { asset: Address | "USDG" | "ETH"; to: Address; amount: bigint };
      return { type: "action", tool: def.name, action: { kind: "actionTransfer", asset: x.asset, to: x.to, amount: x.amount }, extras: {} };
    }
    case "nft.mint": {
      const x = a as { target: Address; value: bigint };
      return { type: "action", tool: def.name, action: { kind: "actionMint", target: x.target, value: x.value }, extras: {} };
    }
    case "social.post": {
      const x = a as { text: string };
      const r = contentAction("castPost", x.text, cfg);
      if (!r.ok) return skip(def.name, r.reason, false);
      return { type: "action", tool: def.name, action: r.action, extras: r.extras, content: x.text };
    }
    case "social.reply": {
      const x = a as { text: string; parentHash: `0x${string}` };
      const bytes = utf8(x.text);
      if (bytes.length > cfg.postMaxBytes) return skip(def.name, `reply ${bytes.length} bytes > postMaxBytes ${cfg.postMaxBytes}`, false);
      return {
        type: "action",
        tool: def.name,
        action: { kind: "castReply", contentHash: keccak256(bytes), parentHash: x.parentHash },
        extras: { messageBytes: bytes },
        content: x.text,
      };
    }
    case "journal.write": {
      const x = a as { text: string };
      const r = contentAction("journalWrite", x.text, cfg);
      if (!r.ok) return skip(def.name, r.reason, false);
      return { type: "action", tool: def.name, action: r.action, extras: r.extras, content: x.text };
    }
    case "watchlist.set": {
      const x = a as { tokens: Address[] };
      const uniq = [...new Set(x.tokens.map((t) => t.toLowerCase()))];
      return { type: "kv", tool: def.name, key: WATCHLIST_KV_KEY, value: JSON.stringify(uniq) };
    }
  }
}
