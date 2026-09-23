// SPEC-M3B §1 seeder.ts — per-leg seeding (04 §2) from the funding wallet, NATIVELY per chain (no
// bridging here). Every tx: fee-capped + nonce-managed (ChainClient.prepare), signed → PERSISTED
// (hash + raw bytes) → broadcast → receipt-awaited. Per-leg idempotence: a leg is skipped when its
// seed row already has a confirmed tx OR the target balance already ≥ expected. A leg whose stored
// tx the node has forgotten is re-broadcast from the SAME signed bytes (same nonce ⇒ can never pay
// twice); only a provably dead tx (nonce consumed by another tx, ours unmined) is re-planned.
//
// Seed destinations are ALWAYS the registry's treasury for the agent, read on-chain by the machine:
// `instanceOf(agentId).treasuryEOA` for post-registration legs, `expectedTreasuryEOA(agentId)` (pinned
// at createAgent; registerInstance only accepts that address) for the pre-registration gas leg —
// never an address from config, event data or the frozen config.
//
// USDG remainder (review ruling 3): the rh.usdg leg is planned LAST as `deferred` with its budget =
// the creation fee, and resolved only once every other leg is terminal:
//   remainder = fee − Σ µUSD of EXECUTED legs (status confirmed — a tx / top-up of ours landed,
//               including preGas).
// Skipped, satisfied (target already held it, nothing spent) and disabled legs' budgets fold into
// the treasury's USDG seed instead of vanishing. Invariant: Σ executed + USDG remainder = fee.
//
// Hosting (ruling, M3 s2 close; 04 §2 / 01 §4 — the first month's rental is part of the creation-fee
// accounting): a VIRTUAL leg `hosting` (asset "virtual": no transfer of ours — the funding wallet
// already paid Oyster at deploy time) planned FIRST with usdMicro = the deploy's projected rental
// (oyster.durationMin × rateUsdcMicroPerHour, µUSDC ≙ µUSD, rounded up — projectedRentalMicroUsdc).
// The machine marks it `confirmed` (ref = the Oyster job id) because SEEDING is only reachable after
// the deploy succeeded; as an executed leg it shrinks the USDG remainder by exactly the rental, and
// it is part of the plan-time fee-coverage check. Genesis only: revivals are paid by the reviver (04 §6).

import type { Address, Hex } from "viem";
import { hasTransferLog, erc20TransferCalldata, type ChainClient, type ChainKey, type TxReceipt } from "./chain.js";
import { LEG_DEFS, LEG_IDS, projectedRentalMicroUsdc, type GenesisConfig } from "./config.js";
import type { GenesisDb, SeedRow } from "./db.js";
import { Fatal, NonceConsumed } from "./errors.js";
import type { Logger } from "./log.js";
import type { TurboFunder } from "./turbo.js";

export interface PlannedLeg {
  leg: string;
  chain: ChainKey;
  asset: "native" | "erc20" | "turbo" | "virtual";
  token: Address | null;
  target: Address;
  amount: bigint;
  mode: "required" | "conditional";
  /** µUSD budget (remainder leg: the whole creation fee, resolved later). */
  usdMicro: bigint;
  /** Only the remainder leg: planned `deferred` (amount unresolved). */
  deferred?: boolean;
}

/** Seed-table leg id of the pre-registration gas leg. */
export const PRE_GAS_LEG = "preGas";
export const REMAINDER_LEG = "rh.usdg";
/** Virtual leg: the deploy's Oyster rental (already paid by the funding wallet at deploy time). */
export const HOSTING_LEG = "hosting";

export type SeedCfg = Pick<GenesisConfig, "seeding" | "tokens" | "contracts" | "chains" | "timing" | "legModes" | "oyster">;

export function usdToWei(usdMicro: bigint, ethUsdMicro: bigint): bigint {
  if (ethUsdMicro <= 0n) throw new Error("ethUsdMicro must be > 0");
  return (usdMicro * 10n ** 18n) / ethUsdMicro;
}

/** wei → µUSD, rounded UP (so a $1 leg converted to wei and back books as exactly $1). */
export function weiToUsdCeil(wei: bigint, ethUsdMicro: bigint): bigint {
  if (ethUsdMicro <= 0n) throw new Error("ethUsdMicro must be > 0");
  return (wei * ethUsdMicro + 10n ** 18n - 1n) / 10n ** 18n;
}

