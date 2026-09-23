// SPEC-M3B §2 — TLS ingress glue, offline. ACME path taken: acme-client MOCKED AT THE MODULE SEAM
// (tls/acme.ts AcmeApi — fake protocol client, REAL acme-client crypto for keys/CSR/ALPN challenge
// certs, a fake Ed25519 test CA); live staging issuance is an s3 checklist item.
// Covers: calendar/X.509 builder, KMS-seeded keys, placeholder determinism, SPKI computation,
// renewal-due math, domain derivation, SNI three-way switching over REAL handshakes (incl. the
// acme-tls/1 challenge cert validated by acme-client's own checker), persistence, issuance glue
// (TLS-ALPN-01 only), TlsManager retry loop, daemon step 10.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acmeClient from "acme-client";
import { keccak256, stringToBytes, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatListenServer } from "../../src/chat/server.js";
import { tick } from "../../src/daemon/daemon.js";
import { agentDomain, issueCertificate, LETS_ENCRYPT_PRODUCTION, renewalDue, RENEW_BEFORE_SEC, TLS_ALPN_01 } from "../../src/tls/acme.js";
import { acmeAccountKeyPem, ed25519KeyFromSeed, p256KeyFromSeed } from "../../src/tls/keys.js";
import {
  ACME_TLS_ALPN,
  CertStore,
  PLACEHOLDER_NOT_AFTER,
  PLACEHOLDER_NOT_BEFORE,
  placeholderMaterial,
  TLS_CERT_FILE,
  TLS_KEY_FILE,
  tlsListenMode,
  TlsManager,
} from "../../src/tls/server.js";
import { buildCertificateDer, certNotAfter, certSpkiSha256, civilFromUnix, daysFromCivil, derToPem, keySpkiSha256, parseOpenSslTime } from "../../src/tls/x509.js";
import { daemonHarness } from "../daemon/harness.js";
import { NOW } from "../policy/helpers.js";
import { DAY, fakeAcme, handshake } from "./helpers.js";

const DOMAIN = "a7.agents.example.test";
const seed = (label: string): Hex => keccak256(stringToBytes(`tls-test|${label}`));
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

const dirs: string[] = [];
const servers: ChatListenServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((r) => {
      s.close(() => r());
      s.closeAllConnections();
    });
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "al-tls-"));
  dirs.push(d);
  return d;
}

function newStore(dir = join(tmp(), "tls"), s = "placeholder"): CertStore {
  return new CertStore({ domain: DOMAIN, dir, placeholder: placeholderMaterial(DOMAIN, ed25519KeyFromSeed(seed(s))) });
}

async function serve(store: CertStore): Promise<number> {
  const srv = tlsListenMode(store).createServer((_req, res) => res.end("ok"));
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const a = srv.address() as { port: number };
  return a.port;
}

