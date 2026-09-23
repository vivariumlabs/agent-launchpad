# BUILD STATE — updated 2026-09-23 (session 5)

## Milestone: **M2 — session 2 done.** Full runtime core implemented locally: executors, pulse machine, LLM client, memory+snapshot, treasury daemon. 837/837 tests green incl. BOTH M2 exit-gate artifacts (adversarial mock-LLM suite, snapshot→restore identity). Next: M2 session 3 (chat server + gating tests, anvil integration, wiring/composition root) → close M2.

## Done (session 2; sessions 1–4 summaries in git history of this file)
- **`runtime/SPEC-M2B.md`** (Fable): normative spec for executors, keyring gates K1–K4, engine social/journal/approve extensions, LLM client, pulse, memory, daemon, and the 13-scenario adversarial suite.
- **Engine extensions:** kinds castPost/castReply/journalWrite/actionApprove/treasuryApprove; rules S1/S2/J1/AP1/AP2; DenyCodes PACE_CAP/APPROVE_SPENDER; acrossBridge gained required `destChain`; wallets now treasury|action|fc|journal.
- **Keyring gates:** K1 single-use approvals (replay protection, keyed hash+issuedAt); K2 signTxApproved (tx content rebuilt from config — LLM/executor can never supply to/data/value/chainId; gas/fee ceilings); K3 EIP-3009 x402 auth (deterministic nonce = keccak(actionHash‖"x402"), value ≤ approved max); K4 cast signing (ed25519 via @noble, contentHash-bound).
- **Executors:** buildTx per kind from real ABIs (transcribed from contracts/ with source line refs); PoolSwapTest swap path mirroring M1 Lifecycle; Across depositV3 (interface from public spec — VERIFY vs live contract in session 3); MockChainClient; execute() with budget-consumed-before-send; composite swaps DRY-RUN the swap verdict before approving (no stranded approvals).
- **Memory:** better-sqlite3, 7 tables per 03 §7; lossless BudgetLedger serialization; AES-256-GCM snapshots (deterministic IV), LocalDirSink (mock Arweave); restoreLatest = newest decryptable. **Gate test green: populate→snapshot→destroy→restore→identical dumps**; corruption fallback + wrong-agentId-key rejection proven.
- **LLM client:** EndpointManager (health states, rotation, attested-first); SPEC-M2 §7 identity checks implemented — price ceiling, contract checks (3-strikes), daily deterministic canaries; self-ID never consulted. MockLlm + MockX402Transport.
- **Pulse machine:** tierOf (01 §6, unified impl, Evicted wakes like Dormant), deterministic context bundle (full/trimmed/minimal), THE tool table (data-exported; provably no treasury kind reachable), runPulse (inference gate → LLM → K=5 cap → map→evaluate→execute → diary/journal/posts → heartbeat → persist), scheduler with budget stretch, intra-pulse dedup of identical actions.
- **Treasury daemon:** tick() steps 1–9 per 03 §8, all through execute(); golden ordered-action test; Conserving skips allowance; Dormant runs survival steps + distribute/convert (fee-income wake path).
- **Adversarial suite (gate): 13 scenarios green** — drains, lookalikes (incl. allowed 3-byte near-miss documented as D13 game bound), counterparty drip, tool flood (K cap), treasury-tool absence, malformed outputs, social flood, approve abuse, K1 replay, bounded-loss computation, canary-failure rotation, budget exhaustion. Suite validated by deliberate mutations (3 planted bugs each caught).
- **SPEC rev 2 (Fable review rulings, from subagent-surfaced spec bugs):** see decisions below.

