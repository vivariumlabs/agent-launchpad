// SPEC-M3D §3c — HubClient (hub rotation, octet-stream Message bytes, transport rules) and fcSink
// (memory mirror first; no fid ⇒ logged, not published; Message assembly; hub failure keeps the row).

import * as ed from "@noble/ed25519";
import { Message as FcMessage } from "@farcaster/core";
import { bytesToHex, hexToBytes, keccak256, stringToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { CastSink } from "../../src/exec/execute.js";
import { execute } from "../../src/exec/execute.js";
import { kvSet, listPosts, openMemory } from "../../src/memory/db.js";
import type { ProposedAction } from "../../src/policy/types.js";
import { memoryCastSink } from "../../src/pulse/pulse.js";
import { buildCastAddData, encodeMessage, fcMessageHash } from "../../src/social/fcMessage.js";
import { KV_FC_FID, readFcFid } from "../../src/social/fcOnboard.js";
import { fcSink } from "../../src/social/fcSink.js";
import { HubClient, type HubSubmitter } from "../../src/social/hubClient.js";
import { tick } from "../../src/daemon/daemon.js";
import { DAY, E18, E6, mkLedger, mkState, NOW } from "../policy/helpers.js";
import { daemonHarness } from "../daemon/harness.js";

const FID = 3_352_486n;
const HUBS = [
  { id: "hub-a", url: "https://hub-a.example/", operator: "platform" },
  { id: "hub-b", url: "https://hub-b.example", operator: "platform" },
];

interface Call {
  url: string;
  method: string;
  contentType: string | null;
  body: Uint8Array | null;
  redirect: string | undefined;
  hasSignal: boolean;
}

function fakeFetch(handler: (c: Call, i: number) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const c: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      contentType: new Headers(init?.headers).get("content-type"),
      body: init?.body instanceof Uint8Array ? init.body : null,
      redirect: init?.redirect,
      hasSignal: init?.signal instanceof AbortSignal,
    };
    calls.push(c);
    return handler(c, calls.length - 1);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const MSG = new Uint8Array([1, 2, 3, 4]);

describe("M3D-fc: HubClient (SPEC-M3D §3c)", () => {
  it("M3D-fc: POST <hub>/v1/submitMessage, octet-stream, body = the exact Message bytes, redirect: error, timeout signal; first 2xx wins", async () => {
    const f = fakeFetch(() => new Response("{}", { status: 200 }));
    const r = await new HubClient({ hubs: HUBS, fetchImpl: f.fetchImpl }).submitMessage(MSG);
    expect(r).toEqual({ hubId: "hub-a", status: 200 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ url: "https://hub-a.example/v1/submitMessage", method: "POST", contentType: "application/octet-stream", redirect: "error", hasSignal: true });
    expect(f.calls[0]!.body).toEqual(MSG);
  });

  it("M3D-fc: hub rotation — first fails (HTTP 500 / network error) ⇒ second wins", async () => {
    for (const first of [() => new Response("no", { status: 500 }), () => Promise.reject(new Error("ECONNREFUSED"))]) {
      const f = fakeFetch((_c, i) => (i === 0 ? first() : new Response("{}", { status: 200 })));
      const r = await new HubClient({ hubs: HUBS, fetchImpl: f.fetchImpl }).submitMessage(MSG);
      expect(r.hubId).toBe("hub-b");
      expect(f.calls.map((c) => c.url)).toEqual(["https://hub-a.example/v1/submitMessage", "https://hub-b.example/v1/submitMessage"]);
    }
  });

  it("M3D-fc: all hubs fail ⇒ throws with every failure listed", async () => {
    const f = fakeFetch((_c, i) => (i === 0 ? new Response("bad", { status: 400 }) : Promise.reject(new Error("timeout"))));
    await expect(new HubClient({ hubs: HUBS, fetchImpl: f.fetchImpl }).submitMessage(MSG)).rejects.toThrow(/every hub failed \(hub-a: HTTP 400; hub-b: timeout\)/);
  });

  it("M3D-fc: https only (allowInsecureHttp for tests), at least one hub, non-empty message", async () => {
    expect(() => new HubClient({ hubs: [{ id: "h", url: "http://hub.example", operator: "x" }] })).toThrow(/non-https/);
    expect(() => new HubClient({ hubs: [{ id: "h", url: "http://127.0.0.1:1", operator: "x" }], allowInsecureHttp: true })).not.toThrow();
    expect(() => new HubClient({ hubs: [] })).toThrow(/no hubs/);
    await expect(new HubClient({ hubs: HUBS, fetchImpl: fakeFetch(() => new Response("")).fetchImpl }).submitMessage(new Uint8Array(0))).rejects.toThrow(/empty/);
  });
});

function recordingHub(fail = false): HubSubmitter & { sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  return {
    sent,
    async submitMessage(b: Uint8Array) {
      sent.push(b);
      if (fail) throw new Error("hubClient: every hub failed (hub-a: HTTP 503)");
      return { hubId: "hub-a", status: 200 };
    },
  };
}

function recordingMirror(): CastSink & { rows: Array<{ kind: string; bytes: Uint8Array }> } {
  const rows: Array<{ kind: string; bytes: Uint8Array }> = [];
  return { rows, publish: async (a, bytes) => void rows.push({ kind: a.kind, bytes }) };
}

const SEED = hexToBytes(`0x${"07".repeat(32)}`);

describe("M3D-fc: fcSink (SPEC-M3D §3c)", () => {
  it("M3D-fc: no fid ⇒ mirror row written, NOT published, logged (not an error)", async () => {
    const mirror = recordingMirror();
    const hub = recordingHub();
    const infos: string[] = [];
    const pub = bytesToHex(await ed.getPublicKeyAsync(SEED));
    const sink = fcSink({ mirror, hub, signerPublicKey: pub, fid: () => undefined, logger: { info: (m) => infos.push(m), warn: (m) => infos.push(m) } });
    const bytes = stringToBytes("draft");
    await expect(sink.publish({ kind: "castPost", contentHash: keccak256(bytes) }, bytes, `0x${"00".repeat(64)}`)).resolves.toBeUndefined();
    expect(mirror.rows).toHaveLength(1);
    expect(hub.sent).toHaveLength(0);
    expect(infos.join("\n")).toMatch(/no fid yet — castPost draft kept locally/);
  });

  it("M3D-fc: fid known but bytes are not a MessageData for it (pre-fid draft / raw reply) ⇒ logged, not published", async () => {
    const mirror = recordingMirror();
    const hub = recordingHub();
    const warns: string[] = [];
    const pub = bytesToHex(await ed.getPublicKeyAsync(SEED));
    const sink = fcSink({ mirror, hub, signerPublicKey: pub, fid: () => FID, logger: { info: () => undefined, warn: (m) => warns.push(m) } });
    for (const bytes of [stringToBytes("raw text"), buildCastAddData("other fid", FID + 1n, NOW)]) {
      await sink.publish({ kind: "castPost", contentHash: keccak256(bytes) }, bytes, `0x${"00".repeat(64)}`);
    }
    expect(hub.sent).toHaveLength(0);
    expect(mirror.rows).toHaveLength(2);
    expect(warns).toHaveLength(2);
  });

  it("M3D-fc: with a fid ⇒ the hub receives Message{data_bytes, blake3-20, schemes, sig, signer = fc pubkey} (decoded by @farcaster/core)", async () => {
    const mirror = recordingMirror();
    const hub = recordingHub();
    const pubBytes = await ed.getPublicKeyAsync(SEED);
    const sink = fcSink({ mirror, hub, signerPublicKey: bytesToHex(pubBytes), fid: () => FID, logger: { info: () => undefined, warn: () => undefined } });
    const data = buildCastAddData("hello hubs", FID, NOW);
    const sig = bytesToHex(await ed.signAsync(fcMessageHash(data), SEED));
    await sink.publish({ kind: "castPost", contentHash: keccak256(data) }, data, sig);
    expect(mirror.rows).toHaveLength(1);
    expect(hub.sent).toHaveLength(1);
    expect(hub.sent[0]).toEqual(encodeMessage({ dataBytes: data, signature: hexToBytes(sig), signer: pubBytes }));
    const m = FcMessage.decode(hub.sent[0]!);
    expect(m.data).toBeUndefined();
    expect(bytesToHex(m.dataBytes!)).toBe(bytesToHex(data));
    expect(bytesToHex(m.hash)).toBe(bytesToHex(fcMessageHash(data)));
    expect([m.hashScheme, m.signatureScheme]).toEqual([1, 1]);
    expect(bytesToHex(m.signer)).toBe(bytesToHex(pubBytes));
    expect(await ed.verifyAsync(m.signature, m.hash, m.signer)).toBe(true);
  });

  it("M3D-fc: through execute() with the real keyring: K4 sig verifies on the hub Message; hub failure ⇒ ExecResult.error, memory draft row STILL written", async () => {
    const h = await daemonHarness();
    const db = openMemory(":memory:");
    kvSet(db, KV_FC_FID, FID.toString(10));
    expect(readFcFid(db)).toBe(FID);
    for (const fail of [false, true]) {
      h.deps.ledger.set(mkLedger()); // fixture postsPerDay = 1
      const hub = recordingHub(fail);
      h.deps.castSink = fcSink({ mirror: memoryCastSink(db, () => NOW), hub, signerPublicKey: h.kr.farcasterPublicKey(), fid: () => readFcFid(db), logger: { info: () => undefined, warn: () => undefined } });
      const data = buildCastAddData(fail ? "second" : "first", FID, NOW);
      const a: ProposedAction = { kind: "castPost", contentHash: keccak256(data) };
      const r = await execute(a, h.deps, { messageBytes: data });
      expect(hub.sent).toHaveLength(1);
      const m = FcMessage.decode(hub.sent[0]!);
      expect(await ed.verifyAsync(m.signature, fcMessageHash(data), hexToBytes(h.kr.farcasterPublicKey()))).toBe(true);
      expect(bytesToHex(m.signature) as Hex).toBe(r.castSignature);
      if (fail) expect(r.error).toMatch(/every hub failed/);
      else expect(r.error).toBeUndefined();
    }
    const posts = listPosts(db);
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.kind)).toEqual(["castPost", "castPost"]);
  });

  it("M3D-fc: readFcFid only accepts a positive decimal", () => {
    const db = openMemory(":memory:");
    expect(readFcFid(db)).toBeUndefined();
    for (const bad of ["0", "-1", "abc", "01", ""]) {
      kvSet(db, KV_FC_FID, bad);
      expect(readFcFid(db), bad).toBeUndefined();
    }
  });
});

