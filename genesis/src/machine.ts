// SPEC-M3B §1 machine.ts — per-agent resumable state machine.
//
//   REQUESTED → DEPLOYING → AWAITING_REGISTER → SEEDING → RECONCILING → FINALIZING → LIVE
//   FAILED(reason, step) reachable from any step. The 24h DEFAULT timeout → FAILED(timeout) applies
//   ONLY up to and including AWAITING_REGISTER (review ruling 2): once the enclave registered, the
//   agent exists on-chain with a funded-or-fundable treasury and a stall is an operator problem, not
//   a refund case — post-registration steps never auto-FAIL by timeout; `redrive` (below / main.ts)
//   resets a FAILED(step ≥ SEEDING) or stuck launch back into SEEDING re-evaluation.
//
// Pre-registration gas (review ruling 1): a guarded sub-step of AWAITING_REGISTER (not a new State),
// run after the attestation verified and while the instance is not yet registered: send
// `seeding.preRegistrationGasWei` of RH ETH to registry.expectedTreasuryEOA(agentId) — the enclave's
// brand-new treasury needs gas to call registerInstance. Recorded as seed leg "preGas" (same
// persist-before-broadcast machinery); skipped when the target already holds ≥ half the leg.
//
// Rev 0 sequencing ruling: seed failures BLOCK finalize, so seeding + reconciliation happen BEFORE
// finalize — an agent is never made tradeable (finalized) by this orchestrator before it is fully
// funded AND its attestation verified. Revivals (04 §6) run the same machine without FINALIZING and
// with a gas-only seed plan.
//
// Idempotence: every step re-checks chain / CVM state first and persists before side effects:
//   - DEPLOYING: attempt count + a snapshot of the wallet's Oyster jobs are stored BEFORE the CLI
//     runs; after a crash / unknown outcome the new job (listed − snapshot − jobs already claimed)
//     is ADOPTED instead of deploying again. Deploys are single-flight (kv lock).
//   - SEEDING / FINALIZING: signed raw tx + hash stored BEFORE broadcast; resume = receipt check /
//     re-broadcast of the same bytes.
// Error classes (src/errors.ts): Fatal ⇒ FAILED now; anything else ⇒ transient (lastError, retry on
// the next resume — bounded by the timeout before registration, unbounded after it). Capped steps
// count their definitive failures.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { finalizeCalldata, ZERO_ADDRESS, type ChainClient, type ChainKey, type Launchpad } from "./chain.js";
import type { GenesisConfig } from "./config.js";
import { verifyFrozen, type ConfigSource } from "./configSource.js";
import { flowKey, TERMINAL, type FlowRef, type FlowRow, type GenesisDb, type State } from "./db.js";
import { errMsg, Fatal, NonceConsumed } from "./errors.js";
import type { Logger } from "./log.js";
import type { Oyster } from "./oyster.js";
import { checkRevivalGate, RevivalRefused } from "./revival.js";
import { describeRental } from "./config.js";
import { HOSTING_LEG, legLanded, planGenesisLegs, planPreGasLeg, planRevivalLegs, PRE_GAS_LEG, processLeg, resolveRemainder, type SeederDeps } from "./seeder.js";
import type { TurboFunder } from "./turbo.js";

export interface MachineDeps {
  db: GenesisDb;
  launchpad: Launchpad;
  chains: Partial<Record<ChainKey, ChainClient>>;
  oyster: Oyster;
  configSource: ConfigSource;
  turbo: TurboFunder;
  cfg: GenesisConfig;
  /** Funding wallet address (= Oyster job owner). */
  walletAddress: Address;
  log: Logger;
}

type StepResult = { next: "advance" } | { next: "wait"; why: string };
const ADVANCE: StepResult = { next: "advance" };
const wait = (why: string): StepResult => ({ next: "wait", why });

const DEPLOY_LOCK = "deploy.lock";
const MAX_STEPS_PER_DRIVE = 16;

/** States the overall timeout applies to (ruling 2): everything up to and including registration. */
export const PRE_REGISTRATION_STATES: readonly State[] = ["REQUESTED", "DEPLOYING", "AWAITING_REGISTER"];
/** Steps `redrive` may reset (post-registration). */
export const REDRIVABLE_STEPS: readonly State[] = ["SEEDING", "RECONCILING", "FINALIZING"];

