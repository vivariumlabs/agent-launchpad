// M3 s1 review fix 6 — pulse paidCall through the REAL x402 transport (X402HttpInference over a
// scripted MockHttp x402 server): mapping of PaidInferenceResult onto pulse outcomes, no double
// counting of transport-recorded endpoint failures, settlement persisted on the actions row.

import { describe, expect, it } from "vitest";
import { CANARY_SYSTEM } from "../../src/llm/canaries.js";
import { estimateMaxCostUsd } from "../../src/llm/checks.js";
import { X402HttpInference, type PaidInferenceResult } from "../../src/llm/x402Http.js";
import { PULSE_MAX_TOKENS } from "../../src/pulse/pulse.js";
import type { HttpRequest } from "../../src/llm/types.js";
import { listActions } from "../../src/memory/db.js";
import type { ProposedAction } from "../../src/policy/types.js";
import { mapPaidInference } from "../../src/pulse/pulse.js";
import { PAYTO_INF_CHEAP, PAYTO_INF_STD } from "../policy/helpers.js";
import { SETTLE_TX, x402Server } from "../llm/x402Server.js";
import { canaryAnswer, DEFAULT_PULSE_RESPONSE, EP_A, EP_B, makeHarness } from "./harness.js";
import type { LlmRequest } from "../../src/llm/types.js";

const URLS = { "https://a": PAYTO_INF_STD, "https://b": PAYTO_INF_CHEAP };
/** 1 µUSD: ≤ every chars-based estimate (estimateMaxCostUsd clamps to ≥ 1), incl. the tiny canary prompts. */
const CHEAP = 1n;

function answer(system: string, user: string): string {
  if (system === CANARY_SYSTEM) return canaryAnswer({ messages: [{ role: "user", content: user }] } as LlmRequest);
  return DEFAULT_PULSE_RESPONSE;
}

describe("mapPaidInference: every transport outcome ⇒ a pulse PaidCall", () => {
  const action: ProposedAction = { kind: "inference", category: "pulse", endpointId: EP_A, maxCostUsd: 1n };
  const auth = { authorization: { from: PAYTO_INF_STD, to: PAYTO_INF_STD, value: 1n, validAfter: 0n, validBefore: 1n, nonce: `0x${"00".repeat(32)}` }, signature: "0x" } as const;
  it.each<[PaidInferenceResult, unknown]>([
    [{ kind: "ok", text: "t", paid: true, action }, { kind: "ok", text: "t" }],
    [{ kind: "denied", code: "RUNWAY", detail: "d", action }, { kind: "denied", code: "RUNWAY", detail: "d" }],
    [{ kind: "quoteRejected", detail: "d" }, { kind: "price", detail: "d" }],
    [{ kind: "httpError", detail: "d" }, { kind: "llmError", detail: "d", recorded: true }],
    [{ kind: "payError", detail: "d", action }, { kind: "payError", detail: "d" }],
    [{ kind: "paymentRejected", detail: "d", action, auth: auth as never }, { kind: "payError", detail: "payment rejected: d" }],
    [{ kind: "contract", detail: "d", paid: true, action }, { kind: "contract", detail: "d" }],
  ])("transport %# ⇒ mapped", (r, want) => {
    expect(mapPaidInference(r)).toEqual(want);
  });
});

