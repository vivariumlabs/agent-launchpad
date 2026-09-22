# 07 — BUILD PLAN (milestones & session protocol)

> Build order is dependency-driven. Each milestone lists its **exit gate** — do not proceed past a gate that isn't green. At the end of every session, update `BUILD-STATE.md` (template in §3).

## M0 — Verify load-bearing assumptions (1 session, DO THIS FIRST)

Before writing any product code, prove the four assumptions the design stands on:
1. **Nautilus KMS key derivation** (Marlin Oyster — re-pointed 2026-09-22 per amended D5) bound to (image, user data): deploy a hello-world CVM, derive a key, kill it, redeploy same image + same user data, assert same key; redeploy modified image, assert *different* key; redeploy same image + different user data (stand-in for agentId), assert *different* key. Also pins live rental pricing and probes disk persistence. (Needs Juan: ~$5 USDC + 0.005 ETH on Arbitrum One.)
2. **Uniswap v4 on RH testnet**: locate PoolManager, execute a swap through a trivial custom hook in a fork test.
3. **USDG mechanics** on testnet (address, decimals, EIP-3009 support for x402).
4. **x402 inference** *(rescoped twice 2026-09-22 — D8 v3: decentralized x402 endpoints, no accounts)*: one end-to-end paid inference call (DeepSeek-class model) against ≥2 independent allowlisted x402 endpoints from a throwaway wallet (needs Juan: ~$5 USDC on Base + explicit OK to spend it). (Hosting-rail evaluation completed 2026-09-22 → D5 amended to Marlin Oyster; see decision log.)
Exit gate: all four demonstrated with written evidence in BUILD-STATE.md. **If any fails, stop and redesign with Juan before proceeding.**

## M1 — Contracts (2–4 sessions)
Foundry project; study PONS contracts; implement + test per `02-CONTRACTS.md`; deploy to testnet; hand-run a full lifecycle with scripted EOAs standing in for the TEE (create → finalize → curve trades → graduate → pool swaps → distribute → claim → burn → re-route).
Exit gate: full test suite + invariants green; testnet lifecycle transcript in BUILD-STATE.md.

## M2 — Runtime core, local (3–5 sessions)
`runtime/` skeleton: keyring (mock KMS locally), policy engine (+ its full test suite — the most important code in the project), pulse machine vs mock LLM + local chain fork, memory + snapshot/restore, treasury daemon. No TEE yet.
Exit gate: adversarial mock-LLM suite green; snapshot→restore identity proven locally.

## M3 — TEE integration + genesis (2–4 sessions)
Dockerize reproducibly; deploy to a short-duration Marlin Oyster CVM (control plane on Arbitrum One mainnet — rentals are cheap and wallet-based, no account); real Nautilus keyring; attestation → Arweave; `genesis/` orchestrator end-to-end on RH testnet: website-less genesis via script → agent live, casting on Farcaster (testnet-flagged account), journaling on Arweave, trading on testnet pools. Kill/restore drill with real KMS. (Needs Juan: USDC + ETH on Arbitrum One for the orchestrator wallet.)
Exit gate: scripted genesis < 10 min; revival drill passes; attestation independently verifiable.

## M4 — Website + indexer (3–5 sessions)
Per `05-WEBSITE.md`, pointed at testnet. Launch flow drives real genesis; chat works against a live CVM; attestation tab verifies for real; NFT claim/burn flows; revive flow.
Exit gate: a stranger with a wallet could launch, chat, claim, burn, and revive with no help.

## M5 — Soak + adversarial phase (3+ weeks calendar, low session effort)
≥5 testnet agents incl. one Claude actively attacks. Scripted attack days (injection, gating bypass, drain, revival races, hostile `distribute`/`poke` ordering). Invariant monitor running. Fix, re-soak.
Exit gate: 3 clean weeks; attack log written up; audit package prepared.

## M6 — Audit, legal, $TOKEN, mainnet (calendar-gated)
External audit + fixes; legal opinion (**blocker**, 06 §5); deploy contracts to mainnet; launch $TOKEN on PONS; wire buyback; capped beta (20 agents, allowlist) per 06 §3.4; public transparency docs live.
Exit gate: audit published, counsel sign-off, beta caps active, monitoring live.

## M7 — Open launch
Lift caps gradually; marketing (the attestation page and a live emancipation/revival demo ARE the marketing); post-launch: weekly invariant review, incident drills.

---

## 2. Session protocol (for fresh chats)

Kickoff prompt template:
> "We're building the agent launchpad. Read `docs/00-OVERVIEW.md`, `BUILD-STATE.md`, and `docs/0X-<module>.md`. We're on milestone MX. Continue from BUILD-STATE's 'next steps'. Don't reopen decision-log items without asking me."

Rules for Claude in any session: tests before features count as done; update BUILD-STATE.md at session end (always); new decisions → append to the 00 decision log with date; parameter changes → edit the parameter table in place with a changelog line; anything touching money paths gets extra tests, no exceptions.

## 3. BUILD-STATE.md template

```markdown
# BUILD STATE — updated <date>
## Milestone: MX (<status>)
## Done
- ...
## In progress / next steps
- ...
## Blocked on Juan
- ...
## Known issues / debt
- ...
## Decisions made this session (mirrored to 00 decision log)
- ...
## Evidence links (test runs, tx hashes, attestation refs)
- ...
```

## 4. Realistic effort estimate

~15–25 working sessions to end of M4, then calendar time dominates (soak, audit, legal). The audit and legal engagements are the critical path to mainnet, so start sourcing both around M3.