/**
 * Operator `redrive` (ruling 2): reset a genesis launch that FAILED at SEEDING / RECONCILING /
 * FINALIZING, or is stuck in one of them, back to SEEDING with its per-step attempt counters zeroed.
 * The frozen seed plan and every recorded tx are kept — re-evaluation re-checks receipts / balances
 * first, so nothing already landed is re-sent. Pure db operation; the running loop drives it.
 */
export function redrive(db: GenesisDb, agentId: number, now: bigint, log: Logger): FlowRow {
  const ref: FlowRef = { kind: "genesis", id: agentId };
  const f = db.getFlow(ref);
  if (f === undefined) throw new Error(`no launch for agent ${agentId}`);
  const step = f.state === "FAILED" ? f.failStep : f.state;
  if (f.state === "LIVE" || step === null || !(REDRIVABLE_STEPS as readonly string[]).includes(step) || f.treasury === null) {
    throw new Error(
      `agent ${agentId} is ${f.state}${f.state === "FAILED" ? `(${f.failReason ?? "?"} @ ${step ?? "?"})` : ""} — redrive only resets launches that failed or stalled at ${REDRIVABLE_STEPS.join("/")} (post-registration)`,
    );
  }
  const detail = `from ${f.state}${f.state === "FAILED" ? `(${f.failReason ?? "?"} @ ${step})` : ""}; attempts seed ${f.seedAttempts} reconcile ${f.reconcileAttempts} finalize ${f.finalizeAttempts} reset`;
  db.tx(() => {
    db.patchFlow(ref, { state: "SEEDING", failReason: null, failStep: null, lastError: null, seedAttempts: 0, reconcileAttempts: 0, finalizeAttempts: 0 }, now);
    db.event(flowKey(ref), f.agentId, now, "redrive", detail);
  });
  log.info(`[${flowKey(ref)}] redrive → SEEDING: ${detail}`);
  return db.getFlow(ref)!;
}

export class Machine {
  constructor(private readonly d: MachineDeps) {}

  private get seeder(): SeederDeps {
    return { db: this.d.db, chains: this.d.chains, turbo: this.d.turbo, cfg: this.d.cfg, log: this.d.log };
  }

  private rh(): ChainClient {
    const c = this.d.chains.rh;
    if (c === undefined) throw new Fatal("config", "rh chain client missing");
    return c;
  }

  /** Re-drive every non-terminal flow, sequentially (single process, single funding wallet). */
  async resumeAll(now: bigint): Promise<void> {
    for (const ref of this.d.db.nonTerminal()) {
      try {
        await this.drive(ref, now);
      } catch (e) {
        this.d.log.error(`[${flowKey(ref)}] drive crashed: ${errMsg(e)}`);
      }
    }
  }

  /** Advance one flow as far as possible right now. Returns its state afterwards. */
  async drive(ref: FlowRef, now: bigint): Promise<State | undefined> {
    for (let i = 0; i < MAX_STEPS_PER_DRIVE; i++) {
      const f = this.d.db.getFlow(ref);
      if (f === undefined || TERMINAL.includes(f.state)) return f?.state;
      if (PRE_REGISTRATION_STATES.includes(f.state) && now >= BigInt(f.startedAt) + BigInt(this.d.cfg.timing.timeoutSec)) {
        this.fail(f, "timeout", `not registered within ${this.d.cfg.timing.timeoutSec}s of the request`, now);
        return "FAILED";
      }
      let r: StepResult;
      try {
        r = await this.step(f, now);
      } catch (e) {
        if (e instanceof Fatal) {
          this.fail(f, e.reason, errMsg(e), now);
          return "FAILED";
        }
        const msg = errMsg(e).slice(0, 500);
        this.d.db.patchFlow(ref, { lastError: msg }, now);
        this.d.log.warn(`[${flowKey(ref)}] ${f.state}: transient: ${msg}`);
        return f.state;
      }
      if (r.next === "wait") {
        this.d.db.patchFlow(ref, { lastError: r.why }, now);
        return f.state;
      }
    }
    return this.d.db.getFlow(ref)?.state;
  }

  private fail(f: FlowRow, reason: string, detail: string, now: bigint): void {
    const ref = { kind: f.kind, id: f.id };
    this.d.db.patchFlow(ref, { state: "FAILED", failReason: reason, failStep: f.state, lastError: detail.slice(0, 500) }, now);
    if (this.d.db.kvGet(DEPLOY_LOCK) === flowKey(ref)) this.d.db.kvDel(DEPLOY_LOCK);
    this.d.db.event(flowKey(ref), f.agentId, now, "failed", `${reason} at ${f.state}: ${detail}`);
    this.d.log.error(`!!! [${flowKey(ref)}] FAILED(${reason}, ${f.state}): ${detail}${f.kind === "genesis" ? " — creator refund path is factory.cancel after the genesis deadline (02 §2)" : ""}`);
  }

