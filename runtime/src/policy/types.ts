// SPEC-M2 §2 (types, normative) + §3 (DenyCode enum). Transcribed exactly.
// SPEC-M3C §1–§3 (additive): WalletState.staleChains, DenyCode STATE_STALE, chainsTouched().
// SPEC-M3D §3d (additive): kinds fcRegister / fcAddKey (treasury, optimism) and fcUserData (fc);
// OwnAddresses.fcPublicKey; BudgetLedger.fcUserDataToday.
// No `any` anywhere in this file.

import type { Address, Hex } from "viem";

export type Chain = "rh" | "base" | "arbitrum" | "optimism";

export type UnixSeconds = bigint; // seconds

// Amounts: bigint in the asset's base units. USDG/USDC: 6 decimals. ETH: wei.

export interface OwnAddresses {
  // derived by keyring at boot, injected into ResolvedConfig
  treasury: Address;
  action: Address; // same EOA addresses on every EVM chain
  // SPEC-M3D §3d: the fc key's 32-byte ed25519 public key (keyring-derived) — T7 fcAddKey only admits it.
  // Optional: absent ⇒ T7 denies every fcAddKey (fail closed).
  fcPublicKey?: Hex;
}

export type TreasuryPurpose =
  | "oysterRental" // USDC, arbitrum, to cfg.marlin.paymentAddresses[], own jobId only
  | "acrossBridge" // USDG(rh)/USDC, to cfg.across.spokePool[chain]; recipient MUST be own EOA
  | "arweaveFunding" // SPEC-M3D §1d: base ETH to cfg.arweaveFundingAddress (Turbo's payment wallet)
  | "gasTopUp" // native ETH, any supported chain, to OWN EOAs only
  | "x402Data"; // USDC, base, to an allowlisted data/search endpoint payTo
// rev 1: "x402Inference" REMOVED as a transfer purpose — inference is paid
// EXCLUSIVELY via the metered `inference` kind (no double I1 budget).

export type ProposedAction =
  | { kind: "heartbeat" } // treasury; RH registry.heartbeat(agentId)
  | { kind: "registerInstance" } // treasury; RH registry, boot/revival only
  | { kind: "distribute" } // treasury; RH FeeSplitHook.distribute(own pool)
  | {
      kind: "treasuryTransfer";
      purpose: TreasuryPurpose;
      chain: Chain;
      asset: "USDG" | "USDC" | "ETH";
      to: Address;
      amount: bigint;
      recipient?: Address; // recipient: bridge final recipient (acrossBridge only)
      destChain?: Chain; // SPEC-M2B §3: REQUIRED for acrossBridge (≠ chain), forbidden otherwise (G1)
    }
  | { kind: "allowance"; amount: bigint } // treasury -> action EOA, USDG on RH
  | {
      kind: "treasurySwap"; // income conversion, 03 §8
      tokenIn: Address;
      amountIn: bigint;
      minOut: bigint; // tokenOut USDG implied; RH PoolManager only
    }
  | {
      kind: "inference";
      category: "pulse" | "chat" | "social";
      endpointId: string;
      maxCostUsd: bigint; // paid from Base USDC via x402
      // SPEC-M3 §3: OPTIONAL per-call salt, exactly 16 bytes hex (G1). Deterministic at the call
      // site; participates in canonicalEncode ⇒ actionHash ⇒ K3 x402 nonce (same-second uniqueness).
      salt?: Hex;
    }
  | {
      kind: "actionTransfer"; // action EOA, RH only
      asset: Address | "USDG" | "ETH";
      to: Address;
      amount: bigint;
    }
  | {
      kind: "actionSwap"; // RH PoolManager only
      tokenIn: Address | "USDG";
      tokenOut: Address | "USDG";
      amountIn: bigint;
      minOut: bigint;
    }
  | { kind: "actionLp"; pool: Hex; usdgAmount: bigint; tokenAmount: bigint; token: Address }
  | { kind: "actionMint"; target: Address; value: bigint } // NFT mint, value = ETH sent
  // SPEC-M2B §1 (additive):
  | { kind: "castPost"; contentHash: Hex } // Farcaster post (fc key)
  | { kind: "castReply"; contentHash: Hex; parentHash: Hex } // Farcaster reply
  | { kind: "journalWrite"; contentHash: Hex; sizeBytes: bigint } // Arweave journal entry
  | { kind: "actionApprove"; token: Address; spender: Address; amount: bigint } // action EOA, RH
  | { kind: "treasuryApprove"; token: Address; spender: Address; amount: bigint } // treasury EOA, RH (for T5 swaps)
  // SPEC-M3D §3d (additive; treasury EOA, optimism; EXCLUDED from the LLM tool schema):
  | { kind: "fcRegister"; priceWei: bigint } // IdGateway.register(recovery = treasury){value: priceWei}
  | { kind: "fcAddKey"; key: Hex; metadata: Hex } // KeyGateway.add(1, key, 1, metadata)
  // SPEC-M3D §3d social (fc key, K4-signed, published via fcSink like casts):
  | { kind: "fcUserData"; contentHash: Hex; sizeBytes: bigint };

// WalletBalances: the per-chain balance shape referenced by WalletState's
// `treasury` and `action` fields ("(shape above, per wallet)" in SPEC-M2 §2).
export type WalletBalances = Record<
  Chain,
  {
    native: bigint;
    USDG?: bigint;
    USDC?: bigint;
    tokens?: Record<Address, bigint>;
  }
>;

