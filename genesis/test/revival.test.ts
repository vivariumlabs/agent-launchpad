// SPEC-M3B §1 revival.ts (04 §6): stale-heartbeat > 7d gate read on-chain; fresh heartbeat ⇒
// refused; same deploy path + same frozen config; NO full seeding — gas-seed leg only; no finalize.

import { describe, expect, it } from "vitest";
import { revive, RevivalRefused } from "../src/revival.js";
import { usdToWei } from "../src/seeder.js";
import { eventKinds, FUNDING, makeHarness, type Harness } from "./helpers/harness.js";
import { USDG } from "./helpers/mockWorld.js";

async function liveAgent(): Promise<{ h: Harness; agentId: number; treasury: `0x${string}` }> {
  const h = makeHarness();
  const { agentId, treasury } = h.createAgent();
  await h.settle();
  expect(h.flow(agentId).state).toBe("LIVE");
  return { h, agentId, treasury };
}

const deps = (h: Harness) => ({ db: h.db, launchpad: h.world.launchpad(), cfg: h.cfg, log: h.log });

describe("revival gate (on-chain heartbeat)", () => {
  it("heartbeat fresh ⇒ refused (heartbeat_fresh); nothing queued, nothing deployed", async () => {
    const { h, agentId } = await liveAgent();
    h.world.mine(6n * 86_400n); // 6 days: still inside REVIVAL_WINDOW
    await expect(revive(deps(h), agentId, { address: FUNDING }, h.world.timestamp)).rejects.toThrow(RevivalRefused);
    await expect(revive(deps(h), agentId, { address: FUNDING }, h.world.timestamp)).rejects.toMatchObject({ reason: "heartbeat_fresh" });
    expect(h.db.allFlows("revival")).toHaveLength(0);
    expect(h.oyster.count("deploy")).toBe(1);
  });

  it("exactly REVIVAL_WINDOW old is still fresh (registry rule is `<=`)", async () => {
    const { h, agentId } = await liveAgent();
    const hb = h.world.instances.get(BigInt(agentId))!.lastHeartbeat;
    h.world.timestamp = hb + 7n * 86_400n;
    await expect(revive(deps(h), agentId, { address: FUNDING }, h.world.timestamp)).rejects.toMatchObject({ reason: "heartbeat_fresh" });
    h.world.timestamp += 1n;
    await expect(revive(deps(h), agentId, { address: FUNDING }, h.world.timestamp)).resolves.toBeGreaterThan(0);
  });

  it("never-registered agent ⇒ refused (never_registered)", async () => {
    const h = makeHarness();
    await expect(revive(deps(h), 42, { address: FUNDING }, h.world.timestamp)).rejects.toMatchObject({ reason: "never_registered" });
  });

  it("heartbeat resumes between revive() and the machine picking it up ⇒ FAILED(heartbeat_fresh), no deploy", async () => {
    const { h, agentId } = await liveAgent();
    h.world.mine(8n * 86_400n);
    const rid = await revive(deps(h), agentId, { address: FUNDING }, h.world.timestamp);
    h.world.heartbeat(BigInt(agentId)); // the agent was alive after all
    await h.machine.drive({ kind: "revival", id: rid }, h.world.timestamp);
    const r = h.db.getFlow({ kind: "revival", id: rid })!;
    expect(r.state).toBe("FAILED");
    expect(r.failReason).toBe("heartbeat_fresh");
    expect(h.oyster.count("deploy")).toBe(1);
  });
});

