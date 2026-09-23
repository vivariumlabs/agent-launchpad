// SPEC-M3 §3 — chat inference salt (replaces the M2 µUSD cost-bump workaround).
// salt = inferenceSalt(now, walletLower, rowId); rowId = the `chats` 'in' row of the
// rate-limit insert. Same-second calls ⇒ distinct actionHash ⇒ distinct approvals and x402
// nonces, while maxCostUsd stays EXACTLY the estimate (no bump).

import { describe, expect, it } from "vitest";
import { x402Nonce } from "../../src/keyring/keyring.js";
import { inferenceSalt } from "../../src/llm/x402Http.js";
import { listActions, listChats } from "../../src/memory/db.js";
import { actionHash } from "../../src/policy/approval.js";
import type { ProposedAction } from "../../src/policy/types.js";
import { holder, makeChatHarness, wallet, type ChatHarness } from "./harness.js";

const A = wallet("A");
const B = wallet("B");

type Inference = Extract<ProposedAction, { kind: "inference" }>;

function paidActions(h: ChatHarness): Inference[] {
  return listActions(h.db)
    .filter((r) => r.kind === "inference" && r.verdict === "allow")
    .map((r) => {
      const j = JSON.parse(r.json) as { category: "chat"; endpointId: string; maxCostUsd: string; salt?: `0x${string}` };
      const a: Inference = { kind: "inference", category: j.category, endpointId: j.endpointId, maxCostUsd: BigInt(j.maxCostUsd) };
      if (j.salt !== undefined) a.salt = j.salt;
      return a;
    });
}

describe("SPEC-M3 §3 chat salt", () => {
  it("two same-second chats ⇒ distinct salts, action hashes and x402 nonces; auth value == approved maxCostUsd (no bump)", async () => {
    const h = await makeChatHarness();
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    expect((await h.chat(t, "same text")).status).toBe(200);
    expect((await h.chat(t, "same text")).status).toBe(200);
    const acts = paidActions(h);
    expect(acts).toHaveLength(2);
    const [a1, a2] = acts as [Inference, Inference];
    expect(a1.maxCostUsd).toBe(h.x402.paid[0]?.auth.authorization.value);
    expect(a1.salt).toBeDefined();
    expect(a1.salt).not.toBe(a2.salt);
    expect(actionHash(a1)).not.toBe(actionHash(a2));
    const nonces = h.x402.paid.map((p) => p.auth.authorization.nonce);
    expect(new Set(nonces).size).toBe(2);
    expect(nonces).toEqual([x402Nonce(actionHash(a1)), x402Nonce(actionHash(a2))]);
    // the auth value equals the approved maxCostUsd exactly (no µUSD adjustment anywhere).
    expect(h.x402.paid.map((p) => p.auth.authorization.value)).toEqual([a1.maxCostUsd, a2.maxCostUsd]);
  });

  it("salt = inferenceSalt(now, walletLower, rowId of this message's 'in' row)", async () => {
    const h = await makeChatHarness();
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    expect((await h.chat(t, "hello")).status).toBe(200);
    const inRow = listChats(h.db).find((c) => c.dir === "in");
    if (inRow === undefined) throw new Error("no in row");
    expect(paidActions(h)[0]?.salt).toBe(inferenceSalt(h.now(), A.address.toLowerCase(), inRow.id));
  });

  it("10 concurrent same-second chats (one wallet) ⇒ 10 distinct salts/approvals/nonces", async () => {
    const h = await makeChatHarness();
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    const rs = await Promise.all(Array.from({ length: 10 }, () => h.chat(t, "burst")));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const acts = paidActions(h);
    expect(new Set(acts.map((a) => a.salt)).size).toBe(10);
    expect(new Set(acts.map((a) => actionHash(a))).size).toBe(10);
    expect(new Set(h.x402.paid.map((p) => p.auth.authorization.nonce)).size).toBe(10);
  });

  it("6 wallets, first message each, same text, same second ⇒ identical prompts ⇒ ALL maxCostUsd EQUAL (the M2 bump made them distinct) yet distinct nonces", async () => {
    const h = await makeChatHarness();
    const ws = Array.from({ length: 6 }, (_, i) => wallet(`W${i}`));
    for (const w of ws) h.setHoldings(w.address, holder());
    const tokens = await Promise.all(ws.map((w) => h.login(w)));
    const rs = await Promise.all(tokens.map((t) => h.chat(t, "gm")));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const acts = paidActions(h);
    expect(acts).toHaveLength(6);
    expect(new Set(acts.map((a) => a.maxCostUsd)).size).toBe(1);
    expect(new Set(acts.map((a) => actionHash(a))).size).toBe(6);
    expect(new Set(h.x402.paid.map((p) => p.auth.authorization.nonce)).size).toBe(6);
  });

  it("two wallets in the same second ⇒ distinct salts (wallet + row id in the preimage)", async () => {
    const h = await makeChatHarness();
    h.setHoldings(A.address, holder());
    h.setHoldings(B.address, holder());
    const ta = await h.login(A);
    const tb = await h.login(B);
    await Promise.all([h.chat(ta, "x"), h.chat(tb, "x")]);
    const acts = paidActions(h);
    expect(acts).toHaveLength(2);
    expect(acts[0]?.salt).not.toBe(acts[1]?.salt);
  });

  it("ledger advances by exactly the sum of the approved (un-bumped) costs", async () => {
    const h = await makeChatHarness();
    h.setHoldings(A.address, holder());
    const t = await h.login(A);
    const before = h.ledger().inferenceSpent.chat;
    await Promise.all(Array.from({ length: 4 }, () => h.chat(t, "sum")));
    const sum = paidActions(h).reduce((s, a) => s + a.maxCostUsd, 0n);
    expect(h.ledger().inferenceSpent.chat - before).toBe(sum);
  });
});
