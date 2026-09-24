// SPEC-M3D §3a — Farcaster message encoding (pure, no network, no clock: `now` is a parameter).
//
// In-house protobuf ENCODER (varint + length-delimited only — the ans104.ts discipline) for the subset
// the agent emits (Farcaster protobufs/schemas/message.proto; field numbers restated below):
//   MessageData { type=1 (enum), fid=2 (uint64), timestamp=3 (uint32), network=4 (enum, 1 = MAINNET),
//                 cast_add_body=5 | user_data_body=12 }
//   CastAddBody { mentions=2 (packed uint64), parent_cast_id=3 (CastId), text=4 (string ≤ 320 BYTES),
//                 mentions_positions=5 (packed uint32) }
//   CastId      { fid=1 (uint64), hash=2 (bytes, 20) }
//   UserDataBody{ type=1 (enum: 2 DISPLAY, 3 BIO), value=2 (string) }
//   Message     { hash=2, hash_scheme=3 (1 BLAKE3), signature=4, signature_scheme=5 (1 ED25519),
//                 signer=6 (32-byte ed25519 pubkey), data_bytes=7 } — serialized via data_bytes (field 1
//                 `data` is NEVER written) so the hash covers exactly the bytes the hub re-hashes.
// Byte layout follows @farcaster/core's ts-proto encoders EXACTLY (cross-verified in
// test/social/fcMessage.test.ts against the dev-only @farcaster/core): proto3 zero values omitted,
// fields in .proto DECLARATION order (CastAddBody: mentions, parent_cast_id, text, mentions_positions),
// and the two packed repeated fields are ALWAYS written, empty (`12 00` … `2a 00`), as ts-proto does.
// hash = blake3(data_bytes, dkLen 20) — @noble/hashes (pure JS, no native modules).
// Timestamp = Farcaster time: unix seconds − FARCASTER_EPOCH_SEC (1_609_459_200), uint32-checked.

import { blake3 } from "@noble/hashes/blake3";
import { hexToBytes, stringToBytes, type Hex } from "viem";
import type { UnixSeconds } from "../policy/types.js";

/** 2021-01-01T00:00:00Z — Farcaster epoch, unix seconds. */
export const FARCASTER_EPOCH_SEC = 1_609_459_200n;
/** CastAddBody.text limit (UTF-8 BYTES) for a regular cast. */
export const FC_MAX_CAST_BYTES = 320;
export const FC_NETWORK_MAINNET = 1;
export const FC_MESSAGE_TYPE_CAST_ADD = 1;
export const FC_MESSAGE_TYPE_USER_DATA_ADD = 11;
export const FC_USER_DATA_DISPLAY = 2;
export const FC_USER_DATA_BIO = 3;
export const FC_HASH_SCHEME_BLAKE3 = 1;
export const FC_SIGNATURE_SCHEME_ED25519 = 1;
/** Farcaster message hash length (blake3 dkLen). */
export const FC_HASH_BYTES = 20;

const UINT32_MAX = 4_294_967_295n;
const UINT64_MAX = (1n << 64n) - 1n;

export type FcUserDataType = typeof FC_USER_DATA_DISPLAY | typeof FC_USER_DATA_BIO;

// ---------------------------------------------------------------------------
// protobuf primitives (wire types 0 = varint, 2 = length-delimited)
// ---------------------------------------------------------------------------

function varint(v: bigint): number[] {
  if (v < 0n || v > UINT64_MAX) throw new Error(`fcMessage: varint out of range: ${v}`);
  const out: number[] = [];
  let x = v;
  while (x >= 0x80n) {
    out.push(Number((x & 0x7fn) | 0x80n));
    x >>= 7n;
  }
  out.push(Number(x));
  return out;
}

function tag(field: number, wire: 0 | 2): number[] {
  return varint(BigInt((field << 3) | wire));
}

/** Varint field; proto3: a zero value is omitted. */
function fVarint(field: number, v: bigint): number[] {
  return v === 0n ? [] : [...tag(field, 0), ...varint(v)];
}

/** Length-delimited field, ALWAYS written (callers decide omission). */
function fBytes(field: number, b: Uint8Array | readonly number[]): number[] {
  return [...tag(field, 2), ...varint(BigInt(b.length)), ...b];
}

function checkFid(fid: bigint, what = "fid"): void {
  if (typeof fid !== "bigint" || fid <= 0n || fid > UINT64_MAX) throw new Error(`fcMessage: bad ${what} ${String(fid)}`);
}

/** Farcaster time (seconds since FARCASTER_EPOCH_SEC), uint32-checked. */
export function farcasterTime(now: UnixSeconds): bigint {
  const t = now - FARCASTER_EPOCH_SEC;
  if (t < 0n || t > UINT32_MAX) throw new Error(`fcMessage: timestamp ${now} outside the Farcaster uint32 range`);
  return t;
}

