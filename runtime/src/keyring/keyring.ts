// SPEC-M2 §5. Holds derived keys; signs ONLY policy-approved payloads.
// No Date.now anywhere here — time is always a parameter (`now`).

import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";
import { actionHash as computeActionHash } from "../policy/approval.js";
import { walletForAction, type Approval, type OwnAddresses, type ProposedAction, type UnixSeconds } from "../policy/types.js";
import { withRetry, type KmsClient, type WithRetryOptions } from "./kms.js";

export interface Keyring {
  addresses(): OwnAddresses;
  signApproved(action: ProposedAction, approval: Approval, now: UnixSeconds): Promise<Hex>;
  farcasterPublicKey(): Hex;
  /** Scoped to the memory module only: raw key material for encrypting/decrypting memory state. */
  memKeyForMemoryModule(): Hex;
}

export interface CreateKeyringOptions {
  /** Overrides withRetry's defaults for boot-time derives (tests use small delays). */
  retry?: WithRetryOptions;
}

export async function createKeyring(kms: KmsClient, opts?: CreateKeyringOptions): Promise<Keyring> {
  const retryOpts = opts?.retry;

  // Sequential, deterministic derive order: treasury, action, fc, mem.
  const treasuryKey = await withRetry(() => kms.derive("treasury"), retryOpts);
  const actionKey = await withRetry(() => kms.derive("action"), retryOpts);
  const fcKey = await withRetry(() => kms.derive("fc"), retryOpts);
  const memKey = await withRetry(() => kms.derive("mem"), retryOpts);

  const treasuryAccount: PrivateKeyAccount = privateKeyToAccount(treasuryKey);
  const actionAccount: PrivateKeyAccount = privateKeyToAccount(actionKey);
  const fcAccount: PrivateKeyAccount = privateKeyToAccount(fcKey);

  const ownAddresses: OwnAddresses = {
    treasury: treasuryAccount.address,
    action: actionAccount.address,
  };

  function accountFor(kind: ProposedAction["kind"]): PrivateKeyAccount {
    return walletForAction(kind) === "treasury" ? treasuryAccount : actionAccount;
  }

  return {
    addresses(): OwnAddresses {
      return ownAddresses;
    },

    async signApproved(action: ProposedAction, approval: Approval, now: UnixSeconds): Promise<Hex> {
      const recomputed = computeActionHash(action);
      if (recomputed !== approval.actionHash) {
        throw new Error("approval mismatch");
      }
      if (now > approval.issuedAt + BigInt(approval.ttlSec)) {
        throw new Error("approval expired");
      }
      const account = accountFor(action.kind);
      return account.signMessage({ message: { raw: approval.actionHash } });
    },

    farcasterPublicKey(): Hex {
      return fcAccount.publicKey;
    },

    memKeyForMemoryModule(): Hex {
      return memKey;
    },
  };
}
