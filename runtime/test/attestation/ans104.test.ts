// In-house ANS-104 (src/attestation/ans104.ts) — self-consistency + MANDATORY cross-verification
// against @dha-team/arbundles (DEV dependency only; repro-lint asserts it never reaches the image):
//   (a) our signed data item passes arbundles' DataItem.verify();
//   (b) our data-item id (and bytes) equal arbundles' for identical inputs and the same treasury key;
// across: no tags / several tags / empty data / multi-KB data (+ unicode tags, target + anchor).

import { createData, DataItem, EthereumSigner, deserializeTags as arbDeserializeTags, serializeTags as arbSerializeTags } from "@dha-team/arbundles";
import { createHash } from "node:crypto";
import { bytesToHex, recoverMessageAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  arweaveOwnerAddress,
  createSignedDataItem,
  dataItemId,
  deepHash,
  deserializeTags,
  MAX_TAGS,
  ownerAddress,
  parseDataItem,
  serializeTags,
  signatureData,
  verifyDataItem,
  type Ans104Tag,
} from "../../src/attestation/ans104.js";
import { turboTags } from "../../src/attestation/turbo.js";
import { createKeyring } from "../../src/keyring/keyring.js";
import { MockKms } from "../../src/keyring/mockKms.js";

const kms = new MockKms("image-ans104", "agent-ans104");

async function setup() {
  const kr = await createKeyring(kms, { retry: { attempts: 1, delayMs: 1 } });
  const treasuryKey = await kms.derive("treasury");
  return { signer: kr.turboSigner(), treasury: kr.addresses().treasury, arbSigner: new EthereumSigner(treasuryKey) };
}

function multiKb(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 131 + 7) & 0xff;
  return b;
}

const CASES: Array<{ name: string; data: Uint8Array; tags: Ans104Tag[]; anchor?: string; target?: Uint8Array }> = [
  { name: "no tags", data: new TextEncoder().encode("hello arweave"), tags: [] },
  { name: "several tags (the sink's attestation tag set)", data: new TextEncoder().encode('{"kind":"agent-launchpad.attestation-report"}'), tags: turboTags("attestation", 42, 1_790_000_000n) },
  { name: "empty data, with tags", data: new Uint8Array(0), tags: [{ name: "App", value: "agent-launchpad" }] },
  { name: "empty data, no tags", data: new Uint8Array(0), tags: [] },
  { name: "multi-KB data (40 KiB) + tags", data: multiKb(40 * 1024), tags: turboTags("snapshot", 7, 1n) },
  { name: "multi-KB data (5 KiB), no tags", data: multiKb(5 * 1024), tags: [] },
  {
    name: "unicode + long (>64 byte) tag values, varint lengths ≥ 128",
    data: multiKb(300),
    tags: [
      { name: "Content-Type", value: "application/json" },
      { name: "Ünïcødé-✓", value: "€".repeat(40) },
      { name: "Long", value: "x".repeat(200) },
      { name: "Emoji", value: "🦀🦀" },
    ],
  },
  { name: "anchor + target present", data: new TextEncoder().encode("anchored"), tags: [{ name: "a", value: "b" }], anchor: "0123456789abcdef0123456789abcdef", target: multiKb(32) },
];

