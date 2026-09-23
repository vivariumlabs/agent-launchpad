// SPEC-M3B §1 integration: the orchestrator against the REAL contracts on anvil (--chain-id 46630),
// deployed by contracts/script/Deploy.s.sol through the runtime's harness
// (runtime/test/integration/foundry.ts — reused, not forked). Run with `npm run test:integration`.
//
//   real createAgent → watcher catches the real AgentRequested log → machine deploys through a FAKE
//   oyster-cvm (mock CVM) → real pre-registration gas leg (RH ETH → expectedTreasuryEOA) → the TEST
//   performs registerInstance with a scripted treasury key (standing in for the enclave), paying the
//   gas ONLY from that preGas leg → real seed transfers (MockUSDG + native ETH) from the funding
//   wallet → real factory.finalize → factory / registry / NFT / balances end state asserted.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseEther,
  stringToBytes,
  toEventSignature,
  toFunctionSignature,
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANVIL_PK0,
  artifact,
  etchPoolManager,
  findFoundry,
  forgeBuild,
  forgeScript,
  makeFoundryRoot,
  readManifest,
  removeFoundryRoot,
  startAnvil,
  TESTNET_CHAIN_ID,
  type Anvil,
  type Manifest,
} from "../../../runtime/test/integration/foundry.js";
import { agentFactoryAbi, agentRegistryAbi, erc20Abi } from "../../src/abi.js";
import { frozenConfigHash } from "../../src/canonical.js";
import { ZERO_ADDRESS } from "../../src/chain.js";
import { loadConfig, projectedRentalMicroUsdc } from "../../src/config.js";
import { memoryLogger } from "../../src/log.js";
import { createOrchestrator, type Orchestrator } from "../../src/orchestrator.js";
import { planGenesisLegs, usdToWei } from "../../src/seeder.js";
import { FakeOyster } from "../helpers/fakeOyster.js";

const bins = findFoundry();
if (bins === undefined) {
  const bar = "!".repeat(78);
  console.warn(`\n${bar}\n!! genesis integration suite SKIPPED: forge/anvil/cast not found (~/.foundry/bin or FOUNDRY_BIN).\n${bar}\n`);
}

/** anvil account #1 — public dev key: the orchestrator's funding wallet in this test. */
const FUNDING_PK: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
/** Scripted "enclave" treasury key (deterministic test key, NOT a secret). */
const TREASURY_PK: Hex = keccak256(stringToBytes("agent-launchpad/genesis-int/scripted-enclave-treasury"));
const ACTION_PK: Hex = keccak256(stringToBytes("agent-launchpad/genesis-int/scripted-enclave-action"));
const CREATOR: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // anvil #2 address
const E6 = 1_000_000n;

function fnOf(abi: Abi, name: string): AbiFunction {
  const f = abi.find((x): x is AbiFunction => x.type === "function" && x.name === name);
  if (f === undefined) throw new Error(`artifact ABI has no function ${name}`);
  return f;
}
function evOf(abi: Abi, name: string): AbiEvent {
  const f = abi.find((x): x is AbiEvent => x.type === "event" && x.name === name);
  if (f === undefined) throw new Error(`artifact ABI has no event ${name}`);
  return f;
}

