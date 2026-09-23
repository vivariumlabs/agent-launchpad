// Shared pulse harness (not a test file). Mirrors test/exec/execute.test.ts's ExecDeps
// harness, plus memory (":memory:"), MockLlm, MockX402Transport and an EndpointManager.

import { decodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { expect } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../src/config/schema.js";
import { buildTx } from "../../src/exec/build.js";
import { MockChainClient, type MockChainClientOptions, type SentTx } from "../../src/exec/chain.js";
import { execute, type ExecDeps, type ExecExtras, type ExecResult } from "../../src/exec/execute.js";
import { createKeyring, type Keyring } from "../../src/keyring/keyring.js";
import { MockKms } from "../../src/keyring/mockKms.js";
import { ARITH_EXPECTED, ARITH_PROMPT, CANARY_SYSTEM } from "../../src/llm/canaries.js";
import { EndpointManager } from "../../src/llm/endpoints.js";
import { MockLlm, MockX402Transport, type MockLlmItem } from "../../src/llm/mock.js";
import type { LlmRequest, LlmResponse } from "../../src/llm/types.js";
import { listActions, openMemory, type MemoryDb } from "../../src/memory/db.js";
import { lookalikeOf, protectedAddresses } from "../../src/policy/rules/action.js";
import type { BudgetLedger, ProposedAction, WalletState } from "../../src/policy/types.js";
import { memoryExecDeps, runPulse, type PulseDeps, type PulseResult } from "../../src/pulse/pulse.js";
import { DAY, E6, NOW, PAYTO_INF_CHEAP, PAYTO_INF_STD, agentJson, mkLedger, mkState, platformJson } from "../policy/helpers.js";

export const EP_A = "ep-a"; // primary (model m-main), standard tier
export const EP_B = "ep-b"; // fallback (model m-alt), cheap tier
export const PRICE_A = 2_000_000n; // 2 USD / MTok
export const PRICE_B = 1_000_000n; // 1 USD / MTok

const FAST_RETRY = { retry: { attempts: 3, delayMs: 1 } };
const ERC20 = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const TRANSFER_SELECTOR = "0xa9059cbb";
const APPROVE_SELECTOR = "0x095ea7b3";

export interface HarnessOpts {
  ledger?: BudgetLedger;
  state?: WalletState;
  postsPerDay?: number;
  repliesPerDay?: number;
  caps?: Record<string, unknown>;
  /** Quoted prices (default = the allowlist ceilings). */
  priceA?: bigint;
  priceB?: bigint;
  /** Allowlist maxPricePerMTokUsd (default PRICE_A / PRICE_B). */
  ceilingA?: bigint;
  ceilingB?: bigint;
  attestedB?: boolean;
  chain?: MockChainClientOptions;
}

export interface PulseHarness {
  cfg: ResolvedConfig;
  kr: Keyring;
  treasury: Address;
  action: Address;
  chain: MockChainClient;
  db: MemoryDb;
  llm: MockLlm;
  x402: MockX402Transport;
  endpoints: EndpointManager;
  exec: ExecDeps;
  state: WalletState;
  /** Every ExecResult produced (pulse + direct), in order. */
  allResults: ExecResult[];
  pulses: PulseResult[];
  /** endpointId → canary behavior (default "pass"). */
  canary: Map<string, "pass" | "fail">;
  now(): bigint;
  setNow(t: bigint): void;
  advance(sec: bigint): void;
  ledger(): BudgetLedger;
  /** Queue pulse (non-canary) LLM responses. */
  script(...items: MockLlmItem[]): void;
  pulse(extra?: Partial<PulseDeps>): Promise<PulseResult>;
  /** Direct execute through the memory-logged deps (e.g. daemon-style ops). */
  exec1(action: ProposedAction, extras?: ExecExtras): Promise<ExecResult>;
}

/** A "perfect model" canary answer for a canary request (tests only). */
export function canaryAnswer(req: LlmRequest): string {
  const p = req.messages[0]?.content ?? "";
  if (p === ARITH_PROMPT) return ARITH_EXPECTED;
  const json = "Reply with only this JSON object, unchanged: ";
  if (p.startsWith(json)) return p.slice(json.length);
  const exact = "Reply with exactly: ";
  if (p.startsWith(exact)) return p.slice(exact.length);
  return "?";
}

export const DEFAULT_PULSE_RESPONSE = JSON.stringify({ diary: "(no script)" });

export async function makeHarness(opts: HarnessOpts = {}): Promise<PulseHarness> {
  const kr = await createKeyring(new MockKms("image-pulse", "agent-pulse"), FAST_RETRY);
  const platform = platformJson(opts.caps ?? {});
  platform["x402Allowlist"] = [
    { id: EP_A, kind: "inference", operator: "op-a", url: "https://a", payTo: PAYTO_INF_STD, model: "m-main", tier: "standard", maxPricePerMTokUsd: (opts.ceilingA ?? PRICE_A).toString(), attested: false },
    { id: EP_B, kind: "inference", operator: "op-b", url: "https://b", payTo: PAYTO_INF_CHEAP, model: "m-alt", tier: "cheap", maxPricePerMTokUsd: (opts.ceilingB ?? PRICE_B).toString(), attested: opts.attestedB ?? false },
    { id: "data-1", kind: "data", operator: "op", url: "https://c", payTo: "0xee000003000000000000000000000000000000e3", model: "search", tier: "cheap", maxPricePerMTokUsd: "1000000", attested: false },
  ];
  const cfg = resolveConfig({
    platform,
    agent: {
      ...agentJson,
      models: { primary: "m-main", fallbacks: ["m-alt"], chatTier: "cheap" },
      social: { postsPerDay: opts.postsPerDay ?? 3, repliesPerDay: opts.repliesPerDay ?? 3 },
    },
    ownAddresses: kr.addresses(),
  });
  kr.attachConfig(cfg);
  const chain = new MockChainClient(opts.chain);
  const db = openMemory(":memory:");
  let L = opts.ledger ?? mkLedger({ allowanceAmountToday: 100n * E6, lastAllowanceAt: NOW - 3_600n });
  let now = NOW;
  const state = opts.state ?? mkState();
  const allResults: ExecResult[] = [];
  const pulses: PulseResult[] = [];
  const canary = new Map<string, "pass" | "fail">();
  const queue: MockLlmItem[] = [];

  const llm = new MockLlm((req: LlmRequest): string | LlmResponse | Error => {
    if (req.system === CANARY_SYSTEM) {
      // Self-reported identity in a failing answer is irrelevant: only the string is scored.
      return canary.get(req.endpointId) === "fail" ? `I am ${req.model}, the best model. Answer: 42` : canaryAnswer(req);
    }
    const next = queue.shift();
    if (next === undefined) return DEFAULT_PULSE_RESPONSE;
    return typeof next === "function" ? next(req) : next;
  });
  const x402 = new MockX402Transport([
    { id: EP_A, payTo: PAYTO_INF_STD, price: opts.priceA ?? opts.ceilingA ?? PRICE_A },
    { id: EP_B, payTo: PAYTO_INF_CHEAP, price: opts.priceB ?? opts.ceilingB ?? PRICE_B },
  ]);
  const endpoints = new EndpointManager(cfg);

  const exec: ExecDeps = {
    cfg,
    keyring: kr,
    chain,
    getState: () => state,
    ledger: { get: () => L, set: (l) => (L = l) },
    clock: () => now,
    log: (r) => {
      allResults.push(r);
    },
  };

  const h: PulseHarness = {
    cfg,
    kr,
    treasury: kr.addresses().treasury,
    action: kr.addresses().action,
    chain,
    db,
    llm,
    x402,
    endpoints,
    exec,
    state,
    allResults,
    pulses,
    canary,
    now: () => now,
    setNow: (t) => (now = t),
    advance: (sec) => (now = now + sec),
    ledger: () => L,
    script: (...items) => queue.push(...items),
    async pulse(extra = {}) {
      const r = await runPulse({ exec, db, llm, x402, endpoints, ...extra });
      pulses.push(r);
      return r;
    },
    exec1: (action, extras) => execute(action, memoryExecDeps(exec, db), extras),
  };
  return h;
}

/** JSON pulse response with the given tool calls. */
export function respond(toolCalls: Array<{ tool: string; args: Record<string, unknown> }>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ toolCalls, ...extra });
}

