// SPEC-M3D §3d — Farcaster on-chain onboarding (daemon step 13; ONLY with platform.farcaster AND
// runtime.tee — boot wires the hook). D16: FID-only (no fname). Live-proven flow (OP mainnet, FID 3352486):
//   1. fid unknown (kv fc.fid absent): idRegistry.idOf(treasury); 0 ⇒ idGateway.price() (> registerMaxWei ⇒
//      warn + retry next tick) ⇒ execute fcRegister{priceWei} ⇒ re-read idOf. Non-zero ⇒ kv fc.fid.
//   2. fid known, key not added (keyRegistry.keyDataOf(fid, fcPublicKey).state != 1): deadline = now + 1h;
//      sig = keyring.signFcKeyRequest(fid, fcPublicKey, deadline) (SELF-signed: requestFid = own fid,
//      requestSigner = treasury); metadata = abi.encode(SignedKeyRequestMetadata tuple); execute fcAddKey.
//   3. key added, kv fc.userDataSent absent: DISPLAY UserDataAdd (= agent.name) through the normal engine as
//      kind fcUserData (S3 pace cap, K4, fcSink) ⇒ kv fc.userDataSent on success.
// All reads through deps.chain ("optimism"); every failure = warn + retry next tick (04 §7: the agent is live
// anyway, social pending). Cadence: the hook is due until the flow completes; a clean run completes it in
// one tick, a failed one is retried on the next tick (so "daily" collapses to "each tick until done").
// Pure viem for the metadata encoding; no clock (now is a parameter), no randomness.

import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { execute, type ExecDeps, type ExecResult } from "../exec/execute.js";
import { FC_KEY_STATE_ADDED, fcIdGatewayAbi, fcIdRegistryAbi, fcKeyRegistryAbi, signedKeyRequestMetadataAbi } from "../exec/abi.js";
import { kvGet, kvSet, type MemoryDb } from "../memory/db.js";
import type { ProposedAction, UnixSeconds } from "../policy/types.js";
import { buildUserDataAdd, FC_USER_DATA_DISPLAY } from "./fcMessage.js";

/** kv: the agent's own Farcaster id (decimal). */
export const KV_FC_FID = "fc.fid";
/** kv: set (decimal unix s) once the DISPLAY UserDataAdd was published through the engine. */
export const KV_FC_USER_DATA_SENT = "fc.userDataSent";
/** SignedKeyRequest deadline = now + this (SPEC-M3D §3d: 1 h). */
export const FC_KEY_REQUEST_DEADLINE_SEC = 3600n;

export interface FcOnboardLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface FcOnboardDeps {
  /** Logged ExecDeps: cfg (frozen platform.farcaster), chain (optimism reads), keyring (signFcKeyRequest). */
  exec: ExecDeps;
  db: MemoryDb;
  logger: FcOnboardLogger;
}

export interface FcOnboardOutcome {
  skip?: string;
  notes: string[];
  results: ExecResult[];
}

/** kv fc.fid as a bigint (> 0), else undefined. */
export function readFcFid(db: MemoryDb): bigint | undefined {
  const v = kvGet(db, KV_FC_FID);
  return v !== undefined && /^[1-9][0-9]{0,19}$/.test(v) ? BigInt(v) : undefined;
}

/** Due until the flow has completed (kv fc.userDataSent). */
export function fcOnboardDue(db: MemoryDb): boolean {
  return kvGet(db, KV_FC_USER_DATA_SENT) === undefined;
}

/** abi.encode(SignedKeyRequestMetadata{requestFid, requestSigner, signature, deadline}) — tuple encoding. */
export function encodeSignedKeyRequestMetadata(m: { requestFid: bigint; requestSigner: Address; signature: Hex; deadline: bigint }): Hex {
  return encodeAbiParameters(signedKeyRequestMetadataAbi, [m]);
}

function asUint(v: unknown, what: string): bigint {
  if (typeof v !== "bigint" || v < 0n) throw new Error(`${what}: expected uint, got ${typeof v}`);
  return v;
}

/** KeyRegistry.keyDataOf result → state (viem returns {state, keyType}; tolerate a positional tuple). */
function keyState(v: unknown): number {
  const s = Array.isArray(v) ? (v as unknown[])[0] : v !== null && typeof v === "object" ? (v as Record<string, unknown>)["state"] : undefined;
  if (typeof s === "number") return s;
  if (typeof s === "bigint") return Number(s);
  throw new Error("keyDataOf: malformed KeyData");
}

function ok(r: ExecResult): boolean {
  return r.verdict.allow && r.error === undefined;
}

