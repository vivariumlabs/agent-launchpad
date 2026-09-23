// SPEC-M2 §6 — INV1..INV7. Fable-authored property/invariant suite.
// These are the properties 03 §11 calls "the most important code in the project":
// INV1 in particular — no treasury outflow outside the whitelist, EVER.

import { describe, it } from "vitest";
import fc from "fast-check";
import { evaluate } from "../../src/policy/engine.js";
import { applyApproved, dayKeyOf } from "../../src/ledger/ledger.js";
import { runwayDays } from "../../src/policy/runway.js";
import { inferenceBudget, categoryBudget } from "../../src/policy/rules/inference.js";
import { allowanceMax } from "../../src/policy/rules/treasury.js";
import type { BudgetLedger, ProposedAction, Verdict, WalletState } from "../../src/policy/types.js";
import {
  ACTION, ARWEAVE, CP, CP2, DAY, E6, E18, MARLIN_PAY, MARLIN_PAY2, NOW,
  PAYTO_DATA, PAYTO_INF_CHEAP, PAYTO_INF_STD, SPOKE, TOKEN_X, TOKEN_Y, TREASURY, USDG_RH,
  cfg, mkLedger, mkRunwayState, mkState, raw,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbAddress = fc
  .bigInt({ min: 0n, max: 2n ** 160n - 1n })
  .map((v) => (`0x${v.toString(16).padStart(40, "0")}`) as `0x${string}`);

const knownAddresses = [
  TREASURY, ACTION, MARLIN_PAY, MARLIN_PAY2, ARWEAVE, PAYTO_DATA, PAYTO_INF_CHEAP,
  PAYTO_INF_STD, USDG_RH, CP, CP2, TOKEN_X, TOKEN_Y, SPOKE.rh, SPOKE.base, SPOKE.arbitrum, SPOKE.optimism,
] as const;

/** Addresses biased toward whitelist members, near-misses, and randoms. */
const arbTo = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...knownAddresses) },
  { weight: 2, arbitrary: arbAddress },
);

const arbChain = fc.constantFrom("rh", "base", "arbitrum", "optimism") as fc.Arbitrary<"rh" | "base" | "arbitrum" | "optimism">;
const arbTreasuryAsset = fc.constantFrom("USDG", "USDC", "ETH") as fc.Arbitrary<"USDG" | "USDC" | "ETH">;
const arbPurpose = fc.constantFrom("oysterRental", "acrossBridge", "arweaveFunding", "gasTopUp", "x402Data") as fc.Arbitrary<
  "oysterRental" | "acrossBridge" | "arweaveFunding" | "gasTopUp" | "x402Data"
>;
const arbAmount6 = fc.bigInt({ min: 1n, max: 20_000n * E6 });
const arbAmountWei = fc.bigInt({ min: 1n, max: 2n * E18 });

const arbTreasuryTransfer: fc.Arbitrary<ProposedAction> = fc
  .record({
    purpose: arbPurpose,
    chain: arbChain,
    asset: arbTreasuryAsset,
    to: arbTo,
    amount: fc.oneof(arbAmount6, arbAmountWei),
    recipient: fc.option(fc.constantFrom(TREASURY, ACTION, CP), { nil: undefined }),
    destChain: arbChain, // SPEC-M2B: acrossBridge-only field (mechanical fix, Job A)
  })
  .map((r) => {
    const a: Record<string, unknown> = { kind: "treasuryTransfer", ...r };
    if (r.recipient === undefined) delete a["recipient"];
    if (r.purpose !== "acrossBridge") delete a["destChain"];
    return a as ProposedAction;
  });

const arbAllowance: fc.Arbitrary<ProposedAction> = fc
  .record({ amount: fc.bigInt({ min: 1n, max: 800n * E6 }) })
  .map((r) => ({ kind: "allowance", ...r }));

const arbInference: fc.Arbitrary<ProposedAction> = fc.record({
  kind: fc.constant("inference" as const),
  category: fc.constantFrom("pulse", "chat", "social") as fc.Arbitrary<"pulse" | "chat" | "social">,
  endpointId: fc.constantFrom("inf-cheap", "inf-std", "data-1", "nope", ""),
  maxCostUsd: fc.bigInt({ min: 1n, max: 1_000_000n }),
});

