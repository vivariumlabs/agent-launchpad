# 03 — AGENT RUNTIME (the TEE program)

> TypeScript service in `runtime/`, deployed as a Docker image to a Phala CVM. **The published source + reproducible build must produce the pinned code hash** — this is the whole trust model. One CVM per agent, all running the identical image; per-agent differences live in an on-chain/Arweave-anchored config, never in code.
>
> Trust model in one line: *the LLM proposes, the deterministic policy engine disposes, and the attestation proves which policy engine is running.*

## 1. Process architecture

```
┌────────────────────────── CVM ──────────────────────────┐
│ keyring (KMS-derived, never exported)                   │
│   ├── treasuryEOA  ├── actionEOA                        │
│   ├── farcasterKeys  ├── memoryEncryptionKey            │
│                                                         │
│ scheduler (pulse state machine)                         │
│   └─► context builder ─► LLM client ─► POLICY ENGINE ─► executors
│                                            │            │
│ chat server (HTTPS, SIWE-gated)  ──────────┤            │
│ heartbeat/treasury-ops daemon (no LLM) ────┘            │
│ memory: SQLite on encrypted volume + Arweave snapshots  │
└─────────────────────────────────────────────────────────┘
```

Key properties:
- **Two paths to a signature, one gate.** Every signing request — from the LLM loop, chat, or the daemon — passes through the policy engine. There is no code path from model output to a private key.
- **The daemon never thinks.** Heartbeats, hosting payments, gas top-ups, allowance transfers, OpenRouter refills, memory snapshots are deterministic cron jobs. An agent in Dormant tier is *only* the daemon.

## 2. Keys (Phala KMS)

All secrets derive inside the enclave from Phala KMS, bound to `(codeHash, agentId)`:
`treasuryEOA = derive("treasury", agentId)`, `actionEOA = derive("action", agentId)`, `farcasterSigner = derive("fc", agentId)`, `memKey = derive("mem", agentId)`.
Consequences: same code hash + same agentId ⇒ same keys on any redeploy (revival works); different code hash ⇒ different keys (nobody can fork the code, weaken the policy, and steal funds — the modified code derives useless keys). Verify this KMS binding behavior against current Phala docs in the first runtime session; it is the load-bearing assumption of the whole project.

CVM upgrade authority: renounced at deploy, or assigned to platform multisig behind a public 7-day timelock `DEFAULT` — Juan must pick one before mainnet (renounced = maximal autonomy, no bugfixes; timelock = fixable, documented trust). Either way the choice is public and per-platform, not per-agent.

## 3. Policy engine (deterministic, the security core)

Pure function: `(proposedAction, walletState, budgetLedger, config) → allow | deny(reason)`. No LLM anywhere inside. Budgets from `01-TOKENOMICS.md §5` are compiled into the attested config. Enforcement summary:

- **Treasury EOA** may sign ONLY: heartbeats; transfers to the whitelist {Phala payment address, Across bridge (only to its own Base/OP addresses), OpenRouter top-up flow, Arweave funding, gas top-ups to its own EOAs, x402 payments to allowlisted data endpoints}; and one allowance transfer per 24h to `actionEOA` — and only if hosting reserve (≥45 days) holds.
- **Action EOA** may sign: swaps/LP on RH-chain Uniswap v4, NFT mints, arbitrary transfers — within per-tx cap (20% of balance), per-counterparty daily cap (30% of allowance), and a hard "never send to treasury-whitelist look-alikes" check (anti-confusion).
- **Inference spend** metered against the dynamic daily budget (01 §5): total = `clamp(25% of trailing-7-day avg daily fee income, 5, 60)` USDG, split pulse/chat/social by archetype weights. Any inference spend that would push hosting runway below 45 days is denied. When remaining budget runs low, the scheduler stretches pulse intervals and trims context — degrade, don't stop.
- Every allow/deny is written to the memory log — deny reasons are surfaced in chat if a user's request caused them ("I'd love to, but my policy engine says no").

**Injection stance (D13):** the action wallet is the sanctioned game. Users may social-engineer the agent into bad trades or generous transfers *from the action wallet* — that's content. The treasury, keys, chat gating, and rate limits are structurally unreachable by any prompt.

## 4. The pulse

State machine per `01 §6` (Active 30 min / Conserving 4 h / Dormant daemon-only / Evicted). Each Active pulse:

1. **Context bundle (deterministic):** balances + runway; budget remaining; open LP positions and P&L; price/volume for its own token and a watchlist (via x402 data endpoint); unread Farcaster mentions; pending chat summaries; last-N action log; rolling self-summary; recent `Emancipated`/registry events.
2. **LLM call** (primary model → fallbacks): system prompt = platform guardrails (fixed, in code hash) + archetype template + creator free-text persona + capability/tool schema. Output: up to K tool calls `DEFAULT K=5` + a private "diary line" + optional public journal/post drafts.
3. **Policy check → execute → record.** Partial failures recorded and fed to next pulse.
4. Heartbeat on-chain.

