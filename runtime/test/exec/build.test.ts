// SPEC-M2B §3 buildTx golden tests. Expected calldata is encoded INDEPENDENTLY in
// this file from human-readable Solidity signatures (parseAbi), not from src/exec/abi.ts.
// SPEC-M3C §9.3 (appended): buildTx(a).chain ∈ chainsTouched(a) consistency.

import { encodeFunctionData, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../src/config/schema.js";
import { buildTx, NoTxError, NotImplementedError, poolKeyFor } from "../../src/exec/build.js";
import { chainsTouched, type ProposedAction } from "../../src/policy/types.js";
import {
  ACTION, AGENT_POOL_ID, ARWEAVE, CODE_HASH, CP, E18, E6, MARLIN_PAY, NOW, PAYTO_DATA, SPOKE, SWAP_ROUTER,
  TOKEN_X, TOKEN_Y, TREASURY, USDC, USDG_RH, WETH, agentJson, cfg, platformJson,
} from "../policy/helpers.js";

const ERC20 = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const REGISTRY = parseAbi([
  "function heartbeat(uint256 agentId)",
  "function registerInstance(uint256 agentId, address treasuryEOA, address actionEOA, bytes32 codeHash, string attestationRef)",
]);
const HOOK = parseAbi(["function distribute(bytes32 poolId, uint256 minConversionOut)"]);
const SPOKE_ABI = parseAbi([
  "function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable",
]);
const SWAP = parseAbi([
  "function swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, (bool takeClaims, bool settleUsingBurn) testSettings, bytes hookData) payable returns (int256 delta)",
]);
// TickMath.sol:31/33, restated independently.
const MIN_SQRT_PLUS_1 = 4295128739n + 1n;
const MAX_SQRT_MINUS_1 = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = "0x0000000000000000000000000000000000000000";
const HOOK_RH = cfg.feeSplitHook.rh;

const lc = (a: string): string => a.toLowerCase();

function expectTx(
  got: ReturnType<typeof buildTx>,
  want: { chain: string; chainId: number; to: Address; value: bigint; data: Hex },
): void {
  expect(got.chain).toBe(want.chain);
  expect(got.chainId).toBe(want.chainId);
  expect(lc(got.to)).toBe(lc(want.to));
  expect(got.value).toBe(want.value);
  expect(got.data).toBe(want.data);
}

describe("selectors (sanity vs canonical Solidity signatures)", () => {
  it("mint() = 0x1249c58b", () => expect(toFunctionSelector("mint()")).toBe("0x1249c58b"));
  it("PoolSwapTest.swap selector matches the canonical tuple signature", () => {
    const d = buildTx({ kind: "treasurySwap", tokenIn: TOKEN_X, amountIn: 1n, minOut: 1n }, cfg, NOW).data;
    expect(d.slice(0, 10)).toBe(toFunctionSelector("swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)"));
  });
  it("depositV3 selector matches the canonical signature", () => {
    const a: ProposedAction = { kind: "treasuryTransfer", purpose: "acrossBridge", chain: "rh", asset: "USDG", to: SPOKE.rh, amount: E6, recipient: TREASURY, destChain: "base" };
    expect(buildTx(a, cfg, NOW).data.slice(0, 10)).toBe(
      toFunctionSelector("depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)"),
    );
  });
  it("registerInstance / heartbeat / distribute selectors", () => {
    expect(buildTx({ kind: "heartbeat" }, cfg, NOW).data.slice(0, 10)).toBe(toFunctionSelector("heartbeat(uint256)"));
    expect(buildTx({ kind: "registerInstance" }, cfg, NOW).data.slice(0, 10)).toBe(
      toFunctionSelector("registerInstance(uint256,address,address,bytes32,string)"),
    );
    expect(buildTx({ kind: "distribute" }, cfg, NOW).data.slice(0, 10)).toBe(toFunctionSelector("distribute(bytes32,uint256)"));
  });
});

describe("buildTx golden: treasury kinds", () => {
  it("heartbeat → registry.rh heartbeat(agentId)", () => {
    expectTx(buildTx({ kind: "heartbeat" }, cfg, NOW), {
      chain: "rh", chainId: 46630, to: cfg.registry.rh, value: 0n,
      data: encodeFunctionData({ abi: REGISTRY, functionName: "heartbeat", args: [1n] }),
    });
  });
  it("registerInstance → registry.rh registerInstance(agentId, treasury, action, codeHash, attestationRef)", () => {
    expectTx(buildTx({ kind: "registerInstance" }, cfg, NOW), {
      chain: "rh", chainId: 46630, to: cfg.registry.rh, value: 0n,
      data: encodeFunctionData({ abi: REGISTRY, functionName: "registerInstance", args: [1n, TREASURY, ACTION, CODE_HASH, "mock-attestation"] }),
    });
  });
  it("registerInstance without cfg.registration throws", () => {
    const c: ResolvedConfig = { ...cfg, registration: undefined };
    expect(() => buildTx({ kind: "registerInstance" }, c, NOW)).toThrow("registration");
  });
  it("distribute → feeSplitHook.rh distribute(agentPoolId, 0)", () => {
    expectTx(buildTx({ kind: "distribute" }, cfg, NOW), {
      chain: "rh", chainId: 46630, to: HOOK_RH, value: 0n,
      data: encodeFunctionData({ abi: HOOK, functionName: "distribute", args: [AGENT_POOL_ID, 0n] }),
    });
  });
  it("distribute without cfg.agentPoolId throws", () => {
    expect(() => buildTx({ kind: "distribute" }, { ...cfg, agentPoolId: undefined }, NOW)).toThrow("agentPoolId");
  });
  it("allowance → USDG.rh transfer(actionEOA, amount)", () => {
    expectTx(buildTx({ kind: "allowance", amount: 25n * E6 }, cfg, NOW), {
      chain: "rh", chainId: 46630, to: USDG_RH, value: 0n,
      data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [ACTION, 25n * E6] }),
    });
  });
  it("treasuryTransfer gasTopUp ETH (optimism) → native value transfer, empty data", () => {
    expectTx(buildTx({ kind: "treasuryTransfer", purpose: "gasTopUp", chain: "optimism", asset: "ETH", to: ACTION, amount: E18 / 100n }, cfg, NOW), {
      chain: "optimism", chainId: 10, to: ACTION, value: E18 / 100n, data: "0x",
    });
  });
  it("treasuryTransfer oysterRental USDC (arbitrum) → cfg.usdc.arbitrum transfer", () => {
    expectTx(buildTx({ kind: "treasuryTransfer", purpose: "oysterRental", chain: "arbitrum", asset: "USDC", to: MARLIN_PAY, amount: 50n * E6 }, cfg, NOW), {
      chain: "arbitrum", chainId: 42161, to: USDC.arbitrum, value: 0n,
      data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [MARLIN_PAY, 50n * E6] }),
    });
  });
  it("treasuryTransfer arweaveFunding USDG (rh) → cfg.usdg.rh transfer", () => {
    expectTx(buildTx({ kind: "treasuryTransfer", purpose: "arweaveFunding", chain: "rh", asset: "USDG", to: ARWEAVE, amount: 5n * E6 }, cfg, NOW), {
      chain: "rh", chainId: 46630, to: USDG_RH, value: 0n,
      data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [ARWEAVE, 5n * E6] }),
    });
  });
  it("treasuryTransfer x402Data USDC (base) → cfg.usdc.base transfer, chainId 8453", () => {
    expectTx(buildTx({ kind: "treasuryTransfer", purpose: "x402Data", chain: "base", asset: "USDC", to: PAYTO_DATA, amount: E6 }, cfg, NOW), {
      chain: "base", chainId: 8453, to: USDC.base, value: 0n,
      data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [PAYTO_DATA, E6] }),
    });
  });
});

