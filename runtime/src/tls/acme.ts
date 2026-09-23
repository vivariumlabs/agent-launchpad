// SPEC-M3B §2 / docs/TLS-INGRESS.md — in-enclave ACME, TLS-ALPN-01 ONLY.
//
//   domain       = a<agentId>.<frozen platform.agentDnsRoot>   (frozen: spend-adjacent identity)
//   account key  = P-256 from KMS derive("acme") (keyring.acmeAccountKey) ⇒ same ACME account
//                  across revivals; the issued-cert key is generated fresh per issuance (below)
//                  and never leaves /data/tls.
//   directory    = ops runtime.tls.acmeDirectoryUrl (DEFAULT Let's Encrypt production)
//   renewal      = when < RENEW_BEFORE_SEC (30 d) remain — daemon step 10 (tlsRenewalDue hook)
//
// Hygiene allowlist: this is the ONLY file in src/tls that talks to the network — through
// acme-client (ACME directory + its own pre-flight TLS-ALPN self-check). acme-client's key/CSR
// generation uses node:crypto randomness internally; this module adds none of its own.
// The acme-client module is injectable at the `AcmeApi` seam (tests mock the protocol client).

import { createPrivateKey, X509Certificate } from "node:crypto";
import * as acmeClient from "acme-client";
import type { UnixSeconds } from "../policy/types.js";
import { certNotAfter } from "./x509.js";

export const LETS_ENCRYPT_PRODUCTION = "https://acme-v02.api.letsencrypt.org/directory";
export const LETS_ENCRYPT_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";
/** DEFAULT: renew when fewer than 30 days of validity remain. */
export const RENEW_BEFORE_SEC = 30n * 86_400n;
export const TLS_ALPN_01 = "tls-alpn-01";

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** a<agentId>.<agentDnsRoot>, lowercase; throws on a malformed root. */
export function agentDomain(agentId: number, agentDnsRoot: string): string {
  if (!Number.isSafeInteger(agentId) || agentId <= 0) throw new Error(`tls: bad agentId ${agentId}`);
  const root = agentDnsRoot.toLowerCase().replace(/\.$/, "");
  const labels = root.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) throw new Error(`tls: agentDnsRoot ${JSON.stringify(agentDnsRoot)} is not a hostname`);
  const domain = `a${agentId.toString(10)}.${root}`;
  if (domain.length > 253) throw new Error("tls: domain too long");
  return domain;
}

/** Due iff no issued cert, or fewer than `windowSec` seconds of validity remain. */
export function renewalDue(notAfter: bigint | null, now: UnixSeconds, windowSec: bigint = RENEW_BEFORE_SEC): boolean {
  if (notAfter === null) return true;
  return notAfter - now < windowSec;
}

// ---------------------------------------------------------------------------
// module seam
// ---------------------------------------------------------------------------

export interface AcmeAuthz {
  identifier: { type: string; value: string };
}

export interface AcmeChallenge {
  type: string;
}

export interface AcmeAutoOptions {
  csr: Buffer | string;
  termsOfServiceAgreed: boolean;
  challengePriority: string[];
  skipChallengeVerification: boolean;
  challengeCreateFn: (authz: AcmeAuthz, challenge: AcmeChallenge, keyAuthorization: string) => Promise<void>;
  challengeRemoveFn: (authz: AcmeAuthz, challenge: AcmeChallenge, keyAuthorization: string) => Promise<void>;
}

export interface AcmeClientLike {
  auto(opts: AcmeAutoOptions): Promise<string>;
}

/** The subset of acme-client this module uses (tests inject a fake protocol client). */
export interface AcmeApi {
  createClient(opts: { directoryUrl: string; accountKey: string }): AcmeClientLike;
  createPrivateEcdsaKey(): Promise<Buffer>;
  createCsr(domain: string, keyPem: Buffer): Promise<Buffer>;
  createAlpnCertificate(authz: AcmeAuthz, keyAuthorization: string): Promise<{ keyPem: string; certPem: string }>;
}

