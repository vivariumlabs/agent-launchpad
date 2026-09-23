// SPEC-M2C §2 group 2 — balance-flash + dual-RPC fail-closed matrix (D9, 03 §5/§11).
// The gate is re-read on EVERY message (no caching); both readers must resolve AND agree;
// anything else is a 503 fail-closed refusal with no rate row and no LLM call.

import type { Address } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { createDualGate, gatePasses, type Holdings } from "../../src/chat/gate.js";
import { listChats } from "../../src/memory/db.js";
import { holder, makeChatHarness, MockBalanceReader, pauper, SUPPLY, wallet, type ChatHarness, type ReaderMode } from "./harness.js";

const A = wallet("A");
const P = { agentBps: 10, platformBps: 100 };

let h: ChatHarness;
let token: string;
beforeEach(async () => {
  h = await makeChatHarness();
  h.setHoldings(A.address, holder());
  token = await h.login(A);
});

function inRows(): number {
  return listChats(h.db).filter((c) => c.dir === "in").length;
}

/** Let pending reader promises + the gate race settle so the timer is armed. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("§2.2 balance-flash: per-message re-check", () => {
  it("passes on message 1; holdings dropped ⇒ message 2 fail-closed refusal (no caching)", async () => {
    const r1 = await h.chat(token, "one");
    expect(r1.status).toBe(200);
    expect(h.readerA.calls).toHaveLength(1);
    expect(h.readerB.calls).toHaveLength(1);

    h.setHoldings(A.address, pauper()); // flash: tokens moved out after sign-in
    const r2 = await h.chat(token, "two");
    expect(r2.status).toBe(403);
    expect(r2.body["error"]).toBe("not_a_holder");
    expect(typeof r2.body["reply"]).toBe("string");
    expect(h.readerA.calls).toHaveLength(2);
    expect(h.readerB.calls).toHaveLength(2);
    expect(h.llm.calls).toHaveLength(1);
    expect(inRows()).toBe(1);

    h.setHoldings(A.address, holder()); // tokens back ⇒ allowed again
    expect((await h.chat(token, "three")).status).toBe(200);
    expect(h.readerA.calls).toHaveLength(3);
  });

  it("flash between login and first message (session obtained while holding) ⇒ blocked", async () => {
    h.setHoldings(A.address, pauper());
    expect((await h.chat(token, "hi")).status).toBe(403);
    expect(h.llm.calls).toHaveLength(0);
  });

  it("gate is read for the TOKEN's wallet, never a body-supplied one", async () => {
    const r = await h.post("/chat", { text: "hi", wallet: wallet("rich").address }, { "x-chat-token": token });
    expect(r.status).toBe(400); // extra fields rejected outright
    await h.chat(token, "hi");
    expect(h.readerA.calls.at(-1)?.toLowerCase()).toBe(A.address.toLowerCase());
  });
});

describe("§2.2 dual-RPC fail-closed matrix", () => {
  it("RPC disagreement: A says pass, B says fail ⇒ 503", async () => {
    h.readerB.set(A.address, pauper());
    const r = await h.chat(token, "hi");
    expect(r.status).toBe(503);
    expect(r.body["error"]).toBe("gate_unavailable");
    expect(String(r.body["detail"])).toMatch(/disagree/);
    expect(h.llm.calls).toHaveLength(0);
    expect(inRows()).toBe(0);
  });

  it("RPC disagreement the other way: A fail, B pass ⇒ 503", async () => {
    h.readerA.set(A.address, pauper());
    expect((await h.chat(token, "hi")).status).toBe(503);
  });

  const modes: ReaderMode[] = ["throw", "reject", "malformed"];
  for (const m of modes) {
    it(`one RPC ${m} (other passes) ⇒ 503`, async () => {
      h.readerA.mode = m;
      expect((await h.chat(token, "hi")).status).toBe(503);
      h.readerA.mode = "ok";
      h.readerB.mode = m;
      expect((await h.chat(token, "hi")).status).toBe(503);
      expect(h.llm.calls).toHaveLength(0);
      expect(inRows()).toBe(0);
    });
  }

  it("both RPCs fail ⇒ 503", async () => {
    h.readerA.mode = "reject";
    h.readerB.mode = "throw";
    expect((await h.chat(token, "hi")).status).toBe(503);
    expect(h.llm.calls).toHaveLength(0);
  });

  it("one RPC hangs ⇒ 503 once the 3 s timer fires (injected timer)", async () => {
    h.readerB.mode = "hang";
    const p = h.chat(token, "hi");
    await settle();
    expect(h.timer.pending.at(-1)?.ms).toBe(3000);
    expect(h.timer.fire()).toBe(1);
    const r = await p;
    expect(r.status).toBe(503);
    expect(String(r.body["detail"])).toMatch(/timed out/);
    expect(h.llm.calls).toHaveLength(0);
    expect(inRows()).toBe(0);
  });

  it("both RPCs hang ⇒ 503 on timeout", async () => {
    h.readerA.mode = "hang";
    h.readerB.mode = "hang";
    const p = h.chat(token, "hi");
    await settle();
    h.timer.fire();
    expect((await p).status).toBe(503);
  });

  it("successful reads cancel the timer (no dangling timeouts)", async () => {
    await h.chat(token, "hi");
    expect(h.timer.armed()).toBe(0);
  });

  it("real setTimeout timer: hanging reader with chatGateTimeoutMs 20 ⇒ 503", async () => {
    const hr = await makeChatHarness({ realTimer: true, caps: { chatGateTimeoutMs: 20 } });
    hr.setHoldings(A.address, holder());
    const t = await hr.login(A);
    hr.readerA.mode = "hang";
    const r = await hr.chat(t, "hi");
    expect(r.status).toBe(503);
    expect(String(r.body["detail"])).toMatch(/20 ms/);
  });

  it("both agree FAIL ⇒ 403 (not 503): a legitimate non-holder is told why", async () => {
    h.setHoldings(A.address, pauper());
    const r = await h.chat(token, "hi");
    expect(r.status).toBe(403);
    expect(String(r.body["reply"])).toContain("0.1%");
    expect(String(r.body["reply"])).toContain("1%");
  });
});

describe("gate predicate (D9 thresholds, exact bigint)", () => {
  const base: Holdings = { agentBal: 0n, agentSupply: SUPPLY, platformBal: 0n, platformSupply: SUPPLY };
  it("agent leg: ≥ 0.1% passes, 0.1% − 1 wei fails", () => {
    expect(gatePasses({ ...base, agentBal: SUPPLY / 1000n }, P)).toBe(true);
    expect(gatePasses({ ...base, agentBal: SUPPLY / 1000n - 1n }, P)).toBe(false);
  });
  it("platform leg: ≥ 1% passes, 1% − 1 wei fails", () => {
    expect(gatePasses({ ...base, platformBal: SUPPLY / 100n }, P)).toBe(true);
    expect(gatePasses({ ...base, platformBal: SUPPLY / 100n - 1n }, P)).toBe(false);
  });
  it("OR semantics: either leg suffices", () => {
    expect(gatePasses({ ...base, agentBal: SUPPLY / 1000n, platformBal: 0n }, P)).toBe(true);
    expect(gatePasses({ ...base, agentBal: 0n, platformBal: SUPPLY / 100n }, P)).toBe(true);
  });
  it("zero supply never passes its leg (0 ≥ 0 must not admit everyone)", () => {
    expect(gatePasses({ agentBal: 0n, agentSupply: 0n, platformBal: 0n, platformSupply: 0n }, P)).toBe(false);
    expect(gatePasses({ agentBal: 5n, agentSupply: 0n, platformBal: 0n, platformSupply: SUPPLY }, P)).toBe(false);
  });
  it("non-divisible supply: threshold rounds against the holder (exact integer compare)", () => {
    const supply = 1001n; // 0.1% = 1.001
    expect(gatePasses({ ...base, agentSupply: supply, agentBal: 1n }, P)).toBe(false);
    expect(gatePasses({ ...base, agentSupply: supply, agentBal: 2n }, P)).toBe(true);
  });
});

describe("createDualGate unit", () => {
  const W = wallet("unit").address as Address;
  it("both pass ⇒ ok; both fail ⇒ insufficient; disagree ⇒ unavailable", async () => {
    const a = new MockBalanceReader("a");
    const b = new MockBalanceReader("b");
    const g = createDualGate([a, b], { ...P, timeoutMs: 3000 });
    a.set(W, holder());
    b.set(W, holder());
    expect(await g.check(W)).toEqual({ ok: true });
    a.set(W, pauper());
    b.set(W, pauper());
    expect((await g.check(W)).ok).toBe(false);
    expect(await g.check(W)).toMatchObject({ reason: "insufficient" });
    b.set(W, holder());
    expect(await g.check(W)).toMatchObject({ reason: "unavailable" });
  });
  it("agreement is on pass/fail, not on exact numbers (different but both-passing balances ⇒ ok)", async () => {
    const a = new MockBalanceReader("a");
    const b = new MockBalanceReader("b");
    a.set(W, holder());
    b.set(W, { ...holder(), agentBal: SUPPLY / 50n });
    expect(await createDualGate([a, b], { ...P, timeoutMs: 3000 }).check(W)).toEqual({ ok: true });
  });
});