describe("buildTx golden: acrossBridge depositV3", () => {
  const FOUR_H = 4n * 3600n;
  it("USDG rh → base: input USDG.rh, output USDC.base, outputAmount = amount × 9900/10000, fillDeadline now+4h", () => {
    const amount = 123_456_789n;
    const a: ProposedAction = { kind: "treasuryTransfer", purpose: "acrossBridge", chain: "rh", asset: "USDG", to: SPOKE.rh, amount, recipient: TREASURY, destChain: "base" };
    expectTx(buildTx(a, cfg, NOW), {
      chain: "rh", chainId: 46630, to: SPOKE.rh, value: 0n,
      data: encodeFunctionData({
        abi: SPOKE_ABI, functionName: "depositV3",
        args: [TREASURY, TREASURY, USDG_RH, USDC.base, amount, (amount * 9900n) / 10000n, 8453n, ZERO, Number(NOW), Number(NOW + FOUR_H), 0, "0x"],
      }),
    });
  });
  it("ETH base → rh: value = amount, input WETH.base, output WETH.rh, destinationChainId from chainIds (testnet override)", () => {
    const amount = E18 / 1000n;
    const a: ProposedAction = { kind: "treasuryTransfer", purpose: "acrossBridge", chain: "base", asset: "ETH", to: SPOKE.base, amount, recipient: TREASURY, destChain: "rh" };
    expectTx(buildTx(a, cfg, NOW), {
      chain: "base", chainId: 8453, to: SPOKE.base, value: amount,
      data: encodeFunctionData({
        abi: SPOKE_ABI, functionName: "depositV3",
        args: [TREASURY, TREASURY, WETH.base, WETH.rh, amount, (amount * 9900n) / 10000n, 46630n, ZERO, Number(NOW), Number(NOW + FOUR_H), 0, "0x"],
      }),
    });
  });
  it("USDC arbitrum → rh: output is USDG on rh", () => {
    const amount = 10n * E6;
    const a: ProposedAction = { kind: "treasuryTransfer", purpose: "acrossBridge", chain: "arbitrum", asset: "USDC", to: SPOKE.arbitrum, amount, recipient: TREASURY, destChain: "rh" };
    expectTx(buildTx(a, cfg, NOW), {
      chain: "arbitrum", chainId: 42161, to: SPOKE.arbitrum, value: 0n,
      data: encodeFunctionData({
        abi: SPOKE_ABI, functionName: "depositV3",
        args: [TREASURY, TREASURY, USDC.arbitrum, USDG_RH, amount, (amount * 9900n) / 10000n, 46630n, ZERO, Number(NOW), Number(NOW + FOUR_H), 0, "0x"],
      }),
    });
  });
  it("bridgeMaxFeeBps is honoured (0 bps ⇒ outputAmount == amount; floor division)", () => {
    const c = resolveConfig({ platform: platformJson({ bridgeMaxFeeBps: 0 }), agent: agentJson, ownAddresses: { treasury: TREASURY, action: ACTION } });
    const a: ProposedAction = { kind: "treasuryTransfer", purpose: "acrossBridge", chain: "rh", asset: "USDG", to: SPOKE.rh, amount: 999n, recipient: TREASURY, destChain: "optimism" };
    expect(buildTx(a, c, NOW).data).toBe(
      encodeFunctionData({ abi: SPOKE_ABI, functionName: "depositV3", args: [TREASURY, TREASURY, USDG_RH, USDC.optimism, 999n, 999n, 10n, ZERO, Number(NOW), Number(NOW + FOUR_H), 0, "0x"] }),
    );
    // default 100 bps on 999 ⇒ floor(999 × 9900 / 10000) = 989
    expect(buildTx(a, cfg, NOW).data).toBe(
      encodeFunctionData({ abi: SPOKE_ABI, functionName: "depositV3", args: [TREASURY, TREASURY, USDG_RH, USDC.optimism, 999n, 989n, 10n, ZERO, Number(NOW), Number(NOW + FOUR_H), 0, "0x"] }),
    );
  });
  it("throws: to ≠ spokePool[chain], destChain missing / == source, recipient missing, ETH without cfg.weth", () => {
    const base = { kind: "treasuryTransfer", purpose: "acrossBridge", chain: "rh", asset: "USDG", to: SPOKE.rh, amount: E6, recipient: TREASURY, destChain: "base" } as const;
    expect(() => buildTx({ ...base, to: SPOKE.base }, cfg, NOW)).toThrow("SpokePool");
    expect(() => buildTx({ ...base, destChain: undefined }, cfg, NOW)).toThrow("destChain");
    expect(() => buildTx({ ...base, destChain: "rh" }, cfg, NOW)).toThrow("destChain");
    expect(() => buildTx({ ...base, recipient: undefined }, cfg, NOW)).toThrow("recipient");
    expect(() => buildTx({ ...base, asset: "ETH" }, { ...cfg, weth: undefined }, NOW)).toThrow("weth");
  });
});

