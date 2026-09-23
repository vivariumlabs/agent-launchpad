import { recoverMessageAddress } from "viem";
import { describe, expect, it } from "vitest";
import { issueApproval } from "../../src/policy/approval.js";
import type { ProposedAction } from "../../src/policy/types.js";
import { createKeyring } from "../../src/keyring/keyring.js";
import { MockKms } from "../../src/keyring/mockKms.js";

const FAST_RETRY = { retry: { attempts: 3, delayMs: 1 } };

describe("createKeyring", () => {
  it("produces stable addresses across two boots with the same (imageId, agentId) — revival semantics", async () => {
    const kmsA = new MockKms("image-a", "agent-0001");
    const kmsB = new MockKms("image-a", "agent-0001");
    const keyringA = await createKeyring(kmsA, FAST_RETRY);
    const keyringB = await createKeyring(kmsB, FAST_RETRY);
    expect(keyringA.addresses()).toEqual(keyringB.addresses());
  });

  it("signApproved happy path returns a 65-byte signature hex", async () => {
    const keyring = await createKeyring(new MockKms("image-a", "agent-0001"), FAST_RETRY);
    const action: ProposedAction = { kind: "heartbeat" };
    const now = 1_000_000n;
    const approval = issueApproval(action, now);
    const sig = await keyring.signApproved(action, approval, now);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("throws 'approval mismatch' when the action is tampered after approval was issued", async () => {
    const keyring = await createKeyring(new MockKms("image-a", "agent-0001"), FAST_RETRY);
    const original: ProposedAction = { kind: "allowance", amount: 100n };
    const tampered: ProposedAction = { kind: "allowance", amount: 999n };
    const now = 1_000_000n;
    const approval = issueApproval(original, now);
    await expect(keyring.signApproved(tampered, approval, now)).rejects.toThrow("approval mismatch");
  });

  it("throws 'approval expired' when now is beyond issuedAt + ttlSec", async () => {
    const keyring = await createKeyring(new MockKms("image-a", "agent-0001"), FAST_RETRY);
    const action: ProposedAction = { kind: "heartbeat" };
    const issuedAt = 1_000_000n;
    const approval = issueApproval(action, issuedAt);
    const tooLate = issuedAt + 61n;
    await expect(keyring.signApproved(action, approval, tooLate)).rejects.toThrow("approval expired");
  });

  it("allows signing exactly at the ttl boundary (now == issuedAt + ttlSec)", async () => {
    const keyring = await createKeyring(new MockKms("image-a", "agent-0001"), FAST_RETRY);
    const action: ProposedAction = { kind: "heartbeat" };
    const issuedAt = 1_000_000n;
    const approval = issueApproval(action, issuedAt);
    const exactBoundary = issuedAt + 60n;
    await expect(keyring.signApproved(action, approval, exactBoundary)).resolves.toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("signs treasury-kind actions with the treasury key, recoverable to the treasury address", async () => {
    const keyring = await createKeyring(new MockKms("image-a", "agent-0001"), FAST_RETRY);
    const action: ProposedAction = { kind: "heartbeat" };
    const now = 1_000_000n;
    const approval = issueApproval(action, now);
    const sig = await keyring.signApproved(action, approval, now);
    const recovered = await recoverMessageAddress({ message: { raw: approval.actionHash }, signature: sig });
    expect(recovered.toLowerCase()).toBe(keyring.addresses().treasury.toLowerCase());
  });

  it("signs action-kind actions with the action key, recoverable to the action address", async () => {
    const keyring = await createKeyring(new MockKms("image-a", "agent-0001"), FAST_RETRY);
    const action: ProposedAction = { kind: "actionMint", target: "0x000000000000000000000000000000000000aa", value: 1n };
    const now = 1_000_000n;
    const approval = issueApproval(action, now);
    const sig = await keyring.signApproved(action, approval, now);
    const recovered = await recoverMessageAddress({ message: { raw: approval.actionHash }, signature: sig });
    expect(recovered.toLowerCase()).toBe(keyring.addresses().action.toLowerCase());
  });

  it("treasury and action addresses differ", async () => {
    const keyring = await createKeyring(new MockKms("image-a", "agent-0001"), FAST_RETRY);
    const { treasury, action } = keyring.addresses();
    expect(treasury.toLowerCase()).not.toBe(action.toLowerCase());
  });
});
