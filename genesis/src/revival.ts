// SPEC-M3B §1 revival.ts (04 §6). revive(agentId, payerInfo) is allowed ONLY when the registry
// heartbeat is stale beyond REVIVAL_WINDOW — both values read ON-CHAIN (registry.instanceOf +
// registry.REVIVAL_WINDOW, compared against the chain's latest block timestamp, exactly the
// registry's own `block.timestamp - lastHeartbeat <= REVIVAL_WINDOW` rule). It then runs the same
// deploy path with the same frozen config (Arweave ref recorded at genesis; launch db as fallback;
// always re-verified against the recorded configHash) and the same release compose. It does NOT
// seed (reviver pays hosting) except the minimal RH gas leg `revivalGasSeed` (DEFAULT $2).
// The machine re-checks the gate when it picks the revival up (the agent may have woken meanwhile).
//
// SPEC-M4F §1 — `checkRevivable` is the FULL read-only dry-run shared by the launch-helper quote and
// the queue path (R2: never charge for an impossible revival):
//   1. gate: registered (lastHeartbeat > 0) and stale beyond REVIVAL_WINDOW (on-chain);
//   2. no active revival of the agent;
//   3. config (R4): configHash (launch row, else the AgentRequested event) and a pre-image that
//      verifies against it, resolution order launches.frozenJson → inbox → Arweave tag discovery →
//      ar:// configRef (the injected ConfigSource chain = orchestrator buildConfigSource);
//   4. compose (R3): the compose whose image-id family matches the REGISTERED codeHash —
//      launches.composePath when recorded AND its recorded imageId equals the codeHash; else the
//      runtime/releases/*.json record whose imageIds contain the codeHash → that version's yml.
//      NO match ⇒ refuse (`config_unavailable`). NEVER the current release (different compose ⇒
//      different keys ⇒ a burnt rental).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Address } from "viem";
import type { AgentInstance, Launchpad } from "./chain.js";
import { projectedRentalMicroUsdc, type GenesisConfig } from "./config.js";
import { verifyFrozen, type ConfigSource } from "./configSource.js";
import type { FlowRow, GenesisDb } from "./db.js";
import { errMsg } from "./errors.js";
import type { Logger } from "./log.js";

export type RefusalReason = "never_registered" | "heartbeat_fresh" | "revival_in_progress" | "config_unavailable" | "bad_payer";

export class RevivalRefused extends Error {
  constructor(
    readonly reason: RefusalReason,
    readonly detail: string,
  ) {
    super(`revival refused (${reason}): ${detail}`);
    this.name = "RevivalRefused";
  }
}

export interface RevivalGate {
  instance: AgentInstance;
  window: bigint;
  chainNow: bigint;
}

/** Throws RevivalRefused unless the on-chain heartbeat is stale beyond the on-chain REVIVAL_WINDOW. */
export async function checkRevivalGate(lp: Launchpad, agentId: number): Promise<RevivalGate> {
  const id = BigInt(agentId);
  const instance = await lp.instanceOf(id);
  if (instance.lastHeartbeat === 0n) throw new RevivalRefused("never_registered", `agent ${agentId} has no registered instance`);
  const window = await lp.revivalWindow();
  const chainNow = (await lp.latestBlock()).timestamp;
  const age = chainNow - instance.lastHeartbeat;
  if (age <= window) {
    throw new RevivalRefused("heartbeat_fresh", `agent ${agentId} heartbeat is ${age}s old (≤ REVIVAL_WINDOW ${window}s) — it is alive`);
  }
  return { instance, window, chainNow };
}

// ---------------------------------------------------------------------------
// R3: runtime/releases/*.json table (version → imageIds)
// ---------------------------------------------------------------------------

export interface ReleaseMatch {
  version: string;
  /** Absolute path of that release's compose yml. */
  composePath: string;
}

export interface ReleasesTable {
  /** Release whose `imageIds` record contains this image id (hex, with or without 0x; case-insensitive). */
  findByImageId(imageId: string): ReleaseMatch | null;
}

const norm = (h: string): string => h.toLowerCase().replace(/^0x/, "");

/**
 * Loads every `<dir>/*.json` release record ({version, composeFile, imageIds: {agentId: imageId}}).
 * Unparseable / foreign JSON files are skipped (reported through `log` when given).
 */
