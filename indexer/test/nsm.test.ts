import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CborError, decodeCbor, encodeSigStructure1 } from "../src/nsm/cbor.js";
import { AWS_ROOT_KEY, AWS_ROOT_KEY_HEX, imageIdFromPcrs, QuoteError, rawP384, verifyCertChain, verifyQuote } from "../src/nsm/quote.js";

// ---------------------------------------------------------------------------
// Fixtures: the LIVE agent-8 / agent-10 attestation reports (Arweave iCt3c0kz… / mAPIQaMe…). The
// expected image-ids are the SPEC-M4D §0 oracle values (`oyster-cvm verify` on the same quotes).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const report = (n: 8 | 10): Record<string, unknown> => JSON.parse(readFileSync(join(here, `fixtures/agent${n}-report-full.json`), "utf8")) as Record<string, unknown>;
const quoteOf = (n: 8 | 10): Uint8Array => new Uint8Array(Buffer.from(String(report(n).quote), "base64"));

const ORACLE8 = "f489dc609c6b33a7016c113f0965a46de35c4cfd2ef8e8f4751bd845923a4350";
const ORACLE10 = "0558ac2879f92c1fd638d522552a81bbcc5ad8d7d543604567375a0d3fa9cc4a";

const h = (s: string): Uint8Array => new Uint8Array(Buffer.from(s.replace(/\s+/g, ""), "hex"));
const hx = (b: Uint8Array): string => Buffer.from(b).toString("hex");

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(QuoteError);
    return (e as QuoteError).reason;
  }
  throw new Error("expected a QuoteError");
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// cbor.ts
// ---------------------------------------------------------------------------

