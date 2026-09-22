# BUILD STATE — updated 2026-09-22 (session 3)

## Milestone: **M1 — CLOSED.** 309/309 tests green AND full stack deployed to RH testnet with a complete real-transaction lifecycle (45 txs, 0 failures). Next: M2 (runtime core, per 03-AGENT-RUNTIME.md).

## Done
- All of session 2 (git `995a376`, `4f11bab`, `d9f388c`): eight contracts, SPEC-M1.md, 309-test suite (unit + invariant + 24-test adversarial + live-fork lifecycle), genesis front-run fix, direct-PoolManager locker, deploy-time buyback impact bound.
- **Deploy tooling:** `script/Deploy.s.sol` (in-script CREATE2 salt mining for the hook flag bits, full wiring + on-chain graph assertions, manifest write), `script/Lifecycle.s.sol` (3 phases, each stage guarded on chain state → idempotent re-runs), `script/support/{MockUSDG,HookDeployer,LaunchpadScript}.sol`. Rehearsed on an anvil fork before spending real ETH.
- **TESTNET DEPLOYMENT (chain 46630), all 12 contracts source-verified on Blockscout.** Key addresses: FeeSplitHook `0x40053E41fa0Bcdcd2EB127954Ce624323e9aa044` (mined, low bits 0x2044), AgentFactory `0x7b257abd9BDf3377Af03DD67e2D67a8D5717b118`, AgentRegistry `0xDBA9680C…2f59`, RoyaltyDistributor `0x25138BDF…d53B`, LiquidityLocker `0x6213D1fb…7a68`, TreasuryBuyback `0xD10097D4…A67D`, MockUSDG `0xe6f7E583…ccAb`. Full table + every tx hash: `contracts/deployments/testnet-46630.json` + `testnet-46630-lifecycle.md`.
- **Lifecycle drill on-chain (M1 gate artifact):** create → registerInstance from the pinned treasury EOA → finalize → 30k USDG curve buys → claim #1 (300 USDG to creator) → sell → closing buy (reserve 42,970 ≥ 42,000) → graduate (15.0M AGENT burned) → createGraduatedPool (2.1494e18 liquidity locked on the real PoolManager) → pool swaps both directions (hook fees accrued) → NFT transfer → claim #2 pays NEW owner (282.12 USDG) → distribute #1 (AGENT converted, 3×28.699315 legs) → burn → emancipation sweep 28.699315 to treasury → +1h wall clock → distribute #2 pays treasury 2× leg (re-route proven live) → heartbeat. Revival skipped (needs 7-day lapse; covered by unit/adversarial suites).
- Gas: 23.10M total = 0.000231 ETH @ 0.01 gwei. Drill wallet ends with 0.01035 ETH on testnet (plus dust on 3 scripted EOAs, keys derived from public seeds in LaunchpadScript.sol).
- USDG-acquisition attempt (per Juan): testnet holds TSLA/AMD/AMZN/NFLX/PLTR demo stocks in the drill wallet; the only USDG pool pairing anything we hold (USDG/TSLA, dynamic-fee hook) has **zero liquidity** → mock USDG per Juan's fallback. Mainnet passes the real USDG address to the same constructors.

## In progress / next steps
- **Start M2** (runtime core, local — per 03-AGENT-RUNTIME.md): `runtime/` skeleton, keyring (mock KMS), policy engine + its full test suite (the most important code in the project), pulse machine vs mock LLM + local chain fork, memory + snapshot/restore, treasury daemon.
- Carry-over design follow-ups for M2 already queued in session-1 notes (TLS/cert flow for chat ingress, derive-server retry-at-boot, x402 allowlist curation, model-identity sanity checks).

## Blocked on Juan
- Nothing for M2 start. Still queued for later: platform multisig (M6), dedicated RPC key (nice-to-have), legal/audit sourcing from ~M3 (07 §4).

## Known issues / debt
- **Mainnet runbook item (from deploy):** FeeSplitHook pins `deployer = msg.sender` for its one-time `setFactory`; deploying the mined address via the canonical CREATE2 singleton would brick that wiring. Deployment MUST go through a HookDeployer-style owned CREATE2 contract (pattern now in `script/support/HookDeployer.sol`). Same applies to any future re-deploy.
- Factory bytecode headroom ~4.4KB (optimizer runs=200); next growth needs AgentToken cloning.
- Public RPC for fork tests; `lib/` vendored without git metadata (pins in contracts/README.md).
- Minor knowns unchanged: zero-liquidity distribute cooldown burn (griefing-only); ≤33-wei USDG trades pay zero fee; hostile-treasury-contract graduate-mid-buy quirk (unreachable in production, wei-exact anyway).

## Decisions made this session (build-level)
- Mock USDG for testnet stack (Juan, this session, after on-chain liquidity check came up empty).
- HookDeployer pattern for hook deployment (Fable, forced by the CREATE2-singleton/msg.sender interaction) — recorded as a binding mainnet runbook step.
- Lifecycle royalty-tail ordering compressed to one cooldown window (claim #1 from curve leg, claim #2 + emancipation sweep from hook credits) — same properties proven, one hour saved.

## Evidence links (test runs, tx hashes, attestation refs)
- Testnet deployment + lifecycle: `contracts/deployments/testnet-46630.json` (addresses) and `contracts/deployments/testnet-46630-lifecycle.md` (stage-by-stage transcript, 45 tx hashes with gas + status, end-state read-back). Explorer: https://explorer.testnet.chain.robinhood.com (all 12 contracts verified).
- Fable end-state spot-check via RPC 2026-09-22: `hook.factory() == 0x7b257abd…b118`; `locker.lockedLiquidity(1) == 2149368475548204523`; `distributor.emancipated(1) == true`; `registry.isRegistered(1) == true`.
- `forge test` (session 2 final): 309/309 green, 16 suites, fork suites on live RPC. Hook gas +27k warm / +63k cold.
- Git: `bf10aa3` → `995a376` → `4f11bab` → `d9f388c` → HEAD (deploy tooling + deployment artifacts + this file).
- M0 evidence unchanged: `runtime/spikes/m0-marlin-kms/RESULTS.md`; Base txs `0x9373bb0b…3636`, `0x40d4f6fa…8dd4`.
