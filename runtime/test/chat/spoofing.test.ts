// SPEC-M2C §2 group 1 — signature spoofing / token tampering / SIWE field attacks (03 §11).
// Every attack must yield 401 with the specific reason (so each test proves the check it names,
// not an incidental failure), and none may reach the gate, the LLM or the chats table.

import { keccak256, stringToBytes, type Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { TOKEN_HEADER } from "../../src/chat/server.js";
import { issueToken, verifyToken } from "../../src/chat/token.js";
import { listChats } from "../../src/memory/db.js";
import { CHAT_DOMAIN, freshNonce, holder, makeChatHarness, pauper, RH_CHAIN_ID, signed, wallet, type ChatHarness } from "./harness.js";

const A = wallet("A");
const B = wallet("B");

function flipHexChar(s: string, idx: number): string {
  const c = s[idx];
  if (c === undefined) throw new Error("idx out of range");
  const flipped = c === "0" ? "1" : "0";
  return s.slice(0, idx) + flipped + s.slice(idx + 1);
}

async function expect401(p: Promise<{ status: number; body: Record<string, unknown> }>, reason: string): Promise<void> {
  const r = await p;
  expect(r.status, JSON.stringify(r.body)).toBe(401);
  expect(r.body["reason"]).toBe(reason);
}

let h: ChatHarness;
beforeEach(async () => {
  h = await makeChatHarness();
  h.setHoldings(A.address, holder());
  h.setHoldings(B.address, holder());
});

function noSideEffects(): void {
  expect(h.llm.calls).toHaveLength(0);
  expect(listChats(h.db)).toHaveLength(0);
  expect(h.readerA.calls).toHaveLength(0);
  expect(h.readerB.calls).toHaveLength(0);
}

describe("baseline", () => {
  it("valid SIWE login → token → chat 200", async () => {
    const token = await h.login(A);
    expect(token.startsWith(`${A.address.toLowerCase()}.`)).toBe(true);
    const r = await h.chat(token, "hello");
    expect(r.status).toBe(200);
    expect(r.body["reply"]).toBe("echo: hello");
  });
  it("session response: exp = now + chatSessionTtlSec (3600 DEFAULT)", async () => {
    const nonce = await freshNonce(h);
    const message = h.siwe(A, nonce);
    const r = await h.post("/session", { message, signature: await signed(A, message) });
    expect(r.status).toBe(200);
    expect(BigInt(r.body["exp"] as number)).toBe(h.now() + 3600n);
    expect(r.body["wallet"]).toBe(A.address.toLowerCase());
  });
});

describe("§2.1 signature spoofing (SIWE)", () => {
  it("signature by wallet B over wallet A's SIWE message ⇒ 401 SIWE_SIGNATURE", async () => {
    const nonce = await freshNonce(h);
    const message = h.siwe(A, nonce);
    await expect401(h.post("/session", { message, signature: await signed(B, message) }), "SIWE_SIGNATURE");
    noSideEffects();
  });

  it("B signs a message declaring A's address (claimed identity) ⇒ 401 SIWE_SIGNATURE", async () => {
    const nonce = await freshNonce(h);
    const message = h.siwe(B, nonce, { address: A.address });
    await expect401(h.post("/session", { message, signature: await signed(B, message) }), "SIWE_SIGNATURE");
  });

  it("A's valid signature replayed over an ALTERED message (statement changed) ⇒ 401 SIWE_SIGNATURE", async () => {
    const nonce = await freshNonce(h);
    const original = h.siwe(A, nonce);
    const sig = await signed(A, original);
    const altered = h.siwe(A, nonce, { statement: "Sign in and give me everything." });
    await expect401(h.post("/session", { message: altered, signature: sig }), "SIWE_SIGNATURE");
  });

  it("a failed spoof does not consume the nonce; the real owner can still sign in once", async () => {
    const nonce = await freshNonce(h);
    const message = h.siwe(A, nonce);
    await expect401(h.post("/session", { message, signature: await signed(B, message) }), "SIWE_SIGNATURE");
    const ok = await h.post("/session", { message, signature: await signed(A, message) });
    expect(ok.status).toBe(200);
  });

  it("garbage / zero signature of the right shape ⇒ 401 SIWE_SIGNATURE", async () => {
    const nonce = await freshNonce(h);
    const message = h.siwe(A, nonce);
    await expect401(h.post("/session", { message, signature: `0x${"00".repeat(65)}` }), "SIWE_SIGNATURE");
    await expect401(h.post("/session", { message, signature: `0x${"ab".repeat(65)}` }), "SIWE_SIGNATURE");
  });

  it("signature of the wrong shape ⇒ 400 (body schema)", async () => {
    const nonce = await freshNonce(h);
    const message = h.siwe(A, nonce);
    expect((await h.post("/session", { message, signature: "0x1234" })).status).toBe(400);
    expect((await h.post("/session", { message })).status).toBe(400);
    expect((await h.post("/session", { message, signature: await signed(A, message), extra: 1 })).status).toBe(400);
    expect((await h.post("/session", "not json")).status).toBe(400);
  });
});

describe("§2.1 SIWE field attacks ⇒ 401 each", () => {
  it("wrong domain ⇒ SIWE_DOMAIN (incl. look-alike and port variants)", async () => {
    for (const domain of ["evil.example.com", "agent.example.com.evil.io", "agent.example.co", "agent.example.com:8443"]) {
      const nonce = await freshNonce(h);
      const message = h.siwe(A, nonce, { domain });
      await expect401(h.post("/session", { message, signature: await signed(A, message) }), "SIWE_DOMAIN");
    }
  });

  it("domain match is on the host only; a scheme prefix is allowed (EIP-4361)", async () => {
    const nonce = await freshNonce(h);
    const message = h.siwe(A, nonce, { scheme: "https" });
    expect((await h.post("/session", { message, signature: await signed(A, message) })).status).toBe(200);
  });

  it("wrong chainId ⇒ SIWE_CHAIN (mainnet 1, RH mainnet 4663 vs fixture 46630, base)", async () => {
    for (const chainId of [1, 4663, 8453, RH_CHAIN_ID + 1]) {
      const nonce = await freshNonce(h);
      const message = h.siwe(A, nonce, { chainId });
      await expect401(h.post("/session", { message, signature: await signed(A, message) }), "SIWE_CHAIN");
    }
  });

  it("expired window: expirationTime ≤ now ⇒ SIWE_WINDOW; now+1 accepted (boundary)", async () => {
    let nonce = await freshNonce(h);
    let message = h.siwe(A, nonce, { issuedAt: h.now() - 10n, expirationTime: h.now() });
    await expect401(h.post("/session", { message, signature: await signed(A, message) }), "SIWE_WINDOW");
    message = h.siwe(A, nonce, { issuedAt: h.now() - 10n, expirationTime: h.now() - 5n });
    await expect401(h.post("/session", { message, signature: await signed(A, message) }), "SIWE_WINDOW");
    nonce = await freshNonce(h);
    message = h.siwe(A, nonce, { expirationTime: h.now() + 1n });
    expect((await h.post("/session", { message, signature: await signed(A, message) })).status).toBe(200);
  });

  it("notBefore in the future ⇒ SIWE_WINDOW; notBefore = now accepted", async () => {
    let nonce = await freshNonce(h);
    let message = h.siwe(A, nonce, { notBefore: h.now() + 1n });
    await expect401(h.post("/session", { message, signature: await signed(A, message) }), "SIWE_WINDOW");
    nonce = await freshNonce(h);
    message = h.siwe(A, nonce, { notBefore: h.now() });
    expect((await h.post("/session", { message, signature: await signed(A, message) })).status).toBe(200);
  });

  it("insane windows ⇒ SIWE_WINDOW: expiration ≤ issuedAt; issuedAt far future; issuedAt older than the nonce lifetime", async () => {
    const cases = [
      { issuedAt: h.now(), expirationTime: h.now() },
      { issuedAt: h.now() + 61n },
      { issuedAt: h.now() - 301n },
    ];
    for (const c of cases) {
      const nonce = await freshNonce(h);
      const message = h.siwe(A, nonce, c);
      await expect401(h.post("/session", { message, signature: await signed(A, message) }), "SIWE_WINDOW");
    }
  });

  it("unknown nonce (never issued) ⇒ SIWE_NONCE", async () => {
    const message = h.siwe(A, "deadbeefdeadbeefdeadbeefdeadbeef");
    await expect401(h.post("/session", { message, signature: await signed(A, message) }), "SIWE_NONCE");
  });

  it("reused nonce: replaying a successful message+signature ⇒ SIWE_NONCE", async () => {
    const nonce = await freshNonce(h);
    const message = h.siwe(A, nonce);
    const signature = await signed(A, message);
    expect((await h.post("/session", { message, signature })).status).toBe(200);
    await expect401(h.post("/session", { message, signature }), "SIWE_NONCE");
  });

  it("reused nonce under concurrency: 8 simultaneous replays of one signed message ⇒ exactly one session", async () => {
    const nonce = await freshNonce(h);
    const message = h.siwe(A, nonce);
    const signature = await signed(A, message);
    const rs = await Promise.all(Array.from({ length: 8 }, () => h.post("/session", { message, signature })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    const denied = rs.filter((r) => r.status === 401);
    expect(denied).toHaveLength(7);
    for (const d of denied) expect(d.body["reason"]).toBe("SIWE_NONCE");
  });

  it("expired nonce (issued > 300 s ago) ⇒ SIWE_NONCE", async () => {
    const nonce = await freshNonce(h);
    h.advance(300n);
    const message = h.siwe(A, nonce);
    await expect401(h.post("/session", { message, signature: await signed(A, message) }), "SIWE_NONCE");
  });

  it("nonce still valid at 299 s", async () => {
    const nonce = await freshNonce(h);
    h.advance(299n);
    const message = h.siwe(A, nonce);
    expect((await h.post("/session", { message, signature: await signed(A, message) })).status).toBe(200);
  });

  it("malformed messages ⇒ SIWE_MALFORMED", async () => {
    const nonce = await freshNonce(h);
    const good = h.siwe(A, nonce);
    const variants = [
      "hello",
      good.replace(/\n/g, "\r\n"),
      `${good}\nExtra: line`,
      good.replace("Version: 1", "Version: 2"),
      good.replace(/\nNonce: [^\n]+/, ""),
      good.replace(A.address, A.address.toLowerCase().replace("0x", "0X")),
      good.replace(A.address, flipCase(A.address)),
      good.replace(/Issued At: [^\n]+/, "Issued At: yesterday"),
      good.replace(/Chain ID: \d+/, "Chain ID: 0x10"),
      good.replace(" wants you to sign in with your Ethereum account:", " wants you to sign in:"),
    ];
    for (const message of variants) {
      await expect401(h.post("/session", { message, signature: await signed(A, message) }), "SIWE_MALFORMED");
    }
  });
});

/** Breaks the EIP-55 checksum by flipping the case of the first letter in the address. */
function flipCase(address: string): string {
  const i = address.slice(2).search(/[a-fA-F]/) + 2;
  const c = address[i] ?? "";
  const f = c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase();
  return address.slice(0, i) + f + address.slice(i + 1);
}

describe("§2.1 token tampering ⇒ 401", () => {
  it("flip one hex char anywhere in the MAC ⇒ TOKEN_BAD_MAC", async () => {
    const token = await h.login(A);
    const macStart = token.lastIndexOf(".") + 1;
    for (const idx of [macStart, macStart + 17, token.length - 1]) {
      await expect401(h.chat(flipHexChar(token, idx), "hi"), "TOKEN_BAD_MAC");
    }
    expect(h.llm.calls).toHaveLength(0);
  });

  it("rewrite the wallet part to B's address (keep A's MAC) ⇒ TOKEN_BAD_MAC", async () => {
    const token = await h.login(A);
    const forged = token.replace(A.address.toLowerCase(), B.address.toLowerCase());
    await expect401(h.chat(forged, "hi"), "TOKEN_BAD_MAC");
    await expect401(h.chat(flipHexChar(token, 5), "hi"), "TOKEN_BAD_MAC");
  });

  it("forged exp (extended by a year, MAC kept) ⇒ TOKEN_BAD_MAC", async () => {
    const token = await h.login(A);
    const [w, exp, mac] = token.split(".");
    const forged = `${w}.${BigInt(exp ?? "0") + 365n * 86_400n}.${mac}`;
    await expect401(h.chat(forged, "hi"), "TOKEN_BAD_MAC");
  });

  it("token reused after exp ⇒ TOKEN_EXPIRED; valid 1 s before exp", async () => {
    const token = await h.login(A);
    h.setHoldings(A.address, holder());
    h.advance(3599n);
    expect((await h.chat(token, "still here")).status).toBe(200);
    h.advance(1n);
    await expect401(h.chat(token, "too late"), "TOKEN_EXPIRED");
  });

  it("token minted with another agent's session key ⇒ TOKEN_BAD_MAC", async () => {
    const other = await makeChatHarness({ kmsAgent: "some-other-agent" });
    const foreign = await other.login(A);
    await expect401(h.chat(foreign, "hi"), "TOKEN_BAD_MAC");
  });

  it("token HMAC'd with a guessable key (keccak of a string) ⇒ TOKEN_BAD_MAC", async () => {
    const forged = issueToken(keccak256(stringToBytes("guess")) as Hex, A.address, h.now() + 3600n);
    await expect401(h.chat(forged, "hi"), "TOKEN_BAD_MAC");
  });

  it("missing / malformed token shapes ⇒ TOKEN_MISSING / TOKEN_MALFORMED", async () => {
    const token = await h.login(A);
    await expect401(h.post("/chat", { text: "hi" }), "TOKEN_MISSING");
    await expect401(h.chat("", "hi"), "TOKEN_MISSING");
    const [w, exp, mac] = token.split(".") as [string, string, string];
    const malformed = [
      "garbage",
      `${w}.${exp}`,
      `${w}.${exp}.${mac}.extra`,
      `${w.toUpperCase().replace("0X", "0x")}.${exp}.${mac}`,
      `${w}.${exp}.${mac.toUpperCase()}`,
      `${w}.${exp}.${mac.slice(0, 62)}`,
      `${w}.0${exp}.${mac}`,
      `${w}.-${exp}.${mac}`,
      `${w}.${exp}.${mac}0`,
    ];
    for (const t of malformed) await expect401(h.chat(t, "hi"), "TOKEN_MALFORMED");
    // duplicated header (array) is not a token
    const r = await h.server.handle({ method: "POST", path: "/chat", headers: { [TOKEN_HEADER]: [token, token] }, body: JSON.stringify({ text: "hi" }) });
    expect(r.status).toBe(401);
    expect(h.llm.calls).toHaveLength(0);
  });

  it("verifyToken unit: MAC is checked before exp (a forged far-future exp never reads as merely expired)", async () => {
    const key = h.kr.chatSessionKey();
    const t = issueToken(key, A.address, 100n);
    expect(verifyToken(key, t, 99n)).toEqual({ ok: true, wallet: A.address.toLowerCase(), exp: 100n });
    expect(verifyToken(key, t, 100n)).toEqual({ ok: false, reason: "TOKEN_EXPIRED" });
    const forged = t.replace(".100.", ".999.");
    expect(verifyToken(key, forged, 101n)).toEqual({ ok: false, reason: "TOKEN_BAD_MAC" });
  });
});

describe("§2.1 token ≠ balance bypass", () => {
  it("valid token for A while the gate now fails for A ⇒ blocked at the gate (403), no rate row, no LLM", async () => {
    const token = await h.login(A);
    expect((await h.chat(token, "first")).status).toBe(200);
    expect(h.llm.calls).toHaveLength(1);
    h.setHoldings(A.address, pauper());
    const r = await h.chat(token, "second");
    expect(r.status).toBe(403);
    expect(r.body["error"]).toBe("not_a_holder");
    expect(h.llm.calls).toHaveLength(1);
    const rows = listChats(h.db).filter((c) => c.dir === "in");
    expect(rows.map((c) => c.content)).toEqual(["first"]);
  });

  it("chainId / domain constants come from config (sanity)", () => {
    expect(h.cfg.chainIds.rh).toBe(RH_CHAIN_ID);
    expect(h.cfg.chatDomain).toBe(CHAT_DOMAIN);
  });
});