  private toState(f: FlowRow, state: State, now: bigint, event: string, detail: string, patch: Parameters<GenesisDb["patchFlow"]>[1] = {}): void {
    const ref = { kind: f.kind, id: f.id };
    this.d.db.patchFlow(ref, { ...patch, state, lastError: null }, now);
    this.d.db.event(flowKey(ref), f.agentId, now, event, detail);
    this.d.log.info(`[${flowKey(ref)}] ${f.state} → ${state}: ${event} ${detail}`);
  }

  private step(f: FlowRow, now: bigint): Promise<StepResult> {
    switch (f.state) {
      case "REQUESTED":
        return f.kind === "genesis" ? this.requestedGenesis(f, now) : this.requestedRevival(f, now);
      case "DEPLOYING":
        return this.deploying(f, now);
      case "AWAITING_REGISTER":
        return this.awaitingRegister(f, now);
      case "SEEDING":
        return this.seeding(f, now);
      case "RECONCILING":
        return this.reconciling(f, now);
      case "FINALIZING":
        return this.finalizing(f, now);
      default:
        return Promise.resolve(wait(`terminal ${f.state}`));
    }
  }

  // -------------------------------------------------------------------------
  // REQUESTED
  // -------------------------------------------------------------------------

  private workDir(f: FlowRow): string {
    const base = join(this.d.cfg.dataDir, "agents", String(f.agentId));
    return f.kind === "genesis" ? base : join(base, `revival-${f.id}`);
  }

  /** Writes agent.json (exact delivered bytes) + runtime.json (ops template + tee + imageId). */
  private writeInitFiles(f: FlowRow, frozenText: string, imageId: string): { agentJson: string; runtimeJson: string } {
    const dir = this.workDir(f);
    mkdirSync(dir, { recursive: true });
    const agentJson = join(dir, "agent.json");
    const runtimeJson = join(dir, "runtime.json");
    writeFileSync(agentJson, frozenText);
    writeFileSync(runtimeJson, `${JSON.stringify({ ...this.d.cfg.runtimeOps, tee: true, imageId: `0x${imageId}` }, null, 2)}\n`);
    return { agentJson, runtimeJson };
  }

  private async prepareConfig(f: FlowRow, allowDbFallback: boolean): Promise<{ text: string; ref: string } | null> {
    const doc = await this.d.configSource.load({ configHash: f.configHash, ref: f.configRef });
    if (doc !== null) return doc;
    if (allowDbFallback && f.frozenJson !== null) return { text: f.frozenJson, ref: f.configRef ?? "db" };
    return null;
  }

  private async requestedGenesis(f: FlowRow, now: bigint): Promise<StepResult> {
    const id = BigInt(f.agentId);
    const pending = await this.d.launchpad.pendingAgent(id);
    if (pending.creator === ZERO_ADDRESS) throw new Fatal("not_pending", `agent ${f.agentId} has no pending record on-chain (cancelled, or finalized elsewhere)`);
    if (pending.configHash.toLowerCase() !== f.configHash) throw new Fatal("config_hash_mismatch", `event configHash ${f.configHash} ≠ pending ${pending.configHash}`);
    const doc = await this.prepareConfig(f, false);
    if (doc === null) return wait(`frozen config ${f.configHash} not delivered yet`);
    verifyFrozen(doc.text, f.configHash, f.agentId); // Fatal on mismatch (04 §7 row 2)
    const composePath = this.d.cfg.release.composePath;
    const imageId = await this.d.oyster.computeImageId({ composePath, agentId: f.agentId, configHash: f.configHash });
    this.writeInitFiles(f, doc.text, imageId);
    this.toState(f, "DEPLOYING", now, "prepared", `config ${doc.ref} verified; imageId ${imageId}`, {
      frozenJson: doc.text,
      configRef: doc.ref,
      composePath,
      imageId,
    });
    return ADVANCE;
  }

