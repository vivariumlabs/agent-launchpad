# M1 CONTRACT SPEC — authored by Fable, session 2026-09-22

Binding spec for M1 implementation. Subagents implement exactly this; concerns come back to Fable, do not improvise. Source docs: `docs/02-CONTRACTS.md`, decision log `docs/00-OVERVIEW.md` §3. Pattern source: PONS V2 (`/tmp/pons-labs`, MIT — credit adapted files with `// Adapted from pons-labs (MIT): <file>`).

## Global conventions

- Solidity `0.8.26`, evm `cancun`, Foundry. Deps pinned in `contracts/README.md`.
- USDG = 6 decimals everywhere. AGENT tokens = 18 decimals. Never hardcode 1e18 for USDG.
- All fee constants in bps, `BASIS_POINTS = 10_000`.
- OZ for ERC-20/721/SafeERC20/ReentrancyGuard. v4-core/v4-periphery pinned commits.
- Patterns to copy from PONS everywhere (see study notes): balance-delta accounting at every ERC-20 boundary (`_transferExact` / measure received delta, revert `InexactTransfer` on fee-on-transfer); state zeroed before external calls (CEI); one-time wiring setters that revert `AlreadySet`; `renounceOwnership` disabled where Ownable is used at all; custom errors, no require-strings; nonReentrant on external entrypoints except where a function must run inside another guard (document each such case).
- NO admin/owner functions beyond what §per-contract says. No sweep/rescue/withdraw functions anywhere except the explicitly specced ones. This is stricter than PONS — we deliberately drop their owner backdoors (forceSweep/rescue): revival + permissionless retry is our recovery story.

## Parameters (DEFAULT = Juan-tunable, record in BUILD-STATE)

| Param | Value | Where |
|---|---|---|
| TOTAL_FEE_BPS | 300 (1/3 each leg) | curve + hook, constant |
| AGENT_SUPPLY | 1_000_000_000e18 | factory constant DEFAULT |
| PHANTOM_QUOTE | 6_000e6 USDG | factory constant DEFAULT |
| GRADUATION_THRESHOLD | 42_000e6 USDG real reserve | factory constant DEFAULT |
| CREATION_FEE | 75e6 USDG | factory, DEFAULT |
| GENESIS_WINDOW | 24 h | factory/registry DEFAULT |
| REVIVAL_WINDOW | 7 days | registry DEFAULT |
| Pool: fee=0, tickSpacing=60, hook=FeeSplitHook | fixed | factory |
| Hook distribute: MAX_IMPACT_BPS=100, MAX_CONVERSION_PER_CALL=5_000e6 (USDG-equiv), DISTRIBUTE_COOLDOWN=1 h | hook constants DEFAULT |
| Buyback: maxPerPoke=2_000e6, cooldown=1 h, rewardBps=30 capped 10e6 | multisig-tunable within hardcoded bounds: maxPerPoke≤10_000e6, cooldown≥10 min, rewardBps≤100 |

## Contract inventory & file layout

```
src/interfaces/ILaunchpad.sol   — shared (written by Fable, do not modify)
src/libraries/CurveMath.sol     — adapt PonsV2BondingCurveMath (MIT credit)
src/libraries/GraduationMath.sol— adapt PonsV2GraduationMath (MIT credit)
src/AgentToken.sol  src/AgentNFT.sol  src/AgentRegistry.sol
src/RoyaltyDistributor.sol  src/TreasuryBuyback.sol
src/AgentBondingCurve.sol  src/AgentFactory.sol  src/FeeSplitHook.sol
src/GraduationGuard.sol  src/GraduationExecutor.sol  src/LiquidityLocker.sol
```

## Per-contract requirements

### AgentToken (Sonnet)
OZ ERC20 + ERC20Burnable + ERC20Permit. Constructor mints full fixed supply to the curve address passed in. No owner, no mint, no other logic.

### AgentNFT (Sonnet)
OZ ERC721. `mint(to, agentId, tokenURI_)` only by factory (one-time-set). tokenId == agentId. Per-token URI storage (Arweave), immutable once set. `burn(tokenId)` by token owner only → calls `royaltyDistributor.onBurn(agentId)` then burns. Irreversible. No admin functions, no base-URI setter.

