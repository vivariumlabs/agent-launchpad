// SPEC-M3B §3 — Turbo (ArDrive) / Arweave sinks.
//
// TurboArweaveSink implements BOTH AttestationSink (attestation.ts) and SnapshotSink
// (memory/snapshot.ts) over ONE TurboUploader. Every upload is an ANS-104 data item signed by the
// TREASURY key through keyring.turboSigner() (no key material leaves the keyring) and tagged
//   { App: "agent-launchpad", Kind: "attestation" | "snapshot", AgentId: <decimal>, Timestamp: <unix s> }.
// The returned ref is the Arweave data-item id (txid) — for attestation it becomes cfg.registration
// .attestationRef. Costs come from the treasury's Turbo credits (seeded at genesis; the agent
// self-top-up path is an s3+ item): after each snapshot the sink compares the balance with the
// estimated cost of LOW_CREDIT_DAYS daily snapshots and logs LOUDLY when short.
//
// Mirrors (belt and suspenders, DEFAULT on): MirroredSnapshotSink / MirroredAttestationSink write
// the primary (Turbo) AND every mirror (LocalDirSink); a failing mirror is logged, a failing primary
// throws after the mirrors are written. Restore reads the sinks separately ([turbo, local] ⇒ Turbo
// wins createdAt ties — restoreLatest's sort is stable in sink order).
//
// The uploader is the in-house ./turboHttp.ts (ANS-104 via ./ans104.ts; the only network file here).
// @ardrive/turbo-sdk was rejected (211 MB, native deps) and is not a dependency.

import type { Address, Hex } from "viem";
import type { SnapshotSink } from "../memory/snapshot.js";
import type { AttestationSink } from "./attestation.js";

export const TURBO_APP_TAG = "agent-launchpad";
/** SPEC-M3D §2: Turbo payment-service token of the step-12 top-up (the `addresses` key in GET /info). */
export const TURBO_BASE_ETH_TOKEN = "base-eth";
/** DEFAULT: warn when credits cover fewer than this many daily snapshots. */
export const LOW_CREDIT_DAYS = 30n;

export type TurboKind = "attestation" | "snapshot";

export interface TurboTag {
  name: string;
  value: string;
}

/** The Turbo/Arweave seam (./turboHttp.ts in production; mocked in tests). */
export interface TurboUploader {
  /** Signs (injected TurboSigner) and uploads one ANS-104 data item; returns its id (Arweave txid). */
  upload(data: Uint8Array, tags: readonly TurboTag[]): Promise<{ id: string }>;
  /** Ids of data items owned by `owner` carrying ALL of `tags` (Arweave GraphQL). */
  query(owner: Address, tags: readonly TurboTag[]): Promise<string[]>;
  /** Raw bytes of a data item (gateway GET /<id>). */
  download(id: string): Promise<Uint8Array>;
  /** Current Turbo credit balance of the signer, winc. */
  balanceWinc(): Promise<bigint>;
  /** Estimated winc to upload `bytes`. */
  costWinc(bytes: number): Promise<bigint>;
}

/**
 * SPEC-M3D §2 — the Turbo payment-service seam of the daemon's step-12 self-top-up (implemented by
 * ./turboHttp.ts TurboHttpUploader; the network allowlist already covers that file).
 */
export interface TurboPayment {
  /** Current Turbo credit balance of the treasury, winc (404 ⇒ 0). */
  balanceWinc(): Promise<bigint>;
  /** GET /info → addresses[token] (UNTRUSTED dynamic address; null ⇒ none listed). */
  paymentAddress(token: string): Promise<Address | null>;
  /** POST /account/balance/<token> {tx_id}: resolves on 200/202, throws otherwise. */
  submitFundTx(token: string, txId: Hex): Promise<{ status: number; body: unknown }>;
}

export interface SinkLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface TurboArweaveSinkOptions {
  uploader: TurboUploader;
  agentId: number;
  /** Treasury EOA (= TurboSigner.address): the owner filter for list(). */
  owner: Address;
  logger?: SinkLogger;
  lowCreditDays?: bigint;
}

export function turboTags(kind: TurboKind, agentId: number, now: bigint): TurboTag[] {
  return [
    { name: "App", value: TURBO_APP_TAG },
    { name: "Kind", value: kind },
    { name: "AgentId", value: agentId.toString(10) },
    { name: "Timestamp", value: now.toString(10) },
  ];
}