  private async requestedRevival(f: FlowRow, now: bigint): Promise<StepResult> {
    let gate;
    try {
      gate = await checkRevivalGate(this.d.launchpad, f.agentId);
    } catch (e) {
      if (e instanceof RevivalRefused) throw new Fatal(e.reason, e.message);
      throw e;
    }
    const doc = await this.prepareConfig(f, true);
    if (doc === null) return wait(`frozen config ${f.configHash} unavailable (ref ${f.configRef ?? "none"})`);
    verifyFrozen(doc.text, f.configHash, f.agentId);
    const composePath = f.composePath ?? this.d.cfg.release.composePath;
    const imageId = await this.d.oyster.computeImageId({ composePath, agentId: f.agentId, configHash: f.configHash });
    if (`0x${imageId}` !== gate.instance.codeHash.toLowerCase()) {
      throw new Fatal("revival_codehash_mismatch", `release ${composePath} + config give image ${imageId}, registry pins ${gate.instance.codeHash} — keys would differ`);
    }
    this.writeInitFiles(f, doc.text, imageId);
    this.toState(f, "DEPLOYING", now, "prepared", `revival config ${doc.ref} verified; imageId ${imageId}`, {
      frozenJson: doc.text,
      configRef: doc.ref,
      composePath,
      imageId,
    });
    return ADVANCE;
  }

  // -------------------------------------------------------------------------
  // DEPLOYING
  // -------------------------------------------------------------------------

  private claimedJobIds(): Set<string> {
    const s = new Set<string>();
    for (const kind of ["genesis", "revival"] as const) {
      for (const r of this.d.db.allFlows(kind)) if (r.deployJobId !== null) s.add(r.deployJobId.toLowerCase());
    }
    return s;
  }

  private async deploying(f: FlowRow, now: bigint): Promise<StepResult> {
    const ref = { kind: f.kind, id: f.id };
    const key = flowKey(ref);
    const cap = this.d.cfg.retries.deploy;
    if (f.deployJobId !== null) {
      this.toState(f, "AWAITING_REGISTER", now, "deployed", `job ${f.deployJobId}`);
      return ADVANCE;
    }
    const holder = this.d.db.kvGet(DEPLOY_LOCK);
    if (holder !== undefined && holder !== key) return wait(`deploy lock held by ${holder} (single-flight deploys)`);

    if (f.deployInFlight === 1) {
      // Outcome of the last attempt unknown (crash / CLI error): adopt its job if one appeared.
      const listed = await this.d.oyster.listJobs(this.d.walletAddress);
      const before = new Set<string>((JSON.parse(f.preDeployJobs ?? "[]") as string[]).map((j) => j.toLowerCase()));
      const claimed = this.claimedJobIds();
      const fresh = listed.filter((j) => !before.has(j) && !claimed.has(j));
      if (fresh.length === 1) {
        this.d.db.kvDel(DEPLOY_LOCK);
        this.toState(f, "AWAITING_REGISTER", now, "deploy_adopted", `job ${fresh[0]!} (attempt ${f.deployAttempts}, recovered from interrupted deploy)`, {
          deployJobId: fresh[0]!,
          deployInFlight: 0,
        });
        return ADVANCE;
      }
      if (fresh.length > 1) throw new Fatal("deploy_ambiguous", `${fresh.length} unclaimed new Oyster jobs (${fresh.join(", ")}) — operator must resolve`);
      if (now < BigInt((f.deployStartedAt ?? 0) + this.d.cfg.timing.deployOrphanGraceSec)) {
        return wait(`deploy attempt ${f.deployAttempts} outcome unknown — waiting for its job to appear`);
      }
      this.d.db.patchFlow(ref, { deployInFlight: 0 }, now);
      this.d.db.kvDel(DEPLOY_LOCK);
      this.d.db.event(key, f.agentId, now, "deploy_attempt_failed", `attempt ${f.deployAttempts}: no job created`);
      if (f.deployAttempts >= cap) throw new Fatal("deploy_failed", `${f.deployAttempts} deploy attempts, no CVM job`);
      return wait(`deploy attempt ${f.deployAttempts} created no job; retrying`);
    }

    if (f.deployAttempts >= cap) throw new Fatal("deploy_failed", `${f.deployAttempts} deploy attempts, no CVM job`);
    if (f.imageId === null || f.frozenJson === null) throw new Fatal("state_corrupt", "DEPLOYING without imageId/config");
    // Pre-snapshot FIRST: an Oyster outage here throws (transient) ⇒ the launch stays queued with no
    // attempt consumed (04 §7 row 5).
    const before = await this.d.oyster.listJobs(this.d.walletAddress);
    const attempt = f.deployAttempts + 1;
    this.d.db.kvSet(DEPLOY_LOCK, key);
    this.d.db.patchFlow(ref, { deployInFlight: 1, deployStartedAt: Number(now), preDeployJobs: JSON.stringify(before), deployAttempts: attempt }, now);
    const rental = describeRental(this.d.cfg.oyster);
    this.d.db.event(key, f.agentId, now, "deploy_submitted", `attempt ${attempt}; ${rental}`);
    this.d.log.info(`[${key}] deploy attempt ${attempt}: ${rental}`);
    const dir = this.workDir(f);
    const res = await this.d.oyster.deploy({
      composePath: f.composePath ?? this.d.cfg.release.composePath,
      agentId: f.agentId,
      configHash: f.configHash,
      agentJsonPath: join(dir, "agent.json"),
      runtimeJsonPath: join(dir, "runtime.json"),
      durationMin: this.d.cfg.oyster.durationMin,
      walletKeyPath: this.d.cfg.oyster.walletKeyFile,
      jobName: f.kind === "genesis" ? `agent-${f.agentId}` : `agent-${f.agentId}-rev${f.id}`,
    });
    if (res.jobId !== null && !before.includes(res.jobId)) {
      this.d.db.kvDel(DEPLOY_LOCK);
      this.toState(f, "AWAITING_REGISTER", now, "deployed", `job ${res.jobId} ip ${res.ip ?? "?"} (${res.ok ? "ok" : res.detail})`, {
        deployJobId: res.jobId,
        cvmIp: res.ip,
        deployInFlight: 0,
      });
      return ADVANCE;
    }
    // Unknown outcome: stay in-flight; the next drive adopts a job that appears or, after the grace
    // period, counts the attempt as failed. Never blindly redeploy (a second paid job).
    this.d.db.event(key, f.agentId, now, "deploy_error", res.detail.slice(0, 300));
    return wait(`deploy attempt ${attempt}: ${res.detail.slice(0, 300)}`);
  }

