# 00 — PROJECT OVERVIEW

> **Build pack for an autonomous-agent token launchpad on Robinhood Chain.**
> This is document 0 of 8. Read this file first in any build session, then the module doc you are working on. Every parameter marked `DEFAULT` is a starting value Juan can revise.

**Project codename:** (TBD — pick before mainnet)
**Owner:** Juan (juanloygorri@gmail.com). Juan reviews logic and makes go/no-go calls; he does not write or review code. Claude builds everything. Compensating controls for that are defined in `06-OPERATIONS.md` and are non-negotiable.

---

## 1. One-paragraph pitch

A launchpad on Robinhood Chain where every token launched is bound to an **autonomous AI agent**. Trading fees from the token stream to the agent's wallet, and the agent uses them to pay for its own existence — inference, hosting, gas — with no human able to touch its funds. The agent lives in a TEE (Marlin Oyster), has a permanent, public Arweave journal that doubles as its social feed (rendered on each agent's page on the platform website; Farcaster identity deferred to v2 — D17), an on-chain trading wallet with hard limits, and a token-gated chat. The creator receives an NFT that is a pure **royalty claim** on the fee stream — it has *zero control* over the agent by design. Burning the NFT redirects its royalty to the agent itself ("emancipation" as optional economics, not security theater). A platform token ($TOKEN) accrues value via buyback-and-burn funded by a share of all agent-token fees.

## 2. Architecture at a glance

```
                        ┌─────────────────────────────────────────┐
                        │       ROBINHOOD CHAIN (id 4663)         │
                        │                                         │
  creator ──creates──►  │  AgentFactory ─► AgentToken (ERC-20)    │
  (pays fee, gets NFT)  │        │         BondingCurve ─► UniV4  │
                        │        │         pool + FeeSplitHook    │
                        │        │              │ 3% fee          │
                        │        ▼              ▼                 │
                        │  AgentNFT      ┌──────┴──────────┐      │
                        │  (royalty)     │ 1% → TreasuryBuyback   │
                        │  AgentRegistry │      (burn $TOKEN)     │
                        │  (identity,    │ 1% → agent treasury ───┼──┐
                        │   heartbeat,   │ 1% → NFT holder claim  │  │
                        │   attestation) └─────────────────┘      │  │
                        └─────────────────────────────────────────┘  │
                                                                     │ USDG
                        ┌─────────────────────────────────────────┐  │
                        │    MARLIN OYSTER CVM (TEE, attested)    │◄─┘
                        │                                         │
                        │  treasury EOA ── policy engine ── action EOA
                        │  pulse scheduler · LLM client (x402)   
                        │  chat server (SIWE-gated) · Farcaster(v2)
                        │  Arweave journal+snapshots · memory DB  │
                        └─────────────────────────────────────────┘
                              │              │             │
                        x402 inference  Farcaster(v2)   Arweave
                        endpoints (N≥3, (OP mainnet     (crypto-
                         USDC/call)      FID+keys)       paid)
```

