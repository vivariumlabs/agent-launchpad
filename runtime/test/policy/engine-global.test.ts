// SPEC-M2 §3 global rules G1–G3, dispatch/default-deny, determinism, wallet
// isolation, approval binding, and the §6 hygiene grep.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { actionHash } from "../../src/policy/approval.js";
import { evaluate } from "../../src/policy/engine.js";
import { evaluateActionWallet } from "../../src/policy/rules/action.js";
import { evaluateTreasury } from "../../src/policy/rules/treasury.js";
import { walletForAction, type ProposedAction, type WalletState } from "../../src/policy/types.js";
import { ProposedActionSchema } from "../../src/policy/validate.js";
import {
  ACTION, CP, DAY, E18, E6, MARLIN_PAY, NOW, SPOKE, SWAP_ROUTER, TOKEN_X, TREASURY,
  cfg, ev, expectAllow, expectDeny, mkLedger, mkState, raw,
} from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "..", "src");

// One valid instance of every kind (all allowed under default fixtures).
const VALID: Record<ProposedAction["kind"], ProposedAction> = {
  heartbeat: { kind: "heartbeat" },
  registerInstance: { kind: "registerInstance" },
  distribute: { kind: "distribute" },
  treasuryTransfer: { kind: "treasuryTransfer", purpose: "oysterRental", chain: "arbitrum", asset: "USDC", to: MARLIN_PAY, amount: 10n * E6 },
  allowance: { kind: "allowance", amount: 100n * E6 },
  treasurySwap: { kind: "treasurySwap", tokenIn: TOKEN_X, amountIn: E18, minOut: 1n },
  inference: { kind: "inference", category: "pulse", endpointId: "inf-cheap", maxCostUsd: 100_000n },
  actionTransfer: { kind: "actionTransfer", asset: "ETH", to: CP, amount: E18 / 10n },
  actionSwap: { kind: "actionSwap", tokenIn: "USDG", tokenOut: TOKEN_X, amountIn: 10n * E6, minOut: 0n },
  actionLp: { kind: "actionLp", pool: `0x${"ab".repeat(32)}`, usdgAmount: 10n * E6, tokenAmount: E18, token: TOKEN_X },
  actionMint: { kind: "actionMint", target: CP, value: E18 / 100n },
  // SPEC-M2B §1
  castPost: { kind: "castPost", contentHash: `0x${"11".repeat(32)}` },
  castReply: { kind: "castReply", contentHash: `0x${"22".repeat(32)}`, parentHash: `0x${"33".repeat(32)}` },
  journalWrite: { kind: "journalWrite", contentHash: `0x${"44".repeat(32)}`, sizeBytes: 1024n },
  actionApprove: { kind: "actionApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: E18 },
  treasuryApprove: { kind: "treasuryApprove", token: TOKEN_X, spender: SWAP_ROUTER, amount: E18 },
};

describe("sanity: every VALID fixture is allowed under defaults", () => {
  for (const [kind, a] of Object.entries(VALID)) {
    it(`${kind} allowed`, () => expectAllow(ev(a)));
  }
});

describe("G1: shape validation ⇒ MALFORMED", () => {
  const tt = VALID.treasuryTransfer;
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["string", "heartbeat"],
    ["array", []],
    ["empty object (no kind)", {}],
    ["unknown kind", { kind: "withdrawAll" }],
    ["kind wrong type", { kind: 1 }],
    ["heartbeat extra field", { kind: "heartbeat", to: CP }],
    ["treasuryTransfer missing amount", { ...tt, amount: undefined }],
    ["treasuryTransfer missing to", (() => { const { to: _to, ...r } = tt as Extract<ProposedAction, { kind: "treasuryTransfer" }>; return r; })()],
    ["treasuryTransfer amount 0n", { ...tt, amount: 0n }],
    ["treasuryTransfer amount -1n", { ...tt, amount: -1n }],
    ["treasuryTransfer amount number", { ...tt, amount: 10_000_000 }],
    ["treasuryTransfer amount string", { ...tt, amount: "10000000" }],
    ["treasuryTransfer to short hex", { ...tt, to: "0x1234" }],
    ["treasuryTransfer to non-address", { ...tt, to: "marlin.eth" }],
    ["treasuryTransfer to bad checksum", { ...tt, to: "0xBb000001000000000000000000000000000000B1" }], // MARLIN_PAY with wrong checksum casing
    ["treasuryTransfer unknown purpose", { ...tt, purpose: "donation" }],
    ["treasuryTransfer unknown chain", { ...tt, chain: "polygon" }],
    ["treasuryTransfer unknown asset", { ...tt, asset: "DAI" }],
    ["treasuryTransfer extra field", { ...tt, memo: "x" }],
    ["treasuryTransfer recipient on non-bridge purpose", { ...tt, recipient: TREASURY }],
    ["acrossBridge malformed recipient", { kind: "treasuryTransfer", purpose: "acrossBridge", chain: "rh", asset: "USDG", to: SPOKE.rh, amount: E6, recipient: "0xdead", destChain: "base" }],
    ["allowance amount 0n", { kind: "allowance", amount: 0n }],
    ["allowance amount negative", { kind: "allowance", amount: -5n }],
    ["allowance extra field", { kind: "allowance", amount: E6, to: CP }],
    ["treasurySwap minOut 0n (T5 minOut > 0)", { ...VALID.treasurySwap, minOut: 0n }],
    ["treasurySwap amountIn 0n", { ...VALID.treasurySwap, amountIn: 0n }],
    ["treasurySwap tokenIn 'USDG' symbol", { ...VALID.treasurySwap, tokenIn: "USDG" }],
    ["inference unknown category", { ...VALID.inference, category: "trading" }],
    ["inference maxCostUsd 0n", { ...VALID.inference, maxCostUsd: 0n }],
    ["inference endpointId number", { ...VALID.inference, endpointId: 7 }],
    ["actionTransfer unknown asset symbol", { ...VALID.actionTransfer, asset: "BTC" }],
    ["actionTransfer bad to", { ...VALID.actionTransfer, to: "0xzz" }],
    ["actionTransfer amount 0n", { ...VALID.actionTransfer, amount: 0n }],
    ["actionTransfer with chain field (extra)", { ...VALID.actionTransfer, chain: "base" }],
    ["actionSwap minOut -1n", { ...VALID.actionSwap, minOut: -1n }],
    ["actionSwap amountIn 0n", { ...VALID.actionSwap, amountIn: 0n }],
    ["actionSwap tokenOut 'ETH'", { ...VALID.actionSwap, tokenOut: "ETH" }],
    ["actionLp pool not 32 bytes", { ...VALID.actionLp, pool: "0xabcd" }],
    ["actionLp usdgAmount 0n", { ...VALID.actionLp, usdgAmount: 0n }],
    ["actionLp tokenAmount 0n", { ...VALID.actionLp, tokenAmount: 0n }],
    ["actionMint value 0n", { ...VALID.actionMint, value: 0n }],
    ["actionMint bad target", { ...VALID.actionMint, target: "0x0" }],
  ];
  for (const [name, input] of cases) {
    it(`G1: ${name} ⇒ MALFORMED`, () => expectDeny(ev(raw(input)), "MALFORMED"));
  }

  for (const [kind, a] of Object.entries(VALID)) {
    it(`G1: ${kind} with an extra field ⇒ MALFORMED`, () => {
      expectDeny(ev(raw({ ...a, extra: 1n })), "MALFORMED");
    });
  }

  it("G1: now not a bigint ⇒ MALFORMED", () => {
    expectDeny(evaluate(VALID.heartbeat, mkState(), mkLedger(), cfg, raw(1) as unknown as bigint), "MALFORMED");
  });
  it("G1: negative now ⇒ MALFORMED", () => {
    expectDeny(evaluate(VALID.heartbeat, mkState(), mkLedger(), cfg, -1n), "MALFORMED");
  });
  it("G1: acrossBridge with recipient: undefined is accepted as absent (⇒ BRIDGE_RECIPIENT, not MALFORMED)", () => {
    const a = raw({ kind: "treasuryTransfer", purpose: "acrossBridge", chain: "rh", asset: "USDG", to: SPOKE.rh, amount: E6, recipient: undefined, destChain: "base" });
    expectDeny(ev(a), "BRIDGE_RECIPIENT");
  });
});

