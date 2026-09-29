// SPEC-M4F §1 — revive flow, genesis side: checkRevivable (R2/R3/R4), R5 EXTERNAL adoption guard +
// abandon + deploy-lock sweep, R6 quote math, R1 payment verification, and the launch-helper revive
// endpoints. Goldens: the REAL runtime/releases/*.json table (agent 8 → v0.1.6, agents 3/4 →
// v0.1.2/v0.1.3, agent-1-style codeHash → no release) and agent 8's frozen config fixture. No network,
// no dependency on e2e/data/genesis.sqlite (db rows are built in a tmp GenesisDb).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { erc20Abi } from "../src/abi.js";
import type { Launchpad, TxLog, TxReceipt } from "../src/chain.js";
import { buildConfig, loadConfig, type GenesisConfig } from "../src/config.js";
import { DirConfigSource } from "../src/configSource.js";
import { GenesisDb } from "../src/db.js";
import type { KmsDeriver } from "../src/kmsDerive.js";
import { createLaunchHelper, LaunchHelper } from "../src/launchHelper.js";
import { memoryLogger } from "../src/log.js";
import { abandon, sweepDeployLock } from "../src/machine.js";
import { parseArgs } from "../src/main.js";
import { checkRevivable, loadReleasesTable, revivalQuote, revive, RevivalRefused, type RevivalDeps } from "../src/revival.js";
import { MANUAL_REVIVAL, quoteJson, ReviveService, verifyRevivalPayment, type ReceiptReader, reviveIntentMessage } from "../src/reviveApi.js";
import { CREATOR, FUNDING, makeHarness, treasuryFor, type Harness } from "./helpers/harness.js";
import { FACTORY, USDG } from "./helpers/mockWorld.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const RELEASES = join(REPO, "runtime", "releases");
const MANIFEST = join(REPO, "contracts", "deployments", "testnet-46630.json");
const AGENT8_TEXT = readFileSync(join(here, "fixtures", "agent-8.json"), "utf8");
const CFG8 = "0x06640d641b49e5f0918360fb46ab6d24036b1888d062290d3e46c231243905d2";
const IMG8 = "f489dc609c6b33a7016c113f0965a46de35c4cfd2ef8e8f4751bd845923a4350";
/** What the orchestrator's v0.1.7 compose built for agent 8 in the session-15 incident (≠ the registered codeHash). */
const IMG8_WRONG = "9bc5c0d19d61feda8b7a76ef656f171085475c40e971b91c66ac7ed4b187b2ad";
const IMG3 = "a55185da1644baa0238a3b76cae823a96a63c7d31464f8fb8d580c39ad919e59";
const IMG4 = "92bc268c8a2661486cf1c29f5d36b203669bab7d7d728946c989a3f0575f7a27";
/** Agent-1 shape: a codeHash no release produced (prefix of the live one, synthetic tail). */
const AGENT1_CODEHASH = `0xc842c3ba${"5a".repeat(28)}` as Hex;
const PAY_TO = getAddress("0x6930FD5C95a2D9d80F3d165597d55843e8A00154");
const ARB_USDC = getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
// M4F rev 1: the payer SIGNS the revive intent, so the test payer is a real key.
const PAYER_ACCOUNT = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const PAYER = PAYER_ACCOUNT.address;
const signIntent = (agentId: number, tx: string): Promise<Hex> => PAYER_ACCOUNT.signMessage({ message: reviveIntentMessage(agentId, tx) });
const DAY = 86_400n;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Registers an instance directly in the mock registry (heartbeat `ago` seconds before now). */
function register(h: Harness, agentId: number, codeHash: string, ago: bigint): bigint {
  const hb = h.world.timestamp - ago;
  h.world.instances.set(BigInt(agentId), {
    treasuryEOA: treasuryFor(agentId),
    actionEOA: getAddress(`0x${"ac".repeat(19)}${agentId.toString(16).padStart(2, "0")}`),
    codeHash: codeHash as Hex,
    attestationRef: "ar://att",
    lastHeartbeat: hb,
    generation: 1,
  });
  return hb;
}

function requestedEvent(h: Harness, agentId: number, configHash: string): void {
  h.world.logs.push({ agentId: BigInt(agentId), configHash: configHash as Hex, creator: CREATOR, blockNumber: h.world.blockNumber, txHash: keccak256(stringToHex(`req-${agentId}`)), logIndex: 0 });
}

function launchRow(h: Harness, agentId: number, r: { configHash: string; frozenJson?: string | null; composePath?: string | null; imageId?: string | null; configRef?: string | null; state?: "LIVE" | "FAILED" }): void {
  h.db.insertRequested({ agentId, configHash: r.configHash, creator: CREATOR, requestTx: `0x${"11".repeat(32)}`, requestBlock: 5, requestedAt: 1 });
  h.db.patchFlow(
    { kind: "genesis", id: agentId },
    { state: r.state ?? "LIVE", frozenJson: r.frozenJson ?? null, composePath: r.composePath ?? null, imageId: r.imageId ?? null, configRef: r.configRef ?? null },
    h.world.timestamp,
  );
}

function frozenText(h: Harness, agentId: number): { configHash: Hex; text: string; path: string } {
  const configHash = h.writeFrozen(agentId);
  const path = join(h.cfg.configInboxDir, `${configHash}.json`);
  return { configHash, text: readFileSync(path, "utf8"), path };
}

function deps(h: Harness, o: Partial<RevivalDeps> & { cfg?: RevivalDeps["cfg"] } = {}): RevivalDeps {
  return { db: h.db, launchpad: h.world.launchpad(), cfg: h.cfg, log: h.log, configSource: new DirConfigSource(h.cfg.configInboxDir), ...o };
}

/** The harness config, but with the release compose inside the REAL runtime/releases dir. */
function realReleasesCfg(h: Harness): GenesisConfig {
  return { ...h.cfg, release: { composePath: join(RELEASES, "v0.1.7.yml") } };
}

async function liveThenStale(): Promise<{ h: Harness; agentId: number }> {
  const h = makeHarness();
  const { agentId } = h.createAgent();
  await h.settle();
  expect(h.flow(agentId).state).toBe("LIVE");
  h.world.mine(8n * DAY);
  return { h, agentId };
}

