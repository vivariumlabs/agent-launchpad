// SPEC-M4E §1a — frozen-config publication to Arweave (02 §1: "the config itself goes to the genesis
// service off-chain AND to Arweave"; D10: revival needs the Arweave-published original).
//
// R1: the Arweave item is pure TRANSPORT — trust comes only from verifyFrozen (configSource.ts): the
// item's text must hash to the ON-CHAIN configHash. R2: the launch-helper signs the ANS-104 item with
// an EPHEMERAL in-memory secp256k1 key (fresh per process, never persisted, holds nothing, proves
// nothing) — the helper stays secret-free. Uploads < 100 KiB are free on Turbo (winc 0, proven M3 s3),
// so the key needs no funding. The data-item encoding + Turbo HTTP client are the runtime's own
// (runtimeArweave.ts seam); this file only builds the signer, the tags and the size/hash checks.
//
// Explicit randomness seam (hygiene test): generatePrivateKey appears ONLY here.

import { hexToBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FrozenConfigFileSchema, frozenConfigHash } from "./canonical.js";
import type { Clock } from "./clock.js";
import {
  DEFAULT_ARWEAVE_GATEWAY_URL,
  DEFAULT_TURBO_UPLOAD_URL,
  TURBO_APP_TAG,
  TurboHttpUploader,
  type TurboSigner,
  type TurboTag,
  type TurboUploader,
} from "./runtimeArweave.js";

/** Turbo free tier: data items under 100 KiB cost 0 winc. */
export const FREE_UPLOAD_MAX_BYTES = 100 * 1024;
/**
 * Max config TEXT bytes: the free limit minus 1 KiB headroom for the data-item header (sig type,
 * 65 B signature, 65 B owner, presence bytes, counts) and the four tags (~200 B) — so the SIGNED
 * item always stays under FREE_UPLOAD_MAX_BYTES.
 */
export const MAX_CONFIG_TEXT_BYTES = FREE_UPLOAD_MAX_BYTES - 1024;
/** SPEC-M4E §1a tag `Kind`. */
export const CONFIG_KIND = "config";
/** Keyring's TurboSigner allowlist, mirrored: sign() accepts ONLY 48-byte ANS-104 deep hashes. */
const ANS104_SIGN_LENGTH = 48;

const HASH_RE = /^0x[0-9a-f]{64}$/;
const utf8 = new TextEncoder();

export class ConfigTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`frozen config is ${bytes} bytes; the free Arweave upload path takes at most ${MAX_CONFIG_TEXT_BYTES} (item < ${FREE_UPLOAD_MAX_BYTES} bytes)`);
    this.name = "ConfigTooLarge";
  }
}

export class ConfigInvalid extends Error {
  constructor(
    readonly code: "config_invalid" | "config_hash_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ConfigInvalid";
  }
}

/**
 * A FRESH secp256k1 key held only in this closure (never returned, logged or persisted). Same shape
 * and 48-byte-only sign allowlist as the runtime keyring's turboSigner().
 */
export function ephemeralTurboSigner(): TurboSigner {
  const account = privateKeyToAccount(generatePrivateKey());
  return Object.freeze({
    signatureType: 3 as const,
    ownerLength: 65 as const,
    signatureLength: 65 as const,
    publicKey: hexToBytes(account.publicKey),
    address: account.address,
    async sign(message: Uint8Array): Promise<Uint8Array> {
      if (!(message instanceof Uint8Array) || message.length !== ANS104_SIGN_LENGTH) {
        throw new Error(`ephemeral signer: refusing a ${message instanceof Uint8Array ? message.length : typeof message}-byte message (only 48-byte ANS-104 deep hashes)`);
      }
      return hexToBytes(await account.signMessage({ message: { raw: message } }));
    },
  });
}

export interface ArweaveHttpOptions {
  uploadUrl?: string;
  gatewayUrl?: string;
  timeoutMs?: number;
  /** Tests only: injected fetch (the runtime client's seam). */
  fetchImpl?: typeof fetch;
  /** Tests only: permit http:// URLs. */
  allowInsecureHttp?: boolean;
}

/** The runtime's Turbo HTTP client over a fresh ephemeral key (one per call — call once per process). */
export function createEphemeralUploader(o: ArweaveHttpOptions = {}): TurboUploader {
  return new TurboHttpUploader(ephemeralTurboSigner(), {
    uploadUrl: o.uploadUrl ?? DEFAULT_TURBO_UPLOAD_URL,
    gatewayUrl: o.gatewayUrl ?? DEFAULT_ARWEAVE_GATEWAY_URL,
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
    ...(o.fetchImpl === undefined ? {} : { fetchImpl: o.fetchImpl }),
    ...(o.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: o.allowInsecureHttp }),
    maxDownloadBytes: FREE_UPLOAD_MAX_BYTES * 2,
  });
}

/**
 * Gateway reader for the discovery source: the runtime client's download() (https only, size-capped,
 * SPEC-M3D §1b one-redirect rule to *.arweave.net). The ephemeral signer is never asked to sign here.
 */
export function createArweaveReader(o: ArweaveHttpOptions = {}): { download(id: string): Promise<Uint8Array> } {
  const u = createEphemeralUploader(o);
  return { download: (id) => u.download(id) };
}

/** SPEC-M4E §1a tags. ConfigHash = 0x + 64 lowercase hex; Timestamp = unix seconds. */
export function configTags(configHash: string, now: bigint): TurboTag[] {
  const h = configHash.toLowerCase();
  if (!HASH_RE.test(h)) throw new Error(`bad configHash ${configHash}`);
  return [
    { name: "App", value: TURBO_APP_TAG },
    { name: "Kind", value: CONFIG_KIND },
    { name: "ConfigHash", value: h },
    { name: "Timestamp", value: now.toString(10) },
  ];
}

/** Hash of a frozen agent.json TEXT ({platform, agent} exactly). Throws ConfigInvalid. */
export function frozenTextHash(text: string): { configHash: string; agent: unknown } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigInvalid("config_invalid", "agentJsonText is not JSON");
  }
  const env = FrozenConfigFileSchema.safeParse(raw);
  if (!env.success) throw new ConfigInvalid("config_invalid", "agentJsonText must be exactly { platform, agent }");
  return { configHash: frozenConfigHash({ platform: env.data.platform, agent: env.data.agent }).toLowerCase(), agent: env.data.agent };
}

export interface PublishDeps {
  /** One per process (createEphemeralUploader); tests inject a mock or a fetch-mocked real client. */
  uploader: Pick<TurboUploader, "upload">;
  clock: Clock;
}

/**
 * Uploads the EXACT text bytes as one ANS-104 item tagged per §1a. Throws ConfigTooLarge /
 * ConfigInvalid before any network; upload errors propagate (the caller maps them to 502).
 */
export async function publishFrozenConfig(text: string, deps: PublishDeps): Promise<{ txId: string; configHash: string }> {
  const bytes = utf8.encode(text);
  if (bytes.length > MAX_CONFIG_TEXT_BYTES) throw new ConfigTooLarge(bytes.length);
  const { configHash } = frozenTextHash(text);
  const { id } = await deps.uploader.upload(bytes, configTags(configHash, deps.clock.now()));
  return { txId: id, configHash };
}
