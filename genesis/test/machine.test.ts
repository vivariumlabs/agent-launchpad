// SPEC-M3B §1 unit scenarios: full happy path REQUESTED→LIVE with every side effect recorded;
// crash-resume mid-DEPLOYING and mid-SEEDING (no duplicate deploys / seed txs); attestation invalid
// ⇒ never finalize; partial seed ⇒ finalize blocked + reconcile retries; timeout ⇒ FAILED.
// Review rulings: pre-registration gas leg (1), timeout scoped to pre-registration + redrive (2),
// USDG remainder = fee − executed legs (3).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redrive } from "../src/machine.js";
import { usdToWei } from "../src/seeder.js";
import { initParam } from "./helpers/fakeOyster.js";
import { eventKinds, FUNDING, makeHarness, type Harness } from "./helpers/harness.js";
import { FACTORY, USDG } from "./helpers/mockWorld.js";

const ETH_USD = 3_000_000_000n; // config DEFAULT
const RH_ETH = usdToWei(2_000_000n, ETH_USD);
const ARB_ETH = usdToWei(1_000_000n, ETH_USD);
const PRE_GAS = usdToWei(1_000_000n, ETH_USD);
// testnet DEFAULT profile, enclave registering instantly (no preGas needed): remainder = 75 − EXECUTED
// legs (hosting 0.1536 [virtual: 180 min × 0.0512 USDC/h] + rh.eth 2 + arb 1); the skipped base.eth /
// base.usdc / arweave budgets fold into USDG ⇒ 71.8464.
const HOSTING = 153_600n; // (180 × 51_200 + 59) / 60 µUSD
const USDG_REMAINDER = 72_000_000n - HOSTING;

function seedTxs(h: Harness): typeof h.world.executed {
  return h.world.executed.filter((t) => t.kind === "native" || t.kind === "erc20");
}

