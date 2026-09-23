// SPEC-M2B §4 (Job B scope only). Snapshot / restore for the memory DB.
//
// No Date.now/Math.random anywhere in this module — `now: bigint` is always
// a caller-supplied parameter (LocalDirSink filenames are derived from it).

import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bytesToHex, hexToBytes, keccak256, type Hex } from "viem";
import DatabaseCtor from "better-sqlite3";
import type { MemoryDb } from "./db.js";

const MAGIC = "ALSNAP1"; // 7 ascii bytes
const VERSION = 1;
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 7 + 1 + 4 + 8; // magic + version + agentId + createdAt
const ENVELOPE_MIN_LEN = HEADER_LEN + IV_LEN + TAG_LEN;

export interface SnapshotMeta {
  agentId: number;
  createdAt: bigint;
  version: number;
}

/**
 * A place snapshots are written to / read back from. `LocalDirSink` is the
 * M2 mock-Arweave stand-in; a real Arweave-backed sink is M3.
 */
export interface SnapshotSink {
  /** Writes `data`, deriving any filename/id deterministically from `now`. Returns the id. */
  write(data: Uint8Array, now: bigint): Promise<string>;
  /** Lists all ids currently held by this sink (order not guaranteed). */
  list(): Promise<string[]>;
  /** Reads back the bytes for a given id. */
  read(id: string): Promise<Uint8Array>;
}

export class LocalDirSink implements SnapshotSink {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private filenameFor(now: bigint): string {
    return `snapshot-${now.toString(10)}.bin`;
  }