// SPEC-M3D §3e ruling — fid injection on the daemon step-9 tier-announcement cast (outside pulse).
describe("M3D-fc: daemon step 9 tier-announcement cast through fcSink", () => {
  async function announce(fid: bigint | null) {
    const s = mkState({ hostingPaidUntil: NOW + 5n * DAY, hostingRatePerDay: 100n * E6 });
    s.treasury.arbitrum = { native: E18 / 10n, USDC: 0n };
    s.treasury.rh = { ...s.treasury.rh, USDG: 1000n * E6, tokens: {} };
    const h = await daemonHarness({ state: s, tier: "Active", lastSnapshotAt: NOW });
    if (fid !== null) kvSet(h.db, KV_FC_FID, fid.toString(10));
    const hub = recordingHub();
    const logs: string[] = [];
    h.deps.castSink = fcSink({
      mirror: memoryCastSink(h.db, () => NOW),
      hub,
      signerPublicKey: h.kr.farcasterPublicKey(),
      fid: () => readFcFid(h.db),
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    });
    const r = await tick(h.deps, NOW);
    const st = r.steps.find((x) => x.step === "tier");
    if (st?.status !== "ran") throw new Error("tier step should run");
    const cast = st.results.find((x) => x.action.kind === "castPost")!;
    return { h, hub, logs, cast };
  }
  const TEXT = "Runway update: moving from Active to Conserving (runway 14 days).";

  it("M3D-fc: kv fc.fid ⇒ the announcement is a CastAdd MessageData (fid + tick clock) ⇒ fcSink publishes a hub Message", async () => {
    const { h, hub, cast } = await announce(FID);
    const want = buildCastAddData(TEXT, FID, NOW);
    expect(cast.verdict.allow).toBe(true);
    expect(cast.error).toBeUndefined();
    expect(cast.action).toEqual({ kind: "castPost", contentHash: keccak256(want) });
    expect(hub.sent).toHaveLength(1);
    const m = FcMessage.decode(hub.sent[0]!);
    expect(bytesToHex(m.dataBytes!)).toBe(bytesToHex(want));
    expect(bytesToHex(m.hash)).toBe(bytesToHex(fcMessageHash(want)));
    expect(await ed.verifyAsync(m.signature, fcMessageHash(want), hexToBytes(h.kr.farcasterPublicKey()))).toBe(true);
    expect(listPosts(h.db)).toHaveLength(1); // local mirror row still written
  });

  it("M3D-fc: no kv fc.fid ⇒ today's UTF-8 bytes; fcSink keeps the draft local (logged, not an error)", async () => {
    const { h, hub, logs, cast } = await announce(null);
    expect(cast.verdict.allow).toBe(true);
    expect(cast.error).toBeUndefined();
    expect(cast.action).toEqual({ kind: "castPost", contentHash: keccak256(stringToBytes(TEXT)) });
    expect(hub.sent).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/no fid yet — castPost draft kept locally/);
    expect(listPosts(h.db)).toHaveLength(1);
  });
});
