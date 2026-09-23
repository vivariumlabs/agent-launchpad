// SPEC-M3B §2 test helpers (not a test file): fake ACME protocol client at the acme.ts module seam
// (real acme-client crypto for keys / CSR / ALPN challenge certs; a fake Ed25519 test CA issues),
// and a raw TLS handshake probe.

import { createHash, createPublicKey, generateKeyPairSync, X509Certificate, type KeyObject } from "node:crypto";
import tls from "node:tls";
import * as acmeClient from "acme-client";
import { realAcme, type AcmeApi, type AcmeAutoOptions, type AcmeAuthz } from "../../src/tls/acme.js";
import { buildCertificateDer, derToPem } from "../../src/tls/x509.js";

export const DAY = 86_400n;

export interface FakeAcmeOptions {
  /** Validity of issued certs: [notBefore, notAfter] as a function of the order index. */
  validity: (order: number) => { notBefore: bigint; notAfter: bigint };
  /** Challenge type the fake CA offers (DEFAULT tls-alpn-01). */
  challengeType?: string;
  /** Authorization identifier override (DEFAULT the CSR's common name). */
  authzDomain?: string;
  /** Called while the challenge cert is installed (e.g. a real handshake probe). */
  onChallenge?: (domain: string, keyAuthorization: string) => Promise<void>;
  /** Orders fail (thrown from auto) while this returns an Error. */
  failWith?: (order: number) => Error | undefined;
}

export interface FakeAcme extends AcmeApi {
  readonly ca: { key: KeyObject; certPem: string };
  readonly clients: Array<{ directoryUrl: string; accountKey: string }>;
  readonly orders: Array<{ domain: string; keyAuthorization: string; opts: AcmeAutoOptions }>;
  /** Hold every auto() until release() (to observe in-flight state). */
  gate: Promise<void> | null;
}

export function fakeAcme(o: FakeAcmeOptions): FakeAcme {
  const { privateKey: caKey } = generateKeyPairSync("ed25519");
  const caSpki = createPublicKey(caKey).export({ type: "spki", format: "der" });
  const caCertPem = derToPem(
    buildCertificateDer({
      subjectSpkiDer: caSpki,
      issuerKey: caKey,
      issuerCommonName: "Fake ACME Test CA",
      subjectCommonName: "Fake ACME Test CA",
      dnsNames: [],
      serial: Buffer.from([0x11]),
      notBefore: 0n,
      notAfter: 4_000_000_000n,
      isCa: true,
    }),
  );
  let lastKey: Buffer | undefined;
  let orderN = 0;
  const f: FakeAcme = {
    ca: { key: caKey, certPem: caCertPem },
    clients: [],
    orders: [],
    gate: null,
    createClient(opts) {
      f.clients.push(opts);
      return {
        async auto(a: AcmeAutoOptions): Promise<string> {
          const n = orderN++;
          if (f.gate !== null) await f.gate;
          const err = o.failWith?.(n);
          if (err !== undefined) throw err;
          const csrDomains = acmeClient.crypto.readCsrDomains(a.csr);
          const domain = o.authzDomain ?? csrDomains.commonName;
          const authz: AcmeAuthz = { identifier: { type: "dns", value: domain } };
          const challenge = { type: o.challengeType ?? "tls-alpn-01" };
          const keyAuthorization = `tok${n}.thumbprint-${createHash("sha256").update(opts.accountKey).digest("hex").slice(0, 16)}`;
          f.orders.push({ domain, keyAuthorization, opts: a });
          try {
            await a.challengeCreateFn(authz, challenge, keyAuthorization);
            await o.onChallenge?.(domain, keyAuthorization);
          } finally {
            await a.challengeRemoveFn(authz, challenge, keyAuthorization);
          }
          if (lastKey === undefined) throw new Error("fake acme: no key generated");
          const v = o.validity(n);
          const leaf = buildCertificateDer({
            subjectSpkiDer: createPublicKey(lastKey.toString()).export({ type: "spki", format: "der" }),
            issuerKey: caKey,
            issuerCommonName: "Fake ACME Test CA",
            subjectCommonName: domain,
            dnsNames: [domain],
            serial: Buffer.from([0x20 + n]),
            notBefore: v.notBefore,
            notAfter: v.notAfter,
          });
          return derToPem(leaf) + caCertPem;
        },
      };
    },
    async createPrivateEcdsaKey() {
      lastKey = await realAcme.createPrivateEcdsaKey();
      return lastKey;
    },
    createCsr: (domain, key) => realAcme.createCsr(domain, key),
    createAlpnCertificate: (authz, ka) => realAcme.createAlpnCertificate(authz, ka),
  };
  return f;
}

export interface Probe {
  cert: X509Certificate;
  alpn: string | false;
  spkiSha256: string;
}

/** One TLS handshake to 127.0.0.1:port with SNI `servername` (no verification — pinning is the caller's job). */
export function handshake(port: number, servername: string | undefined, alpn?: string[]): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({
      port,
      host: "127.0.0.1",
      ...(servername !== undefined ? { servername } : {}),
      ...(alpn !== undefined ? { ALPNProtocols: alpn } : {}),
      rejectUnauthorized: false,
    });
    s.once("error", reject);
    s.once("secureConnect", () => {
      const cert = s.getPeerX509Certificate();
      const alpnProtocol = s.alpnProtocol ?? false;
      s.end();
      if (cert === undefined) return reject(new Error("no peer cert"));
      const spki = cert.publicKey.export({ type: "spki", format: "der" });
      resolve({ cert, alpn: alpnProtocol, spkiSha256: `0x${createHash("sha256").update(spki).digest("hex")}` });
    });
  });
}