function transferLog(token: Address, from: Address, to: Address, value: bigint): TxLog {
  return { address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [value]) };
}

function rcOf(logs: TxLog[], status: "success" | "reverted" = "success"): TxReceipt {
  return { status, blockNumber: 1234n, logs };
}

const txh = (n: number): Hex => keccak256(stringToHex(`pay-${n}`));

interface ApiWorld {
  h: Harness;
  agentId: number;
  helper: LaunchHelper;
  receipts: Map<string, TxReceipt | Error>;
  lp: { fail: Error | null };
  total: bigint;
  paidAt: { value: bigint | null };
}

async function apiWorld(): Promise<ApiWorld> {
  const { h, agentId } = await liveThenStale();
  const receipts = new Map<string, TxReceipt | Error>();
  const paidAt = { value: null as bigint | null }; // null => "now" (fresh)
  const reader: ReceiptReader = {
    receipt: async (hash) => {
      const r = receipts.get(hash.toLowerCase());
      if (r instanceof Error) throw r;
      return r ?? null;
    },
    blockTimestamp: async () => paidAt.value ?? h.world.timestamp,
  };
  const lpState = { fail: null as Error | null };
  const base = h.world.launchpad();
  const launchpad: Launchpad = {
    ...base,
    instanceOf: async (id) => {
      if (lpState.fail !== null) throw lpState.fail;
      return base.instanceOf(id);
    },
  };
  const quote = revivalQuote(h.cfg, PAY_TO);
  const svc = new ReviveService({
    revival: { db: h.db, launchpad, cfg: h.cfg, log: h.log, configSource: new DirConfigSource(h.cfg.configInboxDir), configHashCache: new Map() },
    receipts: reader,
    quote,
    clock: { now: () => h.world.timestamp },
    log: h.log,
  });
  return { h, agentId, helper: bareHelper(h, svc), receipts, lp: lpState, total: quote.totalUsdcMicro, paidAt };
}

