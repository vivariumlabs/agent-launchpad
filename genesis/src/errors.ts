// Error taxonomy for the state machine (SPEC-M3B §1):
//   Fatal       → the flow moves to FAILED(reason, step) immediately (definitive: config hash
//                 mismatch, cap exhausted, registry instance mismatch, cancelled on-chain…).
//   anything else → TRANSIENT: recorded as lastError, retried on the next resume, bounded only by
//                 the overall timeout (RPC hiccups, Oyster outage, funding wallet low, fee spike).
// Attempt-capped steps count their own definitive failures and throw Fatal at the cap.

export class Fatal extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "Fatal";
  }
}

/** Fee estimate above the configured per-chain cap: never broadcast, wait for fees to fall. */
export class FeeCapExceeded extends Error {
  constructor(detail: string) {
    super(`fee cap exceeded: ${detail}`);
    this.name = "FeeCapExceeded";
  }
}

/** A stored raw tx could not be re-broadcast because its nonce is already used (by another tx). */
export class NonceConsumed extends Error {
  constructor(detail: string) {
    super(`nonce consumed: ${detail}`);
    this.name = "NonceConsumed";
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
