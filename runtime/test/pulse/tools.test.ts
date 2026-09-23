// SPEC-M2B §6 tool table: each tool → exact ProposedAction; unknown tool / bad args skip;
// content caps; Conserving filtering; the table maps to no treasury kind.

import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { walletForAction, type ProposedAction } from "../../src/policy/types.js";
import { TOOL_TABLE, WATCHLIST_KV_KEY, mapToolCall, toolSchemaFor, type ToolPlan } from "../../src/pulse/tools.js";
import { CP, E18, E6, TOKEN_X, TOKEN_Y, cfg } from "../policy/helpers.js";

const PARENT = `0x${"22".repeat(32)}` as const;

function map(tool: string, args: Record<string, unknown>, tier: "Active" | "Conserving" = "Active"): ToolPlan {
  return mapToolCall({ tool, args }, tier, cfg);
}

function action(p: ToolPlan): ProposedAction {
  if (p.type !== "action") throw new Error(`expected action plan, got ${p.type}: ${p.type === "skip" ? p.reason : ""}`);
  return p.action;
}

describe("tool table data", () => {
  it("exactly the §6 tools; no trade.lp; no treasury kind reachable", () => {
    expect(TOOL_TABLE.map((t) => t.name)).toEqual(["trade.swap", "wallet.transfer", "nft.mint", "social.post", "social.reply", "journal.write", "watchlist.set"]);
    const kinds = TOOL_TABLE.flatMap((t) => t.mapsTo);
    for (const k of kinds) expect(["action", "fc", "journal"]).toContain(walletForAction(k));
    expect(kinds).not.toContain("actionLp");
  });
  it("Active schema offers all 7; Conserving offers social+journal only; Dormant/Evicted none", () => {
    expect(toolSchemaFor("Active")).toHaveLength(7);
    expect(toolSchemaFor("Conserving").map((t) => t.name)).toEqual(["social.post", "social.reply", "journal.write"]);
    expect(toolSchemaFor("Dormant")).toEqual([]);
    expect(toolSchemaFor("Evicted")).toEqual([]);
  });
  it("mapsTo matches what the mapping actually produces", () => {
    const samples: Record<string, Record<string, unknown>> = {
      "wallet.transfer": { asset: "USDG", to: CP, amount: "1" },
      "nft.mint": { target: CP, value: "1" },
      "social.post": { text: "a" },
      "social.reply": { text: "a", parentHash: PARENT },
      "journal.write": { text: "a" },
    };
    for (const [tool, args] of Object.entries(samples)) {
      const def = TOOL_TABLE.find((t) => t.name === tool)!;
      expect(def.mapsTo).toEqual([action(map(tool, args)).kind]);
    }
    expect(TOOL_TABLE.find((t) => t.name === "trade.swap")!.mapsTo).toEqual(["actionApprove", "actionSwap"]);
    expect(TOOL_TABLE.find((t) => t.name === "watchlist.set")!.mapsTo).toEqual([]);
  });
});

describe("mapping: each tool → exact plan", () => {
  it("trade.swap → composite swap intent (no spender field anywhere)", () => {
    expect(map("trade.swap", { tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: (5n * E18).toString(), minOut: "0" })).toEqual({
      type: "swap",
      tool: "trade.swap",
      intent: { tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: 5n * E18, minOut: 0n },
    });
  });
  it("wallet.transfer → actionTransfer (number and string amounts)", () => {
    expect(action(map("wallet.transfer", { asset: "USDG", to: CP, amount: "1500000" }))).toEqual({ kind: "actionTransfer", asset: "USDG", to: CP, amount: 1_500_000n });
    expect(action(map("wallet.transfer", { asset: "ETH", to: CP, amount: 7 }))).toEqual({ kind: "actionTransfer", asset: "ETH", to: CP, amount: 7n });
    expect(action(map("wallet.transfer", { asset: TOKEN_Y, to: CP, amount: "1" }))).toEqual({ kind: "actionTransfer", asset: TOKEN_Y, to: CP, amount: 1n });
  });
  it("nft.mint → actionMint", () => {
    expect(action(map("nft.mint", { target: CP, value: "1000" }))).toEqual({ kind: "actionMint", target: CP, value: 1000n });
  });
  it("social.post / social.reply → castPost / castReply with runtime-computed contentHash + exact bytes", () => {
    const p = map("social.post", { text: "gm ☀" });
    const bytes = stringToBytes("gm ☀");
    expect(p).toEqual({ type: "action", tool: "social.post", action: { kind: "castPost", contentHash: keccak256(bytes) }, extras: { messageBytes: bytes }, content: "gm ☀" });
    const r = map("social.reply", { text: "hi", parentHash: PARENT });
    expect(action(r)).toEqual({ kind: "castReply", contentHash: keccak256(stringToBytes("hi")), parentHash: PARENT });
  });
  it("journal.write → journalWrite with sizeBytes = UTF-8 length", () => {
    const text = "día uno";
    const bytes = stringToBytes(text);
    expect(action(map("journal.write", { text }))).toEqual({ kind: "journalWrite", contentHash: keccak256(bytes), sizeBytes: BigInt(bytes.length) });
  });
  it("watchlist.set → kv write, lowercased + deduped", () => {
    const up = TOKEN_X.toUpperCase().replace("0X", "0x");
    expect(map("watchlist.set", { tokens: [TOKEN_X, up.toLowerCase(), TOKEN_Y] })).toEqual({
      type: "kv",
      tool: "watchlist.set",
      key: WATCHLIST_KV_KEY,
      value: JSON.stringify([TOKEN_X.toLowerCase(), TOKEN_Y.toLowerCase()]),
    });
  });
});