### AgentRegistry (Sonnet)
Struct per 02 §6 (`treasuryEOA, actionEOA, codeHash, attestationRef, lastHeartbeat, generation`). 
- `openGenesis(agentId, deadline, expectedTreasuryEOA)` — factory only. Pins the KMS-predicted treasury address (publicly recomputable via Marlin kms-derive); first registration is only accepted from exactly that address. **Fable review finding 2026-09-22:** without this pin, any EOA could front-run the enclave during the genesis window, hijack the fee stream permanently and block the creator's cancel refund.
- `registerInstance(agentId, treasuryEOA, actionEOA, codeHash, attestationRef)`:
  - require `msg.sender == treasuryEOA` (possession proof).
  - First registration: only while genesis open (`block.timestamp <= deadline`) and not yet registered. Pins `codeHash` and both EOAs; sets `generation = 1`, `lastHeartbeat = now`.
  - Re-registration (revival): only if `block.timestamp - lastHeartbeat > REVIVAL_WINDOW`; require identical `treasuryEOA`, `actionEOA`, `codeHash` to the pinned ones (KMS guarantees same image+agentId ⇒ same keys; different keys means different code — reject). Updates `attestationRef`, `generation++`, refreshes heartbeat. Single-instance lock: fresh heartbeat blocks displacement.
- `heartbeat(agentId)` — only from registered treasuryEOA; updates `lastHeartbeat`.
- Views: `treasuryOf(agentId)` (revert if unregistered), `isRegistered`, full getter. No admin.

### RoyaltyDistributor (Sonnet)
USDG-denominated, pull-based.
- `credit(agentId, amount)` — only hook or the agent's registered curve (`factory.curveOf(agentId)`... no: distributor stores `authorizedCurve[agentId]`, set once by factory; hook address set once at deploy wiring). Caller must have transferred `amount` USDG first; verify with balance-delta accounting (`accountedBalance` pattern: track total accounted, require actual balance ≥ accounted + amount).
  - If emancipated: forward `amount` directly to `registry.treasuryOf(agentId)` instead of accruing.
- `claim(agentId)` — pays full accrued to current `nft.ownerOf(agentId)`, callable by anyone (funds go to owner regardless).
- `onBurn(agentId)` — only AgentNFT. Sets `emancipated[agentId] = true` (one-way), sweeps unclaimed accrual to `registry.treasuryOf(agentId)`, emits `Emancipated(agentId)`.
- No admin.

### LiquidityLocker (REVISED by Fable, session 2 — replaces the PositionManager/ERC721 model)
**Decision:** graduation liquidity is minted **directly on the PoolManager** by the locker via its own `unlock` callback + `modifyLiquidity` (full range for tickSpacing 60: ticks ±887220, salt = bytes32(agentId)). PositionManager + Permit2 + GraduationExecutor are dropped entirely. Rationale: a v4 position owned by a contract with no removal function is locked forever by construction; removes the Permit2 two-step, ERC721 custody, and an unconfirmed testnet PositionManager dependency; the M0 spike already proved direct liquidity provisioning against the real PoolManager.
- `lock(agentId, key, amount0, amount1)` — factory only, once per agent. Factory transfers both amounts to the locker immediately before. Locker computes liquidity via LiquidityAmounts-style math from current sqrtPrice (read live) and the amounts, `poolManager.unlock` → `modifyLiquidity(+L)` → settle both currencies from its own balances (sync/transfer/settle, balance-delta checked). Reverts if liquidity == 0.
- Rounding dust after settlement is stranded in the locker (wei-level, equivalent to burned; documented).
- **No** other mutating functions. `lockedLiquidity(agentId)` view.

### CurveMath + AgentBondingCurve (Opus)
CurveMath: port PONS `getAmountOut`/`getAmountIn`/`quoteAmountOut` verbatim semantics (input-side fee variant NOT used — see below; we fee the USDG side explicitly, so use the feeBps=0 variants for pricing and handle fees outside the math lib).

