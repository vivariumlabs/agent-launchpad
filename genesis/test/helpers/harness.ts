// Unit-test harness: MockWorld chains + FakeOyster CLI + real GenesisDb (tmp file) + real Machine,
// Watcher and config (buildConfig). Time = the world's chain timestamp.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { frozenConfigHash } from "../../src/canonical.js";
import type { ChainClient, ChainKey } from "../../src/chain.js";
import { buildConfig, type GenesisConfig } from "../../src/config.js";
import { DirConfigSource } from "../../src/configSource.js";
import { GenesisDb, type FlowRow } from "../../src/db.js";
import { memoryLogger, type MemoryLogger } from "../../src/log.js";
import { Machine } from "../../src/machine.js";
import { OysterCli } from "../../src/oyster.js";
import { nullTurbo, type TurboFunder } from "../../src/turbo.js";
import { Watcher } from "../../src/watcher.js";
import { FakeOyster, simulatedEnclave } from "./fakeOyster.js";
import { BASE_USDC, E18, FACTORY, MockWorld, REGISTRY, USDG } from "./mockWorld.js";

/** anvil account #1 — public dev key (NOT a secret). */
export const FUNDING_PK: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const FUNDING: Address = privateKeyToAccount(FUNDING_PK).address;
export const CREATOR: Address = getAddress("0x000000000000000000000000000000000000C0DE");
export const IMAGE_DIGEST = `sha256:${"ab".repeat(32)}`;

export function treasuryFor(agentId: number): Address {
  return getAddress(`0x${"7ea5".padEnd(36, "0")}${agentId.toString(16).padStart(4, "0")}`);
}

export interface HarnessOpts {
  profile?: "testnet" | "mainnet";
  legs?: Record<string, { mode?: string; usdMicro?: string }>;
  chains?: ChainKey[];
  delayRegistration?: boolean;
  timing?: Record<string, number>;
  retries?: Record<string, number>;
  turbo?: TurboFunder;
  turboEnabled?: boolean;
}

export interface Harness {
  dir: string;
  cfg: GenesisConfig;
  world: MockWorld;
  oyster: FakeOyster;
  enclave: ReturnType<typeof simulatedEnclave>;
  db: GenesisDb;
  log: MemoryLogger;
  machine: Machine;
  watcher: Watcher;
  chains: Partial<Record<ChainKey, ChainClient>>;
  keyPath: string;
  newMachine(): Machine;
  reopenDb(): void;
  writeFrozen(agentId: number, mutate?: (c: { platform: Record<string, unknown>; agent: Record<string, unknown> }) => void): Hex;
  createAgent(opts?: { configHash?: Hex; noConfig?: boolean }): { agentId: number; configHash: Hex; treasury: Address };
  settle(maxRounds?: number): Promise<void>;
  flow(agentId: number): FlowRow;
}

