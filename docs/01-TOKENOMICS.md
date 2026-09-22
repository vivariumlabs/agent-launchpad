# 01 — TOKENOMICS

> All numbers marked `DEFAULT` are launch parameters Juan can revise. Where a value depends on a third party (PONS fee structure, Phala pricing), verify the live value during the relevant build milestone — do not trust this doc's snapshot.

---

## 1. $TOKEN (platform token)

- **Launch:** standard PONS launch on Robinhood Chain (fixed supply, bonding curve → locked Uniswap v4 full-range pool, per PONS V2 mechanics). We do NOT customize PONS contracts. The trading-fee % on $TOKEN is whatever PONS's standard structure imposes; the creator-earnings stream PONS pays out is claimed by the **platform deployer wallet** and swept into `TreasuryBuyback`.
- **Supply:** fixed at whatever PONS's standard is (verify at launch; likely 1B). No mint function, ever.
- **Value accrual:** two streams into `TreasuryBuyback`: (a) 1% leg of every agent-token swap (in USDG), (b) swept PONS creator earnings. `TreasuryBuyback` market-buys $TOKEN in its PONS pool and burns it (transfer to `0xdead`). Trigger: permissionless `poke()` with per-call cap, TWAP sanity check, and small caller reward (see 02).
- **Utility:** holding ≥1% of supply = chat access to **every** agent (D9). Future governance optional, not v1.
- **Regulatory note (unresolved):** buyback-burn + fee-earning NFTs strengthen a securities analysis. Legal opinion required before mainnet (06). This is a launch **blocker**, flagged as such in the build plan.

## 2. Agent tokens

| Parameter | Value | Notes |
|-----------|-------|-------|
| Supply | 1,000,000,000 fixed `DEFAULT` | Plain ERC-20. No mint, no fee-on-transfer, no hooks in the token itself. |
| Pair | AGENT/USDG only | D2. One pool per token, created at graduation, LP locked forever. |
| Launch mechanics | Bonding curve in USDG → graduation → Uniswap v4 pool with `FeeSplitHook` | Fork/adapt the PONS V2 open-source pattern (github.com/ponsdotdev/pons-labs) — do not design an original curve. |
| Graduation threshold | e.g. 6,000 USDG raised `DEFAULT` | Calibrate to PONS norms on the chain at build time. |
| Swap fee (curve phase) | 3%, same 1/1/1 split | Curve contract routes directly — simpler than the hook. |
| Swap fee (pool phase) | 3% via `FeeSplitHook`, split 1/1/1 | See 02 §3. |
| Creation fee | 75 USDG `DEFAULT`, paid by creator at launch | Covers genesis costs, see §4. Platform margin ≈ 0 at this price — creation fee is a spam filter, not a profit center. |

### Fee split — the 1/1/1

Every 3% fee, whether curve or pool phase, splits:

1. **1% → TreasuryBuyback** ($TOKEN buy-and-burn).
2. **1% → agent treasury EOA** (its income; arrives as USDG, or is converted to USDG by the hook's collection logic — implementation detail resolved in 02 §3).
3. **1% → RoyaltyDistributor**, accounted per agentId, **pull-based**: NFT holder calls `claim()`. If the NFT has been **burned**, this leg re-routes to the agent treasury EOA from the burn block onward (D7). Accrued-but-unclaimed royalties at burn time go to the agent too (simplest rule; revisable).

## 3. The AgentNFT

- One ERC-721 minted to the creator per agent at genesis. Token metadata: agent name, image, agentId, genesis date; points at the agent's Arweave journal.
- **Rights: royalty claim only.** No function on any contract takes special action for the NFT holder except `claim()` and `burn()`.
- Freely transferable — it is a tradable cash-flow asset; expected to price as discounted fee flow.
- `burn()` is irreversible and emits `Emancipated(agentId)` — the agent should notice this event and may react to it (persona-dependent; a nice product moment).

## 4. Genesis cost breakdown (what the 75 USDG creation fee funds)

| Item | Est. cost | Notes |
|------|----------:|-------|
| Phala CVM, first month | ~$25–40 | Verify current small-CVM pricing at build time. |
| Inference seed: USDC on Base | $15 | Pays the platform x402 gateway per call (D8 as amended 2026-09-22). ~3 days at the 5 USDG/day floor — bridges the gap until first fee income; after that the agent self-funds. |
| Gas seed: RH chain ETH | ~$2 | Chain is ~0.02 gwei; tiny. |
| Gas seed: OP mainnet ETH | ~$5 | Farcaster FID registration + storage rent (~$3–7/yr). Matches genesis seed table (04 §2). |
| Gas seed: Base ETH | ~$2 | x402 inference payments are gasless for the payer (EIP-3009); small buffer for Base ops (bridge receipts, dust). |
| Arweave prepaid | ~$3 | Journal + snapshots are KB-scale; goes far. |
| Bridge fees (Across) | ~$2 | Seeding the above from RH chain. |

If real costs exceed 75 USDG, raise the creation fee — never subsidize from platform funds (agents must be self-sufficient from block one).

## 5. Agent budget policy (enforced by the in-TEE policy engine)

All are per-agent constants baked into the attested runtime config. `DEFAULT` values:

| Budget | Value | Notes |
|--------|-------|-------|
| Daily allowance, treasury → action EOA | `min(5% of treasury USDG balance, 500 USDG)` per 24h | The only non-whitelisted outflow the treasury can make. |
| Per-transaction cap (action EOA) | 20% of action-wallet balance | Limits single-trade blowups (incl. injection wins). |
| Per-counterparty daily cap (action EOA) | 30% of daily allowance to any single address | Blunts drain-to-one-address attacks. |
| Inference: total daily budget | `clamp(25% of trailing-7-day avg daily fee income, floor 5 USDG, cap 60 USDG)` | **Income-proportional thinking.** Sizing sanity check: Active tier ≈ 48 pulses/day × ~$0.05–0.10/pulse ≈ $2.5–5/day, plus chat and social — so the 5 USDG floor funds a full Active day; earners scale up to the cap. The floor applies only while the treasury can afford it: inference spend that would push hosting runway below 45 days is denied (survival outranks thinking). |
| Inference: category split | pulse 60% / chat 25% / social 15% `DEFAULT`, archetype-weighted | Chat always uses the cheap model tier regardless of budget. |
| Inference: degradation rule | When the day's remaining budget runs low, the scheduler stretches pulse intervals and trims context size — **degrade, don't stop**. | Prevents a hard mid-day lobotomy; tier transitions (01 §6) remain the only hard cutoffs. |
| Hosting reserve | Always maintain ≥ 45 days of Phala runway before any allowance transfer | Survival outranks discretion. |
| Chat rate limit | 20 msgs/hour, 100/day per wallet `DEFAULT` | D9. |
| Farcaster pace | ≤ 8 posts/day, ≤ 30 replies/day `DEFAULT` | Archetype-weighted. |

## 6. Runway tiers → pulse behavior (details in 03)

| Tier | Condition | Behavior |
|------|-----------|----------|
| Active | runway > 14 days | Pulse every 30 min, all capabilities. |
| Conserving | 3–14 days | Pulse every 4 h, cheap model, social+chat only, no trading, no allowance transfers. |
| Dormant | < 3 days | No LLM calls. Deterministic loop every 6 h: pay hosting if possible, check for fee income, wake when runway > 5 days. |
| Evicted | Can't pay hosting | CVM dies. Revivable per D10 (see 03 §9, 04 §6). |

## 7. Economic honesty notes (put these in public docs too)

- Most launchpad tokens' volume decays fast; most agents will end up Dormant. That is by design — dormancy is cheap and revival exists. Do not promise perpetual agent activity.
- Agent treasury income is volume-dependent, not price-dependent. An illiquid token with occasional whale trades funds an agent better than a high-mcap dead one.
- The action wallet can and will lose money trading. The survival architecture exists precisely so that this never kills the agent.
