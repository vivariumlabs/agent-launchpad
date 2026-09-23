// Arweave seed leg = Turbo credit top-up for the agent (SPEC-M3B §1 seeder, §3). The real
// @ardrive/turbo-sdk integration (Job L owns the SDK in runtime/) is an s3 item for the orchestrator:
// in s2 the only implementation is NullTurbo ("Turbo unfunded") — the testnet profile then SKIPS the
// arweave leg and logs loudly; the mainnet profile refuses to start without turbo.enabled.

export interface TurboFunder {
  /** Whether the orchestrator's Turbo account can fund top-ups right now. */
  funded(): Promise<boolean>;
  /** Credits the target already holds, µUSD-equivalent (idempotence check). */
  credited(target: string): Promise<bigint>;
  /** Top up `usdMicro` of credits for `target`; returns a reference (payment/tx id). */
  topUp(target: string, usdMicro: bigint): Promise<string>;
}

export const nullTurbo: TurboFunder = {
  funded: async () => false,
  credited: async () => 0n,
  topUp: async () => {
    throw new Error("Turbo top-up is not implemented in the orchestrator yet (s3) — leg must be skipped");
  },
};