/** The pre-registration gas leg (review ruling 1): RH ETH to registry.expectedTreasuryEOA(agentId). */
export function planPreGasLeg(cfg: SeedCfg, target: Address): PlannedLeg {
  const amount = cfg.seeding.preRegistrationGasWei;
  return { leg: PRE_GAS_LEG, chain: "rh", asset: "native", token: null, target, amount, mode: "required", usdMicro: weiToUsdCeil(amount, cfg.seeding.ethUsdMicro) };
}

/**
 * The virtual hosting leg: µUSD = projected rental of ONE deploy (durationMin × rate, rounded up);
 * target = the Oyster operator (informational — nothing is sent). Planned `planned`; the machine
 * confirms it with the deploy's job id.
 */
export function planHostingLeg(cfg: Pick<SeedCfg, "oyster">): PlannedLeg {
  const usd = projectedRentalMicroUsdc(cfg.oyster);
  return { leg: HOSTING_LEG, chain: "arbitrum", asset: "virtual", token: null, target: cfg.oyster.operator as Address, amount: usd, mode: "required", usdMicro: usd };
}

function legUsd(cfg: SeedCfg, id: (typeof LEG_IDS)[number]): bigint | "remainder" {
  return cfg.seeding.legs[id]?.usdMicro ?? LEG_DEFS[id].usdMicro;
}

/**
 * The genesis plan (04 §2), frozen at first SEEDING entry. The USDG remainder leg comes LAST and
 * `deferred` (amount = the creation fee as its budget, resolved by `resolveRemainder`); the virtual
 * `hosting` leg comes FIRST. Plan-time validation is worst case: the fee must cover every
 * non-disabled leg + hosting + the pre-registration gas leg with something left for USDG, else Fatal. USDG and USDC have 6 decimals ⇒ 1 unit = 1 µUSD.
 */
export function planGenesisLegs(cfg: SeedCfg, creationFee: bigint, treasury: Address): PlannedLeg[] {
  const hosting = planHostingLeg(cfg);
  let worstCase = planPreGasLeg(cfg, treasury).usdMicro + hosting.usdMicro;
  const out: PlannedLeg[] = [hosting];
  let remainder: PlannedLeg | undefined;
  for (const id of LEG_IDS) {
    const mode = cfg.legModes[id];
    if (mode === "disabled") continue;
    const def = LEG_DEFS[id];
    const u = legUsd(cfg, id);
    const token = def.token === "usdg" ? cfg.contracts.usdg : def.token === "baseUsdc" ? cfg.tokens.baseUsdc : null;
    if (u === "remainder") {
      remainder = { leg: id, chain: def.chain, asset: def.asset, token, target: treasury, amount: creationFee, mode, usdMicro: creationFee, deferred: true };
      continue;
    }
    worstCase += u;
    // native: wei at the static ETH price; else 6-decimal stable (USDG / USDC) or µUSD of Turbo credits
    const amount = def.asset === "native" ? usdToWei(u, cfg.seeding.ethUsdMicro) : u;
    out.push({ leg: id, chain: def.chain, asset: def.asset, token, target: treasury, amount, mode, usdMicro: u });
  }
  if (creationFee - worstCase <= 0n) {
    throw new Fatal("seed_plan_invalid", `creation fee ${creationFee} does not cover the other legs + hosting + pre-registration gas (${worstCase} µUSD)`);
  }
  if (remainder !== undefined) out.push(remainder);
  return out;
}

/**
 * Resolve the deferred USDG remainder: budget (the frozen creation fee) − Σ µUSD of the EXECUTED
 * (`confirmed`) legs among `rows` (the remainder row itself excluded). Every other row must already
 * be terminal. Throws Fatal if not positive (cannot happen after plan-time validation).
 */