function messageData(type: number, fid: bigint, now: UnixSeconds, bodyField: number, body: readonly number[]): Uint8Array {
  checkFid(fid);
  return new Uint8Array([
    ...fVarint(1, BigInt(type)),
    ...fVarint(2, fid),
    ...fVarint(3, farcasterTime(now)),
    ...fVarint(4, BigInt(FC_NETWORK_MAINNET)),
    ...fBytes(bodyField, body),
  ]);
}

function castAddBody(text: string, parent?: { fid: bigint; hash: Hex }): number[] {
  const t = stringToBytes(text);
  if (t.length > FC_MAX_CAST_BYTES) throw new Error(`fcMessage: cast text ${t.length} bytes > ${FC_MAX_CAST_BYTES}`);
  const out: number[] = [...fBytes(2, [])]; // mentions: packed, always written (ts-proto)
  if (parent !== undefined) {
    checkFid(parent.fid, "parent fid");
    const h = hexToBytes(parent.hash);
    if (h.length !== FC_HASH_BYTES) throw new Error(`fcMessage: parent cast hash must be ${FC_HASH_BYTES} bytes`);
    out.push(...fBytes(3, [...fVarint(1, parent.fid), ...fBytes(2, h)]));
  }
  if (t.length > 0) out.push(...fBytes(4, t));
  out.push(...fBytes(5, [])); // mentions_positions: packed, always written (ts-proto)
  return out;
}

// ---------------------------------------------------------------------------
// builders (serialized MessageData = the K4 messageBytes; contentHash = keccak256 of these bytes)
// ---------------------------------------------------------------------------

/** CAST_ADD MessageData (plain cast). */
export function buildCastAddData(text: string, fid: bigint, now: UnixSeconds): Uint8Array {
  return messageData(FC_MESSAGE_TYPE_CAST_ADD, fid, now, 5, castAddBody(text));
}

/** CAST_ADD MessageData replying to parentCastId {fid, hash (20 bytes)}. */
export function buildCastReplyData(text: string, parent: { fid: bigint; hash: Hex }, fid: bigint, now: UnixSeconds): Uint8Array {
  return messageData(FC_MESSAGE_TYPE_CAST_ADD, fid, now, 5, castAddBody(text, parent));
}

/** USER_DATA_ADD MessageData (DISPLAY = 2, BIO = 3). */
export function buildUserDataAdd(type: FcUserDataType, value: string, fid: bigint, now: UnixSeconds): Uint8Array {
  if (type !== FC_USER_DATA_DISPLAY && type !== FC_USER_DATA_BIO) throw new Error(`fcMessage: unsupported user data type ${String(type)}`);
  const v = stringToBytes(value);
  const body = [...fVarint(1, BigInt(type)), ...(v.length > 0 ? fBytes(2, v) : [])];
  return messageData(FC_MESSAGE_TYPE_USER_DATA_ADD, fid, now, 12, body);
}

/** Farcaster message hash: blake3(dataBytes, dkLen 20). This is what K4 signs. */
export function fcMessageHash(dataBytes: Uint8Array): Uint8Array {
  return blake3(dataBytes, { dkLen: FC_HASH_BYTES });
}

/** Serialized Message { hash, hash_scheme, signature, signature_scheme, signer, data_bytes } (no `data`). */
export function encodeMessage(m: { dataBytes: Uint8Array; signature: Uint8Array; signer: Uint8Array }): Uint8Array {
  if (m.signature.length !== 64) throw new Error("fcMessage: ed25519 signature must be 64 bytes");
  if (m.signer.length !== 32) throw new Error("fcMessage: signer must be a 32-byte ed25519 public key");
  if (m.dataBytes.length === 0) throw new Error("fcMessage: empty data_bytes");
  return new Uint8Array([
    ...fBytes(2, fcMessageHash(m.dataBytes)),
    ...fVarint(3, BigInt(FC_HASH_SCHEME_BLAKE3)),
    ...fBytes(4, m.signature),
    ...fVarint(5, BigInt(FC_SIGNATURE_SCHEME_ED25519)),
    ...fBytes(6, m.signer),
    ...fBytes(7, m.dataBytes),
  ]);
}

/**
 * True iff `bytes` START like a MessageData this module builds for `fid` (type CAST_ADD or USER_DATA_ADD,
 * then that fid). The hub sink uses it to refuse publishing non-Farcaster bytes (e.g. a pre-fid draft).
 */
export function isMessageDataFor(bytes: Uint8Array, fid: bigint): boolean {
  if (fid <= 0n || fid > UINT64_MAX) return false;
  for (const type of [FC_MESSAGE_TYPE_CAST_ADD, FC_MESSAGE_TYPE_USER_DATA_ADD]) {
    const prefix = [...fVarint(1, BigInt(type)), ...fVarint(2, fid)];
    if (bytes.length > prefix.length && prefix.every((b, i) => bytes[i] === b)) return true;
  }
  return false;
}
