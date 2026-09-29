// SPEC-M3B §1 main.ts — argv only (no environment variables).
//
//   genesis run    --config <genesis.json>
//       start the watcher (every pollSec) + resumer loop (re-drives all non-terminal launches every
//       resumeSec; immediately after new requests); SIGINT/SIGTERM ⇒ finish the current step, close.
//   genesis revive --config <genesis.json> --agent-id <N> --payer <0x…> [--payer-ref <ref>]
//       check the on-chain stale-heartbeat gate and queue a revival (the running loop drives it).
//   genesis status --config <genesis.json>
//       print every flow's state (no secrets are ever stored, so nothing to redact).
//   genesis redrive --config <genesis.json> --agent-id <N>
//       operator recovery (review ruling 2): reset a launch that FAILED at SEEDING / RECONCILING /
//       FINALIZING (or is stuck there) back into SEEDING re-evaluation with its attempt counters
//       zeroed; the running loop drives it. Post-registration steps never time out on their own.
//   genesis abandon --config <genesis.json> --agent-id <N> --reason <text>
//       SPEC-M4F R5: move a NON-terminal launch to FAILED(abandoned) with the operator's reason
//       (replaces db surgery). Nothing on-chain / at Oyster is touched.
//   `run` first sweeps a deploy.lock held by a terminal (or missing) flow (SPEC-M4F R5).

import { pathToFileURL } from "node:url";
import { systemClock, sleep } from "./clock.js";
import { describeRental, loadConfig } from "./config.js";
import { errMsg } from "./errors.js";
import type { Logger } from "./log.js";
import { abandon, redrive, sweepDeployLock } from "./machine.js";
import { createOrchestrator, type Orchestrator } from "./orchestrator.js";
import { revive } from "./revival.js";

const consoleLogger: Logger = {
  info: (m) => console.log(`${new Date(Number(systemClock.now()) * 1000).toISOString()} INFO  ${m}`),
  warn: (m) => console.warn(`${new Date(Number(systemClock.now()) * 1000).toISOString()} WARN  ${m}`),
  error: (m) => console.error(`${new Date(Number(systemClock.now()) * 1000).toISOString()} ERROR ${m}`),
};

export function parseArgs(argv: readonly string[]): { cmd: string; flags: Map<string, string> } {
  const [cmd = "run", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} requires a value`);
    flags.set(a.slice(2), v);
    i++;
  }
  return { cmd, flags };
}

async function runLoop(o: Orchestrator, log: Logger): Promise<void> {
  let stopping = false;
  const stop = (sig: string): void => {
    if (!stopping) log.info(`${sig}: stopping after the current step…`);
    stopping = true;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  sweepDeployLock(o.db, systemClock.now(), log);
  let nextPoll = 0n;
  let nextResume = 0n;
  log.info(`genesis orchestrator up: wallet ${o.walletAddress}, factory ${o.cfg.contracts.factory}, profile ${o.cfg.seeding.profile}`);
  // Rental guard (ruling 4): every deploy pays durationMin × rate up front — make it visible.
  log.info(`oyster rental per deploy: ${describeRental(o.cfg.oyster)} (profile ${o.cfg.seeding.profile})`);
  while (!stopping) {
    const now = systemClock.now();
    if (now >= nextPoll) {
      try {
        const fresh = await o.watcher.poll();
        if (fresh.length > 0) nextResume = now;
      } catch (e) {
        log.warn(`watcher: ${errMsg(e)}`);
      }
      nextPoll = now + BigInt(o.cfg.timing.pollSec);
    }
    if (!stopping && now >= nextResume) {
      await o.machine.resumeAll(systemClock.now());
      nextResume = systemClock.now() + BigInt(o.cfg.timing.resumeSec);
    }
    await sleep(1000);
  }
  o.close();
  log.info("genesis orchestrator stopped");
}

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  const cfgPath = flags.get("config");
  if (cfgPath === undefined) throw new Error("--config <path> is required");
  const cfg = loadConfig(cfgPath);
  const o = createOrchestrator(cfg, { log: consoleLogger });
  if (cmd === "run") return runLoop(o, consoleLogger);
  try {
    if (cmd === "revive") {
      const agentId = Number(flags.get("agent-id"));
      const payer = flags.get("payer");
      if (!Number.isSafeInteger(agentId) || agentId <= 0 || payer === undefined) throw new Error("revive needs --agent-id <N> --payer <0x…>");
      const id = await revive({ db: o.db, launchpad: o.launchpad, cfg, log: consoleLogger, configSource: o.configSource }, agentId, { address: payer, ref: flags.get("payer-ref") }, systemClock.now());
      console.log(`revival ${id} queued for agent ${agentId}`);
    } else if (cmd === "redrive") {
      const agentId = Number(flags.get("agent-id"));
      if (!Number.isSafeInteger(agentId) || agentId <= 0) throw new Error("redrive needs --agent-id <N>");
      const f = redrive(o.db, agentId, systemClock.now(), consoleLogger);
      console.log(`agent ${agentId} reset to ${f.state}; the running loop re-drives it`);
    } else if (cmd === "abandon") {
      const agentId = Number(flags.get("agent-id"));
      const reason = flags.get("reason");
      if (!Number.isSafeInteger(agentId) || agentId <= 0 || reason === undefined) throw new Error("abandon needs --agent-id <N> --reason <text>");
      const f = abandon(o.db, agentId, reason, systemClock.now(), consoleLogger);
      console.log(`agent ${agentId} → ${f.state} (${f.failReason} @ ${f.failStep}): ${reason}`);
    } else if (cmd === "status") {
      for (const kind of ["genesis", "revival"] as const) {
        for (const f of o.db.allFlows(kind)) {
          console.log(`${kind}:${f.id} agent ${f.agentId} ${f.state}${f.failReason !== null ? ` (${f.failReason} @ ${f.failStep})` : ""} job ${f.deployJobId ?? "-"} ip ${f.cvmIp ?? "-"} last: ${f.lastError ?? "-"}`);
        }
      }
    } else {
      throw new Error(`unknown command ${cmd} (run | revive | status | redrive | abandon)`);
    }
  } finally {
    o.close();
  }
}

// Entry guard (SPEC-M4F): importable by tests (parseArgs) without running the CLI.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((e) => {
    console.error(`genesis: ${errMsg(e)}`);
    process.exitCode = 1;
  });
}