describe("ANS-104 cross-verification vs @dha-team/arbundles", () => {
  for (const c of CASES) {
    it(`${c.name}: (a) arbundles verify() accepts OUR item; (b) our id + bytes == arbundles' for the same key/inputs`, async () => {
      const { signer, treasury, arbSigner } = await setup();
      const opts = {
        ...(c.anchor !== undefined ? { anchor: new TextEncoder().encode(c.anchor) } : {}),
        ...(c.target !== undefined ? { target: c.target } : {}),
      };
      const ours = await createSignedDataItem(c.data, c.tags, signer, opts);

      // (a) arbundles verifies our bytes, and parses our fields identically
      expect(await DataItem.verify(Buffer.from(ours.bytes))).toBe(true);
      const theirView = new DataItem(Buffer.from(ours.bytes));
      expect(theirView.id).toBe(ours.id);
      expect(theirView.signatureType).toBe(3);
      expect(theirView.tags).toEqual(c.tags);
      expect(new Uint8Array(theirView.rawData)).toEqual(c.data);
      expect(new Uint8Array(theirView.rawOwner)).toEqual(signer.publicKey);

      // (b) arbundles builds + signs the same item with the same (treasury) key ⇒ identical id and bytes
      const arbOpts = {
        ...(c.tags.length > 0 ? { tags: c.tags } : {}),
        ...(c.anchor !== undefined ? { anchor: c.anchor } : {}),
        ...(c.target !== undefined ? { target: Buffer.from(c.target).toString("base64url") } : {}),
      };
      const theirs = createData(Buffer.from(c.data), arbSigner, arbOpts);
      await theirs.sign(arbSigner);
      expect(await theirs.isValid()).toBe(true);
      expect(ours.id).toBe(theirs.id);
      expect(Buffer.from(ours.bytes).equals(theirs.getRaw())).toBe(true);
      expect(Buffer.from(signatureData(parseDataItem(ours.bytes))).equals(Buffer.from(await theirs.getSignatureData()))).toBe(true);

      // and our verifier accepts theirs; owner = the treasury EOA
      expect(await verifyDataItem(new Uint8Array(theirs.getRaw()))).toBe(true);
      expect(ownerAddress(parseDataItem(ours.bytes).owner)).toBe(treasury);
    });
  }

  it("tag encoding is byte-identical to arbundles' serializeTags (incl. empty ⇒ zero bytes) and round-trips both ways", () => {
    for (const c of CASES) {
      const ours = serializeTags(c.tags);
      expect(Buffer.from(ours).equals(arbSerializeTags(c.tags)), c.name).toBe(true);
      if (c.tags.length > 0) expect(arbDeserializeTags(Buffer.from(ours))).toEqual(c.tags);
      expect(deserializeTags(ours)).toEqual(c.tags);
    }
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `n${i}`, value: `v${i}` })); // count varint > 63 (2 bytes)
    expect(Buffer.from(serializeTags(many)).equals(arbSerializeTags(many))).toBe(true);
  });
});

