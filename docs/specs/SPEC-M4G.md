# SPEC-M4G — D18 FloorVault: redemption floor, platform-leg retarget, v2 testnet stack (dual-stack)

> Authored by Fable, M4 session 16 (2026-09-29). Implements D18 (00 §3; 01 §1; 02 §7) and D19's
> consequence (nothing from the PONS creator stream enters the vault). Juan's ruling this session:
> **dual-stack** — the legacy v1 stack (agents 1–11, the Oct-1 revival drill, the claim/burn drills)
> stays live and indexed; the v2 stack issues agent ids from **101**. `DEFAULT` = Juan-revisable.
> Subagents implement exactly this; concerns come back to Fable. Do not reopen 00 §3 (D1–D19).

## 0. Rulings (Fable)

- **R1 (why a full stack):** the platform leg address is immutable in FeeSplitHook, the curve
  (factory-passed at initialize) and the factory; and registry/NFT/distributor/locker each carry
  one-time `setFactory`/`setHook` wiring. A new hook+factory therefore needs fresh copies of all of
  them. **MockUSDG is reused** (v1 address) so every wallet/treasury balance carries over.
- **R2 (id space):** `AgentFactory` gains an immutable constructor param `firstAgentId` (≥ 1, else
  `InvalidFirstAgentId()`); the constructor sets `agentCount = firstAgentId − 1`, so the first
  `createAgent` returns `firstAgentId`. v2 testnet = **101**; unit tests / anvil harness = 1.
  Every off-chain system is keyed by agentId — disjoint ranges make dual-stack collision-free with
  no schema change. The launch-helper's `agentCount()+1` prediction stays correct.
- **R3 (FloorVault math, binding):** `payout = mulDiv(amount, B, S)` (floor rounding) with
  `B = usdg.balanceOf(vault)` and `S = token.totalSupply()` read **before any state change**. Since
  `payout·S ≤ amount·B`, `(B−payout)/(S−amount) ≥ B/S`: redeeming never lowers the floor; rounding
  dust always stays with remaining holders. Inflows only raise B; burns anywhere only lower S. So
  for a fixed `amount`, the payout is **non-decreasing over time** ⇒ `redeem` needs no min-out
  parameter (document this in natspec — it is a user-facing property). Holds as long as the token
  cannot mint (PONS: fixed supply, 01 §1; mock: fixed supply). Floor undefined at S = 0
  (`floorPrice()` returns 0).
- **R4 (burn semantics):** tokens are pulled with `transferFrom` (balance-delta checked, exact —
  `InexactTransfer` otherwise) then destroyed with the token's own ERC20Burnable `burn(amount)`;
  the vault then asserts `totalSupply() == S − amount` (`BurnFailed` otherwise — rejects tokens
  whose burn is a no-op or a dead-address transfer). Never the dead-address pattern.
- **R5 (stray tokens):** $TOKEN sent to the vault by plain transfer would sit in `S` forever
  (no withdrawal exists) and depress the floor. `burnStray()` — permissionless, burns the vault's
  entire $TOKEN balance (reverts `ZeroAmount` when 0), emits `StrayBurned`. Only ever raises the
  floor. Not an owner power, not a parameter, not a withdrawal — consistent with D18.
- **R6 (no admin, no market):** no owner, no setters, no withdrawal/rescue/sweep of USDG, no
  swaps, no oracle. Two immutables: `usdg`, `token`. Constructor asserts `token.decimals() == 18`.
  **Mainnet ordering consequence (record in 07 M6):** the vault needs the $TOKEN address at deploy
  and the hook needs the vault at deploy ⇒ $TOKEN (PONS launch) must exist before the mainnet
  stack is deployed.
- **R7 (retired):** `TreasuryBuyback` + `poke()` + `ITreasuryBuyback` removed from `src/` and tests
  (git history + the v1 deployment keep the as-built record). The indexer stops indexing the v1
  buyback (no `Poked` ever fired: its target pool was never set). The v1 buyback's accrued USDG
  is stranded forever (testnet, no withdrawal — by design; note in docs).
- **R8 (per-stack orchestrators):** genesis stays single-stack; one config per stack.
  `genesis.testnet.json` → v1 archive manifest (Oct-1 revival drill + legacy agents);
  `genesis.testnet.v2.json` → v2 manifest, separate `dataDir` (`data-v2`). The launch-helper runs
  from whichever config the operator starts (v1 during the Oct-1 drill, v2 otherwise).
  Multi-stack revival in one orchestrator = debt, post-M4.

## 1. contracts/ (Opus)