export function resolveRemainder(remainderRow: SeedRow, rows: readonly SeedRow[]): { amount: bigint; executed: string[]; spent: bigint } {
  if (remainderRow.usdMicro === null) throw new Fatal("seed_state_corrupt", `${remainderRow.leg}: deferred without a budget`);
  const budget = BigInt(remainderRow.usdMicro);
  let spent = 0n;
  const executed: string[] = [];
  for (const r of rows) {
    if (r.leg === remainderRow.leg) continue;
    if (r.status !== "confirmed" && r.status !== "satisfied" && r.status !== "skipped") {
      throw new Fatal("seed_state_corrupt", `remainder resolved while leg ${r.leg} is ${r.status}`);
    }
    if (r.status !== "confirmed") continue;
    if (r.usdMicro === null) throw new Fatal("seed_state_corrupt", `${r.leg}: no µUSD budget recorded`);
    spent += BigInt(r.usdMicro);
    executed.push(r.leg);
  }
  const amount = budget - spent;
  if (amount <= 0n) throw new Fatal("seed_plan_invalid", `creation fee ${budget} − executed legs ${spent} µUSD ≤ 0`);
  return { amount, executed, spent };
}

/** Revival (04 §6): NO full seeding — only the minimal RH gas leg (`revivalGasSeed`, DEFAULT $2). */
export function planRevivalLegs(cfg: SeedCfg, treasury: Address): PlannedLeg[] {
  return [
    {
      leg: "rh.eth",
      chain: "rh",
      asset: "native",
      token: null,
      target: treasury,
      amount: usdToWei(cfg.seeding.revivalGasSeedUsdMicro, cfg.seeding.ethUsdMicro),
      mode: "required",
      usdMicro: cfg.seeding.revivalGasSeedUsdMicro,
    },
  ];
}

export interface SeederDeps {
  db: GenesisDb;
  chains: Partial<Record<ChainKey, ChainClient>>;
  turbo: TurboFunder;
  cfg: SeedCfg;
  log: Logger;
}

export type LegOutcome = "done" | "pending" | "reverted";

function chainCfg(deps: SeederDeps, chain: ChainKey): { gasReserveWei: bigint } | undefined {
  return deps.cfg.chains[chain];
}

async function targetBalance(c: ChainClient, row: SeedRow): Promise<bigint> {
  return row.asset === "erc20" ? c.erc20Balance(row.token as Address, row.target as Address) : c.nativeBalance(row.target as Address);
}

/** Can the funding wallet pay this leg (amount + gas reserve)? */
async function fundable(deps: SeederDeps, c: ChainClient, row: SeedRow): Promise<{ ok: boolean; why: string }> {
  const reserve = chainCfg(deps, c.key)?.gasReserveWei ?? 0n;
  const amount = BigInt(row.amount);
  const native = await c.nativeBalance(c.sender);
  if (row.asset === "native") {
    return native >= amount + reserve ? { ok: true, why: "" } : { ok: false, why: `funding wallet holds ${native} wei on ${c.key}, leg needs ${amount} + reserve ${reserve}` };
  }
  const tok = await c.erc20Balance(row.token as Address, c.sender);
  if (tok < amount) return { ok: false, why: `funding wallet holds ${tok} of ${row.token} on ${c.key}, leg needs ${amount}` };
  if (native < reserve) return { ok: false, why: `funding wallet holds ${native} wei gas on ${c.key}, reserve ${reserve}` };
  return { ok: true, why: "" };
}

function landed(row: SeedRow, rc: TxReceipt, sender: Address): boolean {
  if (rc.status !== "success") return false;
  if (row.asset !== "erc20") return true;
  return hasTransferLog(rc, row.token as Address, sender, row.target as Address, BigInt(row.amount));
}

function settle(deps: SeederDeps, row: SeedRow, rc: TxReceipt, sender: Address, now: bigint): LegOutcome {
  if (landed(row, rc, sender)) {
    deps.db.patchSeed(row.flow, row.leg, { status: "confirmed" }, now);
    deps.db.event(row.flow, row.agentId, now, "seed_confirmed", `${row.leg} ${row.amount} → ${row.target} tx ${row.txHash ?? "?"}`);
    return "done";
  }
  deps.db.patchSeed(row.flow, row.leg, { status: "failed", txHash: null, raw: null, note: `tx ${row.txHash ?? "?"} ${rc.status === "success" ? "succeeded without the expected Transfer log" : "reverted"}` }, now);
  deps.db.event(row.flow, row.agentId, now, "seed_reverted", `${row.leg} tx ${row.txHash ?? "?"}`);
  deps.log.error(`[${row.flow}] seed leg ${row.leg} tx ${row.txHash ?? "?"} did not land (${rc.status})`);
  return "reverted";
}

