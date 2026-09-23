import { describe, expect, it } from "vitest";
import type { SeedRow, SeedStatus } from "../src/db.js";
import { HOSTING_LEG, planGenesisLegs, planHostingLeg, planPreGasLeg, planRevivalLegs, PRE_GAS_LEG, resolveRemainder, usdToWei, weiToUsdCeil } from "../src/seeder.js";
import { Fatal } from "../src/errors.js";
import { makeHarness } from "./helpers/harness.js";
import { BASE_USDC, USDG } from "./helpers/mockWorld.js";

const T = "0x7EA5000000000000000000000000000000000001" as const;
/** Virtual hosting leg, DEFAULT rate 0.0512 USDC/h: testnet 180 min ⇒ 0.1536; mainnet 43 200 min (30 d) ⇒ 36.864. */
const HOSTING_TESTNET = 153_600n;
const HOSTING_MAINNET = 36_864_000n;

/** Seed rows as the db would hold them for a plan, with the given terminal statuses. */
function rowsOf(plan: ReturnType<typeof planGenesisLegs>, status: Record<string, SeedStatus>, preGas?: { usdMicro: bigint; status: SeedStatus }): SeedRow[] {
  const base = { flow: "genesis:1", agentId: 1, token: null, target: T, txHash: null, raw: null, note: null, attempts: 0, updatedAt: 0 };
  const rows: SeedRow[] = [];
  if (preGas !== undefined) rows.push({ ...base, leg: PRE_GAS_LEG, chain: "rh", asset: "native", amount: "1", mode: "required", usdMicro: preGas.usdMicro.toString(), status: preGas.status });
  for (const p of plan) {
    rows.push({ ...base, leg: p.leg, chain: p.chain, asset: p.asset, amount: p.amount.toString(), mode: p.mode, usdMicro: p.usdMicro.toString(), status: p.deferred === true ? "deferred" : (status[p.leg] ?? "confirmed") });
  }
  return rows;
}

