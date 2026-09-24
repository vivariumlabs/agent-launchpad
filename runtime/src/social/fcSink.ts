// SPEC-M3D §3c — Farcaster CastSink: local memory mirror FIRST, then the hub.
//
// publish(action, messageBytes, signature): messageBytes IS the serialized MessageData (built by the
// caller: pulse §3e / daemon step 13) and `signature` the K4 ed25519 signature over blake3_20 of it.
//   1. mirror.publish (memoryCastSink — the draft row is written exactly as before: casts stay auditable
//      locally even when the hub submit fails);
//   2. no fid yet (kv fc.fid absent) ⇒ LOGGED, not an error: the draft stays local;
//      bytes that are not a MessageData for that fid (e.g. a draft built before the fid existed) ⇒ same;
//   3. Message { data_bytes, blake3-20 hash, BLAKE3/ED25519 schemes, signature, signer = the keyring's fc
//      public key } → HubSubmitter (hubs in order; all failing ⇒ throws ⇒ ExecResult.error, row kept).
// Boot wires it as the castSink when platform.farcaster is present AND runtime.tee (overrides win).

import { bytesToHex, hexToBytes, type Hex } from "viem";
import type { CastSink } from "../exec/execute.js";
import type { ProposedAction } from "../policy/types.js";
import { encodeMessage, fcMessageHash, isMessageDataFor } from "./fcMessage.js";
import type { HubSubmitter } from "./hubClient.js";

export interface FcSinkLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface FcSinkOptions {
  /** Local draft log (memoryCastSink) — written FIRST, always. */
  mirror: CastSink;
  hub: HubSubmitter;
  /** keyring.farcasterPublicKey() (32-byte ed25519). */
  signerPublicKey: Hex;
  /** Current fid (kv fc.fid) or undefined before on-chain registration. */
  fid(): bigint | undefined;
  logger: FcSinkLogger;
}

export function fcSink(o: FcSinkOptions): CastSink {
  const signer = hexToBytes(o.signerPublicKey);
  if (signer.length !== 32) throw new Error("fcSink: signer public key must be 32 bytes");
  return {
    async publish(action: ProposedAction, messageBytes: Uint8Array, signature: Hex): Promise<void> {
      await o.mirror.publish(action, messageBytes, signature);
      const fid = o.fid();
      if (fid === undefined) {
        o.logger.info(`fc: no fid yet — ${action.kind} draft kept locally (not published)`);
        return;
      }
      if (!isMessageDataFor(messageBytes, fid)) {
        o.logger.warn(`fc: ${action.kind} bytes are not a Farcaster MessageData for fid ${fid} — draft kept locally (not published)`);
        return;
      }
      const message = encodeMessage({ dataBytes: messageBytes, signature: hexToBytes(signature), signer });
      const r = await o.hub.submitMessage(message);
      o.logger.info(`fc: ${action.kind} ${bytesToHex(fcMessageHash(messageBytes))} submitted via hub ${r.hubId} (HTTP ${r.status})`);
    },
  };
}
