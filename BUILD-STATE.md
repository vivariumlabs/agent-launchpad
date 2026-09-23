# BUILD STATE — updated 2026-09-23 (session 6)

## Milestone: **M2 — CLOSED.** Exit gate green per 07 §M2: adversarial mock-LLM suite ✓, snapshot→restore identity ✓; plus policy invariants, chat-gating attack suites, and a 13/13 anvil integration run validating executor ABIs against real deployed bytecode. 951/951 unit tests, 31 files. Next: M3 (TEE integration + genesis, per 03/04).

## Done (session 3 of M2; s1/s2 in git history: `3d8056f`, `1fd14ff`)
- **`runtime/SPEC-M2C.md`** (Fable): chat server, composition root, chain integration.
- **Chat server (03 §5, D9):** own EIP-4361 parser + viem signature verify (per-check reason codes; nonce consumed only after all checks — 8 concurrent replays ⇒ 1 session); HMAC session tokens (constant-time, keyring-derived "chat" key); per-message dual-RPC balance gate, exact bigint math, both readers must resolve AND agree else fail-closed 503; rate limits via single-transaction count+insert (race test: exactly 20/30 concurrent accepted); policy denies surfaced as persona-friendly refusals with reason; strict per-wallet context isolation (MockLlm prompt-capture proven). 96 tests across spoofing/balance-flash/rate-race/isolation/budget + real-socket smoke.
- **Composition root:** `boot()` → Runtime{start,stop}: config hash refuse-to-boot, keyring w/ retry, memory open-or-restore (corrupt db moved aside; undecryptable state ⇒ refuse boot rather than silently resetting daily caps), every ExecResult → `actions` row, injectable timers, tier-transition announce dedupe, stop() = drain → final snapshot → close. next-pulse time persisted BEFORE each pulse (no crash-restart paid-pulse loops). `main.ts` argv-only. 20 boot tests.
- **Chain integration (foundry 1.8.3 in sandbox, forge build clean, contracts/ untouched):** full Deploy.s.sol + Lifecycle phase1/2 on anvil (chain 46630, PoolManager code-injected at pinned address, temp project dir so committed testnet artifacts stay pristine). **Verified against real bytecode:** registerInstance (calldata == buildTx output; readback incl. codeHash/generation), heartbeat (+pre-registration revert path), ERC-20 transfer/approve flows, PoolSwapTest swaps both directions via swapExactIn, FeeSplitHook.distribute + pendingFees, RealChainClient reads. Compiled-ABI-verified: every abi.ts entry. **UNVERIFIED: Across depositV3** (no vendored interface; hand-checked vs upstream e814cb4 — M3 must verify vs live contract). `npm run test:integration` 13/13; hermetic unit suite unaffected.
- **RealChainClient** (viem): suggested fees passed through unclamped (keyring cap is the check), 20% gas headroom, chain-id verification, pending-nonce.

## M3 checklist (carry-over, consolidated)
1. Reproducible Docker image + pinned code hash; real Nautilus keyring (derive-server retry pattern ready); attestation → Arweave; registerInstance codeHash/attestationRef from boot attestation (cfg.registration currently a fixture).
2. Genesis orchestrator (04) end-to-end on RH testnet; kill/restore drill with real KMS+CVM (release gate); TLS ingress per runtime/docs/TLS-INGRESS.md (ACME + attestation-bound fallback).
3. Real x402 HTTP transport (+ per-call salt in the inference action — root fix for same-second action-hash collisions; M2 uses a µUSD cost-bump workaround in chat); real Farcaster framing (20B parentHash vs our 32B); real Across quotes + gross-up for fees + **verify depositV3 vs live SpokePool** (upstream now also has a bytes32 `deposit` — decide); WETH unwrap after ETH bridges.
4. ChainClient.getBalance (native) — daemon gas step reads 0 native until then; Oyster paid-until reader (hosting is static config in M2); receipts→trades real P&L; verify real RH fee levels vs 1-gwei cap default.
5. On-chain config hash must cover exactly the agent-config portion (boot hashes the whole file incl. runtime section — split at genesis wiring).
6. Mainnet-grade swap router or sqrtPriceLimit slippage (PoolSwapTest has NO on-chain minOut) — hard blocker before real-money swaps.
7. Minor debt: daemon may re-announce a same-day tier flip-flop; chats table unindexed; nonce store floodable (10k LRU); no CORS; no EIP-1271 (contract-wallet chat — likely M4 with website); no `start` script (Docker build provides).
8. Needs Juan at M3 start (06 §1): fund orchestrator wallet (USDC + ETH on Arbitrum One) for CVM deploys; begin audit/legal sourcing (07 §4).

## Blocked on Juan
- Nothing to start M3 design/dockerization; funding needed before real CVM deploys (see checklist 8).

## Known issues / debt
- See M3 checklist above (consolidated). M1 debt unchanged (HookDeployer runbook, factory bytecode headroom, vendored lib/).

## Decisions made this session (build-level)
- Chat gate fail-closed matrix: both-fail ⇒ 403, anything ambiguous (disagree/error/timeout) ⇒ 503; refused messages still consume rate budget (conservative); chat context uses a dedicated public self-summary kv (never the rolling summary — it may carry other wallets' chat summaries).
- Boot refuses on undecryptable persisted state (fresh ledger would reset daily caps — availability sacrificed for cap integrity).
- Config hash at boot covers the whole file (stricter than 03 §10) until genesis splits the on-chain-anchored agent portion (checklist 5).
- Integration suite excluded from `npm test` (hermetic); anvil fee-cap override is test-config only.
- Accepted µUSD cost-bump for same-second chat inference uniqueness (root fix = M3 salt field).

## Evidence links
- Unit: `cd runtime && npm run typecheck && npm test` — **31 files, 951/951 green** (2026-09-23).
- Integration: `npm run test:integration` — **13/13 vs real bytecode on anvil** (~25s); ABI verification table in session log; suite self-skips loudly without foundry.
- Gate artifacts: `test/pulse/adversarial.test.ts` (13 scenarios, mutation-validated), `test/memory/snapshot.test.ts` ("gate: snapshot→restore identity"), `test/chat/*` (attack suites, bug-plant-validated ×2).
- M0/M1 evidence unchanged. Git: `3d8056f` → `1fd14ff` → this commit (M2 close).