describe("happy path REQUESTED → LIVE", () => {
  it("drives a real request to LIVE with every side effect recorded, in the rev-0 order (seed before finalize)", async () => {
    const h = makeHarness();
    const { agentId, configHash, treasury } = h.createAgent();
    await h.settle();

    const f = h.flow(agentId);
    expect(f.state).toBe("LIVE");
    expect(f.failReason).toBeNull();
    expect(f.treasury).toBe(treasury);
    expect(f.attestationOk).toBe(1);
    expect(f.deployAttempts).toBe(1);

    // Oyster CLI: exactly one image-id computation, one pre-deploy snapshot, ONE deploy, one verify.
    expect(h.oyster.count("compute-image-id")).toBe(1);
    expect(h.oyster.count("list")).toBe(1);
    expect(h.oyster.count("deploy")).toBe(1);
    expect(h.oyster.count("verify")).toBe(1);
    const dep = h.oyster.calls.find((c) => c.args[0] === "deploy")!.args;
    const params = dep.filter((_, i) => dep[i - 1] === "--init-params");
    const dir = join(h.cfg.dataDir, "agents", String(agentId));
    expect(params).toEqual([
      `agent-id:1:0:utf8:agent-${agentId}`,
      `config-hash:1:0:utf8:${configHash}`,
      `agent.json:0:0:file:${join(dir, "agent.json")}`,
      `runtime.json:0:0:file:${join(dir, "runtime.json")}`,
    ]);
    expect(dep[dep.indexOf("--wallet-private-key-file") + 1]).toBe(h.keyPath);
    expect(dep.join(" ")).not.toMatch(/--wallet-private-key\s/);
    // agent.json deployed byte-for-byte; runtime.json = ops template + tee + imageId (= registered codeHash).
    expect(readFileSync(join(dir, "agent.json"), "utf8")).toBe(f.frozenJson);
    const ops = JSON.parse(readFileSync(join(dir, "runtime.json"), "utf8")) as Record<string, unknown>;
    expect(ops.tee).toBe(true);
    expect(ops.imageId).toBe(`0x${f.imageId!}`);
    expect(ops.imageDigest).toBeDefined();
    expect(h.world.instances.get(BigInt(agentId))!.codeHash).toBe(`0x${f.imageId!}`);
    expect(initParam(h.oyster.jobs[0]!.initParams, "config-hash")).toBe(configHash);

    // Chain: seeds to the registry treasury, THEN exactly one finalize.
    expect(h.world.getErc20("rh", USDG, treasury)).toBe(USDG_REMAINDER);
    expect(h.world.getNative("rh", treasury)).toBe(RH_ETH);
    expect(h.world.getNative("arbitrum", treasury)).toBe(ARB_ETH);
    expect(h.world.finalizeCalls).toEqual([BigInt(agentId)]);
    const fin = h.world.executed.find((t) => t.kind === "finalize")!;
    for (const s of seedTxs(h)) expect(s.index).toBeLessThan(fin.index);
    expect(fin.to).toBe(FACTORY);

    // Seed rows: required legs confirmed; unconfigured Base + unfunded Turbo skipped (conditional); OP disabled.
    const seeds = Object.fromEntries(h.db.seeds(`genesis:${agentId}`).map((s) => [s.leg, s.status]));
    expect(seeds).toEqual({ hosting: "confirmed", "rh.usdg": "confirmed", "rh.eth": "confirmed", "base.eth": "skipped", "base.usdc": "skipped", "arbitrum.eth": "confirmed", "arweave": "skipped" }); // no preGas: registered before it was needed
    // hosting = virtual leg: the deploy's rental, confirmed with the Oyster job id, no tx of ours
    const hosting = h.db.seeds(`genesis:${agentId}`).find((s) => s.leg === "hosting")!;
    expect([hosting.asset, hosting.amount, hosting.usdMicro, hosting.txHash, hosting.raw]).toEqual(["virtual", HOSTING.toString(), HOSTING.toString(), f.deployJobId, null]);
    expect(hosting.note).toMatch(/durationMin 180 × 0\.0512 USDC\/h ⇒ projected rental 0\.1536 USDC/);
    expect(h.db.events(`genesis:${agentId}`).find((e) => e.kind === "seed_remainder")!.detail).toMatch(/^rh\.usdg=71846400 \(remainder: fee 75000000 − executed 3153600 µUSD \[hosting,rh\.eth,arbitrum\.eth\]\)$/);
    expect(h.log.lines.some((l) => /ARWEAVE SEED LEG: Turbo is UNFUNDED — SKIPPING/.test(l))).toBe(true);

    expect(eventKinds(h, `genesis:${agentId}`)).toEqual([
      "requested",
      "prepared",
      "deploy_submitted",
      "deployed",
      "attestation_verified",
      "registered",
      "seed_plan",
      "seed_confirmed", // hosting (virtual: the deploy's rental)
      "seed_submitted", "seed_confirmed", // rh.eth
      "seed_skipped", "seed_skipped", // base.eth, base.usdc (chain not configured)
      "seed_submitted", "seed_confirmed", // arbitrum.eth
      "seed_skipped", // arweave (turbo unfunded)
      "seed_remainder", // rh.usdg resolved LAST: fee − executed
      "seed_submitted", "seed_confirmed", // rh.usdg
      "seeded",
      "reconciled",
      "finalize_submitted",
      "finalized",
    ]);
  });

  it("idempotent re-drive of a LIVE flow does nothing", async () => {
    const h = makeHarness();
    const { agentId } = h.createAgent();
    await h.settle();
    const before = h.world.executed.length;
    await h.machine.drive({ kind: "genesis", id: agentId }, h.world.timestamp);
    await h.machine.resumeAll(h.world.timestamp);
    expect(h.world.executed.length).toBe(before);
    expect(h.oyster.count("deploy")).toBe(1);
  });

  it("waits (no deploy) until the frozen config is delivered, then proceeds", async () => {
    const h = makeHarness();
    const agentId = Number(h.world.agentCount + 1n);
    // hash of the config the website will deliver later
    const tmp = makeHarness();
    const hash = tmp.writeFrozen(agentId);
    h.world.createAgent(hash, FUNDING, `0x${"7ea5".padEnd(36, "0")}${agentId.toString(16).padStart(4, "0")}`);
    await h.settle(3);
    expect(h.flow(agentId).state).toBe("REQUESTED");
    expect(h.flow(agentId).lastError).toMatch(/not delivered yet/);
    expect(h.oyster.count("deploy")).toBe(0);
    h.writeFrozen(agentId);
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
  });
});

