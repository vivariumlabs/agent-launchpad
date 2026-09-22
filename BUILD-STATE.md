# BUILD STATE — updated 2026-09-22 (session 2)

## Milestone: M1 — contracts, session 1 of ~3. Core contracts + hook done and green; factory/graduation/buyback + lifecycle next.

## Done
- **Toolchain in repo:** Foundry 1.8.3, deps vendored under `contracts/lib/` as plain working trees (mount FS breaks git locks — see contracts/README.md). Added OpenZeppelin v5.1.0 (`69c8def5`). First git commits made (M0 + M1 core).
- **PONS V2 studied** (MIT, credited in adapted files). Adopted: afterSwap+afterSwapReturnDelta fee-take on the unspecified currency, pool LP fee forced to 0, two-phase graduation (irreversible guarded sweep → retryable pool-create), phantom-quote pool-leg formula, balance-delta accounting at every ERC-20 edge, one-time wiring setters. Deliberately dropped: PONS owner backdoors (forceSweep/rescue), trusted sweep operator, creator tax, snipe tax, buyback vault.
- **`contracts/SPEC-M1.md`** — binding Fable spec (params table, per-contract requirements, invariant suite). `src/interfaces/ILaunchpad.sol` — shared interfaces.
- **Implemented + tested (200/200 green, incl. live RH-testnet fork suites, fmt clean):**
  - `AgentToken` (OZ ERC20+Burnable+Permit, 1e9 supply to curve), `AgentNFT` (OZ ERC721, tokenId==agentId, owner-only burn → distributor.onBurn; burn reverts if distributor unwired), `AgentRegistry`, `RoyaltyDistributor` (accounted-balance credit gate, one-way emancipation), `LiquidityLocker`.
  - `CurveMath` (verbatim PONS port, diff-verified) + `AgentBondingCurve` (clone pattern; 3% USDG-side fee pushed per-trade in thirds; donations inert; closes at threshold; invariant suite: legs sum exact, k monotone, balance==tracked, no round-trip profit).
  - `FeeSplitHook` — singleton v4 hook: 300 bps of unspecified delta via afterSwap, per-pool pending accrual, permissionless `distribute` (AGENT→USDG conversion sized `min(pending, 5000 USDG notional, 1% of virtual reserve)`, leftover drains across calls; realized-price floor + cooldown 1h; live registry lookup for the treasury leg). Fork-verified on the real PoolManager: **hook gas overhead 27k warm / 63k cold vs bare pool (budget 120k)**. v4-core pinned commit confirmed to skip hook callbacks when the hook is the swap caller (Hooks.sol msg.sender==self short-circuit) + belt in `_afterSwap`.

## In progress / next steps (next session)
- **AgentFactory** (create/finalize/cancel + two-phase graduation), **GraduationGuard/Executor/Math**, **TreasuryBuyback** — spec'd in SPEC-M1.md, incl. binding ordering: mint supply → clone → initialize; hook.registerPool BEFORE pool init.
- Then: full-lifecycle testnet transcript (create → finalize → curve trades → graduate → pool swaps → distribute → claim → burn → re-route), cross-cutting invariant + adversarial-ordering suites, deploy script with real CREATE2 hook-address miner (HookMiner absent from pinned v4-periphery; tests use deployCodeTo).
- M1 exit gate after that per 07.

## Blocked on Juan
- Nothing blocking. Queued for M1 deploy: platform multisig, deployer wallet, dedicated RPC key (06 §1).
- **Review requested (defaults chosen, revisable):** (1) curve economics DEFAULTs: supply 1e9, phantom 6,000 USDG, graduation threshold 42,000 USDG real reserve, creation fee 75 USDG; (2) leftover curve tokens are **burned** at graduation (supply shrinks; %-of-supply gates self-consistent) instead of locked; (3) 02 §7's "short TWAP" for buyback `poke()` is not implementable on v4 (no oracle) — replacement: price-impact bound vs spot (5%) + per-poke cap + cooldown + mandatory nonzero minOut; same spot+caps model on hook `distribute` (bounded-sandwich risk ≤ ~50 USDG/hour/pool, documented in natspec).

## Known issues / debt
- Fork tests still on the public RPC (get dedicated key by deploy).
- `lib/` vendored without git metadata (mount limitation) — commits pinned in contracts/README.md.
- Hook `distribute` on a zero-liquidity pool with only AGENT pending: burns the cooldown, converts nothing (harmless griefing surface, noted in code).
- Curve trades ≤33 wei USDG pay zero fee (floor rounding; economically irrelevant).

## Decisions made this session (build-level; no 00 §3 items reopened)
- **Fee mechanism:** afterSwap on unspecified currency (PONS/Flaunch pattern), not 02 §3's sketched beforeSwap-on-specified — correct for exact-out, proven on this chain. Pool fee = 0, tickSpacing = 60.
- **Security fix (Fable review):** genesis front-run closed — `createAgent` carries the KMS-predicted `expectedTreasuryEOA` (publicly recomputable, M0-proven); registry only accepts first registration from exactly that address. Without it, any EOA could hijack a new agent's fee stream during the genesis window and block the creator's cancel refund.
- Hand-rolled ERC20/721 replaced with OZ v5.1.0 per 02's "fork audited patterns" rule; AgentToken gained free EIP-2612 permit.
- Delegation model worked: Sonnet (periphery), Opus ×2 (curve, hook), Fable spec+review; 2 review-driven fix rounds (conversion sizing, OZ refactor).

## Evidence links (test runs, tx hashes, attestation refs)
- `forge test` 2026-09-22 (session 2): **200 passed / 0 failed / 0 skipped**, 11 suites, incl. `test/fork/FeeSplitHook.fork.t.sol` (5 tests vs live `rpc.testnet.chain.robinhood.com`, PoolManager `0x8366…0951`) and the M0 suite (3). Gas: hooked swap +27,023 warm / +63,223 cold.
- Git: `bf10aa3` (M0), `995a376` (M1 core). Toolchain: Foundry 1.8.3, solc 0.8.26, cancun. Dep pins in `contracts/README.md`.
- M0 evidence unchanged: `runtime/spikes/m0-marlin-kms/RESULTS.md`; Base txs `0x9373bb0b…3636`, `0x40d4f6fa…8dd4`; drill wallet `0x6930FD5C…0154` (~$4.99 USDC Base + ~$4.6 Arbitrum).