describe("M4D §2: cbor", () => {
  it("M4D §2: golden decode of each supported major type (uint all widths, negint, bstr, tstr, array, map, null, 48-byte bstr map values)", () => {
    // major 0 — inline, 1/2/4/8-byte arguments
    expect(decodeCbor(h("00"))).toBe(0);
    expect(decodeCbor(h("17"))).toBe(23);
    expect(decodeCbor(h("1818"))).toBe(24);
    expect(decodeCbor(h("1903e8"))).toBe(1000);
    expect(decodeCbor(h("1a000f4240"))).toBe(1_000_000);
    expect(decodeCbor(h("1affffffff"))).toBe(0xffffffff);
    expect(decodeCbor(h("1b000001938a7c6d20"))).toBe(0x1938a7c6d20); // an NSM-style ms timestamp
    expect(decodeCbor(h("1b001fffffffffffff"))).toBe(Number.MAX_SAFE_INTEGER);
    // major 1
    expect(decodeCbor(h("20"))).toBe(-1);
    expect(decodeCbor(h("3822"))).toBe(-35); // COSE ES384
    expect(decodeCbor(h("3903e7"))).toBe(-1000);
    // major 2 / 3
    expect(decodeCbor(h("40"))).toEqual(new Uint8Array(0));
    expect(decodeCbor(h("4401020304"))).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(decodeCbor(h("60"))).toBe("");
    expect(decodeCbor(h("6449455446"))).toBe("IETF");
    expect(decodeCbor(h("62c3bc"))).toBe("ü");
    // major 4 / 5 / null
    expect(decodeCbor(h("83010203"))).toEqual([1, 2, 3]);
    expect(decodeCbor(h("8301820203820405"))).toEqual([1, [2, 3], [4, 5]]);
    expect(decodeCbor(h("a0"))).toEqual(new Map());
    expect(decodeCbor(h("a201020304"))).toEqual(new Map([[1, 2], [3, 4]]));
    expect(decodeCbor(h("a1616101"))).toEqual(new Map([["a", 1]]));
    expect(decodeCbor(h("f6"))).toBeNull();
    // the NSM pcrs shape: map<uint, bstr48>, with 2-byte (0x59) bstr lengths elsewhere in the doc
    const pcr0 = new Uint8Array(48).fill(0xaa);
    const pcr16 = new Uint8Array(48).fill(0x16);
    expect(decodeCbor(h(`a2 00 5830 ${hx(pcr0)} 10 5830 ${hx(pcr16)}`))).toEqual(new Map([[0, pcr0], [16, pcr16]]));
    const big = new Uint8Array(1500).fill(7); // cabundle-sized
    expect(decodeCbor(h(`81 5905dc ${hx(big)}`))).toEqual([big]);
    expect(decodeCbor(h(`5a000005dc ${hx(big)}`))).toEqual(big);
    // The ONE indefinite form accepted: the NSM payload map (0xbf … 0xff), live-fixture fact.
    expect(decodeCbor(h("bf 6161 01 6162 f6 ff"))).toEqual(new Map<string, unknown>([["a", 1], ["b", null]]));
  });

  it("M4D §2: indefinite length (bstr / tstr / array) ⇒ throw; 64-bit beyond MAX_SAFE_INTEGER, reserved ai, duplicate keys ⇒ throw", () => {
    for (const bad of ["5f4101ff", "7f6161ff", "9f01ff", "1f", "1b0020000000000000", "1c", "a2010201 03", "a201020102"]) {
      expect(() => decodeCbor(h(bad)), bad).toThrow(CborError);
    }
    expect(() => decodeCbor(h("9f01ff"))).toThrow(/indefinite-length array/);
    expect(() => decodeCbor(h("a201020102"))).toThrow(/duplicate map key/);
  });

  it("M4D §2: tag ⇒ throw (incl. COSE_Sign1 tag 18); floats / true / false / undefined ⇒ throw", () => {
    expect(() => decodeCbor(h("d28440a04040"))).toThrow(/tag/);
    expect(() => decodeCbor(h("c11a514b67b0"))).toThrow(/tag/);
    for (const bad of ["f4", "f5", "f7", "f93c00", "fa47c35000", "fb3ff199999999999a", "ff"]) expect(() => decodeCbor(h(bad)), bad).toThrow(CborError);
  });

  it("M4D §2: trailing bytes ⇒ throw; truncated ⇒ throw", () => {
    expect(() => decodeCbor(h("0000"))).toThrow(/trailing/);
    expect(() => decodeCbor(h("83010203 04"))).toThrow(/trailing/);
    expect(() => decodeCbor(h("44010203"))).toThrow(/truncated/);
    expect(() => decodeCbor(h("830102"))).toThrow(/truncated/);
    expect(() => decodeCbor(h("bf6161"))).toThrow(/truncated/);
    expect(() => decodeCbor(new Uint8Array(0))).toThrow(/truncated/);
  });

  it("M4D §2: Sig_structure encoder — golden bytes, derived by hand from RFC 8949 preferred serialization", () => {
    // ["Signature1", h'a1013822', h'', h'010203']:
    //   84                      array(4)                         major 4 (0b100_00000=0x80) | 4
    //   6a 5369676e617475726531 tstr(10) "Signature1"            major 3 (0x60) | 10
    //   44 a1013822             bstr(4) = {1: -35} (the NSM protected header)  major 2 (0x40) | 4
    //   40                      bstr(0)  external_aad = h''
    //   43 010203               bstr(3)  payload
    const got = encodeSigStructure1(h("a1013822"), new Uint8Array(0), h("010203"));
    expect(hx(got)).toBe("846a5369676e61747572653144a101382240" + "43010203");
    // Round-trips through the decoder.
    expect(decodeCbor(got)).toEqual(["Signature1", h("a1013822"), new Uint8Array(0), h("010203")]);
    // Length heads at every argument-width boundary (payload head starts at offset 1+11+5+1 = 18):
    //   23 ⇒ 0x57; 24 ⇒ 0x58 18; 255 ⇒ 0x58 ff; 256 ⇒ 0x59 0100; 4444 (agent-8's payload) ⇒ 0x59 115c;
    //   65536 ⇒ 0x5a 00010000 (a 4-byte argument; never the 8-byte form below 2^32).
    const cases: Array<[number, string]> = [
      [23, "57"],
      [24, "5818"],
      [255, "58ff"],
      [256, "590100"],
      [4444, "59115c"],
      [65535, "59ffff"],
      [65536, "5a00010000"],
    ];
    for (const [n, head] of cases) {
      const e = encodeSigStructure1(h("a1013822"), new Uint8Array(0), new Uint8Array(n));
      expect([n, hx(e.subarray(18, 18 + head.length / 2))]).toEqual([n, head]);
      expect(e.length).toBe(18 + head.length / 2 + n);
    }
    // A non-empty external_aad uses the same bstr head.
    expect(hx(encodeSigStructure1(new Uint8Array(0), h("ff"), new Uint8Array(0)))).toBe("846a5369676e6174757265314041ff40");
  });
});

// ---------------------------------------------------------------------------
// quote.ts — against the live golden quotes
// ---------------------------------------------------------------------------