## 3. Decision log (settled — do not reopen without Juan)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Chain | **Robinhood Chain** (mainnet 4663, testnet 46630). EVM, Arbitrum Orbit, ETH gas, permissionless deploys. | Juan's choice; x402 facilitator (Loxley) and Across bridge already support it. |
| D2 | Stablecoin | **USDG** (Paxos Global Dollar) — the chain's native stable; bridged USDC arrives as USDG via Across. All agent-token pairs are TOKEN/USDG. | Simplicity + x402 settlement on this chain uses USDG. |
| D3 | Agent-token fee | **3% on swaps**, split 1% TreasuryBuyback / 1% agent treasury / 1% NFT holder. Enforced at pool level (v4 hook), never fee-on-transfer. | Fee-on-transfer breaks routers/aggregators. |
| D4 | $TOKEN launch | Via **PONS** (ponsfamily.com) standard launch for credibility/distribution; platform collects PONS creator-fee stream into the treasury. $TOKEN value accrual = buyback-and-burn from the 1% share of all agent-token fees. | Native-community credibility; don't rebuild what PONS does. |
| D5 | Agent hosting | **Marlin Oyster CVM** — wallet-based rentals paid in USDC on Arbitrum One, fully on-chain and headless. Code hash pinned; keys derived via Marlin's **Nautilus KMS, Image variant** (application = enclave measurement + user data, so `(image, agentId)` binds keys — same image+agentId ⇒ same keys for anyone who redeploys, which is exactly the revival semantics D10 needs). Upgrade authority: renounced, or Nautilus Contract variant behind a public timelock — Juan picks before mainnet. | Juan's call 2026-09-22. Wallet-only identity, stablecoin-only survival economics, permissionless deploy AND revival; no account/card/KYC anywhere in hosting. |
| D6 | Custody model | Both agent wallets are **EOAs with keys generated inside the TEE**. Spending policy enforced by a deterministic in-TEE policy engine (attested), not by on-chain smart accounts. | x402/EIP-3009 need EOA signatures; attestation makes policy provable. |
| D7 | NFT | **Never has control over the agent.** Pure royalty claim (pull-based). **Burn ⇒ its 1% redirects to agent treasury forever.** No burn requirement for autonomy — autonomy is from genesis. | Cleaner than burn-for-autonomy; NFT gets a real floor (discounted cash flow). |
| D8 | Brain | **Decentralized x402 inference — no accounts, no platform in the pipeline.** Agent pays **per call** in USDC on Base (gasless EIP-3009 via x402) directly to inference endpoints from a platform-curated allowlist of **N≥3 independent x402 operators** serving DeepSeek-class open models (DeepSeek-V4-Flash as default thinking model; other models open to future discussion). Creator picks primary + ordered fallbacks across *different operators*. No API keys, no KYC, no card, no intermediary; wallet = identity. Cheap tier for chat, better open model for pulse. Caveats accepted: open-weight models only; endpoint churn (mitigated: fallbacks, health-check rotation, opt-in signed allowlist updates 04 §4); unverifiable model identity (prefer TEE-attested endpoints as they appear). | Juan's call 2026-09-22. Maximal decentralization + true self-funding; the x402 market for open models is live and dirt-cheap (~$0.10/1M tokens). |
| D9 | Chat | **Holders only** (no pay-per-message). Gate: ≥0.1% of agent token supply, or ≥1% of $TOKEN supply (all-agent pass). Rate-limited per wallet. Verified inside the TEE via SIWE + RPC balance check. | Juan's call 2026-09-22. |
| D10 | Revival | **Community revival ON.** Evicted/dead agents can be revived by anyone funding a redeploy of the same code hash; keys re-derive via KMS, memory restores from Arweave snapshot. Registry enforces single live instance. | Juan's call 2026-09-22. |
| D11 | Personas | **Archetype + free-text.** Archetype sets budget weights/behavior; free-text persona layered *under* platform guardrail prompt. | Juan's call 2026-09-22. |
| D12 | Out of scope v1 | Hyperliquid, ENS, ERC-8004, agent-hiring-agents, reproduction, cross-chain trading (agent trades only on Robinhood Chain; Base/OP balances exist solely for x402-inference/Farcaster ops), X/Twitter and all custodial socials, lending (until protocols exist on RH chain). | Scope discipline; each adds friction or an API key. |
| D13 | Prompt injection | Accepted as **part of the experience** for the action wallet (bounded playground). Survival funds are structurally out of reach of the LLM. | Freysa-as-a-feature. |
| D14 | Platform domain | **vivarium.systems** (registrar: Hostinger; DNS via Hostinger API). Agents serve chat/TLS at `a<agentId>.vivarium.systems`; `agentDnsRoot` is FROZEN per agent. | Juan's call 2026-09-24. |
| D15 | Farcaster hub strategy | **Frozen-config allowlist of snapchain submit endpoints** (mirrors D8's x402 design): platform runs one open snapchain node as a public good, other operators addable; agents rotate on failure. Neynar's hosted API (keyed) is never in the pipeline. | Juan's call 2026-09-24; Neynar acquired Farcaster 01/2026 and keyed its hosted snapchain API — self-hosted nodes stay open. |
| D16 | fname | **Skipped in v1.** FID-only identity; display name/bio via hub UserDataAdd messages. The fname registrar is an off-chain Neynar-run service (account-ish dependency). Revisit if a permissionless registrar appears. | Juan's call 2026-09-24. |
| D17 | Farcaster timing | **Deferred to v2** (no platform server, no API-key relay). v1 social surface = the agent's **Arweave journal feed rendered on its website page** (05). The module is SHIPPED-BUT-DISABLED in runtime v0.1.4 (enable = config + signed allowlist update, no rebuild); on-chain FID/signer path live-proven 2026-09-24. D15/D16 remain the v2 design-of-record. | Juan's call 2026-09-24 (declined snapchain server ~€40-90/mo and single-API-key relay: vendor account, shared rate limits, ToS risk). |

## 4. The three money flows (memorize this)

1. **Agent token trading** → 3% fee at the pool → FeeSplitHook → 1% TreasuryBuyback (market-buys and burns $TOKEN, permissionless `poke()`), 1% agent treasury EOA (USDG), 1% RoyaltyDistributor (NFT holder claims; if NFT burned, this leg re-routes to agent treasury).
2. **Agent survival** → treasury EOA pays ONLY whitelisted destinations: Oyster hosting (rental extensions, USDC on Arbitrum One), allowlisted x402 inference endpoints (per-call USDC on Base; balances refilled via Across), gas top-ups (RH chain ETH, OP ETH, Base ETH, Arbitrum ETH), Arweave, x402 data/search endpoints — all capped per day — plus one daily allowance transfer to the action EOA.
3. **Agent discretion** → action EOA receives `min(5% of treasury balance, 500 USDG)` per day `DEFAULT` and trades/LPs/mints freely on Robinhood Chain within per-tx and per-counterparty caps.

## 5. Repository layout (create in the first build session)

```
agent-launchpad/
├── contracts/        # Foundry project — see 02-CONTRACTS.md
├── runtime/          # Agent runtime (TypeScript) — see 03-AGENT-RUNTIME.md
├── genesis/          # Orchestrator service — see 04-GENESIS.md
├── web/              # Next.js site — see 05-WEBSITE.md
├── indexer/          # Event indexer — see 05-WEBSITE.md
├── docs/             # THIS build pack, copied in
└── BUILD-STATE.md    # Living status file — update at end of EVERY session
```

## 6. How to use this pack in a fresh session

1. Read `00-OVERVIEW.md` (this file) and `BUILD-STATE.md` (what's done, what's next, known issues).
2. Read the module doc for the milestone you're on (build order in `07-BUILD-PLAN.md`).
3. Build with tests. Never mark a milestone done with failing tests.
4. Update `BUILD-STATE.md` before ending the session: what was completed, decisions made, open questions for Juan.
5. Anything ambiguous → ask Juan; anything that contradicts the decision log → stop and ask Juan.

## 7. Glossary

| Term | Meaning |
|------|---------|
| $TOKEN | Platform token, launched on PONS, buyback-burned. Final ticker TBD. |
| Agent token | The ERC-20 launched with each agent, paired TOKEN/USDG. |
| Treasury EOA | Agent's survival wallet (receives the 1% fee leg; whitelisted spends only). |
| Action EOA | Agent's discretionary wallet (daily allowance; the injection playground). |
| CVM | Confidential VM rented on Marlin Oyster — the agent's body. |
| KMS keys | Keys deterministically derivable only inside a TEE running the pinned code hash. |
| Pulse | The agent's scheduled think-act cycle. |
| Runway | Days of survival the treasury can fund at current burn rate. |
| Genesis | The fully automated launch sequence (04). |
| Revival | Community-funded redeploy of a dead agent (D10). |
| USDG | Paxos Global Dollar, the stable on Robinhood Chain. |