describe("mapping: skips", () => {
  it("unknown tools (incl. treasury-sounding names) ⇒ skip, not badArgs", () => {
    for (const t of ["treasury.transfer", "allowance", "treasuryTransfer", "inference", "trade.lp", "heartbeat", ""]) {
      const p = map(t, {});
      expect(p).toMatchObject({ type: "skip", badArgs: false });
    }
  });
  it("arg coercion failures ⇒ skip with badArgs", () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["wallet.transfer", { asset: "USDG", to: CP, amount: "-5" }],
      ["wallet.transfer", { asset: "USDG", to: CP, amount: -5 }],
      ["wallet.transfer", { asset: "USDG", to: CP, amount: "0" }],
      ["wallet.transfer", { asset: "USDG", to: CP, amount: "1e6" }],
      ["wallet.transfer", { asset: "USDG", to: CP, amount: 1.5 }],
      ["wallet.transfer", { asset: "USDG", to: CP, amount: 2 ** 60 }], // unsafe integer
      ["wallet.transfer", { asset: "USDG", to: CP, amount: "1".repeat(79) }],
      ["wallet.transfer", { asset: "USDC", to: CP, amount: "1" }],
      ["wallet.transfer", { asset: "USDG", to: "0x1234", amount: "1" }],
      ["wallet.transfer", { asset: "USDG", to: CP }],
      ["wallet.transfer", { asset: "USDG", to: CP, amount: "1", spender: CP }], // extra field
      ["trade.swap", { tokenIn: "USDG", tokenOut: TOKEN_X, amountIn: "1", minOut: "-1" }],
      ["trade.swap", { tokenIn: "ETH", tokenOut: TOKEN_X, amountIn: "1", minOut: "0" }],
      ["trade.swap", { tokenIn: "USDG", tokenOut: TOKEN_X, amountIn: "1", minOut: "0", spender: CP }],
      ["nft.mint", { target: CP, value: "0" }],
      ["social.post", { text: "" }],
      ["social.post", { text: 5 }],
      ["social.reply", { text: "x", parentHash: "0x22" }],
      ["watchlist.set", { tokens: Array.from({ length: 11 }, () => CP) }],
      ["watchlist.set", { tokens: ["nope"] }],
    ];
    for (const [tool, args] of bad) {
      const p = map(tool, args);
      expect(p.type, `${tool} ${JSON.stringify(args)}`).toBe("skip");
      if (p.type === "skip") {
        expect(p.badArgs).toBe(true);
        expect(p.reason).toMatch(/^bad args/);
      }
    }
  });
  it("content caps: post ≤ postMaxBytes (320) bytes, journal ≤ journalMaxBytes", () => {
    expect(map("social.post", { text: "x".repeat(320) }).type).toBe("action");
    expect(map("social.post", { text: "x".repeat(321) })).toMatchObject({ type: "skip", badArgs: false, reason: "post 321 bytes > postMaxBytes 320" });
    // multi-byte: 107 × "☀" (3 bytes) = 321 bytes
    expect(map("social.post", { text: "☀".repeat(107) }).type).toBe("skip");
    expect(map("social.reply", { text: "x".repeat(321), parentHash: PARENT }).type).toBe("skip");
    const max = Number(cfg.journalMaxBytes);
    expect(map("journal.write", { text: "j".repeat(max) }).type).toBe("action");
    expect(map("journal.write", { text: "j".repeat(max + 1) }).type).toBe("skip");
  });
  it("Conserving: trade/transfer/mint/watchlist are skipped even if called; social/journal map", () => {
    for (const t of ["trade.swap", "wallet.transfer", "nft.mint", "watchlist.set"]) {
      expect(map(t, {}, "Conserving")).toMatchObject({ type: "skip", badArgs: false });
    }
    expect(map("social.post", { text: "a" }, "Conserving").type).toBe("action");
    expect(map("journal.write", { text: "a" }, "Conserving").type).toBe("action");
  });
  it("USDG amounts are plain base units (E6 scale passes through)", () => {
    expect(action(map("wallet.transfer", { asset: "USDG", to: CP, amount: (3n * E6).toString() }))).toMatchObject({ amount: 3_000_000n });
  });
});
