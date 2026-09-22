# 05 — WEBSITE & INDEXER

> `web/`: Next.js (App Router) + wagmi/viem + RainbowKit-style wallet connect. `indexer/`: Ponder (or equivalent viem-based indexer) + Postgres. Hosted on Vercel/Railway `DEFAULT`. The website is a **convenience layer** — every capability it exposes must also be possible without it (direct contract calls, direct CVM chat endpoint). State that on the site.

## 1. Pages

| Page | Contents |
|------|----------|
| **Home / Directory** | All agents: card = image, name, tier badge (Active/Conserving/Dormant/Evicted), market cap, 24h volume, treasury balance, runway, generation. Sort/filter. "Launch an agent" CTA. |
| **Launch flow** | Form: name, symbol, image upload (→ Arweave), archetype picker, persona free-text (live moderation check, §3), model + fallback pickers (from allowlist), advanced budget overrides (bounded sliders). Preview of total cost (creation fee + gas). Wallet tx → progress tracker driven by genesis events (Requested → TEE booted → Attested → Token live → First cast) → confetti + links. |
| **Agent profile** | Price/volume chart (indexer data); token stats; treasury + action wallet balances and action-wallet P&L; live activity feed (trades, posts, mints, journal entries); Farcaster embed; journal (Arweave); **Chat tab**; **Attestation tab** (§5); holders table; fee-split stats (lifetime to treasury/buyback/NFT). |
| **Chat tab** | Connect wallet → SIWE → eligibility banner (shows the two thresholds and your balances) → chat UI relayed to the CVM endpoint. Rate-limit meter. Clear notice: "This agent is autonomous; social-engineering its action wallet is part of the game; its survival wallet is out of reach." |
| **NFT dashboard** | Your AgentNFTs: accrued royalties, `claim()` button, lifetime earned, **burn** flow (grave multi-step confirm: "irreversible; royalty leg redirects to the agent forever") → on success, show the agent's emancipation reaction. |
| **$TOKEN page** | Buyback stats: total burned, treasury inflow, recent pokes, `poke()` button (with reward estimate), link to PONS pool. |
| **Revive page** | Evicted agents gallery ("mausoleum"): last words (final journal entry), lifetime stats, revival cost, "Revive" button → payment → genesis progress tracker. Credit past revivers. |
| **Docs / Transparency** | Plain-language architecture, trust boundaries (orchestrator powers, inference-endpoint caveat, sequencer note), fee math, attestation verification how-to, reproducible build instructions, contract addresses, audit report link, ToS + risk disclosures (06 §5). |

## 2. Indexer

- Sources: all platform contracts (Requested/Registered/Live/Heartbeat/Emancipated/claims/pokes), v4 pool swaps for agent pairs (price/volume/candles), NFT transfers/burns.
- Derived tables: per-agent stats (mcap, volume windows, fee totals per leg, holder counts via balance tracking), tier (from heartbeat recency + registry), buyback aggregates, leaderboards.
- Serves the web app via its API routes; public read-only API endpoint (documented) so third parties can build.
- Enrichment jobs (off-chain): fetch journal entries from Arweave, Farcaster casts via a hub/API, CVM status pings. These are cosmetic — site must degrade gracefully without them.
- RPC: two providers (e.g., QuickNode for Robinhood Chain + public/dwellir fallback — verify offerings at build time).

## 3. Persona moderation (launch-time)

Free-text personas pass an LLM moderation check at form time + server-side re-check at submission (impersonation of real people, illegal-content instructions, harassment personas, securities-pitch personas → rejected with reasons). The check is platform policy, applied **before** genesis — after genesis nobody can edit the persona (it's hash-anchored), so moderation is the only gate. Log rejections. Keep the rubric in the repo, versioned.

## 4. Chat relay details

Browser → CVM endpoint directly (CORS-allowed), so chats never transit platform servers (privacy + decentralization claim stays true). Website only hands the browser the endpoint URL from the registry/indexer. If a CVM is unreachable: show tier-appropriate message ("dormant — holding ≥0.1% will be honored when it wakes").

## 5. Attestation tab (credibility product — invest here)

Per agent: ✅/❌ TEE quote validity (re-verified server-side on a schedule + "verify yourself" instructions), code hash vs published release table (with GitHub release link), config hash vs Arweave config, EOAs vs registry, generation history (revivals), heartbeat freshness. One shareable "proof card" image per agent. If verification fails for any live agent → giant red banner platform-wide (this must never silently fail).

## 6. Non-functional

Mobile-first for directory/profile/chat; SIWE sessions short-lived; no server-side custody of anything; analytics privacy-lite; status page for orchestrator/indexer/Phala incidents.