describe.skipIf(bins === undefined)("SPEC-M3B §1 genesis orchestrator — anvil 46630, real bytecode", () => {
  let root = "";
  let anvil: Anvil | undefined;
  let m: Manifest;
  let orch: Orchestrator;
  let pub: ReturnType<typeof createPublicClient>;
  const A: Record<string, Abi> = {};
  const oyster = new FakeOyster();
  const log = memoryLogger();
  const treasury = privateKeyToAccount(TREASURY_PK);
  const action = privateKeyToAccount(ACTION_PK);
  const funding = privateKeyToAccount(FUNDING_PK);
  let configHash: Hex;
  const AGENT_ID = 1;

  beforeAll(async () => {
    if (bins === undefined) return;
    const port = Number(process.env.GENESIS_ANVIL_PORT ?? "8547");
    root = makeFoundryRoot();
    forgeBuild(bins, root);
    anvil = await startAnvil(bins, port);
    await etchPoolManager(root, anvil.url);
    forgeScript(bins, root, "script/Deploy.s.sol:Deploy", anvil.url);
    m = readManifest(root);
    expect(m.chainId).toBe(TESTNET_CHAIN_ID);
    for (const [file, name] of [
      ["AgentFactory.sol", "AgentFactory"],
      ["AgentRegistry.sol", "AgentRegistry"],
      ["MockUSDG.sol", "MockUSDG"],
      ["AgentNFT.sol", "AgentNFT"],
    ] as const) {
      A[name] = artifact(root, file, name).abi;
    }

    const chain = defineChain({ id: TESTNET_CHAIN_ID, name: "anvil-46630", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvil.url] } } });
    pub = createPublicClient({ chain, transport: http(anvil.url) });
    const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL_PK0), chain, transport: http(anvil.url) });
    const send = async (address: Address, abi: Abi, functionName: string, args: unknown[], value = 0n): Promise<void> => {
      const hash = await deployer.writeContract({ address, abi, functionName, args, value });
      const rc = await pub.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(`setup tx ${functionName} reverted`);
    };

    // Orchestrator workspace: config + funding key + release compose + frozen-config inbox.
    const dir = mkdtempSync(join(tmpdir(), "genesis-int-"));
    mkdirSync(join(dir, "inbox"));
    writeFileSync(join(dir, "funding.key"), `${FUNDING_PK}\n`, { mode: 0o600 });
    writeFileSync(join(dir, "v0.0.1-int.yml"), `services:\n  agent:\n    image: ghcr.io/example/agent-runtime@sha256:${"cd".repeat(32)}\n    network_mode: host\n`);
    const frozen = {
      platform: { note: "genesis integration platform snapshot", registry: { rh: m.registry }, usdg: { rh: m.usdg } },
      agent: { agentId: AGENT_ID, name: "Genesis Int", symbol: "GINT", archetype: "sage", persona: "integration", models: { primary: "m", fallbacks: [], chatTier: "c" }, social: { postsPerDay: 1, repliesPerDay: 1 } },
    };
    configHash = frozenConfigHash(frozen);
    writeFileSync(join(dir, "inbox", `${configHash}.json`), JSON.stringify(frozen, null, 2));
    writeFileSync(
      join(dir, "genesis.json"),
      JSON.stringify({
        dataDir: "data",
        walletKeyPath: "funding.key",
        deploymentManifest: join(root, "deployments", "testnet-46630.json"),
        chains: { rh: { rpc: anvil.url, chainId: TESTNET_CHAIN_ID, maxFeePerGasWei: "100000000000", maxPriorityFeePerGasWei: "2000000000" } },
        release: { composePath: "v0.0.1-int.yml" },
        configInboxDir: "inbox",
        runtimeOps: { rpc: { rh: anvil.url } },
        // Only the RH chain exists on anvil: Arb leg disabled; Base legs conditional (unconfigured ⇒ skipped).
        seeding: { profile: "testnet", legs: { "arbitrum.eth": { mode: "disabled" } } },
        timing: { confirmations: 0, deployOrphanGraceSec: 0, receiptTimeoutSec: 30 },
      }),
    );

    // Funding wallet holds MockUSDG (deployer is the minter); anvil #1 already holds ETH.
    await send(m.usdg, A.MockUSDG!, "mint", [funding.address, 1_000n * E6]);
    // Creator path: the deployer pays the creation fee (mint + approve) and calls the REAL createAgent,
    // pinning the scripted enclave's treasury as expectedTreasuryEOA.
    await send(m.usdg, A.MockUSDG!, "mint", [m.deployer, 75n * E6]);
    await send(m.usdg, A.MockUSDG!, "approve", [m.factory, 75n * E6]);
    await send(m.factory, A.AgentFactory!, "createAgent", ["Genesis Int", "GINT", "ar://genesis-int", configHash, CREATOR, treasury.address], parseEther("0.00002"));

    orch = createOrchestrator(loadConfig(join(dir, "genesis.json")), { log, exec: oyster, pollingMs: 100 });
  }, 900_000);

  afterAll(async () => {
    orch?.close();
    await anvil?.stop();
    if (root !== "") removeFoundryRoot(root);
  });

  it("[artifact] every transcribed entry in src/abi.ts matches the forge-compiled ABI", () => {
    const pairs: Array<[readonly (AbiFunction | AbiEvent)[], Abi, string]> = [
      [agentFactoryAbi as readonly (AbiFunction | AbiEvent)[], A.AgentFactory!, "AgentFactory"],
      [agentRegistryAbi as readonly (AbiFunction | AbiEvent)[], A.AgentRegistry!, "AgentRegistry"],
      [erc20Abi as readonly (AbiFunction | AbiEvent)[], A.MockUSDG!, "MockUSDG"],
    ];
    for (const [ours, compiled, label] of pairs) {
      for (const e of ours) {
        if (e.type === "event") {
          const c = evOf(compiled, e.name);
          expect(toEventSignature(e), `${label}.${e.name}`).toBe(toEventSignature(c));
          expect(e.inputs.map((i) => i.indexed ?? false), `${label}.${e.name} indexed`).toEqual(c.inputs.map((i) => i.indexed ?? false));
        } else {
          const c = fnOf(compiled, e.name);
          expect(toFunctionSignature(e), `${label}.${e.name}`).toBe(toFunctionSignature(c));
          expect(JSON.stringify(e.outputs.map((o) => [o.type, "components" in o ? o.components : undefined])), `${label}.${e.name} outputs`).toBe(
            JSON.stringify(c.outputs.map((o) => [o.type, "components" in o ? (o.components as readonly { name: string; type: string }[]).map((x) => ({ name: x.name, type: x.type })) : undefined])),
          );
          expect(e.stateMutability, `${label}.${e.name} mutability`).toBe(c.stateMutability);
        }
      }
    }
  });

  it("real createAgent → watcher → deploy (mock CVM) → scripted registerInstance → real seeds → real finalize → LIVE", async () => {
    const now = async (): Promise<bigint> => (await pub.getBlock()).timestamp;

    // 1. watcher catches the REAL AgentRequested log
    expect(await orch.watcher.poll()).toEqual([AGENT_ID]);
    const f0 = orch.db.getLaunch(AGENT_ID)!;
    expect(f0.state).toBe("REQUESTED");
    expect(f0.configHash).toBe(configHash);
    expect(f0.creator).toBe(CREATOR);

    // 2. machine: config verified, image-id computed, deployed (fake oyster-cvm), attestation verified,
    //    pre-registration gas ($1 of RH ETH) sent to the registry's expectedTreasuryEOA, then blocks
    //    awaiting the enclave's registerInstance. That preGas transfer is the ONLY tx so far.
    const fundingNonce0 = await pub.getTransactionCount({ address: funding.address });
    expect(await pub.getBalance({ address: treasury.address })).toBe(0n); // brand-new enclave key: no gas
    await orch.machine.resumeAll(await now());
    const f1 = orch.db.getLaunch(AGENT_ID)!;
    expect(f1.state).toBe("AWAITING_REGISTER");
    expect(f1.attestationOk).toBe(1);
    expect(f1.lastError).toMatch(/awaiting registerInstance/);
    expect(oyster.count("deploy")).toBe(1);
    expect(await pub.getTransactionCount({ address: funding.address })).toBe(fundingNonce0 + 1);
    const preGasWei = usdToWei(1_000_000n, 3_000_000_000n);
    expect(orch.cfg.seeding.preRegistrationGasWei).toBe(preGasWei);
    expect(await pub.getBalance({ address: treasury.address })).toBe(preGasWei);
    const preRow = orch.db.seeds(`genesis:${AGENT_ID}`);
    expect(preRow.map((s) => [s.leg, s.status, s.target])).toEqual([["preGas", "confirmed", treasury.address]]);
    expect((await pub.getTransactionReceipt({ hash: preRow[0]!.txHash as Hex })).from.toLowerCase()).toBe(funding.address.toLowerCase());
    // idempotent while unregistered: another drive sends nothing
    await orch.machine.resumeAll(await now());
    expect(await pub.getTransactionCount({ address: funding.address })).toBe(fundingNonce0 + 1);
    const pending0 = (await pub.readContract({ address: m.factory, abi: agentFactoryAbi, functionName: "pendingAgent", args: [BigInt(AGENT_ID)] })) as { creator: Address };
    expect(pending0.creator).toBe(CREATOR);

    // 3. the TEST stands in for the enclave: registerInstance from the scripted treasury key,
    //    codeHash = the image-id the orchestrator deployed (runtime.json imageId).
    const codeHash = `0x${f1.imageId!}` as Hex;
    // No manual funding: registerInstance is paid from the orchestrator's preGas leg alone.
    const enclave = createWalletClient({ account: treasury, chain: pub.chain!, transport: http(anvil!.url) });
    const regHash = await enclave.writeContract({
      address: m.registry,
      abi: [
        { type: "function", name: "registerInstance", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "treasuryEOA", type: "address" }, { name: "actionEOA", type: "address" }, { name: "codeHash", type: "bytes32" }, { name: "attestationRef", type: "string" }], outputs: [] },
      ] as const,
      functionName: "registerInstance",
      args: [BigInt(AGENT_ID), treasury.address, action.address, codeHash, "ar://genesis-int-attestation"],
    });
    expect((await pub.waitForTransactionReceipt({ hash: regHash })).status).toBe("success");
    const treasuryEthAfterReg = await pub.getBalance({ address: treasury.address });

    // 4. machine: registered → real seeds → reconcile → real finalize → LIVE
    await orch.machine.resumeAll(await now());
    const f2 = orch.db.getLaunch(AGENT_ID)!;
    expect(f2.lastError).toBeNull();
    expect(f2.state).toBe("LIVE");
    expect(f2.treasury).toBe(treasury.address);

    // ---- end state: factory / registry / NFT ----
    const token = (await pub.readContract({ address: m.factory, abi: agentFactoryAbi, functionName: "tokenOf", args: [BigInt(AGENT_ID)] })) as Address;
    const curve = (await pub.readContract({ address: m.factory, abi: agentFactoryAbi, functionName: "curveOf", args: [BigInt(AGENT_ID)] })) as Address;
    expect(token).not.toBe(ZERO_ADDRESS);
    expect(curve).not.toBe(ZERO_ADDRESS);
    const pending1 = (await pub.readContract({ address: m.factory, abi: agentFactoryAbi, functionName: "pendingAgent", args: [BigInt(AGENT_ID)] })) as { creator: Address };
    expect(pending1.creator).toBe(ZERO_ADDRESS);
    expect(await pub.readContract({ address: m.nft, abi: A.AgentNFT!, functionName: "ownerOf", args: [BigInt(AGENT_ID)] })).toBe(CREATOR);
    const inst = (await pub.readContract({ address: m.registry, abi: agentRegistryAbi, functionName: "instanceOf", args: [BigInt(AGENT_ID)] })) as { treasuryEOA: Address; codeHash: Hex; generation: number };
    expect(inst.treasuryEOA).toBe(treasury.address);
    expect(inst.codeHash).toBe(codeHash);
    expect(inst.generation).toBe(1);

    // ---- end state: seeds (real transfers from the funding wallet to the registry treasury) ----
    const plan = planGenesisLegs(orch.cfg, 75n * E6, treasury.address);
    const ethLeg = plan.find((p) => p.leg === "rh.eth")!;
    // remainder = fee − EXECUTED legs = 75 − (preGas 1 + hosting [virtual: durationMin × rate] + rh.eth 2);
    // skipped base.eth / base.usdc / arweave fold into USDG; arb disabled.
    const hosting = projectedRentalMicroUsdc(orch.cfg.oyster);
    expect(hosting).toBe(153_600n); // testnet DEFAULT 180 min × 0.0512 USDC/h
    expect(plan[0]).toMatchObject({ leg: "hosting", asset: "virtual", usdMicro: hosting });
    const usdgAmount = 72n * E6 - hosting;
    expect(orch.db.seeds(`genesis:${AGENT_ID}`).find((s) => s.leg === "rh.usdg")!.amount).toBe(usdgAmount.toString());
    expect(await pub.readContract({ address: m.usdg, abi: erc20Abi, functionName: "balanceOf", args: [treasury.address] })).toBe(usdgAmount);
    expect(await pub.getBalance({ address: treasury.address })).toBe(treasuryEthAfterReg + ethLeg.amount);
    const seeds = Object.fromEntries(orch.db.seeds(`genesis:${AGENT_ID}`).map((s) => [s.leg, s]));
    expect(Object.fromEntries(Object.entries(seeds).map(([k, s]) => [k, s.status]))).toEqual({
      preGas: "confirmed",
      hosting: "confirmed",
      "rh.usdg": "confirmed",
      "rh.eth": "confirmed",
      "base.eth": "skipped",
      "base.usdc": "skipped",
      "arweave": "skipped",
    });
    for (const leg of ["preGas", "rh.usdg", "rh.eth"]) {
      const rc = await pub.getTransactionReceipt({ hash: seeds[leg]!.txHash as Hex });
      expect(rc.status).toBe("success");
      expect(rc.from.toLowerCase()).toBe(funding.address.toLowerCase());
    }
    // finalize: from the funding wallet, strictly AFTER both seeds (block order), success.
    const fin = await pub.getTransactionReceipt({ hash: f2.finalizeTx as Hex });
    expect(fin.status).toBe("success");
    expect(fin.to?.toLowerCase()).toBe(m.factory.toLowerCase());
    for (const leg of ["rh.usdg", "rh.eth"]) {
      const rc = await pub.getTransactionReceipt({ hash: seeds[leg]!.txHash as Hex });
      expect(rc.blockNumber < fin.blockNumber || (rc.blockNumber === fin.blockNumber && rc.transactionIndex < fin.transactionIndex)).toBe(true);
    }
    // creation fee left escrow for the platform fee recipient (the deployer) at finalize
    expect(await pub.readContract({ address: m.usdg, abi: erc20Abi, functionName: "balanceOf", args: [m.factory] })).toBe(0n);
    expect(await pub.getTransactionCount({ address: funding.address })).toBe(fundingNonce0 + 4); // preGas + 2 seeds + finalize (hosting is virtual: no tx)
    expect([seeds["hosting"]!.txHash, seeds["hosting"]!.raw]).toEqual([f2.deployJobId, null]);

    expect(orch.db.events(`genesis:${AGENT_ID}`).map((e) => e.kind)).toEqual([
      "requested", "prepared", "deploy_submitted", "deployed", "attestation_verified",
      "pregas_plan", "seed_submitted", "seed_confirmed", // preGas, before registration
      "registered", "seed_plan",
      "seed_confirmed", // hosting (virtual: the deploy's rental)
      "seed_submitted", "seed_confirmed", // rh.eth
      "seed_skipped", "seed_skipped", "seed_skipped", // base.eth, base.usdc, arweave
      "seed_remainder", "seed_submitted", "seed_confirmed", // rh.usdg last
      "seeded", "reconciled", "finalize_submitted", "finalized",
    ]);
  });

  it("re-driving the LIVE launch sends nothing (idempotent against the real chain)", async () => {
    const n0 = await pub.getTransactionCount({ address: funding.address });
    await orch.watcher.poll();
    await orch.machine.resumeAll((await pub.getBlock()).timestamp);
    expect(await pub.getTransactionCount({ address: funding.address })).toBe(n0);
    expect(oyster.count("deploy")).toBe(1);
  });
});
