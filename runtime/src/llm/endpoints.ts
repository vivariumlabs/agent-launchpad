// SPEC-M2B §5 EndpointManager — deterministic endpoint health + selection (clock injected
// via explicit `now` arguments; no Date.now).
//
// Candidates: [primary, ...fallbacks] from agent config (cfg.agent.models) ∩ inference
// allowlist. A config ref matches an allowlist entry by `id` OR by `model`; several
// entries serving the same ref share that rank and are ordered attested-first, then
// allowlist order (SPEC-M2 §7). An entry appears once, at its best rank.
//
// Health: healthy | unhealthy(untilTs, reason). Unhealthy expires at untilTs (cooldown).
//   price    quoted price > entry.maxPricePerMTokUsd       ⇒ unhealthy cfg.unhealthyCooldownSec.price    (6h)
//   contract cfg.contractFailureLimit consecutive failures ⇒ unhealthy cfg.unhealthyCooldownSec.contract (1h)
//   canary   trailing-3-day canary score < 2/3             ⇒ unhealthy cfg.unhealthyCooldownSec.canary   (24h)
// Selection: first healthy candidate (optionally restricted to tier "cheap", falling back
// to all candidates if none is cheap). ALL unhealthy ⇒ least-recently-failed (degrade, don't stop).

import type { ResolvedConfig, X402AllowlistEntry } from "../config/schema.js";
import type { UnixSeconds } from "../policy/types.js";
import { canaryVerdict, dayNumberOf, type CanaryResult } from "./canaries.js";
import { ConsecutiveFailureCounter, priceWithinCeiling } from "./checks.js";

export type UnhealthyReason = "price" | "contract" | "canary";

export type EndpointHealth = { status: "healthy" } | { status: "unhealthy"; untilTs: UnixSeconds; reason: UnhealthyReason };

interface EndpointRecord {
  health: EndpointHealth;
  lastFailedAt: UnixSeconds | null;
  canary: CanaryResult[];
}

export interface SelectOptions {
  /** Endpoints already tried this pulse. */
  exclude?: ReadonlySet<string>;
  /** Restrict to tier "cheap" entries (Conserving tier, 01 §6); falls back to all if none. */
  cheapOnly?: boolean;
}

export type EndpointConfig = Pick<ResolvedConfig, "x402Allowlist" | "agent" | "unhealthyCooldownSec" | "contractFailureLimit">;