function why(r: ExecResult): string {
  return r.verdict.allow ? (r.error ?? "unknown error") : `${r.verdict.code}: ${r.verdict.detail}`;
}

/** One step-13 run. Throws (after a LOUD warn) on a failed chain read ⇒ step error, retried next tick. */
export async function runFcOnboard(d: FcOnboardDeps, now: UnixSeconds): Promise<FcOnboardOutcome> {
  const notes: string[] = [];
  const results: ExecResult[] = [];
  const fail = (msg: string): FcOnboardOutcome => {
    d.logger.warn(`fc onboarding: ${msg} — retry next tick (agent live; social pending)`);
    notes.push(msg);
    return { notes, results };
  };
  if (!fcOnboardDue(d.db)) return { skip: "farcaster onboarding complete", notes, results };
  const cfg = d.exec.cfg;
  const fc = cfg.farcaster;
  if (fc === undefined) return { skip: "no platform.farcaster config", notes, results };
  const chain = d.exec.chain;
  const treasury = cfg.treasury;
  const idOf = async (): Promise<bigint> =>
    asUint(await chain.readContract("optimism", { address: fc.idRegistry, abi: fcIdRegistryAbi, functionName: "idOf", args: [treasury] }), "idOf");

  try {
    // 1. fid
    let fid = readFcFid(d.db);
    if (fid === undefined) {
      let id = await idOf();
      if (id === 0n) {
        const price = asUint(await chain.readContract("optimism", { address: fc.idGateway, abi: fcIdGatewayAbi, functionName: "price", args: [] }), "price");
        if (price > fc.registerMaxWei) return fail(`IdGateway price ${price} wei > registerMaxWei ${fc.registerMaxWei} — not registering`);
        const reg: ProposedAction = { kind: "fcRegister", priceWei: price };
        const r = await execute(reg, d.exec);
        results.push(r);
        if (!ok(r)) return fail(`fcRegister failed (${why(r)})`);
        id = await idOf();
        if (id === 0n) return fail(`fcRegister sent (tx ${r.txHash ?? "?"}) but idOf(treasury) is still 0`);
        notes.push(`registered fid ${id} (price ${price} wei, tx ${r.txHash ?? "?"})`);
      }
      fid = id;
      kvSet(d.db, KV_FC_FID, fid.toString(10));
      d.logger.info(`fc onboarding: fid ${fid}`);
    }

    // 2. signer key
    const key = d.exec.keyring.farcasterPublicKey();
    const keyData = async (): Promise<number> =>
      keyState(await chain.readContract("optimism", { address: fc.keyRegistry, abi: fcKeyRegistryAbi, functionName: "keyDataOf", args: [fid, key] }));
    if ((await keyData()) !== FC_KEY_STATE_ADDED) {
      const deadline = now + FC_KEY_REQUEST_DEADLINE_SEC;
      const signature = await d.exec.keyring.signFcKeyRequest(fid, key, deadline);
      const metadata = encodeSignedKeyRequestMetadata({ requestFid: fid, requestSigner: treasury, signature, deadline });
      const r = await execute({ kind: "fcAddKey", key, metadata }, d.exec);
      results.push(r);
      if (!ok(r)) return fail(`fcAddKey failed (${why(r)})`);
      if ((await keyData()) !== FC_KEY_STATE_ADDED) return fail(`fcAddKey sent (tx ${r.txHash ?? "?"}) but the key is not ADDED yet`);
      notes.push(`fc key ${key} added for fid ${fid} (tx ${r.txHash ?? "?"})`);
    }

    // 3. DISPLAY user data (agent.name) through the engine (S3 + K4 + fcSink)
    const bytes = buildUserDataAdd(FC_USER_DATA_DISPLAY, cfg.agent.name, fid, now);
    const r = await execute({ kind: "fcUserData", contentHash: keccak256(bytes), sizeBytes: BigInt(bytes.length) }, d.exec, { messageBytes: bytes });
    results.push(r);
    if (!ok(r)) return fail(`fcUserData DISPLAY failed (${why(r)})`);
    kvSet(d.db, KV_FC_USER_DATA_SENT, now.toString(10));
    notes.push(`DISPLAY user data "${cfg.agent.name}" published for fid ${fid}`);
    d.logger.info(`fc onboarding complete: fid ${fid}, key added, DISPLAY set`);
    return { notes, results };
  } catch (e) {
    d.logger.warn(`!!! fc onboarding: read/sign FAILED (${e instanceof Error ? e.message : String(e)}) — retry next tick !!!`);
    throw e;
  }
}