describe("crash-resume mid-DEPLOYING (no duplicate deploys)", () => {
  it("CLI dies after the job tx (no ID printed): the next drive ADOPTS the job instead of redeploying", async () => {
    const h = makeHarness();
    h.oyster.script.deployCrashAfterCreate = 1;
    const { agentId } = h.createAgent();
    await h.watcher.poll();
    await h.machine.drive({ kind: "genesis", id: agentId }, h.world.timestamp);
    expect(h.flow(agentId).state).toBe("DEPLOYING");
    expect(h.flow(agentId).deployInFlight).toBe(1);
    // orchestrator restart: fresh db handle + fresh machine
    h.reopenDb();
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    expect(h.oyster.count("deploy")).toBe(1);
    expect(h.oyster.jobs).toHaveLength(1);
    expect(h.flow(agentId).deployJobId).toBe(h.oyster.jobs[0]!.id);
    expect(eventKinds(h, `genesis:${agentId}`)).toContain("deploy_adopted");
  });

  it("orchestrator process dies while oyster-cvm deploy runs: resume adopts, one job total", async () => {
    const h = makeHarness();
    h.oyster.script.deployThrowAfterCreate = 1;
    const { agentId } = h.createAgent();
    await h.watcher.poll();
    await h.machine.drive({ kind: "genesis", id: agentId }, h.world.timestamp);
    const mid = h.flow(agentId);
    expect(mid.state).toBe("DEPLOYING");
    expect(mid.deployInFlight).toBe(1); // persisted BEFORE the CLI ran
    expect(mid.deployAttempts).toBe(1);
    expect(h.db.kvGet("deploy.lock")).toBe(`genesis:${agentId}`);
    h.reopenDb();
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    expect(h.oyster.count("deploy")).toBe(1);
    expect(h.db.kvGet("deploy.lock")).toBeUndefined();
  });

  it("in-flight deploy whose job never appears: waits the grace period, then retries (bounded)", async () => {
    const h = makeHarness({ timing: { deployOrphanGraceSec: 600 } });
    h.oyster.script.deployFail = 1; // fails BEFORE creating a job
    const { agentId } = h.createAgent();
    await h.watcher.poll();
    const t0 = h.world.timestamp;
    await h.machine.drive({ kind: "genesis", id: agentId }, t0);
    await h.machine.drive({ kind: "genesis", id: agentId }, t0 + 60n);
    expect(h.oyster.count("deploy")).toBe(1); // still inside grace: no second deploy
    expect(h.flow(agentId).lastError).toMatch(/outcome unknown/);
    await h.machine.drive({ kind: "genesis", id: agentId }, t0 + 601n); // grace over: attempt counted failed
    await h.machine.drive({ kind: "genesis", id: agentId }, t0 + 602n); // attempt 2
    expect(h.oyster.count("deploy")).toBe(2);
    expect(h.flow(agentId).state).not.toBe("DEPLOYING");
  });
});

