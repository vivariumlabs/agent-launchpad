# BUILD STATE — updated 2026-09-23 (session 4)

## Milestone: **M2 — session 1 done.** Policy engine (the security core) implemented + 461/461 tests green, incl. Fable-authored property/invariant suite. All four M2/M3 carry-overs addressed. Next: M2 session 2 (pulse machine, memory, daemon).

## Done
- **`runtime/SPEC-M2.md`** (Fable): normative spec for policy engine, keyring, ledger — types, rules G1–G4/T0–T5/I1–I2/A1–A4, 16 DenyCodes, invariants INV1–7, model-identity check design (§7). Rev 1 applied same session (see decisions).
- **Runtime scaffold** (Sonnet): TS strict/Node22/ESM, vitest + fast-check + viem + zod; `src/config/schema.ts` (zod, configHash), `src/policy/types.ts`, `src/policy/approval.ts` (canonical encode + keccak Approval, 60s TTL).
- **Keyring + mock KMS** (Sonnet): `MockKms` reproduces the Nautilus (image, agentId, path) binding semantics (mirrors M0 A/B/C drill in tests); `withRetry` boot pattern (carry-over 2, the M0 derive-server gotcha); keyring's ONLY signing entry is `signApproved(action, approval, now)` — hash + TTL checked, wallet chosen by `walletForAction`.
- **Policy engine** (Opus, vs Fable spec; Fable-reviewed line-by-line): `evaluate()` pure/deterministic/default-deny, never throws, zod G1 gate, wallet isolation (treasury rules never see action balances and vice versa), runway math (floor, 0-rate ⇒ infinite sentinel), Hinnant civil-from-days dayKey (no Date anywhere). Pure ledger reducers shared by engine view + apply path.
- **Tests: 461 green, 10 files** (`npm test` in `runtime/`): 424 unit (every rule × allow/deny/boundary), 26 keyring, 11 property/invariant (Fable): INV1 no-treasury-outflow-outside-whitelist (single-shot 2k runs + 500 mixed 40-step sequences with evolving ledger/clock), INV2 allowance cadence/size, INV3 per-day per-category inference budget, INV4 45d hosting reserve, INV5 20% per-tx cap, INV6 determinism + never-throws on junk, INV7 metamorphic default-deny (mutate any allowed action's destination ⇒ deny). Hygiene test greps sources for Date.now/Math.random/fetch/process.env/`any`.
- **Carry-over (1)** TLS chat ingress: designed — in-enclave ACME (TLS-ALPN-01), KMS-derived ACME account key, per-agent subdomain, platform holds only DNS; attestation-bound cert fallback. `runtime/docs/TLS-INGRESS.md`; verify on real CVM = M3 gate item.
- **Carry-over (3)** x402 allowlist curation: process doc `docs/ops/X402-ALLOWLIST-PROCESS.md` (admission criteria, probes, weekly monitoring, EIP-712-signed opt-in updates, bootstrap target 4–5 entries).
- **Carry-over (4)** model-identity checks: spec'd in SPEC-M2 §7 (price ceiling, per-response contract checks, daily deterministic canaries; self-ID explicitly untrusted) — implement with LLM client in session 2.

## In progress / next steps
- **M2 session 2:** executors (engine→keyring→viem tx assembly), pulse state machine vs scripted-adversarial mock LLM + anvil fork of testnet contracts, LLM client with SPEC-M2 §7 identity checks + endpoint rotation, memory (SQLite + encrypted snapshot/restore), treasury daemon (6h loop per 03 §8). Then M2 exit gate: adversarial mock-LLM suite green; snapshot→restore identity proven locally.
- A2 note for daemon design: USDG counterparty cap denominator is the day's allowance, so the daemon should pull the allowance early in the agent's UTC day (accepted behavior, see decisions).

## Blocked on Juan
- Nothing for M2 session 2. Still queued: platform multisig (M6), dedicated RPC key (nice-to-have), legal/audit sourcing from ~M3 (07 §4).

## Known issues / debt
- `applyApproved` needs `stateAtApproval` to snapshot A2 denominators for non-USDG assets; omitted ⇒ documented live-balance fallback. Executors MUST pass it (wire in session 2).
- treasurySwap slippage honesty (minOut vs real quote) lives in the deterministic daemon, not the engine — both attested; noted in spec T5.
- Engine trusts executor binding for zero-value calls (heartbeat/registerInstance/distribute target+selector hardcoded from config) and for actionSwap/LP routing via PoolManager — structural, revisit when executors exist (session 2).
- Prior M1 debt unchanged (HookDeployer mainnet runbook item, factory bytecode headroom, vendored lib/, minor knowns).

## Decisions made this session (build-level)
- Stack: TypeScript strict/Node 22/vitest/fast-check/viem/zod (Fable).
- **SPEC rev 1 (Fable, from review of Opus's security concerns):** (a) G4 — daily budget buckets reset forward only; a rewound (host-influenced) clock can never refresh caps; (b) removed `x402Inference` as a treasuryTransfer purpose — it duplicated the `inference` kind's I1 budget (2× daily inference spend possible); inference is paid exclusively via the metered `inference` kind.
- Engine caps are per-asset (no price oracle inside the engine); A2 counterparty cap applies to raw transfers only (swaps/LP via canonical PoolManager exempt, still A1-capped); A3 look-alike = exact or 4-byte prefix/suffix collision with the protected set.
- Accepted behaviors: USDG counterparty cap is 0 until the day's allowance is pulled (conservative); zero-amount anything is MALFORMED; USDG referenced by token address in action kinds is denied (single asset key for A2).
- Delegation worked as designed: Fable spec+review+invariants, Opus engine+unit tests (2 passes), Sonnet scaffold+keyring.

## Evidence links (test runs, tx hashes, attestation refs)
- `cd runtime && npm run typecheck && npm test`: 10 files, 461/461 green, ~7s (2026-09-23). Invariant suite ≈7.5k generated cases, 0 violations.
- Session 3 (M1/testnet) evidence unchanged: `contracts/deployments/testnet-46630.json`, `testnet-46630-lifecycle.md`, 309/309 forge tests.
- M0 evidence unchanged: `runtime/spikes/m0-marlin-kms/RESULTS.md`; Base txs `0x9373bb0b…3636`, `0x40d4f6fa…8dd4`.