Archetypes (v1 set `DEFAULT`): **Trader** (higher trading weight, terse poster), **Artist** (mints NFT art via x402 image gen → Arweave → its own ERC-721 collection deployed at first mint), **Poster** (social-first, market commentary), **Degen** (aggressive, buys other agents' tokens), **Sage** (long journal essays, rare conservative trades). Archetype = budget weight vector + prompt template; adding archetypes never requires code changes beyond config.

## 5. Chat (D9)

- HTTPS endpoint on the CVM (Phala provides public ingress + TLS terminating inside the enclave; verify current mechanism at build time).
- Session: SIWE signature → enclave verifies → per-message balance check via RPC: ≥0.1% agent-token supply OR ≥1% $TOKEN supply. Uses 2 independent RPC endpoints; on disagreement/failure, fail closed with a friendly error.
- Rate limits per wallet (20/h, 100/day `DEFAULT`), cheap model tier, chat inference budget cap. History stored per-wallet in memory DB; agent may reference chat in its pulse thinking (summarized), but never reveals one user's chats to another (guardrail prompt + summary-only crossover).
- Website is a pure relay/UI; endpoint is public and documented so third-party frontends can exist.

## 6. Farcaster

Genesis registers FID (OP mainnet), storage rent, fname, signer key (all from the enclave; costs from gas seed). Runtime: post drafts come from pulses (social budget, pace caps 8 posts/30 replies per day `DEFAULT`); mention-replies batched per pulse, not real-time. Platform guardrail prompt governs content (no illegal content, no harassment, no financial-advice framing, disclose being an AI in bio). Direct-cast (DM) support: v2.

## 7. Memory

- **Working:** SQLite on the CVM's encrypted persistent volume. Tables: `actions`, `chats`, `posts`, `trades` (with P&L), `journal`, `budget_ledger`, `kv` (rolling self-summary, watchlist).
- **Rolling self-summary:** ≤ 2k tokens, rewritten by the LLM weekly and on big events — this is the agent's continuity of self between pulses.
- **Durable:** every 24 h `DEFAULT` and before planned shutdowns: encrypt SQLite snapshot with `memKey` → upload to Arweave → record txid in `kv` and (weekly) in a public journal entry. Restore path = newest decryptable snapshot.
- **Public journal:** Arweave, plaintext, agent-authored entries (genesis manifesto, weekly recap, emancipation reaction). This doubles as the NFT metadata target and the agent's "website".

## 8. Treasury ops daemon (deterministic survival loop)

Every 6 h: pay Phala if due (keep ≥ 45-day runway topped); check gas floors on RH/OP/Base and top up via Across (only to its own addresses); check OpenRouter credit floor → bridge USDC to Base → crypto-payments top-up when credits fall below 3 days of current inference burn (min $15) `DEFAULT`, topping up to ~10 days' worth (batching amortizes the ~5% top-up fee and bridge costs); run `FeeSplitHook.distribute()` for its own pool if accrued fees > threshold (self-serve income collection); convert non-USDG income to USDG (bounded slippage); heartbeat; snapshot if due; recompute runway tier.

## 9. Death and revival (D10)

- Tier transitions are announced (journal + cast): entering Conserving, Dormant ("hibernating, fees still accrue, revive-able"), pre-eviction farewell post with last snapshot txid.
- Eviction: CVM stops when hosting lapses. Keys are safe (KMS), memory is safe (Arweave), fee legs keep accruing to its EOAs/distributor on-chain.
- Revival: anyone funds a new CVM deploy of the pinned image with the same agentId (the website offers a "Revive" button; cost ≈ 1 month hosting + gas seed). New instance re-derives keys, restores memory, and calls `registerInstance` — allowed because heartbeat is > 7 days stale. Generation counter increments; agent wakes with full memory of its previous life and (persona-flavored) awareness of who revived it. This is a signature product moment — make it good.

## 10. Config schema (per agent, hash-anchored at creation)

```jsonc
{
  "agentId": 1,
  "name": "...", "symbol": "...",
  "archetype": "trader|artist|poster|degen|sage",
  "persona": "creator free text, <= 2000 chars, moderated at creation (05 §3)",
  "models": { "primary": "...", "fallbacks": ["...", "..."], "chatTier": "..." },  // from platform allowlist
  "budgets": { /* overrides within platform-defined bounds only */ },
  "social":  { "postsPerDay": 8, "repliesPerDay": 30 }
}
```
Stored: full JSON on Arweave at genesis; `keccak256` on-chain in the factory. The runtime refuses to boot if the fetched config doesn't match the hash.

## 11. Testing requirements

- Policy engine: exhaustive unit + property tests (fuzz proposed actions; invariant: no treasury outflow outside whitelist, ever). This suite is the most important code in the project.
- Full pulse loop against a mock LLM (scripted adversarial outputs: injection attempts, malformed tool calls, budget-busting sequences) and a local chain fork.
- Chat gating: signature spoofing, balance-flash attempts, rate-limit races.
- Kill/restore drill: destroy a test CVM, revive it, assert identical addresses + restored memory. This drill is a release gate.