describe("buildTx golden: PoolSwapTest swaps (mirrors Lifecycle.s.sol _swap)", () => {
  // TOKEN_X (0x7070…) < USDG_RH (0xf400…) ⇒ currency0 = TOKEN_X
  const keyX = { currency0: TOKEN_X, currency1: USDG_RH, fee: 0, tickSpacing: 60, hooks: HOOK_RH };
  const TS = { takeClaims: false, settleUsingBurn: false };

  it("pool key: sorted by address, fee 0, tickSpacing 60, FeeSplitHook", () => {
    expect(poolKeyFor(TOKEN_X, cfg)).toEqual(keyX);
    const HIGH = "0xfa00000000000000000000000000000000000001" as Address; // > USDG_RH
    expect(poolKeyFor(HIGH, cfg)).toEqual({ currency0: USDG_RH, currency1: HIGH, fee: 0, tickSpacing: 60, hooks: HOOK_RH });
  });
  it("treasurySwap TOKEN_X → USDG: zeroForOne=true, amountSpecified=-amountIn, limit MIN+1", () => {
    expectTx(buildTx({ kind: "treasurySwap", tokenIn: TOKEN_X, amountIn: 7n * E18, minOut: 1n }, cfg, NOW), {
      chain: "rh", chainId: 46630, to: SWAP_ROUTER, value: 0n,
      data: encodeFunctionData({ abi: SWAP, functionName: "swap", args: [keyX, { zeroForOne: true, amountSpecified: -7n * E18, sqrtPriceLimitX96: MIN_SQRT_PLUS_1 }, TS, "0x"] }),
    });
  });
  it("actionSwap USDG → TOKEN_X: zeroForOne=false, limit MAX-1", () => {
    expectTx(buildTx({ kind: "actionSwap", tokenIn: "USDG", tokenOut: TOKEN_X, amountIn: 3n * E6, minOut: 0n }, cfg, NOW), {
      chain: "rh", chainId: 46630, to: SWAP_ROUTER, value: 0n,
      data: encodeFunctionData({ abi: SWAP, functionName: "swap", args: [keyX, { zeroForOne: false, amountSpecified: -3n * E6, sqrtPriceLimitX96: MAX_SQRT_MINUS_1 }, TS, "0x"] }),
    });
  });
  it("actionSwap TOKEN_X → USDG: zeroForOne=true", () => {
    expect(buildTx({ kind: "actionSwap", tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: E18, minOut: 5n }, cfg, NOW).data).toBe(
      encodeFunctionData({ abi: SWAP, functionName: "swap", args: [keyX, { zeroForOne: true, amountSpecified: -E18, sqrtPriceLimitX96: MIN_SQRT_PLUS_1 }, TS, "0x"] }),
    );
  });
  it("actionSwap with a token sorting ABOVE USDG: USDG in ⇒ zeroForOne=true", () => {
    const HIGH = "0xfa00000000000000000000000000000000000001" as Address;
    const key = { currency0: USDG_RH, currency1: HIGH, fee: 0, tickSpacing: 60, hooks: HOOK_RH };
    expect(buildTx({ kind: "actionSwap", tokenIn: "USDG", tokenOut: HIGH, amountIn: E6, minOut: 0n }, cfg, NOW).data).toBe(
      encodeFunctionData({ abi: SWAP, functionName: "swap", args: [key, { zeroForOne: true, amountSpecified: -E6, sqrtPriceLimitX96: MIN_SQRT_PLUS_1 }, TS, "0x"] }),
    );
  });
  it("minOut does not change calldata (PoolSwapTest has no min-output parameter — flagged)", () => {
    const a = buildTx({ kind: "actionSwap", tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: E18, minOut: 0n }, cfg, NOW).data;
    const b = buildTx({ kind: "actionSwap", tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: E18, minOut: 10n ** 30n }, cfg, NOW).data;
    expect(a).toBe(b);
  });
  it("actionSwap token → token (no USDG leg) ⇒ NotImplementedError", () => {
    expect(() => buildTx({ kind: "actionSwap", tokenIn: TOKEN_X, tokenOut: TOKEN_Y, amountIn: 1n, minOut: 0n }, cfg, NOW)).toThrow(NotImplementedError);
  });
});

