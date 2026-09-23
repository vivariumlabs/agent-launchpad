// SPEC-M2C §2 group 3 — rate-limit races + windows. Source of truth = `chats` 'in' rows;
// check+insert in ONE transaction ⇒ concurrency can never exceed the cap.

import { beforeEach, describe, expect, it } from "vitest";
import { checkAndInsertIn } from "../../src/chat/rate.js";
import { listChats, openMemory } from "../../src/memory/db.js";
import { DAY0, NOW } from "../policy/helpers.js";
import { holder, makeChatHarness, wallet, type ChatHarness } from "./harness.js";

const A = wallet("A");
const B = wallet("B");

function inRows(h: ChatHarness, w: string): number {
  return listChats(h.db).filter((c) => c.dir === "in" && c.wallet === w.toLowerCase()).length;
}

let h: ChatHarness;
beforeEach(async () => {
  h = await makeChatHarness();
  h.setHoldings(A.address, holder());
  h.setHoldings(B.address, holder());
});

describe("§2.3 rate-limit races", () => {
  it("30 concurrent handle() calls, one wallet, hour budget 20 ⇒ EXACTLY 20 accepted, 10 refused, 20 user rows", async () => {
    expect(h.cfg.chatPerHour).toBe(20);
    const token = await h.login(A);
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => h.chat(token, `race message #${i}`)));
    const accepted = rs.filter((r) => r.status === 200);
    const refused = rs.filter((r) => r.status === 429);
    expect(accepted).toHaveLength(20);
    expect(refused).toHaveLength(10);
    for (const r of accepted) expect(r.body["refused"]).toBeUndefined();
    for (const r of refused) expect(r.body["window"]).toBe("hour");
    expect(inRows(h, A.address)).toBe(20);
    // every accepted message got exactly one paid LLM call + one stored reply
    expect(h.llm.calls).toHaveLength(20);
    expect(listChats(h.db).filter((c) => c.dir === "out")).toHaveLength(20);
    // each inference call was a distinct approval (no K1 replay collision, distinct x402 nonces)
    const nonces = new Set(h.x402.paid.map((p) => p.auth.authorization.nonce));
    expect(h.x402.paid).toHaveLength(20);
    expect(nonces.size).toBe(20);
  });

  it("race across the hour cap after partial use: 15 used, 10 concurrent ⇒ exactly 5 accepted", async () => {
    const token = await h.login(A);
    for (let i = 0; i < 15; i++) expect((await h.chat(token, `m${i}`)).status).toBe(200);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => h.chat(token, `burst ${i}`)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(5);
    expect(inRows(h, A.address)).toBe(20);
  });

  it("second wallet unaffected: A exhausted, B concurrent burst still gets its own 20", async () => {
    const ta = await h.login(A);
    const tb = await h.login(B);
    const rs = await Promise.all([
      ...Array.from({ length: 25 }, (_, i) => h.chat(ta, `a${i}`)),
      ...Array.from({ length: 25 }, (_, i) => h.chat(tb, `b${i}`)),
    ]);
    const okA = rs.slice(0, 25).filter((r) => r.status === 200).length;
    const okB = rs.slice(25).filter((r) => r.status === 200).length;
    expect(okA).toBe(20);
    expect(okB).toBe(20);
    expect(inRows(h, A.address)).toBe(20);
    expect(inRows(h, B.address)).toBe(20);
    expect((await h.chat(ta, "more")).status).toBe(429);
    expect((await h.chat(tb, "more")).status).toBe(429);
  });

  it("sliding hour: 20 at t, refused at t+3599, accepted at t+3600 (oldest leaves the window)", async () => {
    const token = await h.login(A);
    for (let i = 0; i < 20; i++) expect((await h.chat(token, `m${i}`)).status).toBe(200);
    const t0 = h.now();
    h.setNow(t0 + 3599n);
    const r = await h.chat(token, "early");
    expect(r.status).toBe(429);
    expect(r.body["retryAfterSec"]).toBe(1);
    expect(r.headers?.["retry-after"]).toBe("1");
    h.setNow(t0 + 3600n);
    // the first session token expired exactly now (exp = t0 + 3600) — sign in again
    const t2 = await h.login(A);
    expect((await h.chat(t2, "on time")).status).toBe(200);
  });

  it("day cap 100 enforced across hours; resets at UTC midnight", async () => {
    // perHour 1000 so only the day cap binds; perDay 5 to keep the test small.
    const hd = await makeChatHarness({ caps: { chatPerHour: 1000, chatPerDay: 5 } });
    hd.setHoldings(A.address, holder());
    hd.setNow(DAY0 + 86_400n - 600n); // 23:50 UTC
    let token = await hd.login(A);
    for (let i = 0; i < 5; i++) expect((await hd.chat(token, `late ${i}`)).status).toBe(200);
    const refused = await hd.chat(token, "one too many");
    expect(refused.status).toBe(429);
    expect(refused.body["window"]).toBe("day");
    expect(refused.body["retryAfterSec"]).toBe(600);
    hd.setNow(DAY0 + 86_400n - 1n); // 23:59:59 — still the same UTC day
    expect((await hd.chat(token, "still today")).status).toBe(429);
    hd.setNow(DAY0 + 86_400n); // 00:00:00 next UTC day — reset
    token = await hd.login(A);
    expect((await hd.chat(token, "new day")).status).toBe(200);
  });

  it("DEFAULT caps: chatPerHour 20, chatPerDay 100", () => {
    expect(h.cfg.chatPerHour).toBe(20);
    expect(h.cfg.chatPerDay).toBe(100);
  });

  it("a refused (429) request inserts no row", async () => {
    const hp = await makeChatHarness({ caps: { chatPerHour: 1 } });
    hp.setHoldings(A.address, holder());
    const tp = await hp.login(A);
    expect((await hp.chat(tp, "1")).status).toBe(200);
    expect((await hp.chat(tp, "2")).status).toBe(429);
    expect(listChats(hp.db).filter((c) => c.dir === "in")).toHaveLength(1);
  });
});