class Timers {
  pending = new Map<number, { fn: () => void; ms: number }>();
  private n = 0;
  set(fn: () => void, ms: number): unknown {
    this.pending.set(++this.n, { fn, ms });
    return this.n;
  }
  clear(h: unknown): void {
    this.pending.delete(h as number);
  }
  fire(): void {
    const all = [...this.pending.entries()];
    for (const [id, t] of all) {
      this.pending.delete(id);
      t.fn();
    }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

// ---------------------------------------------------------------------------

describe("x509: calendar math + builder", () => {
  it("days_from_civil / civil_from_days agree with known instants and round-trip", () => {
    expect(daysFromCivil(1970n, 1n, 1n)).toBe(0n);
    expect(daysFromCivil(2026n, 1n, 1n) * 86_400n).toBe(PLACEHOLDER_NOT_BEFORE);
    expect(daysFromCivil(9999n, 12n, 31n) * 86_400n + 86_399n).toBe(PLACEHOLDER_NOT_AFTER);
    expect(civilFromUnix(951_782_400n)).toEqual({ y: 2000n, m: 2n, d: 29n, hh: 0n, mm: 0n, ss: 0n }); // leap day
    for (const t of [0n, 68_169_600n, 1_790_000_000n, 4_102_444_799n, 253_402_300_799n]) {
      const c = civilFromUnix(t);
      expect(daysFromCivil(c.y, c.m, c.d) * 86_400n + c.hh * 3600n + c.mm * 60n + c.ss).toBe(t);
    }
  });

  it("parseOpenSslTime parses node's validTo format (space-padded day)", () => {
    expect(parseOpenSslTime("Jan  1 00:00:00 2026 GMT")).toBe(PLACEHOLDER_NOT_BEFORE);
    expect(parseOpenSslTime("Dec 31 23:59:59 9999 GMT")).toBe(PLACEHOLDER_NOT_AFTER);
    expect(() => parseOpenSslTime("2026-01-01T00:00:00Z")).toThrow(/unparseable/);
  });

  it("builds a v3 cert node parses + verifies; UTCTime ≤ 2049, GeneralizedTime after; SAN + CN set", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    const pem = derToPem(
      buildCertificateDer({
        subjectSpkiDer: spki, issuerKey: privateKey, issuerCommonName: "x", subjectCommonName: DOMAIN, dnsNames: [DOMAIN],
        serial: Buffer.from([0x01, 0x02]), notBefore: 1_790_000_000n, notAfter: 2_600_000_000n, // 2052 ⇒ GeneralizedTime
      }),
    );
    const x = new X509Certificate(pem);
    expect(x.verify(createPublicKey(privateKey))).toBe(true);
    expect(x.subjectAltName).toBe(`DNS:${DOMAIN}`);
    expect(x.subject).toBe(`CN=${DOMAIN}`);
    expect(x.serialNumber.toLowerCase()).toBe("0102");
    expect(parseOpenSslTime(x.validFrom)).toBe(1_790_000_000n);
    expect(certNotAfter(pem)).toBe(2_600_000_000n);
    expect(x.checkHost(DOMAIN)).toBe(DOMAIN);
  });

  it("refuses a non-Ed25519 issuer and an inverted validity", () => {
    const { privateKey: ec } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spki = createPublicKey(ec).export({ type: "spki", format: "der" });
    const base = { subjectSpkiDer: spki, issuerCommonName: "x", subjectCommonName: "x", dnsNames: [], serial: Buffer.from([1]) };
    expect(() => buildCertificateDer({ ...base, issuerKey: ec, notBefore: 0n, notAfter: 1n })).toThrow(/Ed25519/);
    const { privateKey: ed } = generateKeyPairSync("ed25519");
    expect(() => buildCertificateDer({ ...base, issuerKey: ed, notBefore: 5n, notAfter: 5n })).toThrow(/notAfter/);
  });
});

describe("keys: KMS-seeded, deterministic", () => {
  it("ACME account key: same seed ⇒ same P-256 key (revival keeps the ACME account); acme-client accepts it", () => {
    const a = acmeAccountKeyPem(seed("acme"));
    expect(acmeAccountKeyPem(seed("acme"))).toBe(a);
    expect(acmeAccountKeyPem(seed("acme-2"))).not.toBe(a);
    expect(p256KeyFromSeed(seed("acme")).asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    const jwk = acmeClient.crypto.getJwk(a) as { kty: string; crv: string };
    expect(jwk).toMatchObject({ kty: "EC", crv: "P-256" });
  });

  it("seed of the wrong length is refused; out-of-range scalars are reduced into [1, n−1]", () => {
    expect(() => p256KeyFromSeed("0x1234")).toThrow(/32 bytes/);
    expect(() => ed25519KeyFromSeed("0x1234")).toThrow(/32 bytes/);
    expect(p256KeyFromSeed(`0x${"ff".repeat(32)}`).type).toBe("private");
    expect(p256KeyFromSeed(`0x${"00".repeat(32)}`).type).toBe("private");
  });
});

describe("placeholder: deterministic self-signed from the KMS-derived Ed25519 key", () => {
  it("same seed ⇒ byte-identical cert + key (restarts never churn); different seed ⇒ different", () => {
    const a = placeholderMaterial(DOMAIN, ed25519KeyFromSeed(seed("p")));
    const b = placeholderMaterial(DOMAIN, ed25519KeyFromSeed(seed("p")));
    expect(b).toEqual(a);
    const c = placeholderMaterial(DOMAIN, ed25519KeyFromSeed(seed("q")));
    expect(c.certPem).not.toBe(a.certPem);
    const x = new X509Certificate(a.certPem);
    expect(x.verify(x.publicKey)).toBe(true); // self-signed
    expect(x.checkHost(DOMAIN)).toBe(DOMAIN);
    expect(parseOpenSslTime(x.validFrom)).toBe(PLACEHOLDER_NOT_BEFORE);
    expect(certNotAfter(a.certPem)).toBe(PLACEHOLDER_NOT_AFTER);
  });

  it("SPKI sha256 = sha256(DER SubjectPublicKeyInfo) of the placeholder key", () => {
    const key = ed25519KeyFromSeed(seed("p"));
    const m = placeholderMaterial(DOMAIN, key);
    const manual = `0x${createHash("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("hex")}`;
    expect(certSpkiSha256(m.certPem)).toBe(manual);
    expect(keySpkiSha256(key)).toBe(manual);
  });
});

describe("renewal math + domain", () => {
  it("due iff no cert, or < 30 d remain", () => {
    expect(RENEW_BEFORE_SEC).toBe(30n * DAY);
    expect(renewalDue(null, NOW)).toBe(true);
    expect(renewalDue(NOW + 90n * DAY, NOW)).toBe(false);
    expect(renewalDue(NOW + 30n * DAY, NOW)).toBe(false);
    expect(renewalDue(NOW + 30n * DAY - 1n, NOW)).toBe(true);
    expect(renewalDue(NOW - 1n, NOW)).toBe(true);
  });

  it("domain = a<agentId>.<agentDnsRoot>, lowercase; malformed roots refused", () => {
    expect(agentDomain(7, "agents.example.test")).toBe(DOMAIN);
    expect(agentDomain(12, "Agents.Example.TEST.")).toBe("a12.agents.example.test");
    for (const bad of ["localhost", "", "bad_label.example", "-x.example", "x..example"]) expect(() => agentDomain(1, bad), bad).toThrow(/hostname/);
    expect(() => agentDomain(0, "agents.example.test")).toThrow(/agentId/);
  });
});

describe("CertStore + tls listen mode: SNI three-way over real handshakes", () => {
  it("placeholder before issuance; ALPN http/1.1 for ordinary clients; no-SNI handshakes are refused (no default cert)", async () => {
    const store = newStore();
    const port = await serve(store);
    const p = await handshake(port, DOMAIN, ["h2", "http/1.1"]);
    expect(p.spkiSha256).toBe(store.current().spkiSha256);
    expect(p.cert.raw.equals(new X509Certificate(store.current().material.certPem).raw)).toBe(true);
    expect(p.alpn).toBe("http/1.1");
    expect(store.current().kind).toBe("placeholder");
    await expect(handshake(port, undefined)).rejects.toThrow(/handshake failure|HANDSHAKE_FAILURE/i);
    // any other SNI name gets the placeholder too (never a challenge cert)
    expect((await handshake(port, "a8.agents.example.test")).spkiSha256).toBe(store.current().spkiSha256);
  });

  it("challenge cert ONLY for the exact SNI name while pending; acme-tls/1 negotiated; acme-client validates it", async () => {
    const store = newStore();
    const port = await serve(store);
    const authz = { identifier: { type: "dns", value: DOMAIN } };
    const ka = "token-1.thumbprint";
    const { keyPem, certPem } = await (await import("../../src/tls/acme.js")).realAcme.createAlpnCertificate(authz, ka);
    store.setChallenge(DOMAIN.toUpperCase(), { keyPem, certPem });
    const ch = await handshake(port, DOMAIN, [ACME_TLS_ALPN]);
    expect(ch.alpn).toBe(ACME_TLS_ALPN);
    expect(acmeClient.crypto.isAlpnCertificateAuthorizationValid(ch.cert.toString(), ka)).toBe(true);
    expect(store.select(DOMAIN).kind).toBe("challenge");
    // other names never see it
    const other = await handshake(port, "other.example.test");
    expect(other.spkiSha256).toBe(store.current().spkiSha256);
    store.clearChallenge(DOMAIN);
    const after = await handshake(port, DOMAIN, [ACME_TLS_ALPN]);
    expect(() => acmeClient.crypto.isAlpnCertificateAuthorizationValid(after.cert.toString(), ka)).toThrow(/ALPN extension/);
    expect(after.spkiSha256).toBe(store.current().spkiSha256);
  });

  it("issued cert replaces the placeholder live, is persisted 0600 and reloaded", async () => {
    const dir = join(tmp(), "tls");
    const store = newStore(dir);
    const port = await serve(store);
    const placeholderSpki = store.current().spkiSha256;
    const acme = fakeAcme({ validity: () => ({ notBefore: NOW - DAY, notAfter: NOW + 90n * DAY }) });
    const issued = await issueCertificate({ domain: DOMAIN, directoryUrl: "https://acme.invalid/dir", accountKeyPem: acmeAccountKeyPem(seed("acme")), challenges: store, acme });
    store.saveIssued(issued);
    expect(store.current().kind).toBe("issued");
    expect(store.issuedNotAfter()).toBe(NOW + 90n * DAY);
    const sni = await handshake(port, DOMAIN);
    expect(sni.spkiSha256).toBe(store.current().spkiSha256);
    expect(sni.spkiSha256).not.toBe(placeholderSpki);
    expect(sni.cert.issuer).toBe("CN=Fake ACME Test CA");
    for (const f of [TLS_CERT_FILE, TLS_KEY_FILE]) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, TLS_KEY_FILE), "utf8")).toBe(issued.keyPem);

    const reloaded = newStore(dir);
    expect(reloaded.loadPersisted(NOW, quiet)).toBe(true);
    expect(reloaded.current().spkiSha256).toBe(store.current().spkiSha256);
    // expired at load time ⇒ placeholder
    const late = newStore(dir);
    expect(late.loadPersisted(NOW + 91n * DAY, quiet)).toBe(false);
    expect(late.current().kind).toBe("placeholder");
  });