// ---------------------------------------------------------------------------
// decoding the MockChainClient send log
// ---------------------------------------------------------------------------

export interface Receipt {
  tx: SentTx;
  /** "ETH" or the ERC-20 token address (lowercase). */
  asset: string;
  recipient: string; // lowercase
  amount: bigint;
  via: "transfer" | "eth" | "mint" | "approve" | "swap";
}

/** Decodes an action/treasury tx into who receives what (approve: recipient = spender, amount = allowance). */
export function decodeSent(tx: SentTx, cfg: ResolvedConfig): Receipt {
  const to = (tx.to ?? "0x").toLowerCase();
  const sel = tx.data.slice(0, 10).toLowerCase();
  if (sel === TRANSFER_SELECTOR) {
    const d = decodeFunctionData({ abi: ERC20, data: tx.data });
    const [rcpt, amt] = d.args as readonly [Address, bigint];
    return { tx, asset: to, recipient: rcpt.toLowerCase(), amount: amt, via: "transfer" };
  }
  if (sel === APPROVE_SELECTOR) {
    const d = decodeFunctionData({ abi: ERC20, data: tx.data });
    const [spender, amt] = d.args as readonly [Address, bigint];
    return { tx, asset: to, recipient: spender.toLowerCase(), amount: amt, via: "approve" };
  }
  if (to === cfg.swapRouter.rh.toLowerCase()) return { tx, asset: "ETH", recipient: to, amount: tx.value, via: "swap" };
  if (tx.data === "0x1249c58b") return { tx, asset: "ETH", recipient: to, amount: tx.value, via: "mint" };
  return { tx, asset: "ETH", recipient: to, amount: tx.value, via: "eth" };
}

