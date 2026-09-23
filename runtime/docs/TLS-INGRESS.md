# TLS ingress for chat (carry-over (1) from M0 → 03 §5) — design note

**Goal:** HTTPS chat endpoint on the CVM with TLS terminating *inside* the enclave, so neither the platform nor the Oyster provider can read or MITM chat. Verify in M3 on a real CVM.

## Design (primary): in-enclave ACME, per-agent subdomain

1. **Naming.** Platform DNS zone `agents.<platform-domain>`; each agent gets `a<agentId>.agents.<platform-domain>`. At genesis (and on revival/IP change) the orchestrator — or later the indexer watching registry instance records — sets the A record to the enclave IP (from the Oyster control plane `GET <cp>/ip?id=<jobId>`). DNS is the *only* platform-controlled piece, and it can't MITM: it never has the cert key.
2. **ACME inside the enclave.** Runtime derives a deterministic ACME account key via KMS (`derive("acme")`) and runs TLS-ALPN-01 on :443 (no :80 needed; Oyster exposes the enclave IP directly). Cert private key is generated in-enclave and never leaves; stored on the encrypted volume; renewal at 30 days remaining. Rate limits (Let's Encrypt ~50 certs/week/domain) are fine at our scale; ZeroSSL as fallback CA.
3. **Revival:** same agentId ⇒ same ACME account key; new instance re-issues a fresh cert for its subdomain after DNS repoints. Old cert dies with the old instance — no state handoff needed. Registry's single-live-instance rule prevents cert races.
4. **Boot order:** chat server binds :443 with a self-signed placeholder until first issuance completes (retry loop, same pattern as the KMS derive gotcha).

## Fallback / belt-and-suspenders: attestation-bound self-signed

Independent of ACME, the runtime serves `GET /attestation` returning the Nitro attestation document with the TLS cert's SPKI hash in user data. Third-party frontends (03 §5 says the endpoint is public) can verify they're talking to the pinned code hash even if they distrust the CA path. Cheap to implement; do it regardless.

## Rejected

- Platform-terminated TLS/reverse proxy: platform could read chats — violates the trust model.
- caddy/certbot sidecar outside the enclave: same problem.
- HTTP-01: needs :80; ALPN-01 is cleaner on a bare enclave IP.

**M3 verification gate:** issue a real cert on a test CVM, curl from outside with normal CA validation, kill + revive, cert re-issues, attestation endpoint verifies.