  it("persisted material that is corrupt, mismatched or for another domain is ignored (placeholder served)", () => {
    const dir = join(tmp(), "tls");
    const store = newStore(dir);
    const other = placeholderMaterial("a8.agents.example.test", ed25519KeyFromSeed(seed("o")));
    expect(() => store.saveIssued(other)).toThrow(/does not cover/);
    const mine = placeholderMaterial(DOMAIN, ed25519KeyFromSeed(seed("m")));
    expect(() => store.saveIssued({ certPem: mine.certPem, keyPem: other.keyPem })).toThrow(/mismatch/);
    expect(existsSync(dir)).toBe(false);
    store.saveIssued(mine); // (self-signed, but a consistent pair for the domain)
    writeFileSync(join(dir, TLS_CERT_FILE), "garbage");
    const warns: string[] = [];
    const s2 = newStore(dir);
    expect(s2.loadPersisted(NOW, { ...quiet, warn: (m) => warns.push(m) })).toBe(false);
    expect(s2.current().kind).toBe("placeholder");
    expect(warns.join()).toMatch(/ignoring unusable persisted certificate/);
  });
});

describe("issueCertificate (acme-client mocked at the module seam)", () => {
  it("one TLS-ALPN-01 order: KMS account key + directory passed through, challenge cert live during the challenge, removed after", async () => {
    const store = newStore();
    const port = await serve(store);
    const seen: string[] = [];
    const acme = fakeAcme({
      validity: () => ({ notBefore: NOW, notAfter: NOW + 90n * DAY }),
      onChallenge: async (domain, ka) => {
        const p = await handshake(port, domain, [ACME_TLS_ALPN]);
        seen.push(acmeClient.crypto.isAlpnCertificateAuthorizationValid(p.cert.toString(), ka) ? "valid" : "invalid");
      },
    });
    const accountKeyPem = acmeAccountKeyPem(seed("acme"));
    const r = await issueCertificate({ domain: DOMAIN, directoryUrl: LETS_ENCRYPT_PRODUCTION, accountKeyPem, challenges: store, acme });
    expect(seen).toEqual(["valid"]);
    expect(acme.clients).toEqual([{ directoryUrl: LETS_ENCRYPT_PRODUCTION, accountKey: accountKeyPem }]);
    const opts = acme.orders[0]!.opts;
    expect(opts.challengePriority).toEqual([TLS_ALPN_01]);
    expect(opts.termsOfServiceAgreed).toBe(true);
    expect(opts.skipChallengeVerification).toBe(false);
    expect(acmeClient.crypto.readCsrDomains(opts.csr)).toMatchObject({ commonName: DOMAIN, altNames: [DOMAIN] });
    expect(store.select(DOMAIN).kind).toBe("placeholder"); // challenge removed
    expect(r.notAfter).toBe(NOW + 90n * DAY);
    expect(new X509Certificate(r.certPem).checkPrivateKey(createPrivateKey(r.keyPem))).toBe(true);
  });

  it("refuses any non-ALPN challenge (http-01 / dns-01) and an authorization for another name", async () => {
    const store = newStore();
    for (const t of ["http-01", "dns-01"]) {
      const acme = fakeAcme({ validity: () => ({ notBefore: NOW, notAfter: NOW + 90n * DAY }), challengeType: t });
      await expect(issueCertificate({ domain: DOMAIN, directoryUrl: "https://acme.invalid", accountKeyPem: acmeAccountKeyPem(seed("a")), challenges: store, acme })).rejects.toThrow(/TLS-ALPN-01 only/);
    }
    const wrong = fakeAcme({ validity: () => ({ notBefore: NOW, notAfter: NOW + 90n * DAY }), authzDomain: "evil.example.test" });
    await expect(issueCertificate({ domain: DOMAIN, directoryUrl: "https://acme.invalid", accountKeyPem: acmeAccountKeyPem(seed("a")), challenges: store, acme: wrong })).rejects.toThrow(/expected a7/);
    expect(store.select(DOMAIN).kind).toBe("placeholder");
  });
});