export class TurboArweaveSink implements AttestationSink, SnapshotSink {
  private readonly o: TurboArweaveSinkOptions;

  constructor(o: TurboArweaveSinkOptions) {
    if (!Number.isSafeInteger(o.agentId) || o.agentId <= 0) throw new Error(`TurboArweaveSink: bad agentId ${o.agentId}`);
    this.o = o;
  }

  /** AttestationSink: the canonical report as UTF-8 bytes; ref = txid. */
  async upload(report: string, now: bigint): Promise<string> {
    const { id } = await this.o.uploader.upload(new TextEncoder().encode(report), turboTags("attestation", this.o.agentId, now));
    return id;
  }

  /** SnapshotSink: the encrypted ALSNAP1 envelope; id = txid. Then the low-credit check. */
  async write(data: Uint8Array, now: bigint): Promise<string> {
    const { id } = await this.o.uploader.upload(data, turboTags("snapshot", this.o.agentId, now));
    await this.checkCredits(data.length);
    return id;
  }

  async list(): Promise<string[]> {
    const tags = turboTags("snapshot", this.o.agentId, 0n).filter((t) => t.name !== "Timestamp");
    return this.o.uploader.query(this.o.owner, tags);
  }

  async read(id: string): Promise<Uint8Array> {
    return this.o.uploader.download(id);
  }

  /** Loud warning when the balance covers < lowCreditDays daily snapshots of this size. Never throws. */
  async checkCredits(snapshotBytes: number): Promise<{ balance: bigint; needed: bigint; low: boolean } | null> {
    try {
      const [balance, per] = await Promise.all([this.o.uploader.balanceWinc(), this.o.uploader.costWinc(snapshotBytes)]);
      const days = this.o.lowCreditDays ?? LOW_CREDIT_DAYS;
      const needed = per * days;
      const low = balance < needed;
      if (low) {
        this.o.logger?.warn(
          `!!! TURBO CREDITS LOW: ${balance} winc < ${needed} winc (${days} days of ${snapshotBytes}-byte snapshots) for ${this.o.owner} — ` +
            "snapshots/attestations will stop publishing to Arweave when credits run out (agent self-top-up is an s3+ item) !!!",
        );
      }
      return { balance, needed, low };
    } catch (e) {
      this.o.logger?.warn(`turbo: credit check failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// mirrors
// ---------------------------------------------------------------------------

async function writeAll<T>(primary: () => Promise<T>, mirrors: ReadonlyArray<() => Promise<unknown>>, what: string, logger?: SinkLogger): Promise<T> {
  let result: { ok: true; v: T } | { ok: false; e: unknown };
  try {
    result = { ok: true, v: await primary() };
  } catch (e) {
    result = { ok: false, e };
  }
  for (const [i, m] of mirrors.entries()) {
    try {
      await m();
    } catch (e) {
      logger?.warn(`${what}: mirror ${i} write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!result.ok) throw result.e;
  return result.v;
}

/** Snapshot writes go to primary + mirrors; the id is the primary's. list/read = primary's. */
export class MirroredSnapshotSink implements SnapshotSink {
  constructor(
    readonly primary: SnapshotSink,
    readonly mirrors: readonly SnapshotSink[],
    private readonly logger?: SinkLogger,
  ) {}

  write(data: Uint8Array, now: bigint): Promise<string> {
    return writeAll(() => this.primary.write(data, now), this.mirrors.map((m) => () => m.write(data, now)), "snapshot", this.logger);
  }

  list(): Promise<string[]> {
    return this.primary.list();
  }

  read(id: string): Promise<Uint8Array> {
    return this.primary.read(id);
  }
}

/** Attestation report to primary + mirrors; the ref is the primary's. */
export class MirroredAttestationSink implements AttestationSink {
  constructor(
    readonly primary: AttestationSink,
    readonly mirrors: readonly AttestationSink[],
    private readonly logger?: SinkLogger,
  ) {}

  upload(report: string, now: bigint): Promise<string> {
    return writeAll(() => this.primary.upload(report, now), this.mirrors.map((m) => () => m.upload(report, now)), "attestation", this.logger);
  }
}
