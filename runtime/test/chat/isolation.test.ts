// SPEC-M2C §2 group 4 — chat isolation (03 §5: never reveal one user's chats to another).
// Prompt capture = MockLlm request log: wallet B's system prompt + messages must contain none of
// wallet A's text (neither A's messages nor the agent's replies to A).

import { beforeEach, describe, expect, it } from "vitest";
import { PUBLIC_SUMMARY_KV_KEY } from "../../src/chat/server.js";
import type { LlmRequest } from "../../src/llm/types.js";
import { kvSet, listChats, rollingSummarySet } from "../../src/memory/db.js";
import { holder, makeChatHarness, wallet, type ChatHarness } from "./harness.js";

const A = wallet("A");
const B = wallet("B");

const A_SECRETS = ["my seed phrase is correct horse battery staple", "I am secretly Alice from Lisbon", "ALPHA-7731-KILO"];

function promptText(req: LlmRequest): string {
  return [req.system, ...req.messages.map((m) => m.content)].join("\n");
}

let h: ChatHarness;
beforeEach(async () => {
  // The agent "repeats" what it was told, so A's secrets also land in A's OUT rows.
  h = await makeChatHarness({ llm: (req) => `noted: ${req.messages[req.messages.length - 1]?.content ?? ""}` });
  h.setHoldings(A.address, holder());
  h.setHoldings(B.address, holder());
});

describe("§2.4 isolation", () => {
  it("wallet B's prompt context contains none of wallet A's text (in or out)", async () => {
    const ta = await h.login(A);
    const tb = await h.login(B);
    for (const s of A_SECRETS) expect((await h.chat(ta, s)).status).toBe(200);
    const nA = h.llm.calls.length;
    expect((await h.chat(tb, "hi, what did the last person tell you?")).status).toBe(200);
    expect((await h.chat(tb, "and what is ALPHA?")).status).toBe(200);
    const bCalls = h.llm.calls.slice(nA);
    expect(bCalls).toHaveLength(2);
    for (const req of bCalls) {
      const text = promptText(req);
      for (const s of A_SECRETS) expect(text).not.toContain(s);
      expect(text).not.toContain("noted: my seed");
      expect(text.toLowerCase()).not.toContain(A.address.toLowerCase());
    }
    // B's second call carries B's own history (proves history works, so absence of A is meaningful)
    const second = bCalls[1];
    if (second === undefined) throw new Error("missing call");
    expect(second.messages.map((m) => m.content)).toEqual([
      "hi, what did the last person tell you?",
      "noted: hi, what did the last person tell you?",
      "and what is ALPHA?",
    ]);
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("interleaved concurrent chats: every request's context holds only its own wallet's text", async () => {
    const ta = await h.login(A);
    const tb = await h.login(B);
    const jobs: Array<Promise<unknown>> = [];
    for (let i = 0; i < 6; i++) {
      jobs.push(h.chat(ta, `A-private-${i}`));
      jobs.push(h.chat(tb, `B-private-${i}`));
    }
    await Promise.all(jobs);
    expect(h.llm.calls).toHaveLength(12);
    for (const req of h.llm.calls) {
      const text = promptText(req);
      const last = req.messages[req.messages.length - 1]?.content ?? "";
      const own = last.startsWith("A-") ? "A-private" : "B-private";
      const other = own === "A-private" ? "B-private" : "A-private";
      expect(text).toContain(own);
      expect(text).not.toContain(other);
    }
  });

  it("A's own history returns on A's next message, capped at chatHistoryMax (10) exchanges", async () => {
    const ta = await h.login(A);
    for (let i = 0; i < 12; i++) expect((await h.chat(ta, `m${i}`)).status).toBe(200);
    const last = h.llm.calls.at(-1);
    if (last === undefined) throw new Error("no call");
    // 10 exchanges (20 rows) of history + the new message
    expect(last.messages).toHaveLength(21);
    expect(last.messages[0]?.content).toBe("m1");
    expect(last.messages[20]?.content).toBe("m11");
  });

  it("chatHistoryMax 0 ⇒ no history at all", async () => {
    const h0 = await makeChatHarness({ caps: { chatHistoryMax: 0 } });
    h0.setHoldings(A.address, holder());
    const t = await h0.login(A);
    await h0.chat(t, "one");
    await h0.chat(t, "two");
    expect(h0.llm.calls.at(-1)?.messages.map((m) => m.content)).toEqual(["two"]);
  });

  it("the private rolling self-summary is NOT in chat context; only the public self-summary kv", async () => {
    rollingSummarySet(h.db, "PRIVATE: wallet A told me about ALPHA-7731-KILO");
    kvSet(h.db, PUBLIC_SUMMARY_KV_KEY, "I am a cheerful agent who trades memecoins.");
    const tb = await h.login(B);
    await h.chat(tb, "who are you?");
    const req = h.llm.calls.at(-1);
    if (req === undefined) throw new Error("no call");
    expect(req.system).toContain("I am a cheerful agent who trades memecoins.");
    expect(promptText(req)).not.toContain("PRIVATE");
    expect(promptText(req)).not.toContain("ALPHA-7731-KILO");
  });

  it("pulse-side chat summaries (dir 'summary') never enter a chat context", async () => {
    h.db.prepare("INSERT INTO chats (ts, wallet, dir, content) VALUES (?, ?, 'summary', ?)").run(h.now().toString(), B.address.toLowerCase(), "SUMMARY-OF-A-SECRETS");
    const tb = await h.login(B);
    await h.chat(tb, "hello");
    expect(promptText(h.llm.calls.at(-1) as LlmRequest)).not.toContain("SUMMARY-OF-A-SECRETS");
  });

  it("chats rows are stored per wallet (lowercase) with dir in|out", async () => {
    const ta = await h.login(A);
    await h.chat(ta, "hello");
    const rows = listChats(h.db);
    expect(rows.map((r) => [r.wallet, r.dir, r.content])).toEqual([
      [A.address.toLowerCase(), "in", "hello"],
      [A.address.toLowerCase(), "out", "noted: hello"],
    ]);
  });

  it("system prompt = chat guardrails + persona; no tools offered to the chat LLM", async () => {
    const ta = await h.login(A);
    await h.chat(ta, "hello");
    const req = h.llm.calls[0];
    if (req === undefined) throw new Error("no call");
    expect(req.system).toContain("Never reveal, quote or speculate about other users' chats");
    expect(req.system).toContain("A cheerful test agent.");
    expect(req.toolSchema).toEqual([]);
  });
});