describe("G2: default-deny dispatch", () => {
  it("G2: every schema kind maps to exactly one wallet", () => {
    const kinds = ProposedActionSchema.options.map((o) => o.shape.kind.value);
    expect(new Set(kinds)).toEqual(new Set(Object.keys(VALID)));
    for (const k of kinds) expect(["treasury", "action", "fc", "journal"]).toContain(walletForAction(k));
  });

  it("G2: treasury rule module denies every action-wallet kind with NO_RULE", () => {
    const s = mkState();
    for (const k of ["actionTransfer", "actionSwap", "actionLp", "actionMint", "actionApprove", "castPost", "castReply", "journalWrite"] as const) {
      const v = evaluateTreasury(VALID[k], s, mkLedger(), cfg, NOW);
      expectDeny(v, "NO_RULE");
    }
  });

  it("G2: action rule module denies every treasury kind with NO_RULE", () => {
    const s = mkState();
    for (const k of ["heartbeat", "registerInstance", "distribute", "treasuryTransfer", "allowance", "treasurySwap", "inference", "treasuryApprove", "castPost", "castReply", "journalWrite"] as const) {
      const v = evaluateActionWallet(VALID[k], s.action, mkLedger(), cfg, NOW);
      expectDeny(v, "NO_RULE");
    }
  });

  it("G1/G2: action with a throwing getter never throws out of evaluate, denies MALFORMED", () => {
    const evil = { kind: "allowance" } as Record<string, unknown>;
    Object.defineProperty(evil, "amount", { enumerable: true, get: () => { throw new Error("boom"); } });
    expectDeny(ev(raw(evil)), "MALFORMED");
  });

  it("G2: structurally broken state never throws, denies MALFORMED", () => {
    const broken = raw({}) as unknown as WalletState;
    expectDeny(evaluate(VALID.allowance, broken, mkLedger(), cfg, NOW), "MALFORMED");
    expectDeny(evaluate(VALID.actionTransfer, broken, mkLedger(), cfg, NOW), "MALFORMED");
  });
});