describe("crash-resume mid-SEEDING (no duplicate seed txs)", () => {
  it("crash after a seed tx was mined but before it was recorded confirmed: resume confirms by receipt, no resend", async () => {
    const h = makeHarness();
    let crashed = false;
    h.world.hooks.onWaitReceipt = (tx) => {
      if (!crashed && tx.kind === "erc20") {
        crashed = true;
        throw new Error("simulated crash after broadcast, before recording");
      }
    };
    const { agentId, treasury } = h.createAgent();
    await h.watcher.poll();
    await h.machine.drive({ kind: "genesis", id: agentId }, h.world.timestamp);
    expect(h.flow(agentId).state).toBe("SEEDING");
    expect(h.db.seeds(`genesis:${agentId}`).find((s) => s.leg === "rh.usdg")!.status).toBe("submitted");
    h.reopenDb();
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    const usdgTxs = h.world.executed.filter((t) => t.kind === "erc20" && t.erc20?.to === treasury);
    expect(usdgTxs).toHaveLength(1);
    expect(h.world.getErc20("rh", USDG, treasury)).toBe(USDG_REMAINDER);
  });

  it("crash between persist and broadcast: resume re-broadcasts the SAME signed bytes (one tx)", async () => {
    const h = makeHarness();
    let n = 0;
    h.world.hooks.onBroadcast = (tx) => (tx.data === "0x" && tx.chain === "rh" && n++ === 0 ? "crash-before" : undefined);
    const { agentId, treasury } = h.createAgent();
    await h.watcher.poll();
    await h.machine.drive({ kind: "genesis", id: agentId }, h.world.timestamp);
    const row = h.db.seeds(`genesis:${agentId}`).find((s) => s.leg === "rh.eth")!;
    expect(row.status).toBe("submitted");
    expect(row.txHash).not.toBeNull();
    h.reopenDb();
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    const ethTxs = h.world.executed.filter((t) => t.kind === "native" && t.chain === "rh" && t.to === treasury);
    expect(ethTxs).toHaveLength(1);
    expect(ethTxs[0]!.hash).toBe(row.txHash);
    expect(eventKinds(h, `genesis:${agentId}`)).toContain("seed_rebroadcast");
  });

  it("a stuck (pending) seed tx is waited on, never duplicated", async () => {
    const h = makeHarness();
    let stuck: string | undefined;
    h.world.hooks.onBroadcast = (tx) => {
      if (tx.chain === "arbitrum" && stuck === undefined) {
        stuck = tx.hash;
        return "pending";
      }
      return undefined;
    };
    const { agentId, treasury } = h.createAgent();
    await h.settle(4);
    expect(h.flow(agentId).state).toBe("SEEDING");
    expect(h.flow(agentId).lastError).toMatch(/arbitrum.eth pending/);
    h.world.minePending(stuck as `0x${string}`);
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    expect(h.world.executed.filter((t) => t.chain === "arbitrum" && t.to === treasury)).toHaveLength(1);
  });

  it("leg already funded (target balance ≥ expected) is satisfied without a tx", async () => {
    const h = makeHarness();
    const { agentId, treasury } = h.createAgent();
    h.world.setNative("arbitrum", treasury, 10n ** 18n);
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    expect(h.world.executed.filter((t) => t.chain === "arbitrum")).toHaveLength(0);
    expect(h.db.seeds(`genesis:${agentId}`).find((s) => s.leg === "arbitrum.eth")!.status).toBe("satisfied");
  });
});

