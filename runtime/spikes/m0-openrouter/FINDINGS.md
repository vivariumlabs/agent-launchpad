# M0-4 findings — OpenRouter (2026-09-22)

## Status: SUPERSEDED same day — D8 v3 locked in (decentralized x402 inference, no OpenRouter at all)

Juan rejected the gateway (v2) hours after locking it: card/KYC + platform-as-vital-intermediary breaks agent autonomy. Final D8 v3 (see 00 §3): agents pay independent x402 inference endpoints (N≥3 operators, DeepSeek-class models) per call in USDC on Base — no accounts, no keys, no platform in the pipeline. Verified live: x402 inference market exists (e.g. DeepSeek-V4-Flash at ~$0.10/1M tokens; BlockRun 100+ models pay-per-call). `provision-drill.sh` in this folder is now obsolete; M0-4 evidence = paid e2e calls against ≥2 allowlisted endpoints (needs ~$5 USDC on Base from Juan). Related open item: hosting payment rail (Phala = interactive Coinbase Commerce only) — evaluating Marlin Oyster / Oasis ROFL, D5 decision pending.

## Superseded v2 record (gateway, locked then rejected 2026-09-22)

Agent pays per call in USDC on Base (x402/EIP-3009) to a platform-run gateway (pinned public code in an attested Phala CVM; open-source base: ekailabs/x402-openrouter). Gateway meters against the agent's provisioned OpenRouter key; the platform org self-refills via OpenRouter auto top-up on a saved card. Retired via adapter URL change if OpenRouter ships native x402. Affected docs updated: 00 (D8, diagram, money flow 2), 01 §4, 03 §1/§3/§8, 04 §2/§3, 06 §1/§3.7/§4, 07 M0.4.

---
Original analysis below (kept for the record):

D8 assumes the agent self-funds OpenRouter credits headlessly via the **Crypto Payments API**. That API no longer exists.

### What still holds ✅
- **Programmatic key provisioning** exists and is documented: management API keys can create/update/delete inference keys (`POST /api/v1/keys` etc.) and read remaining credits (`GET /api/v1/credits`). Genesis can mint a per-agent key as designed. See `provision-drill.sh`.

### What broke ❌
- `POST /api/v1/credits/coinbase` (the documented crypto top-up flow) was **removed** — verified live 2026-09-22, returns:
  `410 Gone — "…the Coinbase Commerce credits API has been removed. Use the web credits purchase flow instead."`
- The remaining credit purchase flow is an interactive web checkout (Coinbase Business Checkouts) — a human clicking, not an agent paying.

### The likely replacement 🔶
- OpenRouter is publicly transitioning to **x402 pay-per-use settlement** (USDC on Base): reported May 2026, $50M+ processed protocol-wide. This fits the design *better* than credit top-ups (no prepaid balance to manage) and RH chain already has an x402 facilitator (Loxley, per D1 rationale). **But** OpenRouter's own docs index has no official x402 endpoint documentation yet (checked 2026-09-22). Third-party x402→OpenRouter gateways exist (e.g. Router402) but insert a trust/custody intermediary.

### Options presented (Juan chose a variant of 1+3: platform-run gateway now, native x402 if it ships)
1. Wait/monitor for OpenRouter's official x402 endpoint; build LLM client with a payment-adapter interface so the settlement method is swappable.
2. Interim: human-funded prepaid credits per agent (breaks "no human touch" purity for inference only; policy engine unaffected).
3. Evaluate an x402-native inference gateway as primary or fallback.

### Still to demonstrate once Juan provides OpenRouter org + ~$20
- Run `provision-drill.sh` with a management key: create key → call a model → read credits. (The crypto top-up leg of the drill is void as written; replace per Juan's choice above.)