describe("TlsManager: first-issuance loop + renewal hook", () => {
  function manager(acme: ReturnType<typeof fakeAcme>, store = newStore(), now = { t: NOW }) {
    const timers = new Timers();
    let derives = 0;
    const m = new TlsManager({
      store,
      directoryUrl: "https://acme.invalid/dir",
      accountKeyPem: async () => {
        derives += 1;
        return acmeAccountKeyPem(seed("acme"));
      },
      clock: () => now.t,
      timers,
      logger: quiet,
      acme,
      retrySec: 60n,
    });
    return { m, timers, store, derives: () => derives };
  }

  it("start(): failure ⇒ placeholder stays + retry armed (retrySec); retry success ⇒ issued, no further retry", async () => {
    const acme = fakeAcme({ validity: () => ({ notBefore: NOW, notAfter: NOW + 90n * DAY }), failWith: (n) => (n === 0 ? new Error("dns not pointed yet") : undefined) });
    const { m, timers, store } = manager(acme);
    m.start();
    await vi.waitFor(() => expect(timers.pending.size).toBe(1));
    expect(store.current().kind).toBe("placeholder");
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([60_000]);
    timers.fire();
    await vi.waitFor(() => expect(store.current().kind).toBe("issued"));
    expect(timers.pending.size).toBe(0);
    expect(m.renewalDue(NOW)).toBe(false);
    expect(m.spkiSha256()).toBe(store.current().spkiSha256);
  });

  it("start() with a valid persisted cert does nothing; stop() cancels a pending retry", async () => {
    const acme = fakeAcme({ validity: () => ({ notBefore: NOW, notAfter: NOW + 90n * DAY }), failWith: () => new Error("down") });
    const { m, timers } = manager(acme);
    m.start();
    await vi.waitFor(() => expect(timers.pending.size).toBe(1));
    await m.stop();
    expect(timers.pending.size).toBe(0);

    const ok = fakeAcme({ validity: () => ({ notBefore: NOW, notAfter: NOW + 90n * DAY }) });
    const a = manager(ok);
    await a.m.renew();
    const b = manager(ok, (() => {
      const s = new CertStore({ domain: DOMAIN, dir: a.store.dir, placeholder: placeholderMaterial(DOMAIN, ed25519KeyFromSeed(seed("placeholder"))) });
      s.loadPersisted(NOW, quiet);
      return s;
    })());
    const orders = ok.orders.length;
    b.m.start();
    await flush();
    expect(ok.orders.length).toBe(orders);
    expect(b.timers.pending.size).toBe(0);
  });

  it("renew() deduplicates concurrent calls (one ACME order)", async () => {
    const acme = fakeAcme({ validity: () => ({ notBefore: NOW, notAfter: NOW + 90n * DAY }) });
    let release!: () => void;
    acme.gate = new Promise<void>((r) => (release = r));
    const { m } = manager(acme);
    const p1 = m.renew();
    const p2 = m.renew();
    expect(p2).toBe(p1);
    release();
    expect(await p1).toMatch(/certificate issued for a7\.agents\.example\.test/);
    expect(acme.orders).toHaveLength(1);
  });

  it("daemon step 10: appended only when the hook is wired; skipped while valid, renews when < 30 d remain", async () => {
    const plain = await daemonHarness();
    const r0 = await tick(plain.deps, NOW);
    expect(r0.steps.map((s) => s.step)).not.toContain("tlsRenewal");

    const now = { t: NOW };
    const acme = fakeAcme({ validity: (n) => ({ notBefore: NOW, notAfter: NOW + (n === 0 ? 40n : 130n) * DAY }) });
    const { m, store } = manager(acme, newStore(), now);
    await m.renew(); // cert valid 40 days
    const h = await daemonHarness();
    const deps = { ...h.deps, tlsRenewal: m };
    const r1 = await tick(deps, NOW);
    expect(r1.steps.at(-1)).toEqual({ step: "tlsRenewal", status: "skipped", reason: "certificate valid for ≥ 30 days" });
    now.t = NOW + 11n * DAY; // 29 days left
    const r2 = await tick(deps, now.t);
    const s = r2.steps.at(-1)!;
    expect(s.step).toBe("tlsRenewal");
    expect(s.status).toBe("ran");
    expect(acme.orders).toHaveLength(2);
    expect(store.issuedNotAfter()).toBe(NOW + 130n * DAY);
    expect(acme.clients.map((c) => c.accountKey)).toEqual([acmeAccountKeyPem(seed("acme")), acmeAccountKeyPem(seed("acme"))]); // same ACME account
  });

  it("daemon step 10: a failing renewal is a step error, later steps unaffected", async () => {
    const acme = fakeAcme({ validity: () => ({ notBefore: NOW, notAfter: NOW + 90n * DAY }), failWith: () => new Error("acme 503") });
    const { m } = manager(acme);
    const h = await daemonHarness();
    const r = await tick({ ...h.deps, tlsRenewal: m }, NOW);
    expect(r.steps.at(-1)).toMatchObject({ step: "tlsRenewal", status: "error", error: "acme 503" });
    expect(r.steps.find((x) => x.step === "heartbeat")?.status).toBe("ran");
  });
});
