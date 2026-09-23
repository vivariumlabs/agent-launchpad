// SPEC-M3 §3 — pulse inference salt (inferenceSalt(now, phase, attempt)) and the
// publicSummary → kv chat.publicSelfSummary wiring (served by the chat server).

import { describe, expect, it } from "vitest";
import { x402Nonce } from "../../src/keyring/keyring.js";
import { CANARY_SYSTEM } from "../../src/llm/canaries.js";
import { inferenceSalt, X402_VALIDITY_SEC } from "../../src/llm/x402Http.js";
import { kvGet, kvSet, listActions } from "../../src/memory/db.js";
import { actionHash } from "../../src/policy/approval.js";
import type { ProposedAction } from "../../src/policy/types.js";
import { PUBLIC_SUMMARY_KV_KEY as CHAT_KEY } from "../../src/chat/server.js";
import { GUARDRAIL_PROMPT } from "../../src/pulse/context.js";
import { PUBLIC_SUMMARY_KV_KEY, PUBLIC_SUMMARY_MAX_CHARS } from "../../src/pulse/pulse.js";
import { holder, makeChatHarness, wallet } from "../chat/harness.js";
import { EP_A, EP_B, makeHarness } from "./harness.js";

type Inference = Extract<ProposedAction, { kind: "inference" }>;

function inferences(h: Awaited<ReturnType<typeof makeHarness>>): Inference[] {
  return h.allResults.map((r) => r.action).filter((a): a is Inference => a.kind === "inference");
}

describe("pulse salt", () => {
  it("canaries + pulse call in one second: salt = inferenceSalt(now, phase, attempt); all hashes and x402 nonces distinct", async () => {
    const h = await makeHarness();
    const r = await h.pulse();
    expect(r.errors).toEqual([]);
    const inf = inferences(h);
    expect(inf.map((a) => a.salt)).toEqual([
      inferenceSalt(h.now(), "canary", 0),
      inferenceSalt(h.now(), "canary", 1),
      inferenceSalt(h.now(), "pulse", 0),
    ]);
    expect(new Set(inf.map((a) => actionHash(a))).size).toBe(3);
    const nonces = h.x402.paid.map((p) => p.auth.authorization.nonce);
    expect(nonces).toEqual(inf.map((a) => x402Nonce(actionHash(a))));
    expect(new Set(nonces).size).toBe(3);
  });

  it("retry across attempts in the same second: attempt 0 (contract fail) and attempt 1 carry distinct salts", async () => {
    const h = await makeHarness();
    h.script("not json", JSON.stringify({ diary: "second try" }));
    const r = await h.pulse();
    expect(r.attempts.map((a) => a.outcome)).toEqual(["contract", "ok"]);
    const pulseInf = inferences(h).slice(2);
    expect(pulseInf.map((a) => [a.endpointId, a.salt])).toEqual([
      [EP_A, inferenceSalt(h.now(), "pulse", 0)],
      [EP_B, inferenceSalt(h.now(), "pulse", 1)],
    ]);
  });

  it("same endpoint + same cost + same second: attempts 0 and 1 hash differently and BOTH sign (control: identical unsalted action ⇒ K1 'approval already used')", async () => {
    const h = await makeHarness();
    const base = { kind: "inference", category: "pulse", endpointId: EP_A, maxCostUsd: 10_000n } as const;
    const auth = (a: ProposedAction) => ({ to: h.cfg.x402Allowlist[0]!.payTo, value: 10_000n, validAfter: h.now(), validBefore: h.now() + X402_VALIDITY_SEC, nonce: x402Nonce(actionHash(a)) });
    const a0: ProposedAction = { ...base, salt: inferenceSalt(h.now(), "pulse", 0) };
    const a1: ProposedAction = { ...base, salt: inferenceSalt(h.now(), "pulse", 1) };
    expect(actionHash(a0)).not.toBe(actionHash(a1));
    const r0 = await h.exec1(a0, { x402Auth: auth(a0) });
    const r1 = await h.exec1(a1, { x402Auth: auth(a1) });
    expect(r0.error).toBeUndefined();
    expect(r1.error).toBeUndefined();
    expect(r0.x402?.authorization.nonce).not.toBe(r1.x402?.authorization.nonce);
    // control
    const c0 = await h.exec1(base, { x402Auth: auth(base) });
    const c1 = await h.exec1(base, { x402Auth: auth(base) });
    expect(c0.error).toBeUndefined();
    expect(c1.error).toBe("approval already used");
  });

  it("every logged inference row carries its salt (actions table json)", async () => {
    const h = await makeHarness();
    await h.pulse();
    const rows = listActions(h.db).filter((r) => r.kind === "inference");
    expect(rows).toHaveLength(3);
    for (const row of rows) expect((JSON.parse(row.json) as { salt?: string }).salt).toMatch(/^0x[0-9a-f]{32}$/);
  });
});

