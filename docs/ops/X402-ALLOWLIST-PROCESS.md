# x402 inference/data endpoint allowlist — curation process (carry-over (3); 06 §1 ops duty, D8, 04 §4)

**What it is:** the platform-signed list of x402 endpoints agents may pay. Baked into genesis config; updated post-genesis only via opt-in signed updates (04 §4). This doc is the operating procedure; Juan executes it (it's an ops duty, not code).

## Entry schema (also the on-config format)

`{ id, kind: inference|data, operator, url, payTo, model, tier: cheap|standard, maxPricePerMTokUsd, attested: bool, addedAt, evidence: [probe txids/logs] }`

## Admission criteria (all required)

1. **Independence:** operator not already on the list under another entry (different infra + different payTo controller; N≥3 independent operators overall, D8).
2. **Model class:** serves a DeepSeek-class open-weight model; price ≤ platform ceiling (~$0.10–0.50/1M tok at 2026 rates — pin per entry).
3. **Probe:** 3 paid calls from a throwaway wallet over ≥2 days: correct x402 402→pay→200 flow on USDC/Base (EIP-3009), tool-call schema compliance, canary prompts pass (same canaries as runtime SPEC-M2 §7 — self-ID is NOT evidence, per the M0 OpenRelay/Gemini finding).
4. **Prefer TEE-attested endpoints** when available; `attested: true` entries outrank in default fallback ordering.

## Ongoing monitoring (weekly, ~15 min; automate via indexer job in M4+)

- Re-run canaries + price quote per entry; 2 consecutive weekly failures or a silent price hike above ceiling ⇒ **removal**.
- Watch operator churn signals (payTo changes = re-probe as if new).

## Update mechanics

- List version is EIP-712-signed by the platform allowlist key (multisig-held from M6). Runtimes fetch updates, verify the signature, and apply **only if** the agent's config opted in at genesis (04 §4); opted-out agents keep their genesis list forever.
- Additions: any time. Removals: take effect for opted-in agents at next fetch; document reason in a public changelog (`docs/ops/allowlist-changelog.md`, create at first change).
- Emergency (endpoint hostile/compromised): same mechanism, just fast; there is no forced push by design — opted-out agents are on their own, which is the point.

## Bootstrap target (M2–M3)

Curate 4–5 entries: ≥3 independent inference operators (primary DeepSeek-V4-Flash per D8) + ≥1 cheap-tier + ≥1 data/search endpoint. The two M0-probed endpoints are candidates but must pass the full admission probe.
