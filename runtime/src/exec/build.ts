// SPEC-M2B §3. buildTx(action, cfg, now): pure, config-only transaction
// builder. The keyring (K2) recomputes this for every signature, so `to`,
// `value`, `data` and `chainId` can never come from the LLM or the executor.
//
// `now` is used only by acrossBridge (quoteTimestamp / fillDeadline). Both the
// executor and the keyring pass `approval.issuedAt`, so the signed tx is a pure
// function of (action, approval, fill, cfg).
// SPEC-M3D §1c: quoteTimestamp = now − ACROSS_QUOTE_SAFETY_SEC (a host clock ahead of chain time
// reverts InvalidQuoteTimestamp() 0xf722177f — live-proven); fillDeadline stays now + 4h.
//
// Kinds with no transaction (inference, castPost, castReply, journalWrite, fcUserData)
// throw NoTxError.
// SPEC-M3D §3d: fcRegister ⇒ IdGateway.register(recovery = treasury){value: priceWei}; fcAddKey ⇒
// KeyGateway.add(1, key, 1, metadata); both on optimism, targets from the FROZEN platform.farcaster
// (never from the action) — absent config ⇒ throws. actionLp throws NotImplementedError: the deployments
// manifest (contracts/deployments/testnet-46630.json) has no
// modifyLiquidityRouter.

import { encodeFunctionData, type Address, type Hex } from "viem";
import type { ResolvedConfig } from "../config/schema.js";
import type { Chain, ProposedAction, UnixSeconds } from "../policy/types.js";
import { applyBps, BPS_DENOM, sameAddress } from "../policy/util.js";
import {
  acrossSpokePoolAbi,
  agentRegistryAbi,
  erc20Abi,
  FC_KEY_TYPE_ED25519,
  FC_METADATA_TYPE_SIGNED_KEY_REQUEST,
  fcIdGatewayAbi,
  fcKeyGatewayAbi,
  feeSplitHookAbi,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  MINT_SELECTOR,
  poolSwapTestAbi,
} from "./abi.js";

export interface BuiltTx {
  chain: Chain;
  chainId: number;
  to: Address;
  value: bigint;
  data: Hex;
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

export class NoTxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoTxError";
  }
}

/** Across fillDeadline = now + 4h (SPEC-M2B §3; SPEC-M3D §1c keeps it anchored on now, not on quoteTimestamp). */
export const ACROSS_FILL_WINDOW_SEC = 4n * 3600n;
/** SPEC-M3D §1c: quoteTimestamp = now − this (tolerates a host clock up to 60 s ahead of chain time). */
export const ACROSS_QUOTE_SAFETY_SEC = 60n;
const UINT32_MAX = 4_294_967_295n;

/** Kinds that produce an on-chain transaction via buildTx. */
export const TX_KINDS: ReadonlySet<ProposedAction["kind"]> = new Set([
  "heartbeat",
  "registerInstance",
  "distribute",
  "treasuryTransfer",
  "allowance",
  "treasurySwap",
  "actionTransfer",
  "actionSwap",
  "actionLp",
  "actionMint",
  "actionApprove",
  "treasuryApprove",
  // SPEC-M3D §3d
  "fcRegister",
  "fcAddKey",
]);

