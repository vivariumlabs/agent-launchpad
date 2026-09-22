# M0-4 findings — OpenRouter (2026-09-22)

## Status: ASSUMPTION PARTIALLY FAILED — needs Juan before M2/M3 design freezes

D8 assumes the agent self-funds OpenRouter credits headlessly via the **Crypto Payments API**. That API no longer exists.

### What still holds ✅
- **Programmatic key provisioning** exists and is documented: management API keys can create/update/delete inference keys (`POST /api/v1/keys` etc.) and read remaining credits (`GET /api/v1/credits`). Genesis can mint a per-agent key as designed. See `provision-drill.sh`.

### What broke ❌
- `POST /api/v1/credits/coinbase` (the documented crypto top-up flow) was **removed** — verified live 2026-09-22, returns:
  `410 Gone — "…the Coinbase Commerce credits API has been removed. Use the web credits purchase flow instead."`
- The remaining credit purchase flow is an interactive web checkout (Coinbase Business Checkouts) — a human clicking, not an agent paying.

### The likely replacement 🔶
- OpenRouter is publicly transitioning to **x402 pay-per-use settlement** (USDC on Base): reported May 2026, $50M+ processed protocol-wide. This fits the design *better* than credit top-ups (no prepaid balance to manage) and RH chain already has an x402 facilitator (Loxley, per D1 rationale). **But** OpenRouter's own docs index has no official x402 endpoint documentation yet (checked 2026-09-22). Third-party x402→OpenRouter gateways exist (e.g. Router402) but insert a trust/custody intermediary.

### Options for Juan (not decided — D8 is a decision-log item)
1. Wait/monitor for OpenRouter's official x402 endpoint; build LLM client with a payment-adapter interface so the settlement method is swappable.
2. Interim: human-funded prepaid credits per agent (breaks "no human touch" purity for inference only; policy engine unaffected).
3. Evaluate an x402-native inference gateway as primary or fallback.

### Still to demonstrate once Juan provides OpenRouter org + ~$20
- Run `provision-drill.sh` with a management key: create key → call a model → read credits. (The crypto top-up leg of the drill is void as written; replace per Juan's choice above.)
