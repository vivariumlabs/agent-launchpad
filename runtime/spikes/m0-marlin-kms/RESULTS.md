# M0-1 drill RESULTS — 2026-09-22 — ALL PASS ✅

Setup: `fixed-a.yml` (drill app: serves sha256 of the key from in-enclave `GET 127.0.0.1:1100/derive/secp256k1?path=drill`; never exposes the key), `fixed-b.yml` (one-line modification), agent-id passed as attested init param (`agent-id:1:0:utf8:agent-000N`). Deploys: `oyster-cvm deploy`, wallet-only, Arbitrum One, default arm64 "blue" preset (AWS Nitro Enclaves; attestation on :1300).

| Variant | Job | Image-id | Key hash served |
|---|---|---|---|
| A1: compose-A + agent-0001 | 0x…3196 | `28e981ac…8238eb` | `6f644fee…529a` |
| A2: identical, simultaneous instance | 0x…3197 | `28e981ac…8238eb` | `6f644fee…529a` ✅ same |
| A3: identical, deployed AFTER A1/A2 died | 0x…319a | `28e981ac…8238eb` | `6f644fee…529a` ✅ same across kill/redeploy |
| B: modified compose + agent-0001 | 0x…3198 | `7495b47f…2aaed0` | `9cda2037…fb056` ✅ different |
| C: compose-A + agent-0002 | 0x…3199 | `4c1bd654…37ced4` | `8a50254a…97f4db` ✅ different |

Assertions proven: same (image, agentId) ⇒ same key, for any deployer, across instance death; modified code ⇒ different key; different agentId ⇒ different key. Exactly the D5/D6/D10 load-bearing property, with agentId carried as attested user data.

Additional evidence:
- **Remote attestation verified** (`oyster-cvm verify`) against the offline-computed image-id for the old-compose A instance and production A2 — Nitro root of trust, "Verification successful ✓".
- **Public determinism**: `oyster-cvm kms-derive --image-id <id> --path drill --key-type secp256k1/address/ethereum` returns distinct deterministic addresses per image-id with no deployment (A: `0x03e382a0…`, B: `0x534b03ba…`, C: `0x8019e047…`).
- **Pricing pinned**: 0.0512 USDC/hour for the default small arm64 instance ≈ **$37/month**; total drill spend ≈ 0.4 USDC + dust ETH gas. IP lookup: provider control plane `GET <cp>/ip?id=<jobId>&region=<region>`; CP URL from `https://indexer.oyster.marlin.org/graphql` (`providerById { cp }`).
- Gotcha for M2/M3: query the derive server with a retry loop — it comes up slightly after containers start (first attempt without retry crash-looped and never bound :8080).
- Note: default preset runs on AWS Nitro Enclaves (PCR measurement), not TDX — trust model documented accordingly.