function bareHelper(h: Harness, revive?: ReviveService): LaunchHelper {
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  return new LaunchHelper({
    platform: { x402Allowlist: [] },
    composePath: "unused.yml",
    composeVersion: "v0",
    contracts: { factory: FACTORY, usdg: USDG },
    oyster: { computeImageId: unused },
    kms: { deriveAddress: unused } as KmsDeriver,
    factory: { agentCount: async () => 1n },
    rejections: () => undefined,
    corsOrigin: "*",
    clock: { now: () => h.world.timestamp },
    log: h.log,
    ...(revive === undefined ? {} : { revive }),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(helper: LaunchHelper, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await helper.handle({ method, url, body: body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, body: res.body === "" ? null : JSON.parse(res.body) };
}

// ---------------------------------------------------------------------------
// checkRevivable matrix
// ---------------------------------------------------------------------------

describe("M4F §1: checkRevivable", () => {
  it("M4F §1: checkRevivable matrix — fresh heartbeat ⇒ heartbeat_fresh (gate + evictableAt = lastHeartbeat + window + 1); never registered ⇒ never_registered", async () => {
    const h = makeHarness();
    const { configHash, text } = frozenText(h, 7);
    launchRow(h, 7, { configHash, frozenJson: text, composePath: h.cfg.release.composePath, imageId: "aa".repeat(32) });
    const hb = register(h, 7, `0x${"aa".repeat(32)}`, 6n * DAY);
    const r = await checkRevivable(deps(h), 7);
    expect(r).toMatchObject({ revivable: false, reason: "heartbeat_fresh" });
    expect(r.gate).toMatchObject({ lastHeartbeat: hb, revivalWindow: 7n * DAY, evictableAt: hb + 7n * DAY + 1n, generation: 1 });
    // boundary: exactly REVIVAL_WINDOW old is still fresh (registry `<=`); one second later it is revivable
    h.world.timestamp = hb + 7n * DAY;
    expect(await checkRevivable(deps(h), 7)).toMatchObject({ revivable: false, reason: "heartbeat_fresh" });
    h.world.timestamp += 1n;
    expect(await checkRevivable(deps(h), 7)).toMatchObject({ revivable: true, composeSource: "launches", configSource: "launches.frozenJson" });

    const n = await checkRevivable(deps(h), 42);
    expect(n).toMatchObject({ revivable: false, reason: "never_registered" });
    expect(n.gate.evictableAt).toBeNull();
    await expect(revive(deps(h), 42, { address: FUNDING }, h.world.timestamp)).rejects.toMatchObject({ reason: "never_registered" });
  });

  it("M4F §1: checkRevivable matrix — no config anywhere ⇒ config_unavailable (agent-1 shape: no launch row, no AgentRequested; event known but no pre-image; tampered db copy); nothing queued", async () => {
    const h = makeHarness();
    // agent 1 shape: registered + stale, but no launch record and no AgentRequested since startBlock
    register(h, 1, AGENT1_CODEHASH, 30n * DAY);
    const a1 = await checkRevivable(deps(h), 1);
    expect(a1).toMatchObject({ revivable: false, reason: "config_unavailable" });
    expect(a1.revivable === false && a1.detail).toMatch(/configHash unknown/);
    // configHash known from the event, but no pre-image in the db / inbox
    register(h, 2, `0x${"bb".repeat(32)}`, 30n * DAY);
    requestedEvent(h, 2, `0x${"ee".repeat(32)}`);
    const a2 = await checkRevivable(deps(h), 2);
    expect(a2).toMatchObject({ revivable: false, reason: "config_unavailable" });
    expect(a2.revivable === false && a2.detail).toMatch(/no verifiable pre-image/);
    // a launch row whose frozenJson does not hash to its configHash (and nothing in the inbox)
    const { configHash, text, path } = frozenText(h, 3);
    rmSync(path);
    launchRow(h, 3, { configHash, frozenJson: text.replace("Agent 3", "Agent 3!"), composePath: h.cfg.release.composePath, imageId: "cc".repeat(32) });
    register(h, 3, `0x${"cc".repeat(32)}`, 30n * DAY);
    const a3 = await checkRevivable(deps(h), 3);
    expect(a3).toMatchObject({ revivable: false, reason: "config_unavailable" });
    expect(a3.revivable === false && a3.detail).toMatch(/launches\.frozenJson does not verify/);
    // the queue path refuses identically and queues nothing
    const e = await revive(deps(h), 1, { address: FUNDING }, h.world.timestamp).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RevivalRefused);
    expect((e as RevivalRefused).reason).toBe("config_unavailable");
    expect(h.db.allFlows("revival")).toHaveLength(0);
  });

  it("M4F §1: checkRevivable matrix — compose match via launches (recorded imageId == registered codeHash); a db written under another mount resolves the same release file by name; config order frozenJson → inbox", async () => {
    const h = makeHarness();
    // (a) recorded compose exists
    const c5 = frozenText(h, 5);
    launchRow(h, 5, { configHash: c5.configHash, frozenJson: c5.text, composePath: h.cfg.release.composePath, imageId: "dd".repeat(32), configRef: "inbox:x" });
    register(h, 5, `0x${"DD".repeat(32)}`, 9n * DAY); // codeHash case must not matter
    const r5 = await checkRevivable(deps(h), 5);
    expect(r5).toMatchObject({ revivable: true, composePath: h.cfg.release.composePath, composeSource: "launches", releaseVersion: null, configSource: "launches.frozenJson", configText: c5.text });
    // (b) the e2e db shape: composePath recorded under another sandbox mount → same file name in this checkout's releases dir (agent 3, v0.1.2)
    const c3 = frozenText(h, 3);
    launchRow(h, 3, { configHash: c3.configHash, composePath: "/sessions/magical-zealous-davinci/mnt/agent-launchpad/runtime/releases/v0.1.2.yml", imageId: IMG3 });
    register(h, 3, `0x${IMG3}`, 9n * DAY);
    const r3 = await checkRevivable(deps(h, { cfg: realReleasesCfg(h) }), 3);
    expect(r3).toMatchObject({ revivable: true, composePath: join(RELEASES, "v0.1.2.yml"), composeSource: "launches" });
    // no frozenJson in the row ⇒ the inbox copy (R4 order)
    expect(r3).toMatchObject({ configSource: "inbox", configRef: `inbox:${c3.configHash}.json`, configText: c3.text });
  });

  it("M4F §1: checkRevivable matrix — compose match via the releases table: agent-8 incident shape (launches.composePath built a DIFFERENT image) ⇒ v0.1.6.yml by codeHash, never the current release", async () => {
    // golden: the committed release records
    const t = loadReleasesTable(RELEASES);
    expect(t.findByImageId(IMG8)).toEqual({ version: "v0.1.6", composePath: join(RELEASES, "v0.1.6.yml") });
    expect(t.findByImageId(`0x${IMG8.toUpperCase()}`)?.version).toBe("v0.1.6");
    expect(t.findByImageId(IMG3)?.version).toBe("v0.1.2");
    expect(t.findByImageId(IMG4)?.version).toBe("v0.1.3");
    expect(t.findByImageId(AGENT1_CODEHASH)).toBeNull();

    const h = makeHarness();
    const cfg = realReleasesCfg(h);
    // agent 8: the launch row the orchestrator wrote when it adopted the externally-launched agent (v0.1.7 compose, wrong image)
    launchRow(h, 8, { configHash: CFG8, frozenJson: AGENT8_TEXT, composePath: join(RELEASES, "v0.1.7.yml"), imageId: IMG8_WRONG, state: "FAILED" });
    register(h, 8, `0x${IMG8}`, 10n * DAY);
    const r = await checkRevivable(deps(h, { cfg }), 8);
    expect(r).toMatchObject({ revivable: true, composePath: join(RELEASES, "v0.1.6.yml"), composeSource: "releases", releaseVersion: "v0.1.6", configHash: CFG8, configSource: "launches.frozenJson" });
    expect(r.revivable && r.composePath).not.toBe(cfg.release.composePath);
    // queue path: the revival row carries the matched compose + the verified config
    const id = await revive(deps(h, { cfg }), 8, { address: PAYER, ref: "0xpay" }, h.world.timestamp);
    const row = h.db.getFlow({ kind: "revival", id })!;
    expect(row).toMatchObject({ composePath: join(RELEASES, "v0.1.6.yml"), configHash: CFG8, frozenJson: AGENT8_TEXT, startGeneration: 1, payer: PAYER });
    expect(h.db.events(`revival:${id}`)[0]!.detail).toMatch(/compose releases v0\.1\.6 v0\.1\.6\.yml/);

    // no launch row at all: configHash from the AgentRequested event, config from the inbox, compose from the table
    const h2 = makeHarness();
    writeFileSync(join(h2.cfg.configInboxDir, `${CFG8}.json`), AGENT8_TEXT);
    requestedEvent(h2, 8, CFG8);
    register(h2, 8, `0x${IMG8}`, 10n * DAY);
    const cache = new Map<number, string | null>();
    const r2 = await checkRevivable(deps(h2, { cfg: realReleasesCfg(h2), configHashCache: cache }), 8);
    expect(r2).toMatchObject({ revivable: true, composeSource: "releases", releaseVersion: "v0.1.6", configSource: "inbox" });
    expect(cache.get(8)).toBe(CFG8);
  });

  it("M4F §1: checkRevivable matrix — no compose match ⇒ config_unavailable (never falls back to the current release)", async () => {
    const h = makeHarness();
    const cfg = realReleasesCfg(h);
    expect(existsSync(cfg.release.composePath)).toBe(true); // the current release exists — and must NOT be used
    const c = frozenText(h, 9);
    requestedEvent(h, 9, c.configHash);
    register(h, 9, AGENT1_CODEHASH, 10n * DAY);
    const r = await checkRevivable(deps(h, { cfg }), 9);
    expect(r).toMatchObject({ revivable: false, reason: "config_unavailable" });
    expect(r.revivable === false && r.detail).toMatch(/no compose matches registered codeHash/);
    // a recorded compose whose image differs from the registered codeHash is not trusted either
    launchRow(h, 9, { configHash: c.configHash, frozenJson: c.text, composePath: cfg.release.composePath, imageId: IMG8_WRONG });
    const r2 = await checkRevivable(deps(h, { cfg }), 9);
    expect(r2).toMatchObject({ revivable: false, reason: "config_unavailable" });
    expect(r2.revivable === false && r2.detail).toMatch(/≠ registered codeHash — not used/);
    await expect(revive(deps(h, { cfg }), 9, { address: PAYER }, h.world.timestamp)).rejects.toMatchObject({ reason: "config_unavailable" });
    expect(h.db.allFlows("revival")).toHaveLength(0);
  });

  it("M4F §1: machine R3 — a revival row without a recorded compose FAILs (config_unavailable) before any deploy; a revival stamps runtime.json imageId = registered codeHash and rents revivalDurationMin", async () => {
    const { h, agentId } = await liveThenStale();
    const launch = h.flow(agentId);
    const inst = h.world.instances.get(BigInt(agentId))!;
    const bad = h.db.insertRevival({ agentId, configHash: launch.configHash, configRef: null, frozenJson: launch.frozenJson, composePath: null, treasury: inst.treasuryEOA, payer: PAYER, payerRef: null, startGeneration: 1, startedAt: Number(h.world.timestamp) });
    await h.machine.drive({ kind: "revival", id: bad }, h.world.timestamp);
    expect(h.db.getFlow({ kind: "revival", id: bad })).toMatchObject({ state: "FAILED", failReason: "config_unavailable" });
    expect(h.oyster.count("deploy")).toBe(1); // genesis only

    h.cfg.oyster.revivalDurationMin = 240; // R6: the duration the quote charged
    const rid = await revive(deps(h), agentId, { address: PAYER }, h.world.timestamp);
    await h.settle();
    expect(h.db.getFlow({ kind: "revival", id: rid })!.state).toBe("LIVE");
    const rt = JSON.parse(readFileSync(join(h.cfg.dataDir, "agents", String(agentId), `revival-${rid}`, "runtime.json"), "utf8")) as { imageId: string };
    expect(rt.imageId).toBe(inst.codeHash);
    const deploys = h.oyster.calls.filter((c) => c.args[0] === "deploy");
    const dur = (args: string[]): string => args[args.indexOf("--duration-in-minutes") + 1]!;
    expect([dur(deploys[0]!.args), dur(deploys[1]!.args)]).toEqual(["180", "240"]);
    expect(h.db.events(`revival:${rid}`).find((e) => e.kind === "deploy_submitted")!.detail).toMatch(/durationMin 240 × 0\.24 USDC\/h/);
  });
});

// ---------------------------------------------------------------------------
// R5
// ---------------------------------------------------------------------------

describe("M4F §1: R5 adoption guard, abandon, lock sweep", () => {
  it("M4F §1: EXTERNAL adoption — a REQUESTED launch whose agent is already registered on-chain is never driven (agent-8 incident regression), even adopted days late", async () => {
    const h = makeHarness();
    const a = h.createAgent();
    // launched OUTSIDE this orchestrator: the enclave registered before the watcher adopted the request
    h.world.registerInstance(BigInt(a.agentId), a.treasury, getAddress(`0x${"ac".repeat(20)}`), `0x${IMG8}`);
    await h.settle();
    expect(h.flow(a.agentId)).toMatchObject({ state: "EXTERNAL", deployAttempts: 0, deployJobId: null, composePath: null, imageId: null });
    expect(h.oyster.calls).toEqual([]); // no compute-image-id, no list, no deploy
    expect(h.world.finalizeCalls).toEqual([]);
    expect(h.world.executed).toEqual([]); // no seed, no preGas
    expect(h.db.events(`genesis:${a.agentId}`).map((e) => e.kind)).toEqual(["requested", "external"]);
    expect(h.log.lines.some((l) => /EXTERNAL: .*completed outside this orchestrator/.test(l))).toBe(true);
    expect(h.db.nonTerminal()).toEqual([]);

    // adopted > 24 h late (watcher cursor behind): EXTERNAL, not FAILED(timeout)
    const b = h.createAgent();
    h.world.registerInstance(BigInt(b.agentId), b.treasury, getAddress(`0x${"ad".repeat(20)}`), `0x${IMG3}`);
    h.world.mine(3n * DAY);
    await h.settle();
    expect(h.flow(b.agentId).state).toBe("EXTERNAL");
    expect(h.oyster.count("deploy")).toBe(0);

    // a normal launch is unaffected by the guard
    const c = h.createAgent();
    await h.settle();
    expect(h.flow(c.agentId).state).toBe("LIVE");
  });

  it("M4F §1: abandon CLI — `genesis abandon --agent-id N --reason <text>` moves a non-terminal launch to FAILED(abandoned) with the reason; refuses terminal / unknown / empty reason; releases its deploy lock", () => {
    const { cmd, flags } = parseArgs(["abandon", "--config", "g.json", "--agent-id", "8", "--reason", "launched outside the orchestrator"]);
    expect([cmd, flags.get("agent-id"), flags.get("reason")]).toEqual(["abandon", "8", "launched outside the orchestrator"]);
    expect(() => parseArgs(["abandon", "--agent-id", "8", "--reason"])).toThrow(/requires a value/);

    const h = makeHarness();
    launchRow(h, 8, { configHash: CFG8 });
    h.db.patchFlow({ kind: "genesis", id: 8 }, { state: "DEPLOYING", deployInFlight: 1 }, h.world.timestamp);
    h.db.kvSet("deploy.lock", "genesis:8");
    const f = abandon(h.db, 8, "launched outside the orchestrator", h.world.timestamp, h.log);
    expect(f).toMatchObject({ state: "FAILED", failReason: "abandoned", failStep: "DEPLOYING", lastError: "abandoned by operator: launched outside the orchestrator", deployInFlight: 0 });
    expect(h.db.kvGet("deploy.lock")).toBeUndefined();
    expect(h.db.events("genesis:8").map((e) => [e.kind, e.detail])).toEqual([["abandoned", "from DEPLOYING: launched outside the orchestrator"]]);
    expect(h.db.nonTerminal()).toEqual([]);
    expect(() => abandon(h.db, 8, "again", h.world.timestamp, h.log)).toThrow(/already terminal/);
    expect(() => abandon(h.db, 99, "x", h.world.timestamp, h.log)).toThrow(/no launch/);
    launchRow(h, 9, { configHash: CFG8, state: "LIVE" });
    h.db.patchFlow({ kind: "genesis", id: 9 }, { state: "REQUESTED" }, h.world.timestamp);
    expect(() => abandon(h.db, 9, "   ", h.world.timestamp, h.log)).toThrow(/non-empty/);
    // a lock held by ANOTHER flow is left alone
    h.db.kvSet("deploy.lock", "genesis:10");
    abandon(h.db, 9, "operator decision", h.world.timestamp, h.log);
    expect(h.db.kvGet("deploy.lock")).toBe("genesis:10");
  });

  it("M4F §1: lock sweep — startup releases a deploy.lock held by a terminal (or missing) flow; a live holder keeps it", () => {
    const h = makeHarness();
    expect(sweepDeployLock(h.db, h.world.timestamp, h.log)).toBeNull();
    launchRow(h, 8, { configHash: CFG8, state: "FAILED" });
    h.db.kvSet("deploy.lock", "genesis:8");
    expect(sweepDeployLock(h.db, h.world.timestamp, h.log)).toBe("genesis:8");
    expect(h.db.kvGet("deploy.lock")).toBeUndefined();
    expect(h.db.events("genesis:8").map((e) => [e.kind, e.detail])).toEqual([["deploy_lock_swept", "holder is FAILED"]]);
    // EXTERNAL is terminal too
    launchRow(h, 11, { configHash: CFG8 });
    h.db.patchFlow({ kind: "genesis", id: 11 }, { state: "EXTERNAL" }, h.world.timestamp);
    h.db.kvSet("deploy.lock", "genesis:11");
    expect(sweepDeployLock(h.db, h.world.timestamp, h.log)).toBe("genesis:11");
    // missing holder
    h.db.kvSet("deploy.lock", "revival:77");
    expect(sweepDeployLock(h.db, h.world.timestamp, h.log)).toBe("revival:77");
    expect(h.db.kvGet("deploy.lock")).toBeUndefined();
    // a non-terminal holder keeps its lock
    launchRow(h, 12, { configHash: CFG8 });
    h.db.patchFlow({ kind: "genesis", id: 12 }, { state: "DEPLOYING" }, h.world.timestamp);
    h.db.kvSet("deploy.lock", "genesis:12");
    expect(sweepDeployLock(h.db, h.world.timestamp, h.log)).toBeNull();
    expect(h.db.kvGet("deploy.lock")).toBe("genesis:12");
    expect(h.log.lines.filter((l) => /released stale deploy\.lock/.test(l))).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// R6 quote
// ---------------------------------------------------------------------------

describe("M4F §1: quote", () => {
  it("M4F §1: quote math golden — total = revivalDurationMin/60 × rate + revivalGasSeed; testnet 2.72, mainnet 174.8, override; the committed e2e config; USDC on Arbitrum One", () => {
    const t = makeHarness();
    expect(revivalQuote(t.cfg, PAY_TO)).toEqual({
      rateUsdcMicroPerHour: 240_000n,
      durationMin: 180,
      hostingUsdcMicro: 720_000n,
      gasSeedUsdMicro: 2_000_000n,
      totalUsdcMicro: 2_720_000n,
      payTo: PAY_TO,
      token: ARB_USDC,
      chainId: 42161,
    });
    expect(quoteJson(revivalQuote(t.cfg, PAY_TO))).toEqual({
      rateUsdcMicroPerHour: "240000",
      durationMin: 180,
      hostingUsdcMicro: "720000",
      gasSeedUsdMicro: "2000000",
      totalUsdcMicro: "2720000",
      payTo: PAY_TO,
      token: ARB_USDC,
      chainId: 42161,
      decimals: 6,
    });
    const m = makeHarness({ profile: "mainnet", chains: ["rh", "arbitrum", "base", "optimism"], turboEnabled: true });
    expect(revivalQuote(m.cfg, PAY_TO)).toMatchObject({ durationMin: 43_200, hostingUsdcMicro: 172_800_000n, totalUsdcMicro: 174_800_000n });
    // rounding: ceil(durationMin × rate / 60)
    expect(revivalQuote({ ...t.cfg, oyster: { ...t.cfg.oyster, revivalDurationMin: 1, rateUsdcMicroPerHour: 61n } }, PAY_TO)).toMatchObject({ hostingUsdcMicro: 2n, totalUsdcMicro: 2_000_002n });
    // the committed e2e config: oyster.durationMin 60 (drill deploys) but revivalDurationMin DEFAULT = profile (180)
    const e2e = loadConfig(join(REPO, "genesis", "e2e", "genesis.testnet.json"));
    expect(e2e.oyster.durationMin).toBe(60);
    expect(revivalQuote(e2e, e2e.launchHelper!.revivalPayTo!)).toMatchObject({ durationMin: 180, totalUsdcMicro: 2_720_000n, payTo: PAY_TO, token: ARB_USDC, chainId: 42161 });
    // no payment chain ⇒ no quote
    const noArb = makeHarness({ chains: ["rh"], legs: { "arbitrum.eth": { mode: "disabled" } } });
    expect(() => revivalQuote(noArb.cfg, PAY_TO)).toThrow(/chains\.arbitrum/);
  });
});

// ---------------------------------------------------------------------------
// R1 payment verification + endpoints
// ---------------------------------------------------------------------------

describe("M4F §1: payment verification + endpoints", () => {
  it("M4F §1: payment verification — wrong recipient / wrong token / payer mismatch / short amount / reverted tx / not found; sums the payer's transfers", () => {
    const o = { token: ARB_USDC, payTo: PAY_TO, payer: PAYER, minAmount: 2_720_000n };
    const other = getAddress("0x0000000000000000000000000000000000000bad");
    expect(verifyRevivalPayment(null, o)).toMatchObject({ ok: false, problem: "payment_not_found" });
    expect(verifyRevivalPayment(rcOf([transferLog(ARB_USDC, PAYER, PAY_TO, 2_720_000n)], "reverted"), o)).toMatchObject({ ok: false, problem: "payment_reverted" });
    expect(verifyRevivalPayment(rcOf([transferLog(ARB_USDC, PAYER, other, 9_000_000n)]), o)).toMatchObject({ ok: false, problem: "wrong_recipient" });
    expect(verifyRevivalPayment(rcOf([transferLog(other, PAYER, PAY_TO, 9_000_000n)]), o)).toMatchObject({ ok: false, problem: "wrong_recipient" }); // not USDC
    expect(verifyRevivalPayment(rcOf([transferLog(ARB_USDC, other, PAY_TO, 9_000_000n)]), o)).toMatchObject({ ok: false, problem: "payer_mismatch" });
    expect(verifyRevivalPayment(rcOf([transferLog(ARB_USDC, PAYER, PAY_TO, 2_719_999n)]), o)).toMatchObject({ ok: false, problem: "short_amount" });
    expect(verifyRevivalPayment(rcOf([transferLog(ARB_USDC, PAYER, PAY_TO, 2_720_000n)]), o)).toEqual({ ok: true, amount: 2_720_000n });
    expect(verifyRevivalPayment(rcOf([transferLog(ARB_USDC, PAYER, PAY_TO, 2_000_000n), transferLog(ARB_USDC, PAYER, PAY_TO, 720_000n)]), o)).toEqual({ ok: true, amount: 2_720_000n });
    const upper = { ...o, payer: PAYER.toLowerCase() as Address, payTo: PAY_TO.toLowerCase() as Address };
    expect(verifyRevivalPayment(rcOf([transferLog(ARB_USDC, PAYER, PAY_TO, 3_000_000n)]), upper)).toEqual({ ok: true, amount: 3_000_000n });
  });

  it("M4F §1: POST /api/revive — wrong recipient / short amount / reverted tx ⇒ 402 (nothing queued); good ⇒ queued (200 {revivalId}); reused tx ⇒ 402; the machine then drives the revival to generation 2", async () => {
    const w = await apiWorld();
    const { h, agentId, total } = w;
    const body = async (n: number): Promise<{ agentId: number; payer: string; paymentTx: string; signature: string }> => ({ agentId, payer: PAYER, paymentTx: txh(n), signature: await signIntent(agentId, txh(n)) });
    w.receipts.set(txh(1), rcOf([transferLog(ARB_USDC, PAYER, FUNDING, total)]));
    w.receipts.set(txh(2), rcOf([transferLog(ARB_USDC, PAYER, PAY_TO, total - 1n)]));
    w.receipts.set(txh(3), rcOf([transferLog(ARB_USDC, PAYER, PAY_TO, total)], "reverted"));
    for (const [n, err] of [[1, "wrong_recipient"], [2, "short_amount"], [3, "payment_reverted"], [4, "payment_not_found"]] as const) {
      const r = await call(w.helper, "POST", "/api/revive", await body(n));
      expect([n, r.status, r.body.error]).toEqual([n, 402, err]);
    }
    expect(h.db.allFlows("revival")).toHaveLength(0);
    expect(h.db.paymentsOf(agentId)).toEqual([]);

    w.receipts.set(txh(5), rcOf([transferLog(ARB_USDC, PAYER, PAY_TO, total)]));
    const ok = await call(w.helper, "POST", "/api/revive", { ...(await body(5)), paymentTx: txh(5).toUpperCase().replace("0X", "0x") });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ agentId, paymentTx: txh(5), amount: total.toString() });
    const rid = ok.body.revivalId as number;
    expect(h.db.getFlow({ kind: "revival", id: rid })).toMatchObject({ state: "REQUESTED", payer: PAYER, payerRef: txh(5) });
    expect(h.db.paymentsOf(agentId)).toEqual([expect.objectContaining({ txHash: txh(5), payer: PAYER, amount: total.toString(), status: "queued", revivalId: rid })]);

    const again = await call(w.helper, "POST", "/api/revive", await body(5));
    expect([again.status, again.body.error]).toEqual([402, "payment_reused"]);
    // quote now: revival in progress ⇒ no pay button
    const q = await call(w.helper, "GET", `/api/revive/quote/${agentId}`);
    expect(q.body).toMatchObject({ revivable: false, reason: "revival_in_progress" });
    expect(q.body.quote).toBeUndefined();

    await h.settle();
    expect(h.world.instances.get(BigInt(agentId))!.generation).toBe(2);
    const s = await call(w.helper, "GET", `/api/revive/status/${agentId}`);
    expect(s.status).toBe(200);
    expect(s.body.revivals).toEqual([expect.objectContaining({ revivalId: rid, state: "LIVE", payer: PAYER, paymentTx: txh(5), startGeneration: 1, generation: 2, attestationOk: true, failReason: null })]);
    expect(s.body.payments).toEqual([expect.objectContaining({ txHash: txh(5), status: "queued", revivalId: rid })]);
    expect(s.body.revivals[0].frozenJson).toBeUndefined(); // progress fields only
  });

  it("M4F §1: endpoint status matrix — quote 200 (revivable + quote + history / unrevivable, no quote) / 400 / 405 / 502; POST 409 refused-after-payment (refund_due) / 502 transient (claim released) / 400; status 200; manual mode 503", async () => {
    const w = await apiWorld();
    const { h, agentId, total } = w;

    const q = await call(w.helper, "GET", `/api/revive/quote/${agentId}`);
    expect(q.status).toBe(200);
    const inst = h.world.instances.get(BigInt(agentId))!;
    expect(q.body).toEqual({
      agentId,
      revivable: true,
      quote: { rateUsdcMicroPerHour: "240000", durationMin: 180, hostingUsdcMicro: "720000", gasSeedUsdMicro: "2000000", totalUsdcMicro: "2720000", payTo: PAY_TO, token: ARB_USDC, chainId: 42161, decimals: 6 },
      gate: { lastHeartbeat: Number(inst.lastHeartbeat), revivalWindow: 604_800, evictableAt: Number(inst.lastHeartbeat) + 604_801, chainNow: Number(h.world.timestamp), generation: 1 },
      history: [],
    });
    expect((await call(w.helper, "GET", "/api/revive/quote/999")).body).toMatchObject({ revivable: false, reason: "never_registered", gate: { lastHeartbeat: 0, evictableAt: null } });
    for (const bad of ["abc", "0", "-1", "1.5", "99999999999999999999"]) expect((await call(w.helper, "GET", `/api/revive/quote/${bad}`)).status).toBe(400);
    expect((await call(w.helper, "POST", `/api/revive/quote/${agentId}`, {})).status).toBe(405);
    expect((await call(w.helper, "GET", "/api/revive")).status).toBe(405);
    expect((await call(w.helper, "POST", `/api/revive/status/${agentId}`, {})).status).toBe(405);
    w.lp.fail = new Error("rpc down");
    expect(await call(w.helper, "GET", `/api/revive/quote/${agentId}`)).toMatchObject({ status: 502, body: { error: "upstream failure", stage: "rpc" } });

    // 502 transient inside revive() AFTER verification: the claim is released — the same tx can be resubmitted
    w.receipts.set(txh(10), rcOf([transferLog(ARB_USDC, PAYER, PAY_TO, total)]));
    const t = await call(w.helper, "POST", "/api/revive", { agentId, payer: PAYER, paymentTx: txh(10), signature: await signIntent(agentId, txh(10)) });
    expect([t.status, t.body.stage]).toEqual([502, "revive"]);
    expect(h.db.paymentsOf(agentId)).toEqual([]);
    w.receipts.set(txh(11), new Error("arb rpc down"));
    expect((await call(w.helper, "POST", "/api/revive", { agentId, payer: PAYER, paymentTx: txh(11), signature: await signIntent(agentId, txh(11)) })).body).toMatchObject({ error: "upstream failure", stage: "arbitrum-rpc" });
    w.lp.fail = null;

    // 409: the agent woke between payment and queue — verified payment recorded as refund_due; tx cannot be reused
    h.world.heartbeat(BigInt(agentId));
    const r = await call(w.helper, "POST", "/api/revive", { agentId, payer: PAYER, paymentTx: txh(10), signature: await signIntent(agentId, txh(10)) });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "revival_refused", reason: "heartbeat_fresh", paymentTx: txh(10) });
    expect(r.body.refund).toMatch(/returned by the operator/);
    expect(h.db.paymentsOf(agentId)).toEqual([expect.objectContaining({ txHash: txh(10), status: "refund_due", revivalId: null, note: expect.stringMatching(/^heartbeat_fresh: /) })]);
    expect(h.db.allFlows("revival")).toHaveLength(0);
    expect((await call(w.helper, "POST", "/api/revive", { agentId, payer: PAYER, paymentTx: txh(10), signature: await signIntent(agentId, txh(10)) })).body.error).toBe("payment_reused");
    expect(h.log.lines.some((l) => /REFUND DUE/.test(l))).toBe(true);

    // 400s
    expect((await call(w.helper, "POST", "/api/revive", "not json")).status).toBe(400);
    for (const b of [{}, { agentId, payer: PAYER }, { agentId, payer: "0x1", paymentTx: txh(1) }, { agentId: 0, payer: PAYER, paymentTx: txh(1) }, { agentId, payer: PAYER, paymentTx: txh(1), signature: "0x" + "11".repeat(65), extra: 1 }]) {
      expect((await call(w.helper, "POST", "/api/revive", b)).status).toBe(400);
    }
    // status 200 for any agent id (empty lists when none)
    expect((await call(w.helper, "GET", "/api/revive/status/4242")).body).toEqual({ agentId: 4242, revivals: [], payments: [] });
    const st = await call(w.helper, "GET", `/api/revive/status/${agentId}`);
    expect(st.body.payments).toHaveLength(1);

    // manual mode: no revive service ⇒ 503 + the orchestrator-less instructions on all three endpoints
    const manual = bareHelper(h);
    for (const [m, u] of [["GET", `/api/revive/quote/${agentId}`], ["POST", "/api/revive"], ["GET", `/api/revive/status/${agentId}`]] as const) {
      const x = await call(manual, m, u, m === "POST" ? { agentId, payer: PAYER, paymentTx: txh(1), signature: await signIntent(agentId, txh(1)) } : undefined);
      expect([u, x.status, x.body.error]).toEqual([u, 503, "manual mode"]);
      expect(x.body.manual.links.reproducibleBuild).toMatch(/runtime\/docs\/REPRODUCIBLE-BUILD\.md$/);
    }
    expect(MANUAL_REVIVAL.links.repo).toBe("https://github.com/vivariumlabs/agent-launchpad");
  });

  it("M4F §1: quote history lists past revivals (payer + target generation + state) for the mausoleum card (R7)", async () => {
    const w = await apiWorld();
    const { h, agentId, total } = w;
    w.receipts.set(txh(20), rcOf([transferLog(ARB_USDC, PAYER, PAY_TO, total)]));
    const ok = await call(w.helper, "POST", "/api/revive", { agentId, payer: PAYER, paymentTx: txh(20), signature: await signIntent(agentId, txh(20)) });
    await h.settle();
    h.world.mine(9n * DAY); // dies again
    const q = await call(w.helper, "GET", `/api/revive/quote/${agentId}`);
    expect(q.body.revivable).toBe(true);
    expect(q.body.history).toEqual([{ revivalId: ok.body.revivalId, generation: 2, payer: PAYER, startedAt: expect.any(Number), state: "LIVE" }]);
    expect(q.body.gate.generation).toBe(2);
  });

  it("M4F §1: createLaunchHelper wiring — genesisDb + revivalPayTo + chains.arbitrum + seams ⇒ endpoints on; missing db file refused; unconfigured / no seams ⇒ manual mode (503)", async () => {
    const d = mkdtempSync(join(tmpdir(), "lh-revive-"));
    mkdirSync(join(d, "data"));
    const base = {
      dataDir: "data",
      walletKeyPath: "never-read.key",
      deploymentManifest: MANIFEST,
      chains: {
        rh: { rpc: "https://rpc.example", chainId: 46630, maxFeePerGasWei: "1", maxPriorityFeePerGasWei: "0" },
        arbitrum: { rpc: "https://rpc.example", chainId: 42161, maxFeePerGasWei: "1", maxPriorityFeePerGasWei: "0" },
      },
      release: { composePath: join(RELEASES, "v0.1.7.yml") },
      configInboxDir: "inbox",
      arweaveDiscovery: { enabled: false },
    };
    const lh = { platformTemplate: join(REPO, "genesis", "e2e", "platform-template.testnet.json"), genesisDb: "data/genesis.sqlite", revivalPayTo: PAY_TO.toLowerCase() };
    const cfg = buildConfig({ ...base, launchHelper: lh }, d);
    expect(cfg.launchHelper).toMatchObject({ genesisDb: join(d, "data", "genesis.sqlite"), revivalPayTo: PAY_TO });
    const h = makeHarness();
    const seams = { launchpad: h.world.launchpad(), receipts: { receipt: async () => null, blockTimestamp: async () => 0n } };
    const factory = { agentCount: async () => 1n };
    expect(() => createLaunchHelper(cfg, memoryLogger(), { factory, revive: seams })).toThrow(/does not exist/);
    new GenesisDb(join(d, "data", "genesis.sqlite")).close();
    const on = createLaunchHelper(cfg, memoryLogger(), { factory, revive: seams }).helper;
    const q = await call(on, "GET", "/api/revive/quote/3");
    expect(q).toMatchObject({ status: 200, body: { agentId: 3, revivable: false, reason: "never_registered", history: [] } });
    expect((await call(on, "GET", "/api/revive/status/3")).status).toBe(200);

    const log = memoryLogger();
    const noSeams = createLaunchHelper(cfg, log, { factory }).helper;
    expect((await call(noSeams, "GET", "/api/revive/quote/3")).status).toBe(503);
    expect(log.lines.some((l) => /MANUAL MODE/.test(l))).toBe(true);
    const { revivalPayTo: _p, ...noPay } = lh;
    const off = createLaunchHelper(buildConfig({ ...base, launchHelper: noPay }, d), memoryLogger(), { factory, revive: seams }).helper;
    expect((await call(off, "GET", "/api/revive/quote/3")).status).toBe(503);
    const { arbitrum: _a, ...rhOnly } = base.chains;
    const noArb = createLaunchHelper(buildConfig({ ...base, chains: rhOnly, seeding: { legs: { "arbitrum.eth": { mode: "disabled" } } }, launchHelper: lh }, d), memoryLogger(), { factory, revive: seams }).helper;
    expect((await call(noArb, "GET", "/api/revive/quote/3")).status).toBe(503);
    rmSync(d, { recursive: true, force: true });
  });

  it("M4F §1: R8 secret-free — the revive endpoint modules never import the wallet/keyfile, machine, seeder or orchestrator, reach chain.ts only for TYPES, and never sign", () => {
    for (const f of ["src/reviveApi.ts", "src/revival.ts", "src/launchpadReader.ts", "src/configSource.ts", "src/db.ts"]) {
      const src = readFileSync(join(here, "..", f), "utf8");
      expect([f, /from\s+["']\.\/(?:keyfile|machine|seeder|orchestrator)\.js["']/.test(src)]).toEqual([f, false]);
      const chainImports = [...src.matchAll(/import\s+(type\s+)?\{[^}]*\}\s+from\s+["']\.\/chain\.js["']/g)];
      expect([f, chainImports.every((m) => m[1] !== undefined)]).toEqual([f, true]);
      expect([f, /privateKeyToAccount|signTransaction|sendTransaction|writeContract|walletKeyPath/.test(src.replace(/\/\/.*$/gm, ""))]).toEqual([f, false]);
    }
    // bin/launch-helper.ts wires a key-less PublicClient only
    const bin = readFileSync(join(here, "..", "bin", "launch-helper.ts"), "utf8");
    expect(/createWalletClient|privateKeyToAccount|loadWallet/.test(bin)).toBe(false);
  });
});

describe("M4F rev 1 — payment binding (Fable, session 15)", () => {
  it("M4F §1: a signature by another key, or for another agentId/tx, is 402 bad_signature — nothing verified, nothing queued", async () => {
    const w = await apiWorld();
    const { h, agentId, total } = w;
    w.receipts.set(txh(20), rcOf([transferLog(ARB_USDC, PAYER, PAY_TO, total)]));
    const attacker = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
    const cases: Array<[string, string]> = [
      ["another key", await attacker.signMessage({ message: reviveIntentMessage(agentId, txh(20)) })],
      ["another agentId", await signIntent(agentId + 1, txh(20))],
      ["another tx", await signIntent(agentId, txh(21))],
      ["garbage", ("0x" + "22".repeat(65)) as string],
    ];
    for (const [what, signature] of cases) {
      const r = await call(w.helper, "POST", "/api/revive", { agentId, payer: PAYER, paymentTx: txh(20), signature });
      expect([what, r.status, r.body.error]).toEqual([what, 402, "bad_signature"]);
    }
    expect(h.db.paymentsOf(agentId)).toEqual([]);
    expect(h.db.allFlows("revival")).toHaveLength(0);
  });

  it("M4F §1: a payment older than paymentMaxAgeSec is 402 payment_too_old (fresh one passes; boundary exact)", async () => {
    const w = await apiWorld();
    const { h, agentId, total } = w;
    w.receipts.set(txh(30), rcOf([transferLog(ARB_USDC, PAYER, PAY_TO, total)]));
    w.paidAt.value = h.world.timestamp - 86_401n; // 1s past DEFAULT_PAYMENT_MAX_AGE_SEC
    const old = await call(w.helper, "POST", "/api/revive", { agentId, payer: PAYER, paymentTx: txh(30), signature: await signIntent(agentId, txh(30)) });
    expect([old.status, old.body.error]).toEqual([402, "payment_too_old"]);
    expect(h.db.paymentsOf(agentId)).toEqual([]);
    w.paidAt.value = h.world.timestamp - 86_400n; // exactly at the limit: allowed
    const ok = await call(w.helper, "POST", "/api/revive", { agentId, payer: PAYER, paymentTx: txh(30), signature: await signIntent(agentId, txh(30)) });
    expect(ok.status).toBe(200);
  });
});