describe("seed plan (04 §2 amounts, DEFAULT)", () => {
  it("testnet profile: hosting (virtual) FIRST, RH ETH $2, Base $2 + $15 USDC (conditional), Arb $1, Arweave $3 (conditional), no OP; USDG remainder LAST + deferred (budget = fee)", () => {
    const h = makeHarness({ chains: ["rh", "arbitrum", "base"] });
    const plan = planGenesisLegs(h.cfg, 75_000_000n, T);
    expect(plan.map((p) => [p.leg, p.chain, p.asset, p.amount, p.mode, p.token, p.usdMicro, p.deferred ?? false])).toEqual([
      [HOSTING_LEG, "arbitrum", "virtual", HOSTING_TESTNET, "required", null, HOSTING_TESTNET, false],
      ["rh.eth", "rh", "native", usdToWei(2_000_000n, 3_000_000_000n), "required", null, 2_000_000n, false],
      ["base.eth", "base", "native", usdToWei(2_000_000n, 3_000_000_000n), "conditional", null, 2_000_000n, false],
      ["base.usdc", "base", "erc20", 15_000_000n, "conditional", BASE_USDC, 15_000_000n, false],
      ["arbitrum.eth", "arbitrum", "native", usdToWei(1_000_000n, 3_000_000_000n), "required", null, 1_000_000n, false],
      ["arweave", "rh", "turbo", 3_000_000n, "conditional", null, 3_000_000n, false],
      ["rh.usdg", "rh", "erc20", 75_000_000n, "required", USDG, 75_000_000n, true],
    ]);
    for (const p of plan.filter((x) => x.leg !== HOSTING_LEG)) expect(p.target).toBe(T);
    expect(plan[0]!.target.toLowerCase()).toBe(h.cfg.oyster.operator.toLowerCase()); // informational: nothing is sent
  });

  it("hosting leg = durationMin × rateUsdcMicroPerHour (rounded up), per profile and per override", () => {
    expect(planHostingLeg(makeHarness().cfg).usdMicro).toBe(HOSTING_TESTNET);
    expect(planHostingLeg(makeHarness({ profile: "mainnet", chains: ["rh", "arbitrum", "base", "optimism"], turboEnabled: true }).cfg).usdMicro).toBe(HOSTING_MAINNET);
    const h = makeHarness();
    expect(planHostingLeg({ oyster: { ...h.cfg.oyster, durationMin: 1, rateUsdcMicroPerHour: 61n } }).usdMicro).toBe(2n); // 61/60 ⇒ ceil 2
  });

  it("remainder = fee − EXECUTED legs only: skipped / satisfied legs fold into USDG (testnet, preGas + hosting executed ⇒ 75 − 1 − 0.1536 − 2 − 1 = 70.8464)", () => {
    const h = makeHarness({ chains: ["rh", "arbitrum", "base"] });
    const plan = planGenesisLegs(h.cfg, 75_000_000n, T);
    const pre = { usdMicro: planPreGasLeg(h.cfg, T).usdMicro, status: "confirmed" as const };
    const skipped = { "base.eth": "skipped", "base.usdc": "skipped", "arweave": "skipped" } as const;
    const rows = rowsOf(plan, skipped, pre);
    const usdg = rows.find((r) => r.leg === "rh.usdg")!;
    expect(resolveRemainder(usdg, rows)).toEqual({ amount: 71_000_000n - HOSTING_TESTNET, executed: [PRE_GAS_LEG, HOSTING_LEG, "rh.eth", "arbitrum.eth"], spent: 4_000_000n + HOSTING_TESTNET });
    // the ruling's delta: the remainder shrinks by EXACTLY the rental vs. a plan without the hosting leg
    const noHosting = rows.filter((r) => r.leg !== HOSTING_LEG);
    expect(resolveRemainder(usdg, noHosting).amount - resolveRemainder(usdg, rows).amount).toBe(HOSTING_TESTNET);
    // every conditional leg sent ⇒ 75 − (1 + 0.1536 + 2 + 2 + 15 + 1 + 3) = 50.8464
    expect(resolveRemainder(usdg, rowsOf(plan, {}, pre)).amount).toBe(51_000_000n - HOSTING_TESTNET);
    // preGas satisfied (treasury already had ≥ half) and Arb satisfied by balance: nothing spent on them ⇒ folds in
    expect(resolveRemainder(usdg, rowsOf(plan, { ...skipped, "arbitrum.eth": "satisfied" }, { ...pre, status: "satisfied" })).amount).toBe(73_000_000n - HOSTING_TESTNET);
    // a non-terminal leg means the remainder cannot be resolved yet
    expect(() => resolveRemainder(usdg, rowsOf(plan, { "arbitrum.eth": "submitted" }))).toThrow(Fatal);
  });

  it("mainnet profile: OP included, every leg required; all executed + preGas + 30-day hosting ⇒ remainder 75 − 28 − 1 − 36.864 = 9.136 USDG", () => {
    const h = makeHarness({ profile: "mainnet", chains: ["rh", "arbitrum", "base", "optimism"], turboEnabled: true });
    const plan = planGenesisLegs(h.cfg, 75_000_000n, T);
    expect(plan.find((p) => p.leg === "optimism.eth")!.amount).toBe(usdToWei(5_000_000n, 3_000_000_000n));
    expect(plan.every((p) => p.mode === "required")).toBe(true);
    const rows = rowsOf(plan, {}, { usdMicro: 1_000_000n, status: "confirmed" });
    expect(plan[0]).toMatchObject({ leg: HOSTING_LEG, asset: "virtual", usdMicro: HOSTING_MAINNET });
    expect(resolveRemainder(rows.find((r) => r.leg === "rh.usdg")!, rows).amount).toBe(46_000_000n - HOSTING_MAINNET);
  });

  it("per-leg usd overrides; a fee that cannot cover the legs + hosting + preGas (worst case) is Fatal", () => {
    const h = makeHarness({ legs: { "base.usdc": { usdMicro: "70000000" } } });
    expect(() => planGenesisLegs(h.cfg, 75_000_000n, T)).toThrow(Fatal);
    // 2 + 2 + 15 + 1 + 3 = 23 enabled + 1 preGas + 0.1536 hosting = 24.1536 ⇒ that fee leaves nothing for USDG
    const t = makeHarness();
    expect(() => planGenesisLegs(t.cfg, 24_000_000n + HOSTING_TESTNET, T)).toThrow(/hosting \+ pre-registration gas/);
    expect(planGenesisLegs(t.cfg, 24_000_001n + HOSTING_TESTNET, T).at(-1)!.leg).toBe("rh.usdg");
    // mainnet: the 36.864 rental is part of the coverage check (75 covers 28 + 1 + 36.864; 65.864 does not)
    const m = makeHarness({ profile: "mainnet", chains: ["rh", "arbitrum", "base", "optimism"], turboEnabled: true });
    expect(() => planGenesisLegs(m.cfg, 29_000_000n + HOSTING_MAINNET, T)).toThrow(Fatal);
    expect(planGenesisLegs(m.cfg, 29_000_001n + HOSTING_MAINNET, T).at(-1)!.leg).toBe("rh.usdg");
  });

  it("preGas leg: $1 of RH ETH at ethUsdMicro (DEFAULT), booked as exactly $1; configurable in wei", () => {
    const h = makeHarness();
    expect(h.cfg.seeding.preRegistrationGasWei).toBe(usdToWei(1_000_000n, 3_000_000_000n));
    expect(planPreGasLeg(h.cfg, T)).toEqual({ leg: PRE_GAS_LEG, chain: "rh", asset: "native", token: null, target: T, amount: 333_333_333_333_333n, mode: "required", usdMicro: 1_000_000n });
    expect(weiToUsdCeil(10n ** 15n, 3_000_000_000n)).toBe(3_000_000n);
  });

  it("revival plan = the single RH gas leg (revivalGasSeed $2)", () => {
    const h = makeHarness();
    expect(planRevivalLegs(h.cfg, T)).toEqual([{ leg: "rh.eth", chain: "rh", asset: "native", token: null, target: T, amount: usdToWei(2_000_000n, 3_000_000_000n), mode: "required", usdMicro: 2_000_000n }]);
  });

  it("usdToWei: $2 at $3000/ETH", () => {
    expect(usdToWei(2_000_000n, 3_000_000_000n)).toBe(666_666_666_666_666n);
  });
});

