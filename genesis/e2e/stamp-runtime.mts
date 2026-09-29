// SPEC-M4D §3 — DRILL-OPS TOOLING (not part of genesis; never run by the orchestrator).
//
// Agent-10 lesson: a runtime.json copied from another agent carried a stale `imageId`, so the runtime
// self-reported the wrong measurement in its attestation report (every report↔chain cross-check still
// passed; only the indexer's NSM quote re-verification sees it). Run this after preparing an agent
// directory and BEFORE deploy, so runtime.json's imageId is always the computed one:
//
//   npx tsx e2e/stamp-runtime.mts <agents/<id> dir> <release.yml> [oyster-cvm bin] [--dry-run]
//
//   <agents/<id> dir>  holds the frozen agent.json + runtime.json; <id> (the dir name) is the agentId.
//   <release.yml>      the release compose (runtime/releases/vX.Y.Z.yml) the agent will deploy.
//   [oyster-cvm bin]   DEFAULT /tmp/bin/oyster-cvm (the sandbox's CLI); pass "oyster-cvm" for PATH.
//   --dry-run          compute and print, do not write.
//
// image-id = oyster-cvm compute-image-id over the compose + the two ATTESTED init params
// (agent-id, config-hash = keccak256(canonicalEncode(agent.json))) — the same args genesis uses
// (src/oyster.ts computeImageIdArgs, oyster.arch/preset DEFAULT arm64/blue). Prints before/after and
// rewrites ONLY runtime.json's `imageId` (every other key and the key order preserved).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { frozenConfigHash } from "/sessions/kind-sharp-maxwell/mnt/agent-launchpad/genesis/src/canonical.js";
import { nodeExec } from "/sessions/kind-sharp-maxwell/mnt/agent-launchpad/genesis/src/exec.js";
import { computeImageIdArgs, parseImageId } from "/sessions/kind-sharp-maxwell/mnt/agent-launchpad/genesis/src/oyster.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const pos = argv.filter((a) => a !== "--dry-run");
if (pos.length < 2 || pos.length > 3) {
  console.error("usage: npx tsx e2e/stamp-runtime.mts <agents/<id> dir> <release.yml> [oyster-cvm bin] [--dry-run]");
  process.exit(1);
}
const dir = resolve(pos[0]!);
const compose = resolve(pos[1]!);
const bin = pos[2] ?? "/tmp/bin/oyster-cvm";

const agentId = Number(basename(dir));
if (!Number.isSafeInteger(agentId) || agentId <= 0 || String(agentId) !== basename(dir)) throw new Error(`agent dir name must be the decimal agentId, got ${JSON.stringify(basename(dir))}`);
const agentPath = join(dir, "agent.json");
const runtimePath = join(dir, "runtime.json");
for (const p of [agentPath, runtimePath, compose]) if (!existsSync(p)) throw new Error(`missing ${p}`);

const frozen = JSON.parse(readFileSync(agentPath, "utf8")) as { platform: unknown; agent: unknown };
const configHash = frozenConfigHash(frozen);
const args = computeImageIdArgs({ arch: "arm64", preset: "blue" }, { composePath: compose, agentId, configHash });
console.log(`agent ${agentId}  configHash ${configHash}`);
console.log(`$ ${bin} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);

const r = await nodeExec.run(bin, args, { timeoutMs: 120_000 });
const computed = parseImageId(`${r.stdout}\n${r.stderr}`);
if (r.code !== 0 || computed === null) {
  console.error(`${r.stdout}\n${r.stderr}`.trim());
  throw new Error(`oyster-cvm compute-image-id failed (exit ${r.code}${r.timedOut ? ", timed out" : ""})`);
}

const text = readFileSync(runtimePath, "utf8");
const runtime = JSON.parse(text) as Record<string, unknown>;
const before = typeof runtime.imageId === "string" ? runtime.imageId : null;
const after = `0x${computed}`;
console.log(`runtime.json imageId  before: ${before ?? "(absent)"}`);
console.log(`runtime.json imageId   after: ${after}${before !== null && before.toLowerCase() === after ? "  (unchanged)" : "  (CHANGED)"}`);

if (dryRun) {
  console.log("--dry-run: runtime.json NOT written");
} else if (before === after) {
  console.log("runtime.json already carries the computed imageId: not rewritten");
} else {
  runtime.imageId = after;
  writeFileSync(runtimePath, JSON.stringify(runtime, null, 2) + (text.endsWith("\n") ? "\n" : ""));
  console.log(`wrote ${runtimePath}`);
}