describe("G3: balance checks at evaluation time", () => {
  it("G3: treasuryTransfer asset missing on that chain ⇒ INSUFFICIENT_BALANCE", () => {
    const a: ProposedAction = { kind: "treasuryTransfer", purpose: "acrossBridge", chain: "optimism", asset: "USDC", to: SPOKE.optimism, amount: 1n, recipient: TREASURY, destChain: "base" };
    expectDeny(ev(a), "INSUFFICIENT_BALANCE");
  });
  it("G3: actionTransfer token not held ⇒ INSUFFICIENT_BALANCE", () => {
    expectDeny(ev({ kind: "actionTransfer", asset: "0x9999999999999999999999999999999999999999", to: CP, amount: 1n }), "INSUFFICIENT_BALANCE");
  });
});

describe("wallet inference / isolation", () => {
  it("treasury kinds never read action-wallet balances (allowance with empty treasury USDG, rich action wallet)", () => {
    const s = mkState();
    s.treasury.rh = { ...s.treasury.rh, USDG: 0n };
    s.action.rh = { ...s.action.rh, USDG: 1_000_000n * E6 };
    expectDeny(ev({ kind: "allowance", amount: E6 }, { state: s }), "INSUFFICIENT_BALANCE");
  });
  it("action kinds never read treasury balances (actionTransfer ETH with empty action native, rich treasury)", () => {
    const s = mkState();
    s.action.rh = { ...s.action.rh, native: 0n };
    s.treasury.rh = { ...s.treasury.rh, native: 1000n * E18 };
    expectDeny(ev({ kind: "actionTransfer", asset: "ETH", to: CP, amount: 1n }, { state: s }), "INSUFFICIENT_BALANCE");
  });
  it("treasurySwap: token held only by the action wallet ⇒ INSUFFICIENT_BALANCE", () => {
    const s = mkState();
    s.treasury.rh = { ...s.treasury.rh, tokens: {} };
    expectDeny(ev(VALID.treasurySwap, { state: s }), "INSUFFICIENT_BALANCE");
  });
});

describe("approval binding", () => {
  it("allow carries actionHash(action), issuedAt = now, ttlSec = 60", () => {
    for (const a of Object.values(VALID)) {
      const v = ev(a);
      if (!v.allow) throw new Error(`${a.kind} denied: ${v.detail}`);
      expect(v.approval.actionHash).toBe(actionHash(a));
      expect(v.approval.issuedAt).toBe(NOW);
      expect(v.approval.ttlSec).toBe(60);
    }
  });
  it("checksummed vs lowercase address inputs yield the same approval hash", () => {
    const lowerA: ProposedAction = { kind: "actionTransfer", asset: "ETH", to: CP, amount: E18 / 10n };
    const checksummed: ProposedAction = { ...lowerA, to: getAddress(CP) };
    const v1 = ev(lowerA);
    const v2 = ev(checksummed);
    if (!v1.allow || !v2.allow) throw new Error("expected allows");
    expect(v1.approval.actionHash).toBe(v2.approval.actionHash);
  });
});

