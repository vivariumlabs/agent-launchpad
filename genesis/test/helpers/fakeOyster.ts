// Fake `oyster-cvm` CLI behind the Exec interface: records every invocation, simulates
// compute-image-id / deploy / list / verify with scriptable failures, and (optionally) an enclave
// that boots from the init params exactly like runtime boot would: it REFUSES to register when
// agent.json does not hash to the attested config-hash param or agent-id differs (03 §10 / SPEC-M3 §3b),
// otherwise registers with codeHash = runtime.json imageId and treasury = the registry's expected EOA.

import { readFileSync } from "node:fs";
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { frozenConfigHash } from "../../src/canonical.js";
import type { Exec, ExecResult } from "../../src/exec.js";
import type { MockWorld } from "./mockWorld.js";

export interface FakeJob {
  id: string;
  owner: string;
  agentId: number;
  ip: string;
  initParams: string[];
  jobName: string;
}

export interface FakeScript {
  /** Next N deploys fail before creating any job. */
  deployFail?: number;
  /** Next N deploys create the job but the CLI exits non-zero without printing the ID. */
  deployCrashAfterCreate?: number;
  /** Next N deploys create the job and then the Exec itself throws (orchestrator process died). */
  deployThrowAfterCreate?: number;
  /** Next N `list` calls fail (Oyster outage). */
  listOutage?: number;
  /** verify: "always" invalid, or next N invalid. */
  verifyInvalid?: number | "always";
  /** Deploy output omits the IP (forces the control-plane lookup path). */
  deployNoIp?: boolean;
}

export function initParam(params: readonly string[], name: string): string | undefined {
  const p = params.find((x) => x.startsWith(`${name}:`));
  return p === undefined ? undefined : p.split(":").slice(4).join(":");
}

export class FakeOyster implements Exec {
  readonly calls: Array<{ bin: string; args: string[] }> = [];
  readonly jobs: FakeJob[] = [];
  script: FakeScript = {};
  /** Called after a job is created (enclave boot). */
  onDeploy?: (job: FakeJob) => void;
  private n = 0;

  count(sub: string): number {
    return this.calls.filter((c) => c.args[0] === sub).length;
  }

  private flagAll(args: readonly string[], flag: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1]!);
    return out;
  }

  private flag(args: readonly string[], flag: string): string | undefined {
    return this.flagAll(args, flag)[0];
  }

  async run(bin: string, args: readonly string[]): Promise<ExecResult> {
    this.calls.push({ bin, args: [...args] });
    const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
    const bad = (stderr: string, stdout = ""): ExecResult => ({ code: 1, stdout, stderr, timedOut: false });
    switch (args[0]) {
      case "compute-image-id": {
        const compose = readFileSync(this.flag(args, "--docker-compose")!, "utf8");
        const ids = this.flagAll(args, "--init-params");
        const id = keccak256(stringToHex(`${compose}|${ids.join("|")}|${this.flag(args, "--arch")}|${this.flag(args, "--preset")}`)).slice(2);
        return ok(`[INFO] oyster_cvm::commands::image_id: \x1b[32mImage ID: ${id}\x1b[0m\n`);
      }
      case "list": {
        if ((this.script.listOutage ?? 0) > 0) {
          this.script.listOutage! -= 1;
          return bad("Error: indexer unavailable (503)");
        }
        const owner = this.flag(args, "--address")!.toLowerCase();
        const rows = this.jobs.filter((j) => j.owner === owner).map((j) => `| ${j.id} | 0.0512 | 1.00 USDC | AWS |`);
        return ok(["+----+", "| ID | RATE (USDC/hour) | BALANCE | PROVIDER |", "+----+", ...rows, "+----+"].join("\n"));
      }
      case "deploy": {
        if ((this.script.deployFail ?? 0) > 0) {
          this.script.deployFail! -= 1;
          return bad("[ERROR] Insufficient USDC balance / provider has no capacity");
        }
        const keyFile = this.flag(args, "--wallet-private-key-file")!;
        const owner = readOwner(keyFile);
        const params = this.flagAll(args, "--init-params");
        const agentId = Number((initParam(params, "agent-id") ?? "agent-0").slice("agent-".length));
        this.n += 1;
        const job: FakeJob = {
          id: `0x${(0x37a000 + this.n).toString(16).padStart(64, "0")}`,
          owner,
          agentId,
          ip: `10.0.0.${this.n}`,
          initParams: params,
          jobName: this.flag(args, "--job-name") ?? "",
        };
        this.jobs.push(job);
        this.onDeploy?.(job);
        if ((this.script.deployThrowAfterCreate ?? 0) > 0) {
          this.script.deployThrowAfterCreate! -= 1;
          throw new Error("simulated orchestrator crash while oyster-cvm deploy was running");
        }
        if ((this.script.deployCrashAfterCreate ?? 0) > 0) {
          this.script.deployCrashAfterCreate! -= 1;
          return bad("[ERROR] connection reset while waiting for job initialization", "[INFO] Job creation transaction: 0x38b…008\n");
        }
        const ipLine = this.script.deployNoIp === true ? "" : `[INFO] Found IP address: ${job.ip}\n[INFO] Enclave is ready! IP address: ${job.ip}\n`;
        return ok(`[INFO] Starting deployment...\n[INFO] Job created with ID: ${job.id}\n${ipLine}`);
      }
      case "verify": {
        const inv = this.script.verifyInvalid;
        if (inv === "always" || (typeof inv === "number" && inv > 0)) {
          if (typeof inv === "number") this.script.verifyInvalid = inv - 1;
          return bad("[ERROR] Verification failed: PCR/image-id mismatch");
        }
        return ok("[INFO] Successfully fetched attestation document\n[INFO] Verification successful ✓\n");
      }
      default:
        return bad(`unknown subcommand ${args[0]}`);
    }
  }
}