export function loadReleasesTable(dir: string, log?: Logger): ReleasesTable {
  const rows: Array<{ version: string; composePath: string; imageIds: Set<string> }> = [];
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : [];
  for (const n of names) {
    try {
      const r = JSON.parse(readFileSync(join(dir, n), "utf8")) as { version?: unknown; composeFile?: unknown; imageIds?: unknown };
      if (typeof r.version !== "string" || typeof r.composeFile !== "string" || r.imageIds === null || typeof r.imageIds !== "object") continue;
      const ids = new Set(Object.values(r.imageIds as Record<string, unknown>).filter((v): v is string => typeof v === "string").map(norm));
      rows.push({ version: r.version, composePath: join(dir, basename(r.composeFile)), imageIds: ids });
    } catch (e) {
      log?.warn(`releases table: ${join(dir, n)} skipped: ${errMsg(e)}`);
    }
  }
  return {
    findByImageId(imageId) {
      const want = norm(imageId);
      const hit = rows.find((r) => r.imageIds.has(want));
      return hit === undefined ? null : { version: hit.version, composePath: hit.composePath };
    },
  };
}

/** The release records live next to the release composes (runtime/releases/). */
export function releasesDirOf(cfg: Pick<GenesisConfig, "release">): string {
  return dirname(cfg.release.composePath);
}

// ---------------------------------------------------------------------------
// checkRevivable (R2/R3/R4)
// ---------------------------------------------------------------------------

export interface RevivalDeps {
  db: GenesisDb;
  launchpad: Launchpad;
  cfg: Pick<GenesisConfig, "release" | "contracts" | "timing">;
  log: Logger;
  /**
   * R4 sources after launches.frozenJson: the orchestrator's chain (inbox → Arweave tag discovery →
   * ar:// ref; orchestrator/configSource buildConfigSource). Absent ⇒ launches.frozenJson only.
   */
  configSource?: ConfigSource;
  /** R3 releases table. DEFAULT loadReleasesTable(dirname(cfg.release.composePath)). */
  releases?: ReleasesTable;
  /** Per-process memo of agentId → configHash found by the AgentRequested log scan (null = none since startBlock). */
  configHashCache?: Map<number, string | null>;
}

export interface GateView {
  lastHeartbeat: bigint;
  revivalWindow: bigint;
  chainNow: bigint;
  /** First chain second at which the heartbeat is stale beyond the window (lastHeartbeat + window + 1); null ⇒ never registered. */
  evictableAt: bigint | null;
  generation: number;
  codeHash: string;
  treasury: Address;
}

export type ConfigTier = "launches.frozenJson" | "inbox" | "arweave";

export type Revivability =
  | {
      revivable: true;
      agentId: number;
      configHash: string;
      /** Exact verified frozen agent.json text. */
      configText: string;
      /** Where it came from ("inbox:<h>.json" | "ar://<txid>" | the launch's recorded ref / "db:launches"). */
      configRef: string;
      configSource: ConfigTier;
      composePath: string;
      composeSource: "launches" | "releases";
      /** Release version when composeSource = releases. */
      releaseVersion: string | null;
      gate: GateView;
    }
  | { revivable: false; agentId: number; reason: RefusalReason; detail: string; gate: GateView };

/**
 * kv key for the persisted AgentRequested scan result ("none" = scanned to head, no event). Keyed by
 * the scan's start block too: a "none" is only final for the range actually scanned, so lowering
 * `contracts.startBlock` in the config must trigger a fresh scan rather than reuse a stale miss.
 */
const configHashKvKey = (agentId: number, startBlock: bigint): string => `revival.configHash.${agentId}@${startBlock}`;

/**
 * Session-17 latency fix: the full [startBlock, head] scan took ~105 s live (agent 1, ~2.7 M
 * blocks) and ran on EVERY quote for an agent with no launch record — the web quote call times
 * out. The result is FINAL for any REGISTERED agent (checkRevivable only reaches this after the
 * never_registered gate): its AgentRequested, if inside [startBlock, head], is in the past, so
 * one scan is definitive (found or permanently absent). Persist it in the genesis db kv so the
 * cost is paid once per agent per db, not once per process (the in-memory map stays as L1).
 */
async function findConfigHash(deps: RevivalDeps, agentId: number): Promise<string | null> {
  const cached = deps.configHashCache?.get(agentId);
  if (cached !== undefined) return cached;
  const kvKey = configHashKvKey(agentId, deps.cfg.contracts.startBlock);
  const persisted = deps.db.kvGet(kvKey);
  if (persisted !== undefined) {
    const v = persisted === "none" ? null : persisted;
    deps.configHashCache?.set(agentId, v);
    return v;
  }
  const latest = (await deps.launchpad.latestBlock()).number;
  const step = BigInt(deps.cfg.timing.maxBlockRange);
  let found: string | null = null;
  for (let from = deps.cfg.contracts.startBlock; from <= latest; from += step) {
    const to = from + step - 1n < latest ? from + step - 1n : latest;
    const logs = await deps.launchpad.requestedLogs(from, to, BigInt(agentId));
    const hit = logs.find((l) => l.agentId === BigInt(agentId));
    if (hit !== undefined) {
      found = hit.configHash.toLowerCase();
      break;
    }
  }
  deps.db.kvSet(kvKey, found ?? "none");
  deps.configHashCache?.set(agentId, found);
  return found;
}

