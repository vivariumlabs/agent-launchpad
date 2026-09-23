// SPEC-M3B §3 — Turbo/Arweave sinks (mocked at the TurboUploader seam; the real uploader is the
// in-house attestation/turboHttp.ts — see turboHttp.test.ts / ans104.test.ts), the treasury turboSigner adapter, mirrors,
// and multi-sink restore with Turbo-first ordering.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashMessage, keccak256, recoverAddress, recoverMessageAddress, stringToBytes, toHex, type Address, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDirSink as AttestationDirSink } from "../../src/attestation/attestation.js";
import { LOW_CREDIT_DAYS, MirroredAttestationSink, MirroredSnapshotSink, TURBO_APP_TAG, TurboArweaveSink, turboTags } from "../../src/attestation/turbo.js";
import { createKeyring, TURBO_SIGN_LENGTHS, type TurboSigner } from "../../src/keyring/keyring.js";
import type { KmsClient } from "../../src/keyring/kms.js";
import { MockKms } from "../../src/keyring/mockKms.js";
import { kvSet, openMemory } from "../../src/memory/db.js";
import { LocalDirSink, restoreLatest, writeSnapshot, type SnapshotSink } from "../../src/memory/snapshot.js";
import { MockTurbo } from "./mockTurbo.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "al-turbo-"));
  dirs.push(d);
  return d;
}

const OWNER = "0x6930FD5C95a2D9d80F3d165597d55843e8A00154" as Address;

function logs() {
  const out = { warn: [] as string[], info: [] as string[] };
  return { out, logger: { info: (m: string) => out.info.push(m), warn: (m: string) => out.warn.push(m) } };
}

describe("TurboArweaveSink: both sink interfaces over one uploader; tags + ref plumbing", () => {
  it("attestation upload: UTF-8 report bytes, tags {App, Kind: attestation, AgentId, Timestamp}, ref = txid", async () => {
    const t = new MockTurbo(OWNER);
    const sink = new TurboArweaveSink({ uploader: t, agentId: 7, owner: OWNER });
    const ref = await sink.upload('{"kind":"agent-launchpad.attestation-report"}', 1_790_000_000n);
    const item = t.items.get(ref)!;
    expect(new TextDecoder().decode(item.data)).toBe('{"kind":"agent-launchpad.attestation-report"}');
    expect(item.tags).toEqual([
      { name: "App", value: TURBO_APP_TAG },
      { name: "Kind", value: "attestation" },
      { name: "AgentId", value: "7" },
      { name: "Timestamp", value: "1790000000" },
    ]);
    expect(TURBO_APP_TAG).toBe("agent-launchpad");
  });

  it("snapshot write/list/read: Kind snapshot; list = this agent's snapshots by this owner only", async () => {
    const t = new MockTurbo(OWNER);
    const sink = new TurboArweaveSink({ uploader: t, agentId: 7, owner: OWNER });
    const id = await sink.write(new Uint8Array([1, 2, 3]), 100n);
    await sink.upload("report", 101n); // attestation: not a snapshot
    await new TurboArweaveSink({ uploader: t, agentId: 8, owner: OWNER }).write(new Uint8Array([9]), 102n); // other agent
    const foreign = new MockTurbo("0x000000000000000000000000000000000000dEaD");
    foreign.items.set("spoof", { data: new Uint8Array([6]), tags: turboTags("snapshot", 7, 103n), owner: "0x000000000000000000000000000000000000dEaD" });
    for (const [k, v] of foreign.items) t.items.set(k, v); // same index, other owner
    expect(t.items.get(id)!.tags).toEqual(turboTags("snapshot", 7, 100n));
    expect(await sink.list()).toEqual([id]);
    expect([...(await sink.read(id))]).toEqual([1, 2, 3]);
  });

  it("low credits (< 30 days of snapshots at this size) ⇒ LOUD warning; enough ⇒ silent; credit-check failure never fails the write", async () => {
    const t = new MockTurbo(OWNER);
    const { out, logger } = logs();
    const sink = new TurboArweaveSink({ uploader: t, agentId: 7, owner: OWNER, logger });
    t.balance = 1_000n * 1_000n * LOW_CREDIT_DAYS; // exactly 30 days of 1000-byte snapshots
    await sink.write(new Uint8Array(1_000), 1n);
    expect(out.warn).toEqual([]);
    t.balance -= 1n;
    await sink.write(new Uint8Array(1_000), 2n);
    expect(out.warn).toHaveLength(1);
    expect(out.warn[0]).toMatch(/^!!! TURBO CREDITS LOW: 29999999 winc < 30000000 winc \(30 days of 1000-byte snapshots\)/);
    t.balanceWinc = async () => {
      throw new Error("turbo payment service down");
    };
    await expect(sink.write(new Uint8Array(10), 3n)).resolves.toMatch(/^tx/);
    expect(out.warn.at(-1)).toMatch(/credit check failed: turbo payment service down/);
  });

  it("upload failure propagates (no silent success)", async () => {
    const t = new MockTurbo(OWNER);
    t.failUpload = new Error("402 insufficient balance");
    const sink = new TurboArweaveSink({ uploader: t, agentId: 7, owner: OWNER });
    await expect(sink.write(new Uint8Array(1), 1n)).rejects.toThrow(/402/);
    await expect(sink.upload("r", 1n)).rejects.toThrow(/402/);
  });
});