describe("attestation invalid ⇒ never finalize", () => {
  it("registered enclave whose attestation fails verification ×3 ⇒ FAILED(attestation_invalid); no seeds, no finalize", async () => {
    const h = makeHarness();
    h.oyster.script.verifyInvalid = "always";
    const { agentId } = h.createAgent();
    await h.settle();
    const f = h.flow(agentId);
    expect(h.world.instances.get(BigInt(agentId))).toBeDefined(); // it DID register
    expect(f.state).toBe("FAILED");
    expect(f.failReason).toBe("attestation_invalid");
    expect(f.failStep).toBe("AWAITING_REGISTER");
    expect(f.verifyAttempts).toBe(3);
    expect(h.world.finalizeCalls).toEqual([]);
    expect(seedTxs(h)).toEqual([]);
  });

  it("transiently invalid attestation (< cap) recovers and goes LIVE", async () => {
    const h = makeHarness();
    h.oyster.script.verifyInvalid = 2;
    const { agentId } = h.createAgent();
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    expect(h.flow(agentId).verifyAttempts).toBe(2);
  });

  it("registered codeHash ≠ deployed image ⇒ FAILED(instance_codehash_mismatch), never finalize", async () => {
    const h = makeHarness();
    h.oyster.onDeploy = (job) => {
      h.world.registerInstance(BigInt(job.agentId), h.world.expected.get(BigInt(job.agentId))!, FUNDING, `0x${"99".repeat(32)}`);
    };
    const { agentId } = h.createAgent();
    await h.settle();
    expect(h.flow(agentId).failReason).toBe("instance_codehash_mismatch");
    expect(h.world.finalizeCalls).toEqual([]);
    expect(seedTxs(h)).toEqual([]);
  });
});

describe("partial seed ⇒ finalize blocked, reconcile retries", () => {
  it("a reverted seed tx blocks finalize until a retry lands", async () => {
    const h = makeHarness();
    let reverts = 2;
    h.world.hooks.onBroadcast = (tx) => (tx.data !== "0x" && tx.to !== FACTORY && reverts-- > 0 ? "revert" : undefined);
    const { agentId, treasury } = h.createAgent();
    await h.watcher.poll();
    await h.machine.drive({ kind: "genesis", id: agentId }, h.world.timestamp);
    expect(h.flow(agentId).state).toBe("SEEDING");
    expect(h.flow(agentId).seedAttempts).toBe(1);
    expect(h.world.finalizeCalls).toEqual([]);
    await h.machine.drive({ kind: "genesis", id: agentId }, h.world.timestamp);
    expect(h.flow(agentId).state).toBe("SEEDING");
    expect(h.world.finalizeCalls).toEqual([]);
    await h.settle();
    const f = h.flow(agentId);
    expect(f.state).toBe("LIVE");
    expect(f.seedAttempts).toBe(2);
    const okUsdg = h.world.executed.find((t) => t.kind === "erc20" && t.status === "success")!;
    const fin = h.world.executed.find((t) => t.kind === "finalize")!;
    expect(okUsdg.index).toBeLessThan(fin.index);
    expect(h.world.getErc20("rh", USDG, treasury)).toBe(USDG_REMAINDER);
  });

  it("a seed that vanished before reconciliation (reorg) is re-queued and re-sent; finalize only after", async () => {
    const h = makeHarness();
    let reorged = false;
    h.world.hooks.onWaitReceipt = (tx) => {
      if (!reorged && tx.kind === "native" && tx.chain === "rh") {
        reorged = true;
        queueMicrotask(() => h.world.reorgOut(tx.hash));
      }
    };
    const { agentId, treasury } = h.createAgent();
    await h.settle();
    const f = h.flow(agentId);
    expect(f.state).toBe("LIVE");
    expect(f.reconcileAttempts).toBe(1);
    expect(eventKinds(h, `genesis:${agentId}`)).toContain("seed_missing");
    expect(h.world.getNative("rh", treasury)).toBe(RH_ETH); // funded exactly once in effect
    const fin = h.world.executed.find((t) => t.kind === "finalize")!;
    const eth = h.world.executed.filter((t) => t.kind === "native" && t.chain === "rh" && t.to === treasury);
    expect(eth).toHaveLength(1);
    expect(eth[0]!.index).toBeLessThan(fin.index);
  });

  it("legs that never land ⇒ reconcile ×5 then FAILED(seed_reconcile_failed); finalize never called", async () => {
    const h = makeHarness();
    h.world.hooks.onWaitReceipt = (tx) => {
      if (tx.kind === "native" && tx.chain === "rh") queueMicrotask(() => h.world.reorgOut(tx.hash));
    };
    const { agentId } = h.createAgent();
    await h.settle(60);
    const f = h.flow(agentId);
    expect(f.state).toBe("FAILED");
    expect(f.failReason).toBe("seed_reconcile_failed");
    expect(f.failStep).toBe("RECONCILING");
    expect(f.reconcileAttempts).toBe(5);
    expect(h.world.finalizeCalls).toEqual([]);
  });

  it("the agent spending a landed seed before reconciliation does NOT trigger a re-send (receipt proves landing)", async () => {
    const h = makeHarness();
    h.world.hooks.onWaitReceipt = (tx) => {
      // the live CVM moves its USDG right away
      if (tx.kind === "erc20" && tx.erc20 !== undefined) h.world.setErc20("rh", USDG, tx.erc20.to, 0n);
    };
    const { agentId, treasury } = h.createAgent();
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    expect(h.world.executed.filter((t) => t.kind === "erc20" && t.erc20?.to === treasury)).toHaveLength(1);
  });
});