describe("M4D §2: quote", () => {
  it("M4D §2: agent-8 live quote ⇒ trueImageId == oracle f489dc60…3a4350 (== its registered codeHash), rootKeyOk", async () => {
    const r = await verifyQuote(quoteOf(8));
    expect(r).toEqual({ trueImageId: ORACLE8, timestampMs: 1790665491169, moduleId: "i-09cb181a285c48de2-enc01a0ebfa4bd3d9ac", rootKeyOk: true });
  });

  it("M4D §2: agent-10 live quote ⇒ trueImageId == oracle 0558ac28…9cc4a (≠ its self-reported imageId), rootKeyOk", async () => {
    const r = await verifyQuote(quoteOf(10));
    expect(r).toEqual({ trueImageId: ORACLE10, timestampMs: 1790673375106, moduleId: "i-0f5ab96943b81ec28-enc01a0ec72918bd708", rootKeyOk: true });
    expect(String(report(10).imageId)).toBe(`0x${ORACLE8}`); // the misreport
  });

  it("M4D §2: tampered byte in the signature ⇒ fail", async () => {
    const q = quoteOf(8);
    q[q.length - 1]! ^= 0x01; // the last 96 bytes are the r‖s signature
    expect(await reason(verifyQuote(q))).toBe("COSE_Sign1 signature invalid");
    const p = quoteOf(8);
    p[200]! ^= 0x01; // a byte inside the signed payload (still valid CBOR: inside the module_id/digest region)
    expect(await reason(verifyQuote(p))).toMatch(/signature invalid|CBOR|payload|PCR/);
  });

  it("M4D §2: truncated ⇒ fail", async () => {
    const q = quoteOf(8);
    for (const n of [0, 1, 100, q.length - 1]) expect(await reason(verifyQuote(q.subarray(0, n)))).toMatch(/truncated/);
    expect(await reason(verifyQuote(Uint8Array.of(...q, 0x00)))).toMatch(/trailing/);
  });

  it("M4D §2: alg != -35 ⇒ fail", async () => {
    const q = quoteOf(8);
    expect(hx(q.subarray(0, 6))).toBe("8444a1013822"); // array(4), bstr(4) {1: -35}
    q[5] = 0x23; // {1: -36}
    expect(await reason(verifyQuote(q))).toBe("COSE alg -36 ≠ ES384 (-35)");
    q[4] = 0x26; // a1 01 26 23 = {1: -7 (ES256)} + a stray byte ⇒ protected header has trailing bytes
    expect(await reason(verifyQuote(q))).toMatch(/trailing/);
  });

  it("M4D §2: root key swapped expectation ⇒ fail", async () => {
    const other = Uint8Array.from(AWS_ROOT_KEY);
    other[0]! ^= 0xff;
    expect(await reason(verifyQuote(quoteOf(8), { rootKey: other }))).toBe(`root key ${AWS_ROOT_KEY_HEX} ≠ pinned AWS Nitro root`);
    expect(AWS_ROOT_KEY.length).toBe(96);
  });

  it("M4D §2: cert validity checked at the DOC timestamp — the historical fixture passes regardless of wall clock; outside the leaf window ⇒ fail", async () => {
    // Wall clock far past the ~3 h Nitro leaf lifetime: verification does not consult it (R4).
    vi.useFakeTimers({ now: new Date("2031-01-01T00:00:00Z"), toFake: ["Date"] });
    expect((await verifyQuote(quoteOf(8))).trueImageId).toBe(ORACLE8);
    vi.useRealTimers();
    // The chain walk itself, at shifted timestamps.
    const payload = decodeCbor((decodeCbor(quoteOf(8)) as Uint8Array[])[2]!) as Map<string, unknown>;
    const leaf = payload.get("certificate") as Uint8Array;
    const bundle = payload.get("cabundle") as Uint8Array[];
    const ts = payload.get("timestamp") as number;
    expect(hx(verifyCertChain(leaf, bundle, ts))).toBe(AWS_ROOT_KEY_HEX);
    expect(() => verifyCertChain(leaf, bundle, ts + 86_400_000)).toThrow(/certificate 0 not valid at doc timestamp/);
    expect(() => verifyCertChain(leaf, bundle, ts - 86_400_000)).toThrow(/certificate 0 not valid at doc timestamp/);
    // Chain order / linkage: a bundle missing its intermediate breaks the signature/issuer walk.
    expect(() => verifyCertChain(leaf, bundle.slice(0, -1), ts)).toThrow(/chain: certificate 0/);
    expect(() => verifyCertChain(leaf, [], ts)).toThrow(/cabundle is empty/);
  });

  it("M4D §2: SPKI raw slice asserts the exact 24-byte uncompressed-P-384 prefix (throws on any other key)", () => {
    const k384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey;
    const jwk = k384.export({ format: "jwk" });
    const raw = rawP384(k384);
    expect(raw.length).toBe(96);
    expect(hx(raw)).toBe(Buffer.from(String(jwk.x), "base64url").toString("hex") + Buffer.from(String(jwk.y), "base64url").toString("hex"));
    expect(() => rawP384(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey)).toThrow(/not an uncompressed P-384 SPKI/);
    expect(() => rawP384(generateKeyPairSync("ed25519").publicKey)).toThrow(/not an uncompressed P-384 SPKI/);
  });

  it("M4D §2: image-id = SHA256(be32(0x00010007) ‖ PCR0 ‖ PCR1 ‖ PCR2 ‖ PCR16); PCR16 absent ⇒ zeros; PCR0-2 required 48 bytes", () => {
    const p = (b: number): Uint8Array => new Uint8Array(48).fill(b);
    const withZero16 = imageIdFromPcrs(new Map([[0, p(1)], [1, p(2)], [2, p(3)], [16, p(0)]]));
    expect(imageIdFromPcrs(new Map([[0, p(1)], [1, p(2)], [2, p(3)]]))).toBe(withZero16);
    expect(imageIdFromPcrs(new Map([[0, p(1)], [1, p(2)], [2, p(3)], [3, p(9)], [16, p(0)]]))).toBe(withZero16); // other PCRs ignored
    expect(() => imageIdFromPcrs(new Map([[0, p(1)], [2, p(3)]]))).toThrow(/PCR1 missing/);
    expect(() => imageIdFromPcrs(new Map([[0, p(1)], [1, new Uint8Array(32)], [2, p(3)]]))).toThrow(/PCR1 is 32 bytes/);
  });
});