describe("buildTx golden: action wallet kinds", () => {
  it("actionTransfer ETH → native", () => {
    expectTx(buildTx({ kind: "actionTransfer", asset: "ETH", to: CP, amount: 5n }, cfg, NOW), { chain: "rh", chainId: 46630, to: CP, value: 5n, data: "0x" });
  });
  it("actionTransfer USDG → USDG.rh transfer", () => {
    expectTx(buildTx({ kind: "actionTransfer", asset: "USDG", to: CP, amount: 5n }, cfg, NOW), {
      chain: "rh", chainId: 46630, to: USDG_RH, value: 0n, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [CP, 5n] }),
    });
  });
  it("actionTransfer token → token.transfer", () => {
    expectTx(buildTx({ kind: "actionTransfer", asset: TOKEN_Y, to: CP, amount: 5n }, cfg, NOW), {
      chain: "rh", chainId: 46630, to: TOKEN_Y, value: 0n, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [CP, 5n] }),
    });
  });
  it("actionMint → {to: target, value, data: mint()}", () => {
    expectTx(buildTx({ kind: "actionMint", target: CP, value: E18 / 100n }, cfg, NOW), { chain: "rh", chainId: 46630, to: CP, value: E18 / 100n, data: "0x1249c58b" });
  });
  it("actionApprove / treasuryApprove → token.approve(spender, amount)", () => {
    const want = encodeFunctionData({ abi: ERC20, functionName: "approve", args: [SWAP_ROUTER, 42n] });
    expectTx(buildTx({ kind: "actionApprove", token: USDG_RH, spender: SWAP_ROUTER, amount: 42n }, cfg, NOW), { chain: "rh", chainId: 46630, to: USDG_RH, value: 0n, data: want });
    expectTx(buildTx({ kind: "treasuryApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: 42n }, cfg, NOW), { chain: "rh", chainId: 46630, to: TOKEN_X, value: 0n, data: want });
  });
  it("actionLp ⇒ NotImplementedError (no modifyLiquidityRouter in the deployments manifest)", () => {
    expect(() => buildTx({ kind: "actionLp", pool: `0x${"ab".repeat(32)}`, usdgAmount: 1n, tokenAmount: 1n, token: TOKEN_X }, cfg, NOW)).toThrow(NotImplementedError);
  });
  it("no-tx kinds ⇒ NoTxError", () => {
    const h = `0x${"11".repeat(32)}` as Hex;
    const kinds: ProposedAction[] = [
      { kind: "inference", category: "pulse", endpointId: "inf-cheap", maxCostUsd: 1n },
      { kind: "castPost", contentHash: h },
      { kind: "castReply", contentHash: h, parentHash: h },
      { kind: "journalWrite", contentHash: h, sizeBytes: 1n },
    ];
    for (const a of kinds) expect(() => buildTx(a, cfg, NOW)).toThrow(NoTxError);
  });
});

describe("buildTx purity", () => {
  it("same inputs ⇒ identical output; config default chainIds", () => {
    const a: ProposedAction = { kind: "treasuryTransfer", purpose: "acrossBridge", chain: "rh", asset: "USDG", to: SPOKE.rh, amount: E6, recipient: TREASURY, destChain: "arbitrum" };
    expect(buildTx(a, cfg, NOW)).toEqual(buildTx(structuredClone(a), structuredClone(cfg), NOW));
    expect(cfg.chainIds).toEqual({ rh: 46630, base: 8453, arbitrum: 42161, optimism: 10 });
    const def = resolveConfig({ platform: { ...platformJson(), chainIds: undefined }, agent: agentJson, ownAddresses: { treasury: TREASURY, action: ACTION } });
    expect(def.chainIds.rh).toBe(4663);
    expect([def.poolFee, def.tickSpacing]).toEqual([0, 60]);
  });
});

describe("M3C: buildTx chain ∈ chainsTouched (SPEC-M3C §9.3)", () => {
  it("M3C: for a fixture of every tx-producing kind, buildTx(a).chain ∈ chainsTouched(a); no-tx / not-implemented kinds skipped", () => {
    const h = `0x${"11".repeat(32)}` as Hex;
    const chains = ["rh", "base", "arbitrum", "optimism"] as const;
    const fixtures: ProposedAction[] = [
      { kind: "heartbeat" },
      { kind: "registerInstance" },
      { kind: "distribute" },
      { kind: "allowance", amount: 100n * E6 },
      { kind: "treasurySwap", tokenIn: TOKEN_X, amountIn: E18, minOut: 1n },
      { kind: "treasuryApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: E18 },
      { kind: "actionTransfer", asset: "ETH", to: CP, amount: 1n },
      { kind: "actionTransfer", asset: "USDG", to: CP, amount: 1n },
      { kind: "actionTransfer", asset: TOKEN_X, to: CP, amount: 1n },
      { kind: "actionSwap", tokenIn: "USDG", tokenOut: TOKEN_X, amountIn: E6, minOut: 0n },
      { kind: "actionSwap", tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: E18, minOut: 0n },
      { kind: "actionMint", target: CP, value: 1n },
      { kind: "actionApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: E18 },
      { kind: "treasuryTransfer", purpose: "oysterRental", chain: "arbitrum", asset: "USDC", to: MARLIN_PAY, amount: E6 },
      { kind: "treasuryTransfer", purpose: "arweaveFunding", chain: "rh", asset: "USDG", to: ARWEAVE, amount: E6 },
      { kind: "treasuryTransfer", purpose: "x402Data", chain: "base", asset: "USDC", to: PAYTO_DATA, amount: E6 },
      ...chains.map((c): ProposedAction => ({ kind: "treasuryTransfer", purpose: "gasTopUp", chain: c, asset: "ETH", to: ACTION, amount: 1n })),
      { kind: "treasuryTransfer", purpose: "acrossBridge", chain: "rh", asset: "USDG", to: SPOKE.rh, amount: E6, recipient: TREASURY, destChain: "base" },
      { kind: "treasuryTransfer", purpose: "acrossBridge", chain: "rh", asset: "USDG", to: SPOKE.rh, amount: E6, recipient: TREASURY, destChain: "arbitrum" },
      { kind: "treasuryTransfer", purpose: "acrossBridge", chain: "base", asset: "ETH", to: SPOKE.base, amount: E18, recipient: TREASURY, destChain: "rh" },
      // skipped by construction (buildTx builds no tx for these):
      { kind: "actionLp", pool: `0x${"ab".repeat(32)}`, usdgAmount: 1n, tokenAmount: 1n, token: TOKEN_X },
      { kind: "inference", category: "pulse", endpointId: "inf-cheap", maxCostUsd: 1n },
      { kind: "castPost", contentHash: h },
      { kind: "castReply", contentHash: h, parentHash: h },
      { kind: "journalWrite", contentHash: h, sizeBytes: 1n },
    ];
    const built = new Set<string>();
    const skipped = new Set<string>();
    for (const a of fixtures) {
      let chain: string;
      try {
        chain = buildTx(a, cfg, NOW).chain;
      } catch (e) {
        if (e instanceof NoTxError || e instanceof NotImplementedError) {
          skipped.add(a.kind);
          continue;
        }
        throw e;
      }
      expect(chainsTouched(a), `${a.kind} built on ${chain}`).toContain(chain);
      built.add(a.kind);
    }
    expect([...built].sort()).toEqual(
      ["actionApprove", "actionMint", "actionSwap", "actionTransfer", "allowance", "distribute", "heartbeat", "registerInstance", "treasuryApprove", "treasurySwap", "treasuryTransfer"],
    );
    expect([...skipped].sort()).toEqual(["actionLp", "castPost", "castReply", "inference", "journalWrite"]);
  });
});
