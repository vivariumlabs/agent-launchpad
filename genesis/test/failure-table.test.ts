// docs/04-GENESIS.md §7 failure table — every row mapped to a test, named "04§7: <row>".

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FUNDING_PK, makeHarness } from "./helpers/harness.js";
import { FACTORY, REGISTRY } from "./helpers/mockWorld.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("04§7 failure table", () => {
  it("04§7: CVM boot fails / attestation invalid — retry ×3, then mark launch failed (refund path); never finalize", async () => {
    const h = makeHarness();
    h.oyster.script.verifyInvalid = "always";
    const { agentId } = h.createAgent();
    await h.settle();
    const f = h.flow(agentId);
    expect(f.state).toBe("FAILED");
    expect(f.failReason).toBe("attestation_invalid");
    expect(h.oyster.count("verify")).toBe(3);
    expect(h.world.finalizeCalls).toEqual([]);
    expect(h.log.lines.some((l) => /refund path is factory\.cancel/.test(l))).toBe(true);
  });

  it("04§7: CVM boot fails / attestation invalid — deploy failing ×3 ⇒ FAILED(deploy_failed); never finalize", async () => {
    const h = makeHarness();
    h.oyster.script.deployFail = 99;
    const { agentId } = h.createAgent();
    await h.settle(40);
    const f = h.flow(agentId);
    expect(f.state).toBe("FAILED");
    expect(f.failReason).toBe("deploy_failed");
    expect(f.failStep).toBe("DEPLOYING");
    expect(h.oyster.count("deploy")).toBe(3);
    expect(h.world.finalizeCalls).toEqual([]);
  });

  it("04§7: CVM boot fails / attestation invalid — CVM never registers ⇒ FAILED(timeout) at 24h; never finalize", async () => {
    const h = makeHarness({ delayRegistration: true });
    const { agentId } = h.createAgent();
    await h.settle(4);
    await h.machine.drive({ kind: "genesis", id: agentId }, BigInt(h.flow(agentId).startedAt) + 86_400n);
    expect(h.flow(agentId).failReason).toBe("timeout");
    expect(h.world.finalizeCalls).toEqual([]);
  });

  it("04§7: Config hash mismatch in CVM — the orchestrator never deploys a config that does not hash to the on-chain value; marks failed", async () => {
    const h = makeHarness();
    const agentId = Number(h.world.agentCount + 1n);
    const realHash = h.writeFrozen(agentId);
    // The delivered file for that hash was tampered with (one persona byte).
    const { writeFileSync } = await import("node:fs");
    const p = join(h.cfg.configInboxDir, `${realHash}.json`);
    writeFileSync(p, readFileSync(p, "utf8").replace('"persona": "p"', '"persona": "q"'));
    h.createAgent({ configHash: realHash });
    await h.settle();
    const f = h.flow(agentId);
    expect(f.state).toBe("FAILED");
    expect(f.failReason).toBe("config_hash_mismatch");
    expect(f.failStep).toBe("REQUESTED");
    expect(h.oyster.count("deploy")).toBe(0);
    expect(h.world.finalizeCalls).toEqual([]);
  });

  it("04§7: Config hash mismatch in CVM — config naming another agentId (CVM would refuse to boot) ⇒ FAILED before deploy", async () => {
    const h = makeHarness();
    const agentId = Number(h.world.agentCount + 1n);
    const hash = h.writeFrozen(agentId, (c) => {
      c.agent.agentId = agentId + 1;
    });
    h.createAgent({ configHash: hash });
    await h.settle();
    expect(h.flow(agentId).failReason).toBe("config_agent_id_mismatch");
    expect(h.oyster.count("deploy")).toBe(0);
  });

  it("04§7: Farcaster registration fails — agent goes live anyway (no OP leg in the testnet profile, nothing Farcaster-gated)", async () => {
    const h = makeHarness(); // no optimism chain configured at all
    const { agentId } = h.createAgent();
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    expect(h.db.seeds(`genesis:${agentId}`).map((s) => s.leg)).not.toContain("optimism.eth");
    expect(h.world.executed.some((t) => t.chain === "optimism")).toBe(false);
  });

  it("04§7: Seed tx partial failure — reconciliation retries; finalize blocked until complete", async () => {
    const h = makeHarness();
    let dropped = false;
    h.world.hooks.onWaitReceipt = (tx) => {
      if (!dropped && tx.kind === "erc20") {
        dropped = true;
        queueMicrotask(() => h.world.reorgOut(tx.hash));
      }
    };
    const { agentId } = h.createAgent();
    await h.watcher.poll();
    await h.machine.drive({ kind: "genesis", id: agentId }, h.world.timestamp);
    // Reconciliation found the USDG leg missing: back to SEEDING, finalize not called.
    expect(h.flow(agentId).state).toBe("SEEDING");
    expect(h.flow(agentId).reconcileAttempts).toBe(1);
    expect(h.world.finalizeCalls).toEqual([]);
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    expect(h.world.finalizeCalls).toEqual([BigInt(agentId)]);
  });

  it("04§7: Oyster capacity/outage — launches queue (no attempts consumed, single-flight deploys) and complete once Oyster is back", async () => {
    const h = makeHarness();
    h.oyster.script.listOutage = 6;
    const a = h.createAgent();
    const b = h.createAgent();
    await h.settle(3);
    for (const id of [a.agentId, b.agentId]) {
      expect(h.flow(id).state).toBe("DEPLOYING");
      expect(h.flow(id).deployAttempts).toBe(0);
      expect(h.flow(id).lastError).toMatch(/list failed/);
    }
    expect(h.oyster.count("deploy")).toBe(0);
    await h.settle();
    expect(h.flow(a.agentId).state).toBe("LIVE");
    expect(h.flow(b.agentId).state).toBe("LIVE");
    expect(h.oyster.count("deploy")).toBe(2);
    expect(new Set(h.oyster.jobs.map((j) => j.agentId))).toEqual(new Set([a.agentId, b.agentId]));
  });

  it("04§7: Orchestrator key compromise — powers are only deploy + finalize (+ seeds to registry-pinned treasuries); key never persisted or logged", async () => {
    const h = makeHarness();
    const a = h.createAgent();
    const b = h.createAgent();
    await h.settle();
    expect(h.flow(a.agentId).state).toBe("LIVE");
    // (1) every tx the funding wallet sent: factory.finalize, or a seed whose destination is the
    //     registry's treasuryEOA for that agent (read on-chain, never from config/event/frozen JSON).
    const treasuries = new Set([h.world.instances.get(BigInt(a.agentId))!.treasuryEOA, h.world.instances.get(BigInt(b.agentId))!.treasuryEOA]);
    for (const t of h.world.executed) {
      if (t.kind === "finalize") expect(t.to).toBe(FACTORY);
      else if (t.kind === "erc20") expect(treasuries.has(t.erc20!.to)).toBe(true);
      else if (t.kind === "native") expect(treasuries.has(t.to)).toBe(true);
      else throw new Error(`unexpected tx kind ${t.kind}`);
      expect(t.to).not.toBe(REGISTRY);
    }
    // (2) the only calldata the orchestrator source can build: finalize + ERC-20 transfer.
    const fns = new Set<string>();
    for (const f of walk(SRC)) for (const m of readFileSync(f, "utf8").matchAll(/functionName:\s*"(\w+)"/g)) fns.add(m[1]!);
    const writes = [...fns].filter((n) => !["pendingAgent", "tokenOf", "CREATION_FEE", "isRegistered", "instanceOf", "expectedTreasuryEOA", "genesisDeadline", "REVIVAL_WINDOW", "balanceOf"].includes(n));
    expect(writes.sort()).toEqual(["finalize", "transfer"]);
    // (3) the wallet key never reaches the db or the logs.
    const keyHex = FUNDING_PK.slice(2).toLowerCase();
    const dbBytes = readFileSync(join(h.cfg.dataDir, "genesis.sqlite")).toString("latin1").toLowerCase();
    expect(dbBytes.includes(keyHex)).toBe(false);
    expect(h.log.lines.join("\n").toLowerCase().includes(keyHex)).toBe(false);
    expect(JSON.stringify(h.oyster.calls).toLowerCase().includes(keyHex)).toBe(false);
  });
});