export const realAcme: AcmeApi = {
  createClient: (opts) => {
    const c = new acmeClient.Client({ directoryUrl: opts.directoryUrl, accountKey: opts.accountKey });
    return { auto: (o) => c.auto(o as unknown as Parameters<typeof c.auto>[0]) };
  },
  createPrivateEcdsaKey: () => acmeClient.crypto.createPrivateEcdsaKey("P-256"),
  createCsr: async (domain, keyPem) => (await acmeClient.crypto.createCsr({ commonName: domain, altNames: [domain] }, keyPem))[1],
  createAlpnCertificate: async (authz, keyAuthorization) => {
    const [k, c] = await acmeClient.crypto.createAlpnCertificate(authz as Parameters<typeof acmeClient.crypto.createAlpnCertificate>[0], keyAuthorization);
    return { keyPem: k.toString(), certPem: c.toString() };
  },
};

// ---------------------------------------------------------------------------
// issuance
// ---------------------------------------------------------------------------

export interface TlsMaterial {
  keyPem: string;
  certPem: string;
}

/** Where challenge certs go while an authorization is pending (CertStore implements it). */
export interface ChallengeSink {
  setChallenge(domain: string, m: TlsMaterial): void;
  clearChallenge(domain: string): void;
}

export interface IssueDeps {
  domain: string;
  directoryUrl: string;
  /** PKCS#8 PEM of the KMS-derived P-256 ACME account key (keys.ts acmeAccountKeyPem). */
  accountKeyPem: string;
  challenges: ChallengeSink;
  acme?: AcmeApi;
}

export interface IssuedCert extends TlsMaterial {
  notAfter: bigint;
}

/**
 * One ACME order for `domain` via TLS-ALPN-01 only (a non-ALPN challenge selected by acme-client
 * is refused in challengeCreateFn ⇒ the order fails). Returns the fresh key + full chain PEM.
 */
export async function issueCertificate(deps: IssueDeps): Promise<IssuedCert> {
  const api = deps.acme ?? realAcme;
  const domain = deps.domain.toLowerCase();
  const client = api.createClient({ directoryUrl: deps.directoryUrl, accountKey: deps.accountKeyPem });
  const certKey = await api.createPrivateEcdsaKey();
  const csr = await api.createCsr(domain, certKey);
  const chain = await client.auto({
    csr,
    termsOfServiceAgreed: true,
    challengePriority: [TLS_ALPN_01],
    // acme-client's pre-flight connects to <domain>:443 with ALPN acme-tls/1 and checks the challenge
    // cert BEFORE telling the CA: DNS-not-yet-pointed fails locally, not against the CA's
    // failed-validation rate limit.
    skipChallengeVerification: false,
    challengeCreateFn: async (authz, challenge, keyAuthorization) => {
      if (challenge.type !== TLS_ALPN_01) throw new Error(`tls: refusing ACME challenge type ${challenge.type} (TLS-ALPN-01 only)`);
      const id = authz.identifier.value.toLowerCase();
      if (id !== domain) throw new Error(`tls: authorization for ${id}, expected ${domain}`);
      deps.challenges.setChallenge(id, await api.createAlpnCertificate(authz, keyAuthorization));
    },
    challengeRemoveFn: async (authz) => {
      deps.challenges.clearChallenge(authz.identifier.value.toLowerCase());
    },
  });
  const keyPem = certKey.toString();
  const leaf = new X509Certificate(chain);
  if (!leaf.checkPrivateKey(createPrivateKey(keyPem))) throw new Error("tls: issued certificate does not match the generated key");
  if (leaf.checkHost(domain) === undefined) throw new Error(`tls: issued certificate does not cover ${domain}`);
  return { keyPem, certPem: chain, notAfter: certNotAfter(chain) };
}