function tierOf(ref: string): ConfigTier {
  return ref.startsWith("inbox:") ? "inbox" : "arweave";
}

async function resolveConfig(
  deps: RevivalDeps,
  agentId: number,
  configHash: string,
  launch: FlowRow | undefined,
): Promise<{ ok: true; text: string; ref: string; tier: ConfigTier } | { ok: false; detail: string }> {
  const misses: string[] = [];
  if (launch?.frozenJson !== null && launch?.frozenJson !== undefined) {
    try {
      verifyFrozen(launch.frozenJson, configHash, agentId);
      return { ok: true, text: launch.frozenJson, ref: launch.configRef ?? "db:launches", tier: "launches.frozenJson" };
    } catch (e) {
      misses.push(`launches.frozenJson does not verify (${errMsg(e)})`);
    }
  } else {
    misses.push("no launches.frozenJson");
  }
  if (deps.configSource !== undefined) {
    const doc = await deps.configSource.load({ configHash, ref: launch?.configRef ?? null });
    if (doc !== null) {
      try {
        verifyFrozen(doc.text, configHash, agentId);
        return { ok: true, text: doc.text, ref: doc.ref, tier: tierOf(doc.ref) };
      } catch (e) {
        misses.push(`${doc.ref} does not verify (${errMsg(e)})`);
      }
    } else {
      misses.push(`not in inbox / Arweave tag discovery${launch?.configRef?.startsWith("ar://") === true ? ` / ${launch.configRef}` : ""}`);
    }
  }
  return { ok: false, detail: `no verifiable pre-image of configHash ${configHash}: ${misses.join("; ")}` };
}

function resolveCompose(
  deps: RevivalDeps,
  codeHash: string,
  launch: FlowRow | undefined,
): { ok: true; composePath: string; source: "launches" | "releases"; version: string | null } | { ok: false; detail: string } {
  const want = norm(codeHash);
  const notes: string[] = [];
  const relDir = releasesDirOf(deps.cfg);
  if (launch?.composePath !== null && launch?.composePath !== undefined) {
    if (launch.imageId !== null && norm(launch.imageId) === want) {
      if (existsSync(launch.composePath)) return { ok: true, composePath: launch.composePath, source: "launches", version: null };
      // A db written under another checkout/mount: the same release file in this checkout's releases dir.
      const moved = join(relDir, basename(launch.composePath));
      if (existsSync(moved)) return { ok: true, composePath: moved, source: "launches", version: null };
      notes.push(`launches.composePath ${launch.composePath} missing (also not at ${moved})`);
    } else {
      notes.push(`launches.composePath ${basename(launch.composePath)} built image ${launch.imageId ?? "?"} ≠ registered codeHash — not used`);
    }
  } else {
    notes.push("no launches.composePath");
  }
  const releases = deps.releases ?? loadReleasesTable(relDir, deps.log);
  const rel = releases.findByImageId(want);
  if (rel !== null) {
    if (existsSync(rel.composePath)) return { ok: true, composePath: rel.composePath, source: "releases", version: rel.version };
    notes.push(`release ${rel.version} matches but ${rel.composePath} is missing`);
  } else {
    notes.push(`no runtime/releases/*.json imageIds entry equals ${want}`);
  }
  return { ok: false, detail: `no compose matches registered codeHash 0x${want} (${notes.join("; ")}) — refusing (a different compose derives different keys)` };
}

