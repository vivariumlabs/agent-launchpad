// SPEC-M3B §2 / docs/TLS-INGRESS.md — in-enclave TLS termination for the chat server.
//
// CertStore: the three certificates the :443 listener can present, chosen per handshake by
// SNICallback:
//   (a) challenge   — the acme-tls/1 cert while a TLS-ALPN-01 authorization for that exact SNI
//                     name is pending (ALPNProtocols includes "acme-tls/1"). Node cannot see ALPN
//                     at SNI time, so for the seconds a challenge is live, ordinary clients naming
//                     the agent domain get the challenge cert (handshake fails, they retry);
//   (b) issued      — the CA-issued cert + key persisted under <tls dir> (/data/tls in the
//                     image), reloaded on restart, re-issued after revival (fresh volume);
//   (c) placeholder — before first issuance: a deterministic Ed25519 self-signed cert whose key is
//                     KMS-derived (keys.ts) ⇒ byte-identical across restarts; its SPKI is what
//                     GET /attestation pins until a CA cert exists.
// TlsManager: boot/daemon glue — background first-issuance retry loop (placeholder served
// meanwhile), renewalDue/renew for daemon step 10, SPKI of the currently served cert.
//
// Hygiene: node:https/node:tls/node:fs ONLY here in src/tls; the network (ACME) only via acme.ts.

import { renameSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, X509Certificate, type KeyObject } from "node:crypto";
import https from "node:https";
import { join } from "node:path";
import tls from "node:tls";
import type { Hex } from "viem";
import type { ChatListenServer, ChatRequestListener, TlsListenMode } from "../chat/server.js";
import type { UnixSeconds } from "../policy/types.js";
import { issueCertificate, renewalDue, type AcmeApi, type ChallengeSink, type TlsMaterial } from "./acme.js";
import { buildCertificateDer, certNotAfter, certSpkiSha256, derToPem } from "./x509.js";

export const ACME_TLS_ALPN = "acme-tls/1";
export const TLS_CERT_FILE = "cert.pem";
export const TLS_KEY_FILE = "key.pem";
/** Placeholder validity: fixed constants (no clock) — 2026-01-01T00:00:00Z … 9999-12-31T23:59:59Z (RFC 5280 "no expiry"). */
export const PLACEHOLDER_NOT_BEFORE = 1_767_225_600n;
export const PLACEHOLDER_NOT_AFTER = 253_402_300_799n;
/** DEFAULT delay between failed first-issuance attempts. */
export const ACME_RETRY_SEC = 300n;

// ---------------------------------------------------------------------------
// placeholder
// ---------------------------------------------------------------------------

/** Deterministic self-signed placeholder for `domain`, signed by the KMS-derived Ed25519 key. */
export function placeholderMaterial(domain: string, key: KeyObject): TlsMaterial {
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const serial = createHash("sha256").update(spki).digest().subarray(0, 16);
  serial[0] = (serial[0]! & 0x7f) | 0x40; // positive, non-zero, fixed length
  const der = buildCertificateDer({
    subjectSpkiDer: spki,
    issuerKey: key,
    issuerCommonName: domain,
    subjectCommonName: domain,
    dnsNames: [domain],
    serial,
    notBefore: PLACEHOLDER_NOT_BEFORE,
    notAfter: PLACEHOLDER_NOT_AFTER,
  });
  return { certPem: derToPem(der), keyPem: key.export({ type: "pkcs8", format: "pem" }).toString() };
}

// ---------------------------------------------------------------------------
// CertStore
// ---------------------------------------------------------------------------

export type CertKind = "challenge" | "issued" | "placeholder";

export interface CertStoreLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

interface Loaded {
  material: TlsMaterial;
  context: tls.SecureContext;
  notAfter: bigint;
  spki: Hex;
}

function load(m: TlsMaterial): Loaded {
  return { material: m, context: tls.createSecureContext({ key: m.keyPem, cert: m.certPem }), notAfter: certNotAfter(m.certPem), spki: certSpkiSha256(m.certPem) };
}

