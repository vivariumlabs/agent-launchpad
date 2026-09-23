// SPEC-M3B §3 test helper (not a test file): in-memory Turbo + Arweave stand-in at the TurboUploader
// seam — uploads indexed by owner + tags (GraphQL-like query), gateway-like download, credits.

import type { Address } from "viem";
import type { TurboTag, TurboUploader } from "../../src/attestation/turbo.js";

/** In-memory Turbo + Arweave stand-in: uploads indexed by owner + tags. */
export class MockTurbo implements TurboUploader {
  readonly items = new Map<string, { data: Uint8Array; tags: TurboTag[]; owner: Address }>();
  balance = 10n ** 15n;
  perByte = 1_000n;
  failUpload: Error | null = null;
  private n = 0;
  constructor(readonly owner: Address) {}
  async upload(data: Uint8Array, tags: readonly TurboTag[]): Promise<{ id: string }> {
    if (this.failUpload !== null) throw this.failUpload;
    const id = `tx${(this.n++).toString().padStart(40, "0")}`;
    this.items.set(id, { data: new Uint8Array(data), tags: [...tags], owner: this.owner });
    return { id };
  }
  async query(owner: Address, tags: readonly TurboTag[]): Promise<string[]> {
    return [...this.items.entries()]
      .filter(([, v]) => v.owner.toLowerCase() === owner.toLowerCase() && tags.every((t) => v.tags.some((x) => x.name === t.name && x.value === t.value)))
      .map(([id]) => id);
  }
  async download(id: string): Promise<Uint8Array> {
    const v = this.items.get(id);
    if (v === undefined) throw new Error(`404 ${id}`);
    return v.data;
  }
  async balanceWinc(): Promise<bigint> {
    return this.balance;
  }
  async costWinc(bytes: number): Promise<bigint> {
    return BigInt(bytes) * this.perByte;
  }
}