const arbActionKind: fc.Arbitrary<ProposedAction> = fc.oneof(
  fc.record({
    kind: fc.constant("actionTransfer" as const),
    asset: fc.constantFrom("USDG", "ETH", TOKEN_X, TOKEN_Y, USDG_RH) as fc.Arbitrary<"USDG" | "ETH" | `0x${string}`>,
    to: arbTo,
    amount: fc.oneof(arbAmount6, arbAmountWei),
  }),
  fc.record({
    kind: fc.constant("actionSwap" as const),
    tokenIn: fc.constantFrom("USDG", TOKEN_X, TOKEN_Y) as fc.Arbitrary<"USDG" | `0x${string}`>,
    tokenOut: fc.constantFrom("USDG", TOKEN_X, TOKEN_Y) as fc.Arbitrary<"USDG" | `0x${string}`>,
    amountIn: fc.oneof(arbAmount6, arbAmountWei),
    minOut: fc.bigInt({ min: 0n, max: 100n * E18 }),
  }),
  fc.record({
    kind: fc.constant("actionMint" as const),
    target: arbTo,
    value: fc.bigInt({ min: 1n, max: E18 }),
  }),
);

const arbSimple: fc.Arbitrary<ProposedAction> = fc.constantFrom(
  { kind: "heartbeat" } as ProposedAction,
  { kind: "distribute" } as ProposedAction,
  { kind: "treasurySwap", tokenIn: TOKEN_X, amountIn: 10n * E18, minOut: 1n } as ProposedAction,
);

const arbAnyAction = fc.oneof(arbTreasuryTransfer, arbAllowance, arbInference, arbActionKind, arbSimple);

// ---------------------------------------------------------------------------
// Whitelist oracle (independent re-derivation from the fixtures, NOT from engine code)
// ---------------------------------------------------------------------------

const lower = (s: string): string => s.toLowerCase();
const WHITELIST_BY_PURPOSE: Record<string, string[]> = {
  oysterRental: [MARLIN_PAY, MARLIN_PAY2].map(lower),
  acrossBridge: Object.values(SPOKE).map(lower),
  arweaveFunding: [lower(ARWEAVE)],
  gasTopUp: [TREASURY, ACTION].map(lower),
  x402Data: [lower(PAYTO_DATA)],
};
const ALL_TREASURY_DESTS = new Set(Object.values(WHITELIST_BY_PURPOSE).flat());

function verdictKey(v: Verdict): string {
  return v.allow ? `allow:${v.approval.actionHash}` : `deny:${v.code}:${v.detail}`;
}

// ---------------------------------------------------------------------------
// INV1 — no treasury outflow outside the whitelist, EVER
// ---------------------------------------------------------------------------

