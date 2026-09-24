// Operational (funding) wallet loading. SPEC-M3B §1: the key path comes from config (.secrets/
// pattern); the key is read once, turned into a viem LocalAccount (which exposes signing functions
// and the public address, never the private key) and the raw string goes out of scope here.
// Error messages NEVER include file contents.
//
// Accepted file formats:
//   - raw hex: "0x<64 hex>" or "<64 hex>" (whitespace-trimmed) — also what `oyster-cvm
//     --wallet-file` reads;
//   - `cast wallet new --json` output: { data: [ { private_key: "0x…" } ] } or { private_key } —
//     the .secrets/m0-drill-wallet.json format.

import { readFileSync } from "node:fs";
import type { Hex, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HEX_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

export type KeyFileFormat = "hex" | "json";

function extract(text: string, path: string): { key: string; format: KeyFileFormat } {
  const trimmed = text.trim();
  if (HEX_KEY.test(trimmed)) return { key: trimmed, format: "hex" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`wallet key file ${path}: neither a raw hex key nor JSON (contents not shown)`);
  }
  const pick = (o: unknown): unknown =>
    o !== null && typeof o === "object" && "private_key" in o ? (o as { private_key: unknown }).private_key : undefined;
  let cand = pick(parsed);
  if (cand === undefined && parsed !== null && typeof parsed === "object" && "data" in parsed) {
    const data = (parsed as { data: unknown }).data;
    cand = Array.isArray(data) ? pick(data[0]) : pick(data);
  }
  if (typeof cand !== "string" || !HEX_KEY.test(cand.trim())) {
    throw new Error(`wallet key file ${path}: no 32-byte hex private_key field found (contents not shown)`);
  }
  return { key: cand.trim(), format: "json" };
}

/** Loads the funding wallet. Only the signing account leaves this function. */
export function loadWallet(path: string): { account: LocalAccount; format: KeyFileFormat } {
  const { key, format } = extract(readFileSync(path, "utf8"), path);
  const hex = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
  return { account: privateKeyToAccount(hex), format };
}