Curve: constant-product AGENT vs (realUSDG + PHANTOM_QUOTE), PONS V2 pattern, deployed per agent as EIP-1167 clone (`initialize(...)` once, factory only).
- `buy(usdgIn, minTokensOut, recipient)`: pull USDG (balance-delta), fee = 3% of usdgIn taken first, net goes to reserve, price via constant product. Fee split: 1% TreasuryBuyback (plain transfer), 1% `registry.treasuryOf(agentId)` (plain transfer), 1% RoyaltyDistributor (transfer + `credit`). Immediate push, no accrual.
- `sell(tokensIn, minUsdgOut, recipient)`: price via constant product on gross, fee = 3% of gross USDG out, payout = gross − fee, same 3-way split. Sells revert once `readyToGraduate`.
- `readyToGraduate()`: real USDG reserve ≥ GRADUATION_THRESHOLD. Once crossed, buys also close (curve is done).
- `graduate(to)` — factory only, once: transfers **tracked** reserves (not raw balances — donations must not move the opening price) of USDG and AGENT to factory; marks graduated.
- Reentrancy: nonReentrant on buy/sell; CEI. Track reserves in storage, never `balanceOf` for pricing.
- Invariant/fuzz tests: (a) fee legs sum to exactly 3% of USDG volume ± 3 wei rounding dust per trade, dust accounted; (b) k never decreases from trades; (c) no path sends funds to any address outside {reserve, three recipients, trader}; (d) buy→sell round trip never profits the trader.

