// M3 s2 close — in-house ANS-104 data items (replaces the rejected 211 MB @ardrive/turbo-sdk).
//
// ONE signed DataItem per upload, Ethereum signer only (signatureType 3):
//
//   offset  size        field
//   0       2           signature type, u16 LE (= 3)
//   2       65          signature (EIP-191 personal_sign over the 48-byte deep hash; r ‖ s ‖ v)
//   67      65          owner (uncompressed secp256k1 public key, 0x04 ‖ x ‖ y)
//   132     1 [+32]     target presence byte [+ target]
//   …       1 [+32]     anchor presence byte [+ anchor]
//   …       8           number of tags, u64 LE
//   …       8           number of tag bytes, u64 LE
//   …       n           tags, Avro-encoded array<{name: string, value: string}> (empty when 0 tags)
//   …       rest        data
//
//   signature input = deepHash(["dataitem", "1", "3", owner, target|∅, anchor|∅, rawTags, data])
//   deepHash (SHA-384): blob b ⇒ H(H("blob" ‖ len(b)) ‖ H(b)); list L ⇒ fold acc = H("list" ‖ n),
//                        acc = H(acc ‖ deepHash(item)) for each item.
//   id = base64url(sha256(signature))
//
// Spec: https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md (§1.3 format,
// §2 tag rules). Cross-verified against @dha-team/arbundles (DEV dependency only) in
// test/attestation/ans104.test.ts: our items pass arbundles' DataItem.verify() and our ids equal
// arbundles' ids byte-for-byte for identical inputs (no tags / several tags / empty / multi-KB data).
//
// Dependencies: node:crypto (SHA-384 / SHA-256 — hashing only, no randomness) + viem (signature
// verification helpers). Signing goes through keyring.turboSigner() (TREASURY key, 48-byte-only
// allowlist) — this file never sees key material. No network, no clock.

import { createHash } from "node:crypto";
import { publicKeyToAddress } from "viem/accounts";
import { bytesToHex, recoverMessageAddress, type Address } from "viem";

export const SIG_TYPE_ETHEREUM = 3;
export const ETH_OWNER_LENGTH = 65;
export const ETH_SIGNATURE_LENGTH = 65;
/** ANS-104 §2 tag limits. */
export const MAX_TAGS = 128;
export const MAX_TAG_NAME_BYTES = 1024;
export const MAX_TAG_VALUE_BYTES = 3072;
/** arbundles' MAX_TAG_BYTES (an item with more serialized tag bytes fails its verify()). */
export const MAX_TAG_BYTES = 4096;

export interface Ans104Tag {
  name: string;
  value: string;
}

