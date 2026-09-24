// SPEC-M3D §3e — pulse seam: fid injection into cast bytes (kv fc.fid present ⇒ serialized Farcaster
// MessageData; absent ⇒ today's UTF-8 bytes). castReply keeps today's bytes (no parent fid available).

import * as ed from "@noble/ed25519";
import { hexToBytes, keccak256, stringToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { kvSet } from "../../src/memory/db.js";
import type { ProposedAction } from "../../src/policy/types.js";
import { contentAction, mapToolCall } from "../../src/pulse/tools.js";
import { buildCastAddData, fcMessageHash } from "../../src/social/fcMessage.js";
import { KV_FC_FID } from "../../src/social/fcOnboard.js";
import { NOW } from "../policy/helpers.js";
import { makeHarness, respond } from "./harness.js";

const FID = 3_352_486n;
const PARENT = `0x${"33".repeat(32)}` as Hex;

async function capture(fid: bigint | null) {
  const h = await makeHarness();
  if (fid !== null) kvSet(h.db, KV_FC_FID, fid.toString(10));
  const casts: Array<{ action: ProposedAction; bytes: Uint8Array; sig: Hex }> = [];
  h.exec.castSink = { publish: async (action, bytes, sig) => void casts.push({ action, bytes, sig }) };
  h.script(respond([{ tool: "social.post", args: { text: "gm" } }, { tool: "social.reply", args: { text: "re", parentHash: PARENT } }], { posts: ["hello 🌍"] }));
  const r = await h.pulse();
  expect(r.errors).toEqual([]);
  return { h, casts, r };
}

describe("M3D: pulse cast bytes (SPEC-M3D §3e)", () => {
  it("M3D: kv fc.fid present ⇒ social.post + posts[] carry serialized MessageData (fid + pulse clock); contentHash = keccak256 of those bytes; K4 sig over blake3-20", async () => {
    const { h, casts } = await capture(FID);
    const posts = casts.filter((c) => c.action.kind === "castPost");
    expect(posts).toHaveLength(2);
    const want = [buildCastAddData("gm", FID, NOW), buildCastAddData("hello 🌍", FID, NOW)];
    for (const [i, c] of posts.entries()) {
      expect(c.bytes).toEqual(want[i]);
      expect(c.action).toEqual({ kind: "castPost", contentHash: keccak256(want[i]!) });
      expect(await ed.verifyAsync(hexToBytes(c.sig), fcMessageHash(c.bytes), hexToBytes(h.kr.farcasterPublicKey()))).toBe(true);
    }
    // castReply: today's bytes (no parent fid ⇒ no CastId to build)
    const reply = casts.find((c) => c.action.kind === "castReply")!;
    expect(reply.bytes).toEqual(stringToBytes("re"));
  });

  it("M3D: kv fc.fid absent ⇒ TODAY's bytes (UTF-8 text), unchanged behavior", async () => {
    const { casts } = await capture(null);
    expect(casts.map((c) => [c.action.kind, new TextDecoder().decode(c.bytes)])).toEqual([
      ["castPost", "gm"],
      ["castReply", "re"],
      ["castPost", "hello 🌍"],
    ]);
    expect(casts[0]!.action).toEqual({ kind: "castPost", contentHash: keccak256(stringToBytes("gm")) });
  });

  it("M3D: contentAction / mapToolCall with an fc context; over the 320-byte Farcaster limit ⇒ skipped (not thrown)", () => {
    const cfg = { postMaxBytes: 1024, journalMaxBytes: 65_536n };
    const ok = contentAction("castPost", "hi", cfg, { fid: FID, now: NOW });
    expect(ok.ok && ok.extras.messageBytes).toEqual(buildCastAddData("hi", FID, NOW));
    const long = contentAction("castPost", "x".repeat(321), cfg, { fid: FID, now: NOW });
    expect(long).toMatchObject({ ok: false, reason: expect.stringMatching(/321 bytes > 320/) });
    expect(contentAction("castPost", "x".repeat(321), cfg).ok).toBe(true); // no fid ⇒ today's cap only
    const plan = mapToolCall({ tool: "social.post", args: { text: "hi" } }, "Active", cfg, { fid: FID, now: NOW });
    expect(plan.type === "action" && plan.extras.messageBytes).toEqual(buildCastAddData("hi", FID, NOW));
    // journalWrite is untouched by the fc context
    const j = contentAction("journalWrite", "entry", cfg, { fid: FID, now: NOW });
    expect(j.ok && j.extras.journalBytes).toEqual(stringToBytes("entry"));
  });
});
