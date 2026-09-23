// SPEC-M2 §5 + SPEC-M2B §2. Holds derived keys; signs ONLY policy-approved payloads.
// No Date.now anywhere here — time is always a parameter (`now`).
//
// Signing gates (every sign*Approved entry point):
//   K1  hash match (approval.actionHash == actionHash(action)) → TTL (now ≤ issuedAt + ttlSec)
//       → single-use: reject if (actionHash, issuedAt) already consumed, else mark consumed.
//       Consumed entries older than 10 × TTL are pruned on every call. A legitimate retry
//       must go back through evaluate() for a fresh approval (policy re-checked by design).
//   K2  signTxApproved: tx body rebuilt here via buildTx(action, cfg, approval.issuedAt);
//       only {nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas} are taken from `fill`
//       (any other field on `fill` is ignored); gas/fee bounds from config.
//   K3  signX402AuthApproved: EIP-3009 TransferWithAuthorization for `inference` only.
//   K4  signCastApproved: ed25519 over messageBytes iff keccak256(messageBytes) == contentHash.
//
// Config binding: the keyring derives OwnAddresses, which ResolvedConfig needs, so
// the config is attached once after resolveConfig() via attachConfig(cfg); it must
// carry exactly this keyring's own addresses. K2/K3 throw until a config is attached.

import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { concat, hexToBytes, keccak256, stringToBytes, stringToHex, type Address, type Hex } from "viem";
import type { ResolvedConfig, X402AllowlistEntry } from "../config/schema.js";
import { buildTx } from "../exec/build.js";
import type { TxFill } from "../exec/chain.js";
import { transferWithAuthorizationTypes } from "../exec/abi.js";
import { actionHash as computeActionHash } from "../policy/approval.js";
import { walletForAction, type Approval, type OwnAddresses, type ProposedAction, type UnixSeconds } from "../policy/types.js";
import { sameAddress } from "../policy/util.js";
import { ed25519PublicKey, ed25519Sign } from "./ed25519.js";
import { withRetry, type KmsClient, type WithRetryOptions } from "./kms.js";