/** The TurboSigner shape (keyring.ts) — PUBLIC data + a sign() over the 48-byte deep hash. */
export interface Ans104Signer {
  readonly signatureType: 3;
  readonly ownerLength: 65;
  readonly signatureLength: 65;
  readonly publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export interface DataItemOptions {
  /** 32 raw bytes. */
  target?: Uint8Array;
  /** 32 raw bytes. */
  anchor?: Uint8Array;
}

export interface SignedDataItem {
  /** Full binary data item (what Turbo's POST /v1/tx takes). */
  bytes: Uint8Array;
  /** base64url(sha256(signature)) — the Arweave id Turbo returns. */
  id: string;
}

export interface ParsedDataItem {
  signatureType: number;
  signature: Uint8Array;
  owner: Uint8Array;
  target: Uint8Array | null;
  anchor: Uint8Array | null;
  tags: Ans104Tag[];
  rawTags: Uint8Array;
  data: Uint8Array;
  id: string;
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

function sha384(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha384");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export function base64url(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

export type DeepHashChunk = Uint8Array | DeepHashChunk[];

/** Arweave deep hash (SHA-384). */
export function deepHash(chunk: DeepHashChunk): Uint8Array {
  if (chunk instanceof Uint8Array) {
    const tag = sha384(utf8.encode("blob"), utf8.encode(chunk.byteLength.toString(10)));
    return sha384(tag, sha384(chunk));
  }
  let acc = sha384(utf8.encode("list"), utf8.encode(chunk.length.toString(10)));
  for (const c of chunk) acc = sha384(acc, deepHash(c));
  return acc;
}

function u64le(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`ans104: bad u64 ${n}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

function readU64le(b: Uint8Array, off: number): number {
  if (off + 8 > b.length) throw new Error("ans104: truncated u64");
  const v = new DataView(b.buffer, b.byteOffset + off, 8).getBigUint64(0, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ans104: u64 out of range");
  return Number(v);
}

/** Avro long: zig-zag then base-128 varint (little-endian groups, MSB = continuation). */
function avroLong(n: number): number[] {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`ans104: bad avro long ${n}`);
  let z = BigInt(n) * 2n; // zig-zag of a non-negative value
  const out: number[] = [];
  do {
    let byte = Number(z & 0x7fn);
    z >>= 7n;
    if (z > 0n) byte |= 0x80;
    out.push(byte);
  } while (z > 0n);
  return out;
}

function readAvroLong(b: Uint8Array, pos: { p: number }): number {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos.p >= b.length) throw new Error("ans104: truncated avro long");
    const byte = b[pos.p++]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error("ans104: avro long too long");
  }
  const v = (result >> 1n) ^ -(result & 1n); // un-zig-zag
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("ans104: avro long out of range");
  return Number(v);
}

function checkTags(tags: readonly Ans104Tag[]): void {
  if (tags.length > MAX_TAGS) throw new Error(`ans104: ${tags.length} tags > ${MAX_TAGS}`);
  for (const t of tags) {
    if (typeof t?.name !== "string" || typeof t?.value !== "string") throw new Error("ans104: tag name/value must be strings");
    const n = utf8.encode(t.name).length;
    const v = utf8.encode(t.value).length;
    if (n === 0 || v === 0) throw new Error("ans104: empty tag name/value");
    if (n > MAX_TAG_NAME_BYTES) throw new Error(`ans104: tag name ${n} bytes > ${MAX_TAG_NAME_BYTES}`);
    if (v > MAX_TAG_VALUE_BYTES) throw new Error(`ans104: tag value ${v} bytes > ${MAX_TAG_VALUE_BYTES}`);
  }
}

/**
 * Avro array<{name,value}>: one block [count, (len name)(len value)…] then the 0 terminator.
 * Zero tags ⇒ EMPTY bytes (not the lone terminator) — arbundles' serializeTags convention.
 */
export function serializeTags(tags: readonly Ans104Tag[]): Uint8Array {
  checkTags(tags);
  if (tags.length === 0) return new Uint8Array(0);
  const out: number[] = [...avroLong(tags.length)];
  for (const t of tags) {
    for (const s of [t.name, t.value]) {
      const b = utf8.encode(s);
      out.push(...avroLong(b.length));
      for (const x of b) out.push(x);
    }
  }
  out.push(0);
  const bytes = Uint8Array.from(out);
  if (bytes.length > MAX_TAG_BYTES) throw new Error(`ans104: ${bytes.length} tag bytes > ${MAX_TAG_BYTES}`);
  return bytes;
}

export function deserializeTags(b: Uint8Array): Ans104Tag[] {
  if (b.length === 0) return [];
  const dec = new TextDecoder("utf-8", { fatal: true });
  const pos = { p: 0 };
  const out: Ans104Tag[] = [];
  for (;;) {
    let n = readAvroLong(b, pos);
    if (n === 0) break;
    if (n < 0) {
      n = -n;
      readAvroLong(b, pos); // block byte size (ignored)
    }
    for (let i = 0; i < n; i++) {
      const pair: string[] = [];
      for (let k = 0; k < 2; k++) {
        const len = readAvroLong(b, pos);
        if (len < 0 || pos.p + len > b.length) throw new Error("ans104: tag string out of range");
        pair.push(dec.decode(b.subarray(pos.p, pos.p + len)));
        pos.p += len;
      }
      out.push({ name: pair[0]!, value: pair[1]! });
    }
  }
  if (pos.p !== b.length) throw new Error("ans104: trailing tag bytes");
  return out;
}

// ---------------------------------------------------------------------------
// create / sign / parse / verify
// ---------------------------------------------------------------------------

function optional32(v: Uint8Array | undefined, what: string): Uint8Array | null {
  if (v === undefined) return null;
  if (!(v instanceof Uint8Array) || v.length !== 32) throw new Error(`ans104: ${what} must be 32 bytes`);
  return v;
}

/** The 48-byte ANS-104 signature input. */
export function signatureData(f: { signatureType: number; owner: Uint8Array; target: Uint8Array | null; anchor: Uint8Array | null; rawTags: Uint8Array; data: Uint8Array }): Uint8Array {
  return deepHash([
    utf8.encode("dataitem"),
    utf8.encode("1"),
    utf8.encode(f.signatureType.toString(10)),
    f.owner,
    f.target ?? new Uint8Array(0),
    f.anchor ?? new Uint8Array(0),
    f.rawTags,
    f.data,
  ]);
}

export function dataItemId(signature: Uint8Array): string {
  return base64url(new Uint8Array(createHash("sha256").update(signature).digest()));
}

/** Build + sign one data item (signer = keyring.turboSigner()). */
export async function createSignedDataItem(data: Uint8Array, tags: readonly Ans104Tag[], signer: Ans104Signer, opts: DataItemOptions = {}): Promise<SignedDataItem> {
  if (!(data instanceof Uint8Array)) throw new Error("ans104: data must be a Uint8Array");
  if (signer.signatureType !== SIG_TYPE_ETHEREUM || signer.ownerLength !== ETH_OWNER_LENGTH || signer.signatureLength !== ETH_SIGNATURE_LENGTH) {
    throw new Error("ans104: only the Ethereum signer (type 3, 65/65) is supported");
  }
  const owner = signer.publicKey;
  if (!(owner instanceof Uint8Array) || owner.length !== ETH_OWNER_LENGTH || owner[0] !== 0x04) throw new Error("ans104: owner must be a 65-byte uncompressed secp256k1 key");
  const target = optional32(opts.target, "target");
  const anchor = optional32(opts.anchor, "anchor");
  const rawTags = serializeTags(tags);

  const message = signatureData({ signatureType: SIG_TYPE_ETHEREUM, owner, target, anchor, rawTags, data });
  const signature = await signer.sign(message);
  if (!(signature instanceof Uint8Array) || signature.length !== ETH_SIGNATURE_LENGTH) throw new Error("ans104: signer returned a malformed signature");

  const len = 2 + ETH_SIGNATURE_LENGTH + ETH_OWNER_LENGTH + 1 + (target?.length ?? 0) + 1 + (anchor?.length ?? 0) + 16 + rawTags.length + data.length;
  const bytes = new Uint8Array(len);
  let o = 0;
  bytes[o++] = SIG_TYPE_ETHEREUM & 0xff;
  bytes[o++] = (SIG_TYPE_ETHEREUM >> 8) & 0xff;
  bytes.set(signature, o);
  o += ETH_SIGNATURE_LENGTH;
  bytes.set(owner, o);
  o += ETH_OWNER_LENGTH;
  for (const opt of [target, anchor]) {
    bytes[o++] = opt === null ? 0 : 1;
    if (opt !== null) {
      bytes.set(opt, o);
      o += 32;
    }
  }
  bytes.set(u64le(tags.length), o);
  o += 8;
  bytes.set(u64le(rawTags.length), o);
  o += 8;
  bytes.set(rawTags, o);
  o += rawTags.length;
  bytes.set(data, o);
  return { bytes, id: dataItemId(signature) };
}

/** Parse an Ethereum-signed (type 3) data item. Throws on malformed input. */
export function parseDataItem(b: Uint8Array): ParsedDataItem {
  if (b.length < 2 + ETH_SIGNATURE_LENGTH + ETH_OWNER_LENGTH + 2 + 16) throw new Error("ans104: too short");
  const signatureType = b[0]! | (b[1]! << 8);
  if (signatureType !== SIG_TYPE_ETHEREUM) throw new Error(`ans104: unsupported signature type ${signatureType}`);
  let o = 2;
  const signature = b.subarray(o, o + ETH_SIGNATURE_LENGTH);
  o += ETH_SIGNATURE_LENGTH;
  const owner = b.subarray(o, o + ETH_OWNER_LENGTH);
  o += ETH_OWNER_LENGTH;
  const opt = (): Uint8Array | null => {
    const flag = b[o++];
    if (flag === 0) return null;
    if (flag !== 1) throw new Error("ans104: bad presence byte");
    if (o + 32 > b.length) throw new Error("ans104: truncated");
    const v = b.subarray(o, o + 32);
    o += 32;
    return v;
  };
  const target = opt();
  const anchor = opt();
  const nTags = readU64le(b, o);
  const nTagBytes = readU64le(b, o + 8);
  o += 16;
  if (nTagBytes > MAX_TAG_BYTES || o + nTagBytes > b.length) throw new Error("ans104: bad tag byte count");
  const rawTags = b.subarray(o, o + nTagBytes);
  o += nTagBytes;
  const tags = deserializeTags(rawTags);
  if (tags.length !== nTags) throw new Error("ans104: tag count mismatch");
  return { signatureType, signature, owner, target, anchor, tags, rawTags, data: b.subarray(o), id: dataItemId(signature) };
}

/** Owner EOA of an Ethereum-signed item (keccak of the uncompressed key). */
export function ownerAddress(owner: Uint8Array): Address {
  return publicKeyToAddress(bytesToHex(owner));
}

/** Arweave-normalized owner address = base64url(sha256(owner)) — what gateways index for GraphQL `owners`. */
export function arweaveOwnerAddress(owner: Uint8Array): string {
  return base64url(new Uint8Array(createHash("sha256").update(owner).digest()));
}

/** Full self-verification: parses, recomputes the deep hash, recovers the EIP-191 signer == owner. Never throws. */
export async function verifyDataItem(b: Uint8Array): Promise<boolean> {
  try {
    const p = parseDataItem(b);
    const msg = signatureData(p);
    const recovered = await recoverMessageAddress({ message: { raw: msg }, signature: bytesToHex(p.signature) });
    return recovered === ownerAddress(p.owner);
  } catch {
    return false;
  }
}
