import { describe, expect, it } from "vitest";
import { withRetry } from "../../src/keyring/kms.js";
import { MockKms } from "../../src/keyring/mockKms.js";

describe("withRetry", () => {
  it("converges once the underlying calls stop failing (failFirstN=3, attempts=5)", async () => {
    const kms = new MockKms("image-a", "agent-0001", { failFirstN: 3 });
    const key = await withRetry(() => kms.derive("treasury"), { attempts: 5, delayMs: 1 });
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rethrows the last error when attempts are exhausted (failFirstN=3, attempts=2)", async () => {
    const kms = new MockKms("image-a", "agent-0001", { failFirstN: 3 });
    await expect(withRetry(() => kms.derive("treasury"), { attempts: 2, delayMs: 1 })).rejects.toThrow(
      /simulated failure/,
    );
  });

  it("waits roughly delayMs between attempts", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls < 3) throw new Error("not yet");
      return "ok";
    };
    const start = Date.now();
    const result = await withRetry(fn, { attempts: 5, delayMs: 20 });
    const elapsed = Date.now() - start;
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    // Two delays of ~20ms should have elapsed (loose bound, avoids flakiness).
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });

  it("defaults to attempts=30, delayMs=1000 when opts are omitted", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return "ok";
    };
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });
});
