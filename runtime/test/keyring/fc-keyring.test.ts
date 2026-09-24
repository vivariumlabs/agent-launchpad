// SPEC-M3D §3b (K4 signs blake3-20) + §3d (signFcKeyRequest: narrow EIP-712 SignedKeyRequest by the treasury).

import * as ed from "@noble/ed25519";
import { SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_TYPES } from "@farcaster/core";
import {
  concat,
  encodeAbiParameters,
  hashTypedData,
  hexToBytes,
  keccak256,
  recoverAddress,
  stringToBytes,
  toHex,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../src/config/schema.js";
import { signedKeyRequestTypes } from "../../src/exec/abi.js";
import { createKeyring, type Keyring } from "../../src/keyring/keyring.js";
import { MockKms } from "../../src/keyring/mockKms.js";
import { issueApproval } from "../../src/policy/approval.js";
import type { ProposedAction } from "../../src/policy/types.js";
import { buildCastAddData, buildUserDataAdd, fcMessageHash, FC_USER_DATA_DISPLAY } from "../../src/social/fcMessage.js";
import { NOW, agentJson, platformJson } from "../policy/helpers.js";

const LIVE_VALIDATOR = "0x00000000FC700472606ED4fA22623Acf62c60553" as const;
const FID = 3_352_486n;

async function setup(opts: { farcaster?: boolean; validator?: Hex } = {}): Promise<{ kr: Keyring; c: ResolvedConfig }> {
  const kr = await createKeyring(new MockKms("image-fc", "agent-fc"), { retry: { attempts: 2, delayMs: 1 } });
  const p = platformJson() as Record<string, unknown> & { farcaster: Record<string, unknown> };
  if (opts.farcaster === false) delete (p as Record<string, unknown>).farcaster;
  else if (opts.validator !== undefined) p.farcaster = { ...p.farcaster, validator: opts.validator };
  const c = resolveConfig({ platform: p, agent: agentJson, ownAddresses: kr.addresses() });
  kr.attachConfig(c);
  return { kr, c };
}

describe("M3D: K4 signs the Farcaster hash blake3_20(messageBytes) (SPEC-M3D §3b)", () => {
  const data = buildCastAddData("gm from the enclave", FID, NOW);
  const POST: ProposedAction = { kind: "castPost", contentHash: keccak256(data) };

  it("M3D: castPost signature is a 64-byte ed25519 sig over blake3-20(MessageData), verified with noble against the fc pubkey", async () => {
    const { kr } = await setup();
    const sig = await kr.signCastApproved(POST, issueApproval(POST, NOW), data, NOW);
    expect(sig).toMatch(/^0x[0-9a-f]{128}$/);
    const pub = hexToBytes(kr.farcasterPublicKey());
    expect(await ed.verifyAsync(hexToBytes(sig), fcMessageHash(data), pub)).toBe(true);
    expect(await ed.verifyAsync(hexToBytes(sig), data, pub)).toBe(false); // NOT the raw bytes any more
    expect(kr.addresses().fcPublicKey).toBe(kr.farcasterPublicKey());
  });

  it("M3D: fcUserData (DISPLAY UserDataAdd) and castReply go through the same K4 path", async () => {
    const { kr } = await setup();
    const ud = buildUserDataAdd(FC_USER_DATA_DISPLAY, "Test Agent", FID, NOW);
    const UD: ProposedAction = { kind: "fcUserData", contentHash: keccak256(ud), sizeBytes: BigInt(ud.length) };
    const s1 = await kr.signCastApproved(UD, issueApproval(UD, NOW), ud, NOW);
    expect(await ed.verifyAsync(hexToBytes(s1), fcMessageHash(ud), hexToBytes(kr.farcasterPublicKey()))).toBe(true);
    const raw = stringToBytes("reply text");
    const R: ProposedAction = { kind: "castReply", contentHash: keccak256(raw), parentHash: `0x${"22".repeat(32)}` };
    const s2 = await kr.signCastApproved(R, issueApproval(R, NOW), raw, NOW);
    expect(await ed.verifyAsync(hexToBytes(s2), fcMessageHash(raw), hexToBytes(kr.farcasterPublicKey()))).toBe(true);
  });

  it("M3D: K4 gate regressions — approval required (hash / TTL / single-use), keccak(messageBytes) == contentHash, fc kinds only", async () => {
    const { kr } = await setup();
    const other: ProposedAction = { kind: "castPost", contentHash: keccak256(stringToBytes("other")) };
    await expect(kr.signCastApproved(POST, issueApproval(other, NOW), data, NOW)).rejects.toThrow("approval mismatch");
    await expect(kr.signCastApproved(POST, issueApproval(POST, NOW), data, NOW + 61n)).rejects.toThrow("approval expired");
    const ap = issueApproval(POST, NOW);
    await kr.signCastApproved(POST, ap, data, NOW);
    await expect(kr.signCastApproved(POST, ap, data, NOW)).rejects.toThrow("approval already used");
    await expect(kr.signCastApproved(POST, issueApproval(POST, NOW + 1n), buildCastAddData("gm from the enclave!", FID, NOW), NOW + 1n)).rejects.toThrow("contentHash");
    const J: ProposedAction = { kind: "journalWrite", contentHash: keccak256(data), sizeBytes: BigInt(data.length) };
    await expect(kr.signCastApproved(J, issueApproval(J, NOW), data, NOW)).rejects.toThrow(/not a cast/);
    const REG: ProposedAction = { kind: "fcRegister", priceWei: 1n };
    await expect(kr.signCastApproved(REG, issueApproval(REG, NOW), data, NOW)).rejects.toThrow(/not a cast/);
  });

  it("M3D: attachConfig refuses a config whose fcPublicKey is not the keyring's", async () => {
    const kr = await createKeyring(new MockKms("image-fc", "agent-fc"), { retry: { attempts: 2, delayMs: 1 } });
    const c = resolveConfig({ platform: platformJson(), agent: agentJson, ownAddresses: { ...kr.addresses(), fcPublicKey: `0x${"01".repeat(32)}` } });
    expect(() => kr.attachConfig(c)).toThrow(/fcPublicKey/);
  });
});

describe("M3D: signFcKeyRequest (SPEC-M3D §3d)", () => {
  const DEADLINE = NOW + 3600n;

  /** EIP-712 digest recomputed by hand (typehash / structHash / domain separator), independent of viem's typed-data code. */
  function manualDigest(requestFid: bigint, key: Hex, deadline: bigint, validator: Hex): Hex {
    const typeHash = keccak256(stringToBytes("SignedKeyRequest(uint256 requestFid,bytes key,uint256 deadline)"));
    const structHash = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }], [typeHash, requestFid, keccak256(key), deadline]));
    const domainType = keccak256(stringToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
    const ds = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [domainType, keccak256(stringToBytes("Farcaster SignedKeyRequestValidator")), keccak256(stringToBytes("1")), 10n, validator],
      ),
    );
    return keccak256(concat(["0x1901", ds, structHash]));
  }

  it("M3D: EIP-712 digest golden (viem hashTypedData == hand-rolled) and the signature recovers to the TREASURY", async () => {
    const { kr } = await setup({ validator: LIVE_VALIDATOR });
    const key = kr.farcasterPublicKey();
    const viemDigest = hashTypedData({
      domain: { name: "Farcaster SignedKeyRequestValidator", version: "1", chainId: 10, verifyingContract: LIVE_VALIDATOR },
      types: { SignedKeyRequest: [{ name: "requestFid", type: "uint256" }, { name: "key", type: "bytes" }, { name: "deadline", type: "uint256" }] },
      primaryType: "SignedKeyRequest",
      message: { requestFid: FID, key, deadline: DEADLINE },
    });
    expect(viemDigest).toBe(manualDigest(FID, key, DEADLINE, LIVE_VALIDATOR));
    // fixed-input golden (key = 0xfc…fc, deadline = NOW + 1h) — pins the domain/type strings
    expect(manualDigest(FID, `0x${"fc".repeat(32)}`, 1_790_154_000n, LIVE_VALIDATOR)).toBe("0x07b8a70ed03da85735b1b398f069ae4d5ef170102e721181a08dab600de10574");
    const sig = await kr.signFcKeyRequest(FID, key, DEADLINE);
    expect(await recoverAddress({ hash: viemDigest, signature: sig })).toBe(kr.addresses().treasury);
    // our type table equals the reference one
    expect(signedKeyRequestTypes).toEqual(SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_TYPES.types);
  });

  it("M3D: refuses every foreign key (incl. case variants of other keys) — narrow like turboSigner", async () => {
    const { kr } = await setup();
    for (const k of [`0x${"fc".repeat(32)}`, toHex(new Uint8Array(32)), `0x${kr.farcasterPublicKey().slice(4)}00` as Hex]) {
      await expect(kr.signFcKeyRequest(FID, k as Hex, DEADLINE)).rejects.toThrow(/not the agent's own fc public key/);
    }
    const upper = `0x${kr.farcasterPublicKey().slice(2).toUpperCase()}` as Hex;
    await expect(kr.signFcKeyRequest(FID, upper, DEADLINE)).resolves.toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("M3D: requires an attached config with platform.farcaster; bad fid / deadline refused", async () => {
    const bare = await createKeyring(new MockKms("image-fc", "agent-fc"), { retry: { attempts: 2, delayMs: 1 } });
    await expect(bare.signFcKeyRequest(FID, bare.farcasterPublicKey(), DEADLINE)).rejects.toThrow(/no config attached/);
    const { kr } = await setup({ farcaster: false });
    await expect(kr.signFcKeyRequest(FID, kr.farcasterPublicKey(), DEADLINE)).rejects.toThrow(/platform\.farcaster/);
    const ok = await setup();
    await expect(ok.kr.signFcKeyRequest(0n, ok.kr.farcasterPublicKey(), DEADLINE)).rejects.toThrow(/requestFid/);
    await expect(ok.kr.signFcKeyRequest(FID, ok.kr.farcasterPublicKey(), 0n)).rejects.toThrow(/deadline/);
  });
});