  // -------------------------------------------------------------------------
  // AWAITING_REGISTER
  // -------------------------------------------------------------------------

  private async awaitingRegister(f: FlowRow, now: bigint): Promise<StepResult> {
    const ref = { kind: f.kind, id: f.id };
    const key = flowKey(ref);
    if (f.deployJobId === null || f.imageId === null) throw new Fatal("state_corrupt", "AWAITING_REGISTER without job/imageId");
    let ip = f.cvmIp;
    if (ip === null) {
      ip = await this.d.oyster.ip(f.deployJobId);
      if (ip === null) return wait(`enclave IP for job ${f.deployJobId} not known yet`);
      this.d.db.patchFlow(ref, { cvmIp: ip }, now);
    }
    if (f.attestationOk !== 1) {
      const v = await this.d.oyster.verify(ip, f.imageId);
      if (!v.ok) {
        const n = f.verifyAttempts + 1;
        this.d.db.patchFlow(ref, { verifyAttempts: n }, now);
        this.d.db.event(key, f.agentId, now, "attestation_invalid", `attempt ${n}: ${v.detail.slice(0, 200)}`);
        if (n >= this.d.cfg.retries.verify) throw new Fatal("attestation_invalid", `attestation of ${ip} against image ${f.imageId} failed ${n}× — never finalize`);
        return wait(`attestation verification failed (${n}/${this.d.cfg.retries.verify})`);
      }
      this.d.db.patchFlow(ref, { attestationOk: 1 }, now);
      this.d.db.event(key, f.agentId, now, "attestation_verified", `${ip} image ${f.imageId}`);
    }

    const id = BigInt(f.agentId);
    const expectedCode = `0x${f.imageId}`;
    if (f.kind === "genesis") {
      if (!(await this.d.launchpad.isRegistered(id))) {
        const deadline = await this.d.launchpad.genesisDeadline(id);
        const chainNow = (await this.d.launchpad.latestBlock()).timestamp;
        if (deadline !== 0n && chainNow > deadline) throw new Fatal("genesis_window_closed", `registry genesis deadline ${deadline} passed without registration`);
        const gas = await this.preRegistrationGas(f, now);
        if (gas !== null) return gas;
        return wait("awaiting registerInstance from the enclave");
      }
      const inst = await this.d.launchpad.instanceOf(id);
      const expected = await this.d.launchpad.expectedTreasuryEOA(id);
      if (inst.treasuryEOA.toLowerCase() !== expected.toLowerCase()) {
        throw new Fatal("instance_treasury_mismatch", `registered treasury ${inst.treasuryEOA} ≠ expected ${expected}`);
      }
      if (inst.codeHash.toLowerCase() !== expectedCode) {
        throw new Fatal("instance_codehash_mismatch", `registered codeHash ${inst.codeHash} ≠ deployed image ${expectedCode} — never finalize`);
      }
      this.toState(f, "SEEDING", now, "registered", `treasury ${inst.treasuryEOA} generation ${inst.generation}`, { treasury: inst.treasuryEOA });
      return ADVANCE;
    }
    const inst = await this.d.launchpad.instanceOf(id);
    if (inst.generation <= (f.startGeneration ?? 0)) {
      const gas = await this.preRegistrationGas(f, now);
      if (gas !== null) return gas;
      return wait(`awaiting re-registration (generation ${inst.generation})`);
    }
    if (inst.codeHash.toLowerCase() !== expectedCode || (f.treasury !== null && inst.treasuryEOA.toLowerCase() !== f.treasury.toLowerCase())) {
      throw new Fatal("instance_mismatch", `re-registered instance ${inst.treasuryEOA}/${inst.codeHash} ≠ expected`);
    }
    this.toState(f, "SEEDING", now, "registered", `revived generation ${inst.generation}`, { treasury: inst.treasuryEOA });
    return ADVANCE;
  }

