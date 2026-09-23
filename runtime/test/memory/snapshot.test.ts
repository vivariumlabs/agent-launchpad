import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseCtor from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { createKeyring } from "../../src/keyring/keyring.js";
import { MockKms } from "../../src/keyring/mockKms.js";
import { openMemory, type MemoryDb } from "../../src/memory/db.js";
import { LocalDirSink, restoreLatest, writeSnapshot, _internal } from "../../src/memory/snapshot.js";
import { dumpAllTables, populateAllTables } from "./fixtures.js";

async function memKeyFor(imageId: string, agentId: string): Promise<Hex> {
  const keyring = await createKeyring(new MockKms(imageId, agentId));
  return keyring.memKeyForMemoryModule();
}

function freshTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("gate: snapshot→restore identity", () => {
  it("populates all 7 tables, snapshots, destroys the DB file, restores, and every table dumps identically", async () => {
    const workDir = freshTmpDir("al-snap-gate-");
    const dbPath = join(workDir, "mem.sqlite");
    const db = openMemory(dbPath);
    populateAllTables(db);

    const originalDump = dumpAllTables(db);

    const memKey = await memKeyFor("image-a", "agent-0001");
    const sink = new LocalDirSink(join(workDir, "snapshots"));
    const now = 1_700_000_500n;

    await writeSnapshot(db, memKey, sink, now, 7);
    db.close();
    rmSync(dbPath); // destroy the source DB file entirely

    const result = await restoreLatest([sink], memKey);
    expect(result).not.toBeNull();
    const restoredDump = dumpAllTables(result!.db);

    expect(restoredDump).toEqual(originalDump);
    expect(result!.meta.agentId).toBe(7);
    expect(result!.meta.createdAt).toBe(now);

    result!.db.close();
    rmSync(workDir, { recursive: true, force: true });
  });
});

describe("restoreLatest: corruption fallback", () => {
  it("skips a corrupted newest snapshot (flipped ciphertext byte) and restores the older one", async () => {
    const workDir = freshTmpDir("al-snap-corrupt-");
    const memKey = await memKeyFor("image-a", "agent-0001");
    const sink = new LocalDirSink(join(workDir, "snapshots"));

    const dbOld = openMemory(":memory:");
    populateAllTables(dbOld);
    const oldDump = dumpAllTables(dbOld);
    const olderNow = 1_000n;
    const { id: olderId } = await writeSnapshot(dbOld, memKey, sink, olderNow, 1);
    dbOld.close();

    const dbNew = openMemory(":memory:");
    populateAllTables(dbNew);
    // Make the newer snapshot's content distinguishable from the older one.
    dbNew.prepare("INSERT INTO kv (key, value) VALUES ('marker', 'newer')").run();
    const newerNow = 2_000n;
    const { id: newerId } = await writeSnapshot(dbNew, memKey, sink, newerNow, 1);
    dbNew.close();

    expect(newerId).not.toBe(olderId);

    // Flip one ciphertext byte in the newest snapshot file.
    const newerPath = join(workDir, "snapshots", newerId);
    const bytes = readFileSync(newerPath);
    const corrupted = Buffer.from(bytes);
    const ciphertextStart = _internal.HEADER_LEN + _internal.IV_LEN + _internal.TAG_LEN;
    corrupted[ciphertextStart] = corrupted[ciphertextStart]! ^ 0xff;
    writeFileSync(newerPath, corrupted);

    const result = await restoreLatest([sink], memKey);
    expect(result).not.toBeNull();
    expect(result!.meta.createdAt).toBe(olderNow);
    const restoredDump = dumpAllTables(result!.db);
    expect(restoredDump).toEqual(oldDump);

    result!.db.close();
    rmSync(workDir, { recursive: true, force: true });
  });
});

