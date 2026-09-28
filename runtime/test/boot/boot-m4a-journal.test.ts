// SPEC-M4A §3 boot wiring: runtime.arweave.enabled AND runtime.tee ⇒ journalSink = TurboJournalSink
// wrapping memoryJournalSink; otherwise memoryJournalSink only; overrides.journalSink wins.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, stringToBytes, type Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { boot, type BootLogger, type BootOverrides, type Runtime, type TimerApi } from "../../src/boot.js";
import { journalEnvelope, TurboJournalSink } from "../../src/attestation/turbo.js";
import { frozenConfigHash } from "../../src/config/schema.js";
import { MockChainClient } from "../../src/exec/chain.js";
import { execute, type JournalSink } from "../../src/exec/execute.js";
import { listJournal } from "../../src/memory/db.js";
import { NOW } from "../policy/helpers.js";
import { MockNautilusServer } from "../attestation/mockNautilus.js";
import { MockTurbo } from "../attestation/mockTurbo.js";

const FIXTURE = join(__dirname, "fixtures", "runtime.config.json");
const OWNER = "0x0000000000000000000000000000000000000001" as Address;

const dirs: string[] = [];
const runtimes: Runtime[] = [];
const servers: MockNautilusServer[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.stop().catch(() => undefined);
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class FakeTimers implements TimerApi {
  set(): unknown {
    return 1;
  }
  clear(): void {}
}

function logger(): BootLogger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => void lines.push(`I ${m}`), warn: (m) => void lines.push(`W ${m}`), error: (m) => void lines.push(`E ${m}`) };
}

/** Legacy single-file boot; tee ⇒ MockNautilus KMS + attestation + attested init params. */
async function bootWith(opts: { tee: boolean; arweave: boolean }, overrides: Partial<BootOverrides>): Promise<Runtime> {
  const dir = mkdtempSync(join(tmpdir(), "al-boot4a-"));
  dirs.push(dir);
  const j = JSON.parse(readFileSync(FIXTURE, "utf8")) as { platform: Record<string, unknown>; agent: unknown; runtime: Record<string, unknown> };
  if (opts.arweave) j.runtime.arweave = { enabled: true };
  let initParamsDir: string | undefined;
  if (opts.tee) {
    const s = new MockNautilusServer({ seed: "image-a|agent-1" });
    await s.start();
    servers.push(s);
    delete j.runtime.mockKms;
    Object.assign(j.runtime, { tee: true, kmsUrl: s.baseUrl, attestationUrl: s.attestationUrl, imageId: `0x${"28e981ac".repeat(8)}`, registrationRetrySec: 0 });
    initParamsDir = join(dir, "init");
    mkdirSync(initParamsDir);
    writeFileSync(join(initParamsDir, "agent-id"), "agent-1");
    writeFileSync(join(initParamsDir, "config-hash"), frozenConfigHash({ platform: j.platform, agent: j.agent }));
  }
  const cfgPath = join(dir, "m4a.json");
  writeFileSync(cfgPath, JSON.stringify(j));
  mkdirSync(join(dir, "data"), { recursive: true });
  const rt = await boot({
    configPath: cfgPath,
    dbPath: join(dir, "data", "agent.db"),
    snapshotDir: join(dir, "snapshots"),
    clock: () => NOW,
    kmsRetry: { attempts: 2, delayMs: 1 },
    ...(initParamsDir !== undefined ? { initParamsDir } : {}),
    overrides: { chain: new MockChainClient({ reads: () => 0n }), timers: new FakeTimers(), logger: logger(), chatPort: 0, ...overrides },
  });
  runtimes.push(rt);
  return rt;
}

async function journalOnce(rt: Runtime, text: string) {
  const bytes = stringToBytes(text);
  return execute({ kind: "journalWrite", contentHash: keccak256(bytes), sizeBytes: BigInt(bytes.length) }, rt.exec, { journalBytes: bytes });
}

function journalItems(t: MockTurbo) {
  return [...t.items.values()].filter((v) => v.tags.some((x) => x.name === "Kind" && x.value === "journal"));
}

describe("M4A-journal: boot wiring matrix (SPEC-M4A §3)", () => {
  it("M4A-journal: arweave on + tee on ⇒ TurboJournalSink wrapping memory (memory ref returned, row written, envelope uploaded)", async () => {
    const turbo = new MockTurbo(OWNER);
    const rt = await bootWith({ tee: true, arweave: true }, { turboUploader: turbo });
    expect(rt.exec.journalSink).toBeInstanceOf(TurboJournalSink);
    const r = await journalOnce(rt, "gm from the enclave");
    expect(r.verdict.allow).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.journalRef).toBe("journal:1");
    expect(listJournal(rt.db).map((x) => x.content)).toEqual(["gm from the enclave"]);
    const items = journalItems(turbo);
    expect(items).toHaveLength(1);
    expect(items[0]!.data).toEqual(journalEnvelope(rt.cfg.agent.agentId, NOW, "gm from the enclave"));
  });

  it("M4A-journal: arweave off (tee on) or tee off (arweave on) ⇒ memory only, nothing uploaded", async () => {
    for (const opts of [
      { tee: true, arweave: false },
      { tee: false, arweave: true },
      { tee: false, arweave: false },
    ]) {
      const turbo = new MockTurbo(OWNER);
      const rt = await bootWith(opts, { turboUploader: turbo });
      expect(rt.exec.journalSink).not.toBeInstanceOf(TurboJournalSink);
      const r = await journalOnce(rt, "local only");
      expect(r.error).toBeUndefined();
      expect(r.journalRef).toBe("journal:1");
      expect(listJournal(rt.db)).toHaveLength(1);
      expect(journalItems(turbo)).toHaveLength(0);
    }
  });

  it("M4A-journal: overrides.journalSink wins over TurboJournalSink (arweave on + tee on)", async () => {
    const turbo = new MockTurbo(OWNER);
    const seen: string[] = [];
    const sink: JournalSink = { write: async (_a, b) => (seen.push(new TextDecoder().decode(b)), "override:1") };
    const rt = await bootWith({ tee: true, arweave: true }, { turboUploader: turbo, journalSink: sink });
    expect(rt.exec.journalSink).toBe(sink);
    const r = await journalOnce(rt, "x");
    expect(r.journalRef).toBe("override:1");
    expect(seen).toEqual(["x"]);
    expect(listJournal(rt.db)).toHaveLength(0);
    expect(journalItems(turbo)).toHaveLength(0);
  });
});
