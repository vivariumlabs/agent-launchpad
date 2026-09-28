// SPEC-M4A §3 — TurboJournalSink: memory row first (authoritative ref), then a best-effort plaintext
// Arweave upload of {v:1, agentId, ts, text} tagged turboTags("journal", agentId, now).

import { keccak256, stringToBytes, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { journalEnvelope, TURBO_APP_TAG, TurboJournalSink, turboTags } from "../../src/attestation/turbo.js";
import type { ProposedAction } from "../../src/policy/types.js";
import { listJournal, openMemory } from "../../src/memory/db.js";
import { memoryJournalSink } from "../../src/pulse/pulse.js";
import { MockTurbo } from "./mockTurbo.js";

const OWNER = "0x00000000000000000000000000000000000000aa" as Address;
const T = 1_760_000_000n;
const clock = () => T;

function logger() {
  const lines: string[] = [];
  return { lines, info: (m: string) => void lines.push(`I ${m}`), warn: (m: string) => void lines.push(`W ${m}`) };
}

function entry(text: string): { action: ProposedAction; bytes: Uint8Array } {
  const bytes = stringToBytes(text);
  return { action: { kind: "journalWrite", contentHash: keccak256(bytes), sizeBytes: BigInt(bytes.length) }, bytes };
}

describe("M4A-journal: TurboJournalSink (SPEC-M4A §3)", () => {
  it("M4A-journal: uploads the exact envelope bytes with exactly the 4 tags {App, Kind: journal, AgentId, Timestamp}; returns the memory ref", async () => {
    const db = openMemory(":memory:");
    const turbo = new MockTurbo(OWNER);
    const sink = new TurboJournalSink({ inner: memoryJournalSink(db, clock), uploader: turbo, agentId: 7, clock, logger: logger() });
    const { action, bytes } = entry("déjà vu — gm ✓");
    const ref = await sink.write(action, bytes);
    expect(ref).toBe("journal:1");
    expect(listJournal(db)).toHaveLength(1);
    expect([...turbo.items.values()]).toHaveLength(1);
    const item = [...turbo.items.values()][0]!;
    expect(item.data).toEqual(new TextEncoder().encode(JSON.stringify({ v: 1, agentId: 7, ts: 1_760_000_000, text: "déjà vu — gm ✓" })));
    expect(item.tags).toEqual([
      { name: "App", value: TURBO_APP_TAG },
      { name: "Kind", value: "journal" },
      { name: "AgentId", value: "7" },
      { name: "Timestamp", value: "1760000000" },
    ]);
    expect(item.tags).toEqual(turboTags("journal", 7, T));
  });

  it("M4A-journal: upload failure ⇒ memory row still written, LOUD warn logged, no throw, memory ref returned; next entry still tries", async () => {
    const db = openMemory(":memory:");
    const turbo = new MockTurbo(OWNER);
    turbo.failUpload = new Error("turbo 503");
    const log = logger();
    const sink = new TurboJournalSink({ inner: memoryJournalSink(db, clock), uploader: turbo, agentId: 7, clock, logger: log });
    const a = entry("first");
    await expect(sink.write(a.action, a.bytes)).resolves.toBe("journal:1");
    expect(listJournal(db).map((r) => r.content)).toEqual(["first"]);
    expect(turbo.items.size).toBe(0);
    const warns = log.lines.filter((l) => l.startsWith("W "));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^W !!! JOURNAL ARWEAVE UPLOAD FAILED for journal:1: turbo 503 .*!!!$/);

    turbo.failUpload = null;
    const b = entry("second");
    await expect(sink.write(b.action, b.bytes)).resolves.toBe("journal:2");
    expect(listJournal(db)).toHaveLength(2);
    expect(turbo.items.size).toBe(1); // nothing queued: only "second" uploaded
    expect(new TextDecoder().decode([...turbo.items.values()][0]!.data)).toContain('"text":"second"');
  });

  it("M4A-journal: inner (memory) write failure propagates and nothing is uploaded", async () => {
    const turbo = new MockTurbo(OWNER);
    const sink = new TurboJournalSink({
      inner: { write: async () => Promise.reject(new Error("disk full")) },
      uploader: turbo,
      agentId: 7,
      clock,
    });
    const a = entry("x");
    await expect(sink.write(a.action, a.bytes)).rejects.toThrow("disk full");
    expect(turbo.items.size).toBe(0);
  });

  it("M4A-journal: JSON envelope golden (fixed clock + text, byte-exact)", () => {
    const got = journalEnvelope(42, 1_700_000_123n, 'hello "world"\nline2 é');
    const golden = '{"v":1,"agentId":42,"ts":1700000123,"text":"hello \\"world\\"\\nline2 é"}';
    expect(new TextDecoder().decode(got)).toBe(golden);
    expect(got).toEqual(new Uint8Array([...Buffer.from(golden, "utf8")]));
    expect(got.length).toBe(Buffer.byteLength(golden, "utf8"));
  });

  it("M4A-journal: bad agentId refuses construction", () => {
    for (const agentId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new TurboJournalSink({ inner: { write: async () => "x" }, uploader: new MockTurbo(OWNER), agentId, clock })).toThrow(/bad agentId/);
    }
  });
});
