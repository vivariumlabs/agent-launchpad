# BUILD STATE — updated 2026-09-22 (session 2, part 2)

## Milestone: M1 — contracts. **All eight contracts implemented, reviewed, 309/309 tests green** (unit + invariant + adversarial + live-RPC fork suites, incl. full-lifecycle transcript). Remaining for the M1 exit gate: real testnet deployment + hand-run lifecycle with actual txs, and the deploy script (CREATE2 hook-address miner).

## Done
- Everything from part 1 (see git `995a376`): toolchain, SPEC-M1.md, interfaces, AgentToken/AgentNFT/AgentRegistry/RoyaltyDistributor, CurveMath+AgentBondingCurve, FeeSplitHook (hook gas +27k warm / +63k cold; genesis front-run fix).
- **AgentFactory**: two-step create/finalize/cancel, two-phase graduation (irreversible guarded sweep + burn → retryable pool-create), owner surface = pause(createAgent only) + setPlatformFeeRecipient, renounce disabled. Binding orderings verified by log-index tests (registerPool → initialize → lock; mint-supply → clone initialize).
- **LiquidityLocker (revised design, Fable)**: mints full-range liquidity **directly on the PoolManager** via its own unlock callback (salt = agentId); PositionManager + Permit2 + GraduationExecutor dropped — position owned by a contract with no removal surface is locked by construction. `GraduationChecks` ported as an internal library (int128 ceilings, sqrt bounds, maxLiquidityPerTick), run before both graduation phases. GraduationMath = verbatim PONS port (diff-verified).
- **TreasuryBuyback**: permissionless capped `poke` (USDG→$TOKEN→0xdEaD), reward always funded by construction, cooldown, mandatory nonzero minOut; **impact bound is a deploy-time immutable (0<bps≤1000)** — Fable fix for a permanent-brick risk, since the buyback deploys before the $TOKEN pool exists (hook pins its address) and the target pool's own PONS hook fee spends from the same impact budget. `setTargetPool` one-time by design (re-settable target would let a compromised multisig drain via a hostile pool).
- **System suites**: `test/Lifecycle.t.sol` (wei-exact money conservation asserted at every stage via two independent ledgers; 3%-of-volume identity across curve + pool phases), `test/Adversarial.t.sol` (24 hostile-ordering/reentrancy/donation tests; escalated environment with callback-capable USDG + hostile treasury contract — all guards hold), fork lifecycle transcript on live RH testnet (create→register→finalize→trades→graduate→pool→distribute→claim→NFT-transfer-claim→burn→re-route→revival; full log in `forge test --match-path test/fork/Graduation.fork.t.sol -vv`).
- Optimizer enabled (runs=200) — factory is 33KB unoptimized (EIP-170 violation), 20.1KB optimized (~4.4KB headroom).
- Git: `995a376`, `4f11bab`, + this session's final commit.

## In progress / next steps (next session)
- **Deploy script** (`script/`): CREATE2 hook-address miner (HookMiner absent from pinned v4-periphery; tests use `deployCodeTo`), full deploy ordering (registry/nft/distributor/locker/buyback → mine+deploy hook → factory → one-time wiring: setFactory×4, setHook, hook.setFactory), wiring sanity asserts.
- **Real RH-testnet deployment** + hand-run lifecycle with scripted EOAs standing in for the TEE → transcript with real tx hashes into BUILD-STATE. That closes the M1 exit gate.
- Then M2 (runtime core, per 03).

## Blocked on Juan
- **For testnet deploy (next session):** a deployer key funded with RH-testnet ETH (faucet or bridge — drill wallet has only Base/Arbitrum funds), and the testnet-USDG question: real testnet USDG (`0x7E9552…802F`) has a supply controller — we cannot mint it, so the scripted lifecycle either needs testnet USDG obtained somehow or deploys with a mock USDG (mainnet uses the real one). Juan to say which; mock is fine for the gate in my view.
- **Standing review items from part 1** (curve economics defaults; burn-not-lock leftover; spot+caps instead of TWAP) — unchanged, no action needed unless Juan objects.
- Platform multisig + dedicated RPC key still queued (needed by mainnet, not by testnet gate).

## Known issues / debt
- Factory bytecode headroom ~4.4KB; next growth step needs AgentToken cloning or a linked library.
- Fork tests on public RPC; occasional latency, no failures observed.
- `lib/` vendored without git metadata (mount limitation); pins in contracts/README.md.
- Harmless quirk (tested, documented): a treasury *contract* with USDG receive-hooks could call `graduate` mid-threshold-buy — books stay wei-exact; unreachable with real USDG (no hooks) + KMS EOA treasuries.
- Zero-liquidity pool + AGENT-only pending: `distribute` burns its cooldown converting nothing (griefing-only).

## Decisions made this session (build-level; no 00 §3 items reopened)
- Part 1 decisions (afterSwap fee pattern; genesis front-run fix via KMS-predicted `expectedTreasuryEOA`; OZ v5.1.0 bases) — see `995a376`.
- **Graduation simplification (Fable):** direct-PoolManager liquidity mint by the locker; PositionManager/Permit2/Executor removed from the system (less audit surface, no unconfirmed testnet periphery dependency; M0 spike already proved direct provisioning).
- **Buyback impact bound = constructor immutable** (rationale above). $TOKEN's PONS launch params (esp. creator tax) must be chosen at M6 so the pool's effective hook fee fits inside the deployed bound — recorded as an M6 wiring constraint.
- Optimizer runs=200 (deployability, all suites re-verified green).

## Evidence links (test runs, tx hashes, attestation refs)
- `forge test` 2026-09-22 (session 2 final): **309 passed / 0 failed / 0 skipped**, 16 suites; fork suites against live `rpc.testnet.chain.robinhood.com` (chain 46630, PoolManager `0x8366…0951`): M0 (3), FeeSplitHook.fork (5), Graduation.fork (5 incl. lifecycle transcript). Gas: hooked swap +27,023 warm / +63,223 cold (budget <120k).
- Fork lifecycle transcript (mock 6-dec USDG, real PoolManager): agent 1 graduated at 43,650 USDG real reserve; 985.4M-token seed after burn; locked liquidity 2.15e18; per-leg curve fees 450 USDG each; post-burn royalty leg re-routes to treasury (2× leg observed). Full log via `-vv` on `test_fork_lifecycleTranscript`.
- Git: `bf10aa3` (M0) → `995a376` (M1 core) → `4f11bab` (factory/graduation/buyback) → HEAD (suites + this file). Toolchain: Foundry 1.8.3, solc 0.8.26, cancun, optimizer runs=200; dep pins incl. OZ v5.1.0 `69c8def5` in contracts/README.md.
- M0 evidence unchanged: `runtime/spikes/m0-marlin-kms/RESULTS.md`; Base txs `0x9373bb0b…3636`, `0x40d4f6fa…8dd4`; drill wallet `0x6930FD5C…0154`.
