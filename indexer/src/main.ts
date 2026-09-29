// SPEC-M4A §1 main.ts — argv only (no environment variables, no secrets).
//
//   npm start -- --config <indexer.json>
//     config → db (migrations) → watcher loop (every pollMs; backfill from min(stack startBlock) in
//     maxBlockRange chunks; SPEC-M4G every stack) + balance refresh loop (every balanceRefreshSec; the
//     SPEC-M4G floor refresher runs at the same cadence when a floor vault is configured) + journal enrich loop (every enrichSec,
//     only when arweave.enabled) + attestation verify loop (every verifySec, SPEC-M4B §1b; Arweave checks
//     skip when arweave.enabled is false; release table re-read from releasesDir each pass) + HTTP API on host:port. SIGINT/SIGTERM ⇒ stop the loops after their
//     current step, close the server, close the db.
//
// The --config path resolves against the directory npm was invoked from (INIT_CWD) first, then the
// process cwd — so `npm --prefix indexer start -- --config indexer/e2e/testnet.json` from the repo
// root and `npm start -- --config e2e/testnet.json` from indexer/ both work.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { IndexerApi } from "./api.js";
import { BalanceRefresher } from "./balances.js";
import { ViemIndexerChain } from "./chain.js";
import { sleep, systemClock } from "./clock.js";
import { chainContractsOf, loadConfig } from "./config.js";
import { IndexerDb } from "./db.js";
import { Enricher, HttpArweaveClient } from "./enrich.js";
import { FloorRefresher } from "./floor.js";
import { errMsg, type Logger } from "./log.js";
import { loadReleaseTable } from "./releases.js";
import { Verifier } from "./verify.js";
import { Watcher } from "./watcher.js";

const stamp = (): string => new Date(Number(systemClock.now()) * 1000).toISOString();
const consoleLogger: Logger = {
  info: (m) => console.log(`${stamp()} INFO  ${m}`),
  warn: (m) => console.warn(`${stamp()} WARN  ${m}`),
  error: (m) => console.error(`${stamp()} ERROR ${m}`),
};

function configPath(argv: readonly string[]): string {
  const i = argv.indexOf("--config");
  const p = i >= 0 ? argv[i + 1] : undefined;
  if (p === undefined || p.startsWith("--")) throw new Error("usage: npm start -- --config <indexer.json>");
  const candidates = [process.env.INIT_CWD, process.cwd()].filter((d): d is string => d !== undefined).map((d) => resolve(d, p));
  const hit = candidates.find((c) => existsSync(c));
  if (hit === undefined) throw new Error(`config not found: ${candidates.join(" | ")}`);
  return hit;
}

async function main(): Promise<void> {
  const log = consoleLogger;
  const cfg = loadConfig(configPath(process.argv.slice(2)));
  if (cfg.dbPath !== ":memory:") mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const db = new IndexerDb(cfg.dbPath);
  const chain = new ViemIndexerChain({ rpc: cfg.chain.rpc, stacks: cfg.stacks });
  const watcher = new Watcher(db, chain, { contracts: chainContractsOf(cfg), reorgWindowBlocks: cfg.reorgWindowBlocks, maxBlockRange: cfg.maxBlockRange, senderBackfillPerPoll: cfg.senderBackfillPerPoll }, systemClock, log);
  const balances = new BalanceRefresher(db, chain, cfg.usdg, systemClock, log);
  const floor = cfg.floor === null ? null : new FloorRefresher(db, chain, cfg.usdg, cfg.floor, systemClock, log);
  const arweave = cfg.arweave.enabled ? new HttpArweaveClient({ graphqlUrl: cfg.arweave.graphqlUrl, gatewayUrl: cfg.arweave.gatewayUrl }) : null;
  const enricher = arweave === null ? null : new Enricher(db, arweave, systemClock, log);
  const releasesDir = cfg.releasesDir;
  const verifier = new Verifier(db, arweave, () => (releasesDir === undefined ? null : loadReleaseTable(releasesDir, log)), systemClock, log);
  const api = new IndexerApi(
    db,
    systemClock,
    {
      staleAfterSec: cfg.staleAfterSec,
      startBlock: watcher.startBlock(),
      gatewayUrl: cfg.arweave.gatewayUrl,
      contracts: cfg.contractsView,
      stacks: cfg.stacks,
      floor: cfg.floor === null ? null : { ...cfg.floor, usdg: cfg.usdg },
    },
    log,
  );
  const server = api.server();

  let stopping = false;
  const stop = (sig: string): void => {
    if (!stopping) log.info(`${sig}: stopping after the current step…`);
    stopping = true;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(cfg.port, cfg.host, () => res());
  });
  const stackList = cfg.stacks.map((s) => `v${s.version}${s.legacy ? " (legacy)" : ""} factory ${s.factory} ids ${s.firstAgentId}+ from ${s.startBlock}`).join("; ");
  log.info(`indexer up: api http://${cfg.host}:${cfg.port}, db ${cfg.dbPath}, stacks [${stackList}], from block ${watcher.cursor()} (startBlock ${watcher.startBlock()})`);
  log.info(cfg.floor === null ? "no floorVault in the primary manifest: /api/floor {enabled:false}" : `floor vault ${cfg.floor.vault}, token ${cfg.floor.token}`);
  if (enricher === null) log.info("arweave.enabled = false: journal enrichment off; attestation Arweave checks skip");
  if (releasesDir === undefined) log.warn("releasesDir unset: attestation releaseMatch renders \"no release table\"");

  /** Sleep in ≤ 250 ms slices so SIGINT is honored promptly. */
  const nap = async (ms: number): Promise<void> => {
    for (let left = ms; !stopping && left > 0; left -= 250) await sleep(Math.min(250, left));
  };

  const watcherLoop = async (): Promise<void> => {
    while (!stopping) await nap(await watcher.pollSafe(cfg.pollMs));
  };
  const periodic = async (name: string, everySec: number, fn: () => Promise<unknown>): Promise<void> => {
    while (!stopping) {
      try {
        await fn();
      } catch (e) {
        log.warn(`${name} LOOP FAILED: ${errMsg(e)}`); // fn() never throws by contract; belt only
      }
      await nap(everySec * 1000);
    }
  };

  await Promise.all([
    watcherLoop(),
    periodic("balances", cfg.balanceRefreshSec, () => balances.refreshAll()),
    floor === null ? Promise.resolve() : periodic("floor", cfg.balanceRefreshSec, () => floor.refresh()),
    enricher === null ? Promise.resolve() : periodic("enrich", cfg.enrichSec, () => enricher.runOnce()),
    periodic("verify", cfg.verifySec, () => verifier.runOnce()),
  ]);

  await new Promise<void>((res) => server.close(() => res()));
  db.close();
  log.info("indexer stopped (db closed)");
}

main().catch((e: unknown) => {
  console.error(`indexer: ${errMsg(e)}`);
  process.exit(1);
});
