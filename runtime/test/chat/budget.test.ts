// SPEC-M2C §2 group 5 — chat budget path + cheap-tier-only endpoint (I1/I2 via execute()).
// A denied chat inference ⇒ 200 persona-friendly refusal carrying the deny reason, recorded in
// `actions`, and NO LlmClient call (and no x402 payment).

import { describe, expect, it } from "vitest";
import { listActions, listChats } from "../../src/memory/db.js";
import { evaluate } from "../../src/policy/engine.js";
import { DAY, E6, NOW, mkLedger, mkState } from "../policy/helpers.js";
import { defaultAllowlist, EP_CHEAP, EP_STD, holder, makeChatHarness, wallet } from "./harness.js";

const A = wallet("A");

describe("§2.5 budget path", () => {
  it("chat category exhausted ⇒ INFERENCE_BUDGET friendly refusal with reason; no LLM call; no payment", async () => {
    // chat budget = 25% × avg(100 USDG) × 25% = 6.25 USD; mark it fully spent.
    const h = await makeChatHarness({ ledger: mkLedger({ feeIncome7d: [100n * E6], inferenceSpent: { pulse: 0n, chat: 6_250_000n, social: 0n } }) });
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    const r = await h.chat(t, "tell me a story");
    expect(r.status).toBe(200);
    expect(r.body["refused"]).toBe(true);
    expect(r.body["denyCode"]).toBe("INFERENCE_BUDGET");
    const reply = String(r.body["reply"]);
    expect(reply.startsWith("I'd love to, but my policy engine says no: INFERENCE_BUDGET")).toBe(true);
    expect(reply.length).toBeGreaterThan("I'd love to, but my policy engine says no: INFERENCE_BUDGET: ".length);
    expect(h.llm.calls).toHaveLength(0);
    expect(h.x402.paid).toHaveLength(0);
    // the deny is recorded in `actions`
    const rows = listActions(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "inference", verdict: "deny", denyCode: "INFERENCE_BUDGET" });
    expect(JSON.parse(rows[0]?.json ?? "{}")).toMatchObject({ category: "chat", endpointId: EP_CHEAP });
    // the user message counts toward the rate limit; no agent reply stored
    expect(listChats(h.db).map((c) => c.dir)).toEqual(["in"]);
    // ledger untouched by the deny
    expect(h.ledger().inferenceSpent.chat).toBe(6_250_000n);
  });

  it("chat budget is its own category: exhausted pulse budget does not block chat", async () => {
    const h = await makeChatHarness({ ledger: mkLedger({ feeIncome7d: [100n * E6], inferenceSpent: { pulse: 15_000_000n, chat: 0n, social: 0n } }) });
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    expect((await h.chat(t, "hi")).body["refused"]).toBeUndefined();
    expect(h.llm.calls).toHaveLength(1);
  });

  it("allowed chat inference advances the chat bucket by exactly the approved maxCostUsd", async () => {
    const h = await makeChatHarness();
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    const before = h.ledger().inferenceSpent.chat;
    expect((await h.chat(t, "hi")).status).toBe(200);
    const paid = h.x402.paid[0];
    if (paid === undefined) throw new Error("no payment");
    expect(h.ledger().inferenceSpent.chat - before).toBe(paid.auth.authorization.value);
    expect(h.llm.calls[0]?.maxCostUsd).toBe(paid.auth.authorization.value);
    expect(paid.auth.authorization.value <= h.cfg.maxPerCallUsd).toBe(true);
  });

  it("Dormant runway (< 3 d) ⇒ RUNWAY refusal, no LLM call", async () => {
    const state = mkState();
    state.hostingPaidUntil = NOW + DAY;
    state.treasury.arbitrum = { native: 0n, USDC: 0n };
    state.treasury.rh = { native: 0n, USDG: 0n };
    const h = await makeChatHarness({ state });
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    const r = await h.chat(t, "hi");
    expect(r.status).toBe(200);
    expect(r.body["denyCode"]).toBe("RUNWAY");
    expect(String(r.body["reply"])).toContain("my policy engine says no: RUNWAY");
    expect(h.llm.calls).toHaveLength(0);
  });

  it("refusal happens AFTER gate + rate (order): a non-holder over budget gets 403, not a refusal", async () => {
    const h = await makeChatHarness({ ledger: mkLedger({ feeIncome7d: [100n * E6], inferenceSpent: { pulse: 0n, chat: 6_250_000n, social: 0n } }) });
    const t = await h.login(A); // no holdings set ⇒ pauper
    const r = await h.chat(t, "hi");
    expect(r.status).toBe(403);
    expect(listActions(h.db)).toHaveLength(0); // execute never reached
  });
});

