// SPEC-M2B §2 K4: ed25519 for the Farcaster (fc) key. The 32-byte seed is the
// KMS "fc" derive output (the session-1 secp fc key becomes the seed source).
// Uses @noble/ed25519's async API (SHA-512 via WebCrypto; no global config).
//
// Only keyring.ts may call ed25519Sign (it is the sole holder of the seed).

import * as ed from "@noble/ed25519";
import { bytesToHex, hexToBytes, type Hex } from "viem";

function seedBytes(seed: Hex): Uint8Array {
  const b = hexToBytes(seed);
  if (b.length !== 32) throw new Error("ed25519: seed must be 32 bytes");
  return b;
}

/** 32-byte ed25519 public key for a 32-byte seed. */
export async function ed25519PublicKey(seed: Hex): Promise<Hex> {
  return bytesToHex(await ed.getPublicKeyAsync(seedBytes(seed)));
}

/** 64-byte ed25519 signature over `message`. */
export async function ed25519Sign(seed: Hex, message: Uint8Array): Promise<Hex> {
  return bytesToHex(await ed.signAsync(message, seedBytes(seed)));
}

/** Verify a 64-byte ed25519 signature (public helper; no key material). */
export async function ed25519Verify(signature: Hex, message: Uint8Array, publicKey: Hex): Promise<boolean> {
  return ed.verifyAsync(hexToBytes(signature), message, hexToBytes(publicKey));
}