## In progress / next steps
- **M2 session 3 (close-out):** chat server (SIWE + dual-RPC balance gate + rate limits per 03 §5, TLS deferred to M3) + its attack tests (signature spoofing, balance-flash, rate-limit races); composition root wiring (deps.log → insertAction, ledger history rows for daemon burn calc, announceTierTransition into scheduler loop); install foundry in sandbox → anvil integration tests for executors (real ABIs vs deployed bytecode; verify Across depositV3 signature); update hygiene/invariants if wiring adds src dirs; M2 exit-gate checklist against 07 §M2 and close.
- Carry into M3: real x402 HTTP transport; real Farcaster message framing (parentHash is 20B there, we hold 32B); real Across quotes (M2 uses 1% bps bound, amounts not grossed-up for fees); WETH unwrap after ETH bridges; real viem ChainClient; receipts→trades P&L (currently minOut placeholder); mainnet-grade swap router (PoolSwapTest has NO on-chain minOut — slippage advisory only; MUST fix before real money).

## Blocked on Juan
- Nothing for session 3. Queued: multisig (M6), RPC key, legal/audit sourcing (~M3).

## Known issues / debt
- Swap slippage unenforced on-chain (router limitation) — hard blocker before mainnet real-money swaps, listed above.
- registerInstance needs codeHash+attestationRef (cfg.registration optional; belongs to M3 attestation boot).
- distribute uses minConversionOut=0 (hook's own impact bound is the guard).
- Approvals are process-internal (not cryptographically authenticated); execute() is the sole policy path; guarantee is structural + attested code hash. Documented.
- Dedup edge: identical-second duplicate approve from two same-amount swaps K1-throws (caught+logged, small budget waste). Envelope-vs-tool duplicate posts same. Acceptable noise.
- Bridge amounts not fee-grossed (arrive ~1% short of target); refill/gas targets tolerate.
- M1 debt unchanged (HookDeployer runbook, bytecode headroom, vendored lib/).

## Decisions made this session (build-level; 01 §5 parameter table edited with changelog lines)
- **T0 rev 2:** the 45d hosting reserve gates ONLY fundable-draining outflows (allowance, stable-asset bridges). gasTopUp/ETH-bridges/arweave/x402Data/inference exempt (survival infra or already-bridged funds, all daily-capped). Fixes a real contradiction: rev 1 made Conserving agents unable to think and starved heartbeat gas. 01 §5 table updated with changelog (values unchanged, semantics made precise).
- **I1 rev 2:** floor (5 USDG) applies only at runway ≥ 45d; 3–45d ⇒ income-only budget min(raw, 60); < 3d ⇒ no LLM (Dormant hard cutoff). New cfg `dormantRunwayDays 3 DEFAULT`.
- **A2 rev 2:** actionMint now counterparty-capped (was a K×20% ETH/pulse drain vector — caught in review).
- **A4 rev 2:** actionSwap must have a USDG leg (token↔token unbuildable, stranded approvals).
- Composite swaps dry-run the swap verdict pre-approve; every deny (incl. dry-run) memory-logged.
- tierOf unified (pulse/tier.ts canonical); Evicted wake requires >5d like Dormant.
- Daemon: refill target max(10×burn, 15); snapshot due at ≥24h; allowance precheck on 24h not dayKey; Dormant collects fee income.
- Output-token bridge mapping: stables → USDG on rh / USDC elsewhere; ETH → WETH (unwrap = M3).
- INV4 rewritten to rev 2 oracle + new INV4b (Dormant never infers; floorless budget bound fuzzed).

## Evidence links
- `cd runtime && npm run typecheck && npm test`: 24 files, **837/837 green** (2026-09-23). Gate artifacts: `test/pulse/adversarial.test.ts` (13 scenarios), `test/memory/snapshot.test.ts` ("gate: snapshot→restore identity").
- Adversarial-suite mutation validation: 3 planted bugs (K=6, unlogged denies, treasury-mapped tool) each caught by ≥1 scenario.
- Sessions 1–4 evidence unchanged (M0 spike, M1 testnet lifecycle, policy-engine invariants).
- Git: `3d8056f` (M2 s1) → this commit.