async function processTurbo(deps: SeederDeps, row: SeedRow, now: bigint): Promise<LegOutcome> {
  const amount = BigInt(row.amount);
  if ((await deps.turbo.credited(row.target)) >= amount) {
    deps.db.patchSeed(row.flow, row.leg, { status: "satisfied", note: "turbo credits already ≥ expected" }, now);
    return "done";
  }
  if (!(await deps.turbo.funded())) {
    const msg = `!!! [${row.flow}] ARWEAVE SEED LEG: Turbo is UNFUNDED — ${row.mode === "conditional" ? "SKIPPING" : "BLOCKED"} ${row.amount} µUSD for ${row.target}`;
    deps.log.error(msg);
    if (row.mode === "conditional") {
      deps.db.patchSeed(row.flow, row.leg, { status: "skipped", note: "turbo unfunded" }, now);
      deps.db.event(row.flow, row.agentId, now, "seed_skipped", `${row.leg}: turbo unfunded`);
      return "done";
    }
    throw new Error(`turbo unfunded (required leg ${row.leg})`);
  }
  deps.db.patchSeed(row.flow, row.leg, { status: "submitted", attempts: row.attempts + 1 }, now);
  const ref = await deps.turbo.topUp(row.target, amount);
  deps.db.patchSeed(row.flow, row.leg, { status: "confirmed", txHash: ref }, now);
  deps.db.event(row.flow, row.agentId, now, "seed_confirmed", `${row.leg} ${row.amount} µUSD turbo → ${row.target} ref ${ref}`);
  return "done";
}

