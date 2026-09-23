import { describe, expect, it } from "vitest";
import { actionHash, canonicalEncode, issueApproval } from "../../src/policy/approval.js";
import type { ProposedAction } from "../../src/policy/types.js";

describe("canonicalEncode", () => {
  it("sorts object keys recursively", () => {
    const value = { b: 1, a: { d: 2, c: 3 } };
    expect(canonicalEncode(value)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("serializes bigint as a decimal string", () => {
    const value = { amount: 123456789012345678901234567890n };
    expect(canonicalEncode(value)).toBe('{"amount":"123456789012345678901234567890"}');
  });

  it("lowercases 0x-prefixed strings", () => {
    const value = { to: "0xABCDEF1234567890abcdef1234567890ABCDEF12" };
    expect(canonicalEncode(value)).toBe('{"to":"0xabcdef1234567890abcdef1234567890abcdef12"}');
  });

  it("does not lowercase non-hex strings", () => {
    const value = { name: "AgentX" };
    expect(canonicalEncode(value)).toBe('{"name":"AgentX"}');
  });

  it("preserves array order while sorting nested object keys", () => {
    const value = { list: [{ z: 1, a: 2 }, { b: 3 }] };
    expect(canonicalEncode(value)).toBe('{"list":[{"a":2,"z":1},{"b":3}]}');
  });
});

describe("actionHash", () => {
  const base: ProposedAction = { kind: "allowance", amount: 100n };

  it("is stable across key-order permutations of an equivalent action", () => {
    const a: ProposedAction = { kind: "allowance", amount: 100n };
    // Same logical object, keys constructed in a different order.
    const b = { amount: 100n, kind: "allowance" } as ProposedAction;
    expect(actionHash(a)).toBe(actionHash(b));
  });

  it("differs when a field changes", () => {
    const changed: ProposedAction = { kind: "allowance", amount: 101n };
    expect(actionHash(base)).not.toBe(actionHash(changed));
  });

  it("is deterministic across repeated calls", () => {
    expect(actionHash(base)).toBe(actionHash(base));
  });
});

describe("issueApproval", () => {
  it("sets actionHash, issuedAt, and a 60s ttl", () => {
    const action: ProposedAction = { kind: "heartbeat" };
    const now = 1_000_000n;
    const approval = issueApproval(action, now);
    expect(approval.actionHash).toBe(actionHash(action));
    expect(approval.issuedAt).toBe(now);
    expect(approval.ttlSec).toBe(60);
  });
});
