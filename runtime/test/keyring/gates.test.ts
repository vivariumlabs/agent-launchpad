// SPEC-M2B §2 keyring gates K1–K4.

import {
  decodeFunctionData,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  stringToBytes,
  verifyTypedData,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import { resolveConfig, type ResolvedConfig } from "../../src/config/schema.js";
import type { TxFill } from "../../src/exec/chain.js";
import { ed25519Verify } from "../../src/keyring/ed25519.js";
import { createKeyring, x402Nonce, type Keyring, type X402AuthInput } from "../../src/keyring/keyring.js";
import { MockKms } from "../../src/keyring/mockKms.js";
import { issueApproval } from "../../src/policy/approval.js";
import type { ProposedAction } from "../../src/policy/types.js";
import { CP, E18, E6, NOW, PAYTO_DATA, PAYTO_INF_CHEAP, TOKEN_X, agentJson, platformJson } from "../policy/helpers.js";

const FAST_RETRY = { retry: { attempts: 3, delayMs: 1 } };
const GWEI = 1_000_000_000n;
const FILL: TxFill = { nonce: 7, gasLimit: 100_000n, maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI / 10n };

async function setup(agentId = "agent-0001"): Promise<{ kr: Keyring; c: ResolvedConfig }> {
  const kr = await createKeyring(new MockKms("image-a", agentId), FAST_RETRY);
  const c = resolveConfig({ platform: platformJson(), agent: agentJson, ownAddresses: kr.addresses() });
  kr.attachConfig(c);
  return { kr, c };
}

const HB: ProposedAction = { kind: "heartbeat" };

// ---------------------------------------------------------------------------
// config binding
// ---------------------------------------------------------------------------

describe("keyring config binding", () => {
  it("K2/K3 throw before a config is attached", async () => {
    const kr = await createKeyring(new MockKms("image-a", "agent-0001"), FAST_RETRY);
    await expect(kr.signTxApproved(HB, issueApproval(HB, NOW), FILL, NOW)).rejects.toThrow("no config attached");
  });
  it("attachConfig rejects a config whose own addresses differ from the keyring", async () => {
    const kr = await createKeyring(new MockKms("image-a", "agent-0001"), FAST_RETRY);
    const other = await createKeyring(new MockKms("image-a", "agent-0002"), FAST_RETRY);
    const c = resolveConfig({ platform: platformJson(), agent: agentJson, ownAddresses: other.addresses() });
    expect(() => kr.attachConfig(c)).toThrow("do not match");
  });
  it("attachConfig is one-shot", async () => {
    const { kr, c } = await setup();
    expect(() => kr.attachConfig(c)).toThrow("already attached");
  });
});

// ---------------------------------------------------------------------------
// K1 — single-use approvals
// ---------------------------------------------------------------------------

describe("K1: single-use approvals (replay protection)", () => {
  it("K1: same approval twice ⇒ second signTxApproved throws", async () => {
    const { kr } = await setup();
    const ap = issueApproval(HB, NOW);
    await expect(kr.signTxApproved(HB, ap, FILL, NOW)).resolves.toMatch(/^0x02/);
    await expect(kr.signTxApproved(HB, ap, FILL, NOW)).rejects.toThrow("approval already used");
    // A structurally identical copy of the approval is the same approval.
    await expect(kr.signTxApproved(HB, { ...ap }, FILL, NOW + 1n)).rejects.toThrow("approval already used");
  });
  it("K1: fresh approval after re-evaluate (later issuedAt) signs again", async () => {
    const { kr } = await setup();
    await kr.signTxApproved(HB, issueApproval(HB, NOW), FILL, NOW);
    await expect(kr.signTxApproved(HB, issueApproval(HB, NOW + 1n), FILL, NOW + 1n)).resolves.toMatch(/^0x02/);
  });
  it("K1: identical action re-approved in the SAME second is the same (hash, issuedAt) ⇒ rejected", async () => {
    const { kr } = await setup();
    await kr.signTxApproved(HB, issueApproval(HB, NOW), FILL, NOW);
    await expect(kr.signTxApproved(HB, issueApproval(HB, NOW), FILL, NOW)).rejects.toThrow("approval already used");
  });
  it("K1: consumed set is shared across all sign*Approved entry points", async () => {
    const { kr } = await setup();
    const ap = issueApproval(HB, NOW);
    await kr.signApproved(HB, ap, NOW);
    await expect(kr.signTxApproved(HB, ap, FILL, NOW)).rejects.toThrow("approval already used");
  });
  it("K1: session-1 signApproved is now single-use too", async () => {
    const { kr } = await setup();
    const ap = issueApproval(HB, NOW);
    await kr.signApproved(HB, ap, NOW);
    await expect(kr.signApproved(HB, ap, NOW)).rejects.toThrow("approval already used");
  });
  it("K1: hash mismatch / expiry checked BEFORE consumption (a rejected attempt does not burn the approval)", async () => {
    const { kr } = await setup();
    const ap = issueApproval(HB, NOW);
    await expect(kr.signTxApproved({ kind: "distribute" }, ap, FILL, NOW)).rejects.toThrow("approval mismatch");
    await expect(kr.signTxApproved(HB, ap, FILL, NOW)).resolves.toMatch(/^0x02/);
  });
  it("K1: an approval that fails K2 bounds after the K1 check IS consumed (retry must re-evaluate)", async () => {
    const { kr } = await setup();
    const ap = issueApproval(HB, NOW);
    await expect(kr.signTxApproved(HB, ap, { ...FILL, gasLimit: 2_000_001n }, NOW)).rejects.toThrow("maxGasLimit");
    await expect(kr.signTxApproved(HB, ap, FILL, NOW)).rejects.toThrow("approval already used");
  });
  it("K1: after pruning (10×TTL) a replay is still rejected — as expired", async () => {
    const { kr } = await setup();
    const ap = issueApproval(HB, NOW);
    await kr.signTxApproved(HB, ap, FILL, NOW);
    const later = NOW + 601n; // > issuedAt + 10×60 ⇒ entry pruned on this call
    await kr.signTxApproved(HB, issueApproval(HB, later), FILL, later);
    await expect(kr.signTxApproved(HB, ap, FILL, later)).rejects.toThrow("approval expired");
  });
  it("K1: TTL boundary unchanged (issuedAt + 60 ok, + 61 expired)", async () => {
    const { kr } = await setup();
    await expect(kr.signTxApproved(HB, issueApproval(HB, NOW), FILL, NOW + 60n)).resolves.toMatch(/^0x02/);
    await expect(kr.signTxApproved(HB, issueApproval(HB, NOW + 1n), FILL, NOW + 62n)).rejects.toThrow("approval expired");
  });
});

// ---------------------------------------------------------------------------
// K2 — signTxApproved
// ---------------------------------------------------------------------------

describe("K2: signTxApproved", () => {
  it("K2: heartbeat tx is built from config, signed by the treasury key", async () => {
    const { kr, c } = await setup();
    const raw = await kr.signTxApproved(HB, issueApproval(HB, NOW), FILL, NOW);
    const tx = parseTransaction(raw);
    expect(tx.type).toBe("eip1559");
    expect(tx.chainId).toBe(46630);
    expect(tx.to?.toLowerCase()).toBe(c.registry.rh.toLowerCase());
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.nonce).toBe(7);
    expect(tx.gas).toBe(100_000n);
    const d = decodeFunctionData({ abi: parseAbi(["function heartbeat(uint256 agentId)"]), data: tx.data! });
    expect(d.args).toEqual([1n]);
    const from = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
    expect(from).toBe(kr.addresses().treasury);
  });
  it("K2: action-wallet kinds are signed by the action key", async () => {
    const { kr } = await setup();
    const a: ProposedAction = { kind: "actionTransfer", asset: "ETH", to: CP, amount: E18 / 100n };
    const raw = await kr.signTxApproved(a, issueApproval(a, NOW), FILL, NOW);
    expect(await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })).toBe(kr.addresses().action);
  });
  it("K2: doctored fill carrying to/data/value/chainId/type is ignored — the built tx wins", async () => {
    const { kr, c } = await setup();
    const a: ProposedAction = { kind: "allowance", amount: 5n * E6 };
    const doctored = { ...FILL, to: CP, data: "0xdeadbeef", value: 10n ** 18n, chainId: 1, gas: 1n, type: "legacy" } as unknown as TxFill;
    const raw = await kr.signTxApproved(a, issueApproval(a, NOW), doctored, NOW);
    const tx = parseTransaction(raw);
    expect(tx.type).toBe("eip1559");
    expect(tx.to?.toLowerCase()).toBe(c.usdg.rh.toLowerCase());
    expect(tx.chainId).toBe(46630);
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.gas).toBe(FILL.gasLimit);
    const d = decodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount)"]), data: tx.data! });
    expect(d.args).toEqual([kr.addresses().action, 5n * E6]);
  });
  const bounds: Array<[string, Record<string, unknown>, string | null]> = [
    ["gasLimit == maxGasLimit (2_000_000) ok", { gasLimit: 2_000_000n }, null],
    ["gasLimit maxGasLimit + 1", { gasLimit: 2_000_001n }, "maxGasLimit"],
    ["gasLimit 0", { gasLimit: 0n }, "gasLimit"],
    ["gasLimit number", { gasLimit: 100_000 }, "gasLimit"],
    ["maxFeePerGas == rh cap (1 gwei) ok", { maxFeePerGas: GWEI, maxPriorityFeePerGas: 0n }, null],
    ["maxFeePerGas rh cap + 1", { maxFeePerGas: GWEI + 1n }, "cap"],
    ["maxFeePerGas 0", { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }, "maxFeePerGas"],
    ["priority > maxFee", { maxFeePerGas: GWEI / 2n, maxPriorityFeePerGas: GWEI }, "maxPriorityFeePerGas"],
    ["priority negative", { maxPriorityFeePerGas: -1n }, "maxPriorityFeePerGas"],
    ["nonce negative", { nonce: -1 }, "nonce"],
    ["nonce non-integer", { nonce: 1.5 }, "nonce"],
    ["nonce bigint", { nonce: 1n }, "nonce"],
  ];
  for (const [name, over, err] of bounds) {
    it(`K2 bounds: ${name}`, async () => {
      const { kr } = await setup();
      const p = kr.signTxApproved(HB, issueApproval(HB, NOW), { ...FILL, ...over } as unknown as TxFill, NOW);
      if (err === null) await expect(p).resolves.toMatch(/^0x02/);
      else await expect(p).rejects.toThrow(err);
    });
  }
  it("K2 bounds: per-chain maxFeePerGas — 10 gwei OK on base, 10 gwei + 1 throws; 10 gwei throws on rh", async () => {
    const { kr, c } = await setup();
    const onBase: ProposedAction = { kind: "treasuryTransfer", purpose: "x402Data", chain: "base", asset: "USDC", to: PAYTO_DATA, amount: E6 };
    await expect(kr.signTxApproved(onBase, issueApproval(onBase, NOW), { ...FILL, maxFeePerGas: 10n * GWEI }, NOW)).resolves.toMatch(/^0x02/);
    await expect(kr.signTxApproved(onBase, issueApproval(onBase, NOW + 1n), { ...FILL, maxFeePerGas: 10n * GWEI + 1n }, NOW + 1n)).rejects.toThrow("cap");
    await expect(kr.signTxApproved(HB, issueApproval(HB, NOW), { ...FILL, maxFeePerGas: 10n * GWEI }, NOW)).rejects.toThrow("cap");
    expect(c.maxFeePerGasWei).toEqual({ rh: GWEI, base: 10n * GWEI, arbitrum: 10n * GWEI, optimism: 10n * GWEI });
  });
  it("K2: non-tx kinds throw (inference, castPost, journalWrite); actionLp NotImplemented", async () => {
    const { kr } = await setup();
    const inf: ProposedAction = { kind: "inference", category: "pulse", endpointId: "inf-cheap", maxCostUsd: 1000n };
    await expect(kr.signTxApproved(inf, issueApproval(inf, NOW), FILL, NOW)).rejects.toThrow("inference");
    const cp: ProposedAction = { kind: "castPost", contentHash: keccak256(stringToBytes("x")) };
    await expect(kr.signTxApproved(cp, issueApproval(cp, NOW), FILL, NOW)).rejects.toThrow("no EVM signing key");
    const jw: ProposedAction = { kind: "journalWrite", contentHash: keccak256(stringToBytes("x")), sizeBytes: 1n };
    await expect(kr.signTxApproved(jw, issueApproval(jw, NOW), FILL, NOW)).rejects.toThrow("no EVM signing key");
    const lp: ProposedAction = { kind: "actionLp", pool: `0x${"ab".repeat(32)}`, usdgAmount: 1n, tokenAmount: 1n, token: TOKEN_X };
    await expect(kr.signTxApproved(lp, issueApproval(lp, NOW), FILL, NOW)).rejects.toThrow("modifyLiquidityRouter");
  });
});