describe("determinism (INV6 smoke)", () => {
  it("same inputs ⇒ identical verdicts, including on structuredClone'd inputs", () => {
    const s = mkState();
    const L = mkLedger();
    const probes: ProposedAction[] = [
      ...Object.values(VALID),
      { kind: "allowance", amount: 10_000n * E6 },
      { kind: "actionTransfer", asset: "USDG", to: TREASURY, amount: E6 },
    ];
    for (const a of probes) {
      const v1 = evaluate(a, s, L, cfg, NOW);
      const v2 = evaluate(a, s, L, cfg, NOW);
      const v3 = evaluate(structuredClone(a), structuredClone(s), structuredClone(L), structuredClone(cfg), NOW);
      expect(v2).toEqual(v1);
      expect(v3).toEqual(v1);
    }
  });
  it("evaluate does not mutate its inputs", () => {
    const s = mkState();
    const L = mkLedger({ dayKey: "2000-01-01", treasurySpent: { oysterRental: 5n } });
    const sBefore = structuredClone(s);
    const LBefore = structuredClone(L);
    for (const a of Object.values(VALID)) evaluate(a, s, L, cfg, NOW);
    expect(s).toEqual(sBefore);
    expect(L).toEqual(LBefore);
  });
});

describe("G4: stale ledger dayKey ⇒ empty daily buckets, forward only (engine view)", () => {
  it("T3: yesterday's maxed oysterRental bucket does not block today", () => {
    const a: ProposedAction = { kind: "treasuryTransfer", purpose: "oysterRental", chain: "arbitrum", asset: "USDC", to: MARLIN_PAY, amount: 100n * E6 };
    expectDeny(ev(a, { ledger: mkLedger({ treasurySpent: { oysterRental: 1n } }) }), "DAILY_CAP");
    expectAllow(ev(a, { ledger: mkLedger({ dayKey: "2026-09-22", treasurySpent: { oysterRental: 100n * E6 } }) }));
  });
  it("G4: ledger with a dayKey from a later day (clock rewound) is treated as current-day — buckets kept", () => {
    const a: ProposedAction = { kind: "treasuryTransfer", purpose: "oysterRental", chain: "arbitrum", asset: "USDC", to: MARLIN_PAY, amount: 1n };
    expectDeny(ev(a, { ledger: mkLedger({ dayKey: "2026-09-24", treasurySpent: { oysterRental: 100n * E6 } }) }), "DAILY_CAP");
  });
  it("G4: cap-exhausted purpose stays exhausted when now goes back a day; forward roll still resets", () => {
    const a: ProposedAction = { kind: "treasuryTransfer", purpose: "oysterRental", chain: "arbitrum", asset: "USDC", to: MARLIN_PAY, amount: E6 };
    const L = mkLedger({ treasurySpent: { oysterRental: 100n * E6 } }); // dayKey = 2026-09-23, cap exhausted
    expectDeny(ev(a, { ledger: L, now: NOW }), "DAILY_CAP");
    const back = NOW - DAY;
    expectDeny(ev(a, { ledger: L, now: back, state: { ...mkState(), hostingPaidUntil: back + 30n * DAY } }), "DAILY_CAP");
    const back30 = NOW - 30n * DAY;
    expectDeny(ev(a, { ledger: L, now: back30, state: { ...mkState(), hostingPaidUntil: back30 + 30n * DAY } }), "DAILY_CAP");
    const fwd = NOW + DAY;
    expectAllow(ev(a, { ledger: L, now: fwd, state: { ...mkState(), hostingPaidUntil: fwd + 30n * DAY } }));
  });
  it("G4: exhausted inference category stays exhausted when now goes back a day", () => {
    const a: ProposedAction = { kind: "inference", category: "pulse", endpointId: "inf-cheap", maxCostUsd: 1n };
    const L = mkLedger({ inferenceSpent: { pulse: 15n * E6, chat: 0n, social: 0n } });
    const back = NOW - DAY;
    expectDeny(ev(a, { ledger: L, now: back, state: { ...mkState(), hostingPaidUntil: back + 30n * DAY } }), "INFERENCE_BUDGET");
  });
  it("the next UTC day starts exactly at 00:00:00", () => {
    const a: ProposedAction = { kind: "treasuryTransfer", purpose: "oysterRental", chain: "arbitrum", asset: "USDC", to: MARLIN_PAY, amount: E6 };
    const L = mkLedger({ treasurySpent: { oysterRental: 100n * E6 } }); // dayKey = 2026-09-23
    const midnight = NOW - 43_200n + DAY;
    expectDeny(ev(a, { ledger: L, now: midnight - 1n }), "DAILY_CAP");
    expectAllow(ev(a, { ledger: L, now: midnight, state: { ...mkState(), hostingPaidUntil: midnight + 30n * DAY } }));
  });
});

