// SPEC-M3 §2 — NautilusKms: localhost guard, hex normalization, path passthrough, boot retry.

import { afterEach, describe, expect, it } from "vitest";
import { createKeyring } from "../../src/keyring/keyring.js";
import { assertLocalhostUrl, NautilusKms, NonLocalUrlError, normalizeKeyBody, normalizeKeyHex } from "../../src/keyring/nautilusKms.js";
import { MockNautilusServer, mockDerivedKey } from "./mockNautilus.js";

const servers: MockNautilusServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function serve(opts: ConstructorParameters<typeof MockNautilusServer>[0] = {}): Promise<MockNautilusServer> {
  const s = new MockNautilusServer(opts);
  await s.start();
  servers.push(s);
  return s;
}

const K = "ab".repeat(32);

describe("normalizeKeyHex", () => {
  it("accepts bare, 0x/0X-prefixed, upper-case and whitespace-padded hex ⇒ 0x-lowercase", () => {
    for (const v of [K, `0x${K}`, `0X${K}`, K.toUpperCase(), ` ${K}\n`, `0x${K}\r\n`, `${K.slice(0, 20)} \n${K.slice(20)}`]) {
      expect(normalizeKeyHex(v)).toBe(`0x${K}`);
    }
  });
  it("rejects anything that is not exactly 32 bytes of hex", () => {
    for (const v of ["", "0x", K.slice(2), `${K}ab`, `${K.slice(2)}zz`, `0x0x${K}`, "not a key"]) {
      expect(() => normalizeKeyHex(v)).toThrow(/32 bytes/);
    }
  });
  it("error message never echoes the key material", () => {
    try {
      normalizeKeyHex(`${K}00`);
    } catch (e) {
      expect(String(e)).not.toContain(K);
    }
  });
});

describe("normalizeKeyBody (dual format: raw 32 bytes | hex text)", () => {
  const RAW = Buffer.from(K, "hex");
  it("exactly 32 raw bytes ⇒ that key (even bytes that are not printable / not hex)", () => {
    expect(RAW.length).toBe(32);
    expect(normalizeKeyBody(RAW)).toBe(`0x${K}`);
    const odd = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 250) % 256));
    expect(normalizeKeyBody(odd)).toBe(`0x${odd.toString("hex")}`);
  });
  it("hex text (64 chars, 0x/whitespace variants) still accepted", () => {
    expect(normalizeKeyBody(Buffer.from(`0x${K}\n`, "utf8"))).toBe(`0x${K}`);
    expect(normalizeKeyBody(Buffer.from(K, "utf8"))).toBe(`0x${K}`);
  });
  it("33 raw bytes (and 31, and 0) ⇒ reject", () => {
    expect(() => normalizeKeyBody(Buffer.concat([RAW, Buffer.from([0x01])]))).toThrow(/32 bytes/);
    expect(() => normalizeKeyBody(Buffer.concat([RAW, Buffer.from("\n")]))).toThrow(/32 bytes/);
    expect(() => normalizeKeyBody(RAW.subarray(1))).toThrow(/32 bytes/);
    expect(() => normalizeKeyBody(Buffer.alloc(0))).toThrow(/32 bytes/);
  });
});

describe("localhost-only guard", () => {
  it("constructor refuses non-localhost / non-http / credentialed URLs", () => {
    for (const u of [
      "http://10.0.0.1:1100",
      "http://8.8.8.8:1100",
      "https://127.0.0.1:1100",
      "http://127.0.0.1.evil.com:1100",
      "http://localhost.evil.com:1100",
      "http://localhost@evil.com:1100",
      "http://user:pw@127.0.0.1:1100",
      "http://[::1]:1100",
      "http://0.0.0.0:1100",
      "ftp://127.0.0.1:1100",
      "not a url",
    ]) {
      expect(() => new NautilusKms(u), u).toThrow(NonLocalUrlError);
    }
  });
  it("accepts 127.0.0.1 and localhost (any case), default URL included", () => {
    expect(() => new NautilusKms()).not.toThrow();
    expect(() => new NautilusKms("http://127.0.0.1:1100")).not.toThrow();
    expect(() => new NautilusKms("http://LOCALHOST:1100/")).not.toThrow();
    expect(assertLocalhostUrl("http://localhost:1300/attestation/raw").pathname).toBe("/attestation/raw");
  });
});

