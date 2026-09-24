// SPEC-M3D §3a — in-house Farcaster encoder, cross-verified BYTE-IDENTICAL against @farcaster/core
// (DEV-ONLY dependency; lint-enforced out of the prod tree like arbundles — test/build/repro-lint.test.ts).

import {
  CastType,
  FarcasterNetwork,
  Message as FcMessage,
  MessageData as FcMessageData,
  NobleEd25519Signer,
  UserDataType,
  makeCastAddData,
  makeMessage,
  makeUserDataAddData,
  toFarcasterTime,
} from "@farcaster/core";
import * as ed from "@noble/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildCastAddData,
  buildCastReplyData,
  buildUserDataAdd,
  encodeMessage,
  FARCASTER_EPOCH_SEC,
  farcasterTime,
  fcMessageHash,
  FC_USER_DATA_BIO,
  FC_USER_DATA_DISPLAY,
  isMessageDataFor,
} from "../../src/social/fcMessage.js";

const FID = 3_352_486n; // live-proven FID (SPEC-M3D preamble)
const NOW = 1_790_150_400n; // 2026-09-23T08:00:00Z
const SEED = hexToBytes(`0x${"42".repeat(32)}`);

function unwrap<T>(r: { isErr(): boolean; value?: T; error?: unknown; _unsafeUnwrap(): T }): T {
  if (r.isErr()) throw new Error(`farcaster/core: ${String((r as { error?: { message?: string } }).error?.message ?? r.error)}`);
  return r._unsafeUnwrap();
}

const dataOptions = { fid: Number(FID), network: FarcasterNetwork.MAINNET, timestamp: unwrap(toFarcasterTime(Number(NOW) * 1000)) };

async function refCast(text: string, parent?: { fid: number; hash: Uint8Array }): Promise<FcMessageData> {
  return unwrap(
    await makeCastAddData(
      {
        text,
        embeds: [],
        embedsDeprecated: [],
        mentions: [],
        mentionsPositions: [],
        type: CastType.CAST,
        ...(parent !== undefined ? { parentCastId: parent } : {}),
      },
      dataOptions,
    ),
  );
}

async function refUserData(type: UserDataType, value: string): Promise<FcMessageData> {
  return unwrap(await makeUserDataAddData({ type, value }, dataOptions));
}

/** @farcaster/core reference Message bytes, serialized via data_bytes only (no nested `data`). */
async function refMessageBytes(data: FcMessageData): Promise<{ dataBytes: Uint8Array; hash: Uint8Array; signature: Uint8Array; signer: Uint8Array; messageBytes: Uint8Array }> {
  const signerImpl = new NobleEd25519Signer(SEED);
  const msg = unwrap(await makeMessage(data, signerImpl));
  const dataBytes = msg.dataBytes!;
  const bytes = FcMessage.encode(
    FcMessage.create({ hash: msg.hash, hashScheme: msg.hashScheme, signature: msg.signature, signatureScheme: msg.signatureScheme, signer: msg.signer, dataBytes }),
  ).finish();
  return { dataBytes, hash: msg.hash, signature: msg.signature, signer: msg.signer, messageBytes: bytes };
}

async function ours(dataBytes: Uint8Array): Promise<{ hash: Uint8Array; messageBytes: Uint8Array }> {
  const hash = fcMessageHash(dataBytes);
  const signature = await ed.signAsync(hash, SEED);
  const signer = await ed.getPublicKeyAsync(SEED);
  return { hash, messageBytes: encodeMessage({ dataBytes, signature, signer }) };
}

const PARENT_HASH = `0x${"ab".repeat(20)}` as Hex;
const VECTORS: Array<{ name: string; ours: () => Uint8Array; ref: () => Promise<FcMessageData> }> = [
  { name: "short cast", ours: () => buildCastAddData("gm", FID, NOW), ref: () => refCast("gm") },
  { name: "320-byte cast", ours: () => buildCastAddData("x".repeat(320), FID, NOW), ref: () => refCast("x".repeat(320)) },
  {
    name: "unicode/emoji cast (multi-byte UTF-8)",
    ours: () => buildCastAddData("héllo 🌍 — 日本語 ✨ agents ∞", FID, NOW),
    ref: () => refCast("héllo 🌍 — 日本語 ✨ agents ∞"),
  },
  {
    name: "reply with parentCastId",
    ours: () => buildCastReplyData("replying 👋", { fid: 2n, hash: PARENT_HASH }, FID, NOW),
    ref: () => refCast("replying 👋", { fid: 2, hash: hexToBytes(PARENT_HASH) }),
  },
  { name: "DISPLAY UserDataAdd", ours: () => buildUserDataAdd(FC_USER_DATA_DISPLAY, "Test Agent", FID, NOW), ref: () => refUserData(UserDataType.DISPLAY, "Test Agent") },
  {
    name: "BIO UserDataAdd",
    ours: () => buildUserDataAdd(FC_USER_DATA_BIO, "An autonomous agent 🤖 on agent-launchpad.", FID, NOW),
    ref: () => refUserData(UserDataType.BIO, "An autonomous agent 🤖 on agent-launchpad."),
  },
  { name: "1-byte fid, emoji-only cast", ours: () => buildCastAddData("🚀🚀", 1n, NOW), ref: async () => unwrap(await makeCastAddData({ text: "🚀🚀", embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], type: CastType.CAST }, { ...dataOptions, fid: 1 })) },
];

