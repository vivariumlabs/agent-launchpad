// SPEC-M3D §3d — Farcaster on-chain onboarding (daemon step 13) on the MockChainClient: FID register →
// self-signed key add → DISPLAY user data, each through the real engine + keyring.

import * as ed from "@noble/ed25519";
import { decodeAbiParameters, decodeFunctionData, getAddress, hexToBytes, keccak256, parseAbi, verifyTypedData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { tick, type DaemonStepHook } from "../../src/daemon/daemon.js";
import type { ReadContractRequest } from "../../src/exec/chain.js";
import { signedKeyRequestMetadataAbi } from "../../src/exec/abi.js";
import { kvGet, kvSet } from "../../src/memory/db.js";
import type { Chain } from "../../src/policy/types.js";
import { buildUserDataAdd, fcMessageHash, FC_USER_DATA_DISPLAY } from "../../src/social/fcMessage.js";
import {
  encodeSignedKeyRequestMetadata,
  FC_KEY_REQUEST_DEADLINE_SEC,
  fcOnboardDue,
  KV_FC_FID,
  KV_FC_USER_DATA_SENT,
  runFcOnboard,
} from "../../src/social/fcOnboard.js";
import { agentJson, FC, FC_REGISTER_MAX_WEI, mkState, NOW } from "../policy/helpers.js";
import { daemonHarness, type DaemonHarness } from "../daemon/harness.js";

const FID = 3_352_486n;
const PRICE = 75_000_000_000_000n;
const IDG = parseAbi(["function register(address recovery) payable returns (uint256 fid, uint256 overpayment)"]);
const KG = parseAbi(["function add(uint32 keyType, bytes key, uint8 metadataType, bytes metadata)"]);

interface World {
  h: DaemonHarness;
  reads: Array<{ chain: Chain; fn: string }>;
  warns: string[];
  infos: string[];
  run(now?: bigint): ReturnType<typeof runFcOnboard>;
}

/** Stateful OP-mainnet stand-in: idOf flips after a register tx to the idGateway, keyDataOf after an add to the keyGateway. */
async function world(o: { price?: bigint; registered?: boolean; keyAdded?: boolean; failReads?: boolean; state?: ReturnType<typeof mkState> } = {}): Promise<World> {
  const reads: World["reads"] = [];
  let h: DaemonHarness | undefined;
  const sentTo = (a: string): boolean => (h?.chain.sent ?? []).some((t) => t.chain === "optimism" && t.to?.toLowerCase() === a.toLowerCase() && t.outcome === "success");
  h = await daemonHarness({
    lastSnapshotAt: NOW,
    ...(o.state !== undefined ? { state: o.state } : {}),
    chain: {
      reads: (chain: Chain, req: ReadContractRequest) => {
        reads.push({ chain, fn: req.functionName });
        if (o.failReads === true) throw new Error("rpc down");
        switch (req.functionName) {
          case "idOf":
            return o.registered === true || sentTo(FC.idGateway) ? FID : 0n;
          case "price":
            return o.price ?? PRICE;
          case "keyDataOf":
            return o.keyAdded === true || sentTo(FC.keyGateway) ? { state: 1, keyType: 1 } : { state: 0, keyType: 0 };
          default:
            throw new Error(`unexpected read ${req.functionName}`);
        }
      },
    },
  });
  const warns: string[] = [];
  const infos: string[] = [];
  const hh = h;
  return {
    h: hh,
    reads,
    warns,
    infos,
    run: (now = NOW) => runFcOnboard({ exec: hh.deps, db: hh.db, logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m) } }, now),
  };
}