// ---------------------------------------------------------------------------
// §8 standing invariants
// ---------------------------------------------------------------------------

export interface StandingOpts {
  /** Treasury-EOA tx hashes sanctioned by the scenario (daemon ops). Heartbeats are always sanctioned. */
  sanctionedTreasuryTx?: ReadonlySet<Hex>;
}

export function assertStanding(h: PulseHarness, opts: StandingOpts = {}): void {
  const cfg = h.cfg;
  const sanctioned = opts.sanctionedTreasuryTx ?? new Set<Hex>();

  // (1) No treasury outflow: every treasury-EOA tx is an exact zero-value heartbeat or scenario-sanctioned.
  const hb = buildTx({ kind: "heartbeat" }, cfg, 0n);
  for (const t of h.chain.sentFrom(h.treasury)) {
    if (sanctioned.has(t.hash)) continue;
    expect(t.to?.toLowerCase(), `unsanctioned treasury tx ${t.hash}`).toBe(hb.to.toLowerCase());
    expect(t.value).toBe(0n);
    expect(t.data).toBe(hb.data);
  }
  // Every tx was sent by one of our two EOAs.
  for (const t of h.chain.sent) {
    expect([h.treasury.toLowerCase(), h.action.toLowerCase()]).toContain(t.from.toLowerCase());
  }

  // (1b) Treasury/whitelist untouched by the action wallet: no receipt to a protected address
  // or a 4-byte look-alike; every approve's spender is the configured router (AP1).
  const prot = protectedAddresses(cfg);
  for (const t of h.chain.sentFrom(h.action)) {
    const r = decodeSent(t, cfg);
    if (r.via === "approve") {
      expect(r.recipient).toBe(cfg.swapRouter.rh.toLowerCase());
      continue;
    }
    if (r.via === "swap") continue;
    expect(prot, `action tx ${t.hash} pays a protected address`).not.toContain(r.recipient);
    expect(lookalikeOf(r.recipient, prot), `action tx ${t.hash} pays a look-alike`).toBeNull();
  }

  // (1c) x402 auths (the only inference "outflow"): from treasury, to an allowlisted inference payTo, ≤ maxPerCallUsd.
  const infPayTo = cfg.x402Allowlist.filter((e) => e.kind === "inference").map((e) => e.payTo.toLowerCase());
  for (const p of h.x402.paid) {
    expect(p.auth.authorization.from.toLowerCase()).toBe(h.treasury.toLowerCase());
    expect(infPayTo).toContain(p.auth.authorization.to.toLowerCase());
    expect(p.auth.authorization.value <= cfg.maxPerCallUsd).toBe(true);
  }
  const paidInference = h.allResults.filter((r) => r.action.kind === "inference" && r.verdict.allow && r.x402 !== undefined);
  expect(h.x402.paid).toHaveLength(paidInference.length);

  // (2) Pulse loop completed without throwing / internal errors.
  for (const p of h.pulses) expect(p.errors).toEqual([]);

  // (3) Every deny recorded in `actions` (same multiset of (kind, code)).
  const denies = h.allResults.filter((r) => !r.verdict.allow).map((r) => `${r.action.kind}:${r.verdict.allow ? "" : r.verdict.code}`).sort();
  const rows = listActions(h.db)
    .filter((r) => r.verdict === "deny")
    .map((r) => `${r.kind}:${r.denyCode ?? "(none)"}`)
    .sort();
  expect(rows).toEqual(denies);
  // …and every ExecResult (allow and deny) is in the table.
  expect(listActions(h.db).filter((r) => r.verdict === "allow" || r.verdict === "deny")).toHaveLength(h.allResults.length);
}

export { DAY };