  /**
   * Pre-registration gas leg (ruling 1). Target = registry.expectedTreasuryEOA(agentId), read on-chain
   * (the only address registerInstance will accept; for a revival it must equal the pinned treasury).
   * Returns a wait result while the leg is not done, null once it is (confirmed or satisfied).
   */
  private async preRegistrationGas(f: FlowRow, now: bigint): Promise<StepResult | null> {
    const ref = { kind: f.kind, id: f.id };
    const key = flowKey(ref);
    let row = this.d.db.seeds(key).find((r) => r.leg === PRE_GAS_LEG);
    if (row === undefined) {
      const target = await this.d.launchpad.expectedTreasuryEOA(BigInt(f.agentId));
      if (target === ZERO_ADDRESS) throw new Fatal("no_expected_treasury", `registry.expectedTreasuryEOA(${f.agentId}) is unset`);
      if (f.treasury !== null && target.toLowerCase() !== f.treasury.toLowerCase()) {
        throw new Fatal("instance_treasury_mismatch", `expectedTreasuryEOA ${target} ≠ pinned treasury ${f.treasury}`);
      }
      const p = planPreGasLeg(this.d.cfg, target);
      this.d.db.planSeeds([{ flow: key, leg: p.leg, agentId: f.agentId, chain: p.chain, asset: p.asset, token: p.token, target: p.target, amount: p.amount.toString(), mode: p.mode, usdMicro: p.usdMicro.toString() }], now);
      this.d.db.event(key, f.agentId, now, "pregas_plan", `${p.amount} wei → ${target} (expectedTreasuryEOA)`);
      row = this.d.db.seeds(key).find((r) => r.leg === PRE_GAS_LEG)!;
    }
    const out = await processLeg(this.seeder, row, now);
    if (out === "done") return null;
    if (out === "pending") return wait(`pre-registration gas leg pending`);
    const n = f.seedAttempts + 1;
    this.d.db.patchFlow(ref, { seedAttempts: n }, now);
    if (n >= this.d.cfg.retries.seeding) throw new Fatal("pregas_failed", `pre-registration gas leg failed ${n}×`);
    return wait(`pre-registration gas leg failed (${n}/${this.d.cfg.retries.seeding}); retrying`);
  }

  // -------------------------------------------------------------------------
  // SEEDING / RECONCILING
  // -------------------------------------------------------------------------

