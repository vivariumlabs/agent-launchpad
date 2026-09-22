# M0-1 drill runbook — Nautilus KMS key derivation on Marlin Oyster (D5)

**Goal (07 §M0.1):** prove Nautilus Image-variant binding — application = (enclave measurement, user data):
same image + same user data ⇒ same derived key across kill/redeploy (by any wallet);
modified image ⇒ different key; same image + different user data (agentId stand-in) ⇒ different key.
Also: pin live rental pricing, probe disk persistence across restart.

**Needs Juan:** ~$5 USDC + 0.005 ETH on **Arbitrum One** to a throwaway wallet Claude generates, plus explicit OK to spend on rentals. No account, no signup, no KYC — deploys are wallet-only.

## Steps (Claude runs all of it)

1. Install `oyster-cvm` CLI (artifacts.marlin.org binaries).
2. Hello-world app: minimal HTTP server that requests a derived key from the in-enclave Nautilus endpoint (exact derive API per docs.marlin.org/oyster/nautilus at drill time) and prints the derived address + image id.
3. Deploy A: `oyster-cvm deploy --wallet-private-key <k> --duration-in-minutes 20 --docker-compose compose.yml` with user data `agent-0001`. Record address **A1**; `oyster-cvm verify --enclave-ip <ip> --image-id <id>`.
4. Kill (let expire or stop). Redeploy identical image + user data. Record **A2**.
5. Deploy modified image (one-byte change). Record **B1**.
6. Deploy original image, user data `agent-0002`. Record **C1**.
7. **Pass criteria:** A1 == A2; B1 != A1; C1 != A1. Write a file to disk in step 3, check survival after in-place restart (persistence note, informational).
8. Record addresses, image ids, tx hashes, per-hour price observed, into BUILD-STATE.md evidence.

## Doc basis (2026-09-22)

Nautilus goals (docs.marlin.org/oyster/nautilus): secrets persist across restarts; copies of the same application derive the same secrets; Image variant defines application by enclave PCRs + user data; Contract variant enables contract-approved upgrades (candidate for the D5 timelock option). Quickstart confirms wallet-only deploys (USDC + ETH on Arbitrum One).