/** SPEC-M4F §1: the full read-only revival dry-run (R2/R3/R4). Throws only on RPC / IO failures. */
export async function checkRevivable(deps: RevivalDeps, agentId: number): Promise<Revivability> {
  const inst = await deps.launchpad.instanceOf(BigInt(agentId));
  const window = await deps.launchpad.revivalWindow();
  const chainNow = (await deps.launchpad.latestBlock()).timestamp;
  const gate: GateView = {
    lastHeartbeat: inst.lastHeartbeat,
    revivalWindow: window,
    chainNow,
    evictableAt: inst.lastHeartbeat === 0n ? null : inst.lastHeartbeat + window + 1n,
    generation: inst.generation,
    codeHash: inst.codeHash.toLowerCase(),
    treasury: inst.treasuryEOA,
  };
  const no = (reason: RefusalReason, detail: string): Revivability => ({ revivable: false, agentId, reason, detail, gate });
  if (inst.lastHeartbeat === 0n) return no("never_registered", `agent ${agentId} has no registered instance`);
  const age = chainNow - inst.lastHeartbeat;
  if (age <= window) return no("heartbeat_fresh", `agent ${agentId} heartbeat is ${age}s old (≤ REVIVAL_WINDOW ${window}s) — it is alive`);
  if (deps.db.activeRevivals(agentId).length > 0) return no("revival_in_progress", `agent ${agentId} already has an active revival`);

  const launch = deps.db.getLaunch(agentId);
  const configHash = launch?.configHash ?? (await findConfigHash(deps, agentId));
  if (configHash === null) {
    return no(
      "config_unavailable",
      `no launch record and no AgentRequested(${agentId}) event in the scanned range (block ${deps.cfg.contracts.startBlock} → head) — the event may predate this config's startBlock; configHash unknown here, so no pre-image can be resolved`,
    );
  }
  const conf = await resolveConfig(deps, agentId, configHash, launch);
  if (!conf.ok) return no("config_unavailable", conf.detail);
  const comp = resolveCompose(deps, gate.codeHash, launch);
  if (!comp.ok) return no("config_unavailable", comp.detail);
  return {
    revivable: true,
    agentId,
    configHash,
    configText: conf.text,
    configRef: conf.ref,
    configSource: conf.tier,
    composePath: comp.composePath,
    composeSource: comp.source,
    releaseVersion: comp.version,
    gate,
  };
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface PayerInfo {
  /** Who paid the revival fee (credited in the wake journal entry, 04 §6). */
  address: string;
  /** Payment reference (tx hash / receipt id), informational. */
  ref?: string | undefined;
}

/** Runs checkRevivable and queues a revival flow (driven by the machine). Returns the revival id. */
export async function revive(deps: RevivalDeps, agentId: number, payer: PayerInfo, now: bigint): Promise<number> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(payer.address)) throw new RevivalRefused("bad_payer", `payer ${payer.address} is not an address`);
  const c = await checkRevivable(deps, agentId);
  if (!c.revivable) throw new RevivalRefused(c.reason, c.detail);

  const id = deps.db.insertRevival({
    agentId,
    configHash: c.configHash,
    configRef: c.configRef,
    frozenJson: c.configText,
    composePath: c.composePath,
    treasury: c.gate.treasury,
    payer: payer.address,
    payerRef: payer.ref ?? null,
    startGeneration: c.gate.generation,
    startedAt: Number(now),
  });
  deps.db.event(
    `revival:${id}`,
    agentId,
    now,
    "revival_requested",
    `payer ${payer.address}; heartbeat age ${c.gate.chainNow - c.gate.lastHeartbeat}s > ${c.gate.revivalWindow}s; generation ${c.gate.generation}; config ${c.configSource} ${c.configRef}; compose ${c.composeSource}${c.releaseVersion === null ? "" : ` ${c.releaseVersion}`} ${basename(c.composePath)} (codeHash ${c.gate.codeHash})`,
  );
  deps.log.info(`revival ${id} queued for agent ${agentId} (payer ${payer.address}, compose ${basename(c.composePath)})`);
  return id;
}

// ---------------------------------------------------------------------------
// R6 quote
// ---------------------------------------------------------------------------

export interface RevivalQuote {
  rateUsdcMicroPerHour: bigint;
  durationMin: number;
  hostingUsdcMicro: bigint;
  gasSeedUsdMicro: bigint;
  totalUsdcMicro: bigint;
  /** Orchestrator funding wallet (R1). */
  payTo: Address;
  /** USDC on Arbitrum One (tokens.arbUsdc) and its chain id (chains.arbitrum.chainId). */
  token: Address;
  chainId: number;
}

/**
 * R6: total = revivalDurationMin/60 × rate (rounded up, = projectedRentalMicroUsdc) + revivalGasSeedUsdMicro.
 * Throws when chains.arbitrum is not configured (the payment chain).
 */
export function revivalQuote(cfg: Pick<GenesisConfig, "oyster" | "seeding" | "tokens" | "chains">, payTo: Address): RevivalQuote {
  const arb = cfg.chains.arbitrum;
  if (arb === undefined) throw new Error("revival quote needs chains.arbitrum (the USDC payment chain)");
  const durationMin = cfg.oyster.revivalDurationMin;
  const hosting = projectedRentalMicroUsdc({ durationMin, rateUsdcMicroPerHour: cfg.oyster.rateUsdcMicroPerHour });
  const gas = cfg.seeding.revivalGasSeedUsdMicro;
  return {
    rateUsdcMicroPerHour: cfg.oyster.rateUsdcMicroPerHour,
    durationMin,
    hostingUsdcMicro: hosting,
    gasSeedUsdMicro: gas,
    totalUsdcMicro: hosting + gas,
    payTo,
    token: cfg.tokens.arbUsdc,
    chainId: arb.chainId,
  };
}
