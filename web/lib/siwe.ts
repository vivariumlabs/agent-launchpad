/**
 * SPEC-M4C §2 / R6 — SIWE (EIP-4361) message builder for the chat tab.
 *
 * MUST byte-match the grammar runtime/src/chat/siwe.ts parses + verifies:
 *
 *   <domain> wants you to sign in with your Ethereum account:   (no scheme prefix)
 *   <address>                                                   EIP-55 checksummed
 *   ""
 *   <statement>                                                 single line, non-empty
 *   ""
 *   URI: <uri>                                                  endpoint origin
 *   Version: 1
 *   Chain ID: 46630
 *   Nonce: <nonce>                                              verbatim from GET /nonce
 *   Issued At: <RFC 3339>                                       Date#toISOString()
 *
 * LF line endings only, no trailing newline, no optional fields (Expiration Time /
 * Not Before / Request ID / Resources are all omitted).
 *
 * The golden cross-test runtime/test/chat/web-siwe-golden.test.ts INLINES a copy of
 * buildSiweMessage + siweFieldsForEndpoint — keep the two in sync by hand.
 */
import { getAddress } from "viem";

export const SIWE_HEADER_SUFFIX = " wants you to sign in with your Ethereum account:";

/** Runtime DOMAIN_RE (siwe.ts): host[:port], no brackets / underscores / userinfo. */
const DOMAIN_RE = /^[a-zA-Z0-9.\-]+(:[0-9]{1,5})?$/;
/** Runtime NONCE_RE. */
const NONCE_RE = /^[a-zA-Z0-9]{8,}$/;

export interface SiweInput {
  /** Endpoint host (with port when non-default) — must equal the agent's frozen cfg.chatDomain. */
  domain: string;
  address: string;
  statement: string;
  /** Endpoint origin. */
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: Date;
}

/** Statement line (single line, no LF). */
export function siweStatement(agentId: number): string {
  return `Sign in to chat with agent #${agentId}. This signature proves wallet ownership only; it cannot move funds.`;
}

/** SIWE domain + uri for an endpoint origin: domain = URL.host (port kept only if non-default), uri = URL.origin. */
export function siweFieldsForEndpoint(endpoint: string): { domain: string; uri: string } {
  const u = new URL(endpoint);
  return { domain: u.host, uri: u.origin };
}

export function buildSiweMessage(input: SiweInput): string {
  if (!DOMAIN_RE.test(input.domain)) throw new Error(`SIWE: domain "${input.domain}" is not host[:port]`);
  if (!NONCE_RE.test(input.nonce)) throw new Error("SIWE: nonce must be ≥8 alphanumerics");
  if (input.statement === "" || input.statement.includes("\n")) throw new Error("SIWE: statement must be one non-empty line");
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error("SIWE: bad chainId");
  const issued = input.issuedAt.getTime();
  if (!Number.isFinite(issued)) throw new Error("SIWE: bad issuedAt");
  return [
    `${input.domain}${SIWE_HEADER_SUFFIX}`,
    getAddress(input.address),
    "",
    input.statement,
    "",
    `URI: ${input.uri}`,
    "Version: 1",
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
  ].join("\n");
}