describe("checkAndInsertIn unit", () => {
  const W = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  it("counts only dir 'in' rows of the same wallet", () => {
    const db = openMemory(":memory:");
    db.prepare("INSERT INTO chats (ts, wallet, dir, content) VALUES (?, ?, 'out', 'x')").run(NOW.toString(), W);
    db.prepare("INSERT INTO chats (ts, wallet, dir, content) VALUES (?, ?, 'in', 'x')").run(NOW.toString(), "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(checkAndInsertIn(db, W, "hi", NOW, { perHour: 1, perDay: 1 }).ok).toBe(true);
    expect(checkAndInsertIn(db, W, "hi", NOW, { perHour: 1, perDay: 1 })).toMatchObject({ ok: false, window: "hour" });
  });
  it("wallet matching is case-insensitive (stored lowercase)", () => {
    const db = openMemory(":memory:");
    expect(checkAndInsertIn(db, W.toUpperCase().replace("0X", "0x"), "hi", NOW, { perHour: 1, perDay: 5 }).ok).toBe(true);
    expect(checkAndInsertIn(db, W, "hi", NOW, { perHour: 1, perDay: 5 }).ok).toBe(false);
  });
  it("clock rewind: rows stamped in the future still count (conservative)", () => {
    const db = openMemory(":memory:");
    expect(checkAndInsertIn(db, W, "hi", NOW + 10_000n, { perHour: 1, perDay: 5 }).ok).toBe(true);
    expect(checkAndInsertIn(db, W, "hi", NOW, { perHour: 1, perDay: 5 }).ok).toBe(false);
  });
  it("ts compared numerically, not lexicographically (9- vs 10-digit timestamps)", () => {
    const db = openMemory(":memory:");
    db.prepare("INSERT INTO chats (ts, wallet, dir, content) VALUES ('999999999', ?, 'in', 'old')").run(W);
    expect(checkAndInsertIn(db, W, "hi", 1_000_010_000n, { perHour: 1, perDay: 5 }).ok).toBe(true);
  });
});
