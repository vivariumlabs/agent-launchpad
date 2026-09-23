// Signed GET /attestation responses (M3 s2 close; closes the MITM gap found by Job L).
// keyring.attestationSigner(): treasury key, EIP-191 over keccak256("launchpad-attestation-v1" ‖ payload),
// no key material; signAttestationResponse / verifyAttestationResponse; chat harness end-to-end over a socket.

import { concat, hashMessage, keccak256, recoverAddress, recoverMessageAddress, stringToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { attestationPayloadBytes, signAttestationResponse, verifyAttestationResponse, type AttestationResponsePayloadInput } from "../../src/attestation/attestation.js";
import { ATTESTATION_SIG_DOMAIN, attestationDigest, createKeyring, TURBO_SIGN_LENGTHS } from "../../src/keyring/keyring.js";
import { MockKms } from "../../src/keyring/mockKms.js";
import { NOW } from "../policy/helpers.js";
import { makeChatHarness } from "../chat/harness.js";

const kms = new MockKms("image-att", "agent-att");
const SPKI = `0x${"ab".repeat(32)}` as Hex;
const INPUT: AttestationResponsePayloadInput = {
  report: '{"kind":"agent-launchpad.attestation-report","version":1}',
  attestationRef: "Xq3kT0dS0mW4d2A6Qp2a8XJ0cP1nVh9k3uUu6rJ2x0Y",
  certSpkiSha256: SPKI,
  certKind: "issued",
  domain: "a1.agents.example.test",
  timestamp: NOW,
};

async function setup() {
  const kr = await createKeyring(kms, { retry: { attempts: 1, delayMs: 1 } });
  const all = await Promise.all(["treasury", "action", "fc", "mem", "chat", "acme", "tls"].map((p) => kms.derive(p)));
  return { kr, signer: kr.attestationSigner(), treasury: kr.addresses().treasury, all };
}

describe("keyring.attestationSigner()", () => {
  it("signs EIP-191 over keccak256(utf8(domain) ‖ payload) with the TREASURY key", async () => {
    const { signer, treasury, all } = await setup();
    expect(signer.address).toBe(treasury);
    const payload = stringToBytes('{"a":1}');
    const sig = await signer.sign(payload);
    const digest = keccak256(concat([stringToBytes("launchpad-attestation-v1"), payload]));
    expect(ATTESTATION_SIG_DOMAIN).toBe("launchpad-attestation-v1");
    expect(attestationDigest(payload)).toBe(digest);
    expect(await recoverMessageAddress({ message: { raw: digest }, signature: sig })).toBe(treasury);
    expect(await recoverAddress({ hash: hashMessage({ raw: digest }), signature: sig })).toBe(treasury);
    // byte-identical to what a plain viem account produces for the same digest (deterministic RFC 6979)
    expect(sig).toBe(await privateKeyToAccount(all[0]!).signMessage({ message: { raw: digest } }));
    // NOT a signature over the raw payload (the domain prefix is applied inside)
    expect(await recoverMessageAddress({ message: { raw: payload }, signature: sig })).not.toBe(treasury);
  });

  it("refuses empty / non-bytes payloads", async () => {
    const { signer } = await setup();
    await expect(signer.sign(new Uint8Array(0))).rejects.toThrow(/non-empty/);
    await expect(signer.sign("0x1234" as unknown as Uint8Array)).rejects.toThrow(/non-empty/);
  });

  it("the signer object holds NO key material (frozen; only address + sign; walk of the whole graph)", async () => {
    const { signer, all } = await setup();
    expect(Object.keys(signer).sort()).toEqual(["address", "sign"]);
    expect(Object.getOwnPropertyNames(signer).sort()).toEqual(["address", "sign"]);
    expect(Object.isFrozen(signer)).toBe(true);
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
    hay.push(JSON.stringify(signer).toLowerCase());
    expect(hay.length).toBeGreaterThan(1);
    for (const h of hay) for (const n of needles) expect(h.includes(n)).toBe(false);
  });

  it("cannot collide with turboSigner: turbo signs ONLY 48-byte messages, attestation digests are 32 bytes", async () => {
    const { kr } = await setup();
    expect(TURBO_SIGN_LENGTHS).toEqual([48]);
    const digest = attestationDigest(stringToBytes("forged"));
    await expect(kr.turboSigner().sign(stringToBytes(digest.slice(2)).subarray(0, 32))).rejects.toThrow(/refusing/);
    await expect(kr.turboSigner().sign(Buffer.from(digest.slice(2), "hex"))).rejects.toThrow(/refusing/);
  });
});

describe("signAttestationResponse / verifyAttestationResponse", () => {
  it("round-trip: payload is canonical (timestamp decimal string), signature recovers to the treasury", async () => {
    const { signer, treasury } = await setup();
    const r = await signAttestationResponse(signer, INPUT);
    expect(r.signer).toBe(treasury);
    expect(r.payload).toEqual({ ...INPUT, timestamp: NOW.toString(10) });
    expect(Object.keys(r.payload)).toEqual(["attestationRef", "certKind", "certSpkiSha256", "domain", "report", "timestamp"]);
    expect(await recoverMessageAddress({ message: { raw: attestationDigest(attestationPayloadBytes(r.payload)) }, signature: r.signature })).toBe(treasury);
    // survives a JSON round-trip (what a real client sees)
    const wire = JSON.parse(JSON.stringify(r)) as unknown;
    expect(await verifyAttestationResponse(wire, { expectedTreasury: treasury, observedSpkiSha256: SPKI, now: NOW + 10n })).toEqual({ ok: true, payload: r.payload });
  });

  it("any tampered payload field / signer swap / wrong expected treasury ⇒ rejected", async () => {
    const { signer, treasury } = await setup();
    const r = JSON.parse(JSON.stringify(await signAttestationResponse(signer, INPUT))) as { payload: Record<string, unknown>; signer: string; signature: Hex };
    const ok = { expectedTreasury: treasury };
    for (const [k, v] of Object.entries({
      report: '{"kind":"evil"}',
      certSpkiSha256: `0x${"cd".repeat(32)}`,
      attestationRef: "evil-ref",
      domain: "evil.example",
      certKind: "placeholder",
      timestamp: (NOW + 1n).toString(10),
    })) {
      const t = { ...r, payload: { ...r.payload, [k]: v } };
      expect((await verifyAttestationResponse(t, ok)).ok, k).toBe(false);
    }
    expect((await verifyAttestationResponse({ ...r, payload: { ...r.payload, extra: 1 } }, ok)).ok).toBe(false);
    // a MITM re-signing with its own key and advertising itself as signer: the on-chain treasury check fails
    const mitm = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const forged = { payload: { ...r.payload, certSpkiSha256: `0x${"ee".repeat(32)}` }, signer: mitm.address, signature: await mitm.signMessage({ message: { raw: attestationDigest(attestationPayloadBytes({ ...r.payload, certSpkiSha256: `0x${"ee".repeat(32)}` })) } }) };
    expect(await verifyAttestationResponse(forged, ok)).toEqual({ ok: false, reason: "wrong_signer" });
    expect(await verifyAttestationResponse(r, { expectedTreasury: mitm.address })).toEqual({ ok: false, reason: "wrong_signer" });
    // flipped signature byte / malformed
    const flipped = `${r.signature.slice(0, 10)}${r.signature[10] === "0" ? "1" : "0"}${r.signature.slice(11)}` as Hex;
    expect((await verifyAttestationResponse({ ...r, signature: flipped }, ok)).ok).toBe(false);
    for (const bad of [null, 1, "x", {}, { payload: r.payload }, { payload: [], signature: r.signature }, { payload: r.payload, signature: "0x12" }]) {
      expect(await verifyAttestationResponse(bad, ok)).toEqual({ ok: false, reason: "shape" });
    }
  });

  it("SPKI pinning and freshness", async () => {
    const { signer, treasury } = await setup();
    const r = await signAttestationResponse(signer, INPUT);
    expect(await verifyAttestationResponse(r, { expectedTreasury: treasury, observedSpkiSha256: `0x${"cd".repeat(32)}` })).toEqual({ ok: false, reason: "spki_mismatch" });
    expect(await verifyAttestationResponse(r, { expectedTreasury: treasury, observedSpkiSha256: SPKI.toUpperCase().replace("0X", "0x") as Hex })).toMatchObject({ ok: true });
    expect(await verifyAttestationResponse(r, { expectedTreasury: treasury, now: NOW + 301n })).toEqual({ ok: false, reason: "stale" });
    expect(await verifyAttestationResponse(r, { expectedTreasury: treasury, now: NOW - 301n })).toEqual({ ok: false, reason: "stale" });
    expect(await verifyAttestationResponse(r, { expectedTreasury: treasury, now: NOW + 3000n, maxAgeSec: 3600n })).toMatchObject({ ok: true });
  });
});

describe("chat server GET /attestation end-to-end (real socket)", () => {
  it("fetch → { payload, signer, signature } verifies against the harness treasury; tampering in transit is detected", async () => {
    const h = await makeChatHarness({
      attestation: async () => ({ report: INPUT.report, attestationRef: INPUT.attestationRef, certSpkiSha256: SPKI, certKind: "issued", domain: INPUT.domain }),
    });
    const { host, port } = await h.server.listen({ port: 0 });
    try {
      const res = await fetch(`http://${host}:${port}/attestation`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { payload: Record<string, unknown>; signer: string; signature: Hex };
      expect(Object.keys(body).sort()).toEqual(["payload", "signature", "signer"]);
      expect(body.signer).toBe(h.kr.addresses().treasury);
      expect(body.payload["timestamp"]).toBe(h.now().toString(10));
      expect(await verifyAttestationResponse(body, { expectedTreasury: h.kr.addresses().treasury, observedSpkiSha256: SPKI, now: h.now() })).toEqual({ ok: true, payload: body.payload });
      // a proxy swapping in its own cert pin breaks the signature
      const proxied = { ...body, payload: { ...body.payload, certSpkiSha256: `0x${"99".repeat(32)}` } };
      expect(await verifyAttestationResponse(proxied, { expectedTreasury: h.kr.addresses().treasury, observedSpkiSha256: `0x${"99".repeat(32)}` })).toEqual({ ok: false, reason: "wrong_signer" });
    } finally {
      await h.server.close();
    }
  });
});