// ---------------------------------------------------------------------------
// K3 — x402 EIP-3009 authorization
// ---------------------------------------------------------------------------

describe("K3: signX402AuthApproved", () => {
  const INF: ProposedAction = { kind: "inference", category: "pulse", endpointId: "inf-cheap", maxCostUsd: 400_000n };
  function auth(over: Partial<X402AuthInput> = {}): X402AuthInput {
    const ap = issueApproval(INF, NOW);
    return { to: PAYTO_INF_CHEAP, value: 400_000n, validAfter: NOW - 10n, validBefore: NOW - 10n + 3600n, nonce: x402Nonce(ap.actionHash), ...over };
  }

  it("K3: happy path — typed-data signature recovers to the treasury EOA; nonce = keccak(actionHash ‖ 'x402')", async () => {
    const { kr, c } = await setup();
    const ap = issueApproval(INF, NOW);
    const r = await kr.signX402AuthApproved(INF, ap, auth(), NOW);
    expect(r.authorization.from).toBe(kr.addresses().treasury);
    expect(r.authorization.nonce).toBe(keccak256(`${ap.actionHash}${Buffer.from("x402").toString("hex")}` as Hex));
    const d = c.usdcDomain.base;
    const ok = await verifyTypedData({
      address: kr.addresses().treasury,
      domain: { name: d.name, version: d.version, chainId: d.chainId, verifyingContract: d.verifyingContract },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: r.authorization,
      signature: r.signature,
    });
    expect(ok).toBe(true);
  });
  it("K3: auth.from == own treasury accepted", async () => {
    const { kr } = await setup();
    await expect(kr.signX402AuthApproved(INF, issueApproval(INF, NOW), auth({ from: kr.addresses().treasury }), NOW)).resolves.toBeDefined();
  });
  const bad: Array<[string, Partial<X402AuthInput>, string]> = [
    ["auth.to not the endpoint payTo", { to: CP }, "payTo"],
    ["auth.to = a data endpoint payTo", { to: PAYTO_DATA }, "payTo"],
    ["auth.value > maxCostUsd", { value: 400_001n }, "maxCostUsd"],
    ["auth.value 0", { value: 0n }, "value"],
    ["window 3601s", { validAfter: NOW, validBefore: NOW + 3601n }, "window"],
    ["validBefore == validAfter", { validAfter: NOW, validBefore: NOW }, "validBefore"],
    ["validBefore < validAfter", { validAfter: NOW, validBefore: NOW - 1n }, "validBefore"],
    ["nonce random", { nonce: `0x${"00".repeat(32)}` }, "nonce"],
  ];
  for (const [name, over, msg] of bad) {
    it(`K3: ${name} ⇒ throws`, async () => {
      const { kr } = await setup();
      await expect(kr.signX402AuthApproved(INF, issueApproval(INF, NOW), auth(over), NOW)).rejects.toThrow(msg);
    });
  }
  it("K3: boundaries — value == maxCostUsd and window == 3600s accepted", async () => {
    const { kr } = await setup();
    await expect(
      kr.signX402AuthApproved(INF, issueApproval(INF, NOW), auth({ value: 400_000n, validAfter: NOW, validBefore: NOW + 3600n }), NOW),
    ).resolves.toBeDefined();
  });
  it("K3: auth.from = own ACTION EOA ⇒ throws", async () => {
    const { kr } = await setup();
    await expect(kr.signX402AuthApproved(INF, issueApproval(INF, NOW), auth({ from: kr.addresses().action }), NOW)).rejects.toThrow("from");
  });
  it("K3: non-inference kind ⇒ throws", async () => {
    const { kr } = await setup();
    await expect(kr.signX402AuthApproved(HB, issueApproval(HB, NOW), auth(), NOW)).rejects.toThrow("not inference");
  });
  it("K3: replay of the same approval ⇒ K1 throws", async () => {
    const { kr } = await setup();
    const ap = issueApproval(INF, NOW);
    await kr.signX402AuthApproved(INF, ap, auth(), NOW);
    await expect(kr.signX402AuthApproved(INF, ap, auth(), NOW)).rejects.toThrow("approval already used");
  });
});

