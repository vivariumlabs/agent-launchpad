// SPEC-M2C §3 — process entry point. argv only (no environment variables):
//   main --config <path> [--db <path>] [--expected-hash <hex>]
// Boots with the system clock; SIGINT/SIGTERM → runtime.stop() (final snapshot) → exit.

import { pathToFileURL } from "node:url";
import { boot, type Runtime } from "./boot.js";
import { systemClock } from "./clock.js";

export interface MainArgs {
  configPath: string;
  dbPath?: string;
  expectedHash?: string;
}

export const USAGE = "usage: main --config <path> [--db <path>] [--expected-hash <0x…32-byte hex>]";

export function parseArgs(argv: readonly string[]): MainArgs {
  let configPath: string | undefined;
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

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`[main] boot failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