describe("M3D-fc: fcOnboard — full flow on a mock chain (SPEC-M3D §3d)", () => {
  it("M3D-fc: fid unknown ⇒ idOf 0 ⇒ price ⇒ fcRegister ⇒ idOf ⇒ kv fc.fid; key not added ⇒ self-signed fcAddKey; DISPLAY fcUserData ⇒ kv fc.userDataSent", async () => {
    const w = await world();
    const out = await w.run();
    const h = w.h;
    expect(out.results.map((r) => [r.action.kind, r.verdict.allow, r.error])).toEqual([
      ["fcRegister", true, undefined],
      ["fcAddKey", true, undefined],
      ["fcUserData", true, undefined],
    ]);
    expect(kvGet(h.db, KV_FC_FID)).toBe(FID.toString(10));
    expect(kvGet(h.db, KV_FC_USER_DATA_SENT)).toBe(NOW.toString(10));
    expect(w.reads.every((r) => r.chain === "optimism")).toBe(true);
    expect(w.reads.map((r) => r.fn)).toEqual(["idOf", "price", "idOf", "keyDataOf", "keyDataOf"]);

    const [reg, add] = h.chain.sent;
    // register: to the FROZEN idGateway, value = price, recovery = own treasury, chainId 10, from treasury
    expect(reg).toMatchObject({ chain: "optimism", chainId: 10, value: PRICE });
    expect(reg!.to!.toLowerCase()).toBe(FC.idGateway.toLowerCase());
    expect(reg!.from.toLowerCase()).toBe(h.cfg.treasury.toLowerCase());
    expect(decodeFunctionData({ abi: IDG, data: reg!.data }).args).toEqual([h.cfg.treasury]);
    // add: KeyGateway.add(1, own fc key, 1, SignedKeyRequestMetadata{fid, treasury, sig, now + 1h})
    expect(add!.to!.toLowerCase()).toBe(FC.keyGateway.toLowerCase());
    expect(add!.value).toBe(0n);
    const [keyType, key, metadataType, metadata] = decodeFunctionData({ abi: KG, data: add!.data }).args;
    expect([keyType, key, metadataType]).toEqual([1, h.kr.farcasterPublicKey(), 1]);
    const [meta] = decodeAbiParameters(signedKeyRequestMetadataAbi, metadata);
    expect(meta.requestFid).toBe(FID);
    expect(meta.requestSigner).toBe(h.cfg.treasury);
    expect(meta.deadline).toBe(NOW + FC_KEY_REQUEST_DEADLINE_SEC);
    expect(
      await verifyTypedData({
        address: h.cfg.treasury,
        domain: { name: "Farcaster SignedKeyRequestValidator", version: "1", chainId: 10, verifyingContract: FC.validator },
        types: { SignedKeyRequest: [{ name: "requestFid", type: "uint256" }, { name: "key", type: "bytes" }, { name: "deadline", type: "uint256" }] },
        primaryType: "SignedKeyRequest",
        message: { requestFid: FID, key: h.kr.farcasterPublicKey(), deadline: NOW + 3600n },
        signature: meta.signature,
      }),
    ).toBe(true);
    // DISPLAY user data = agent.name, K4-signed, published via the cast sink; S3 counter consumed
    const want = buildUserDataAdd(FC_USER_DATA_DISPLAY, agentJson.name, FID, NOW);
    expect(h.casts).toHaveLength(1);
    expect(h.casts[0]!.bytes).toEqual(want);
    expect(await ed.verifyAsync(hexToBytes(h.casts[0]!.sig), fcMessageHash(want), hexToBytes(h.kr.farcasterPublicKey()))).toBe(true);
    expect(out.results[2]!.action).toEqual({ kind: "fcUserData", contentHash: keccak256(want), sizeBytes: BigInt(want.length) });
    expect(h.ledger().fcUserDataToday).toBe(1n);
    expect(fcOnboardDue(h.db)).toBe(false);
  });

  it("M3D-fc: idempotent re-run does nothing (no reads, no txs, no casts)", async () => {
    const w = await world();
    await w.run();
    const sent = w.h.chain.sent.length;
    const reads = w.reads.length;
    const again = await w.run(NOW + 21_600n);
    expect(again).toEqual({ skip: "farcaster onboarding complete", notes: [], results: [] });
    expect(w.h.chain.sent).toHaveLength(sent);
    expect(w.reads).toHaveLength(reads);
    expect(w.h.casts).toHaveLength(1);
  });

  it("M3D-fc: IdGateway price > registerMaxWei ⇒ skip + warn, no tx, fid stays unknown (retry next tick)", async () => {
    const w = await world({ price: FC_REGISTER_MAX_WEI + 1n });
    const out = await w.run();
    expect(out.results).toEqual([]);
    expect(w.h.chain.sent).toHaveLength(0);
    expect(kvGet(w.h.db, KV_FC_FID)).toBeUndefined();
    expect(w.warns.join("\n")).toMatch(/price 200000000000001 wei > registerMaxWei 200000000000000/);
    expect(fcOnboardDue(w.h.db)).toBe(true);
  });

  it("M3D-fc: already registered (idOf ≠ 0) and key already ADDED ⇒ no register / add tx; only the DISPLAY user data", async () => {
    const w = await world({ registered: true, keyAdded: true });
    const out = await w.run();
    expect(out.results.map((r) => r.action.kind)).toEqual(["fcUserData"]);
    expect(w.h.chain.sent).toHaveLength(0);
    expect(kvGet(w.h.db, KV_FC_FID)).toBe(FID.toString(10));
  });

  it("M3D-fc: fid known in kv ⇒ idOf not read again", async () => {
    const w = await world({ registered: true });
    kvSet(w.h.db, KV_FC_FID, FID.toString(10));
    await w.run();
    expect(w.reads.map((r) => r.fn)).toEqual(["keyDataOf", "keyDataOf"]);
    expect(w.h.chain.sent.map((t) => t.to?.toLowerCase())).toEqual([FC.keyGateway.toLowerCase()]);
  });

  it("M3D-fc: a stale optimism state ⇒ engine denies fcRegister (STATE_STALE) ⇒ warn + retry, nothing sent", async () => {
    const w = await world({ state: mkState({ staleChains: ["optimism"] }) });
    const out = await w.run();
    expect(out.results.map((r) => r.verdict)).toMatchObject([{ allow: false, code: "STATE_STALE" }]);
    expect(w.h.chain.sent).toHaveLength(0);
    expect(w.warns.join("\n")).toMatch(/fcRegister failed \(STATE_STALE/);
    expect(kvGet(w.h.db, KV_FC_FID)).toBeUndefined();
  });

  it("M3D-fc: a failed read throws (step error) after a LOUD warn; nothing is recorded", async () => {
    const w = await world({ failReads: true });
    await expect(w.run()).rejects.toThrow(/rpc down/);
    expect(w.warns.join("\n")).toMatch(/!!! fc onboarding: read\/sign FAILED/);
    expect(kvGet(w.h.db, KV_FC_FID)).toBeUndefined();
  });

  it("M3D-fc: daemon step 13 via tick(): hook wired ⇒ 'fcOnboard' step runs after step 12 slot; error ⇒ status error, later ticks retry", async () => {
    const w = await world();
    const hook: DaemonStepHook = { due: () => fcOnboardDue(w.h.db), run: (now) => w.run(now) };
    w.h.deps.fcOnboard = hook;
    const r1 = await tick(w.h.deps, NOW);
    const st = r1.steps.find((s) => s.step === "fcOnboard");
    expect(st?.status).toBe("ran");
    expect(r1.steps.at(-1)?.step).toBe("fcOnboard");
    const r2 = await tick(w.h.deps, NOW + 21_600n);
    expect(r2.steps.find((s) => s.step === "fcOnboard")).toMatchObject({ status: "skipped", reason: "farcaster onboarding not due" });

    const bad = await world({ failReads: true });
    bad.h.deps.fcOnboard = { due: () => fcOnboardDue(bad.h.db), run: (now) => bad.run(now) };
    const r3 = await tick(bad.h.deps, NOW);
    expect(r3.steps.find((s) => s.step === "fcOnboard")).toMatchObject({ status: "error" });
  });

  it("M3D-fc: SignedKeyRequestMetadata ABI encoding is the tuple encoding (dynamic head offset 0x20)", () => {
    const sig = `0x${"11".repeat(65)}` as Hex;
    const enc = encodeSignedKeyRequestMetadata({ requestFid: FID, requestSigner: "0x00000000000000000000000000000000000000aa", signature: sig, deadline: 5n });
    expect(enc.slice(2, 66)).toBe("20".padStart(64, "0")); // tuple offset
    const [m] = decodeAbiParameters(signedKeyRequestMetadataAbi, enc);
    expect(m).toEqual({ requestFid: FID, requestSigner: getAddress("0x00000000000000000000000000000000000000aa"), signature: sig, deadline: 5n });
  });
});
