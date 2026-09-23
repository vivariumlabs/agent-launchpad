// SPEC-M2B §3 execute() semantics + composite swaps + MockChainClient send log.

import { decodeFunctionData, getAddress, keccak256, parseAbi, stringToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/schema.js";
import { MockChainClient, type MockChainClientOptions } from "../../src/exec/chain.js";
import { NotImplementedError } from "../../src/exec/build.js";
import {
  execute,
  swapExactIn,
  treasurySwapExactIn,
  type ExecDeps,
  type ExecResult,
} from "../../src/exec/execute.js";
import { ed25519Verify } from "../../src/keyring/ed25519.js";
import { createKeyring, x402Nonce, type Keyring } from "../../src/keyring/keyring.js";
import { MockKms } from "../../src/keyring/mockKms.js";
import type { BudgetLedger, ProposedAction, WalletState } from "../../src/policy/types.js";
import { CP, E18, E6, NOW, PAYTO_INF_CHEAP, SWAP_ROUTER, TOKEN_X, TOKEN_Y, USDG_RH, agentJson, mkLedger, mkState, platformJson } from "../policy/helpers.js";

const FAST_RETRY = { retry: { attempts: 3, delayMs: 1 } };
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function approve(address spender, uint256 amount) returns (bool)"]);

interface Harness {
  deps: ExecDeps;
  chain: MockChainClient;
  kr: Keyring;
  logs: ExecResult[];
  ledger(): BudgetLedger;
  events: string[];
  setNow(t: bigint): void;
  published: Array<{ bytes: Uint8Array; sig: Hex }>;
  journal: Uint8Array[];
}

class OrderedMockChain extends MockChainClient {
  onSend: (() => void) | undefined;
  override async sendRaw(chain: Parameters<MockChainClient["sendRaw"]>[0], signedTx: Hex) {
    this.onSend?.();
    return super.sendRaw(chain, signedTx);
  }
}

async function harness(opts: { chain?: MockChainClientOptions; state?: WalletState; ledger?: BudgetLedger } = {}): Promise<Harness> {
  const kr = await createKeyring(new MockKms("image-a", "agent-exec"), FAST_RETRY);
  const cfg = resolveConfig({
    platform: platformJson(),
    agent: { ...agentJson, social: { postsPerDay: 2, repliesPerDay: 2 } },
    ownAddresses: kr.addresses(),
  });
  kr.attachConfig(cfg);
  const chain = new OrderedMockChain(opts.chain);
  const events: string[] = [];
  chain.onSend = () => events.push("send");
  let L = opts.ledger ?? mkLedger();
  let now = NOW;
  const logs: ExecResult[] = [];
  const published: Array<{ bytes: Uint8Array; sig: Hex }> = [];
  const journal: Uint8Array[] = [];
  const state = opts.state ?? mkState();
  const deps: ExecDeps = {
    cfg,
    keyring: kr,
    chain,
    getState: () => state,
    ledger: {
      get: () => L,
      set: (l) => {
        events.push("ledger");
        L = l;
      },
    },
    clock: () => now,
    log: (r) => {
      logs.push(r);
    },
    castSink: {
      publish: async (_a, bytes, sig) => {
        published.push({ bytes, sig });
      },
    },
    journalSink: {
      write: async (_a, bytes) => {
        journal.push(bytes);
        return `journal-${journal.length}`;
      },
    },
  };
  return { deps, chain, kr, logs, ledger: () => L, events, setNow: (t) => (now = t), published, journal };
}

// ---------------------------------------------------------------------------
// deny path
// ---------------------------------------------------------------------------

describe("execute: deny short-circuits", () => {
  it("deny ⇒ no ledger change, no chain calls, recorded + logged", async () => {
    const h = await harness();
    const before = h.ledger();
    const a: ProposedAction = { kind: "actionTransfer", asset: "USDG", to: h.deps.cfg.treasury, amount: E6 };
    const r = await execute(a, h.deps);
    expect(r.verdict.allow).toBe(false);
    if (!r.verdict.allow) expect(r.verdict.code).toBe("LOOKALIKE");
    expect(r.txHash).toBeUndefined();
    expect(h.ledger()).toBe(before);
    expect(h.chain.sent).toEqual([]);
    expect(h.chain.estimates).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.logs).toEqual([r]);
  });
  it("malformed action ⇒ MALFORMED deny, logged, nothing sent", async () => {
    const h = await harness();
    const r = await execute({ kind: "allowance", amount: 0n }, h.deps);
    expect(r.verdict.allow).toBe(false);
    expect(h.chain.sent).toHaveLength(0);
    expect(h.logs).toHaveLength(1);
  });
  it("actionLp ⇒ NotImplementedError (before evaluation; nothing logged or sent)", async () => {
    const h = await harness();
    const lp: ProposedAction = { kind: "actionLp", pool: `0x${"ab".repeat(32)}`, usdgAmount: E6, tokenAmount: E18, token: TOKEN_X };
    await expect(execute(lp, h.deps)).rejects.toThrow(NotImplementedError);
    expect(h.chain.sent).toHaveLength(0);
    expect(h.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tx path
// ---------------------------------------------------------------------------

describe("execute: tx kinds", () => {
  it("allowance: ledger advanced BEFORE send; tx from treasury to USDG.rh transfer(actionEOA)", async () => {
    const h = await harness();
    const r = await execute({ kind: "allowance", amount: 100n * E6 }, h.deps);
    expect(r.verdict.allow).toBe(true);
    expect(r.error).toBeUndefined();
    expect(h.events).toEqual(["ledger", "send"]);
    expect(h.ledger().lastAllowanceAt).toBe(NOW);
    expect(h.ledger().allowanceAmountToday).toBe(100n * E6);
    expect(h.chain.sent).toHaveLength(1);
    const s = h.chain.sent[0]!;
    expect(r.txHash).toBe(s.hash);
    expect(s.hash).toBe(keccak256(s.raw));
    expect(s.from).toBe(h.kr.addresses().treasury);
    expect(s.to?.toLowerCase()).toBe(USDG_RH.toLowerCase());
    expect(s.chain).toBe("rh");
    expect(s.chainId).toBe(46630);
    expect(s.outcome).toBe("success");
    expect(decodeFunctionData({ abi: ERC20, data: s.data }).args).toEqual([h.kr.addresses().action, 100n * E6]);
    expect(h.logs).toEqual([r]);
  });
  it("uses chain nonce + fill; nonce advances per mined tx", async () => {
    const t = (await harness()).kr.addresses().treasury; // deterministic MockKms ⇒ same EOA in h2
    const h2 = await harness({ chain: { nonces: { [`rh:${t}`]: 5 }, fill: { gasLimit: 123_456n, maxFeePerGas: 900_000_000n, maxPriorityFeePerGas: 1n } } });
    await execute({ kind: "heartbeat" }, h2.deps);
    h2.setNow(NOW + 1n);
    await execute({ kind: "heartbeat" }, h2.deps);
    expect(h2.chain.sent.map((s) => s.nonce)).toEqual([5, 6]);
    expect(h2.chain.sent[0]!.gasLimit).toBe(123_456n);
    expect(h2.chain.sent[0]!.maxFeePerGas).toBe(900_000_000n);
    expect(h2.chain.estimates[0]!.from).toBe(t);
  });
  it("failed send (dropped) still consumes the budget; retry re-evaluates and is denied", async () => {
    const h = await harness({ chain: { outcomes: [new Error("node dropped tx")] } });
    const r = await execute({ kind: "allowance", amount: 100n * E6 }, h.deps);
    expect(r.verdict.allow).toBe(true);
    expect(r.error).toBe("node dropped tx");
    expect(r.txHash).toBeUndefined();
    expect(h.ledger().lastAllowanceAt).toBe(NOW);
    expect(h.chain.sent[0]!.outcome).toBe("error");
    h.setNow(NOW + 5n);
    const retry = await execute({ kind: "allowance", amount: 100n * E6 }, h.deps);
    expect(retry.verdict.allow).toBe(false);
    if (!retry.verdict.allow) expect(retry.verdict.code).toBe("ALLOWANCE_EARLY");
    expect(h.logs).toHaveLength(2);
  });
  it("reverted tx ⇒ error + txHash recorded, budget consumed", async () => {
    const h = await harness({ chain: { outcomes: ["reverted"] } });
    const a: ProposedAction = { kind: "actionTransfer", asset: "ETH", to: CP, amount: E18 / 10n };
    const r = await execute(a, h.deps, {});
    expect(r.verdict.allow).toBe(true);
    expect(r.error).toMatch(/reverted/);
    expect(r.txHash).toBe(h.chain.sent[0]!.hash);
    expect(h.ledger().counterpartySpent[CP.toLowerCase() as `0x${string}`]?.["ETH"]).toBe(E18 / 10n);
  });
  it("chain-supplied fill outside K2 bounds ⇒ error, nothing sent, budget still consumed", async () => {
    const h = await harness({ chain: { fill: { gasLimit: 100_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n } } });
    const r = await execute({ kind: "allowance", amount: 10n * E6 }, h.deps);
    expect(r.error).toMatch(/cap/);
    expect(h.chain.sent).toHaveLength(0);
    expect(h.ledger().allowanceAmountToday).toBe(10n * E6);
  });
  it("K1 through the executor: re-signing the returned approval throws (replay)", async () => {
    const h = await harness();
    const a: ProposedAction = { kind: "heartbeat" };
    const r = await execute(a, h.deps);
    if (!r.verdict.allow) throw new Error("expected allow");
    await expect(
      h.kr.signTxApproved(a, r.verdict.approval, { nonce: 9, gasLimit: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }, NOW),
    ).rejects.toThrow("approval already used");
    expect(h.chain.sent).toHaveLength(1);
  });
  it("action-wallet kinds are sent from the action EOA; treasury kinds from the treasury EOA", async () => {
    const h = await harness();
    await execute({ kind: "actionMint", target: CP, value: E18 / 100n }, h.deps);
    await execute({ kind: "distribute" }, h.deps);
    expect(h.chain.sent[0]!.from).toBe(h.kr.addresses().action);
    expect(h.chain.sent[0]!.data).toBe("0x1249c58b");
    expect(h.chain.sent[0]!.value).toBe(E18 / 100n);
    expect(h.chain.sent[1]!.from).toBe(h.kr.addresses().treasury);
    expect(h.chain.sent[1]!.to?.toLowerCase()).toBe(h.deps.cfg.feeSplitHook.rh.toLowerCase());
    expect(h.chain.sentFrom(h.kr.addresses().treasury)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// composite swaps
// ---------------------------------------------------------------------------

describe("composite swapExactIn / treasurySwapExactIn", () => {
  it("swapExactIn: approve(router, amountIn) then swap, both from the action EOA, each its own approval", async () => {
    const h = await harness();
    const rs = await swapExactIn({ tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: 50n * E18, minOut: 1n }, h.deps);
    expect(rs.map((r) => r.action.kind)).toEqual(["actionApprove", "actionSwap"]);
    expect(rs.every((r) => r.verdict.allow && r.error === undefined)).toBe(true);
    const [ap, sw] = rs;
    if (!ap!.verdict.allow || !sw!.verdict.allow) throw new Error("allows expected");
    expect(ap!.verdict.approval.actionHash).not.toBe(sw!.verdict.approval.actionHash);
    expect(h.chain.sent).toHaveLength(2);
    const [s1, s2] = h.chain.sent;
    expect(s1!.from).toBe(h.kr.addresses().action);
    expect(s1!.to?.toLowerCase()).toBe(TOKEN_X.toLowerCase());
    expect(decodeFunctionData({ abi: ERC20, data: s1!.data }).args).toEqual([getAddress(SWAP_ROUTER), 50n * E18]);
    expect(s2!.to?.toLowerCase()).toBe(SWAP_ROUTER.toLowerCase());
    expect(s2!.nonce).toBe(s1!.nonce + 1);
    expect(h.logs).toHaveLength(2);
  });
  it("swapExactIn with USDG in approves the USDG token address", async () => {
    const h = await harness();
    const rs = await swapExactIn({ tokenIn: "USDG", tokenOut: TOKEN_X, amountIn: 10n * E6, minOut: 0n }, h.deps);
    expect(rs).toHaveLength(2);
    expect(h.chain.sent[0]!.to?.toLowerCase()).toBe(USDG_RH.toLowerCase());
  });
  it("first-step deny aborts: amountIn > 20% ⇒ actionApprove PER_TX_CAP, no swap attempted, nothing sent", async () => {
    const h = await harness();
    const rs = await swapExactIn({ tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: 101n * E18, minOut: 0n }, h.deps);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.verdict.allow).toBe(false);
    if (!rs[0]!.verdict.allow) expect(rs[0]!.verdict.code).toBe("PER_TX_CAP");
    expect(h.chain.sent).toHaveLength(0);
    expect(h.logs).toHaveLength(1);
  });
  it("first-step send failure aborts the swap", async () => {
    const h = await harness({ chain: { outcomes: ["reverted"] } });
    const rs = await swapExactIn({ tokenIn: TOKEN_X, tokenOut: "USDG", amountIn: E18, minOut: 0n }, h.deps);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.error).toMatch(/reverted/);
    expect(h.chain.sent).toHaveLength(1);
  });
  it("A4 rev 2 + dry-run: token→token swap intent denied BEFORE the approve — nothing lands on-chain", async () => {
    const h = await harness();
    const rs = await swapExactIn({ tokenIn: TOKEN_X, tokenOut: TOKEN_Y, amountIn: E18, minOut: 0n }, h.deps);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.verdict.allow).toBe(false);
    if (!rs[0]!.verdict.allow) expect(rs[0]!.verdict.detail).toMatch(/USDG leg/);
    expect(h.chain.sent).toHaveLength(0); // no stranded approve
  });
  it("treasurySwapExactIn: treasuryApprove + treasurySwap from the treasury EOA", async () => {
    const h = await harness();
    const rs = await treasurySwapExactIn({ tokenIn: TOKEN_X, amountIn: 1000n * E18, minOut: 5n }, h.deps);
    expect(rs.map((r) => r.action.kind)).toEqual(["treasuryApprove", "treasurySwap"]);
    expect(h.chain.sent.map((s) => s.from)).toEqual([h.kr.addresses().treasury, h.kr.addresses().treasury]);
    expect(h.chain.sent[1]!.to?.toLowerCase()).toBe(SWAP_ROUTER.toLowerCase());
  });
  it("treasurySwapExactIn: token not held ⇒ treasuryApprove deny aborts", async () => {
    const h = await harness();
    const rs = await treasurySwapExactIn({ tokenIn: TOKEN_Y, amountIn: E18, minOut: 5n }, h.deps);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.verdict.allow).toBe(false);
    expect(h.chain.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// inference / cast / journal
// ---------------------------------------------------------------------------

describe("execute: non-tx kinds", () => {
  const INF: ProposedAction = { kind: "inference", category: "pulse", endpointId: "inf-cheap", maxCostUsd: 300_000n };

  it("inference ⇒ K3 auth returned, no tx, inference budget consumed", async () => {
    const h = await harness();
    const hash = (await import("../../src/policy/approval.js")).actionHash(INF);
    const r = await execute(INF, h.deps, {
      x402Auth: { to: PAYTO_INF_CHEAP, value: 250_000n, validAfter: NOW, validBefore: NOW + 600n, nonce: x402Nonce(hash) },
    });
    expect(r.error).toBeUndefined();
    expect(r.x402?.authorization.from).toBe(h.kr.addresses().treasury);
    expect(r.x402?.authorization.value).toBe(250_000n);
    expect(h.chain.sent).toHaveLength(0);
    expect(h.ledger().inferenceSpent.pulse).toBe(300_000n);
  });
  it("inference without x402Auth ⇒ error, budget still consumed", async () => {
    const h = await harness();
    const r = await execute(INF, h.deps);
    expect(r.error).toMatch(/x402Auth/);
    expect(h.ledger().inferenceSpent.pulse).toBe(300_000n);
  });
  it("castPost ⇒ K4 signature (verifies), published, counter incremented; PACE_CAP after postsPerDay", async () => {
    const h = await harness();
    const bytes = stringToBytes("hello world");
    const post: ProposedAction = { kind: "castPost", contentHash: keccak256(bytes) };
    const r1 = await execute(post, h.deps, { messageBytes: bytes });
    expect(r1.castSignature).toBeDefined();
    expect(await ed25519Verify(r1.castSignature!, bytes, h.kr.farcasterPublicKey())).toBe(true);
    expect(h.published).toHaveLength(1);
    h.setNow(NOW + 1n);
    await execute(post, h.deps, { messageBytes: bytes });
    h.setNow(NOW + 2n);
    const r3 = await execute(post, h.deps, { messageBytes: bytes });
    expect(r3.verdict.allow).toBe(false);
    if (!r3.verdict.allow) expect(r3.verdict.code).toBe("PACE_CAP");
    expect(h.ledger().castPostsToday).toBe(2n);
    expect(h.published).toHaveLength(2);
    expect(h.chain.sent).toHaveLength(0);
  });
  it("castReply with mismatched bytes ⇒ K4 error, nothing published, pace slot consumed", async () => {
    const h = await harness();
    const reply: ProposedAction = { kind: "castReply", contentHash: keccak256(stringToBytes("a")), parentHash: `0x${"22".repeat(32)}` };
    const r = await execute(reply, h.deps, { messageBytes: stringToBytes("b") });
    expect(r.error).toMatch(/contentHash/);
    expect(h.published).toHaveLength(0);
    expect(h.ledger().castRepliesToday).toBe(1n);
  });
  it("journalWrite ⇒ journal sink write; hash/size mismatch ⇒ error", async () => {
    const h = await harness();
    const bytes = stringToBytes("dear diary");
    const ok: ProposedAction = { kind: "journalWrite", contentHash: keccak256(bytes), sizeBytes: BigInt(bytes.length) };
    const r = await execute(ok, h.deps, { journalBytes: bytes });
    expect(r.journalRef).toBe("journal-1");
    expect(h.ledger().journalToday).toBe(1n);
    h.setNow(NOW + 1n);
    const badSize: ProposedAction = { kind: "journalWrite", contentHash: keccak256(bytes), sizeBytes: 3n };
    expect((await execute(badSize, h.deps, { journalBytes: bytes })).error).toMatch(/sizeBytes/);
    h.setNow(NOW + 2n);
    expect((await execute(ok, h.deps, { journalBytes: stringToBytes("other") })).error).toMatch(/contentHash/);
    expect(h.journal).toHaveLength(1);
  });
});