describe("restoreLatest: wrong memKey", () => {
  it("a memKey derived for a different agentId cannot decrypt anything (returns null)", async () => {
    const workDir = freshTmpDir("al-snap-wrongkey-");
    const writerKey = await memKeyFor("image-a", "agent-0001");
    const wrongKey = await memKeyFor("image-a", "agent-0002");
    expect(wrongKey).not.toBe(writerKey);

    const db = openMemory(":memory:");
    populateAllTables(db);
    const sink = new LocalDirSink(join(workDir, "snapshots"));
    await writeSnapshot(db, writerKey, sink, 555n, 1);
    db.close();

    const result = await restoreLatest([sink], wrongKey);
    expect(result).toBeNull();

    // Sanity: the right key still works against the same sink.
    const okResult = await restoreLatest([sink], writerKey);
    expect(okResult).not.toBeNull();
    okResult!.db.close();

    rmSync(workDir, { recursive: true, force: true });
  });
});

describe("writeSnapshot determinism", () => {
  it("same (db bytes, memKey, now) produces a byte-identical snapshot file", async () => {
    const workDir = freshTmpDir("al-snap-determinism-");
    const memKey = await memKeyFor("image-a", "agent-0001");

    const seedDb = openMemory(":memory:");
    populateAllTables(seedDb);
    const seedBytes = seedDb.serialize();
    seedDb.close();

    // Two independently-opened DBs from identical bytes, each written exactly
    // once (so neither has the post-write kv "lastSnapshotId" mutation baked
    // into ITS OWN serialize() call).
    const dbA = new DatabaseCtor(seedBytes) as unknown as MemoryDb;
    const dbB = new DatabaseCtor(seedBytes) as unknown as MemoryDb;

    const sinkA = new LocalDirSink(join(workDir, "a"));
    const sinkB = new LocalDirSink(join(workDir, "b"));
    const now = 424_242n;

    const { id: idA } = await writeSnapshot(dbA, memKey, sinkA, now, 9);
    const { id: idB } = await writeSnapshot(dbB, memKey, sinkB, now, 9);

    const bytesA = readFileSync(join(workDir, "a", idA));
    const bytesB = readFileSync(join(workDir, "b", idB));

    expect(idA).toBe(idB);
    expect(Buffer.compare(bytesA, bytesB)).toBe(0);

    dbA.close();
    dbB.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("a different `now` yields a different IV and therefore a different ciphertext", async () => {
    const workDir = freshTmpDir("al-snap-determinism2-");
    const memKey = await memKeyFor("image-a", "agent-0001");
    const db1 = openMemory(":memory:");
    populateAllTables(db1);
    const bytes = db1.serialize();
    db1.close();

    const dbA = new DatabaseCtor(bytes) as unknown as MemoryDb;
    const dbB = new DatabaseCtor(bytes) as unknown as MemoryDb;
    const sink = new LocalDirSink(join(workDir, "snapshots"));

    const { id: idA } = await writeSnapshot(dbA, memKey, sink, 1n, 1);
    const { id: idB } = await writeSnapshot(dbB, memKey, sink, 2n, 1);

    const bytesA = readFileSync(join(workDir, "snapshots", idA));
    const bytesB = readFileSync(join(workDir, "snapshots", idB));
    expect(Buffer.compare(bytesA, bytesB)).not.toBe(0);

    dbA.close();
    dbB.close();
    rmSync(workDir, { recursive: true, force: true });
  });
});

describe("restoreLatest: unparseable files are tolerated", () => {
  it("skips garbage files in the sink directory and still restores the real snapshot", async () => {
    const workDir = freshTmpDir("al-snap-garbage-");
    const memKey = await memKeyFor("image-a", "agent-0001");
    const db = openMemory(":memory:");
    populateAllTables(db);
    const dump = dumpAllTables(db);
    const sink = new LocalDirSink(join(workDir, "snapshots"));
    await writeSnapshot(db, memKey, sink, 10n, 1);
    db.close();

    writeFileSync(join(workDir, "snapshots", "snapshot-garbage.bin"), Buffer.from("not an envelope at all"));

    const result = await restoreLatest([sink], memKey);
    expect(result).not.toBeNull();
    expect(dumpAllTables(result!.db)).toEqual(dump);

    result!.db.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("restoreLatest returns null when the sink is empty", async () => {
    const workDir = freshTmpDir("al-snap-empty-");
    const memKey = await memKeyFor("image-a", "agent-0001");
    const sink = new LocalDirSink(join(workDir, "snapshots"));
    const result = await restoreLatest([sink], memKey);
    expect(result).toBeNull();
    rmSync(workDir, { recursive: true, force: true });
  });
});