describe("ANS-104 self-consistency", () => {
  it("layout: type 3 LE, 65-byte sig + owner, presence bytes, u64 LE counts; id = base64url(sha256(sig)); signature = EIP-191 over the 48-byte deep hash", async () => {
    const { signer, treasury } = await setup();
    const data = new TextEncoder().encode("layout");
    const tags = [{ name: "k", value: "v" }];
    const it1 = await createSignedDataItem(data, tags, signer);
    const b = it1.bytes;
    expect([b[0], b[1]]).toEqual([3, 0]);
    const p = parseDataItem(b);
    expect(p.owner).toEqual(signer.publicKey);
    expect([b[132], b[133]]).toEqual([0, 0]); // no target, no anchor
    expect(Buffer.from(b.subarray(134, 142)).readBigUInt64LE()).toBe(1n);
    expect(Buffer.from(b.subarray(142, 150)).readBigUInt64LE()).toBe(BigInt(p.rawTags.length));
    expect(p.data).toEqual(data);
    expect(it1.id).toBe(createHash("sha256").update(p.signature).digest("base64url"));
    expect(dataItemId(p.signature)).toBe(it1.id);
    expect(it1.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const msg = signatureData(p);
    expect(msg).toHaveLength(48);
    expect(await recoverMessageAddress({ message: { raw: msg }, signature: bytesToHex(p.signature) })).toBe(treasury);
    expect(arweaveOwnerAddress(p.owner)).toBe(createHash("sha256").update(p.owner).digest("base64url"));
  });

  it("deterministic: same inputs ⇒ same id (RFC 6979); any change in data/tags ⇒ different id", async () => {
    const { signer } = await setup();
    const d = new TextEncoder().encode("x");
    const a = await createSignedDataItem(d, [{ name: "a", value: "1" }], signer);
    expect((await createSignedDataItem(d, [{ name: "a", value: "1" }], signer)).id).toBe(a.id);
    expect((await createSignedDataItem(d, [{ name: "a", value: "2" }], signer)).id).not.toBe(a.id);
    expect((await createSignedDataItem(new TextEncoder().encode("y"), [{ name: "a", value: "1" }], signer)).id).not.toBe(a.id);
  });

  it("tampering with any region breaks verification (ours and arbundles')", async () => {
    const { signer } = await setup();
    const { bytes } = await createSignedDataItem(multiKb(512), [{ name: "a", value: "b" }], signer);
    for (const off of [5, 70, 140, 152, bytes.length - 1]) {
      const t = new Uint8Array(bytes);
      t[off] = t[off]! ^ 0x01;
      expect(await verifyDataItem(t), `offset ${off}`).toBe(false);
      expect(await DataItem.verify(Buffer.from(t)).catch(() => false), `arbundles offset ${off}`).toBe(false);
    }
    expect(await verifyDataItem(bytes.subarray(0, 100))).toBe(false);
  });

  it("deepHash matches the reference definition for blobs and nested lists", () => {
    const H = (...p: Uint8Array[]) => {
      const h = createHash("sha384");
      for (const x of p) h.update(x);
      return new Uint8Array(h.digest());
    };
    const e = new TextEncoder();
    const blob = e.encode("abc");
    const blobHash = H(H(e.encode("blob3")), H(blob));
    expect(deepHash(blob)).toEqual(blobHash);
    const list = H(H(e.encode("list1")), blobHash);
    expect(deepHash([blob])).toEqual(list);
    expect(deepHash([])).toEqual(H(e.encode("list0")));
  });

  it("tag limits (ANS-104 §2): ≤128 tags, non-empty name/value, name ≤1024 B, value ≤3072 B, total ≤4096 B", () => {
    expect(() => serializeTags(Array.from({ length: MAX_TAGS + 1 }, () => ({ name: "a", value: "b" })))).toThrow(/tags/);
    expect(() => serializeTags([{ name: "", value: "b" }])).toThrow(/empty/);
    expect(() => serializeTags([{ name: "a", value: "" }])).toThrow(/empty/);
    expect(() => serializeTags([{ name: "a".repeat(1025), value: "b" }])).toThrow(/name/);
    expect(() => serializeTags([{ name: "a", value: "b".repeat(3073) }])).toThrow(/value/);
    expect(() => serializeTags([{ name: "a", value: "b".repeat(3000) }, { name: "c", value: "d".repeat(1500) }])).toThrow(/tag bytes/);
  });

  it("the signer is only ever asked to sign 48-byte deep hashes (turboSigner's allowlist)", async () => {
    const { signer } = await setup();
    const seen: number[] = [];
    const spy = { ...signer, sign: async (m: Uint8Array) => (seen.push(m.length), signer.sign(m)) };
    await createSignedDataItem(multiKb(10_000), turboTags("snapshot", 1, 1n), spy);
    await createSignedDataItem(new Uint8Array(0), [], spy);
    expect(seen).toEqual([48, 48]);
  });

  it("rejects bad options / non-Ethereum signers / malformed items", async () => {
    const { signer } = await setup();
    await expect(createSignedDataItem(new Uint8Array(1), [], signer, { anchor: new Uint8Array(31) })).rejects.toThrow(/anchor/);
    await expect(createSignedDataItem(new Uint8Array(1), [], signer, { target: new Uint8Array(33) })).rejects.toThrow(/target/);
    await expect(createSignedDataItem(new Uint8Array(1), [], { ...signer, signatureType: 1 as 3 })).rejects.toThrow(/Ethereum/);
    await expect(createSignedDataItem(new Uint8Array(1), [], { ...signer, sign: async () => new Uint8Array(64) })).rejects.toThrow(/malformed/);
    const { bytes } = await createSignedDataItem(new Uint8Array(1), [], signer);
    const t = new Uint8Array(bytes);
    t[0] = 1;
    expect(() => parseDataItem(t)).toThrow(/signature type/);
  });
});
