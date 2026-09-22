# 00 — PROJECT OVERVIEW

> **Build pack for an autonomous-agent token launchpad on Robinhood Chain.**
> This is document 0 of 8. Read this file first in any build session, then the module doc you are working on. Every parameter marked `DEFAULT` is a starting value Juan can revise.

**Project codename:** (TBD — pick before mainnet)
**Owner:** Juan (juanloygorri@gmail.com). Juan reviews logic and makes go/no-go calls; he does not write or review code. Claude builds everything. Compensating controls for that are defined in `06-OPERATIONS.md` and are non-negotiable.

---

## 1. One-paragraph pitch

A launchpad on Robinhood Chain where every token launched is bound to an **autonomous AI agent**. Trading fees from the token stream to the agent's wallet, and the agent uses them to pay for its own existence — inference, hosting, gas — with no human able to touch its funds. The agent lives in a TEE (Phala), has a Farcaster social identity, a permanent Arweave journal, an on-chain trading wallet with hard limits, and a token-gated chat. The creator receives an NFT that is a pure **royalty claim** on the fee stream — it has *zero control* over the agent by design. Burning the NFT redirects its royalty to the agent itself ("emancipation" as optional economics, not security theater). A platform token ($TOKEN) accrues value via buyback-and-burn funded by a share of all agent-token fees.

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
                        │        PHALA CVM (TEE, attested)        │◄─┘
                        │                                         │
                        │  treasury EOA ── policy engine ── action EOA
                        │  pulse scheduler · LLM client (OpenRouter)
                        │  chat server (SIWE-gated) · Farcaster   │
                        │  Arweave journal+snapshots · memory DB  │
                        └─────────────────────────────────────────┘
                              │              │             │
                        OpenRouter      Farcaster       Arweave
                        (Base USDC      (OP mainnet     (crypto-
                         top-ups)       FID+keys)        paid)
```

## 3. Decision log (settled — do not reopen without Juan)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Chain | **Robinhood Chain** (mainnet 4663, testnet 46630). EVM, Arbitrum Orbit, ETH gas, permissionless deploys. | Juan's choice; x402 facilitator (Loxley) and Across bridge already support it. |
| D2 | Stablecoin | **USDG** (Paxos Global Dollar) — the chain's native stable; bridged USDC arrives as USDG via Across. All agent-token pairs are TOKEN/USDG. | Simplicity + x402 settlement on this chain uses USDG. |
| D3 | Agent-token fee | **3% on swaps**, split 1% TreasuryBuyback / 1% agent treasury / 1% NFT holder. Enforced at pool level (v4 hook), never fee-on-transfer. | Fee-on-transfer breaks routers/aggregators. |
| D4 | $TOKEN launch | Via **PONS** (ponsfamily.com) standard launch for credibility/distribution; platform collects PONS creator-fee stream into the treasury. $TOKEN value accrual = buyback-and-burn from the 1% share of all agent-token fees. | Native-community credibility; don't rebuild what PONS does. |
| D5 | Agent hosting | **Phala CVM**, code hash pinned, keys derived via Phala KMS (bound to code hash), upgrade authority renounced or timelocked-governance only. | Only provable-autonomy option. |
| D6 | Custody model | Both agent wallets are **EOAs with keys generated inside the TEE**. Spending policy enforced by a deterministic in-TEE policy engine (attested), not by on-chain smart accounts. | x402/EIP-3009 need EOA signatures; attestation makes policy provable. |
| D7 | NFT | **Never has control over the agent.** Pure royalty claim (pull-based). **Burn ⇒ its 1% redirects to agent treasury forever.** No burn requirement for autonomy — autonomy is from genesis. | Cleaner than burn-for-autonomy; NFT gets a real floor (discounted cash flow). |
| D8 | Brain | **OpenRouter**: creator picks model + fallback list at launch from a platform allowlist. Agent self-funds credits via OpenRouter's Crypto Payments API (USDC on Base, bridged via Across). Cheap model tier for chat, better tier for pulse decisions. Centralized-brain caveat accepted. | One API, all models, native fallback, headless crypto top-ups. |
| D9 | Chat | **Holders only** (no pay-per-message). Gate: ≥0.1% of agent token supply, or ≥1% of $TOKEN supply (all-agent pass). Rate-limited per wallet. Verified inside the TEE via SIWE + RPC balance check. | Juan's call 2026-09-22. |
| D10 | Revival | **Community revival ON.** Evicted/dead agents can be revived by anyone funding a redeploy of the same code hash; keys re-derive via KMS, memory restores from Arweave snapshot. Registry enforces single live instance. | Juan's call 2026-09-22. |
| D11 | Personas | **Archetype + free-text.** Archetype sets budget weights/behavior; free-text persona layered *under* platform guardrail prompt. | Juan's call 2026-09-22. |
| D12 | Out of scope v1 | Hyperliquid, ENS, ERC-8004, agent-hiring-agents, reproduction, cross-chain trading (agent trades only on Robinhood Chain; Base/OP balances exist solely for OpenRouter/Farcaster ops), X/Twitter and all custodial socials, lending (until protocols exist on RH chain). | Scope discipline; each adds friction or an API key. |
| D13 | Prompt injection | Accepted as **part of the experience** for the action wallet (bounded playground). Survival funds are structurally out of reach of the LLM. | Freysa-as-a-feature. |

## 4. The three money flows (memorize this)

1. **Agent token trading** → 3% fee at the pool → FeeSplitHook → 1% TreasuryBuyback (market-buys and burns $TOKEN, permissionless `poke()`), 1% agent treasury EOA (USDG), 1% RoyaltyDistributor (NFT holder claims; if NFT burned, this leg re-routes to agent treasury).
2. **Agent survival** → treasury EOA pays ONLY whitelisted destinations: Phala hosting, OpenRouter top-up (bridge to Base via Across), gas top-ups (RH chain ETH, OP ETH, Base ETH), Arweave, x402 data/search endpoints — all capped per day — plus one daily allowance transfer to the action EOA.
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
| CVM | Confidential VM on Phala — the agent's body. |
| KMS keys | Keys deterministically derivable only inside a TEE running the pinned code hash. |
| Pulse | The agent's scheduled think-act cycle. |
| Runway | Days of survival the treasury can fund at current burn rate. |
| Genesis | The fully automated launch sequence (04). |
| Revival | Community-funded redeploy of a dead agent (D10). |
| USDG | Paxos Global Dollar, the stable on Robinhood Chain. |