/** EIP-3009 authorization fields supplied by the x402 client (from the 402 quote). */
export interface X402AuthInput {
  /** Optional; if present must equal the own treasury EOA. The signed `from` is always the treasury. */
  from?: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface X402Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface SignedX402Auth {
  authorization: X402Authorization;
  signature: Hex;
}

export interface Keyring {
  addresses(): OwnAddresses;
  /** Bind the resolved config (once). Its treasury/action must equal addresses(). */
  attachConfig(cfg: ResolvedConfig): void;
  /**
   * SPEC-M3B §4: replace ONLY the attached config's x402 allowlist (K3's payTo source) after a verified
   * signed-allowlist adoption. Nothing else of the attached config can change (K2 bounds, addresses).
   * Throws when no config is attached.
   */
  updateAllowlist(entries: readonly X402AllowlistEntry[]): void;
  /** SPEC-M2 §1 entry point (kept for tests); K1-gated. Signs the raw actionHash. */
  signApproved(action: ProposedAction, approval: Approval, now: UnixSeconds): Promise<Hex>;
  /** K2: serialized signed EIP-1559 tx. */
  signTxApproved(action: ProposedAction, approval: Approval, fill: TxFill, now: UnixSeconds): Promise<Hex>;
  /** K3: EIP-3009 TransferWithAuthorization signed by the treasury key. */
  signX402AuthApproved(action: ProposedAction, approval: Approval, auth: X402AuthInput, now: UnixSeconds): Promise<SignedX402Auth>;
  /** K4: ed25519 signature (64 bytes) with the fc key. */
  signCastApproved(action: ProposedAction, approval: Approval, messageBytes: Uint8Array, now: UnixSeconds): Promise<Hex>;
  /** ed25519 public key (32 bytes) of the fc key. */
  farcasterPublicKey(): Hex;
  /** Scoped to the memory module only: raw key material for encrypting/decrypting memory state. */
  memKeyForMemoryModule(): Hex;
  /** Scoped to the chat module only (SPEC-M2C §1): raw 32-byte HMAC key for chat session tokens. */
  chatSessionKey(): Hex;
  /**
   * Scoped to src/tls only (SPEC-M3B §2): raw 32-byte seed of the ACME account key, KMS derive("acme").
   * LAZY (first call derives, withRetry; memoized): the boot derive order is unchanged and the KMS is
   * never asked for TLS keys unless ops.tls.enabled.
   */
  acmeAccountKey(): Promise<Hex>;
  /** Scoped to src/tls only: raw 32-byte seed of the placeholder-cert Ed25519 key, KMS derive("tls"). Lazy, as acmeAccountKey. */
  tlsPlaceholderKey(): Promise<Hex>;
  /**
   * SPEC-M3B §3: treasury-backed ANS-104 (Ethereum, signatureType 3) signer for Turbo uploads.
   * The returned object holds NO key material — sign() closes over the keyring's treasury account.
   */
  turboSigner(): TurboSigner;
  /**
   * GET /attestation response signer (closes the MITM gap on the attestation route): signs ONLY
   * keccak256(utf8(ATTESTATION_SIG_DOMAIN) ‖ payloadBytes) with the TREASURY key (EIP-191 over that
   * 32-byte digest). The domain prefix is prepended HERE, never by the caller. Holds NO key material.
   */
  attestationSigner(): AttestationSigner;
}

/**
 * Minimal ANS-104 Ethereum signer (arbundles EthereumSigner shape: signatureType 3, 65-byte
 * uncompressed secp256k1 owner, 65-byte EIP-191 personal_sign signature). Carries only PUBLIC data.
 * sign() accepts exactly ONE message shape — the 48-byte ANS-104 data-item deep hash (SHA-384,
 * src/attestation/ans104.ts) — so it cannot be used as a general personal_sign oracle over the
 * treasury key (SIWE logins, off-chain orders) and can never produce an attestationSigner()
 * signature (those are EIP-191 over a 32-byte digest: a different EIP-191 length prefix).
 */
export interface TurboSigner {
  readonly signatureType: 3;
  readonly ownerLength: 65;
  readonly signatureLength: 65;
  /** 65-byte uncompressed secp256k1 public key (0x04 ‖ x ‖ y). */
  readonly publicKey: Uint8Array;
  /** Treasury EOA. */
  readonly address: Address;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * TurboSigner.sign accepted message lengths — an explicit allowlist: 48 = ANS-104 deep hash (SHA-384).
 * (Job L's 32-byte "Turbo signed-request nonce" shape was REMOVED in M3 s2 close: the in-house
 * uploader (attestation/turboHttp.ts) never makes signed requests — upload auth is the data-item
 * signature, balance reads are by address — and a 32-byte EIP-191 shape would collide with
 * attestationSigner's digest signatures.)
 */
export const TURBO_SIGN_LENGTHS: readonly number[] = [48];

/** Domain prefix of attestationSigner digests (never shared with any other treasury signature). */
export const ATTESTATION_SIG_DOMAIN = "launchpad-attestation-v1";

/** keccak256(utf8(ATTESTATION_SIG_DOMAIN) ‖ payloadBytes) — the 32-byte digest attestationSigner signs (EIP-191). */
export function attestationDigest(payloadBytes: Uint8Array): Hex {
  return keccak256(concat([stringToBytes(ATTESTATION_SIG_DOMAIN), payloadBytes]));
}

/**
 * Treasury-backed signer for GET /attestation responses. Carries only PUBLIC data (the address).
 * sign(payloadBytes) = EIP-191 personal_sign over attestationDigest(payloadBytes); the domain prefix
 * is applied inside, so no caller can obtain a treasury signature over an arbitrary 32-byte value.
 * Non-collision: the treasury's other EIP-191 signatures are over 48-byte ANS-104 deep hashes
 * (different length prefix), raw actionHashes = keccak256(canonical JSON starting with "{") (distinct
 * preimage space) and — never — SIWE text (the keyring has no SIWE signing path).
 */
export interface AttestationSigner {
  /** Treasury EOA — must equal registry.instanceOf(agentId).treasuryEOA for a verifier to accept. */
  readonly address: Address;
  /** 65-byte EIP-191 signature (0x-hex) over attestationDigest(payloadBytes). */
  sign(payloadBytes: Uint8Array): Promise<Hex>;
}

export interface CreateKeyringOptions {
  /** Overrides withRetry's defaults for boot-time derives (tests use small delays). */
  retry?: WithRetryOptions;
}

/** K3: deterministic, replay-safe EIP-3009 nonce = keccak256(actionHash ‖ utf8("x402")). */
export function x402Nonce(actionHash: Hex): Hex {
  return keccak256(concat([actionHash, stringToHex("x402")]));
}

/** K3: max EIP-3009 validity window (validBefore − validAfter). */
export const X402_MAX_WINDOW_SEC = 3600n;
/** K1: consumed-set entries older than CONSUMED_RETENTION_TTLS × ttl are pruned. */
export const CONSUMED_RETENTION_TTLS = 10n;

export async function createKeyring(kms: KmsClient, opts?: CreateKeyringOptions): Promise<Keyring> {
  const retryOpts = opts?.retry;

  // Sequential, deterministic derive order: treasury, action, fc, mem, chat.
  const treasuryKey = await withRetry(() => kms.derive("treasury"), retryOpts);
  const actionKey = await withRetry(() => kms.derive("action"), retryOpts);
  const fcSeed = await withRetry(() => kms.derive("fc"), retryOpts);
  const memKey = await withRetry(() => kms.derive("mem"), retryOpts);
  const chatKey = await withRetry(() => kms.derive("chat"), retryOpts);

  // SPEC-M3B §2 lazy TLS derives (memoized; a failed derive is retried on the next call).
  const lazy = new Map<string, Promise<Hex>>();
  function lazyDerive(path: string): Promise<Hex> {
    let p = lazy.get(path);
    if (p === undefined) {
      p = withRetry(() => kms.derive(path), retryOpts);
      lazy.set(path, p);
      p.catch(() => lazy.delete(path));
    }
    return p;
  }

  const treasuryAccount: PrivateKeyAccount = privateKeyToAccount(treasuryKey);
  const actionAccount: PrivateKeyAccount = privateKeyToAccount(actionKey);
  const fcPublicKey: Hex = await ed25519PublicKey(fcSeed);

  const ownAddresses: OwnAddresses = {
    treasury: treasuryAccount.address,
    action: actionAccount.address,
  };

  let cfg: ResolvedConfig | undefined;

  /** K1 consumed set: key `${actionHash}:${issuedAt}` → issuedAt. */
  const consumed = new Map<string, bigint>();

  function requireCfg(): ResolvedConfig {
    if (cfg === undefined) throw new Error("keyring: no config attached");
    return cfg;
  }

  function evmAccountFor(kind: ProposedAction["kind"]): PrivateKeyAccount {
    const w = walletForAction(kind);
    if (w === "treasury") return treasuryAccount;
    if (w === "action") return actionAccount;
    throw new Error(`keyring: kind "${kind}" has no EVM signing key (wallet ${w})`);
  }

  /** K1 (hash → TTL → single-use). Throws on any failure; marks the approval consumed on success. */
  function gate(action: ProposedAction, approval: Approval, now: UnixSeconds): void {
    const recomputed = computeActionHash(action);
    if (recomputed !== approval.actionHash) {
      throw new Error("approval mismatch");
    }
    const ttl = BigInt(approval.ttlSec);
    if (now > approval.issuedAt + ttl) {
      throw new Error("approval expired");
    }
    // Prune entries older than 10 × TTL.
    for (const [k, issuedAt] of consumed) {
      if (issuedAt + CONSUMED_RETENTION_TTLS * ttl < now) consumed.delete(k);
    }
    const key = `${approval.actionHash}:${approval.issuedAt.toString(10)}`;
    if (consumed.has(key)) {
      throw new Error("approval already used");
    }
    consumed.set(key, approval.issuedAt);
  }

  function checkFill(fill: TxFill, chain: keyof ResolvedConfig["maxFeePerGasWei"], c: ResolvedConfig): void {
    if (typeof fill.nonce !== "number" || !Number.isSafeInteger(fill.nonce) || fill.nonce < 0) {
      throw new Error("fill: nonce must be a non-negative safe integer");
    }
    if (typeof fill.gasLimit !== "bigint" || fill.gasLimit <= 0n) throw new Error("fill: gasLimit must be a bigint > 0");
    if (fill.gasLimit > c.maxGasLimit) throw new Error(`fill: gasLimit ${fill.gasLimit} > maxGasLimit ${c.maxGasLimit}`);
    if (typeof fill.maxFeePerGas !== "bigint" || fill.maxFeePerGas <= 0n) throw new Error("fill: maxFeePerGas must be a bigint > 0");
    const cap = c.maxFeePerGasWei[chain];
    if (fill.maxFeePerGas > cap) throw new Error(`fill: maxFeePerGas ${fill.maxFeePerGas} > cap ${cap} on ${chain}`);
    if (typeof fill.maxPriorityFeePerGas !== "bigint" || fill.maxPriorityFeePerGas < 0n) {
      throw new Error("fill: maxPriorityFeePerGas must be a bigint >= 0");
    }
    if (fill.maxPriorityFeePerGas > fill.maxFeePerGas) throw new Error("fill: maxPriorityFeePerGas > maxFeePerGas");
  }

  return {
    addresses(): OwnAddresses {
      return ownAddresses;
    },

    attachConfig(c: ResolvedConfig): void {
      if (cfg !== undefined) throw new Error("keyring: config already attached");
      if (!sameAddress(c.treasury, ownAddresses.treasury) || !sameAddress(c.action, ownAddresses.action)) {
        throw new Error("keyring: config own addresses do not match the keyring");
      }
      cfg = c;
    },

    updateAllowlist(entries: readonly X402AllowlistEntry[]): void {
      const c = requireCfg();
      cfg = { ...c, x402Allowlist: entries.map((e) => ({ ...e })) };
    },

    async signApproved(action: ProposedAction, approval: Approval, now: UnixSeconds): Promise<Hex> {
      const account = evmAccountFor(action.kind);
      gate(action, approval, now);
      return account.signMessage({ message: { raw: approval.actionHash } });
    },

    async signTxApproved(action: ProposedAction, approval: Approval, fill: TxFill, now: UnixSeconds): Promise<Hex> {
      const c = requireCfg();
      const account = evmAccountFor(action.kind);
      if (action.kind === "inference") throw new Error("K2: inference has no transaction (use signX402AuthApproved)");
      gate(action, approval, now);
      // (b) body recomputed here — never taken from the caller.
      const built = buildTx(action, c, approval.issuedAt);
      // (c) bounds on the chain-supplied fields.
      checkFill(fill, built.chain, c);
      return account.signTransaction({
        type: "eip1559",
        chainId: built.chainId,
        to: built.to,
        value: built.value,
        data: built.data,
        nonce: fill.nonce,
        gas: fill.gasLimit,
        maxFeePerGas: fill.maxFeePerGas,
        maxPriorityFeePerGas: fill.maxPriorityFeePerGas,
      });
    },

    async signX402AuthApproved(
      action: ProposedAction,
      approval: Approval,
      auth: X402AuthInput,
      now: UnixSeconds,
    ): Promise<SignedX402Auth> {
      const c = requireCfg();
      if (action.kind !== "inference") throw new Error(`K3: kind "${action.kind}" is not inference`);
      gate(action, approval, now);
      const entry = c.x402Allowlist.find((e) => e.id === action.endpointId && e.kind === "inference");
      if (entry === undefined) throw new Error(`K3: endpoint "${action.endpointId}" is not an allowlisted inference endpoint`);
      if (!sameAddress(auth.to, entry.payTo)) throw new Error(`K3: auth.to ${auth.to} != allowlist payTo ${entry.payTo}`);
      if (auth.from !== undefined && !sameAddress(auth.from, ownAddresses.treasury)) {
        throw new Error("K3: auth.from must be the own treasury EOA");
      }
      if (typeof auth.value !== "bigint" || auth.value <= 0n) throw new Error("K3: auth.value must be a bigint > 0");
      if (auth.value > action.maxCostUsd) throw new Error(`K3: auth.value ${auth.value} > maxCostUsd ${action.maxCostUsd}`);
      if (typeof auth.validAfter !== "bigint" || typeof auth.validBefore !== "bigint" || auth.validAfter < 0n) {
        throw new Error("K3: validAfter/validBefore must be non-negative bigints");
      }
      if (auth.validBefore <= auth.validAfter) throw new Error("K3: validBefore must be > validAfter");
      if (auth.validBefore - auth.validAfter > X402_MAX_WINDOW_SEC) {
        throw new Error(`K3: validity window ${auth.validBefore - auth.validAfter}s > ${X402_MAX_WINDOW_SEC}s`);
      }
      const expectedNonce = x402Nonce(approval.actionHash);
      if (typeof auth.nonce !== "string" || auth.nonce.toLowerCase() !== expectedNonce) {
        throw new Error("K3: auth.nonce != keccak256(actionHash ‖ \"x402\")");
      }
      const authorization: X402Authorization = {
        from: ownAddresses.treasury,
        to: auth.to,
        value: auth.value,
        validAfter: auth.validAfter,
        validBefore: auth.validBefore,
        nonce: expectedNonce,
      };
      const d = c.usdcDomain.base;
      const signature = await treasuryAccount.signTypedData({
        domain: { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract },
        types: transferWithAuthorizationTypes,
        primaryType: "TransferWithAuthorization",
        message: authorization,
      });
      return { authorization, signature };
    },

    async signCastApproved(action: ProposedAction, approval: Approval, messageBytes: Uint8Array, now: UnixSeconds): Promise<Hex> {
      if (action.kind !== "castPost" && action.kind !== "castReply") {
        throw new Error(`K4: kind "${action.kind}" is not a cast`);
      }
      gate(action, approval, now);
      if (!(messageBytes instanceof Uint8Array)) throw new Error("K4: messageBytes must be a Uint8Array");
      if (keccak256(messageBytes) !== action.contentHash.toLowerCase()) {
        throw new Error("K4: keccak256(messageBytes) != contentHash");
      }
      return ed25519Sign(fcSeed, messageBytes);
    },

    farcasterPublicKey(): Hex {
      return fcPublicKey;
    },

    memKeyForMemoryModule(): Hex {
      return memKey;
    },

    chatSessionKey(): Hex {
      return chatKey;
    },

    acmeAccountKey(): Promise<Hex> {
      return lazyDerive("acme");
    },

    tlsPlaceholderKey(): Promise<Hex> {
      return lazyDerive("tls");
    },

    turboSigner(): TurboSigner {
      const publicKey = hexToBytes(treasuryAccount.publicKey);
      return Object.freeze({
        signatureType: 3 as const,
        ownerLength: 65 as const,
        signatureLength: 65 as const,
        publicKey,
        address: treasuryAccount.address,
        async sign(message: Uint8Array): Promise<Uint8Array> {
          if (!(message instanceof Uint8Array) || !TURBO_SIGN_LENGTHS.includes(message.length)) {
            throw new Error(`turboSigner: refusing to sign a ${message instanceof Uint8Array ? message.length : typeof message}-byte message (only 48-byte ANS-104 deep hashes)`);
          }
          return hexToBytes(await treasuryAccount.signMessage({ message: { raw: message } }));
        },
      });
    },

    attestationSigner(): AttestationSigner {
      return Object.freeze({
        address: treasuryAccount.address,
        async sign(payloadBytes: Uint8Array): Promise<Hex> {
          if (!(payloadBytes instanceof Uint8Array) || payloadBytes.length === 0) {
            throw new Error("attestationSigner: payload must be a non-empty Uint8Array");
          }
          return treasuryAccount.signMessage({ message: { raw: attestationDigest(payloadBytes) } });
        },
      });
    },
  };
}
