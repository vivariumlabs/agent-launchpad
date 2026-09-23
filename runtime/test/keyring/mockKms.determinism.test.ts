import { describe, expect, it } from "vitest";
import { MockKms } from "../../src/keyring/mockKms.js";

// Mirrors the M0 A/B/C determinism drill (spikes/m0-marlin-kms/RESULTS.md):
// same (image, agentId, path) => same key; any change => different key.
describe("MockKms determinism", () => {
  it("same (imageId, agentId, path) called twice yields the same key", async () => {
    const kms = new MockKms("image-a", "agent-0001");
    const k1 = await kms.derive("treasury");
    const k2 = await kms.derive("treasury");
    expect(k1).toBe(k2);
  });

  it("a different imageId yields a different key", async () => {
    const a = await new MockKms("image-a", "agent-0001").derive("treasury");
    const b = await new MockKms("image-b", "agent-0001").derive("treasury");
    expect(a).not.toBe(b);
  });

  it("a different agentId yields a different key", async () => {
    const a = await new MockKms("image-a", "agent-0001").derive("treasury");
    const c = await new MockKms("image-a", "agent-0002").derive("treasury");
    expect(a).not.toBe(c);
  });

  it("a different path yields a different key", async () => {
    const kms = new MockKms("image-a", "agent-0001");
    const treasury = await kms.derive("treasury");
    const action = await kms.derive("action");
    expect(treasury).not.toBe(action);
  });

  it("keys are 32-byte hex (0x + 64 hex chars)", async () => {
    const key = await new MockKms("image-a", "agent-0001").derive("treasury");
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