describe("INV1: treasury outflows only to whitelist", () => {
  it("single-shot: any allowed treasuryTransfer targets its purpose's exact destination set", () => {
    fc.assert(
      fc.property(arbTreasuryTransfer, (a) => {
        const v = evaluate(a, mkState(), mkLedger(), cfg, NOW);
        if (v.allow && a.kind === "treasuryTransfer") {
          const allowed = WHITELIST_BY_PURPOSE[a.purpose] ?? [];
          if (!allowed.includes(lower(a.to))) {
            throw new Error(`INV1 violated: ${a.purpose} allowed to ${a.to}`);
          }
          if (a.purpose === "acrossBridge" && lower(a.recipient ?? "") !== lower(TREASURY)) {
            throw new Error(`INV1 violated: bridge recipient ${String(a.recipient)}`);
          }
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("sequence: over any mixed action sequence with evolving ledger and clock, every approved treasury destination stays whitelisted", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbAnyAction, fc.bigInt({ min: 0n, max: 2n * DAY })), { minLength: 1, maxLength: 40 }),
        (steps) => {
          let ledger = mkLedger();
          let now = NOW;
          const state = mkState();
          for (const [a, gap] of steps) {
            now += gap;
            const v = evaluate(a, state, ledger, cfg, now);
            if (v.allow) {
              if (a.kind === "treasuryTransfer" && !ALL_TREASURY_DESTS.has(lower(a.to))) {
                throw new Error(`INV1 violated in sequence: to ${a.to}`);
              }
              if (a.kind === "inference" && !["inf-cheap", "inf-std"].includes(a.endpointId)) {
                throw new Error(`INV1 violated: inference endpoint ${a.endpointId}`);
              }
              ledger = applyApproved(ledger, a, now, state);
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// INV2 — allowance: ≤1 per 24h, each ≤ min(5% of treasury USDG, 500)
// ---------------------------------------------------------------------------

describe("INV2: allowance cadence and size", () => {
  it("holds over random allowance request sequences with evolving balance", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.bigInt({ min: 1n, max: 800n * E6 }), fc.bigInt({ min: 1n, max: (3n * DAY) / 2n })), {
          minLength: 1,
          maxLength: 30,
        }),
        (reqs) => {
          let ledger = mkLedger();
          let now = NOW;
          let state = mkState();
          let lastApprovedAt = -1n;
          for (const [amount, gap] of reqs) {
            now += gap;
            const a: ProposedAction = { kind: "allowance", amount };
            const usdgBefore = state.treasury.rh.USDG ?? 0n;
            const v = evaluate(a, state, ledger, cfg, now);
            if (v.allow) {
              const max = allowanceMax(state, cfg);
              if (amount > max) throw new Error(`INV2 violated: ${amount} > max ${max}`);
              if (lastApprovedAt >= 0n && now - lastApprovedAt < DAY) {
                throw new Error(`INV2 violated: two allowances ${now - lastApprovedAt}s apart`);
              }
              lastApprovedAt = now;
              ledger = applyApproved(ledger, a, now, state);
              state = structuredClone(state);
              state.treasury.rh.USDG = usdgBefore - amount; // outflow executed
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// INV3 — inference spend per UTC day ≤ clamp budget, per category
// ---------------------------------------------------------------------------

describe("INV3: inference budget", () => {
  it("per-day, per-category approved spend never exceeds the category budget", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom("pulse", "chat", "social") as fc.Arbitrary<"pulse" | "chat" | "social">,
            fc.constantFrom("inf-cheap", "inf-std"),
            fc.bigInt({ min: 1n, max: 600_000n }),
            fc.bigInt({ min: 0n, max: 6n * 3600n }),
          ),
          { minLength: 1, maxLength: 60 },
        ),
        (calls) => {
          let ledger = mkLedger();
          let now = NOW;
          const state = mkState();
          const spentByDayCat = new Map<string, bigint>();
          const B = inferenceBudget(ledger, cfg);
          for (const [category, endpointId, maxCostUsd, gap] of calls) {
            now += gap;
            const a: ProposedAction = { kind: "inference", category, endpointId, maxCostUsd };
            const v = evaluate(a, state, ledger, cfg, now);
            if (v.allow) {
              // G4: buckets key on the LEDGER's day (forward-only), not raw wall time.
              const rolledDay = dayKeyOf(now) > ledger.dayKey ? dayKeyOf(now) : ledger.dayKey;
              const key = `${rolledDay}:${category}`;
              const tot = (spentByDayCat.get(key) ?? 0n) + maxCostUsd;
              spentByDayCat.set(key, tot);
              if (tot > categoryBudget(B, category, cfg)) {
                throw new Error(`INV3 violated: ${key} spent ${tot} > ${categoryBudget(B, category, cfg)}`);
              }
              ledger = applyApproved(ledger, a, now, state);
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// INV4 — runway ≥ 45d after any approved non-hosting treasury spend
// ---------------------------------------------------------------------------

describe("INV4: hosting reserve (T0 rev 2)", () => {
  // Rev 2: the 45d reserve gates exactly the outflows that drain `fundable`:
  // allowance, and acrossBridge with a stable asset. Everything else is exempt
  // by design (survival infrastructure / already-bridged funds) — see SPEC-M2 T0 rev 2.
  it("any allowed fundable-draining spend (allowance, stable bridge) leaves runway ≥ minRunwayDays", () => {
    fc.assert(
      fc.property(
        fc.record({
          arbUsdc: fc.bigInt({ min: 0n, max: 500n * E6 }),
          rhUsdg: fc.bigInt({ min: 0n, max: 20_000n * E6 }),
          paidAhead: fc.bigInt({ min: -10n * DAY, max: 90n * DAY }),
          rate: fc.bigInt({ min: 1n, max: 5_000_000n }),
          action: fc.oneof(arbTreasuryTransfer, arbAllowance, arbInference),
        }),
        ({ arbUsdc, rhUsdg, paidAhead, rate, action }) => {
          const state = mkRunwayState(arbUsdc, rhUsdg, NOW + paidAhead, rate);
          const v = evaluate(action, state, mkLedger(), cfg, NOW);
          if (!v.allow) return;
          const gated =
            action.kind === "allowance" ||
            (action.kind === "treasuryTransfer" && action.purpose === "acrossBridge" && action.asset !== "ETH");
          if (!gated) return;
          const spend =
            action.kind === "allowance"
              ? { chain: "rh" as const, asset: "USDG" as const, amount: action.amount }
              : { chain: action.chain, asset: action.asset, amount: action.amount };
          const days = runwayDays(state, NOW, spend, cfg.bridgeHaircutBps);
          if (days < BigInt(cfg.minRunwayDays)) {
            throw new Error(`INV4 violated: ${action.kind} allowed with post-spend runway ${days}d`);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("INV4b (I1 rev 2): below dormantRunwayDays NO inference is ever allowed; below minRunwayDays the floor is gone", () => {
    fc.assert(
      fc.property(
        fc.record({
          arbUsdc: fc.bigInt({ min: 0n, max: 500n * E6 }),
          paidAhead: fc.bigInt({ min: -10n * DAY, max: 90n * DAY }),
          rate: fc.bigInt({ min: 1n, max: 5_000_000n }),
          action: arbInference,
          income: fc.bigInt({ min: 0n, max: 200n * E6 }),
        }),
        ({ arbUsdc, paidAhead, rate, action, income }) => {
          if (action.kind !== "inference") return;
          const state = mkRunwayState(arbUsdc, 0n, NOW + paidAhead, rate);
          const ledger = mkLedger({ feeIncome7d: Array.from({ length: 7 }, () => income) });
          const v = evaluate(action, state, ledger, cfg, NOW);
          if (!v.allow) return;
          const days = runwayDays(state, NOW, undefined, cfg.bridgeHaircutBps);
          if (days < cfg.dormantRunwayDays) {
            throw new Error(`INV4b violated: inference allowed at runway ${days}d (< dormant ${cfg.dormantRunwayDays}d)`);
          }
          if (days < BigInt(cfg.minRunwayDays)) {
            // Floor withdrawn: allowed spend must fit inside the income-only budget.
            // feeIncome7d is `income` on all 7 days ⇒ avg = income exactly (integer).
            const budget = (income * 2500n) / 10_000n;
            const capped = budget > 60n * E6 ? 60n * E6 : budget;
            if (action.maxCostUsd > capped) {
              throw new Error(`INV4b violated: floorless budget ${capped} but spend ${action.maxCostUsd} allowed at ${days}d`);
            }
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
});

// ---------------------------------------------------------------------------
// INV5 — action wallet per-tx ≤ 20% of that asset's balance
// ---------------------------------------------------------------------------

describe("INV5: action per-tx cap", () => {
  it("every approved action-wallet outgoing leg is ≤ perTxPctBps of its asset balance", () => {
    fc.assert(
      fc.property(arbActionKind, (a) => {
        const state = mkState();
        const v = evaluate(a, state, mkLedger({ allowanceAmountToday: 500n * E6 }), cfg, NOW);
        if (!v.allow) return;
        const w = state.action.rh;
        const balOf = (asset: string): bigint =>
          asset === "USDG" ? (w.USDG ?? 0n) : asset === "ETH" ? w.native : (w.tokens?.[asset as `0x${string}`] ?? 0n);
        const cap = (b: bigint): bigint => (b * BigInt(cfg.perTxPctBps)) / 10_000n;
        const legs: Array<[string, bigint]> =
          a.kind === "actionTransfer"
            ? [[a.asset, a.amount]]
            : a.kind === "actionSwap"
              ? [[a.tokenIn, a.amountIn]]
              : a.kind === "actionMint"
                ? [["ETH", a.value]]
                : [];
        for (const [asset, amount] of legs) {
          if (amount > cap(balOf(asset))) {
            throw new Error(`INV5 violated: ${a.kind} ${asset} ${amount} > cap ${cap(balOf(asset))}`);
          }
        }
      }),
      { numRuns: 2000 },
    );
  });
});

// ---------------------------------------------------------------------------
// INV6 — determinism
// ---------------------------------------------------------------------------

describe("INV6: determinism", () => {
  it("evaluate is referentially transparent (twice + structuredClone of every input)", () => {
    fc.assert(
      fc.property(
        fc.oneof(arbAnyAction, fc.jsonValue().map(raw)),
        fc.bigInt({ min: 0n, max: 4n * DAY }),
        (a, dt) => {
          const state = mkState();
          const ledger = mkLedger();
          const v1 = evaluate(a, state, ledger, cfg, NOW + dt);
          const v2 = evaluate(a, state, ledger, cfg, NOW + dt);
          const v3 = evaluate(
            structuredClone(a),
            structuredClone(state),
            structuredClone(ledger),
            structuredClone(cfg),
            NOW + dt,
          );
          if (verdictKey(v1) !== verdictKey(v2) || verdictKey(v1) !== verdictKey(v3)) {
            throw new Error(`INV6 violated: ${verdictKey(v1)} / ${verdictKey(v2)} / ${verdictKey(v3)}`);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("evaluate never throws, whatever the input shape", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (junk) => {
        const v = evaluate(raw(junk), mkState(), mkLedger(), cfg, NOW);
        if (v.allow) throw new Error("INV6/G1: junk input was allowed");
      }),
      { numRuns: 1000 },
    );
  });
});

// ---------------------------------------------------------------------------
// INV7 — metamorphic default-deny: mutate any allowed action's destination ⇒ deny
// ---------------------------------------------------------------------------

describe("INV7: metamorphic default-deny", () => {
  // Templates known-allowed under the default fixtures.
  const allowedTemplates: ProposedAction[] = [
    { kind: "treasuryTransfer", purpose: "oysterRental", chain: "arbitrum", asset: "USDC", to: MARLIN_PAY, amount: 50n * E6 },
    { kind: "treasuryTransfer", purpose: "arweaveFunding", chain: "rh", asset: "USDG", to: ARWEAVE, amount: 5n * E6 },
    { kind: "treasuryTransfer", purpose: "gasTopUp", chain: "rh", asset: "ETH", to: TREASURY, amount: E18 / 200n },
    { kind: "treasuryTransfer", purpose: "x402Data", chain: "base", asset: "USDC", to: PAYTO_DATA, amount: E6 },
    { kind: "treasuryTransfer", purpose: "acrossBridge", chain: "rh", asset: "USDG", to: SPOKE.rh, amount: 100n * E6, recipient: TREASURY, destChain: "base" },
    { kind: "allowance", amount: 100n * E6 },
    { kind: "inference", category: "pulse", endpointId: "inf-std", maxCostUsd: 400_000n },
    { kind: "actionTransfer", asset: TOKEN_X, to: CP, amount: 50n * E18 },
  ];

  it("all templates actually allow (guard for the metamorphic step)", () => {
    for (const t of allowedTemplates) {
      const v = evaluate(t, mkState(), mkLedger(), cfg, NOW);
      if (!v.allow) throw new Error(`template ${t.kind} unexpectedly denied: ${!v.allow ? v.detail : ""}`);
    }
  });

  it("mutating the destination/endpoint of an allowed action to a random value denies", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allowedTemplates.keys()),
        arbAddress,
        fc.string({ minLength: 1, maxLength: 12 }),
        (idx, randomAddr, randomId) => {
          const t = structuredClone(allowedTemplates[idx]!);
          fc.pre(!ALL_TREASURY_DESTS.has(lower(randomAddr))); // random addr must be off-list
          let mutated: ProposedAction;
          switch (t.kind) {
            case "treasuryTransfer":
              mutated = { ...t, to: randomAddr };
              break;
            case "allowance":
              mutated = { ...t, amount: allowanceMax(mkState(), cfg) + 1n };
              break;
            case "inference":
              fc.pre(!["inf-cheap", "inf-std"].includes(randomId));
              mutated = { ...t, endpointId: randomId };
              break;
            case "actionTransfer":
              mutated = { ...t, to: TREASURY }; // protected address ⇒ LOOKALIKE
              break;
            default:
              return;
          }
          const v = evaluate(mutated, mkState(), mkLedger(), cfg, NOW);
          if (v.allow) throw new Error(`INV7 violated: mutated ${t.kind} was allowed`);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("chain/asset drift on a whitelisted destination denies (T2 is an exact-row match)", () => {
    fc.assert(
      fc.property(arbChain, arbTreasuryAsset, (chain, asset) => {
        fc.pre(!(chain === "arbitrum" && asset === "USDC"));
        const v = evaluate(
          { kind: "treasuryTransfer", purpose: "oysterRental", chain, asset, to: MARLIN_PAY, amount: 10n * E6 },
          mkState(), mkLedger(), cfg, NOW,
        );
        if (v.allow) throw new Error(`INV7 violated: oysterRental allowed on ${chain}/${asset}`);
      }),
      { numRuns: 200 },
    );
  });
});