/** Ordered candidate list (see header). Pure. */
export function candidateEndpoints(cfg: EndpointConfig): X402AllowlistEntry[] {
  const refs = [cfg.agent.models.primary, ...cfg.agent.models.fallbacks];
  const inference = cfg.x402Allowlist.filter((e) => e.kind === "inference");
  const out: X402AllowlistEntry[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const matches = inference.filter((e) => (e.id === ref || e.model === ref) && !seen.has(e.id));
    // stable: attested first, then allowlist order
    const ranked = [...matches.filter((e) => e.attested), ...matches.filter((e) => !e.attested)];
    for (const e of ranked) {
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}

export class EndpointManager {
  private readonly cfg: EndpointConfig;
  private readonly records = new Map<string, EndpointRecord>();
  readonly contractFailures = new ConsecutiveFailureCounter();
  private lastCanaryDay: bigint | null = null;

  constructor(cfg: EndpointConfig) {
    this.cfg = cfg;
    for (const e of candidateEndpoints(cfg)) {
      this.records.set(e.id, { health: { status: "healthy" }, lastFailedAt: null, canary: [] });
    }
  }

  candidates(): X402AllowlistEntry[] {
    return candidateEndpoints(this.cfg);
  }

  entry(id: string): X402AllowlistEntry | undefined {
    return this.candidates().find((e) => e.id === id);
  }

  private rec(id: string): EndpointRecord {
    const r = this.records.get(id);
    if (r === undefined) throw new Error(`EndpointManager: unknown endpoint "${id}"`);
    return r;
  }

  /** Health at `now`; an expired cooldown reads (and becomes) healthy. */
  health(id: string, now: UnixSeconds): EndpointHealth {
    const r = this.rec(id);
    if (r.health.status === "unhealthy" && now >= r.health.untilTs) r.health = { status: "healthy" };
    return r.health;
  }

  isHealthy(id: string, now: UnixSeconds): boolean {
    return this.health(id, now).status === "healthy";
  }

  lastFailedAt(id: string): UnixSeconds | null {
    return this.rec(id).lastFailedAt;
  }

  canaryHistory(id: string): readonly CanaryResult[] {
    return this.rec(id).canary;
  }

  markUnhealthy(id: string, reason: UnhealthyReason, now: UnixSeconds): void {
    const r = this.rec(id);
    const cd = this.cfg.unhealthyCooldownSec[reason];
    r.health = { status: "unhealthy", untilTs: now + cd, reason };
    r.lastFailedAt = now;
    this.contractFailures.reset(id);
  }

  select(now: UnixSeconds, opts: SelectOptions = {}): X402AllowlistEntry | undefined {
    const exclude = opts.exclude ?? new Set<string>();
    let pool = this.candidates().filter((e) => !exclude.has(e.id));
    if (opts.cheapOnly === true) {
      const cheap = pool.filter((e) => e.tier === "cheap");
      if (cheap.length > 0) pool = cheap;
    }
    if (pool.length === 0) return undefined;
    const healthy = pool.find((e) => this.isHealthy(e.id, now));
    if (healthy !== undefined) return healthy;
    // All unhealthy ⇒ least-recently-failed (ties: candidate order).
    let best: X402AllowlistEntry | undefined;
    let bestTs: bigint | null = null;
    for (const e of pool) {
      const ts = this.rec(e.id).lastFailedAt ?? -1n;
      if (best === undefined || bestTs === null || ts < bestTs) {
        best = e;
        bestTs = ts;
      }
    }
    return best;
  }

  /** (a) price ceiling. Returns true if within the ceiling; else marks unhealthy (price cooldown). */
  checkPrice(id: string, quotedPerMTokUsd: bigint, now: UnixSeconds): boolean {
    const e = this.entry(id);
    if (e === undefined) throw new Error(`EndpointManager: unknown endpoint "${id}"`);
    if (priceWithinCeiling(e, quotedPerMTokUsd)) return true;
    this.markUnhealthy(id, "price", now);
    return false;
  }

  /** (b) contract failure. Returns true if this failure made the endpoint unhealthy. */
  recordContractFailure(id: string, now: UnixSeconds): boolean {
    const r = this.rec(id);
    r.lastFailedAt = now;
    const n = this.contractFailures.fail(id);
    if (n >= this.cfg.contractFailureLimit) {
      this.markUnhealthy(id, "contract", now);
      return true;
    }
    return false;
  }

  recordContractSuccess(id: string): void {
    this.rec(id);
    this.contractFailures.succeed(id);
  }

  consecutiveContractFailures(id: string): number {
    return this.contractFailures.count(id);
  }

  /** (c) canary result for today; returns true if it made the endpoint unhealthy. */
  recordCanary(id: string, pass: boolean, now: UnixSeconds): boolean {
    const r = this.rec(id);
    const day = dayNumberOf(now);
    r.canary = [...r.canary.filter((c) => c.dayNumber !== day && c.dayNumber > day - 7n), { dayNumber: day, pass }];
    if (!pass) r.lastFailedAt = now;
    if (canaryVerdict(r.canary, now) === "unhealthy") {
      this.markUnhealthy(id, "canary", now);
      return true;
    }
    return false;
  }

  /** True iff no canary round has been started for the UTC day of `now`. */
  canaryDue(now: UnixSeconds): boolean {
    return this.lastCanaryDay === null || dayNumberOf(now) > this.lastCanaryDay;
  }

  markCanaryRound(now: UnixSeconds): void {
    this.lastCanaryDay = dayNumberOf(now);
  }
}