describe("M3D-fc: fcMessage cross-verification vs @farcaster/core (SPEC-M3D §3a)", () => {
  for (const v of VECTORS) {
    it(`M3D-fc: ${v.name}: MessageData bytes, blake3-20 hash and full Message bytes are byte-identical`, async () => {
      const refData = await v.ref();
      const mine = v.ours();
      const ref = await refMessageBytes(refData);
      expect(bytesToHex(mine)).toBe(bytesToHex(FcMessageData.encode(refData).finish()));
      expect(bytesToHex(mine)).toBe(bytesToHex(ref.dataBytes));
      const o = await ours(mine);
      expect(bytesToHex(o.hash)).toBe(bytesToHex(ref.hash));
      expect(bytesToHex(o.hash)).toBe(bytesToHex(blake3(ref.dataBytes, { dkLen: 20 })));
      expect(bytesToHex(o.messageBytes)).toBe(bytesToHex(ref.messageBytes));
      // the reference decoder reads our Message back (data_bytes path)
      const back = FcMessage.decode(o.messageBytes);
      expect(back.data).toBeUndefined();
      expect(bytesToHex(back.dataBytes!)).toBe(bytesToHex(mine));
      expect(bytesToHex(back.signer)).toBe(bytesToHex(ref.signer));
    });
  }
  it("M3D-fc: ≥ 6 vectors covered", () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(6);
  });
});

describe("M3D-fc: fcMessage guards", () => {
  it("M3D-fc: timestamp = unix − 1_609_459_200, uint32-checked", () => {
    expect(FARCASTER_EPOCH_SEC).toBe(1_609_459_200n);
    expect(farcasterTime(NOW)).toBe(NOW - 1_609_459_200n);
    expect(() => farcasterTime(FARCASTER_EPOCH_SEC - 1n)).toThrow(/uint32/);
    expect(() => farcasterTime(FARCASTER_EPOCH_SEC + 4_294_967_296n)).toThrow(/uint32/);
  });
  it("M3D-fc: 321-byte text, bad fid, bad parent hash, bad user-data type ⇒ throw", () => {
    expect(() => buildCastAddData("é".repeat(161), FID, NOW)).toThrow(/322 bytes > 320/);
    expect(() => buildCastAddData("x", 0n, NOW)).toThrow(/fid/);
    expect(() => buildCastReplyData("x", { fid: 2n, hash: `0x${"ab".repeat(32)}` }, FID, NOW)).toThrow(/20 bytes/);
    expect(() => buildUserDataAdd(5 as 2, "x", FID, NOW)).toThrow(/unsupported/);
  });
  it("M3D-fc: encodeMessage refuses wrong-length signature / signer / empty data", () => {
    const d = buildCastAddData("gm", FID, NOW);
    expect(() => encodeMessage({ dataBytes: d, signature: new Uint8Array(63), signer: new Uint8Array(32) })).toThrow(/64 bytes/);
    expect(() => encodeMessage({ dataBytes: d, signature: new Uint8Array(64), signer: new Uint8Array(33) })).toThrow(/32-byte/);
    expect(() => encodeMessage({ dataBytes: new Uint8Array(0), signature: new Uint8Array(64), signer: new Uint8Array(32) })).toThrow(/empty/);
  });
  it("M3D-fc: isMessageDataFor recognizes our CAST_ADD / USER_DATA_ADD for the fid only; raw text drafts are not MessageData", () => {
    expect(isMessageDataFor(buildCastAddData("gm", FID, NOW), FID)).toBe(true);
    expect(isMessageDataFor(buildUserDataAdd(FC_USER_DATA_DISPLAY, "n", FID, NOW), FID)).toBe(true);
    expect(isMessageDataFor(buildCastAddData("gm", FID, NOW), FID + 1n)).toBe(false);
    expect(isMessageDataFor(new TextEncoder().encode("gm"), FID)).toBe(false);
    expect(isMessageDataFor(new Uint8Array(0), FID)).toBe(false);
  });
});