/** Throws unless `m` is a consistent key/cert pair covering `domain`. */
function validate(m: TlsMaterial, domain: string): void {
  const leaf = new X509Certificate(m.certPem);
  if (!leaf.checkPrivateKey(createPrivateKey(m.keyPem))) throw new Error("certificate/key mismatch");
  if (leaf.checkHost(domain) === undefined) throw new Error(`certificate does not cover ${domain}`);
}

export class CertStore implements ChallengeSink {
  readonly domain: string;
  readonly dir: string;
  private readonly placeholder: Loaded;
  private issued: Loaded | null = null;
  private readonly challenges = new Map<string, tls.SecureContext>();

  constructor(opts: { domain: string; dir: string; placeholder: TlsMaterial }) {
    this.domain = opts.domain.toLowerCase();
    this.dir = opts.dir;
    this.placeholder = load(opts.placeholder);
  }

  /** Loads a persisted issued cert (if any, valid for the domain and unexpired at `now`). Returns whether one was loaded. */
  loadPersisted(now: UnixSeconds, logger?: CertStoreLogger): boolean {
    const certPath = join(this.dir, TLS_CERT_FILE);
    const keyPath = join(this.dir, TLS_KEY_FILE);
    if (!existsSync(certPath) || !existsSync(keyPath)) return false;
    try {
      const m: TlsMaterial = { certPem: readFileSync(certPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") };
      validate(m, this.domain);
      const l = load(m);
      if (l.notAfter <= now) {
        logger?.warn(`tls: persisted certificate in ${this.dir} expired at ${l.notAfter}; serving the placeholder until re-issuance`);
        return false;
      }
      this.issued = l;
      return true;
    } catch (e) {
      logger?.warn(`tls: ignoring unusable persisted certificate in ${this.dir}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** Validates, persists (dir 0700, files 0600, write-then-rename), and switches to `m`. */
  saveIssued(m: TlsMaterial): void {
    validate(m, this.domain);
    const l = load(m);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const [file, body] of [[TLS_KEY_FILE, m.keyPem], [TLS_CERT_FILE, m.certPem]] as const) {
      const tmp = join(this.dir, `${file}.tmp`);
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, join(this.dir, file));
    }
    this.issued = l;
  }

  setChallenge(domain: string, m: TlsMaterial): void {
    this.challenges.set(domain.toLowerCase(), tls.createSecureContext({ key: m.keyPem, cert: m.certPem }));
  }

  clearChallenge(domain: string): void {
    this.challenges.delete(domain.toLowerCase());
  }

  /** SNI selection: challenge (exact name, pending) → issued → placeholder (any other name too). */
  select(servername: string | undefined): { kind: CertKind; context: tls.SecureContext } {
    const sn = servername?.toLowerCase();
    const ch = sn === undefined ? undefined : this.challenges.get(sn);
    if (ch !== undefined) return { kind: "challenge", context: ch };
    if (this.issued !== null) return { kind: "issued", context: this.issued.context };
    return { kind: "placeholder", context: this.placeholder.context };
  }

  /** The non-challenge material currently served (issued, else placeholder). */
  current(): { kind: "issued" | "placeholder"; material: TlsMaterial; spkiSha256: Hex; notAfter: bigint } {
    const l = this.issued ?? this.placeholder;
    return { kind: this.issued !== null ? "issued" : "placeholder", material: l.material, spkiSha256: l.spki, notAfter: l.notAfter };
  }

  issuedNotAfter(): bigint | null {
    return this.issued?.notAfter ?? null;
  }
}

/** Chat-server `listen({ tls })` mode: an https server on the CertStore's SNI selection. */
export function tlsListenMode(store: CertStore): TlsListenMode {
  return {
    createServer(onRequest: ChatRequestListener): ChatListenServer {
      // NO default key/cert on purpose: OpenSSL keeps one certificate slot per key type and merges the
      // default context's slot with the SNI context's, then picks by the client's sigalg order — an
      // Ed25519/ECDSA default would shadow an RSA acme-tls/1 challenge cert (observed). With every
      // certificate coming from SNICallback there is exactly one candidate per handshake.
      // Consequence: clients MUST send SNI (connect by hostname; pinning verifiers set servername) —
      // a no-SNI handshake fails.
      return https.createServer(
        {
          minVersion: "TLSv1.2",
          ALPNProtocols: ["http/1.1", ACME_TLS_ALPN],
          SNICallback: (servername, cb) => cb(null, store.select(servername).context),
        },
        onRequest,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// TlsManager
// ---------------------------------------------------------------------------

export interface TlsTimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface TlsManagerOptions {
  store: CertStore;
  directoryUrl: string;
  /** KMS-derived ACME account key PEM (lazy: keyring.acmeAccountKey → keys.acmeAccountKeyPem). */
  accountKeyPem: () => Promise<string>;
  clock: () => UnixSeconds;
  timers: TlsTimerApi;
  logger: CertStoreLogger;
  acme?: AcmeApi;
  retrySec?: bigint;
}

export class TlsManager {
  readonly store: CertStore;
  private inflight: Promise<string> | null = null;
  private retryHandle: unknown = undefined;
  private active = false;

  constructor(private readonly opts: TlsManagerOptions) {
    this.store = opts.store;
  }

  listenMode(): TlsListenMode {
    return tlsListenMode(this.store);
  }

  /** Begins the first-issuance loop when no valid cert is held (placeholder served meanwhile). */
  start(): void {
    this.active = true;
    if (this.renewalDue(this.opts.clock())) this.attempt();
  }

  /** Stops the retry loop. An in-flight ACME order is NOT awaited (it can take minutes; it only writes <tls dir>). */
  async stop(): Promise<void> {
    this.active = false;
    this.cancelRetry();
  }

  renewalDue(now: UnixSeconds): boolean {
    return renewalDue(this.store.issuedNotAfter(), now);
  }

  /** One issuance (deduplicated with any in flight). Resolves to a note; throws on failure. */
  renew(): Promise<string> {
    if (this.inflight !== null) return this.inflight;
    const p = (async () => {
      const issued = await issueCertificate({
        domain: this.store.domain,
        directoryUrl: this.opts.directoryUrl,
        accountKeyPem: await this.opts.accountKeyPem(),
        challenges: this.store,
        ...(this.opts.acme !== undefined ? { acme: this.opts.acme } : {}),
      });
      this.store.saveIssued({ keyPem: issued.keyPem, certPem: issued.certPem });
      this.cancelRetry();
      const note = `tls: certificate issued for ${this.store.domain} (notAfter ${issued.notAfter}, spki ${this.store.current().spkiSha256})`;
      this.opts.logger.info(note);
      return note;
    })();
    this.inflight = p;
    const clear = (): void => {
      if (this.inflight === p) this.inflight = null;
    };
    p.then(clear, clear);
    return p;
  }

  /** SPKI sha256 of the cert served to ordinary clients now (issued, else placeholder). */
  spkiSha256(): Hex {
    return this.store.current().spkiSha256;
  }

  private attempt(): void {
    if (!this.active) return;
    this.renew().catch((e: unknown) => {
      const retry = this.opts.retrySec ?? ACME_RETRY_SEC;
      this.opts.logger.warn(`tls: ACME issuance for ${this.store.domain} failed (${e instanceof Error ? e.message : String(e)}); placeholder stays; retry in ${retry}s`);
      if (!this.active || this.store.issuedNotAfter() !== null) return;
      this.cancelRetry();
      this.retryHandle = this.opts.timers.set(() => {
        this.retryHandle = undefined;
        this.attempt();
      }, Number(retry * 1000n));
    });
  }

  private cancelRetry(): void {
    if (this.retryHandle !== undefined) {
      this.opts.timers.clear(this.retryHandle);
      this.retryHandle = undefined;
    }
  }
}
