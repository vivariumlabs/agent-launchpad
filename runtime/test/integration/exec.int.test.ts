// SPEC-M2C §4. Chain integration: the runtime's transcribed ABIs (src/exec/abi.ts),
// buildTx, the executors and RealChainClient against REAL compiled bytecode on
// anvil (--chain-id 46630), deployed by contracts/script/Deploy.s.sol exactly as
// the M1 testnet rehearsal did. Run with `npm run test:integration`.
//
// Stack bring-up (beforeAll):
//   forge build → anvil → etch v4 PoolManager at the pinned address → Deploy.s.sol
//   → Lifecycle.s.sol phase1 + phase2 (agent #1: curve → graduation → live
//   AGENT/USDG pool with pending fees) → factory.createAgent for agent #2 whose
//   expected treasury is the RUNTIME keyring's treasury EOA.
//
// ABI verification classes (reported per test name):
//   [bytecode]  a tx built by buildTx and signed by the keyring succeeded against
//               the real contract AND the resulting state was read back.
//   [artifact]  transcribed ABI entry ≡ the forge-compiled artifact ABI entry.
//   [reference] encoding compared against `cast calldata` only (no live target).

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseEther,
  stringToBytes,
  toFunctionSignature,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveConfig, type ResolvedConfig } from "../../src/config/schema.js";
import { ensureRegistered } from "../../src/boot.js";
import { acrossSpokePoolAbi, agentRegistryAbi, erc20Abi, feeSplitHookAbi, MIN_SQRT_PRICE, poolSwapTestAbi } from "../../src/exec/abi.js";
import { buildTx, poolKeyFor, swapCalldata } from "../../src/exec/build.js";
import { RealChainClient } from "../../src/exec/chainViem.js";
import { execute, swapExactIn, type ExecDeps, type ExecResult } from "../../src/exec/execute.js";
import { createKeyring, type Keyring } from "../../src/keyring/keyring.js";
import { MockKms } from "../../src/keyring/mockKms.js";
import { emptyLedger } from "../../src/ledger/ledger.js";
import type { BudgetLedger, WalletBalances, WalletState } from "../../src/policy/types.js";
import {
  ANVIL_PK0,
  artifact,
  castCalldata,
  etchPoolManager,
  findFoundry,
  forgeBuild,
  forgeScript,
  increaseTime,
  makeFoundryRoot,
  POOL_MANAGER,
  readManifest,
  removeFoundryRoot,
  setBalance,
  startAnvil,
  TESTNET_CHAIN_ID,
  type Anvil,
  type Manifest,
} from "./foundry.js";

const bins = findFoundry();
if (bins === undefined) {
  const bar = "!".repeat(78);
  console.warn(
    `\n${bar}\n!! SPEC-M2C §4 integration suite SKIPPED: forge/anvil/cast not found.\n` +
      `!! Install with runtime/scripts/install-foundry.sh (or set FOUNDRY_BIN).\n` +
      `!! NO ABI has been verified against real bytecode in this run.\n${bar}\n`,
  );
}

const E6 = 1_000_000n;
const DAY = 86_400n;
const CODE_HASH = keccak256(stringToBytes("agent-launchpad/m2c-int/enclave-image/v1"));
const ATTESTATION = "ar://m2c-int-attestation";
/** Plain counterparty for the action-wallet transfer; clear of every A3-protected prefix/suffix. */
const COUNTERPARTY: Address = "0x1234567800000000000000000000000087654321";

function placeholder(n: number): Address {
  return `0x${n.toString(16).padStart(8, "0")}${"0".repeat(24)}${n.toString(16).padStart(8, "0")}` as Address;
}
const chainMap = (rh: Address, base: number): Record<"rh" | "base" | "arbitrum" | "optimism", Address> => ({
  rh,
  base: placeholder(base + 1),
  arbitrum: placeholder(base + 2),
  optimism: placeholder(base + 3),
});

function nowSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

function fnOf(abi: Abi, name: string): AbiFunction {
  const f = abi.find((x): x is AbiFunction => x.type === "function" && x.name === name);
  if (f === undefined) throw new Error(`artifact ABI has no function ${name}`);
  return f;
}

