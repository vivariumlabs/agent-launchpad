// M3 s1 review fix 6 — chat step 3+4 through the REAL x402 transport (X402HttpInference over a
// scripted MockHttp x402 server): reply, refusal and error mapping; failures counted once;
// settlement persisted on the chat inference's actions row.

import { describe, expect, it } from "vitest";
import { listActions, listChats } from "../../src/memory/db.js";
import { DAY, E6, NOW, PAYTO_INF_CHEAP, PAYTO_INF_STD, mkLedger, mkState } from "../policy/helpers.js";
import { SETTLE_TX, x402Server } from "../llm/x402Server.js";
import { EP_CHEAP, holder, makeChatHarness, wallet } from "./harness.js";

const A = wallet("A");
const URLS = { "https://a": PAYTO_INF_STD, "https://b": PAYTO_INF_CHEAP };
const answer = (_system: string, user: string): string => `echo: ${user}`;

describe("chat /chat with deps.paidInference (real transport)", () => {
  it("paid 200 ⇒ reply stored, MockLlm/MockX402Transport untouched, settlement on the actions row, success recorded", async () => {
    const http = x402Server({ payTo: URLS, answer, amount: 1n });
    const h = await makeChatHarness({ x402Http: http });
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    const r = await h.chat(t, "hi there");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body["reply"]).toBe("echo: hi there");
    expect(h.llm.calls).toHaveLength(0);
    expect(h.x402.quotes).toHaveLength(0);
    expect(http.requests.map((q) => q.url)).toEqual(["https://b", "https://b"]); // cheap tier only
    expect(listChats(h.db).filter((c) => c.dir === "out").map((c) => c.content)).toEqual(["echo: hi there"]);
    const inf = listActions(h.db).filter((a) => a.kind === "inference");
    expect(inf).toHaveLength(1);
    const j = JSON.parse(inf[0]!.json) as { category: string; endpointId: string; x402Settlement?: { transaction?: string } };
    expect(j.category).toBe("chat");
    expect(j.endpointId).toBe(EP_CHEAP);
    expect(j.x402Settlement?.transaction).toBe(SETTLE_TX);
    expect(h.endpoints.consecutiveContractFailures(EP_CHEAP)).toBe(0);
  });

  it("engine deny on the quote (chat budget exhausted) ⇒ 200 refusal with the deny code, no paid retry", async () => {
    const http = x402Server({ payTo: URLS, answer, amount: 1n });
    const h = await makeChatHarness({ x402Http: http, ledger: mkLedger({ feeIncome7d: [], inferenceSpent: { pulse: 0n, chat: 100n * E6, social: 0n } }) });
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    const r = await h.chat(t, "hi");
    expect(r.status).toBe(200);
    expect(r.body["refused"]).toBe(true);
    expect(typeof r.body["denyCode"]).toBe("string");
    expect(http.requests.filter((q) => q.headers["x-payment"] !== undefined)).toHaveLength(0);
  });

  it("Dormant (RUNWAY) ⇒ refusal WITHOUT any HTTP request", async () => {
    const http = x402Server({ payTo: URLS, answer, amount: 1n });
    const h = await makeChatHarness({ x402Http: http, state: mkState({ hostingPaidUntil: NOW - 6000n * DAY }) });
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    const r = await h.chat(t, "hi");
    expect(r.status).toBe(200);
    expect(r.body["denyCode"]).toBe("RUNWAY");
    expect(http.requests).toHaveLength(0);
  });

  it("quote over the estimate ⇒ 503 price_ceiling, nothing executed", async () => {
    const http = x402Server({ payTo: URLS, answer, amount: 10n ** 9n });
    const h = await makeChatHarness({ x402Http: http });
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    const r = await h.chat(t, "hi");
    expect(r.status).toBe(503);
    expect(r.body["error"]).toBe("price_ceiling");
    expect(listActions(h.db).filter((a) => a.kind === "inference")).toHaveLength(0);
  });

  it("provider down ⇒ 503 quote_failed; the endpoint failure is counted ONCE", async () => {
    const http = x402Server({ payTo: URLS, answer, amount: 1n, down: new Set(["https://b"]) });
    const h = await makeChatHarness({ x402Http: http });
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    const r = await h.chat(t, "hi");
    expect(r.status).toBe(503);
    expect(r.body["error"]).toBe("quote_failed");
    expect(h.endpoints.consecutiveContractFailures(EP_CHEAP)).toBe(1);
  });
});
