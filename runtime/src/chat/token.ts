// SPEC-M2C §1 — chat session tokens.
//   wire format: `${walletLowercase}.${exp}.${hmacHex}`
//   hmacHex    = HMAC-SHA256(chatSessionKey, `${walletLowercase}.${exp}`)  (64 lowercase hex)
// Verification recomputes the MAC over the canonical payload and compares in constant time
// (crypto.timingSafeEqual) BEFORE looking at exp; then requires now < exp.

import { createHmac, timingSafeEqual } from "node:crypto";
import { hexToBytes, type Address, type Hex } from "viem";
import type { UnixSeconds } from "../policy/types.js";

export type TokenFailure = "TOKEN_MISSING" | "TOKEN_MALFORMED" | "TOKEN_BAD_MAC" | "TOKEN_EXPIRED";

export type TokenCheck = { ok: true; wallet: Address; exp: UnixSeconds } | { ok: false; reason: TokenFailure };

const TOKEN_RE = /^(0x[0-9a-f]{40})\.([1-9][0-9]{0,19})\.([0-9a-f]{64})$/;

function keyBytes(sessionKey: Hex): Uint8Array {
  const k = hexToBytes(sessionKey);
  if (k.length !== 32) throw new Error(`chat token: session key must be 32 bytes, got ${k.length}`);
  return k;
}

function mac(sessionKey: Hex, payload: string): Buffer {
  return createHmac("sha256", keyBytes(sessionKey)).update(payload, "utf8").digest();
}

export function issueToken(sessionKey: Hex, wallet: Address, exp: UnixSeconds): string {
  if (exp <= 0n) throw new Error("chat token: exp must be > 0");
  const payload = `${wallet.toLowerCase()}.${exp.toString(10)}`;
  return `${payload}.${mac(sessionKey, payload).toString("hex")}`;
}

export function verifyToken(sessionKey: Hex, token: string | undefined, now: UnixSeconds): TokenCheck {
  if (token === undefined || token === "") return { ok: false, reason: "TOKEN_MISSING" };
  const m = TOKEN_RE.exec(token);
  if (m === null) return { ok: false, reason: "TOKEN_MALFORMED" };
  const [, wallet, expStr, macHex] = m;
  if (wallet === undefined || expStr === undefined || macHex === undefined) return { ok: false, reason: "TOKEN_MALFORMED" };
  const expected = mac(sessionKey, `${wallet}.${expStr}`);
  const given = Buffer.from(macHex, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "TOKEN_BAD_MAC" };
  const exp = BigInt(expStr);
  if (now >= exp) return { ok: false, reason: "TOKEN_EXPIRED" };
  return { ok: true, wallet: wallet as Address, exp };
}