describe("pre-registration gas leg (ruling 1)", () => {
  it("attested, unregistered enclave: $1 RH ETH → expectedTreasuryEOA BEFORE registration, leg preGas; the USDG remainder deducts it (75 − 0.1536 − 1 − 2 − 1 = 70.8464)", async () => {
    const h = makeHarness({ delayRegistration: true });
    const { agentId, treasury } = h.createAgent();
    await h.settle(5);
    const f0 = h.flow(agentId);
    expect(f0.state).toBe("AWAITING_REGISTER");
    expect(f0.lastError).toMatch(/awaiting registerInstance/);
    // exactly one tx so far: the preGas native transfer to the registry-pinned expected treasury
    expect(seedTxs(h).map((t) => [t.kind, t.chain, t.to, t.value])).toEqual([["native", "rh", treasury, PRE_GAS]]);
    expect(h.world.expected.get(BigInt(agentId))).toBe(treasury);
    expect(h.world.instances.get(BigInt(agentId))).toBeUndefined();
    const pre = h.db.seeds(`genesis:${agentId}`);
    expect(pre.map((s) => [s.leg, s.status, s.amount, s.usdMicro])).toEqual([["preGas", "confirmed", PRE_GAS.toString(), "1000000"]]);
    // re-driving while still unregistered sends nothing more
    await h.settle(3);
    expect(seedTxs(h)).toHaveLength(1);

    h.enclave.registerPending(); // the enclave pays registerInstance with that gas
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    const seeds = Object.fromEntries(h.db.seeds(`genesis:${agentId}`).map((s) => [s.leg, s.status]));
    expect(seeds).toEqual({ preGas: "confirmed", hosting: "confirmed", "rh.usdg": "confirmed", "rh.eth": "confirmed", "base.eth": "skipped", "base.usdc": "skipped", "arbitrum.eth": "confirmed", "arweave": "skipped" });
    expect(h.world.getErc20("rh", USDG, treasury)).toBe(71_000_000n - HOSTING);
    expect(h.world.getNative("rh", treasury)).toBe(PRE_GAS + RH_ETH); // mock registration is gasless
    const kinds = eventKinds(h, `genesis:${agentId}`);
    expect(kinds.slice(0, 8)).toEqual(["requested", "prepared", "deploy_submitted", "deployed", "attestation_verified", "pregas_plan", "seed_submitted", "seed_confirmed"]);
    expect(kinds.indexOf("registered")).toBeGreaterThan(kinds.indexOf("pregas_plan"));
  });

  it("idempotent: target already holding ≥ half the leg ⇒ satisfied, no tx, and its budget folds into USDG", async () => {
    const h = makeHarness({ delayRegistration: true });
    const { agentId, treasury } = h.createAgent();
    h.world.setNative("rh", treasury, PRE_GAS / 2n);
    await h.settle(5);
    expect(h.flow(agentId).state).toBe("AWAITING_REGISTER");
    expect(seedTxs(h)).toEqual([]);
    expect(h.db.seeds(`genesis:${agentId}`).map((s) => [s.leg, s.status])).toEqual([["preGas", "satisfied"]]);
    h.enclave.registerPending();
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    expect(h.world.getErc20("rh", USDG, treasury)).toBe(72_000_000n - HOSTING);
  });

  it("just below half ⇒ sent", async () => {
    const h = makeHarness({ delayRegistration: true });
    const { agentId, treasury } = h.createAgent();
    h.world.setNative("rh", treasury, PRE_GAS / 2n - 1n);
    await h.settle(5);
    expect(h.db.seeds(`genesis:${agentId}`)[0]!.status).toBe("confirmed");
    expect(seedTxs(h)).toHaveLength(1);
  });

  it("never funds an enclave whose attestation failed", async () => {
    const h = makeHarness({ delayRegistration: true });
    h.oyster.script.verifyInvalid = "always";
    const { agentId } = h.createAgent();
    await h.settle();
    expect(h.flow(agentId).failReason).toBe("attestation_invalid");
    expect(seedTxs(h)).toEqual([]);
    expect(h.db.seeds(`genesis:${agentId}`)).toEqual([]);
  });
});