**Interface (`src/interfaces/ILaunchpad.sol`, Fable-authored — the edits below are signed off):**
- `IAgentBondingCurve.initialize(...)`: param `treasuryBuyback` → `floorVault` (same position/type).
- `IFeeSplitHook.Distributed(bytes32 indexed poolId, uint256 floorLeg, uint256 treasuryLeg,
  uint256 royaltyLeg, uint256 converted)` (renamed field only — topic0 unchanged, so v1 logs decode
  with the same ABI).
- Remove `ITreasuryBuyback`. Add:
```solidity
interface IFloorVault {
    event Redeemed(address indexed redeemer, uint256 tokensBurned, uint256 usdgPaid);
    event StrayBurned(address indexed caller, uint256 amount);
    function redeem(uint256 amount) external returns (uint256 usdgPaid);
    function burnStray() external returns (uint256 amount);
    function quoteRedeem(uint256 amount) external view returns (uint256 usdgPaid);
    /// USDG base units per whole token (1e18 base units), scaled by 1e18: mulDiv(B, 1e36, S); 0 if S == 0.
    function floorPrice() external view returns (uint256);
    function state() external view returns (uint256 usdgBalance, uint256 tokenSupply, uint256 totalRedeemedUsdg, uint256 totalBurned);
}
```

**`src/FloorVault.sol`** (new; OZ ReentrancyGuard, SafeERC20, Math.mulDiv; custom errors
`ZeroAddress, ZeroAmount, ZeroPayout, InexactTransfer, BurnFailed, WrongDecimals`):
- `constructor(address usdg_, address token_)` — non-zero, `IERC20Metadata(token_).decimals()==18`.
- `redeem(amount)` nonReentrant, exact order: `amount==0`⇒ZeroAmount → read B,S → payout (R3) →
  `payout==0`⇒ZeroPayout → effects (`totalRedeemedUsdg += payout; totalBurned += amount`) → pull
  (R4, delta==amount) → `burn(amount)` → assert supply (R4) → `usdg.safeTransfer(msg.sender,
  payout)` → emit `Redeemed`. Returns payout.
- `burnStray()` nonReentrant per R5 (does NOT touch `totalBurned`).
- Views per the interface. Natspec: D18, R3's monotone property, "no owner / no withdrawal", the
  mint caveat, and that donations are plain USDG transfers.

**Retarget:** `FeeSplitHook` + `AgentBondingCurve` + `AgentFactory`: `treasuryBuyback` →
`floorVault` (storage/immutable name, ctor/initialize param, natspec — "floor vault (D18)").
`AgentFactory`: R2 `firstAgentId` (constructor param inserted right after `floorVault_`; public
immutable). No other behavior change anywhere.

**Removed:** `src/TreasuryBuyback.sol`, `test/TreasuryBuyback.t.sol`, `test/mocks/BuybackMocks.sol`
(if only buyback uses it). If the mount refuses deletes, report the paths — Fable deletes them.

**Mocks:** `script/support/MockPlatformToken.sol` — OZ ERC20 + ERC20Burnable, fixed supply
`1_000_000_000e18` minted to a constructor-given holder, no mint/owner. Name "Vivarium Test
Platform Token", symbol "tVIV" `DEFAULT`. Tests may import it.