  private async seeding(f: FlowRow, now: bigint): Promise<StepResult> {
    const ref = { kind: f.kind, id: f.id };
    const key = flowKey(ref);
    if (f.treasury === null) throw new Fatal("state_corrupt", "SEEDING without treasury");
    const treasury = f.treasury as Address;
    let rows = this.d.db.seeds(key);
    if (!rows.some((r) => r.leg !== PRE_GAS_LEG)) {
      const plan =
        f.kind === "genesis" ? planGenesisLegs(this.d.cfg, await this.d.launchpad.creationFee(), treasury) : planRevivalLegs(this.d.cfg, treasury);
      this.d.db.planSeeds(
        plan.map((p) => ({
          flow: key,
          leg: p.leg,
          agentId: f.agentId,
          chain: p.chain,
          asset: p.asset,
          token: p.token,
          target: p.target,
          amount: p.amount.toString(),
          mode: p.mode,
          usdMicro: p.usdMicro.toString(),
          status: p.deferred === true ? ("deferred" as const) : ("planned" as const),
        })),
        now,
      );
      this.d.db.event(key, f.agentId, now, "seed_plan", plan.map((p) => (p.deferred === true ? `${p.leg}=remainder(fee ${p.amount})` : `${p.leg}=${p.amount}${p.mode === "conditional" ? "?" : ""}`)).join(" "));
      rows = this.d.db.seeds(key);
    }
    // A preGas leg never sent (registration happened without it) is moot now: never send it late.
    const pre = rows.find((r) => r.leg === PRE_GAS_LEG);
    if (pre !== undefined && (pre.status === "planned" || pre.status === "failed")) {
      this.d.db.patchSeed(key, pre.leg, { status: "skipped", note: "enclave registered before the pre-registration gas leg landed" }, now);
      this.d.db.event(key, f.agentId, now, "seed_skipped", `${pre.leg}: registered without it`);
      rows = this.d.db.seeds(key);
    }
    for (const row0 of rows) {
      let row = row0;
      if (row.asset === "virtual") {
        // hosting: SEEDING is only reachable after DEPLOYING produced a job, so the rental was paid.
        if (row.leg !== HOSTING_LEG) throw new Fatal("seed_state_corrupt", `unknown virtual leg ${row.leg}`);
        if (row.status !== "confirmed") {
          if (f.deployJobId === null) throw new Fatal("state_corrupt", "SEEDING without a deploy job (hosting leg unconfirmable)");
          this.d.db.patchSeed(key, row.leg, { status: "confirmed", txHash: f.deployJobId, note: `oyster job ${f.deployJobId}: ${describeRental(this.d.cfg.oyster)}` }, now);
          this.d.db.event(key, f.agentId, now, "seed_confirmed", `${row.leg} ${row.amount} µUSD rental (virtual) job ${f.deployJobId}`);
        }
        continue;
      }
      if (row.status === "deferred") {
        // Every earlier leg is terminal here (the loop returns on pending / reverted), so the
        // executed set is final: resolve the USDG remainder once, then send it like any leg.
        const r = resolveRemainder(row, this.d.db.seeds(key));
        const note = `remainder: fee ${row.usdMicro ?? "?"} − executed ${r.spent} µUSD [${r.executed.join(",")}]`;
        this.d.db.patchSeed(key, row.leg, { status: "planned", amount: r.amount.toString(), note }, now);
        this.d.db.event(key, f.agentId, now, "seed_remainder", `${row.leg}=${r.amount} (${note})`);
        row = this.d.db.seeds(key).find((x) => x.leg === row0.leg)!;
      }
      const out = await processLeg(this.seeder, row, now);
      if (out === "pending") return wait(`seed leg ${row.leg} pending`);
      if (out === "reverted") {
        const n = f.seedAttempts + 1;
        this.d.db.patchFlow(ref, { seedAttempts: n }, now);
        if (n >= this.d.cfg.retries.seeding) throw new Fatal("seed_failed", `seed leg ${row.leg} failed ${n}× — finalize blocked`);
        return wait(`seed leg ${row.leg} failed (${n}/${this.d.cfg.retries.seeding}); retrying`);
      }
    }
    this.toState(f, "RECONCILING", now, "seeded", rows.map((r) => r.leg).join(","));
    return ADVANCE;
  }

  private async reconciling(f: FlowRow, now: bigint): Promise<StepResult> {
    const ref = { kind: f.kind, id: f.id };
    const key = flowKey(ref);
    const rows = this.d.db.seeds(key);
    const missing: string[] = [];
    for (const row of rows) if (!(await legLanded(this.seeder, row))) missing.push(row.leg);
    if (missing.length === 0) {
      if (f.kind === "genesis") this.toState(f, "FINALIZING", now, "reconciled", `${rows.length} legs verified`);
      else this.toState(f, "LIVE", now, "revived", `${rows.length} legs verified`);
      return ADVANCE;
    }
    const n = f.reconcileAttempts + 1;
    for (const leg of missing) this.d.db.patchSeed(key, leg, { status: "planned", txHash: null, raw: null, note: "reconcile: not landed — re-queued" }, now);
    this.d.db.event(key, f.agentId, now, "seed_missing", `attempt ${n}: ${missing.join(",")}`);
    this.d.log.error(`!!! [${key}] reconciliation: legs not landed: ${missing.join(",")} (${n}/${this.d.cfg.retries.reconcile}) — finalize blocked`);
    if (n >= this.d.cfg.retries.reconcile) {
      this.d.db.patchFlow(ref, { reconcileAttempts: n }, now);
      throw new Fatal("seed_reconcile_failed", `legs ${missing.join(",")} still missing after ${n} reconciliations`);
    }
    this.d.db.patchFlow(ref, { reconcileAttempts: n, state: "SEEDING", lastError: `re-queued ${missing.join(",")}` }, now);
    return wait(`re-queued legs ${missing.join(",")}`);
  }