describe("timeout scoping (ruling 2): pre-registration only", () => {
  it("enclave never registers: FAILED(timeout) after 24h; only the preGas leg was sent, no finalize", async () => {
    const h = makeHarness({ delayRegistration: true });
    const { agentId, treasury } = h.createAgent();
    await h.settle(5);
    expect(h.flow(agentId).state).toBe("AWAITING_REGISTER");
    const f0 = h.flow(agentId);
    await h.machine.drive({ kind: "genesis", id: agentId }, BigInt(f0.startedAt) + 86_399n);
    expect(h.flow(agentId).state).toBe("AWAITING_REGISTER");
    await h.machine.drive({ kind: "genesis", id: agentId }, BigInt(f0.startedAt) + 86_400n);
    const f = h.flow(agentId);
    expect(f.state).toBe("FAILED");
    expect(f.failReason).toBe("timeout");
    expect(f.failStep).toBe("AWAITING_REGISTER");
    expect(h.world.finalizeCalls).toEqual([]);
    expect(seedTxs(h).map((t) => [t.to, t.value])).toEqual([[treasury, PRE_GAS]]);
  });

  it("post-registration stall (required leg blocked for > 24h) does NOT time out; resumes when unblocked", async () => {
    const h = makeHarness();
    h.world.setNative("arbitrum", FUNDING, 0n);
    const { agentId } = h.createAgent();
    await h.settle(4);
    const f0 = h.flow(agentId);
    expect(f0.state).toBe("SEEDING");
    for (const dt of [86_400n, 7n * 86_400n, 30n * 86_400n]) {
      await h.machine.drive({ kind: "genesis", id: agentId }, BigInt(f0.startedAt) + dt);
      expect(h.flow(agentId).state).toBe("SEEDING");
      expect(h.flow(agentId).lastError).toMatch(/funding wallet low/);
    }
    h.world.setNative("arbitrum", FUNDING, 10n ** 18n);
    await h.machine.drive({ kind: "genesis", id: agentId }, BigInt(f0.startedAt) + 31n * 86_400n);
    expect(h.flow(agentId).state).toBe("LIVE");
  });

  it("a crashed finalize resumed long after 24h still goes LIVE (FINALIZING never times out)", async () => {
    const h = makeHarness();
    h.world.hooks.onBroadcast = (tx) => (tx.to === FACTORY ? "crash-after" : undefined);
    const { agentId } = h.createAgent();
    await h.watcher.poll();
    for (let i = 0; i < 10 && h.world.finalizeCalls.length === 0; i++) await h.machine.resumeAll(h.world.timestamp);
    expect(h.world.finalizeCalls).toEqual([BigInt(agentId)]);
    const f0 = h.flow(agentId);
    expect(f0.state).toBe("FINALIZING");
    h.world.hooks = {};
    await h.machine.drive({ kind: "genesis", id: agentId }, BigInt(f0.startedAt) + 90_000n);
    expect(h.flow(agentId).state).toBe("LIVE");
  });
});

