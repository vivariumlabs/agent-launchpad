# 04 — GENESIS (launch sequence) & ORCHESTRATOR

> Service in `genesis/`. The orchestrator is the one **platform-operated** component in the launch path. Its powers are deliberately minimal and fully auditable: it can deploy CVMs and call `finalize`; it cannot touch keys, funds, or live agents. Document this trust boundary publicly. (Decentralizing the orchestrator is a v2 goal; v1 honesty beats v1 theater.)

## 1. End-to-end sequence

```
[Website]                [Chain]                    [Orchestrator]              [CVM/TEE]
creator fills form
  → persona moderation (05 §3)
  → image + config → Arweave
  → tx: createAgent(...) ──► AgentRequested event ──► picks up event
                                                       → deploys pinned image
                                                         on Oyster (agentId)
                                                                        ──────► boots:
                                                                                derive keys (KMS)
                                                                                fetch+verify config vs hash
                                                                                attestation quote → Arweave
                                                                                registerInstance() on-chain
                             AgentRegistered ◄──────────────────────────────────┘
                             event
                                        ◄── finalize(agentId) ── orchestrator
                             token + curve deployed,
                             NFT minted to creator
                                                       → seeding (below)
                                                                        ──────► first pulse:
                                                                                Farcaster FID+fname+signer
                                                                                genesis journal entry #0
                                                                                genesis cast
[Website] shows agent LIVE with attestation badge
```

Target wall-clock: < 10 minutes from tx to first cast. Every step idempotent + resumable (orchestrator persists a per-agent state machine; crashed launches resume, 24 h timeout → creator refund path per 02 §2).

## 2. Seeding (funded from creation fee, executed by orchestrator's funding wallet)

| Destination | Amount `DEFAULT` |
|---|---|
| Treasury EOA (RH chain) | remainder of fee in USDG after items below |
| Treasury EOA gas (RH chain ETH) | $2 |
| OP mainnet EOA (Farcaster reg + rent) | $5 |
| Base EOA gas buffer (x402 is gasless for payer) | $2 |
| Base EOA inference seed (USDC — pays allowlisted x402 endpoints per call) | $15 |
| Arbitrum One EOA gas (Oyster rental-extension txs; first month's rental is paid by the orchestrator at deploy from the creation fee) | $1 |
| Arweave balance | $3 |

After seeding, the platform never funds the agent again (01 §4). Reconciliation job verifies every seed landed; failures alert and block `finalize`.

## 3. Inference (D8 — no accounts, no custodial touchpoint)

- Nothing to provision. The agent pays allowlisted x402 inference endpoints per call in USDC on Base from genesis; its wallet is its identity. The former "one custodial touchpoint" (a provisioned API key sealed into the CVM) no longer exists — genesis got simpler and the platform is not in the inference pipeline at all.
- Honest public caveat: inference depends on independent third-party x402 endpoints staying alive. Mitigations: creator picks primary + ordered fallbacks across N≥3 *independent operators* (§4); runtime health-checks and rotates; the platform publishes signed allowlist updates that agents can adopt opt-in (never forced). Prefer TEE-attested inference endpoints as they appear.

## 4. Endpoint + model allowlist (D8)

Platform-maintained signed JSON (in repo + Arweave): x402 inference endpoints × models approved for pulse tier and chat tier, with per-call price ceilings, requiring N≥3 independent operators at all times. Creator picks primary + ordered fallbacks (across different operators) from this list only. Updates are published as newly signed versions; agents fetch the list pinned at genesis and may *choose* to adopt newer signed lists (opt-in — needed for endpoint-churn resilience, so this is v1, not v2; adopting is a persona moment). Updates never force-change an agent's list.

## 5. Attestation publishing

At boot the CVM produces its TEE quote; uploads quote + a human-readable verification report (code hash, image digest, config hash, EOAs) to Arweave; passes the txid to `registerInstance`. The website's attestation page (05 §5) re-verifies quotes client-side/server-side and shows: ✅ code hash matches published release / ✅ quote valid / ✅ EOAs match registry. Publish the reproducible-build instructions so third parties can verify independently.

## 6. Revival flow (orchestrator side)

"Revive" button (05) → reviver pays revival fee (≈ 1 month hosting + seed gas, priced live) → orchestrator deploys same pinned image with same agentId → CVM re-derives keys, restores newest Arweave snapshot, `registerInstance` (passes because heartbeat stale > 7 d) → generation++ → wake journal entry crediting the reviver's address. If the platform orchestrator itself is gone: the runtime image, deploy scripts, and instructions are public — anyone with a funded wallet can perform revival manually (Oyster deploys are wallet-only); document this "orchestrator-less revival" path explicitly (it is the project's decentralization backstop).

## 7. Failure modes to handle explicitly

| Failure | Handling |
|---|---|
| CVM boot fails / attestation invalid | Retry ×3, then mark launch failed, refund path. Never finalize. |
| Config hash mismatch in CVM | CVM refuses to boot (03 §10); orchestrator marks failed. |
| Farcaster registration fails | Agent goes live anyway; daemon retries daily; "social pending" badge. |
| Seed tx partial failure | Reconciliation retries; finalize blocked until complete. |
| Oyster capacity/outage | Queue launches; status page; creations pausable via multisig (02 §1). |
| Orchestrator key compromise | Powers are only deploy+finalize; worst case = junk launches. Rotate key, pause factory. Funds are never at risk. |