describe("runPulse with deps.paidInference (real transport over MockHttp)", () => {
  it("canaries + pulse are PAID through the transport; MockLlm / MockX402Transport untouched; settlement lands on the actions rows", async () => {
    const h = await makeHarness();
    const http = x402Server({ payTo: URLS, answer, amount: CHEAP });
    const paidInference = new X402HttpInference({ http, exec: h.exec, endpoints: h.endpoints });
    const r = await h.pulse({ paidInference });

    expect(r.status).toBe("completed");
    expect(r.errors).toEqual([]);
    expect(r.canaries.map((c) => [c.endpointId, c.outcome, c.pass])).toEqual([
      [EP_A, "ok", true],
      [EP_B, "ok", true],
    ]);
    expect(r.attempts).toEqual([{ endpointId: EP_A, outcome: "ok" }]);
    expect(h.llm.calls).toHaveLength(0);
    expect(h.x402.quotes).toHaveLength(0);
    // 3 paid calls ⇒ 3 × (unpaid POST + paid retry)
    expect(http.requests).toHaveLength(6);

    const inf = listActions(h.db).filter((a) => a.kind === "inference");
    expect(inf).toHaveLength(3);
    for (const row of inf) {
      expect(row.verdict).toBe("allow");
      expect(row.error).toBeNull();
      const j = JSON.parse(row.json) as { salt?: string; x402Settlement?: { transaction?: string } };
      expect(j.salt).toMatch(/^0x[0-9a-f]{32}$/);
      expect(j.x402Settlement?.transaction).toBe(SETTLE_TX);
    }
    expect(h.endpoints.consecutiveContractFailures(EP_A)).toBe(0);
  });

  it("free endpoint (200 without 402) ⇒ meterOnly: allow row with NO error, nothing signed", async () => {
    const h = await makeHarness();
    const http = x402Server({ payTo: URLS, answer, free: new Set(["https://a", "https://b"]) });
    const r = await h.pulse({ paidInference: new X402HttpInference({ http, exec: h.exec, endpoints: h.endpoints }) });
    expect(r.status).toBe("completed");
    const inf = listActions(h.db).filter((a) => a.kind === "inference");
    expect(inf).toHaveLength(3);
    for (const row of inf) {
      expect(row.verdict).toBe("allow");
      expect(row.error).toBeNull();
    }
    expect(http.requests).toHaveLength(3);
    expect(h.allResults.filter((x) => x.action.kind === "inference").every((x) => x.x402 === undefined)).toBe(true);
  });

  it("primary down (first POST transport error) ⇒ retry on the fallback; the failure is counted ONCE (by the transport)", async () => {
    const h = await makeHarness();
    h.endpoints.markCanaryRound(h.now()); // skip canaries: isolate the pulse attempt
    const http = x402Server({ payTo: URLS, answer, amount: CHEAP, down: new Set(["https://a"]) });
    const r = await h.pulse({ paidInference: new X402HttpInference({ http, exec: h.exec, endpoints: h.endpoints }) });
    expect(r.attempts.map((a) => [a.endpointId, a.outcome])).toEqual([
      [EP_A, "llmError"],
      [EP_B, "ok"],
    ]);
    expect(r.status).toBe("completed");
    expect(h.endpoints.consecutiveContractFailures(EP_A)).toBe(1);
  });

  it("price ceiling on the real 402 (quote > estimate) ⇒ outcome price, endpoint unhealthy, fallback used, nothing signed for the primary", async () => {
    const h = await makeHarness();
    h.endpoints.markCanaryRound(h.now());
    const http = x402Server({ payTo: { "https://a": PAYTO_INF_STD, "https://b": PAYTO_INF_CHEAP }, answer, amount: 10n ** 9n });
    const r = await h.pulse({ paidInference: new X402HttpInference({ http, exec: h.exec, endpoints: h.endpoints }) });
    expect(r.attempts.map((a) => [a.endpointId, a.outcome])).toEqual([
      [EP_A, "price"],
      [EP_B, "price"],
    ]);
    expect(r.status).toBe("noResponse");
    expect(listActions(h.db).filter((a) => a.kind === "inference")).toHaveLength(0);
  });

  it("SPEC-M3 §3c: a quote priced for FULL output (max_tokens 2048 at the allowlist's $2/MTok) is NOT price-rejected", async () => {
    const h = await makeHarness();
    h.endpoints.markCanaryRound(h.now()); // isolate the pulse call (maxTokens 2048)
    const ep = h.cfg.x402Allowlist.find((e) => e.id === EP_A)!;
    expect(ep.maxPricePerMTokUsd).toBe(2_000_000n); // realistic per-MTok price (fixture allowlist)
    expect(PULSE_MAX_TOKENS).toBe(2048);
    // An honest endpoint: bills ceil((inputTokens + max_tokens) × price / 1e6), input = chars/4 of the body's messages.
    const quotes: Array<{ quoted: bigint; inputOnlyEstimate: bigint; maxTokens: number }> = [];
    const amountFor = (req: HttpRequest): bigint => {
      const body = JSON.parse(req.body) as { max_tokens: number; messages: Array<{ content: string }> };
      const chars = body.messages.reduce((n, m) => n + m.content.length, 0);
      const tokens = BigInt(Math.ceil(chars / 4) + body.max_tokens);
      const quoted = (tokens * ep.maxPricePerMTokUsd + 999_999n) / 1_000_000n;
      quotes.push({ quoted, inputOnlyEstimate: estimateMaxCostUsd(chars, 0, ep.maxPricePerMTokUsd, h.cfg.maxPerCallUsd), maxTokens: body.max_tokens });
      return quoted;
    };
    const http = x402Server({ payTo: URLS, answer, amountFor });
    const r = await h.pulse({ paidInference: new X402HttpInference({ http, exec: h.exec, endpoints: h.endpoints }) });

    expect(r.attempts).toEqual([{ endpointId: EP_A, outcome: "ok" }]);
    expect(r.status).toBe("completed");
    expect(quotes).toHaveLength(1);
    const q = quotes[0]!;
    expect(q.maxTokens).toBe(2048);
    // the regression: an input-only estimate would have rejected this honest quote
    expect(q.quoted).toBeGreaterThan(q.inputOnlyEstimate);
    // paid exactly the quote (min(estimate, quoted)), within the per-call cap
    const inf = h.allResults.filter((x) => x.action.kind === "inference");
    expect(inf).toHaveLength(1);
    expect(inf[0]!.x402?.authorization.value).toBe(q.quoted);
    expect(q.quoted).toBeLessThanOrEqual(h.cfg.maxPerCallUsd);
  });
});