describe("mirrors (belt and suspenders)", () => {
  it("MirroredSnapshotSink: primary id returned, bytes in both; mirror failure logged; primary failure throws AFTER the mirror is written", async () => {
    const t = new MockTurbo(OWNER);
    const turbo = new TurboArweaveSink({ uploader: t, agentId: 7, owner: OWNER });
    const local = new LocalDirSink(tmp());
    const { out, logger } = logs();
    const m = new MirroredSnapshotSink(turbo, [local], logger);
    const id = await m.write(new Uint8Array([5]), 10n);
    expect(id).toMatch(/^tx/);
    expect(await local.list()).toEqual(["snapshot-10.bin"]);
    expect(await m.list()).toEqual([id]);

    const broken: SnapshotSink = { write: async () => Promise.reject(new Error("disk full")), list: async () => [], read: async () => new Uint8Array() };
    await new MirroredSnapshotSink(turbo, [broken], logger).write(new Uint8Array([6]), 11n);
    expect(out.warn.at(-1)).toMatch(/mirror 0 write failed: disk full/);

    t.failUpload = new Error("turbo down");
    await expect(m.write(new Uint8Array([7]), 12n)).rejects.toThrow(/turbo down/);
    expect((await local.list()).sort()).toEqual(["snapshot-10.bin", "snapshot-12.bin"]);
  });

  it("MirroredAttestationSink: ref = the Turbo txid, local copy kept", async () => {
    const t = new MockTurbo(OWNER);
    const dir = tmp();
    const ref = await new MirroredAttestationSink(new TurboArweaveSink({ uploader: t, agentId: 7, owner: OWNER }), [new AttestationDirSink(dir)]).upload("rep", 5n);
    expect(t.items.has(ref)).toBe(true);
    expect(await new LocalDirSink(dir).list()).toEqual([]); // (different filename family)
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir)).toEqual(["attestation-5.json"]);
  });
});

describe("multi-sink restore: [turbo, local]", () => {
  const MEM_KEY = keccak256(stringToBytes("turbo-restore-memkey"));
  function dbWith(v: string) {
    const db = openMemory(":memory:");
    kvSet(db, "marker", v);
    return db;
  }

  it("Turbo-first: equal createdAt in both sinks ⇒ restored from Turbo (sinkIndex 0); newer local wins over older Turbo", async () => {
    const t = new MockTurbo(OWNER);
    const turbo = new TurboArweaveSink({ uploader: t, agentId: 7, owner: OWNER });
    const local = new LocalDirSink(tmp());
    await writeSnapshot(dbWith("both"), MEM_KEY, new MirroredSnapshotSink(turbo, [local]), 100n, 7);
    const r1 = await restoreLatest([turbo, local], MEM_KEY);
    expect(r1?.meta.sinkIndex).toBe(0);
    expect(r1?.meta.id).toMatch(/^tx/);

    await writeSnapshot(dbWith("local-newer"), MEM_KEY, local, 200n, 7); // e.g. Turbo was down
    const r2 = await restoreLatest([turbo, local], MEM_KEY);
    expect(r2?.meta.sinkIndex).toBe(1);
    expect(r2?.meta.createdAt).toBe(200n);
  });

  it("fresh enclave (empty local) ⇒ restored from Turbo alone; Turbo list failure ⇒ local still restores", async () => {
    const t = new MockTurbo(OWNER);
    const turbo = new TurboArweaveSink({ uploader: t, agentId: 7, owner: OWNER });
    await writeSnapshot(dbWith("arweave-only"), MEM_KEY, turbo, 300n, 7);
    const r = await restoreLatest([turbo, new LocalDirSink(tmp())], MEM_KEY);
    expect(r?.meta.sinkIndex).toBe(0);
    expect(r?.db.prepare("SELECT value FROM kv WHERE key = 'marker'").get()).toEqual({ value: "arweave-only" });

    const local = new LocalDirSink(tmp());
    await writeSnapshot(dbWith("local"), MEM_KEY, local, 50n, 7);
    t.query = async () => Promise.reject(new Error("graphql down"));
    const r2 = await restoreLatest([turbo, local], MEM_KEY);
    expect(r2?.meta.sinkIndex).toBe(1);
  });
});

