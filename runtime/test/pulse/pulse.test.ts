// SPEC-M2B §6 runPulse steps 1–9 (happy paths + plumbing). Adversarial cases: adversarial.test.ts.

import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { CANARY_SYSTEM } from "../../src/llm/canaries.js";
import { kvGet, listActions, listJournal, listPosts, listTrades, loadLedger } from "../../src/memory/db.js";
import { recordTierTransition } from "../../src/pulse/pulse.js";
import { promptChars } from "../../src/pulse/context.js";
import { estimateMaxCostUsd } from "../../src/llm/checks.js";
import { announceTierTransition } from "../../src/pulse/scheduler.js";
import { memoryExecDeps } from "../../src/pulse/pulse.js";
import { CP, E18, E6, TOKEN_X, mkLedger, mkRunwayState } from "../policy/helpers.js";
import { EP_A, EP_B, PRICE_A, assertStanding, makeHarness, respond } from "./harness.js";

describe("runPulse: happy path", () => {
  it("canaries → inference gate → LLM → tools → diary/journal/posts → heartbeat → persist", async () => {
    const h = await makeHarness();
    h.script(
      respond(
        [
          { tool: "wallet.transfer", args: { asset: "ETH", to: CP, amount: (E18 / 100n).toString() } },
          { tool: "trade.swap", args: { tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: (10n * E18).toString(), minOut: "5" } },
          { tool: "watchlist.set", args: { tokens: [TOKEN_X] } },
          { tool: "social.post", args: { text: "gm" } },
        ],
        { diary: "felt cute", journal: "entry one", posts: ["hello"] },
      ),
    );
    const r = await h.pulse();
    expect(r.errors).toEqual([]);
    expect(r.status).toBe("completed");
    expect(r.tier).toBe("Active");
    expect(r.level).toBe("full");
    expect(r.endpointUsed).toBe(EP_A);
    // canaries: one per candidate endpoint, first pulse of the day, both pass
    expect(r.canaries.map((c) => [c.endpointId, c.pass])).toEqual([
      [EP_A, true],
      [EP_B, true],
    ]);
    const kinds = r.results.map((x) => x.action.kind);
    expect(kinds).toEqual([
      "inference", // canary A
      "inference", // canary B
      "inference", // pulse
      "actionTransfer",
      "actionApprove",
      "actionSwap",
      "castPost", // tool social.post
      "journalWrite",
      "castPost", // posts[]
      "heartbeat",
    ]);
    expect(r.results.every((x) => x.verdict.allow && x.error === undefined)).toBe(true);
    // inference gate precedes the LLM call: 3 inference execs ⇔ 3 LLM calls ⇔ 3 x402 auths
    expect(h.llm.calls).toHaveLength(3);
    expect(h.x402.paid).toHaveLength(3);
    expect(h.llm.calls[2]!.system).not.toBe(CANARY_SYSTEM);
    expect(h.llm.calls[2]!.toolSchema.map((t) => t.name)).not.toContain("trade.lp");
    // memory
    expect(kvGet(h.db, "diary:last")).toBe("felt cute");
    expect(kvGet(h.db, "watchlist")).toBe(JSON.stringify([TOKEN_X.toLowerCase()]));
    expect(listJournal(h.db).map((j) => j.content)).toEqual(["entry one"]);
    expect(listPosts(h.db).map((p) => p.content)).toEqual(["gm", "hello"]);
    expect(listPosts(h.db)[0]!.castHash).toBe(keccak256(stringToBytes("gm")));
    expect(listTrades(h.db)).toHaveLength(1);
    expect(listTrades(h.db)[0]!.side).toBe("sell");
    // persisted ledger == live ledger
    expect(loadLedger(h.db)).toEqual(h.ledger());
    // heartbeat is the only treasury tx
    expect(h.chain.sentFrom(h.treasury)).toHaveLength(1);
    assertStanding(h);
  });

  it("second pulse the same day runs no canaries; context carries the last-N action log", async () => {
    const h = await makeHarness();
    await h.pulse();
    h.advance(1800n);
    const r = await h.pulse();
    expect(r.canaries).toEqual([]);
    const req = h.llm.calls[h.llm.calls.length - 1]!;
    expect(req.messages[0]!.content).toContain("heartbeat");
    assertStanding(h);
  });

  it("maxCostUsd = ceil(chars/4 × entry price × 1.5) and the K3 auth is bound to it", async () => {
    const h = await makeHarness();
    await h.pulse();
    const req = h.llm.calls[2]!;
    const chars = promptChars(req.system, req.messages, req.toolSchema);
    const tokens = BigInt(Math.ceil(chars / 4));
    const expected = (tokens * PRICE_A * 3n + 2_000_000n - 1n) / 2_000_000n;
    expect(req.maxCostUsd).toBe(expected);
    expect(req.maxCostUsd).toBe(estimateMaxCostUsd(chars, PRICE_A, h.cfg.maxPerCallUsd));
    const inf = h.allResults.filter((x) => x.action.kind === "inference")[2]!;
    expect(inf.action).toEqual({ kind: "inference", category: "pulse", endpointId: EP_A, maxCostUsd: expected });
    const auth = h.x402.paid[2]!.auth.authorization;
    expect(auth.value).toBe(expected);
    expect(auth.to.toLowerCase()).toBe(h.cfg.x402Allowlist[0]!.payTo.toLowerCase());
    expect(auth.validBefore - auth.validAfter).toBe(600n);
    expect(h.ledger().inferenceSpent.pulse).toBe(
      h.allResults.filter((x) => x.action.kind === "inference").reduce((s, x) => s + (x.action.kind === "inference" ? x.action.maxCostUsd : 0n), 0n),
    );
  });

  it("Conserving tier: schema is social+journal only; trade/transfer/mint calls are skipped; cheap endpoint preferred", async () => {
    // runway ≈ 10 days ⇒ Conserving. T0 rev 2 / I1 rev 2: inference runs under DEFAULT caps
    // (budget = min(raw, cap), floor-free; default ledger raw = 25 USDG).
    const h = await makeHarness({ state: mkRunwayState(17_000_000n), ledger: mkLedger() });
    h.script(
      respond([
        { tool: "trade.swap", args: { tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: "1", minOut: "0" } },
        { tool: "wallet.transfer", args: { asset: "ETH", to: CP, amount: "1" } },
        { tool: "nft.mint", args: { target: CP, value: "1" } },
        { tool: "watchlist.set", args: { tokens: [] } },
        { tool: "journal.write", args: { text: "conserving" } },
      ]),
    );
    const r = await h.pulse();
    expect(r.tier).toBe("Conserving");
    expect(r.endpointUsed).toBe(EP_B);
    const req = h.llm.calls[h.llm.calls.length - 1]!;
    expect(req.toolSchema.map((t) => t.name).sort()).toEqual(["journal.write", "social.post", "social.reply"]);
    expect(r.skips.map((s) => s.tool)).toEqual(["trade.swap", "wallet.transfer", "nft.mint", "watchlist.set"]);
    expect(r.skips.every((s) => /not offered in tier Conserving/.test(s.reason))).toBe(true);
    expect(h.chain.sentFrom(h.action)).toHaveLength(0);
    expect(r.results.filter((x) => x.action.kind === "journalWrite")).toHaveLength(1);
    assertStanding(h);
  });

  it("I1 rev 2: Conserving tier with NO fee income ⇒ floor withdrawn (B = 0) ⇒ INFERENCE_BUDGET, stretched, no LLM call", async () => {
    const h = await makeHarness({ state: mkRunwayState(17_000_000n), ledger: mkLedger({ feeIncome7d: [] }) });
    const r = await h.pulse();
    expect(r.tier).toBe("Conserving");
    expect(r.status).toBe("inferenceDenied");
    expect(r.inferenceDeny).toBe("INFERENCE_BUDGET");
    expect(r.stretch).toBe(true);
    expect(h.llm.calls).toHaveLength(0);
    expect(listActions(h.db).filter((x) => x.denyCode === "INFERENCE_BUDGET").length).toBeGreaterThan(0);
    assertStanding(h);
  });

  it("Dormant tier: no pulse, no LLM call, nothing spent", async () => {
    const h = await makeHarness({ state: mkRunwayState(1_700_000n), ledger: mkLedger() });
    const r = await h.pulse();
    expect(r.tier).toBe("Dormant");
    expect(r.status).toBe("skipped");
    expect(h.llm.calls).toHaveLength(0);
    expect(r.results).toHaveLength(0);
    expect(h.chain.sent).toHaveLength(0);
  });

  it("LLM throws on primary ⇒ contract failure counted, ONE retry on the fallback", async () => {
    const h = await makeHarness();
    h.script(new Error("timeout"), respond([]));
    const r = await h.pulse();
    expect(r.attempts.map((a) => [a.endpointId, a.outcome])).toEqual([
      [EP_A, "llmError"],
      [EP_B, "ok"],
    ]);
    expect(h.endpoints.consecutiveContractFailures(EP_A)).toBe(1);
    expect(r.status).toBe("completed");
  });

  it("price ceiling breach on the quote ⇒ unhealthy 6h, rotate, nothing paid to that endpoint", async () => {
    const h = await makeHarness({ priceA: 2_000_001n });
    const r = await h.pulse();
    expect(r.canaries.find((c) => c.endpointId === EP_A)?.outcome).toBe("price");
    const hA = h.endpoints.health(EP_A, h.now());
    expect(hA).toEqual({ status: "unhealthy", untilTs: h.now() + 21_600n, reason: "price" });
    expect(r.endpointUsed).toBe(EP_B);
    expect(h.x402.paid.every((p) => p.endpointId === EP_B)).toBe(true);
    assertStanding(h);
  });

  it("tier transition: logged + announcement castPost through the engine (pace caps apply)", async () => {
    const h = await makeHarness({ postsPerDay: 1 });
    recordTierTransition(h.db, { from: "Active", to: "Conserving" }, h.now());
    const ex = memoryExecDeps(h.exec, h.db);
    const a1 = await announceTierTransition({ from: "Active", to: "Conserving" }, ex);
    const a2 = await announceTierTransition({ from: "Conserving", to: "Dormant" }, ex);
    expect(a1?.verdict.allow).toBe(true);
    expect(a2?.verdict.allow).toBe(false);
    if (a2 !== null && !a2.verdict.allow) expect(a2.verdict.code).toBe("PACE_CAP");
    const rows = listActions(h.db);
    expect(rows[0]!.kind).toBe("tierTransition");
    expect(rows.map((x) => x.verdict)).toEqual(["info", "allow", "deny"]);
    expect(E6).toBe(1_000_000n);
  });
});

