// Composition root: GenesisConfig → db + chains + launchpad + oyster + machine + watcher. Used by
// main.ts and by the anvil integration test (which injects a fake oyster-cvm Exec).
// The funding wallet key is loaded here ONCE (src/keyfile.ts) and only its LocalAccount travels on.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { CHAIN_KEYS, ViemChainClient, ViemLaunchpad, type ChainClient, type ChainKey, type Launchpad } from "./chain.js";
import type { GenesisConfig } from "./config.js";
import { createArweaveReader } from "./arweavePublish.js";
import { ArweaveConfigSource, ArweaveTagConfigSource, ChainedConfigSource, DirConfigSource, type ArweaveReader, type ConfigSource } from "./configSource.js";
import { DEFAULT_ARWEAVE_GATEWAY_URL } from "./runtimeArweave.js";
import { GenesisDb } from "./db.js";
import { nodeExec, type Exec } from "./exec.js";
import { fetchHttp, type HttpClient } from "./http.js";
import { loadWallet } from "./keyfile.js";
import type { Logger } from "./log.js";
import { Machine } from "./machine.js";
import { OysterCli, type Oyster } from "./oyster.js";
import { nullTurbo, type TurboFunder } from "./turbo.js";
import { Watcher } from "./watcher.js";

export interface OrchestratorOpts {
  log: Logger;
  exec?: Exec;
  http?: HttpClient;
  turbo?: TurboFunder;
  /** SPEC-M4E §1c: gateway reader for tag discovery (DEFAULT the runtime Turbo client's download). */
  arweaveReader?: ArweaveReader;
  /** viem polling interval (ms) for receipt waits. */
  pollingMs?: number;
}

export interface Orchestrator {
  cfg: GenesisConfig;
  db: GenesisDb;
  launchpad: Launchpad;
  chains: Partial<Record<ChainKey, ChainClient>>;
  oyster: Oyster;
  machine: Machine;
  watcher: Watcher;
  walletAddress: Address;
  close(): void;
}

/**
 * The orchestrator's frozen-config sources, in order: inbox dir (operator override / drills), SPEC-M4E
 * §1c Arweave tag discovery (arweaveDiscovery.enabled), then the ar://<txid> ref fetch (arweaveGateway
 * set). First non-null wins; the machine runs verifyFrozen on whatever comes back.
 */
export function buildConfigSource(cfg: GenesisConfig, o: { http: HttpClient; log: Logger; arweaveReader?: ArweaveReader }): ChainedConfigSource {
  const http = o.http;
  const sources: ConfigSource[] = [new DirConfigSource(cfg.configInboxDir)];
  // SPEC-M4E §1c / R4: inbox first (operator override / drills), then tag discovery of the
  // launch-helper-published config; the recorded ref becomes ar://<txid> (revival, 04 §6).
  const gateway = (cfg.arweaveGateway ?? DEFAULT_ARWEAVE_GATEWAY_URL).replace(/\/+$/, "");
  const timeoutMs = cfg.oyster.httpTimeoutSec * 1000;
  const reader = o.arweaveReader ?? createArweaveReader({ gatewayUrl: gateway, timeoutMs });
  if (cfg.arweaveDiscovery.enabled) {
    sources.push(
      new ArweaveTagConfigSource({
        graphqlUrl: cfg.arweaveGraphqlUrl ?? `${gateway}/graphql`,
        http,
        reader,
        timeoutMs,
        log: o.log,
        maxCandidates: cfg.arweaveDiscovery.maxCandidates,
      }),
    );
  }
  // ar://<ref> loads (revival) share the SAME one-redirect reader (M4E fix — raw GET refused the
  // arweave.net 302 to its data door, so every live ref fetch failed).
  sources.push(new ArweaveConfigSource(reader));
  return new ChainedConfigSource(sources);
}

export function createOrchestrator(cfg: GenesisConfig, opts: OrchestratorOpts): Orchestrator {
  const { account, format } = loadWallet(cfg.walletKeyPath);
  // oyster-cvm reads its own key file; it must be the SAME wallet (job owner = listJobs address).
  if (cfg.oyster.walletKeyFile === cfg.walletKeyPath) {
    if (format !== "hex") {
      throw new Error(`oyster-cvm --wallet-file needs a raw-hex key file; ${cfg.walletKeyPath} is JSON — set oyster.walletKeyFile`);
    }
  } else {
    const o = loadWallet(cfg.oyster.walletKeyFile);
    if (o.format !== "hex") throw new Error(`oyster.walletKeyFile ${cfg.oyster.walletKeyFile} must be a raw-hex key file`);
    if (o.account.address !== account.address) {
      throw new Error(`oyster.walletKeyFile is wallet ${o.account.address}, walletKeyPath is ${account.address} — must be the same wallet`);
    }
  }

  mkdirSync(cfg.dataDir, { recursive: true });
  const chains: Partial<Record<ChainKey, ChainClient>> = {};
  let rh: ViemChainClient | undefined;
  for (const key of CHAIN_KEYS) {
    const c = cfg.chains[key];
    if (c === undefined) continue;
    const client = new ViemChainClient(
      key,
      { rpc: c.rpc, chainId: c.chainId, caps: { maxFeePerGasWei: c.maxFeePerGasWei, maxPriorityFeePerGasWei: c.maxPriorityFeePerGasWei }, pollingMs: opts.pollingMs },
      account,
    );
    chains[key] = client;
    if (key === "rh") rh = client;
  }
  if (rh === undefined) throw new Error("chains.rh is required");
  const launchpad = new ViemLaunchpad(rh.publicClient, cfg.contracts.factory, cfg.contracts.registry, cfg.contracts.usdg);

  const http = opts.http ?? fetchHttp;
  const configSource = buildConfigSource(cfg, { http, log: opts.log, ...(opts.arweaveReader === undefined ? {} : { arweaveReader: opts.arweaveReader }) });

  const oyster = new OysterCli(
    {
      bin: cfg.oyster.bin,
      deployment: cfg.oyster.deployment,
      arch: cfg.oyster.arch,
      preset: cfg.oyster.preset,
      region: cfg.oyster.region,
      operator: cfg.oyster.operator,
      instanceType: cfg.oyster.instanceType,
      rpc: cfg.oyster.rpc,
      enclaveMemoryMb: cfg.oyster.enclaveMemoryMb,
      bandwidthKbps: cfg.oyster.bandwidthKbps,
      indexerUrl: cfg.oyster.indexerUrl,
      cpUrl: cfg.oyster.cpUrl,
      deployTimeoutSec: cfg.oyster.deployTimeoutSec,
      verifyTimeoutSec: cfg.oyster.verifyTimeoutSec,
      cliTimeoutSec: cfg.oyster.cliTimeoutSec,
      httpTimeoutSec: cfg.oyster.httpTimeoutSec,
    },
    opts.exec ?? nodeExec,
    http,
  );

  const db = new GenesisDb(join(cfg.dataDir, "genesis.sqlite"));
  const machine = new Machine({
    db,
    launchpad,
    chains,
    oyster,
    configSource,
    turbo: opts.turbo ?? nullTurbo,
    cfg,
    walletAddress: account.address,
    log: opts.log,
  });
  const watcher = new Watcher(db, launchpad, { startBlock: cfg.contracts.startBlock, confirmations: cfg.timing.confirmations, maxBlockRange: cfg.timing.maxBlockRange }, opts.log);
  return { cfg, db, launchpad, chains, oyster, machine, watcher, walletAddress: account.address, close: () => db.close() };
}
