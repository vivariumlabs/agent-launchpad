# 06 — OPERATIONS, SECURITY & LAUNCH

## 1. Accounts & resources Juan must set up (Claude cannot/should not do these alone)

| Item | Purpose | When |
|------|---------|------|
| Platform multisig (2-of-3 Safe on RH chain) | Factory pause, buyback tuning, (optionally) runtime-upgrade timelock | M1 |
| Deployer wallet + testnet/mainnet ETH & USDG | Contract deploys, PONS $TOKEN launch | M1 |
| Marlin Oyster: no account (wallet-based) — fund the orchestrator wallet with USDC + ETH on Arbitrum One | CVM hosting deploys (D5) | M2 |
| x402 inference-endpoint allowlist curation (no account — an ops duty) | Maintain signed endpoint×model list, N≥3 independent operators, health monitoring (D8) | M2 |
| RPC provider account(s) | Chain access for runtime/indexer/web | M1 |
| GitHub org (public repos) | Reproducible builds are the trust model — code must be public | M1 |
| Domain + hosting (Vercel/Railway) | Website, indexer, orchestrator | M4 |
| Arweave funding (Turbo/etc.) | Genesis uploads before agents self-fund | M3 |
| Legal counsel engagement | §5 | Before M6 |
| Audit firm engagement | §3 | Before M6 |

Claude will prepare each step precisely (what to click, what to fund, how much); Juan executes payments/signups and any account-creation or credential entry himself.

## 2. Cost estimate (verify all prices at build time)

| Item | One-off | Monthly |
|------|--------:|--------:|
| Contract audit (small scope, ~6 contracts) | $15–40k | — |
| Legal opinion | $5–15k | — |
| Testnet phase (Oyster test CVMs ×5, services) | ~$300 | — |
| RPC + hosting + domain | — | $100–300 |
| Orchestrator funding float | $500 | small |
| Audit + legal are the dominant costs; everything else is noise. | | |

**Crypto-revenue accounting:** platform crypto receipts (creation fees, PONS stream, buyback flows) are revenue/taxable per counsel's treatment — explicit agenda item at engagement (§5). No fiat float or card exists anywhere: inference (D8) and hosting (D5) are both paid on-chain by the agents themselves.

## 3. Security controls (non-negotiable, because Juan cannot review code)

1. **Public code + reproducible builds.** Anyone can audit; the attested code hash must be reproducible from the public repo. This substitutes for owner code review with *world* code review.
2. **External audit** of `contracts/` before mainnet. Runtime policy engine: at minimum an independent review pass (second audit if budget allows — it guards the money in every agent).
3. **Testnet soak:** ≥ 3 weeks on testnet with ≥ 5 agents including one adversarial agent Claude actively tries to break (injection, drain attempts, gating bypass, revival races). Kill/restore drill passed. Scripted attack days.
4. **Capped mainnet beta:** first 4 weeks `DEFAULT`: max 20 agents, creation allowlist, buyback `maxPerPoke` low, banner "beta — unaudited limits apply". Raise caps only after audit + soak metrics.
5. **Invariant monitoring in prod:** indexer job continuously checks fee-split sums, registry consistency, attestation validity; any violation → automatic factory pause (the one automated multisig-adjacent power; wire via a guardian module with pause-only rights).
6. **No emergency backdoors** in agent funds. Accept this consciously: a bug that drains an agent's wallet is unrecoverable. That's the product's promise working against us — say it in the risk disclosures.
7. **Incident runbook** in repo: sequencer halt, Oyster provider outage, inference-endpoint churn/outage, RPC failure, moderation incident (agent posts something bad), exploit disclosure contact.

## 4. Risk register (public version goes in site docs)

| Risk | Severity | Mitigation |
|------|----------|-----------|
| FeeSplitHook bug | Critical | Fork tests, invariants, audit, capped beta. |
| Policy-engine bypass | Critical | Property tests, review, attestation, injection game confines blast radius by design. |
| Nautilus KMS assumption wrong (Marlin — keys not recoverable / recoverable by others / user-data not bound) | Critical | Verify in M0-1 with kill/redeploy drill before anything else depends on it. **This is the first thing to prove.** |
| x402 inference endpoint churn/outage (young operators) | Medium | N≥3 independent operators per agent, health-check rotation, opt-in signed allowlist updates, prefer TEE-attested endpoints as they appear. |
| Endpoint serves degraded/wrong model (unverifiable identity) | Medium | Price ceilings + output sanity checks in runtime; migrate allowlist toward attested-inference endpoints. |
| Oyster marketplace maturity (provider uptime, capacity, persistence across machine swaps) | Medium | Multiple providers, revival path + Arweave snapshot/restore tolerate instance loss by design; M0-1 drill probes persistence; monitor. |
| Sequencer censorship (Robinhood-operated) | Medium | Documented; L1 forced inclusion exists; accept for v1. |
| Fee volume ≈ 0 for most agents | High (economic) | Dormancy is cheap, revival exists, honest docs. |
| Securities characterization ($TOKEN buyback-burn; income NFT) | High (legal) | Counsel opinion pre-mainnet; geo-blocking if advised; possible reframing of NFT as "creator royalty". **Launch blocker until resolved.** |
| Agent posts unlawful/harmful content | Medium | Guardrail prompt in code hash, persona moderation at launch, AI disclosure, incident runbook. |
| Platform-of-record risk (Juan personally) | High | Entity formation per counsel; ToS; no custody of user funds anywhere in the design. |

## 5. Legal checklist for counsel (prepare, don't improvise)

Token ($TOKEN) characterization with buyback-burn; AgentNFT as revenue-share instrument (Howey analysis); who is the "operator" of an autonomous agent (liability for its trades/posts); money-transmission analysis of fee routing; jurisdiction/geo-blocking strategy; ToS + risk disclosures for creators, traders, NFT holders, chat users; marketing-language constraints ("earnings", "income", "autonomous"). Nothing in this pack is legal advice.
