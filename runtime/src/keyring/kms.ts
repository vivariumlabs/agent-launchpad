// SPEC-M2 §5. KmsClient interface + boot-retry helper (carry-over (2), M0 gotcha:
// the Nautilus derive server comes up after containers start; first-touch
// without retry crash-loops).

import type { Hex } from "viem";

export interface KmsClient {
  /** Returns a 32-byte hex key derived at `path`. */
  derive(path: string): Promise<Hex>;
}

export interface WithRetryOptions {
  attempts?: number;
  delayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, opts?: WithRetryOptions): Promise<T> {
  const attempts = opts?.attempts ?? 30;
  const delayMs = opts?.delayMs ?? 1000;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}
