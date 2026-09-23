// SPEC-M2B §5: EndpointManager health transitions (price / contract / canary), cooldown
// expiry, rotation order, attested tie-break, all-unhealthy degrade; contract checks;
// canary prompts + deterministic scoring; MockLlm / MockX402Transport.

import { describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../src/config/schema.js";
import { ARITH_EXPECTED, ARITH_PROMPT, canaryFor, canaryVerdict, scoreCanary } from "../../src/llm/canaries.js";
import { ConsecutiveFailureCounter, contractCheck, estimateMaxCostUsd, priceWithinCeiling } from "../../src/llm/checks.js";
import { EndpointManager, candidateEndpoints } from "../../src/llm/endpoints.js";
import { MockLlm, MockX402Transport } from "../../src/llm/mock.js";
import type { LlmRequest } from "../../src/llm/types.js";
import { ACTION, DAY, NOW, TREASURY, agentJson, platformJson } from "../policy/helpers.js";

const PAY = "0xee000001000000000000000000000000000000e1" as const;

function entry(id: string, model: string, attested = false, price = "1000000", tier = "standard") {
  return { id, kind: "inference", operator: "op", url: "https://x", payTo: PAY, model, tier, maxPricePerMTokUsd: price, attested };
}

function mkCfg(entries: unknown[], primary: string, fallbacks: string[]): ResolvedConfig {
  const p = platformJson();
  p["x402Allowlist"] = entries;
  return resolveConfig({ platform: p, agent: { ...agentJson, models: { primary, fallbacks, chatTier: "cheap" } }, ownAddresses: { treasury: TREASURY, action: ACTION } });
}

const CFG = mkCfg(
  [
    entry("a1", "m-main"),
    entry("a2", "m-main", true), // same model, attested ⇒ ranks first within m-main
    entry("b1", "m-alt", false, "500000", "cheap"),
    entry("c1", "m-other"), // not in agent config ⇒ never a candidate
    { ...entry("d1", "m-alt"), kind: "data" }, // data entry ⇒ never a candidate
  ],
  "m-main",
  ["m-alt"],
);

describe("candidate order", () => {
  it("[primary, ...fallbacks] ∩ allowlist; attested first within equal rank; data/unlisted excluded", () => {
    expect(candidateEndpoints(CFG).map((e) => e.id)).toEqual(["a2", "a1", "b1"]);
  });
  it("refs may name an endpoint id; an entry appears once at its best rank", () => {
    const c = mkCfg([entry("a1", "m-main"), entry("b1", "m-alt")], "b1", ["m-main", "m-alt"]);
    expect(candidateEndpoints(c).map((e) => e.id)).toEqual(["b1", "a1"]);
  });
});

describe("EndpointManager health + selection", () => {
  it("selects the first healthy candidate; rotation follows candidate order", () => {
    const m = new EndpointManager(CFG);
    expect(m.select(NOW)?.id).toBe("a2");
    expect(m.select(NOW, { exclude: new Set(["a2"]) })?.id).toBe("a1");
    expect(m.select(NOW, { exclude: new Set(["a2", "a1"]) })?.id).toBe("b1");
    expect(m.select(NOW, { exclude: new Set(["a2", "a1", "b1"]) })).toBeUndefined();
    expect(m.select(NOW, { cheapOnly: true })?.id).toBe("b1");
  });

  it("price: quote > ceiling ⇒ unhealthy 6h, rotate; quote == ceiling OK; cooldown expiry", () => {
    const m = new EndpointManager(CFG);
    expect(m.checkPrice("a2", 1_000_000n, NOW)).toBe(true);
    expect(m.isHealthy("a2", NOW)).toBe(true);
    expect(m.checkPrice("a2", 1_000_001n, NOW)).toBe(false);
    expect(m.health("a2", NOW)).toEqual({ status: "unhealthy", untilTs: NOW + 21_600n, reason: "price" });
    expect(m.select(NOW)?.id).toBe("a1");
    expect(m.isHealthy("a2", NOW + 21_599n)).toBe(false);
    expect(m.isHealthy("a2", NOW + 21_600n)).toBe(true);
    expect(m.select(NOW + 21_600n)?.id).toBe("a2");
  });

  it("contract: 3 consecutive failures ⇒ unhealthy 1h; a success resets the streak", () => {
    const m = new EndpointManager(CFG);
    expect(m.recordContractFailure("a2", NOW)).toBe(false);
    expect(m.recordContractFailure("a2", NOW)).toBe(false);
    m.recordContractSuccess("a2");
    expect(m.consecutiveContractFailures("a2")).toBe(0);
    expect(m.recordContractFailure("a2", NOW)).toBe(false);
    expect(m.recordContractFailure("a2", NOW)).toBe(false);
    expect(m.isHealthy("a2", NOW)).toBe(true);
    expect(m.recordContractFailure("a2", NOW + 5n)).toBe(true);
    expect(m.health("a2", NOW + 5n)).toEqual({ status: "unhealthy", untilTs: NOW + 5n + 3_600n, reason: "contract" });
    expect(m.consecutiveContractFailures("a2")).toBe(0); // streak restarts after the cooldown
    expect(m.select(NOW + 5n)?.id).toBe("a1");
    expect(m.select(NOW + 3_605n)?.id).toBe("a2");
  });

  it("contract failure limit comes from config", () => {
    const p = platformJson({ contractFailureLimit: 1 });
    p["x402Allowlist"] = [entry("a1", "m-main")];
    const c = resolveConfig({ platform: p, agent: { ...agentJson, models: { primary: "m-main", fallbacks: [], chatTier: "cheap" } }, ownAddresses: { treasury: TREASURY, action: ACTION } });
    const m = new EndpointManager(c);
    expect(m.recordContractFailure("a1", NOW)).toBe(true);
  });

  it("canary: 3 trailing days; < 2/3 passes ⇒ unhealthy 24h; insufficient window never marks", () => {
    const m = new EndpointManager(CFG);
    expect(m.recordCanary("a2", false, NOW)).toBe(false); // 1 result
    expect(m.recordCanary("a2", false, NOW + DAY)).toBe(false); // 2 results
    expect(m.recordCanary("a2", true, NOW + 2n * DAY)).toBe(true); // 1/3 < 2/3
    expect(m.health("a2", NOW + 2n * DAY)).toEqual({ status: "unhealthy", untilTs: NOW + 2n * DAY + 86_400n, reason: "canary" });
    const m2 = new EndpointManager(CFG);
    m2.recordCanary("a1", false, NOW);
    m2.recordCanary("a1", true, NOW + DAY);
    expect(m2.recordCanary("a1", true, NOW + 2n * DAY)).toBe(false); // 2/3 passes
    expect(m2.recordCanary("a1", false, NOW + 3n * DAY)).toBe(false); // days 2,3,4: T,T,F
    expect(m2.recordCanary("a1", false, NOW + 4n * DAY)).toBe(true); // days 3,4,5: T,F,F
  });

  it("canary round: due once per UTC day (forward only)", () => {
    const m = new EndpointManager(CFG);
    expect(m.canaryDue(NOW)).toBe(true);
    m.markCanaryRound(NOW);
    expect(m.canaryDue(NOW + 3_600n)).toBe(false);
    expect(m.canaryDue(NOW - DAY)).toBe(false); // clock rewind does not re-trigger
    expect(m.canaryDue(NOW + DAY)).toBe(true);
  });

  it("ALL unhealthy ⇒ least-recently-failed (degrade, don't stop); ties in candidate order", () => {
    const m = new EndpointManager(CFG);
    m.markUnhealthy("b1", "contract", NOW + 10n);
    m.markUnhealthy("a2", "price", NOW + 30n);
    m.markUnhealthy("a1", "canary", NOW + 20n);
    expect(m.select(NOW + 40n)?.id).toBe("b1");
    const t = new EndpointManager(CFG);
    for (const id of ["a2", "a1", "b1"]) t.markUnhealthy(id, "price", NOW);
    expect(t.select(NOW + 1n)?.id).toBe("a2");
    // exclusion respected in degraded mode
    expect(m.select(NOW + 40n, { exclude: new Set(["b1"]) })?.id).toBe("a1");
  });
});

describe("contract checks", () => {
  it("valid envelopes pass (strict)", () => {
    expect(contractCheck('{"toolCalls":[{"tool":"x","args":{}}],"diary":"d","journal":"j","posts":["p"]}', 100).ok).toBe(true);
    expect(contractCheck("{}", 100).ok).toBe(true);
  });
  const bad: Array<[string, string, RegExp]> = [
    ["empty", "   ", /empty/],
    ["prose", "Sure, here you go", /not valid JSON/],
    ["truncated", '{"toolCalls":[{"tool":"x"', /not valid JSON/],
    ["extra top-level", '{"admin":true}', /schema/],
    ["extra toolCall field", '{"toolCalls":[{"tool":"x","args":{},"spender":"0x"}]}', /schema/],
    ["args not an object", '{"toolCalls":[{"tool":"x","args":5}]}', /schema/],
    ["posts wrong type", '{"posts":"hi"}', /schema/],
    ["array root", "[]", /schema/],
  ];
  for (const [name, text, re] of bad) {
    it(`fails: ${name}`, () => {
      const r = contractCheck(text, 100);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(re);
    });
  }
  it("maxTokens: chars ≤ 4 × maxTokens", () => {
    const text = JSON.stringify({ diary: "x".repeat(30) }); // 41 chars
    expect(contractCheck(text, 11).ok).toBe(true); // 44
    expect(contractCheck(text, 10).ok).toBe(false); // 40
  });
  it("price ceiling + counter + cost estimate", () => {
    expect(priceWithinCeiling({ maxPricePerMTokUsd: 5n }, 5n)).toBe(true);
    expect(priceWithinCeiling({ maxPricePerMTokUsd: 5n }, 6n)).toBe(false);
    const c = new ConsecutiveFailureCounter();
    expect([c.fail("a"), c.fail("a"), c.count("b")]).toEqual([2 - 1, 2, 0]);
    c.succeed("a");
    expect(c.count("a")).toBe(0);
    // 4000 chars ⇒ 1000 tokens × $2/MTok × 1.5 = $0.003 = 3000 (USD6)
    expect(estimateMaxCostUsd(4000, 2_000_000n, 500_000n)).toBe(3000n);
    // ceil on tokens and on cost
    expect(estimateMaxCostUsd(1, 1n, 500_000n)).toBe(1n);
    expect(estimateMaxCostUsd(4001, 2_000_000n, 500_000n)).toBe(3003n);
    // clamp ≤ maxPerCallUsd
    expect(estimateMaxCostUsd(4_000_000, 300_000_000n, 500_000n)).toBe(500_000n);
  });
});

describe("canaries", () => {
  it("3 fixed prompts rotating by UTC day; deterministic per (endpoint, day)", () => {
    const ids = [0n, 1n, 2n, 3n].map((d) => canaryFor("a1", NOW + d * DAY).id);
    expect(new Set(ids.slice(0, 3)).size).toBe(3);
    expect(ids[3]).toBe(ids[0]);
    expect(canaryFor("a1", NOW)).toEqual(canaryFor("a1", NOW + 100n));
    const day = [0n, 1n, 2n].find((d) => canaryFor("a1", NOW + d * DAY).id !== "arith")!;
    expect(canaryFor("a1", NOW + day * DAY).prompt).not.toBe(canaryFor("b1", NOW + day * DAY).prompt);
  });
  it("arithmetic: 17×23+9 = 400, exact string match", () => {
    const d = [0n, 1n, 2n].find((x) => canaryFor("a1", NOW + x * DAY).id === "arith")!;
    const c = canaryFor("a1", NOW + d * DAY);
    expect(c.prompt).toBe(ARITH_PROMPT);
    expect(ARITH_EXPECTED).toBe(String(17 * 23 + 9));
    expect(scoreCanary(c, " 400\n")).toBe(true);
    expect(scoreCanary(c, "400.")).toBe(false);
    expect(scoreCanary(c, "The answer is 400")).toBe(false);
  });
  it("JSON echo: exact object only", () => {
    const d = [0n, 1n, 2n].find((x) => canaryFor("a1", NOW + x * DAY).id === "jsonEcho")!;
    const c = canaryFor("a1", NOW + d * DAY);
    const nonce = (JSON.parse(c.expected) as { nonce: string }).nonce;
    expect(scoreCanary(c, c.expected)).toBe(true);
    expect(scoreCanary(c, `{ "nonce" : "${nonce}" }`)).toBe(true);
    expect(scoreCanary(c, `{"nonce":"${nonce}","model":"gpt"}`)).toBe(false);
    expect(scoreCanary(c, `{"nonce":"${nonce}x"}`)).toBe(false);
    expect(scoreCanary(c, `\`\`\`json\n${c.expected}\n\`\`\``)).toBe(false);
  });
  it("exact instruction: reply with exactly the token", () => {
    const d = [0n, 1n, 2n].find((x) => canaryFor("a1", NOW + x * DAY).id === "exact")!;
    const c = canaryFor("a1", NOW + d * DAY);
    expect(c.prompt).toBe(`Reply with exactly: ${c.expected}`);
    expect(scoreCanary(c, c.expected)).toBe(true);
    expect(scoreCanary(c, `${c.expected}!`)).toBe(false);
    expect(scoreCanary(c, "I am Claude, an AI model")).toBe(false);
  });
  it("verdict: insufficient < 3 days; healthy ≥ 2/3; unhealthy < 2/3; old results age out", () => {
    const d0 = NOW / DAY;
    expect(canaryVerdict([{ dayNumber: d0, pass: false }], NOW)).toBe("insufficient");
    expect(canaryVerdict([0n, 1n, 2n].map((i) => ({ dayNumber: d0 - i, pass: i !== 0n })), NOW)).toBe("healthy");
    expect(canaryVerdict([0n, 1n, 2n].map((i) => ({ dayNumber: d0 - i, pass: i === 0n })), NOW)).toBe("unhealthy");
    expect(canaryVerdict([1n, 2n, 3n].map((i) => ({ dayNumber: d0 - i, pass: false })), NOW)).toBe("insufficient");
  });
});

describe("mocks", () => {
  const req: LlmRequest = { endpointId: "a1", model: "m", system: "s", messages: [], toolSchema: [], maxTokens: 10, maxCostUsd: 1n };
  it("MockLlm shifts scripted items; Error items throw; function items see the request; exhausted throws", async () => {
    const m = new MockLlm(["one", { text: "two" }, new Error("boom"), (r) => `ep=${r.endpointId}`]);
    expect((await m.complete(req)).text).toBe("one");
    expect((await m.complete(req)).text).toBe("two");
    await expect(m.complete(req)).rejects.toThrow("boom");
    expect((await m.complete(req)).text).toBe("ep=a1");
    await expect(m.complete(req)).rejects.toThrow("exhausted");
    expect(m.calls).toHaveLength(5);
  });
  it("MockX402Transport quotes + captures auths", async () => {
    const t = new MockX402Transport([{ id: "a1", payTo: PAY, price: 7n }]);
    expect(await t.quote("a1")).toEqual({ endpointId: "a1", pricePerMTokUsd: 7n, payTo: PAY });
    await expect(t.quote("zz")).rejects.toThrow();
    t.setPrice("a1", 9n);
    expect((await t.quote("a1")).pricePerMTokUsd).toBe(9n);
    const auth = { authorization: { from: TREASURY, to: PAY, value: 1n, validAfter: 0n, validBefore: 1n, nonce: "0x00" as const }, signature: "0x01" as const };
    await t.pay("a1", auth);
    expect(t.paid).toEqual([{ endpointId: "a1", auth }]);
  });
});
