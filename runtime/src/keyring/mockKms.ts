// SPEC-M2 §5. Deterministic local KMS stand-in for Nautilus (M2 only).

import { keccak256, stringToBytes, type Hex } from "viem";
import type { KmsClient } from "./kms.js";

export interface MockKmsOptions {
  /** Makes the first N derive() calls reject, to exercise withRetry. */
  failFirstN?: number;
}

export class MockKms implements KmsClient {
  private readonly imageId: string;
  private readonly agentId: string;
  private readonly failFirstN: number;
  private callCount = 0;

  constructor(imageId: string, agentId: string, opts?: MockKmsOptions) {
    this.imageId = imageId;
    this.agentId = agentId;
    this.failFirstN = opts?.failFirstN ?? 0;
  }

  async derive(path: string): Promise<Hex> {
    this.callCount += 1;
    if (this.callCount <= this.failFirstN) {
      return Promise.reject(new Error(`mock-kms: simulated failure (${this.callCount}/${this.failFirstN})`));
    }
    const preimage = `mock-kms|${this.imageId}|${this.agentId}|${path}`;
    return Promise.resolve(keccak256(stringToBytes(preimage)));
  }
}