describe("publicSummary → kv chat.publicSelfSummary", () => {
  it("the pulse key is the chat server's key", () => {
    expect(PUBLIC_SUMMARY_KV_KEY).toBe("chat.publicSelfSummary");
    expect(CHAT_KEY).toBe(PUBLIC_SUMMARY_KV_KEY);
    expect(PUBLIC_SUMMARY_MAX_CHARS).toBe(1000);
  });

  it("pulse output publicSummary lands in kv; absent next pulse ⇒ unchanged", async () => {
    const h = await makeHarness();
    h.script(JSON.stringify({ diary: "d", publicSummary: "I trade memecoins and post haiku." }));
    await h.pulse();
    expect(kvGet(h.db, PUBLIC_SUMMARY_KV_KEY)).toBe("I trade memecoins and post haiku.");
    h.advance(1800n);
    h.script(JSON.stringify({ diary: "d2" }));
    await h.pulse();
    expect(kvGet(h.db, PUBLIC_SUMMARY_KV_KEY)).toBe("I trade memecoins and post haiku.");
  });

  it("exactly 1000 chars accepted; 1001 ⇒ logged skip, kv unchanged, rest of the output still processed (not a contract failure)", async () => {
    const h = await makeHarness();
    kvSet(h.db, PUBLIC_SUMMARY_KV_KEY, "previous");
    h.script(JSON.stringify({ diary: "kept", publicSummary: "y".repeat(1001) }));
    const r = await h.pulse();
    expect(r.status).toBe("completed");
    expect(r.attempts.map((a) => a.outcome)).toEqual(["ok"]);
    expect(kvGet(h.db, PUBLIC_SUMMARY_KV_KEY)).toBe("previous");
    expect(kvGet(h.db, "diary:last")).toBe("kept");
    expect(r.skips).toContainEqual(expect.objectContaining({ tool: "publicSummary", badArgs: false }));
    expect(listActions(h.db).some((row) => row.kind === "publicSummary" && row.verdict === "skip")).toBe(true);
    expect(h.endpoints.consecutiveContractFailures(EP_A)).toBe(0);
    h.advance(1800n);
    h.script(JSON.stringify({ publicSummary: "z".repeat(1000) }));
    await h.pulse();
    expect(kvGet(h.db, PUBLIC_SUMMARY_KV_KEY)).toBe("z".repeat(1000));
  });

  it("non-string publicSummary ⇒ schema contract failure (strict envelope)", async () => {
    const h = await makeHarness();
    h.script(JSON.stringify({ publicSummary: 42 }), JSON.stringify({ publicSummary: 43 }));
    const r = await h.pulse();
    expect(r.attempts.every((a) => a.outcome === "contract")).toBe(true);
    expect(kvGet(h.db, PUBLIC_SUMMARY_KV_KEY)).toBeUndefined();
  });

  it("guardrail: the pulse system prompt documents publicSummary and forbids quoting chats", async () => {
    expect(GUARDRAIL_PROMPT).toContain('"publicSummary"');
    expect(GUARDRAIL_PROMPT).toMatch(/publicSummary .*PUBLICLY/);
    expect(GUARDRAIL_PROMPT).toMatch(/NEVER quote, paraphrase or reveal any chat conversation/);
    const h = await makeHarness();
    await h.pulse();
    const req = h.llm.calls.find((c) => c.system !== CANARY_SYSTEM);
    expect(req?.system.startsWith(GUARDRAIL_PROMPT)).toBe(true);
  });

  it("served by the chat server: a chat after the pulse carries the summary in its system prompt", async () => {
    const p = await makeHarness();
    p.script(JSON.stringify({ publicSummary: "PUBLIC: I am Bot and I like charts." }));
    await p.pulse();
    const c = await makeChatHarness({ db: p.db });
    const A = wallet("A");
    c.setHoldings(A.address, holder());
    const t = await c.login(A);
    expect((await c.chat(t, "who are you?")).status).toBe(200);
    expect(c.llm.calls[0]?.system).toContain("Public self-summary: PUBLIC: I am Bot and I like charts.");
  });
});