export function makeHarness(opts: HarnessOpts = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "genesis-unit-"));
  const inbox = join(dir, "inbox");
  mkdirSync(inbox);
  const keyPath = join(dir, "funding.key");
  writeFileSync(keyPath, `${FUNDING_PK}\n`, { mode: 0o600 });
  const compose = join(dir, "v0.0.1.yml");
  writeFileSync(compose, `services:\n  agent:\n    image: ghcr.io/example/agent-runtime@sha256:${"cd".repeat(32)}\n    network_mode: host\n`);

  const chainsList = opts.chains ?? ["rh", "arbitrum"];
  const chainCfg = (id: number): Record<string, unknown> => ({ rpc: "http://127.0.0.1:1", chainId: id, maxFeePerGasWei: "100000000000", maxPriorityFeePerGasWei: "2000000000" });
  const ids: Record<ChainKey, number> = { rh: 46630, base: 8453, arbitrum: 42161, optimism: 10 };
  const chainsRaw: Record<string, unknown> = {};
  for (const c of chainsList) chainsRaw[c] = chainCfg(ids[c]);

  const raw = {
    dataDir: "data",
    walletKeyPath: "funding.key",
    contracts: { factory: FACTORY, registry: REGISTRY, usdg: USDG, startBlock: "1" },
    chains: chainsRaw,
    release: { composePath: "v0.0.1.yml" },
    configInboxDir: "inbox",
    runtimeOps: { rpc: { rh: "https://rpc.testnet.chain.robinhood.com" }, imageDigest: IMAGE_DIGEST },
    seeding: { profile: opts.profile ?? "testnet", legs: opts.legs ?? {} },
    turbo: { enabled: opts.turboEnabled ?? false },
    timing: { deployOrphanGraceSec: 0, confirmations: 0, ...(opts.timing ?? {}) },
    retries: opts.retries ?? {},
  };
  const cfg = buildConfig(raw, dir);
  mkdirSync(cfg.dataDir, { recursive: true });

  const world = new MockWorld();
  for (const c of chainsList) world.setNative(c, FUNDING, 10n * E18);
  world.setErc20("rh", USDG, FUNDING, 10_000_000_000n);
  if (chainsList.includes("base")) world.setErc20("base", BASE_USDC, FUNDING, 100_000_000n);

  const oyster = new FakeOyster();
  const enclave = simulatedEnclave(world, { delayRegistration: opts.delayRegistration });
  oyster.onDeploy = enclave.onDeploy;
  const log = memoryLogger();
  const chains: Partial<Record<ChainKey, ChainClient>> = {};
  for (const c of chainsList) chains[c] = world.client(c, FUNDING);

  const h: Harness = {
    dir,
    cfg,
    world,
    oyster,
    enclave,
    db: new GenesisDb(join(cfg.dataDir, "genesis.sqlite")),
    log,
    machine: undefined as unknown as Machine,
    watcher: undefined as unknown as Watcher,
    chains,
    keyPath,
    newMachine(): Machine {
      const cli = new OysterCli(
        {
          bin: "oyster-cvm",
          deployment: cfg.oyster.deployment,
          arch: cfg.oyster.arch,
          preset: cfg.oyster.preset,
          region: cfg.oyster.region,
          operator: cfg.oyster.operator,
          indexerUrl: cfg.oyster.indexerUrl,
          deployTimeoutSec: 1,
          verifyTimeoutSec: 1,
          cliTimeoutSec: 1,
          httpTimeoutSec: 1,
        },
        oyster,
        {
          // Oyster indexer GraphQL + provider control plane (M0 RESULTS), backed by the fake CLI's jobs.
          postJson: async () => ({ status: 200, text: JSON.stringify({ data: { providerById: { cp: "http://cp.test" } } }) }),
          get: async (url) => {
            const id = new URL(url).searchParams.get("id");
            const job = oyster.jobs.find((j) => j.id === id);
            return job === undefined ? { status: 404, text: "" } : { status: 200, text: JSON.stringify({ id, ip: job.ip }) };
          },
        },
      );
      return new Machine({
        db: h.db,
        launchpad: world.launchpad(),
        chains,
        oyster: cli,
        configSource: new DirConfigSource(inbox),
        turbo: opts.turbo ?? nullTurbo,
        cfg,
        walletAddress: FUNDING,
        log,
      });
    },
    reopenDb(): void {
      h.db.close();
      h.db = new GenesisDb(join(cfg.dataDir, "genesis.sqlite"));
      h.machine = h.newMachine();
      h.watcher = new Watcher(h.db, world.launchpad(), { startBlock: 1n, confirmations: 0, maxBlockRange: 50 }, log);
    },
    writeFrozen(agentId, mutate): Hex {
      const c = {
        platform: { note: "fixture platform snapshot", allowlistUpdateSigner: "0x0000000000000000000000000000000000000001" } as Record<string, unknown>,
        agent: { agentId, name: `Agent ${agentId}`, symbol: `AG${agentId}`, archetype: "sage", persona: "p", models: { primary: "m", fallbacks: [], chatTier: "c" }, social: { postsPerDay: 1, repliesPerDay: 1 } } as Record<string, unknown>,
      };
      mutate?.(c);
      const hash = frozenConfigHash(c);
      writeFileSync(join(inbox, `${hash}.json`), JSON.stringify(c, null, 2));
      return hash;
    },
    createAgent(o = {}): { agentId: number; configHash: Hex; treasury: Address } {
      const agentId = Number(world.agentCount + 1n);
      const configHash = o.configHash ?? (o.noConfig === true ? (`0x${"ee".repeat(32)}` as Hex) : h.writeFrozen(agentId));
      const treasury = treasuryFor(agentId);
      world.createAgent(configHash, CREATOR, treasury);
      return { agentId, configHash, treasury };
    },
    async settle(maxRounds = 30): Promise<void> {
      for (let i = 0; i < maxRounds; i++) {
        await h.watcher.poll();
        const before = JSON.stringify(h.db.allFlows("genesis").map((f) => [f.state, f.lastError])) + JSON.stringify(h.db.allFlows("revival").map((f) => [f.state, f.lastError]));
        await h.machine.resumeAll(world.timestamp);
        const after = JSON.stringify(h.db.allFlows("genesis").map((f) => [f.state, f.lastError])) + JSON.stringify(h.db.allFlows("revival").map((f) => [f.state, f.lastError]));
        if (h.db.nonTerminal().length === 0) return;
        if (before === after) world.mine();
      }
    },
    flow(agentId): FlowRow {
      const f = h.db.getLaunch(agentId);
      if (f === undefined) throw new Error(`no launch ${agentId}`);
      return f;
    },
  };
  h.machine = h.newMachine();
  h.watcher = new Watcher(h.db, world.launchpad(), { startBlock: 1n, confirmations: 0, maxBlockRange: 50 }, log);
  return h;
}

export function eventKinds(h: Harness, flow: string): string[] {
  return h.db.events(flow).map((e) => e.kind);
}
