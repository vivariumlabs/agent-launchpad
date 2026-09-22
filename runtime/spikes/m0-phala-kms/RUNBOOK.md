# M0-1 drill runbook — Phala KMS key derivation bound to code hash

**Goal (07 §M0.1):** same image ⇒ same derived key across kill/redeploy; modified image ⇒ different key.

**Blocked on Juan:** a Phala Cloud account with billing (Claude cannot create accounts). Once it exists, share an API token and this drill is ~30 min.

## Steps

1. `cd app && docker build -t m0-kms-drill .` — push to a registry, record the **digest**.
2. Put the digest in `docker-compose.yml`, deploy on Phala Cloud (dstack CVM, KMS enabled), `KEY_VARIANT=v1`.
3. `curl https://<cvm-endpoint>:8080/` → record `derived_address` (call it **A1**) and `compose_hash`.
4. Destroy the CVM. Redeploy the identical compose. Record **A2**.
5. Change `KEY_VARIANT=v2` (this changes the compose hash), deploy. Record **B1**.
6. **Pass criteria:** A1 == A2, B1 != A1. Paste all three addresses + compose hashes into BUILD-STATE.md evidence.

## What we already know from docs (2026-09-22)

dstack KMS derives deterministic keys bound to the app's attested identity (compose hash is part of it); keys are not tied to specific TEE hardware, so an app redeployed with the same compose gets the same keys — this is exactly the property D5/D6 and revival (D10) depend on. Docs: docs.phala.com/dstack/overview, Phala-Network/dstack-cloud on GitHub.