export function isTxKind(kind: ProposedAction["kind"]): boolean {
  return TX_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// Pool key (mirrors contracts/script/support/LaunchpadScript.sol:93-98 poolKeyOf
// and contracts/script/Lifecycle.s.sol:347-360 _swap)
// ---------------------------------------------------------------------------

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** AGENT/USDG pool key: currencies sorted numerically by address, fee/tickSpacing/hook from config. */
export function poolKeyFor(token: Address, cfg: ResolvedConfig): PoolKey {
  const usdg = cfg.usdg.rh;
  const tokenFirst = BigInt(token) < BigInt(usdg);
  return {
    currency0: tokenFirst ? token : usdg,
    currency1: tokenFirst ? usdg : token,
    fee: cfg.poolFee,
    tickSpacing: cfg.tickSpacing,
    hooks: cfg.feeSplitHook.rh,
  };
}

/**
 * PoolSwapTest.swap calldata for an exact-input swap of `amountIn` of
 * `tokenIn` against `key`. Mirrors Lifecycle.s.sol `_swap`: amountSpecified =
 * -amountIn (negative ⇒ exact-in), sqrtPriceLimitX96 = MIN+1 / MAX-1,
 * TestSettings{takeClaims:false, settleUsingBurn:false}, hookData "".
 * NOTE: PoolSwapTest enforces NO minimum output — `minOut` is not encodable here.
 */
export function swapCalldata(key: PoolKey, tokenIn: Address, amountIn: bigint): Hex {
  const zeroForOne = sameAddress(key.currency0, tokenIn);
  if (!zeroForOne && !sameAddress(key.currency1, tokenIn)) {
    throw new Error(`swapCalldata: tokenIn ${tokenIn} is not a currency of the pool`);
  }
  return encodeFunctionData({
    abi: poolSwapTestAbi,
    functionName: "swap",
    args: [
      key,
      {
        zeroForOne,
        amountSpecified: -amountIn,
        sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
      },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    ],
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function erc20Transfer(token: Address, to: Address, amount: bigint): { to: Address; value: bigint; data: Hex } {
  return { to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) };
}

function tx(chain: Chain, cfg: ResolvedConfig, body: { to: Address; value: bigint; data: Hex }): BuiltTx {
  return { chain, chainId: cfg.chainIds[chain], ...body };
}

function wethOf(cfg: ResolvedConfig, chain: Chain): Address {
  const w = cfg.weth;
  if (w === undefined) throw new Error(`buildTx: cfg.weth is required for native-ETH Across bridges`);
  return w[chain];
}

/** Source-chain input token for an Across deposit. */
function bridgeInputToken(asset: "USDG" | "USDC" | "ETH", chain: Chain, cfg: ResolvedConfig): Address {
  if (asset === "ETH") return wethOf(cfg, chain);
  if (asset === "USDG") return cfg.usdg[chain];
  return cfg.usdc[chain];
}

/**
 * Destination-chain output token. ETH ⇒ WETH on dest (Across unwraps to native
 * for EOAs). Stablecoins (USDG/USDC, counted 1:1 by T3) ⇒ the destination
 * chain's canonical stable: USDG on rh, USDC elsewhere (so the daemon's
 * "USDG rh → base" refill lands as Base USDC, where inference is paid).
 */
function bridgeOutputToken(asset: "USDG" | "USDC" | "ETH", dest: Chain, cfg: ResolvedConfig): Address {
  if (asset === "ETH") return wethOf(cfg, dest);
  return dest === "rh" ? cfg.usdg.rh : cfg.usdc[dest];
}

type TreasuryTransfer = Extract<ProposedAction, { kind: "treasuryTransfer" }>;

function buildAcrossDeposit(a: TreasuryTransfer, cfg: ResolvedConfig, now: UnixSeconds): BuiltTx {
  const dest = a.destChain;
  if (dest === undefined) throw new Error("buildTx: acrossBridge requires destChain");
  if (dest === a.chain) throw new Error("buildTx: acrossBridge destChain must differ from source chain");
  if (a.recipient === undefined) throw new Error("buildTx: acrossBridge requires recipient");
  const spoke = cfg.across.spokePool[a.chain];
  if (!sameAddress(a.to, spoke)) throw new Error(`buildTx: acrossBridge to ${a.to} is not the ${a.chain} SpokePool`);
  if (now < ACROSS_QUOTE_SAFETY_SEC || now + ACROSS_FILL_WINDOW_SEC > UINT32_MAX) throw new Error("buildTx: now out of uint32 range");

  const outputAmount = applyBps(a.amount, Number(BPS_DENOM) - cfg.bridgeMaxFeeBps);
  const data = encodeFunctionData({
    abi: acrossSpokePoolAbi,
    functionName: "depositV3",
    args: [
      cfg.treasury, // depositor = self
      a.recipient,
      bridgeInputToken(a.asset, a.chain, cfg),
      bridgeOutputToken(a.asset, dest, cfg),
      a.amount, // inputAmount
      outputAmount,
      BigInt(cfg.chainIds[dest]),
      "0x0000000000000000000000000000000000000000", // exclusiveRelayer
      Number(now - ACROSS_QUOTE_SAFETY_SEC), // quoteTimestamp (SPEC-M3D §1c)
      Number(now + ACROSS_FILL_WINDOW_SEC), // fillDeadline
      0, // exclusivityDeadline
      "0x", // message
    ],
  });
  return tx(a.chain, cfg, { to: spoke, value: a.asset === "ETH" ? a.amount : 0n, data });
}

function buildTreasuryTransfer(a: TreasuryTransfer, cfg: ResolvedConfig, now: UnixSeconds): BuiltTx {
  if (a.purpose === "acrossBridge") return buildAcrossDeposit(a, cfg, now);
  if (a.asset === "ETH") return tx(a.chain, cfg, { to: a.to, value: a.amount, data: "0x" });
  const token = a.asset === "USDG" ? cfg.usdg[a.chain] : cfg.usdc[a.chain];
  return tx(a.chain, cfg, erc20Transfer(token, a.to, a.amount));
}

// ---------------------------------------------------------------------------
// buildTx
// ---------------------------------------------------------------------------

export function buildTx(action: ProposedAction, cfg: ResolvedConfig, now: UnixSeconds): BuiltTx {
  const agentId = BigInt(cfg.agent.agentId);
  switch (action.kind) {
    case "heartbeat":
      return tx("rh", cfg, {
        to: cfg.registry.rh,
        value: 0n,
        data: encodeFunctionData({ abi: agentRegistryAbi, functionName: "heartbeat", args: [agentId] }),
      });
    case "registerInstance": {
      const reg = cfg.registration;
      if (reg === undefined) throw new Error("buildTx: registerInstance requires cfg.registration {codeHash, attestationRef}");
      return tx("rh", cfg, {
        to: cfg.registry.rh,
        value: 0n,
        data: encodeFunctionData({
          abi: agentRegistryAbi,
          functionName: "registerInstance",
          args: [agentId, cfg.treasury, cfg.action, reg.codeHash, reg.attestationRef],
        }),
      });
    }
    case "distribute": {
      const poolId = cfg.agentPoolId;
      if (poolId === undefined) throw new Error("buildTx: distribute requires cfg.agentPoolId");
      return tx("rh", cfg, {
        to: cfg.feeSplitHook.rh,
        value: 0n,
        // minConversionOut = 0: the hook's own impact cap (MAX_IMPACT_BPS floor) bounds the conversion leg.
        data: encodeFunctionData({ abi: feeSplitHookAbi, functionName: "distribute", args: [poolId, 0n] }),
      });
    }
    case "treasuryTransfer":
      return buildTreasuryTransfer(action, cfg, now);
    case "allowance":
      return tx("rh", cfg, erc20Transfer(cfg.usdg.rh, cfg.action, action.amount));
    case "treasurySwap": {
      const key = poolKeyFor(action.tokenIn, cfg);
      return tx("rh", cfg, { to: cfg.swapRouter.rh, value: 0n, data: swapCalldata(key, action.tokenIn, action.amountIn) });
    }
    case "actionTransfer": {
      if (action.asset === "ETH") return tx("rh", cfg, { to: action.to, value: action.amount, data: "0x" });
      const token = action.asset === "USDG" ? cfg.usdg.rh : action.asset;
      return tx("rh", cfg, erc20Transfer(token, action.to, action.amount));
    }
    case "actionSwap": {
      const tokenIn = action.tokenIn === "USDG" ? cfg.usdg.rh : action.tokenIn;
      let other: Address;
      if (action.tokenIn === "USDG" && action.tokenOut !== "USDG") other = action.tokenOut;
      else if (action.tokenOut === "USDG" && action.tokenIn !== "USDG") other = action.tokenIn;
      else throw new NotImplementedError("buildTx: actionSwap without exactly one USDG leg has no single AGENT/USDG pool");
      const key = poolKeyFor(other, cfg);
      return tx("rh", cfg, { to: cfg.swapRouter.rh, value: 0n, data: swapCalldata(key, tokenIn, action.amountIn) });
    }
    case "actionLp":
      throw new NotImplementedError(
        "actionLp: no modifyLiquidityRouter in contracts/deployments/testnet-46630.json — tool absent from LLM schema",
      );
    case "actionMint":
      return tx("rh", cfg, { to: action.target, value: action.value, data: MINT_SELECTOR });
    case "actionApprove":
    case "treasuryApprove":
      return tx("rh", cfg, {
        to: action.token,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [action.spender, action.amount] }),
      });
    case "fcRegister": {
      const fc = cfg.farcaster;
      if (fc === undefined) throw new Error("buildTx: fcRegister requires platform.farcaster");
      return tx("optimism", cfg, {
        to: fc.idGateway,
        value: action.priceWei,
        data: encodeFunctionData({ abi: fcIdGatewayAbi, functionName: "register", args: [cfg.treasury] }),
      });
    }
    case "fcAddKey": {
      const fc = cfg.farcaster;
      if (fc === undefined) throw new Error("buildTx: fcAddKey requires platform.farcaster");
      return tx("optimism", cfg, {
        to: fc.keyGateway,
        value: 0n,
        data: encodeFunctionData({
          abi: fcKeyGatewayAbi,
          functionName: "add",
          args: [FC_KEY_TYPE_ED25519, action.key, FC_METADATA_TYPE_SIGNED_KEY_REQUEST, action.metadata],
        }),
      });
    }
    case "inference":
    case "castPost":
    case "castReply":
    case "journalWrite":
    case "fcUserData":
      throw new NoTxError(`buildTx: kind "${action.kind}" has no transaction`);
  }
}