export interface WalletState {
  treasury: WalletBalances;
  action: WalletBalances;
  hostingPaidUntil: UnixSeconds; // current Oyster rental expiry
  hostingRatePerDay: bigint; // USDC(6) per day, live marketplace rate
  // SPEC-M3C §1: chains whose balances in THIS state object are NOT fresh reads (cached or zeroed).
  // Absent/empty ⇒ all fresh. The engine's G5 gate denies STATE_STALE on any intersection with
  // chainsTouched(action).
  staleChains?: readonly Chain[];
}

// ADDITIVE (M2 policy-engine agent): SPEC-M2 §3 T3 tracks gasTopUp per chain
// under a `gasTopUp:<chain>` subkey of treasurySpent; the original
// Record<TreasuryPurpose, ...> key type could not express it.
export type TreasurySpentKey = TreasuryPurpose | `gasTopUp:${Chain}`;

export interface BudgetLedger {
  lastAllowanceAt: UnixSeconds; // 0n if never
  allowanceAmountToday: bigint; // amount of the last allowance (for A2 denominator)
  dayKey: string; // "YYYY-MM-DD" UTC; reducers reset daily buckets only when the day advances (G4)
  inferenceSpent: { pulse: bigint; chat: bigint; social: bigint }; // USD(6), today
  treasurySpent: Partial<Record<TreasurySpentKey, bigint>>; // today, per purpose, in the purpose's asset units
  counterpartySpent: Record<Address /* lowercase */, Record<string /* assetKey */, bigint>>; // action wallet, today
  feeIncome7d: bigint[]; // last 7 complete UTC days of treasury fee income, USDG(6)
  // SPEC-M2B §1: social/journal pace counters (today; reset on forward roll per G4).
  castPostsToday: bigint;
  castRepliesToday: bigint;
  journalToday: bigint;
  // SPEC-M3D §3d: S3 fcUserData pace counter (today; reset on forward roll per G4).
  fcUserDataToday: bigint;
}

// DenyCode: stable strings (logged + surfaced in chat per 03 §3).
export type DenyCode =
  | "MALFORMED"
  | "NO_RULE"
  | "INSUFFICIENT_BALANCE"
  | "RUNWAY"
  | "WHITELIST"
  | "BRIDGE_RECIPIENT"
  | "DAILY_CAP"
  | "ALLOWANCE_EARLY"
  | "ALLOWANCE_AMOUNT"
  | "INFERENCE_BUDGET"
  | "ENDPOINT"
  | "PER_CALL_CAP"
  | "CHAIN"
  | "PER_TX_CAP"
  | "COUNTERPARTY_CAP"
  | "LOOKALIKE"
  // SPEC-M2B §1:
  | "PACE_CAP"
  | "APPROVE_SPENDER"
  // SPEC-M3C §3:
  | "STATE_STALE";

export interface Approval {
  actionHash: Hex;
  issuedAt: UnixSeconds;
  ttlSec: 60;
}

export type Verdict = { allow: true; approval: Approval } | { allow: false; code: DenyCode; detail: string };

const TREASURY_KINDS: ReadonlySet<ProposedAction["kind"]> = new Set([
  "heartbeat",
  "registerInstance",
  "distribute",
  "treasuryTransfer",
  "allowance",
  "treasurySwap",
  "inference",
  "treasuryApprove",
  // SPEC-M3D §3d
  "fcRegister",
  "fcAddKey",
]);

const ACTION_KINDS: ReadonlySet<ProposedAction["kind"]> = new Set([
  "actionTransfer",
  "actionSwap",
  "actionLp",
  "actionMint",
  "actionApprove",
]);

// SPEC-M2B §1: social kinds route to the fc key; journal to the arweave/mem path.
const FC_KINDS: ReadonlySet<ProposedAction["kind"]> = new Set(["castPost", "castReply", "fcUserData"]); // + SPEC-M3D §3d
const JOURNAL_KINDS: ReadonlySet<ProposedAction["kind"]> = new Set(["journalWrite"]);

export type WalletKind = "treasury" | "action" | "fc" | "journal";

export function walletForAction(kind: ProposedAction["kind"]): WalletKind {
  if (TREASURY_KINDS.has(kind)) return "treasury";
  if (ACTION_KINDS.has(kind)) return "action";
  if (FC_KINDS.has(kind)) return "fc";
  if (JOURNAL_KINDS.has(kind)) return "journal";
  throw new Error(`walletForAction: unknown kind ${String(kind)}`);
}

/**
 * SPEC-M3C §2 (ruling, exact): the chains whose balances the rules read and/or where the tx lands.
 * Social/journal kinds touch no chain balances ⇒ [] (never stale-blocked). Pure.
 */
export function chainsTouched(a: ProposedAction): readonly Chain[] {
  switch (a.kind) {
    case "heartbeat":
    case "registerInstance":
    case "distribute":
    case "allowance":
    case "treasurySwap":
    case "treasuryApprove":
    case "actionTransfer":
    case "actionSwap":
    case "actionLp":
    case "actionMint":
    case "actionApprove":
      return ["rh"];
    case "treasuryTransfer":
      return a.destChain !== undefined ? [a.chain, a.destChain] : [a.chain];
    case "inference":
      return ["base"]; // x402 pays Base USDC
    case "fcRegister":
    case "fcAddKey":
      return ["optimism"]; // SPEC-M3D §3d: Farcaster contracts live on OP mainnet
    case "castPost":
    case "castReply":
    case "journalWrite":
    case "fcUserData":
      return [];
    default: {
      const unknownKind: never = a;
      throw new Error(`chainsTouched: unknown kind ${String((unknownKind as { kind?: unknown }).kind)}`);
    }
  }
}