describe("seeding execution", () => {
  it("conditional Base legs are SENT when the funding wallet holds the funds (native per chain, no bridging)", async () => {
    const h = makeHarness({ chains: ["rh", "arbitrum", "base"] });
    const { agentId, treasury } = h.createAgent();
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    expect(h.world.getNative("base", treasury)).toBe(usdToWei(2_000_000n, 3_000_000_000n));
    expect(h.world.getErc20("base", BASE_USDC, treasury)).toBe(15_000_000n);
  });

  it("conditional Base USDC leg is SKIPPED (loudly) when the funding wallet lacks it — finalize not blocked", async () => {
    const h = makeHarness({ chains: ["rh", "arbitrum", "base"] });
    h.world.setErc20("base", BASE_USDC, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 4_990_000n); // 4.99 USDC like the real wallet
    const { agentId } = h.createAgent();
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    const leg = h.db.seeds(`genesis:${agentId}`).find((s) => s.leg === "base.usdc")!;
    expect(leg.status).toBe("skipped");
    expect(leg.note).toMatch(/needs 15000000/);
    expect(h.log.lines.some((l) => /base\.usdc SKIPPED/.test(l))).toBe(true);
  });

  it("required leg with the funding wallet low: blocks (transient, loud), no attempt burned, resumes when topped up", async () => {
    const h = makeHarness();
    h.world.setNative("arbitrum", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 0n);
    const { agentId } = h.createAgent();
    await h.settle(4);
    const f = h.flow(agentId);
    expect(f.state).toBe("SEEDING");
    expect(f.seedAttempts).toBe(0);
    expect(f.lastError).toMatch(/funding wallet low/);
    expect(h.log.lines.some((l) => /FUNDING WALLET LOW/.test(l))).toBe(true);
    h.world.setNative("arbitrum", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 10n ** 18n);
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
  });

  it("the seed plan is frozen at first SEEDING entry (never re-planned on resume)", async () => {
    const h = makeHarness();
    h.world.setNative("arbitrum", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 0n);
    const { agentId } = h.createAgent();
    await h.settle(4);
    const plan1 = h.db.seeds(`genesis:${agentId}`).map((s) => [s.leg, s.leg === "rh.usdg" ? s.status : s.amount, s.usdMicro]);
    expect(plan1.at(-1)).toEqual(["rh.usdg", "deferred", "75000000"]); // budget = the fee read at first entry
    h.world.creationFee = 100_000_000n; // chain view changes — plan must not
    h.world.setNative("arbitrum", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", 10n ** 18n);
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    const rows = h.db.seeds(`genesis:${agentId}`);
    expect(rows.map((s) => [s.leg, s.leg === "rh.usdg" ? "deferred" : s.amount, s.usdMicro])).toEqual(plan1);
    // resolved from the FROZEN 75 fee: 75 − hosting 0.1536 − rh.eth 2 − arb 1 (the skipped conditional legs fold in)
    expect(rows.find((s) => s.leg === "rh.usdg")!.amount).toBe((72_000_000n - HOSTING_TESTNET).toString());
  });

  it("fee above the per-chain cap: tx never broadcast, flow waits (transient)", async () => {
    const h = makeHarness();
    const rh = h.chains.rh!;
    const orig = rh.prepare.bind(rh);
    let blocked = 2;
    rh.prepare = async (req) => {
      if (blocked-- > 0) {
        const { FeeCapExceeded } = await import("../src/errors.js");
        throw new FeeCapExceeded("rh: baseFee 900 gwei > cap");
      }
      return orig(req);
    };
    const { agentId } = h.createAgent();
    await h.watcher.poll();
    await h.machine.drive({ kind: "genesis", id: agentId }, h.world.timestamp);
    expect(h.flow(agentId).state).toBe("SEEDING");
    expect(h.flow(agentId).lastError).toMatch(/fee cap exceeded/);
    expect(h.world.executed).toHaveLength(0);
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
  });

  it("turbo funded: arweave leg tops up once and is confirmed", async () => {
    const credits = new Map<string, bigint>();
    const calls: string[] = [];
    const turbo = {
      funded: async () => true,
      credited: async (t: string) => credits.get(t) ?? 0n,
      topUp: async (t: string, u: bigint) => {
        calls.push(t);
        credits.set(t, (credits.get(t) ?? 0n) + u);
        return "turbo-payment-1";
      },
    };
    const h = makeHarness({ turbo });
    const { agentId, treasury } = h.createAgent();
    await h.settle();
    expect(h.flow(agentId).state).toBe("LIVE");
    expect(calls).toEqual([treasury]);
    expect(h.db.seeds(`genesis:${agentId}`).find((s) => s.leg === "arweave")!.status).toBe("confirmed");
  });
});