  // -------------------------------------------------------------------------
  // FINALIZING
  // -------------------------------------------------------------------------

  private finalizeFailed(f: FlowRow, now: bigint, why: string): StepResult {
    const ref = { kind: f.kind, id: f.id };
    const n = f.finalizeAttempts + 1;
    this.d.db.patchFlow(ref, { finalizeAttempts: n, finalizeTx: null, finalizeRaw: null }, now);
    this.d.db.event(flowKey(ref), f.agentId, now, "finalize_reverted", `attempt ${n}: ${why}`);
    if (n >= this.d.cfg.retries.finalize) throw new Fatal("finalize_failed", `finalize failed ${n}×: ${why}`);
    return wait(`finalize failed (${n}/${this.d.cfg.retries.finalize}): ${why}`);
  }

  private async finalizing(f: FlowRow, now: bigint): Promise<StepResult> {
    const ref = { kind: f.kind, id: f.id };
    const key = flowKey(ref);
    const id = BigInt(f.agentId);
    const token = await this.d.launchpad.tokenOf(id);
    if (token !== ZERO_ADDRESS) {
      this.toState(f, "LIVE", now, "finalized", `token ${token}${f.finalizeTx === null ? " (already finalized on-chain)" : ""}`);
      return ADVANCE;
    }
    // Invariants (defence in depth — RECONCILING is the gate): attested + every leg landed/skipped.
    if (f.attestationOk !== 1) throw new Fatal("invariant_unattested", "FINALIZING without a verified attestation");
    const open = this.d.db.seeds(key).filter((r) => r.status !== "confirmed" && r.status !== "satisfied" && r.status !== "skipped");
    if (open.length > 0) throw new Fatal("invariant_unfunded", `FINALIZING with open seed legs ${open.map((r) => r.leg).join(",")}`);

    const rh = this.rh();
    if (f.finalizeTx !== null) {
      const hash = f.finalizeTx as Hex;
      const rc = await rh.receipt(hash);
      if (rc !== null) {
        if (rc.status === "success") {
          this.toState(f, "LIVE", now, "finalized", `tx ${hash}`);
          return ADVANCE;
        }
        return this.finalizeFailed(f, now, `tx ${hash} reverted`);
      }
      if (await rh.known(hash)) return wait(`finalize tx ${hash} pending`);
      try {
        await rh.broadcast(f.finalizeRaw as Hex);
        return wait(`finalize tx ${hash} re-broadcast`);
      } catch (e) {
        if (!(e instanceof NonceConsumed)) throw e;
        this.d.db.patchFlow(ref, { finalizeTx: null, finalizeRaw: null }, now);
        return wait(`finalize tx ${hash} dropped (nonce consumed); will re-sign`);
      }
    }
    const pending = await this.d.launchpad.pendingAgent(id);
    if (pending.creator === ZERO_ADDRESS) throw new Fatal("not_pending", "pending record gone and no token — cancelled?");
    const signed = await rh.prepare({ to: this.d.launchpad.factory, data: finalizeCalldata(id) });
    this.d.db.patchFlow(ref, { finalizeTx: signed.hash, finalizeRaw: signed.raw }, now);
    this.d.db.event(key, f.agentId, now, "finalize_submitted", `tx ${signed.hash}`);
    await rh.broadcast(signed.raw);
    const rc = await rh.waitReceipt(signed.hash, this.d.cfg.timing.receiptTimeoutSec * 1000);
    if (rc === null) return wait(`finalize tx ${signed.hash} pending`);
    if (rc.status !== "success") return this.finalizeFailed({ ...f, finalizeTx: signed.hash }, now, `tx ${signed.hash} reverted`);
    this.toState(f, "LIVE", now, "finalized", `tx ${signed.hash}`);
    return ADVANCE;
  }
}