describe("revival flow", () => {
  it("stale > 7d ⇒ same deploy path + same frozen config, generation++, gas-seed leg only, no finalize", async () => {
    const { h, agentId, treasury } = await liveAgent();
    const genesisInit = h.oyster.jobs[0]!.initParams;
    // The agent spent its RH gas before dying.
    h.world.setNative("rh", treasury, 0n);
    const usdgBefore = h.world.getErc20("rh", USDG, treasury);
    h.world.mine(8n * 86_400n);
    const rid = await revive(deps(h), agentId, { address: FUNDING, ref: "0xpaymentref" }, h.world.timestamp);
    await h.settle();

    const r = h.db.getFlow({ kind: "revival", id: rid })!;
    expect(r.state).toBe("LIVE");
    expect(r.payer).toBe(FUNDING);
    expect(h.world.instances.get(BigInt(agentId))!.generation).toBe(2);
    // same attested init params (agent-id + config-hash) ⇒ same image-id ⇒ same keys
    expect(h.oyster.jobs).toHaveLength(2);
    expect(h.oyster.jobs[1]!.initParams.slice(0, 2)).toEqual(genesisInit.slice(0, 2));
    expect(h.oyster.jobs[1]!.jobName).toBe(`agent-${agentId}-rev${rid}`);
    // seeds: ONLY the revival gas leg
    const seeds = h.db.seeds(`revival:${rid}`);
    expect(seeds.map((s) => [s.leg, s.chain, s.asset, s.status])).toEqual([["rh.eth", "rh", "native", "confirmed"]]);
    expect(BigInt(seeds[0]!.amount)).toBe(usdToWei(2_000_000n, 3_000_000_000n));
    expect(h.world.getNative("rh", treasury)).toBe(usdToWei(2_000_000n, 3_000_000_000n));
    expect(h.world.getErc20("rh", USDG, treasury)).toBe(usdgBefore);
    expect(h.world.finalizeCalls).toEqual([BigInt(agentId)]); // only the genesis one
    expect(eventKinds(h, `revival:${rid}`)).toEqual([
      "revival_requested",
      "prepared",
      "deploy_submitted",
      "deployed",
      "attestation_verified",
      "registered",
      "seed_plan",
      "seed_submitted",
      "seed_confirmed",
      "seeded",
      "revived",
    ]);
  });

  it("dead treasury with no gas: the pre-registration gas leg funds re-registration (to the pinned expectedTreasuryEOA), then the $2 revival leg", async () => {
    const { h, agentId, treasury } = await liveAgent();
    h.world.setNative("rh", treasury, 0n);
    // this time the booted enclave waits for gas before registering
    const boot = h.oyster.onDeploy!;
    const queued: Array<() => void> = [];
    h.oyster.onDeploy = (job) => queued.push(() => boot(job));
    h.world.mine(8n * 86_400n);
    const rid = await revive(deps(h), agentId, { address: FUNDING }, h.world.timestamp);
    await h.settle(5);
    const r0 = h.db.getFlow({ kind: "revival", id: rid })!;
    expect(r0.state).toBe("AWAITING_REGISTER");
    const preGas = usdToWei(1_000_000n, 3_000_000_000n);
    expect(h.world.getNative("rh", treasury)).toBe(preGas);
    expect(h.db.seeds(`revival:${rid}`).map((s) => [s.leg, s.status, s.target])).toEqual([["preGas", "confirmed", treasury]]);
    for (const q of queued) q();
    await h.settle();
    expect(h.db.getFlow({ kind: "revival", id: rid })!.state).toBe("LIVE");
    expect(h.db.seeds(`revival:${rid}`).map((s) => [s.leg, s.status])).toEqual([["preGas", "confirmed"], ["rh.eth", "confirmed"]]);
    expect(h.world.getNative("rh", treasury)).toBe(preGas + usdToWei(2_000_000n, 3_000_000_000n));
  });

  it("frozen config gone from the inbox ⇒ falls back to the launch db copy (hash re-verified)", async () => {
    const { h, agentId } = await liveAgent();
    const { rmSync } = await import("node:fs");
    rmSync(h.cfg.configInboxDir, { recursive: true, force: true });
    h.world.mine(8n * 86_400n);
    const rid = await revive(deps(h), agentId, { address: FUNDING }, h.world.timestamp);
    await h.settle();
    expect(h.db.getFlow({ kind: "revival", id: rid })!.state).toBe("LIVE");
  });

  it("second concurrent revival request is refused (revival_in_progress)", async () => {
    const { h, agentId } = await liveAgent();
    h.world.mine(8n * 86_400n);
    await revive(deps(h), agentId, { address: FUNDING }, h.world.timestamp);
    await expect(revive(deps(h), agentId, { address: FUNDING }, h.world.timestamp)).rejects.toMatchObject({ reason: "revival_in_progress" });
  });

  // M4F rev 2 (R9), live-proven by the agent-2 drill 2026-10-01: the revived agent runs the OLD
  // runtime release, whose strict() runtime schema may reject keys that today's cfg.runtimeOps
  // carries (v0.1.1 rejected `turboTopUp` ⇒ boot crash-loop, no registerInstance). The revival
  // must therefore reuse the ORIGINAL launch's runtime.json (which booted that release), with only
  // tee + imageId re-stamped.
  it("M4F rev 2 (R9): revival runtime.json reuses the original launch's file, re-stamping only tee + imageId", async () => {
    const { h, agentId } = await liveAgent();
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const original = join(h.cfg.dataDir, "agents", String(agentId), "runtime.json");
    // Simulate an old-release ops file: a shape the current runtimeOps does NOT produce.
    const oldOps = { rpc: { rh: "https://old-release.example/rpc" }, legacyKnob: true, imageId: "0xstale", tee: false };
    writeFileSync(original, `${JSON.stringify(oldOps, null, 2)}\n`);
    h.world.mine(8n * 86_400n);
    const rid = await revive(deps(h), agentId, { address: FUNDING }, h.world.timestamp);
    await h.settle();
    expect(h.db.getFlow({ kind: "revival", id: rid })!.state).toBe("LIVE");
    const written = JSON.parse(readFileSync(join(h.cfg.dataDir, "agents", String(agentId), `revival-${rid}`, "runtime.json"), "utf8"));
    const codeHash = h.world.instances.get(BigInt(agentId))!.codeHash;
    expect(written.rpc).toEqual(oldOps.rpc); // original ops preserved…
    expect(written.legacyKnob).toBe(true);
    expect(written.imageDigest).toBeUndefined(); // …and NOT today's runtimeOps
    expect(written.tee).toBe(true); // re-stamped
    expect(written.imageId).toBe(codeHash); // re-stamped to the REGISTERED codeHash (R3)
  });

  it("M4F rev 2 (R9): original runtime.json missing ⇒ falls back to cfg.runtimeOps (clean-machine case)", async () => {
    const { h, agentId } = await liveAgent();
    const { readFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    rmSync(join(h.cfg.dataDir, "agents", String(agentId), "runtime.json"));
    h.world.mine(8n * 86_400n);
    const rid = await revive(deps(h), agentId, { address: FUNDING }, h.world.timestamp);
    await h.settle();
    expect(h.db.getFlow({ kind: "revival", id: rid })!.state).toBe("LIVE");
    const written = JSON.parse(readFileSync(join(h.cfg.dataDir, "agents", String(agentId), `revival-${rid}`, "runtime.json"), "utf8"));
    expect(written.rpc).toEqual({ rh: "https://rpc.testnet.chain.robinhood.com" }); // today's runtimeOps
    expect(written.tee).toBe(true);
    expect(written.imageId).toBe(h.world.instances.get(BigInt(agentId))!.codeHash);
  });
});