describe("operator redrive (ruling 2)", () => {
  it("FAILED(seed_reconcile_failed) ⇒ redrive resets to SEEDING (counters zeroed) and re-drives to LIVE without re-sending landed legs", async () => {
    const h = makeHarness();
    let reorgs = true;
    h.world.hooks.onWaitReceipt = (tx) => {
      if (reorgs && tx.kind === "native" && tx.chain === "rh") queueMicrotask(() => h.world.reorgOut(tx.hash));
    };
    const { agentId, treasury } = h.createAgent();
    await h.settle(60);
    const failed = h.flow(agentId);
    expect(failed.state).toBe("FAILED");
    expect(failed.failReason).toBe("seed_reconcile_failed");
    expect(failed.failStep).toBe("RECONCILING");
    expect(h.world.finalizeCalls).toEqual([]);
    const usdgTxs = h.world.executed.filter((t) => t.kind === "erc20").length;

    reorgs = false; // operator fixed the cause
    const r = redrive(h.db, agentId, h.world.timestamp, h.log);
    expect(r.state).toBe("SEEDING");
    expect([r.failReason, r.failStep, r.seedAttempts, r.reconcileAttempts, r.finalizeAttempts]).toEqual([null, null, 0, 0, 0]);
    expect(eventKinds(h, `genesis:${agentId}`)).toContain("redrive");
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    expect(h.world.finalizeCalls).toEqual([BigInt(agentId)]);
    expect(h.world.executed.filter((t) => t.kind === "erc20")).toHaveLength(usdgTxs); // USDG landed once, never re-sent
    expect(h.world.getErc20("rh", USDG, treasury)).toBe(USDG_REMAINDER);
    expect(h.world.getNative("rh", treasury)).toBe(RH_ETH);
  });

  it("FAILED(finalize_failed) ⇒ redrive ⇒ LIVE", async () => {
    const h = makeHarness({ retries: { finalize: 2 } });
    let reverting = true;
    h.world.hooks.onBroadcast = (tx) => (reverting && tx.to === FACTORY ? "revert" : undefined);
    const { agentId } = h.createAgent();
    await h.settle();
    expect(h.flow(agentId).failReason).toBe("finalize_failed");
    expect(h.flow(agentId).failStep).toBe("FINALIZING");
    reverting = false;
    redrive(h.db, agentId, h.world.timestamp, h.log);
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    expect(h.world.finalizeCalls).toEqual([BigInt(agentId)]);
  });

  it("refuses pre-registration failures, LIVE launches and unknown agents", async () => {
    const h = makeHarness();
    h.oyster.script.verifyInvalid = "always";
    const bad = h.createAgent();
    await h.settle();
    expect(h.flow(bad.agentId).failStep).toBe("AWAITING_REGISTER");
    expect(() => redrive(h.db, bad.agentId, h.world.timestamp, h.log)).toThrow(/post-registration/);
    h.oyster.script.verifyInvalid = 0;
    const ok = h.createAgent();
    await h.settle();
    expect(h.flow(ok.agentId).state).toBe("LIVE");
    expect(() => redrive(h.db, ok.agentId, h.world.timestamp, h.log)).toThrow(/LIVE/);
    expect(() => redrive(h.db, 999, h.world.timestamp, h.log)).toThrow(/no launch/);
    expect(h.flow(bad.agentId).state).toBe("FAILED");
  });
});