// ---------------------------------------------------------------------------
// K4 — casts (ed25519, fc key)
// ---------------------------------------------------------------------------

describe("K4: signCastApproved", () => {
  const msg = stringToBytes("gm from the enclave");
  const POST: ProposedAction = { kind: "castPost", contentHash: keccak256(msg) };
  const REPLY: ProposedAction = { kind: "castReply", contentHash: keccak256(msg), parentHash: `0x${"22".repeat(32)}` };

  it("K4: ed25519 roundtrip — signature verifies against farcasterPublicKey()", async () => {
    const { kr } = await setup();
    const sig = await kr.signCastApproved(POST, issueApproval(POST, NOW), msg, NOW);
    expect(sig).toMatch(/^0x[0-9a-f]{128}$/);
    expect(kr.farcasterPublicKey()).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await ed25519Verify(sig, msg, kr.farcasterPublicKey())).toBe(true);
    expect(await ed25519Verify(sig, stringToBytes("gm from the enclave!"), kr.farcasterPublicKey())).toBe(false);
  });
  it("K4: castReply signs too", async () => {
    const { kr } = await setup();
    const sig = await kr.signCastApproved(REPLY, issueApproval(REPLY, NOW), msg, NOW);
    expect(await ed25519Verify(sig, msg, kr.farcasterPublicKey())).toBe(true);
  });
  it("K4: contentHash mismatch ⇒ throws", async () => {
    const { kr } = await setup();
    await expect(kr.signCastApproved(POST, issueApproval(POST, NOW), stringToBytes("something else"), NOW)).rejects.toThrow("contentHash");
  });
  it("K4: checksummed/uppercase contentHash still matches", async () => {
    const { kr } = await setup();
    const a: ProposedAction = { kind: "castPost", contentHash: `0x${keccak256(msg).slice(2).toUpperCase()}` };
    await expect(kr.signCastApproved(a, issueApproval(a, NOW), msg, NOW)).resolves.toMatch(/^0x/);
  });
  it("K4: non-cast kind ⇒ throws", async () => {
    const { kr } = await setup();
    await expect(kr.signCastApproved(HB, issueApproval(HB, NOW), msg, NOW)).rejects.toThrow("not a cast");
  });
  it("K4: replay ⇒ K1 throws", async () => {
    const { kr } = await setup();
    const ap = issueApproval(POST, NOW);
    await kr.signCastApproved(POST, ap, msg, NOW);
    await expect(kr.signCastApproved(POST, ap, msg, NOW)).rejects.toThrow("approval already used");
  });
  it("K4: fc key is deterministic per (image, agentId) and differs across agents; not an EVM key", async () => {
    const a = await setup("agent-0001");
    const b = await setup("agent-0001");
    const other = await setup("agent-0002");
    expect(a.kr.farcasterPublicKey()).toBe(b.kr.farcasterPublicKey());
    expect(a.kr.farcasterPublicKey()).not.toBe(other.kr.farcasterPublicKey());
    const sigA = await a.kr.signCastApproved(POST, issueApproval(POST, NOW), msg, NOW);
    const sigB = await b.kr.signCastApproved(POST, issueApproval(POST, NOW), msg, NOW);
    expect(sigA).toBe(sigB); // ed25519 is deterministic
    expect(await ed25519Verify(sigA, msg, other.kr.farcasterPublicKey())).toBe(false);
  });
  it("K4: signApproved refuses fc kinds (no EVM key for the fc wallet)", async () => {
    const { kr } = await setup();
    await expect(kr.signApproved(POST, issueApproval(POST, NOW), NOW)).rejects.toThrow("no EVM signing key");
  });
});