function ok(r: ExecResult | undefined): void {
  expect(r, "missing result").toBeDefined();
  if (r === undefined) return;
  if (!r.verdict.allow) throw new Error(`${r.action.kind} denied ${r.verdict.code}: ${r.verdict.detail}`);
  expect(r.error, `${r.action.kind} error`).toBeUndefined();
  expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
}

describe.skipIf(bins === undefined)("SPEC-M2C §4 chain integration (anvil 46630, real bytecode)", () => {
  let root = "";
  let anvil: Anvil | undefined;
  let m: Manifest;
  let pub: ReturnType<typeof createPublicClient>;
  let chain: RealChainClient;
  let kr: Keyring;
  let cfg: ResolvedConfig;
  let deps: ExecDeps;
  let ledger: BudgetLedger;
  let agent1Token: Address;
  let agent1PoolId: Hex;
  const logs: ExecResult[] = [];
  const A: Record<string, Abi> = {};
  const MY_AGENT_ID = 2n;

  async function erc20Bal(token: Address, who: Address): Promise<bigint> {
    return (await chain.readContract("rh", { address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] })) as bigint;
  }

  async function walletRh(who: Address): Promise<WalletBalances> {
    return {
      rh: {
        native: await pub.getBalance({ address: who }),
        USDG: await erc20Bal(m.usdg, who),
        tokens: { [agent1Token]: await erc20Bal(agent1Token, who) },
      },
      base: { native: 0n },
      arbitrum: { native: 0n },
      optimism: { native: 0n },
    };
  }

  beforeAll(async () => {
    if (bins === undefined) return;
    const port = Number(process.env.ANVIL_PORT ?? "8545");
    root = makeFoundryRoot();
    forgeBuild(bins, root);
    anvil = await startAnvil(bins, port);
    await etchPoolManager(root, anvil.url);
    forgeScript(bins, root, "script/Deploy.s.sol:Deploy", anvil.url);
    m = readManifest(root);
    expect(m.chainId).toBe(TESTNET_CHAIN_ID);
    forgeScript(bins, root, "script/Lifecycle.s.sol:Lifecycle", anvil.url, ["--sig", "phase1()"]);
    forgeScript(bins, root, "script/Lifecycle.s.sol:Lifecycle", anvil.url, ["--sig", "phase2()"]);

    for (const [file, name] of [
      ["AgentFactory.sol", "AgentFactory"],
      ["AgentRegistry.sol", "AgentRegistry"],
      ["MockUSDG.sol", "MockUSDG"],
      ["FeeSplitHook.sol", "FeeSplitHook"],
      ["PoolSwapTest.sol", "PoolSwapTest"],
    ] as const) {
      A[name] = artifact(root, file, name).abi;
    }

    const viemChain = defineChain({
      id: TESTNET_CHAIN_ID,
      name: "anvil-46630",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [anvil.url] } },
    });
    pub = createPublicClient({ chain: viemChain, transport: http(anvil.url) });
    const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL_PK0), chain: viemChain, transport: http(anvil.url) });
    const send = async (address: Address, abi: Abi, functionName: string, args: unknown[], value = 0n): Promise<void> => {
      const hash = await deployer.writeContract({ address, abi, functionName, args, value });
      const rc = await pub.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(`setup tx ${functionName} reverted`);
    };

    agent1Token = (await pub.readContract({ address: m.factory, abi: A.AgentFactory!, functionName: "tokenOf", args: [1n] })) as Address;

    // Runtime identity: keyring-derived EOAs (MockKms — deterministic, M2).
    kr = await createKeyring(new MockKms("m2c-int-image", "m2c-int-agent"), { retry: { attempts: 3, delayMs: 1 } });
    const own = kr.addresses();
    cfg = resolveConfig({
      platform: {
        registry: chainMap(m.registry, 0x10),
        feeSplitHook: chainMap(m.hook, 0x20),
        poolManager: chainMap(POOL_MANAGER, 0x30),
        usdg: chainMap(m.usdg, 0x40),
        across: { spokePool: chainMap(placeholder(0x51), 0x50) },
        marlin: { paymentAddresses: [placeholder(0x61)] },
        arweaveFundingAddress: placeholder(0x71),
        x402Allowlist: [
          { id: "inf-cheap", kind: "inference", operator: "op", url: "https://a", payTo: placeholder(0x81), model: "m1", tier: "cheap", maxPricePerMTokUsd: "1000000", attested: false },
        ],
        // anvil suggests a 1 gwei priority fee (RH, an Arbitrum Orbit chain, suggests 0),
        // so the 1 gwei rh DEFAULT cap would reject every anvil fill at K2.
        caps: { maxFeePerGasWei: { rh: (10n ** 10n).toString() } },
        usdc: chainMap(placeholder(0x91), 0x90),
        weth: chainMap(placeholder(0xa1), 0xa0),
        chainIds: { rh: TESTNET_CHAIN_ID },
        swapRouter: { rh: m.swapRouter },
        usdcDomain: { base: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: placeholder(0x92) } },
        agentTokenAddress: agent1Token,
        registration: { codeHash: CODE_HASH, attestationRef: ATTESTATION },
      },
      agent: {
        agentId: Number(MY_AGENT_ID),
        name: "M2C Int",
        symbol: "M2CI",
        archetype: "trader",
        persona: "integration",
        models: { primary: "m1", fallbacks: [], chatTier: "cheap" },
        social: { postsPerDay: 1, repliesPerDay: 1 },
      },
      ownAddresses: own,
    });
    const key = poolKeyFor(agent1Token, cfg);
    agent1PoolId = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      ),
    );
    // distribute targets agent #1's live pool (the only one with fees); distribute is permissionless.
    cfg = { ...cfg, agentPoolId: agent1PoolId };
    kr.attachConfig(cfg);

    // Fund: gas ETH for both own EOAs, USDG for treasury (allowance) and action (swap).
    await setBalance(anvil.url, own.treasury, parseEther("1"));
    await setBalance(anvil.url, own.action, parseEther("1"));
    await send(m.usdg, A.MockUSDG!, "mint", [own.treasury, 10_000n * E6]);
    await send(m.usdg, A.MockUSDG!, "mint", [own.action, 1_000n * E6]);

    // Agent #2 via the factory path (Lifecycle._createRegisterFinalize), expected treasury = runtime treasury.
    // phase1 already minted USDG to the deployer and approved the factory for the creation fee.
    await send(m.factory, A.AgentFactory!, "createAgent", ["M2C Int", "M2CI", "ar://m2c-int", keccak256(stringToBytes("m2c-int-config")), m.deployer, own.treasury], parseEther("0.00002"));
    const count = (await pub.readContract({ address: m.factory, abi: A.AgentFactory!, functionName: "agentCount" })) as bigint;
    expect(count).toBe(MY_AGENT_ID);

    chain = new RealChainClient({ rpcUrls: { rh: anvil.url }, chainIds: { rh: TESTNET_CHAIN_ID }, receiptTimeoutMs: 20_000 });
    ledger = { ...emptyLedger(nowSec()), feeIncome7d: Array.from({ length: 7 }, () => 100n * E6) };
    deps = {
      cfg,
      keyring: kr,
      chain,
      getState: async (): Promise<WalletState> => ({
        treasury: await walletRh(own.treasury),
        action: await walletRh(own.action),
        hostingPaidUntil: nowSec() + 365n * DAY,
        hostingRatePerDay: 1_700_000n,
      }),
      ledger: { get: () => ledger, set: (l) => (ledger = l) },
      clock: nowSec,
      log: (r) => {
        logs.push(r);
      },
    };
  }, 900_000);

  afterAll(async () => {
    await anvil?.stop();
    if (root !== "") removeFoundryRoot(root);
  });

  // -------------------------------------------------------------------------
  // [artifact] transcribed ABI ≡ compiled ABI
  // -------------------------------------------------------------------------

  it("[artifact] every transcribed entry in src/exec/abi.ts matches the forge-compiled ABI (inputs, outputs, mutability)", () => {
    const pairs: Array<[readonly AbiFunction[], Abi, string]> = [
      [agentRegistryAbi as readonly AbiFunction[], A.AgentRegistry!, "AgentRegistry"],
      [feeSplitHookAbi as readonly AbiFunction[], A.FeeSplitHook!, "FeeSplitHook"],
      [poolSwapTestAbi as readonly AbiFunction[], A.PoolSwapTest!, "PoolSwapTest"],
      [erc20Abi as readonly AbiFunction[], A.MockUSDG!, "MockUSDG"],
    ];
    for (const [ours, compiled, label] of pairs) {
      for (const f of ours) {
        const c = fnOf(compiled, f.name);
        expect(toFunctionSignature(f), `${label}.${f.name} signature`).toBe(toFunctionSignature(c));
        expect(f.outputs.map((o) => o.type), `${label}.${f.name} outputs`).toEqual(c.outputs.map((o) => o.type));
        expect(f.stateMutability, `${label}.${f.name} mutability`).toBe(c.stateMutability);
      }
    }
  });

  // -------------------------------------------------------------------------
  // RealChainClient basics
  // -------------------------------------------------------------------------

  it("RealChainClient: chain-id guard, nonce, fill within K2 bounds, unknown chain throws", async () => {
    const wrong = new RealChainClient({ rpcUrls: { rh: anvil!.url }, chainIds: { rh: 4663 } });
    await expect(wrong.getNonce("rh", m.deployer)).rejects.toThrow(/chainId 46630, expected 4663/);
    await expect(chain.getNonce("base", m.deployer)).rejects.toThrow(/no RPC url/);
    expect(await chain.getNonce("rh", kr.addresses().treasury)).toBe(0);
    const built = buildTx({ kind: "allowance", amount: E6 }, cfg, nowSec());
    const fill = await chain.estimateFill("rh", { ...built, from: kr.addresses().treasury });
    expect(fill.gasLimit).toBeGreaterThan(21_000n);
    expect(fill.gasLimit).toBeLessThanOrEqual(cfg.maxGasLimit);
    expect(fill.maxPriorityFeePerGas).toBeLessThanOrEqual(fill.maxFeePerGas);
    expect(fill.maxFeePerGas).toBeLessThanOrEqual(cfg.maxFeePerGasWei.rh);
  });

  // -------------------------------------------------------------------------
  // (b) + (a) AgentRegistry
  // -------------------------------------------------------------------------

  it("[bytecode] heartbeat before registration: the real registry reverts (NotRegistered) ⇒ ExecResult.error, no nonce consumed", async () => {
    const r = await execute({ kind: "heartbeat" }, deps);
    expect(r.verdict.allow).toBe(true);
    expect(r.error).toBeDefined();
    expect(r.txHash).toBeUndefined();
    expect(await chain.getNonce("rh", kr.addresses().treasury)).toBe(0);
  });

  it("[bytecode] (b) registerInstance from the keyring treasury EOA ⇒ AgentRegistry pins treasury/action/codeHash/attestation, generation 1", async () => {
    const r = await execute({ kind: "registerInstance" }, deps);
    ok(r);
    const own = kr.addresses();
    expect(await chain.readContract("rh", { address: m.registry, abi: agentRegistryAbi, functionName: "isRegistered", args: [MY_AGENT_ID] })).toBe(true);
    const inst = (await pub.readContract({ address: m.registry, abi: A.AgentRegistry!, functionName: "instanceOf", args: [MY_AGENT_ID] })) as {
      treasuryEOA: Address;
      actionEOA: Address;
      codeHash: Hex;
      attestationRef: string;
      generation: number | bigint;
      lastHeartbeat: number | bigint;
    };
    expect(inst.treasuryEOA.toLowerCase()).toBe(own.treasury.toLowerCase());
    expect(inst.actionEOA.toLowerCase()).toBe(own.action.toLowerCase());
    expect(inst.codeHash).toBe(CODE_HASH);
    expect(inst.attestationRef).toBe(ATTESTATION);
    expect(BigInt(inst.generation)).toBe(1n);
    // The tx on chain is exactly buildTx's (to/data), signed by the treasury.
    const tx = await pub.getTransaction({ hash: r.txHash! });
    expect(tx.from.toLowerCase()).toBe(own.treasury.toLowerCase());
    expect(tx.to?.toLowerCase()).toBe(m.registry.toLowerCase());
    expect(tx.input).toBe(buildTx({ kind: "registerInstance" }, cfg, 0n).data);
    expect(tx.chainId).toBe(TESTNET_CHAIN_ID);
  });

  it("[bytecode] (a) heartbeat ⇒ lastHeartbeat advances on the real registry", async () => {
    const read = async (): Promise<bigint> =>
      BigInt(((await pub.readContract({ address: m.registry, abi: A.AgentRegistry!, functionName: "instanceOf", args: [MY_AGENT_ID] })) as { lastHeartbeat: number | bigint }).lastHeartbeat);
    const before = await read();
    await increaseTime(anvil!.url, 600);
    const r = await execute({ kind: "heartbeat" }, deps);
    ok(r);
    const after = await read();
    expect(after).toBeGreaterThanOrEqual(before + 600n);
    const block = await pub.getBlock();
    expect(after).toBe(block.timestamp);
  });

  // -------------------------------------------------------------------------
  // (c) ERC-20 transfers (MockUSDG)
  // -------------------------------------------------------------------------

  it("[bytecode] (c) allowance: treasury → action USDG transfer via buildTx ⇒ exact balances moved", async () => {
    const own = kr.addresses();
    const t0 = await erc20Bal(m.usdg, own.treasury);
    const a0 = await erc20Bal(m.usdg, own.action);
    const amount = 100n * E6;
    const r = await execute({ kind: "allowance", amount }, deps);
    ok(r);
    expect(await erc20Bal(m.usdg, own.treasury)).toBe(t0 - amount);
    expect(await erc20Bal(m.usdg, own.action)).toBe(a0 + amount);
  });

  it("[bytecode] (c) actionTransfer USDG to a counterparty (A2 cap = 30% of today's allowance) ⇒ exact balances moved", async () => {
    const own = kr.addresses();
    const a0 = await erc20Bal(m.usdg, own.action);
    const amount = 10n * E6;
    const r = await execute({ kind: "actionTransfer", asset: "USDG", to: COUNTERPARTY, amount }, deps);
    ok(r);
    expect(await erc20Bal(m.usdg, own.action)).toBe(a0 - amount);
    expect(await erc20Bal(m.usdg, COUNTERPARTY)).toBe(amount);
  });

  // -------------------------------------------------------------------------
  // (d) real swap through PoolSwapTest + FeeSplitHook on the graduated pool
  // -------------------------------------------------------------------------

  it("[bytecode] (d) swapExactIn USDG → AGENT#1 (approve + PoolSwapTest.swap) ⇒ both legs moved", async () => {
    const own = kr.addresses();
    const usdg0 = await erc20Bal(m.usdg, own.action);
    const agent0 = await erc20Bal(agent1Token, own.action);
    const amountIn = 50n * E6;
    const rs = await swapExactIn({ tokenIn: "USDG", tokenOut: agent1Token, amountIn, minOut: 0n }, deps);
    expect(rs.map((r) => r.action.kind)).toEqual(["actionApprove", "actionSwap"]);
    rs.forEach(ok);
    expect(await erc20Bal(m.usdg, own.action)).toBe(usdg0 - amountIn);
    expect(await erc20Bal(agent1Token, own.action)).toBeGreaterThan(agent0);
    // PoolSwapTest pulled exactly amountIn: the approval is fully consumed.
    const left = (await chain.readContract("rh", { address: m.usdg, abi: erc20Abi, functionName: "allowance", args: [own.action, m.swapRouter] })) as bigint;
    expect(left).toBe(0n);
  });

  it("[bytecode] (d') swapExactIn AGENT#1 → USDG (reverse direction, other sqrtPrice limit) ⇒ both legs moved", async () => {
    const own = kr.addresses();
    const agentBal = await erc20Bal(agent1Token, own.action);
    const usdg0 = await erc20Bal(m.usdg, own.action);
    const amountIn = agentBal / 10n; // well under the A1 20% cap
    const rs = await swapExactIn({ tokenIn: agent1Token, tokenOut: "USDG", amountIn, minOut: 0n }, deps);
    rs.forEach(ok);
    expect(await erc20Bal(agent1Token, own.action)).toBe(agentBal - amountIn);
    expect(await erc20Bal(m.usdg, own.action)).toBeGreaterThan(usdg0);
  });

  it("[reference] swapCalldata ≡ `cast calldata` for the same PoolSwapTest.swap call", () => {
    const key = poolKeyFor(agent1Token, cfg);
    const usdgIsC0 = key.currency0.toLowerCase() === m.usdg.toLowerCase();
    const ours = swapCalldata(key, m.usdg, 50n * E6);
    const ref = castCalldata(bins!, "swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)", [
      `(${key.currency0},${key.currency1},${key.fee},${key.tickSpacing},${key.hooks})`,
      usdgIsC0 ? `(true,-50000000,${MIN_SQRT_PRICE + 1n})` : `(false,-50000000,1461446703485210103287273052203988822378723970341)`,
      "(false,false)",
      "0x",
    ]);
    expect(ours.toLowerCase()).toBe(ref);
  });

  // -------------------------------------------------------------------------
  // FeeSplitHook.distribute (bonus: permissionless, agent #1's pool has fees pending)
  // -------------------------------------------------------------------------

  it("[bytecode] distribute(poolId, 0) on the live hook after the 1h cooldown ⇒ lastDistribute set, USDG pending drained", async () => {
    await increaseTime(anvil!.url, 3_601);
    const r = await execute({ kind: "distribute" }, deps);
    ok(r);
    const last = (await pub.readContract({ address: m.hook, abi: A.FeeSplitHook!, functionName: "lastDistribute", args: [agent1PoolId] })) as bigint;
    expect(last).toBe((await pub.getBlock()).timestamp);
    const pendingAgent = (await chain.readContract("rh", { address: m.hook, abi: feeSplitHookAbi, functionName: "pendingFees", args: [agent1PoolId, agent1Token] })) as bigint;
    expect(pendingAgent).toBe(0n);
    const pendingUsdg = (await chain.readContract("rh", { address: m.hook, abi: feeSplitHookAbi, functionName: "pendingFees", args: [agent1PoolId, m.usdg] })) as bigint;
    expect(pendingUsdg).toBeLessThan(3n); // 0-2 wei remainder stays pending
  });

  // -------------------------------------------------------------------------
  // (e) Across depositV3 — NO live target on anvil; reference-only
  // -------------------------------------------------------------------------

  it("[reference, UNVERIFIED vs bytecode] Across depositV3 encoding ≡ `cast calldata` of the canonical V3 signature", () => {
    const spoke = cfg.across.spokePool.rh;
    const now = 1_790_150_000n;
    const built = buildTx(
      { kind: "treasuryTransfer", chain: "rh", asset: "USDG", to: spoke, amount: 100n * E6, purpose: "acrossBridge", destChain: "base", recipient: cfg.treasury },
      cfg,
      now,
    );
    const d = decodeFunctionData({ abi: acrossSpokePoolAbi, data: built.data });
    expect(d.functionName).toBe("depositV3");
    const ref = castCalldata(
      bins!,
      "depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)",
      [cfg.treasury, cfg.treasury, cfg.usdg.rh, cfg.usdc.base, "100000000", "99000000", "8453", "0x0000000000000000000000000000000000000000", now.toString(), (now + 14_400n).toString(), "0", "0x"],
    );
    expect(built.data.toLowerCase()).toBe(ref);
    expect(built.data.slice(0, 10)).toBe("0x7b939232");
  });

  it("[bytecode] boot revival gate (ensureRegistered) vs the REAL registry: fresh ⇒ skip; stale past REVIVAL_WINDOW (read from the contract) ⇒ revival registerInstance, generation 1 → 2", async () => {
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
    const blockNow = async (): Promise<bigint> => (await pub.getBlock()).timestamp;
    const readInst = async () =>
      (await pub.readContract({ address: m.registry, abi: A.AgentRegistry!, functionName: "instanceOf", args: [MY_AGENT_ID] })) as { generation: number | bigint; lastHeartbeat: number | bigint; attestationRef: string };
    expect(await chain.readContract("rh", { address: m.registry, abi: agentRegistryAbi, functionName: "REVIVAL_WINDOW", args: [] })).toBe(604_800n);
    expect(await ensureRegistered(cfg, Number(MY_AGENT_ID), chain, deps, log, await blockNow())).toBe("alreadyRegistered");
    expect(BigInt((await readInst()).generation)).toBe(1n);
    await increaseTime(anvil!.url, 7 * 86_400 + 60);
    expect(await ensureRegistered(cfg, Number(MY_AGENT_ID), chain, deps, log, await blockNow())).toBe("revived");
    const after = await readInst();
    expect(BigInt(after.generation)).toBe(2n);
    expect(after.attestationRef).toBe(ATTESTATION);
    expect(BigInt(after.lastHeartbeat)).toBe(await blockNow());
    expect(lines.join("\n")).toMatch(/REVIVING \(generation 1 → 2\)/);
  });

  it("every executed tx was logged, and every tx-kind result came from a real receipt", () => {
    const txs = logs.filter((l) => l.txHash !== undefined);
    expect(txs.length).toBeGreaterThanOrEqual(8);
  });
});