**Tests** (all existing suites updated for the rename; baseline 299 non-fork green):
- `test/FloorVault.t.sol` unit: ctor guards (zeros, decimals ≠ 18); redeem happy path (exact
  payout, burn, supply drop, events, cumulative views); zero amount; zero payout (dust vs tiny
  vault); redeem with empty vault ⇒ ZeroPayout; no approval ⇒ revert; redeem entire supply ⇒ vault
  drains to exactly 0 and `floorPrice()==0`; donation raises `floorPrice` and payout; `burnStray`
  (raises floor, ZeroAmount when none, doesn't count in totalBurned); floor-price scaling golden
  (e.g. B=1e6, S=1e27 ⇒ floorPrice = 1e15); hostile tokens via test mocks: fee-on-transfer ⇒
  InexactTransfer; no-op burn ⇒ BurnFailed; dead-address burn ⇒ BurnFailed; reentrant token
  (transferFrom re-enters redeem) ⇒ reverts via guard; `redeem` gas recorded (log it).
- `test/FloorVault.invariant.t.sol` (forge invariant, handler with ≥3 actors; runs/depth DEFAULT
  foundry.toml values or `[invariant] runs=256 depth=64`): actions = redeem(random ≤ balance),
  donate USDG, fee-leg inflow, transfer $TOKEN between actors, direct `burn` by a holder, stray
  send + `burnStray`. Invariants: **(I1)** floor never decreases across any call — compare by cross
  multiplication `B1·S0 ≥ B0·S1` (S>0), never via rounded floorPrice; **(I2)** for a fixed probe
  amount, `quoteRedeem(probe)` never decreases; **(I3)** USDG conservation: `vaultBalance +
  totalRedeemedUsdg == Σ inflows` (ghost); **(I4)** `S == initialSupply − totalBurned − Σstray −
  Σdirect burns` (ghost); **(I5)** USDG only ever leaves the vault to the caller of `redeem`.
- 02 §8 suite updates: fee-leg invariants now assert the platform leg lands in the vault (curve +
  pool phases); `Adversarial.t.sol`: replace the poke scenarios with hostile `redeem`/`burnStray`
  orderings interleaved with `distribute`/`registerInstance`/`finalize`/`cancel` (attacker cannot
  lower the floor or extract more than pro-rata); `Lifecycle.t.sol`: end-to-end — curve buys +
  graduation + pool swaps + `distribute` ⇒ vault USDG == Σ platform legs ⇒ a holder redeems ⇒
  floor ≥ before. Factory: `firstAgentId` (first id == firstAgentId, `InvalidFirstAgentId` at 0,
  counter continues). Fork tests updated for the rename (they may skip if RPC is down).

**Scripts:**
- `Deploy.s.sol`: env `USDG` (optional — reuse that address; must have code and `decimals()==6`,
  else deploy MockUSDG as today), env `FIRST_AGENT_ID` (optional, DEFAULT 1). Deploys
  `MockPlatformToken(deployer)` + `FloorVault(usdg, token)` in `_deployBase` instead of the buyback;
  hook/factory get the vault; wiring asserts updated (`hook.floorVault`, `factory.floorVault`,
  `factory.firstAgentId`, `factory.agentCount == firstAgentId−1`, vault.usdg/token, token supply ==
  1e27 held by deployer). Manifest keys: drop `treasuryBuyback`; add `floorVault`,
  `platformToken`, `firstAgentId` (uint), `stackVersion` (uint, 2). When reusing USDG,
  `usdg.minter()` assert still holds (deployer is the v1 minter) — keep it.
- `LaunchpadScript.sol` Deployment struct/readDeployment + `Lifecycle.s.sol`: `floorVault`.
- `runtime/test/integration/foundry.ts` (anvil harness that runs Deploy+Lifecycle): manifest type
  `treasuryBuyback` → `floorVault` (+ new keys). Run `npm --prefix runtime run test:integration`
  if the sandbox allows (TMPDIR=/tmp/s16, npm_config_cache=/tmp/s16/npm-cache); else report.
- `forge fmt` clean; `forge build --sizes` — AgentFactory must stay < 24,576 B (report size).

## 2. Deploy (Fable, live)

Before broadcast: `git mv`-equivalent copy `deployments/testnet-46630.json` →
`deployments/testnet-46630.v1.json` (content unchanged + `"stackVersion": 1`, `"firstAgentId": 1`,
`"legacy": true`). Broadcast `Deploy.s.sol` with `USDG=<v1 MockUSDG>` `FIRST_AGENT_ID=101` → new
`testnet-46630.json` (v2). Blockscout-verify if the verifier is reachable (not gating). Post-deploy
live checks: wiring asserts pass in-script; `floorPrice()==0`; a 1-USDG donation + a small redeem
by the deployer prove `Redeemed` + floor rise live.

## 3. indexer/ (Opus)

- **Config:** `legacyManifests?: string[]` (paths, relative to the config file). Primary
  `deploymentManifest` = v2. Manifest schema: `treasuryBuyback` optional (v1 only); `floorVault`,
  `platformToken`, `firstAgentId`, `stackVersion`, `legacy` optional. Resolved config: `stacks:
  StackCfg[]` = `[{version, legacy, factory, registry, hook, distributor, nft, startBlock,
  firstAgentId}]` (primary first) + shared `usdg`, `poolManager` (assert equal across stacks) +
  `floor: {vault, token} | null` (from the primary). The explicit `contracts` block, if present,
  still cross-checks the primary. `indexer/e2e/testnet.json`: primary = `testnet-46630.json`,
  `legacyManifests: ["../../contracts/deployments/testnet-46630.v1.json"]`.
- **Watcher:** roles from every stack (factory/registry/hook/distributor/nft) + `vault` (the floor
  vault: `Redeemed`, `StrayBurned`); scan start = min(startBlock); a new stack's contracts must be
  picked up by an EXISTING db whose cursor is past the new stack's startBlock only if the stack
  deployed later — it is (v2 deploys after the cursor), so no rescan is needed; still: if a
  configured stack's startBlock < cursor and its factory has never been seen, log a LOUD warning
  (no auto-rescan). Buyback role removed (no `Poked` handling; keep the ABI entry out).
  `AgentLive` curve discovery works per factory. Fee `Distributed` ABI uses `floorLeg`.
- **Vault inflows:** new chain method `getTransferLogsTo(token, to, from, toBlock)` (USDG `Transfer`
  topic0 + topic2 = vault) per ingested range; classify `from`: any stack's hook ⇒ `fee_pool`
  (agentId from the matching `Distributed` in the same tx when resolvable, else null); a known v2
  curve ⇒ `fee_curve` (agentId from curveMap); anything else ⇒ `donation`. Table `floor_flows`
  (txHash, logIndex PK; kind in {fee_pool, fee_curve, donation, redeem, stray_burn}; account;
  usdg; tokens; agentId; ts; blockNumber) — idempotent upserts, reorg-window re-scan like the rest.
  Schema migration appended (never edit old migrations).
- **Floor refresher** (balance loop cadence): `usdg.balanceOf(vault)`, `token.totalSupply()`,
  token `name/symbol/decimals` (once) → kv.
- **API:** `GET /api/floor` → `{enabled, vault, token:{address,name,symbol,decimals,totalSupply},
  usdg, vaultUsdg, floorPriceX18 (= B·1e36/S as a decimal string; "0" when S=0), totals:
  {feePool, feeCurve, donations, redeemedUsdg, burnedTokens, strayBurned, redemptions},
  recent: [≤50 floor_flows desc], updatedAt}`; `{enabled:false}` when no vault configured.
  `/api/contracts` += `stacks` (array as above) — floorVault/platformToken already flow through
  the manifest copy. Every agent payload (list + detail) gains `stack: {version, legacy, factory,
  registry, hook, distributor, nft}`. Fee totals field `buybackLeg` → `platformLeg` (API + derive;
  db column may keep its name).
- **Tests:** multi-stack config (parse, shared-address asserts, primary cross-check); watcher over
  two stacks (disjoint agents from both factories land; curve discovery per factory); inflow
  classification (hook/curve/donation) + Redeemed/StrayBurned; reorg idempotency for floor_flows;
  `/api/floor` golden (math incl. S=0); agent `stack` field; migration on a v5 db. Baseline 115.

## 4. web/ (Opus)

- **`/token` page** (header nav "$TOKEN"): hero = floor price per token (USDG, from
  `floorPriceX18`, adequate precision — tiny numbers must not render as 0), vault USDG, supply,
  lifetime inflows (pool fees / curve fees / donations), redeemed USDG, burned tokens; D18
  explainer in plain language (floor only rises; redeeming at the floor leaves it unchanged; no
  owner, no withdrawal, no market interaction; donations are plain USDG transfers; D19: $TOKEN's
  own trading fees are team revenue and do not enter the vault — say so); recent activity list;
  testnet honesty note ("mock $TOKEN on testnet; the real token launches on PONS at M6").
- **Redeem UI:** wagmi on RH testnet (existing config). Addresses ONLY from `/api/contracts`
  (`floorVault`, `platformToken`, `usdg`). Shows wallet $TOKEN balance, amount input + Max, live
  quote via `vault.quoteRedeem(amount)` read, "your payout can only grow before inclusion" note
  (R3), approve (only if allowance < amount) → `redeem(amount)` → receipt → show paid USDG from
  the `Redeemed` log. States: disconnected, wrong chain, zero balance, ZeroPayout (dust) disabled
  with reason, pending, success, error. `{enabled:false}` ⇒ page explains the floor launches with
  the v2 stack.
- **Dual-stack:** per-agent contract addresses from the agent's `stack` (nfts claim/burn, any
  per-agent contract read); launch flow uses the primary (v2) factory from `/api/contracts`.
  Legacy badge on directory card + profile for `stack.legacy` ("legacy stack — its platform leg
  went to the retired buyback"). Fee breakdown label: "Floor vault" (v2) / "Platform leg (legacy
  buyback)" (v1), field `platformLeg`.
- **Fixtures:** floor fresh (all zero), floor active (donation + fee flows + redemptions), disabled;
  redeem flow walkable walletless (simulated); a legacy + a v2 agent in the directory.
- **Tests:** `npm run build` + tsc green.

## 5. Acceptance (Fable review gate)

1. contracts: all non-fork suites green (baseline 299 ± rename churn), FloorVault unit + invariant
   green, factory size < 24,576 B, fmt clean; runtime integration harness green or reported.
2. v2 stack live on RH testnet: wiring asserted, manifest v2 + v1 archive committed, live
   donation + redeem proven (tx hashes in BUILD-STATE).
3. indexer suite green (baseline 115 + new); live: both stacks ingested (agents 1–11 unchanged),
   `/api/floor` shows the live donation + redemption.
4. web build + tsc green; `/token` renders live data.
5. genesis suite green (183) with the per-stack configs; v1 revival quote for agent 2 still
   returns `heartbeat_fresh` / evictableAt 2026-10-01 against the v1 config.

## 6. Out of scope

Multi-stack single orchestrator (R8 debt); donate button; $TOKEN chart/market price; PONS
integration (M6); Blockscout verification failures (non-gating).
