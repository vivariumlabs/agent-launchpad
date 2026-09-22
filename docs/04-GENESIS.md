# 04 — GENESIS (launch sequence) & ORCHESTRATOR

> Service in `genesis/`. The orchestrator is the one **platform-operated** component in the launch path. Its powers are deliberately minimal and fully auditable: it can deploy CVMs and call `finalize`; it cannot touch keys, funds, or live agents. Document this trust boundary publicly. (Decentralizing the orchestrator is a v2 goal; v1 honesty beats v1 theater.)

## 1. End-to-end sequence

```
[Website]                [Chain]                    [Orchestrator]              [CVM/TEE]
creator fills form
  → persona moderation (05 §3)
  → image + config → Arweave
  → tx: createAgent(...) ──► AgentRequested event ──► picks up event
                                                       → provisions OpenRouter
                                                         key (platform org),
                                                         sealed to the CVM
                                                       → deploys pinned image
                                                         on Phala (agentId)
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
| Base EOA (OpenRouter top-up gas) | $2 |
| OpenRouter starter credits | $15 |
| Arweave balance | $3 |

After seeding, the platform never funds the agent again (01 §4). Reconciliation job verifies every seed landed; failures alert and block `finalize`.

## 3. OpenRouter provisioning (the one custodial touchpoint)

- Platform OpenRouter org; orchestrator uses the provisioning API to mint one API key per agent, delivered **only** into the CVM via Phala's sealed-secret channel (never logged, never stored server-side after delivery; verify current Phala secret-injection mechanism at build time).
- Agent thereafter self-funds via OpenRouter's crypto payments API from its Base balance.
- Honest public caveat: OpenRouter (or the platform org) can revoke a key ⇒ agent loses its good brain. Mitigations: per-agent keys (no collective punishment), documented status, and a last-resort pure-x402 inference fallback endpoint in the model allowlist so a revoked agent degrades instead of dying. Platform policy: keys are never revoked except for legal compulsion; say so publicly.

## 4. Model allowlist

Platform-maintained JSON (in repo + Arweave): models approved for pulse tier, chat tier, with price ceilings. Creator picks primary + ordered fallbacks from this list only. Update cadence: as models change; updates never force-change an existing agent's list (agents fetch the list pinned at their genesis; agents may *choose* to adopt newer lists — persona moment, v2).

## 5. Attestation publishing

At boot the CVM produces its TEE quote; uploads quote + a human-readable verification report (code hash, image digest, config hash, EOAs) to Arweave; passes the txid to `registerInstance`. The website's attestation page (05 §5) re-verifies quotes client-side/server-side and shows: ✅ code hash matches published release / ✅ quote valid / ✅ EOAs match registry. Publish the reproducible-build instructions so third parties can verify independently.

## 6. Revival flow (orchestrator side)

"Revive" button (05) → reviver pays revival fee (≈ 1 month hosting + seed gas, priced live) → orchestrator deploys same pinned image with same agentId → CVM re-derives keys, restores newest Arweave snapshot, `registerInstance` (passes because heartbeat stale > 7 d) → generation++ → wake journal entry crediting the reviver's address. If the platform orchestrator itself is gone: the runtime image, deploy scripts, and instructions are public — anyone with a Phala account can perform revival manually; document this "orchestrator-less revival" path explicitly (it is the project's decentralization backstop).

## 7. Failure modes to handle explicitly

| Failure | Handling |
|---|---|
| CVM boot fails / attestation invalid | Retry ×3, then mark launch failed, refund path. Never finalize. |
| Config hash mismatch in CVM | CVM refuses to boot (03 §10); orchestrator marks failed. |
| Farcaster registration fails | Agent goes live anyway; daemon retries daily; "social pending" badge. |
| Seed tx partial failure | Reconciliation retries; finalize blocked until complete. |
| Phala capacity/outage | Queue launches; status page; creations pausable via multisig (02 §1). |
| Orchestrator key compromise | Powers are only deploy+finalize; worst case = junk launches. Rotate key, pause factory. Funds are never at risk. |