describe("keyring.turboSigner(): treasury-backed, NO key material exposed", () => {
  const kms = new MockKms("image-a", "agent-0001");
  async function setup(): Promise<{ signer: TurboSigner; treasury: Address; treasuryKey: Hex; all: Hex[] }> {
    const kr = await createKeyring(kms, { retry: { attempts: 1, delayMs: 1 } });
    const all = await Promise.all(["treasury", "action", "fc", "mem", "chat", "acme", "tls"].map((p) => kms.derive(p)));
    return { signer: kr.turboSigner(), treasury: kr.addresses().treasury, treasuryKey: all[0]!, all };
  }

  it("shape: ANS-104 Ethereum signer (type 3, 65-byte owner + signature); only public fields; frozen", async () => {
    const { signer, treasury } = await setup();
    expect(Object.keys(signer).sort()).toEqual(["address", "ownerLength", "publicKey", "sign", "signatureLength", "signatureType"]);
    expect(Object.getOwnPropertyNames(signer).sort()).toEqual(Object.keys(signer).sort());
    expect(signer.signatureType).toBe(3);
    expect(signer.ownerLength).toBe(65);
    expect(signer.signatureLength).toBe(65);
    expect(signer.publicKey).toHaveLength(65);
    expect(signer.publicKey[0]).toBe(4);
    expect(signer.address).toBe(treasury);
    expect(Object.isFrozen(signer)).toBe(true);
    for (const k of Object.keys(signer)) if (k !== "publicKey") expect(k).not.toMatch(/key|priv|secret|seed|account|mnemonic/i);
  });

  it("no key material anywhere in the object graph (serialized, enumerable or not, function source)", async () => {
    const { signer, all } = await setup();
    const needles = all.map((k) => k.slice(2).toLowerCase());
    const hay: string[] = [];
    const seen = new Set<unknown>();
    const walk = (v: unknown): void => {
      if (v === null || seen.has(v)) return;
      if (typeof v === "string") return void hay.push(v.toLowerCase());
      if (typeof v === "bigint" || typeof v === "number") return void hay.push(v.toString(16));
      if (v instanceof Uint8Array) return void hay.push(Buffer.from(v).toString("hex"));
      if (typeof v === "function") return void hay.push(v.toString().toLowerCase());
      if (typeof v !== "object") return;
      seen.add(v);
      for (const k of Reflect.ownKeys(v)) walk((v as Record<string | symbol, unknown>)[k]);
    };
    walk(signer);
    hay.push(JSON.stringify(signer, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v)).toLowerCase());
    for (const h of hay) for (const n of needles) expect(h.includes(n)).toBe(false);
  });

  it("sign(48-byte deep hash) = EIP-191 personal_sign by the TREASURY key (65 bytes, recovers to the treasury EOA)", async () => {
    const { signer, treasury } = await setup();
    const msg = new Uint8Array(48).map((_, i) => i * 3);
    const sig = await signer.sign(msg);
    expect(sig).toHaveLength(65);
    expect(await recoverMessageAddress({ message: { raw: msg }, signature: toHex(sig) })).toBe(treasury);
    expect(await recoverAddress({ hash: hashMessage({ raw: msg }), signature: toHex(sig) })).toBe(treasury);
  });

  it("refuses to be a general personal_sign oracle: only 48-byte ANS-104 deep hashes (32-byte shape removed: attestationSigner collision)", async () => {
    const { signer } = await setup();
    expect(TURBO_SIGN_LENGTHS).toEqual([48]);
    for (const n of [0, 1, 20, 31, 32, 33, 47, 49, 64, 200]) await expect(signer.sign(new Uint8Array(n)), String(n)).rejects.toThrow(/refusing to sign/);
    await expect(signer.sign(stringToBytes("Sign in with Ethereum to evil.example") as Uint8Array)).rejects.toThrow(/refusing/);
    await expect(signer.sign("0x1234" as unknown as Uint8Array)).rejects.toThrow(/refusing/);
  });

  it("acmeAccountKey / tlsPlaceholderKey are LAZY: the boot derive order is untouched until first use; memoized; a failed derive retries", async () => {
    const paths: string[] = [];
    let failTls = 1;
    const spy: KmsClient = {
      derive: async (p) => {
        paths.push(p);
        if (p === "tls" && failTls-- > 0) throw new Error("kms not ready");
        return kms.derive(p);
      },
    };
    const kr = await createKeyring(spy, { retry: { attempts: 1, delayMs: 1 } });
    expect(paths).toEqual(["treasury", "action", "fc", "mem", "chat"]);
    const a = await kr.acmeAccountKey();
    expect(await kr.acmeAccountKey()).toBe(a);
    expect(a).toBe(await kms.derive("acme"));
    await expect(kr.tlsPlaceholderKey()).rejects.toThrow(/kms not ready/);
    expect(await kr.tlsPlaceholderKey()).toBe(await kms.derive("tls"));
    expect(paths).toEqual(["treasury", "action", "fc", "mem", "chat", "acme", "tls", "tls"]);
  });
});