### FeeSplitHook (Opus — the hard one, test to death)
Singleton v4 hook, all agent pools. Permissions: `beforeInitialize` (restrict pool creation to factory), `afterSwap` + `afterSwapReturnDelta`. Address mined with correct flag bits (HookMiner in tests/deploy script).
- `registerPool(key, agentId, agentToken)` — factory only, once per pool; validates hook==this, one currency == agentToken, other == USDG; stores poolId → {agentId, agentIsCurrency0}, poolKey.
- `_afterSwap`: PONS pattern exactly — fee = 300 bps of |unspecified delta|, `poolManager.take` it, accrue `pendingFees[poolId][currency]`, return the int128 delta. Skip when unregistered (must be impossible given beforeInitialize gate, but stay safe) or zero.
- `distribute(poolId, minConversionOut)` — **permissionless**, nonReentrant, cooldown per pool:
  1. Convert pending AGENT-side fees to USDG via this pool through the PoolManager (hook's own swap; v4 skips hooks when hook is caller). Per-call conversion capped: convert at most an amount whose quoted USDG value ≤ MAX_CONVERSION_PER_CALL; enforce execution price within MAX_IMPACT_BPS of pre-swap spot AND ≥ caller's `minConversionOut`.
  2. Split total pending USDG into thirds: transfer to TreasuryBuyback; transfer to `registry.treasuryOf(agentId)` (live lookup — never store the treasury address); transfer + `credit(agentId, third)` to RoyaltyDistributor. Remainder (≤2 wei) stays pending.
  3. Rounding: accumulate, never revert on tiny amounts.
- No owner, no params setters — all constants immutable. Addresses (registry, distributor, buyback, usdg, factory) set in constructor / one-time factory wiring.
- Known accepted risk (document in natspec + BUILD-STATE): spot-based impact bound is sandwichable; loss bounded by MAX_IMPACT_BPS × MAX_CONVERSION_PER_CALL per cooldown period.
- Tests: fork tests against real PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951` (RH testnet fork, rpc endpoint `rh_testnet`): exact-in/exact-out both directions, fee exactness invariant (sum of legs == 3% of volume), distribute happy path + conversion cap + impact bound revert + cooldown, hostile-ordering (distribute mid-lifecycle, distribute with zero pending, reentrancy attempt via malicious token — AGENT tokens are ours so token callbacks don't exist, but test with a mock hostile caller), gas snapshot of hooked swap (target < 120k added vs bare swap; record number).

### GraduationChecks (library) / GraduationMath / graduation flow in factory (Opus — REVISED, executor dropped)
GraduationChecks = internal **library** (not a contract) of stateless preflight asserts adapted from PONS GraduationGuard (credit): int128 (not uint128) amount ceilings, sqrtPrice within TickMath bounds, resulting liquidity nonzero and ≤ maxLiquidityPerTick(60). Run **before** the irreversible sweep (phase 1) and again before seeding (phase 2). GraduationMath = PONS port (credit) for sqrtPriceX96FromAmounts.
Factory graduation, two phases, both permissionless:
- `graduate(agentId)`: requires `curve.readyToGraduate()`; guard preflight; sweep curve via balance-delta; compute `poolTokens = mulDiv(sweptTokens, sweptQuote, sweptQuote + PHANTOM_QUOTE)`; **burn** `sweptTokens − poolTokens` (AgentToken is Burnable); record swept state; CEI.
- `createGraduatedPool(agentId)`: retryable; re-check guard; `hook.registerPool` FIRST, then init pool (fee 0, tickSpacing 60, hook) with sqrtPrice from GraduationMath on the sorted amounts; transfer both amounts to locker; `locker.lock`. Zero swept state before external calls.
- `finalize` uses `pending.imageURI` as the NFT tokenURI (it is the Arweave metadata URI uploaded by the website pre-create; 02 §5 semantics — document in natspec).

### AgentFactory (Opus)
Per 02 §2 exactly:
- `createAgent(name, symbol, imageURI, configHash, creator, expectedTreasuryEOA)` payable: pull CREATION_FEE USDG (balance-delta), forward `msg.value` ETH to `genesisGasRecipient` (constructor-set orchestrator gas address, immutable), store PendingAgent, `registry.openGenesis(agentId, now + GENESIS_WINDOW, expectedTreasuryEOA)`, emit `AgentRequested(agentId, configHash, creator)`. agentId = incrementing counter starting 1.
- ORDERING (binding, from Fable review): in `finalize`, the full AGENT supply must be minted to the clone address BEFORE `curve.initialize` runs (initialize seeds `_tokenReserve` from balanceOf), all in one tx. In `createGraduatedPool`, `hook.registerPool` must run BEFORE `poolManager.initialize` and before any liquidity/swap can touch the pool (`beforeInitialize` only gates by sender; an initialized-but-unregistered pool would swap untaxed).
- `finalize(agentId)` — permissionless; requires `registry.isRegistered(agentId)` and pending: deploy AgentToken (full supply → curve clone), deploy + initialize curve clone, `distributor.setCurve(agentId, curve)`, `nft.mint(creator, agentId, tokenURI)`, transfer CREATION_FEE to platformFeeRecipient, emit `AgentLive`. Clear pending.
- `cancel(agentId)` — creator only, only after genesis deadline passed and not registered/finalized: refund CREATION_FEE USDG (ETH not refundable — spent on orchestrator gas). 
- Owner = platform multisig; **only** power: `pause()/unpause()` gating `createAgent` (never finalize/graduate/cancel), and `setPlatformFeeRecipient`. Ownable2Step, renounce disabled.
- Graduation functions as above.

### TreasuryBuyback (Opus)
- Receives USDG passively (hook leg, curve leg, swept dust, PONS creator-fee sweeps later).
- `setTargetPool(poolKey)` — multisig, **one-time** (`AlreadySet`): the $TOKEN/USDG v4 pool (PONS pool; exists M6 — until set, `poke` reverts `TargetNotSet`).
- `poke(minTokensOut)` permissionless: swap `min(maxPerPoke, balance)` USDG → $TOKEN via PoolManager; require execution price within 500 bps of pre-swap spot (hardcoded) and out ≥ minTokensOut ≥ 0 rejected if 0 — require nonzero minTokensOut (PONS lesson); send $TOKEN to `0xdead` (works regardless of burnability); pay caller `rewardBps` of swap in USDG, capped; cooldown.
- Multisig tuning within hardcoded bounds (params table). **No withdrawal of any kind.** Note in natspec: swapping through the PONS pool pays their hook fee; accepted.
- Unit tests with a local v4 pool standing in for the PONS pool; hostile-ordering tests (poke spam at cooldown edge, poke sandwiched, poke with dust balance).

## Cross-cutting invariant suite (02 §8 — required for M1 gate, some tests land next session)
(a) Σ fee legs == 3% of volume (curve + pool phases); (b) no path moves treasury/royalty funds outside the three recipients; (c) single-instance lock unbypassable while heartbeats fresh; (d) burn re-route one-way; adversarial ordering suite (attacker EOAs calling distribute/poke/registerInstance/finalize/cancel in hostile orders); gas snapshots.

## Test conventions
- Unit tests: local PoolManager deployment (v4-core `PoolManager`), not fork, for speed — file per contract `test/<Name>.t.sol`.
- Fork tests: `test/fork/*.t.sol`, `vm.createSelectFork(vm.rpcUrl("rh_testnet"))`, guard with try/catch skip if RPC down.
- Every subagent runs its own tests green before returning; set `FOUNDRY_OUT=out-<batch>` and `FOUNDRY_CACHE_PATH=cache-<batch>` env vars to avoid clobbering parallel builds.
- forge fmt clean.
