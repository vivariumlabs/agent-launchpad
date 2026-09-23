// SPEC-M2C §3 — process entry point. argv only (no environment variables):
//   main --config <agent.json> [--runtime <runtime.json>] [--db <path>] [--expected-hash <hex>]
//   main --print-config-hash --config <agent.json>      (prints CONFIG_HASH=0x…, no boot)
//   main --help
// --runtime ⇒ SPEC-M3 §3b split layout (frozen agent.json + ops runtime.json); without it the legacy
// single-file config. Boots with the system clock; SIGINT/SIGTERM → runtime.stop() (final snapshot) → exit.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { boot, type Runtime } from "./boot.js";
import { systemClock } from "./clock.js";
import { FrozenConfigFileSchema, frozenConfigHash } from "./config/schema.js";
import type { Hex } from "viem";

export interface MainArgs {
  configPath: string;
  /** SPEC-M3 §3b ops config (runtime.json); given ⇒ split layout. */
  runtimeConfigPath?: string;
  dbPath?: string;
  expectedHash?: string;
}

export const USAGE =
  "usage: main --config <agent.json> [--runtime <runtime.json>] [--db <path>] [--expected-hash <0x…32-byte hex>]\n" +
  "       main --print-config-hash --config <agent.json>";

/**
 * SPEC-M3 §3b: the frozen config hash of an agent.json ({ platform, agent } exactly) — the value of
 * the attested `config-hash` init param (scripts/release.sh / compute-image-id.sh --config-hash).
 */
export function frozenHashOfFile(path: string): Hex {
  const json: unknown = JSON.parse(readFileSync(path, "utf8"));
  const f = FrozenConfigFileSchema.parse(json);
  return frozenConfigHash({ platform: f.platform, agent: f.agent });
}

export function parseArgs(argv: readonly string[]): MainArgs {
  let configPath: string | undefined;
  let runtimeConfigPath: string | undefined;
  let dbPath: string | undefined;
  let expectedHash: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    const take = (): string => {
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value\n${USAGE}`);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--config":
        configPath = take();
        break;
      case "--runtime":
        runtimeConfigPath = take();
        break;
      case "--db":
        dbPath = take();
        break;
      case "--expected-hash": {
        const h = take();
        if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error(`--expected-hash must be 32-byte 0x hex\n${USAGE}`);
        expectedHash = h;
        break;
      }
      default:
        throw new Error(`unknown argument ${String(flag)}\n${USAGE}`);
    }
  }
  if (configPath === undefined) throw new Error(`--config is required\n${USAGE}`);
  const out: MainArgs = { configPath };
  if (runtimeConfigPath !== undefined) out.runtimeConfigPath = runtimeConfigPath;
  if (dbPath !== undefined) out.dbPath = dbPath;
  if (expectedHash !== undefined) out.expectedHash = expectedHash;
  return out;
}

export async function main(argv: readonly string[]): Promise<Runtime> {
  const args = parseArgs(argv);
  const runtime = await boot({ ...args, clock: systemClock });
  let stopping = false;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[main] ${sig}: stopping (final snapshot)…`);
    runtime.stop().then(
      () => {
        process.exitCode = 0;
      },
      (e: unknown) => {
        console.error(`[main] stop failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  await runtime.start();
  return runtime;
}

/** `--help` / `-h` anywhere in argv ⇒ print USAGE and exit 0 without booting (image smoke test). */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/** `--print-config-hash --config <agent.json>` ⇒ the agent.json path (no other flags allowed), else null. */
export function printConfigHashTarget(argv: readonly string[]): string | null {
  if (!argv.includes("--print-config-hash")) return null;
  const rest = argv.filter((a) => a !== "--print-config-hash");
  if (rest.length !== 2 || rest[0] !== "--config" || rest[1] === undefined || rest[1].startsWith("--")) {
    throw new Error(`--print-config-hash takes exactly --config <agent.json>\n${USAGE}`);
  }
  return rest[1];
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const argv = process.argv.slice(2);
  const fail = (what: string, e: unknown): void => {
    console.error(`[main] ${what}: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  };
  if (wantsHelp(argv)) {
    console.log(USAGE);
  } else if (argv.includes("--print-config-hash")) {
    try {
      console.log(`CONFIG_HASH=${frozenHashOfFile(printConfigHashTarget(argv)!)}`);
    } catch (e) {
      fail("config hash failed", e);
    }
  } else {
    main(argv).catch((e: unknown) => fail("boot failed", e));
  }
}