  async write(data: Uint8Array, now: bigint): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const filename = this.filenameFor(now);
    await writeFile(join(this.dir, filename), data);
    return filename;
  }

  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir);
      return entries.filter((name) => name.startsWith("snapshot-") && name.endsWith(".bin"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async read(id: string): Promise<Uint8Array> {
    return await readFile(join(this.dir, id));
  }
}

// ---------------------------------------------------------------------------
// crypto helpers
// ---------------------------------------------------------------------------

function bigintToBytesBE(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** 12-byte IV = first 12 bytes of keccak256(memKey ‖ now-as-8-byte-BE). */
function computeIv(memKey: Hex, now: bigint): Buffer {
  const memKeyBytes = hexToBytes(memKey);
  const nowBytes = bigintToBytesBE(now, 8);
  const preimage = new Uint8Array(memKeyBytes.length + nowBytes.length);
  preimage.set(memKeyBytes, 0);
  preimage.set(nowBytes, memKeyBytes.length);
  const digest = keccak256(preimage); // 0x-prefixed 32-byte hex
  const digestBytes = hexToBytes(digest);
  return Buffer.from(digestBytes.slice(0, IV_LEN));
}

function keyBuffer(memKey: Hex): Buffer {
  const bytes = hexToBytes(memKey);
  if (bytes.length !== 32) {
    throw new Error(`snapshot: memKey must be 32 bytes, got ${bytes.length}`);
  }
  return Buffer.from(bytes);
}

interface EncryptResult {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

function encrypt(memKey: Hex, now: bigint, plaintext: Buffer): EncryptResult {
  const iv = computeIv(memKey, now);
  const cipher = createCipheriv(ALGO, keyBuffer(memKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, tag, ciphertext };
}

/** Throws (GCM auth failure) if `memKey`/iv/tag do not authenticate `ciphertext`. */
function decrypt(memKey: Hex, iv: Buffer, tag: Buffer, ciphertext: Buffer): Buffer {
  const decipher = createDecipheriv(ALGO, keyBuffer(memKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---------------------------------------------------------------------------
// envelope framing: magic(7) | version(1) | agentId(u32BE) | createdAt(u64BE)
//                   | iv(12) | tag(16) | ciphertext
// ---------------------------------------------------------------------------

function encodeEnvelope(meta: SnapshotMeta, iv: Buffer, tag: Buffer, ciphertext: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_LEN);
  header.write(MAGIC, 0, "ascii");
  header.writeUInt8(meta.version, 7);
  header.writeUInt32BE(meta.agentId, 8);
  header.writeBigUInt64BE(meta.createdAt, 12);
  return Buffer.concat([header, iv, tag, ciphertext]);
}

interface DecodedEnvelope {
  agentId: number;
  createdAt: bigint;
  version: number;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

/** Returns null (never throws) for anything that isn't a well-formed envelope. */
function decodeEnvelope(buf: Buffer): DecodedEnvelope | null {
  try {
    if (buf.length < ENVELOPE_MIN_LEN) return null;
    const magic = buf.subarray(0, 7).toString("ascii");
    if (magic !== MAGIC) return null;
    const version = buf.readUInt8(7);
    const agentId = buf.readUInt32BE(8);
    const createdAt = buf.readBigUInt64BE(12);
    const iv = buf.subarray(HEADER_LEN, HEADER_LEN + IV_LEN);
    const tag = buf.subarray(HEADER_LEN + IV_LEN, HEADER_LEN + IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(HEADER_LEN + IV_LEN + TAG_LEN);
    return { agentId, createdAt, version, iv: Buffer.from(iv), tag: Buffer.from(tag), ciphertext: Buffer.from(ciphertext) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export interface WriteSnapshotResult {
  id: string;
  meta: SnapshotMeta;
}

const LAST_SNAPSHOT_ID_KEY = "lastSnapshotId";

/**
 * Serializes `db`, encrypts it (AES-256-GCM, key = memKey, deterministic IV
 * derived from memKey+now), frames it in the ALSNAP1 envelope, and writes it
 * to `sink`. Records the resulting id in `kv` under "lastSnapshotId" (this
 * write happens AFTER serialization, so it is not itself part of the
 * snapshot). `agentId` is an optional informational envelope field — the
 * memory module has no access to agent identity/config (out of Job B scope),
 * so callers that care about it should pass it explicitly; it plays no role
 * in encryption or restore correctness.
 */
export async function writeSnapshot(
  db: MemoryDb,
  memKey: Hex,
  sink: SnapshotSink,
  now: bigint,
  agentId = 0,
): Promise<WriteSnapshotResult> {
  const plaintext = db.serialize();
  const { iv, tag, ciphertext } = encrypt(memKey, now, plaintext);
  const meta: SnapshotMeta = { agentId, createdAt: now, version: VERSION };
  const envelope = encodeEnvelope(meta, iv, tag, ciphertext);
  const id = await sink.write(envelope, now);

  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    LAST_SNAPSHOT_ID_KEY,
    id,
  );

  return { id, meta };
}

export interface RestoreResult {
  db: MemoryDb;
  meta: SnapshotMeta & { sinkIndex: number; id: string };
}

/**
 * Tries snapshots newest-first (by the envelope's createdAt, across all
 * sinks). The first one that both GCM-authenticates under `memKey` AND opens
 * as a valid SQLite database wins. Unparseable / corrupt / wrong-key entries
 * are skipped silently (logged via console.warn) and the next-newest is
 * tried. Returns null if nothing restorable is found.
 */
export async function restoreLatest(sinks: SnapshotSink[], memKey: Hex): Promise<RestoreResult | null> {
  interface Candidate {
    sinkIndex: number;
    id: string;
    envelope: DecodedEnvelope;
  }

  const candidates: Candidate[] = [];

  for (let sinkIndex = 0; sinkIndex < sinks.length; sinkIndex++) {
    const sink = sinks[sinkIndex]!;
    let ids: string[];
    try {
      ids = await sink.list();
    } catch (err) {
      console.warn(`snapshot: sink ${sinkIndex} list() failed, skipping`, err);
      continue;
    }
    for (const id of ids) {
      let raw: Uint8Array;
      try {
        raw = await sink.read(id);
      } catch (err) {
        console.warn(`snapshot: sink ${sinkIndex} could not read "${id}", skipping`, err);
        continue;
      }
      const envelope = decodeEnvelope(Buffer.from(raw));
      if (!envelope) {
        console.warn(`snapshot: "${id}" in sink ${sinkIndex} is not a parseable envelope, skipping`);
        continue;
      }
      candidates.push({ sinkIndex, id, envelope });
    }
  }

  candidates.sort((a, b) => {
    if (a.envelope.createdAt === b.envelope.createdAt) return 0;
    return a.envelope.createdAt > b.envelope.createdAt ? -1 : 1;
  });

  for (const candidate of candidates) {
    const { envelope } = candidate;
    let plaintext: Buffer;
    try {
      plaintext = decrypt(memKey, envelope.iv, envelope.tag, envelope.ciphertext);
    } catch (err) {
      console.warn(`snapshot: "${candidate.id}" failed GCM authentication, skipping`, err);
      continue;
    }

    let restoredDb: MemoryDb;
    try {
      restoredDb = new DatabaseCtor(plaintext);
      // Sanity-check it is really a usable SQLite DB, not just bytes that
      // happened to decrypt: this throws for non-SQLite content.
      restoredDb.pragma("quick_check");
    } catch (err) {
      console.warn(`snapshot: "${candidate.id}" decrypted but is not a valid SQLite DB, skipping`, err);
      continue;
    }

    return {
      db: restoredDb,
      meta: {
        agentId: envelope.agentId,
        createdAt: envelope.createdAt,
        version: envelope.version,
        sinkIndex: candidate.sinkIndex,
        id: candidate.id,
      },
    };
  }

  return null;
}

// Exported for tests that want to assert envelope byte-layout directly.
export const _internal = { MAGIC, VERSION, HEADER_LEN, IV_LEN, TAG_LEN, encodeEnvelope, decodeEnvelope, bytesToHex };