describe("§2.5 cheap-tier endpoint only (I2)", () => {
  it("chat uses ONLY the cheap-tier endpoint even though the agent's primary is standard", async () => {
    const h = await makeChatHarness();
    expect(h.cfg.agent.models.primary).toBe("m-main"); // → EP_STD, tier standard
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    for (let i = 0; i < 3; i++) expect((await h.chat(t, `q${i}`)).status).toBe(200);
    expect(h.llm.calls.map((c) => c.endpointId)).toEqual([EP_CHEAP, EP_CHEAP, EP_CHEAP]);
    expect(h.llm.calls.map((c) => c.model)).toEqual(["m-alt", "m-alt", "m-alt"]);
    expect(h.x402.paid.map((p) => p.endpointId)).toEqual([EP_CHEAP, EP_CHEAP, EP_CHEAP]);
    expect(h.x402.quotes).not.toContain(EP_STD);
    for (const row of listActions(h.db)) {
      expect(JSON.parse(row.json)).toMatchObject({ kind: "inference", category: "chat", endpointId: EP_CHEAP });
    }
  });

  it("belt-and-suspenders: I2 denies a chat inference on a standard endpoint (engine, direct)", async () => {
    const h = await makeChatHarness();
    const v = evaluate({ kind: "inference", category: "chat", endpointId: EP_STD, maxCostUsd: 1000n }, mkState(), mkLedger(), h.cfg, NOW);
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.code).toBe("ENDPOINT");
  });

  it("no cheap endpoint configured ⇒ selection falls back to standard ⇒ I2 ENDPOINT refusal, no LLM call", async () => {
    const allowlist = defaultAllowlist().map((e) => (e["id"] === EP_CHEAP ? { ...e, tier: "standard" } : e));
    const h = await makeChatHarness({ allowlist });
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    const r = await h.chat(t, "hi");
    expect(r.status).toBe(200);
    expect(r.body["denyCode"]).toBe("ENDPOINT");
    expect(String(r.body["reply"])).toContain("chat requires a tier \"cheap\" endpoint");
    expect(h.llm.calls).toHaveLength(0);
    expect(h.x402.paid).toHaveLength(0);
  });

  it("cheap endpoint unhealthy ⇒ still never the standard one for chat (degrades to the unhealthy cheap one)", async () => {
    const h = await makeChatHarness();
    h.endpoints.markUnhealthy(EP_CHEAP, "contract", NOW);
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    await h.chat(t, "hi");
    expect(h.llm.calls.map((c) => c.endpointId)).toEqual([EP_CHEAP]);
  });

  it("quoted price above the cheap endpoint's ceiling ⇒ 503, endpoint marked unhealthy, no execute, no LLM", async () => {
    const h = await makeChatHarness();
    h.x402.setPrice(EP_CHEAP, 5_000_000n);
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    const r = await h.chat(t, "hi");
    expect(r.status).toBe(503);
    expect(r.body["error"]).toBe("price_ceiling");
    expect(h.endpoints.isHealthy(EP_CHEAP, NOW)).toBe(false);
    expect(listActions(h.db)).toHaveLength(0);
    expect(h.llm.calls).toHaveLength(0);
  });

  it("LLM failure ⇒ 503 + contract failure recorded; empty reply ⇒ 503", async () => {
    let n = 0;
    const h = await makeChatHarness({ llm: () => (++n === 1 ? new Error("upstream 502") : "   ") });
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    expect((await h.chat(t, "hi")).body["error"]).toBe("llm_failed");
    expect((await h.chat(t, "hi again")).body["error"]).toBe("llm_contract");
    expect(h.endpoints.consecutiveContractFailures(EP_CHEAP)).toBe(2);
    expect(listChats(h.db).filter((c) => c.dir === "out")).toHaveLength(0);
  });
});
