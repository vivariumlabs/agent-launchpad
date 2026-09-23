// SPEC-M3 §2 — fetchAttestation (raw quote, no in-enclave verification), canonical report
// golden, AttestationSink implementations.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReport,
  fetchAttestation,
  LocalDirSink,
  NotFundedError,
  TurboArweaveSink,
  type BuildReportInput,
} from "../../src/attestation/attestation.js";
import { NonLocalUrlError } from "../../src/keyring/nautilusKms.js";
import { DEFAULT_QUOTE, MockNautilusServer } from "./mockNautilus.js";

const servers: MockNautilusServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function serve(opts: ConstructorParameters<typeof MockNautilusServer>[0] = {}): Promise<MockNautilusServer> {
  const s = new MockNautilusServer(opts);
  await s.start();
  servers.push(s);
  return s;
}

const INPUT: BuildReportInput = {
  quote: DEFAULT_QUOTE,
  imageId: `0x${"28E981AC".repeat(8)}` as Hex,
  imageDigest: `sha256:${"0f".repeat(32)}`,
  configHash: `0x${"c0".repeat(32)}` as Hex,
  ownAddresses: { treasury: "0x1111111111111111111111111111111111111111" as Address, action: "0xAbCdEf0000000000000000000000000000000002" as Address },
  generation: null,
  now: 1_790_000_000n,
};

const GOLDEN =
  '{"configHash":"0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",' +
  '"eoas":{"action":"0xabcdef0000000000000000000000000000000002","treasury":"0x1111111111111111111111111111111111111111"},' +
  '"generation":null,' +
  '"imageDigest":"sha256:0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",' +
  '"imageId":"0x28e981ac28e981ac28e981ac28e981ac28e981ac28e981ac28e981ac28e981ac",' +
  '"kind":"agent-launchpad.attestation-report",' +
  '"quote":"0oREoQE4IqBZAATerb7vAP8=","quoteEncoding":"base64",' +
  '"timestamp":"1790000000","version":1}';

describe("fetchAttestation", () => {
  it("returns the raw quote bytes unchanged (no parsing / verification)", async () => {
    const quote = new Uint8Array(4096).map((_, i) => (i * 31) & 0xff);
    const s = await serve({ quote });
    const got = await fetchAttestation(s.attestationUrl);
    expect(Buffer.from(got).equals(Buffer.from(quote))).toBe(true);
    expect(s.requests).toEqual(["/attestation/raw"]);
  });
  it("non-200 ⇒ throws", async () => {
    const s = await serve({ failFirstN: 1 });
    await expect(fetchAttestation(s.attestationUrl)).rejects.toThrow(/HTTP 404/);
  });
  it("non-localhost URL ⇒ refused before any connection", async () => {
    await expect(fetchAttestation("http://10.1.2.3:1300/attestation/raw")).rejects.toBeInstanceOf(NonLocalUrlError);
    await expect(fetchAttestation("https://127.0.0.1:1300/attestation/raw")).rejects.toBeInstanceOf(NonLocalUrlError);
  });
});

describe("buildReport (04 §5) — canonical JSON", () => {
  it("golden: key-sorted, hex lowercased, timestamp decimal string, quote base64", () => {
    expect(buildReport(INPUT)).toBe(GOLDEN);
  });
  it("deterministic and insensitive to input key order / hex case", () => {
    const shuffled: BuildReportInput = {
      now: INPUT.now,
      generation: null,
      ownAddresses: { action: INPUT.ownAddresses.action, treasury: INPUT.ownAddresses.treasury },
      configHash: INPUT.configHash.toUpperCase().replace("0X", "0x") as Hex,
      imageDigest: INPUT.imageDigest ?? null,
      imageId: INPUT.imageId.toLowerCase() as Hex,
      quote: new Uint8Array(DEFAULT_QUOTE),
    };
    expect(buildReport(shuffled)).toBe(GOLDEN);
  });
  it("quote round-trips byte-exact through the report; absent digest / known generation encode as expected", () => {
    const r = JSON.parse(buildReport({ ...INPUT, imageDigest: undefined, generation: 3 })) as { quote: string; imageDigest: unknown; generation: unknown };
    expect(Buffer.from(r.quote, "base64").equals(Buffer.from(DEFAULT_QUOTE))).toBe(true);
    expect(r.imageDigest).toBeNull();
    expect(r.generation).toBe(3);
  });
  it("rejects malformed imageId / configHash / empty quote", () => {
    expect(() => buildReport({ ...INPUT, imageId: "0x1234" as Hex })).toThrow(/imageId/);
    expect(() => buildReport({ ...INPUT, configHash: `0x${"zz".repeat(32)}` as Hex })).toThrow(/configHash/);
    expect(() => buildReport({ ...INPUT, quote: new Uint8Array(0) })).toThrow(/empty quote/);
  });
});

describe("AttestationSink", () => {
  it("LocalDirSink writes attestation-<now>.json and returns the filename as ref", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "al-att-")), "nested");
    dirs.push(dir);
    const sink = new LocalDirSink(dir);
    const ref = await sink.upload(GOLDEN, 1_790_000_000n);
    expect(ref).toBe("attestation-1790000000.json");
    expect(readdirSync(dir)).toEqual([ref]);
    expect(readFileSync(join(dir, ref), "utf8")).toBe(GOLDEN);
  });
  it("TurboArweaveSink skeleton ⇒ NotFundedError with a clear message", async () => {
    const sink = new TurboArweaveSink({ address: "0x6930FD5C95a2D9d80F3d165597d55843e8A00154", sign: async (d) => d });
    const p = sink.upload(GOLDEN, 1n);
    await expect(p).rejects.toBeInstanceOf(NotFundedError);
    await expect(sink.upload(GOLDEN, 1n)).rejects.toThrow(/NotFunded: .*not wired yet \(SPEC-M3 s2\).*0x6930FD5C95a2D9d80F3d165597d55843e8A00154/);
  });
});