/** Drive one leg as far as it can go now. Transient problems throw (RPC, fee cap, funding low). */
export async function processLeg(deps: SeederDeps, row0: SeedRow, now: bigint): Promise<LegOutcome> {
  let row = row0;
  if (row.status === "confirmed" || row.status === "satisfied" || row.status === "skipped") return "done";
  if (row.status === "deferred") throw new Fatal("seed_state_corrupt", `${row.leg}: processed before its remainder amount was resolved`);
  // Virtual legs are confirmed by the machine (hosting ⇐ the deploy succeeded); never sent from here.
  if (row.asset === "virtual") throw new Fatal("seed_state_corrupt", `${row.leg}: virtual leg processed as a transfer (status ${row.status})`);
  if (row.asset === "turbo") return processTurbo(deps, row, now);

  const c = deps.chains[row.chain as ChainKey];
  if (c === undefined) {
    if (row.mode === "conditional") {
      deps.log.error(`!!! [${row.flow}] seed leg ${row.leg} SKIPPED: chain ${row.chain} not configured`);
      deps.db.patchSeed(row.flow, row.leg, { status: "skipped", note: `chain ${row.chain} not configured` }, now);
      deps.db.event(row.flow, row.agentId, now, "seed_skipped", `${row.leg}: chain not configured`);
      return "done";
    }
    throw new Fatal("seed_chain_missing", `required leg ${row.leg} needs chain ${row.chain}`);
  }

  if (row.status === "submitted" && row.txHash !== null) {
    const hash = row.txHash as Hex;
    const rc = await c.receipt(hash);
    if (rc !== null) return settle(deps, row, rc, c.sender, now);
    if (await c.known(hash)) return "pending";
    if (row.raw === null) throw new Fatal("seed_state_corrupt", `${row.leg}: submitted without raw bytes`);
    try {
      await c.broadcast(row.raw as Hex); // SAME signed bytes: idempotent by nonce
      deps.db.event(row.flow, row.agentId, now, "seed_rebroadcast", `${row.leg} tx ${hash}`);
      return "pending";
    } catch (e) {
      if (!(e instanceof NonceConsumed)) throw e;
      const rc2 = await c.receipt(hash);
      if (rc2 !== null) return settle(deps, row, rc2, c.sender, now);
      deps.log.warn(`[${row.flow}] seed leg ${row.leg}: tx ${hash} is dead (nonce consumed elsewhere, never mined) — re-planning`);
      deps.db.patchSeed(row.flow, row.leg, { status: "planned", txHash: null, raw: null, note: `dropped ${hash}: nonce consumed` }, now);
      deps.db.event(row.flow, row.agentId, now, "seed_dropped", `${row.leg} tx ${hash}`);
      row = { ...row, status: "planned", txHash: null, raw: null };
    }
  }

  // Fresh send (planned / failed). Idempotence by balance first. The pre-registration gas leg is
  // skipped at HALF its amount (ruling 1): a treasury that already holds that much can register.
  const amount = BigInt(row.amount);
  const threshold = row.leg === PRE_GAS_LEG ? amount / 2n : amount;
  const bal = await targetBalance(c, row);
  if (bal >= threshold) {
    deps.db.patchSeed(row.flow, row.leg, { status: "satisfied", note: `target balance ${bal} ≥ ${threshold}` }, now);
    deps.db.event(row.flow, row.agentId, now, "seed_satisfied", `${row.leg}: balance ${bal} ≥ ${threshold}`);
    return "done";
  }
  const f = await fundable(deps, c, row);
  if (!f.ok) {
    if (row.mode === "conditional") {
      deps.log.error(`!!! [${row.flow}] seed leg ${row.leg} SKIPPED: ${f.why}`);
      deps.db.patchSeed(row.flow, row.leg, { status: "skipped", note: f.why }, now);
      deps.db.event(row.flow, row.agentId, now, "seed_skipped", `${row.leg}: ${f.why}`);
      return "done";
    }
    deps.log.error(`!!! [${row.flow}] FUNDING WALLET LOW — required seed leg ${row.leg} blocked: ${f.why}`);
    throw new Error(`funding wallet low: ${f.why}`);
  }

  const req =
    row.asset === "native"
      ? { to: row.target as Address, value: amount }
      : { to: row.token as Address, data: erc20TransferCalldata(row.target as Address, amount), value: 0n };
  const signed = await c.prepare(req);
  // Persist BEFORE broadcast: a crash from here on resumes from the stored hash/raw bytes.
  deps.db.patchSeed(row.flow, row.leg, { status: "submitted", txHash: signed.hash, raw: signed.raw, attempts: row.attempts + 1, note: null }, now);
  deps.db.event(row.flow, row.agentId, now, "seed_submitted", `${row.leg} ${row.amount} → ${row.target} on ${row.chain} tx ${signed.hash} nonce ${signed.nonce}`);
  await c.broadcast(signed.raw);
  const rc = await c.waitReceipt(signed.hash, deps.cfg.timing.receiptTimeoutSec * 1000);
  if (rc === null) return "pending";
  return settle(deps, { ...row, status: "submitted", txHash: signed.hash, raw: signed.raw }, rc, c.sender, now);
}

/**
 * RECONCILING check for one leg: it has landed iff (its recorded tx has a successful on-chain
 * receipt — re-fetched now, not trusted from the db — carrying the expected transfer) OR the target
 * balance is ≥ expected. The receipt path matters: the agent's CVM is already running and may spend
 * seeded funds before reconciliation; a landed seed must never be re-sent because of that.
 */
export async function legLanded(deps: SeederDeps, row: SeedRow): Promise<boolean> {
  if (row.status === "skipped") return true;
  // Virtual (hosting): nothing to re-check on-chain; landed iff the machine confirmed it.
  if (row.asset === "virtual") return row.status === "confirmed";
  // preGas existed only to pay for registerInstance; reaching RECONCILING proves registration
  // happened, and SEEDING already drove the row terminal. Its balance is expected to be spent.
  if (row.leg === PRE_GAS_LEG) return row.status === "confirmed" || row.status === "satisfied";
  if (row.asset === "turbo") {
    if (row.status === "confirmed" || row.status === "satisfied") return true;
    return (await deps.turbo.credited(row.target)) >= BigInt(row.amount);
  }
  const c = deps.chains[row.chain as ChainKey];
  if (c === undefined) return false;
  if (row.txHash !== null) {
    const rc = await c.receipt(row.txHash as Hex);
    if (rc !== null && landed(row, rc, c.sender)) return true;
  }
  return (await targetBalance(c, row)) >= BigInt(row.amount);
}