describe("runPulse: (5b) per-pulse dedup of identical tool-call-derived actions", () => {
  it("identical wallet.transfer / trade.swap calls after the first are dropped before evaluation and logged as dropped", async () => {
    const h = await makeHarness();
    const t = { tool: "wallet.transfer", args: { asset: "ETH", to: CP, amount: (E18 / 100n).toString() } };
    const t2 = { tool: "wallet.transfer", args: { asset: "ETH", to: CP, amount: (E18 / 100n + 1n).toString() } };
    const sw = { tool: "trade.swap", args: { tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: (10n * E18).toString(), minOut: "5" } };
    h.script(respond([t, t, sw, sw, t2]));
    const r = await h.pulse();
    expect(r.errors).toEqual([]);
    expect(r.toolCallsReceived).toBe(5);
    expect(r.toolCallsProcessed).toBe(3);
    expect(r.deduped).toBe(2);
    expect(r.dropped).toBe(0);
    const transfers = r.results.filter((x) => x.action.kind === "actionTransfer");
    expect(transfers).toHaveLength(2);
    expect(transfers.every((x) => x.verdict.allow)).toBe(true);
    expect(r.results.filter((x) => x.action.kind === "actionSwap")).toHaveLength(1);
    const dropped = listActions(h.db).filter((x) => x.verdict === "dropped");
    expect(dropped).toHaveLength(2);
    expect(dropped.every((x) => /duplicate of an earlier tool call/.test(x.error ?? ""))).toBe(true);
    assertStanding(h);
  });
});