/** The fake CLI reads the wallet file only to learn the job owner address (like the real CLI). */
function readOwner(path: string): string {
  const text = readFileSync(path, "utf8").trim();
  const pk = (text.startsWith("0x") ? text : `0x${text}`) as Hex;
  return privateKeyAddress(pk).toLowerCase();
}

function privateKeyAddress(pk: Hex): Address {
  return privateKeyToAccount(pk).address;
}

/**
 * Simulated enclave boot (runtime boot semantics): verify agent.json against the attested
 * config-hash + agent-id params, then registerInstance from the expected treasury key with
 * codeHash = runtime.json imageId. Returns the boot log for assertions.
 */
export function simulatedEnclave(world: MockWorld, opts: { action?: Address; delayRegistration?: boolean } = {}): {
  onDeploy: (job: FakeJob) => void;
  boots: Array<{ job: string; booted: boolean; why: string }>;
  registerPending: () => void;
} {
  const boots: Array<{ job: string; booted: boolean; why: string }> = [];
  const queue: Array<() => void> = [];
  const action = opts.action ?? getAddress("0x00000000000000000000000000000000000AC710");
  const onDeploy = (job: FakeJob): void => {
    const agentJson = initParam(job.initParams, "agent.json")!;
    const runtimeJson = initParam(job.initParams, "runtime.json")!;
    const cfgHash = initParam(job.initParams, "config-hash")!;
    const agentIdParam = initParam(job.initParams, "agent-id")!;
    const raw = JSON.parse(readFileSync(agentJson, "utf8")) as { platform: unknown; agent: { agentId: number } };
    const h = frozenConfigHash(raw);
    if (h !== cfgHash) {
      boots.push({ job: job.id, booted: false, why: `config hash mismatch ${h} ≠ ${cfgHash}` });
      return;
    }
    if (agentIdParam !== `agent-${raw.agent.agentId}`) {
      boots.push({ job: job.id, booted: false, why: "agent-id mismatch" });
      return;
    }
    const ops = JSON.parse(readFileSync(runtimeJson, "utf8")) as { imageId: Hex; tee: boolean };
    const id = BigInt(raw.agent.agentId);
    const reg = (): void => {
      const existing = world.instances.get(id);
      const treasury = existing?.treasuryEOA ?? world.expected.get(id)!;
      world.registerInstance(id, treasury, existing?.actionEOA ?? action, ops.imageId);
    };
    boots.push({ job: job.id, booted: true, why: `tee=${ops.tee}` });
    if (opts.delayRegistration === true) queue.push(reg);
    else reg();
  };
  return {
    onDeploy,
    boots,
    registerPending: () => {
      while (queue.length > 0) queue.shift()!();
    },
  };
}