describe("NautilusKms.derive against MockNautilusServer", () => {
  it("GET /derive/secp256k1?path=<path> (no agentId appended) ⇒ normalized 32-byte key", async () => {
    const s = await serve({ seed: "img|agent-1" });
    const kms = new NautilusKms(s.baseUrl);
    expect(await kms.derive("treasury")).toBe(`0x${mockDerivedKey("img|agent-1", "treasury")}`);
    expect(await kms.derive("a b/&c")).toBe(`0x${mockDerivedKey("img|agent-1", "a b/&c")}`);
    expect(s.derivePaths).toEqual(["treasury", "a b/&c"]);
    expect(s.requests[0]).toBe("/derive/secp256k1?path=treasury");
  });

  it("works through a localhost-spelled base URL (connects to 127.0.0.1)", async () => {
    const s = await serve();
    const kms = new NautilusKms(s.baseUrl.replace("127.0.0.1", "localhost"));
    expect(await kms.derive("mem")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("0x-prefixed / upper-case bodies normalize; malformed bodies throw", async () => {
    const s = await serve({ deriveBody: (p) => (p === "bad" ? "0xdeadbeef\n" : `0X${K.toUpperCase()}\n`) });
    const kms = new NautilusKms(s.baseUrl);
    expect(await kms.derive("good")).toBe(`0x${K}`);
    await expect(kms.derive("bad")).rejects.toThrow(/32 bytes/);
  });

  it("raw 32-byte body ⇒ key; raw 33-byte body ⇒ throws", async () => {
    const raw = Buffer.from(K, "hex");
    const s = await serve({ deriveBody: (p) => (p === "long" ? Buffer.concat([raw, Buffer.from([0xff])]) : raw) });
    const kms = new NautilusKms(s.baseUrl);
    expect(await kms.derive("treasury")).toBe(`0x${K}`);
    await expect(kms.derive("long")).rejects.toThrow(/32 bytes/);
  });

  it("non-200 ⇒ throws with the status", async () => {
    const s = await serve({ failFirstN: 1, failStatus: 503 });
    await expect(new NautilusKms(s.baseUrl).derive("treasury")).rejects.toThrow(/HTTP 503/);
  });

  it("same server binding ⇒ same keys across client instances (deterministic)", async () => {
    const s = await serve({ seed: "x" });
    const a = await createKeyring(new NautilusKms(s.baseUrl), { retry: { attempts: 1, delayMs: 1 } });
    const b = await createKeyring(new NautilusKms(s.baseUrl), { retry: { attempts: 1, delayMs: 1 } });
    expect(a.addresses()).toEqual(b.addresses());
    expect(s.derivePaths).toEqual(["treasury", "action", "fc", "mem", "chat", "treasury", "action", "fc", "mem", "chat"]);
  });
});

describe("boot-time retry (M0 gotcha: derive server comes up late) — existing withRetry in createKeyring", () => {
  it("server 404s the first 3 calls ⇒ keyring still derives with retry", async () => {
    const s = await serve({ failFirstN: 3 });
    const kr = await createKeyring(new NautilusKms(s.baseUrl), { retry: { attempts: 5, delayMs: 1 } });
    expect(kr.addresses().treasury).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(s.derivePaths.slice(0, 4)).toEqual(["treasury", "treasury", "treasury", "treasury"]);
  });
  it("fewer attempts than failures ⇒ rejects with the last HTTP error", async () => {
    const s = await serve({ failFirstN: 3 });
    await expect(createKeyring(new NautilusKms(s.baseUrl), { retry: { attempts: 2, delayMs: 1 } })).rejects.toThrow(/HTTP 404/);
  });
});