describe("§6 hygiene: src/policy, src/ledger and src/exec (SPEC-M2B §10)", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  }
  /** Strip // line comments and /* block *\/ comments so prose like "no Date.now" in comments does not trip the check. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  }
  const files = [...walk(join(SRC, "policy")), ...walk(join(SRC, "ledger")), ...walk(join(SRC, "exec")), ...walk(join(SRC, "daemon")), ...walk(join(SRC, "llm")), ...walk(join(SRC, "pulse"))];

  it("covers the expected files", () => {
    const rel = files.map((f) => f.slice(SRC.length + 1)).sort();
    for (const must of ["policy/engine.ts", "policy/runway.ts", "policy/rules/treasury.ts", "policy/rules/action.ts", "policy/rules/inference.ts", "policy/rules/social.ts", "ledger/ledger.ts", "exec/abi.ts", "exec/build.ts", "exec/chain.ts", "exec/execute.ts", "llm/types.ts", "llm/endpoints.ts", "llm/canaries.ts", "llm/checks.ts", "llm/mock.ts", "pulse/tier.ts", "pulse/context.ts", "pulse/tools.ts", "pulse/pulse.ts", "pulse/scheduler.ts"]) {
      expect(rel).toContain(must);
    }
  });

  it("no Date.now / Math.random / fetch( / process.env / crypto randomness anywhere in src/ (explicit allowlist)", () => {
    // SPEC-M2C §3/§1: the ONLY exceptions — src/clock.ts may read Date.now (systemClock);
    // src/chat/nonce.ts may use node:crypto randomBytes. Every other ban still applies to them.
    const bans: Array<[string, RegExp]> = [
      ["Date.now", /Date\.now/],
      ["Math.random", /Math\.random/],
      ["fetch(", /fetch\(/],
      ["process.env", /process\.env/],
      ["randomBytes", /randomBytes|randomUUID|getRandomValues/],
    ];
    const allow: Record<string, readonly string[]> = { "clock.ts": ["Date.now"], "chat/nonce.ts": ["randomBytes"] };
    const hits: string[] = [];
    for (const f of walk(SRC)) {
      const rel = f.slice(SRC.length + 1);
      const code = stripComments(readFileSync(f, "utf8"));
      for (const [name, re] of bans) if (re.test(code) && !(allow[rel] ?? []).includes(name)) hits.push(`${rel}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it("no network/fs/time imports", () => {
    const bad = /from\s+["'](node:)?(http|https|net|dgram|tls|fs|child_process|worker_threads)["']|new Date\(/;
    const hits = files.filter((f) => bad.test(stripComments(readFileSync(f, "utf8"))));
    expect(hits).toEqual([]);
  });

  it("src/chat (SPEC-M2C §1): no `any`, no new Date(, no fs/net imports; node:http ONLY in chat/server.ts (listen wrapper)", () => {
    const chat = walk(join(SRC, "chat"));
    expect(chat.map((f) => f.slice(SRC.length + 1))).toContain("chat/nonce.ts");
    const hits: string[] = [];
    for (const f of chat) {
      const rel = f.slice(SRC.length + 1);
      const code = stripComments(readFileSync(f, "utf8"));
      if (/(:\s*any\b|\bas\s+any\b|<any>|any\[\])/.test(code)) hits.push(`${rel}: any`);
      if (/new Date\(|parseFloat|toFixed\(/.test(code)) hits.push(`${rel}: time/float`);
      if (/from\s+["'](node:)?(https|net|dgram|tls|fs|child_process|worker_threads)["']/.test(code)) hits.push(`${rel}: import`);
      if (/from\s+["'](node:)?http["']/.test(code) && rel !== "chat/server.ts") hits.push(`${rel}: http`);
    }
    expect(hits).toEqual([]);
  });

  it("no `any` type in src/policy, src/ledger or src/exec", () => {
    const bad = /(:\s*any\b|\bas\s+any\b|<any>|any\[\])/;
    const hits = files.filter((f) => bad.test(stripComments(readFileSync(f, "utf8"))));
    expect(hits).toEqual([]);
  });

  it("no floating point on money: no parseFloat / toFixed / Number division in code", () => {
    const bad = /parseFloat|toFixed\(|Math\.(floor|round|ceil)\(/;
    const hits = files.filter((f) => bad.test(stripComments(readFileSync(f, "utf8"))));
    expect(hits).toEqual([]);
  });
});

// Keep ACTION referenced for readers: own action EOA is a valid gasTopUp destination.
void ACTION;
