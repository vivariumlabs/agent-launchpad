// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {AgentFactory} from "../src/AgentFactory.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {AgentToken} from "../src/AgentToken.sol";
import {AgentBondingCurve} from "../src/AgentBondingCurve.sol";
import {RoyaltyDistributor} from "../src/RoyaltyDistributor.sol";
import {FeeSplitHook} from "../src/FeeSplitHook.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";

import {LaunchpadScript} from "./support/LaunchpadScript.sol";
import {MockUSDG} from "./support/MockUSDG.sol";

/// @notice The M1 agent lifecycle, run against the live Robinhood Chain testnet stack that
///         `Deploy.s.sol` put on chain, in three broadcast phases.
///
/// @dev Phase split, and why:
///
///      * `phase1` — curve phase: create, register (from the pinned treasury EOA), finalize,
///        buys, the creator's royalty claim, a sell, then the buy that closes the curve.
///      * `phase2` — pool phase: graduate, seed + lock the pool, swap both ways, hand the NFT
///        to a second EOA, that owner's claim, the **first** `distribute`, the burn (which
///        sweeps the freshly credited royalties to the agent's treasury), and one more swap
///        to leave fees pending.
///      * `phase3` — the second `distribute`, which proves the royalty leg now routes straight
///        to the treasury EOA, plus a registry heartbeat. It must run at least
///        `FeeSplitHook.DISTRIBUTE_COOLDOWN` (1 h) after phase 2's distribute: there is no
///        `vm.warp` on a live chain, so the gap is wall-clock.
///
///      **Revival is not exercised.** `AgentRegistry.registerInstance`'s re-registration path
///      needs `REVIVAL_WINDOW` (7 days) of heartbeat silence. That cannot be produced on a live
///      chain inside a drill; it is covered by `test/AgentRegistry.t.sol` and the adversarial
///      suite instead.
///
///      Ordering note: the creator's claim is funded by the curve's royalty leg and the second
///      owner's claim by the rest of it, so that the burn in phase 2 has the hook-credited
///      royalties still unclaimed and sweeps a non-zero amount. Chaining both claims off pool
///      distributions instead would have cost two extra one-hour cooldown waits for no extra
///      coverage.
///
/// Usage (per phase):
///   FOUNDRY_OUT=out-g FOUNDRY_CACHE_PATH=cache-g \
///   forge script script/Lifecycle.s.sol:Lifecycle --sig "phase1()" --rpc-url rh_testnet \
///     --broadcast --slow
contract Lifecycle is LaunchpadScript {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant MINT_AMOUNT = 250_000e6;
    uint256 internal constant EOA_GAS_FUNDING = 0.0002 ether;
    uint256 internal constant GENESIS_GAS_VALUE = 0.00002 ether;

    uint256 internal constant BUY_1 = 15_000e6;
    uint256 internal constant BUY_2 = 15_000e6;
    uint256 internal constant POOL_SWAP_USDG = 2_000e6;
    uint256 internal constant POOL_SWAP_AGENT = 2_000_000e18;

    uint256 internal constant ACTION_KEY = uint256(keccak256("agent-launchpad/m1-drill/action-eoa/v1"));

    bytes32 internal constant CODE_HASH = keccak256("agent-launchpad/m1-drill/enclave-image/v1");
    string internal constant IMAGE_URI = "ar://m1-drill-agent-metadata";
    string internal constant ATTESTATION = "ar://m1-drill-attestation";

    Deployment internal dep;
    uint256 internal agentId;

    // -----------------------------------------------------------------------
    // phases
    // -----------------------------------------------------------------------

    function phase1() external {
        _load();
        console2.log("=== PHASE 1 - curve ===");
        _fundActors();
        _createRegisterFinalize();
        _curvePhase();
        _report();
    }

    function phase2() external {
        _load();
        agentId = _currentAgentId();
        console2.log("=== PHASE 2 - graduation, pool, royalty tail ===");
        _graduateAndSeed();
        _poolSwaps();
        _royaltyTail();
        _report();
    }

    function phase3() external {
        _load();
        agentId = _currentAgentId();
        console2.log("=== PHASE 3 - post-burn distribute + heartbeat ===");
        _postBurnDistribute();
        _heartbeat();
        _report();
    }

    /// @notice Rehearsal only: every phase in one simulated run, with the cooldown warped.
    ///         Never use with `--broadcast` — `vm.warp` does not exist on a live chain.
    function rehearse() external {
        _load();
        _fundActors();
        _createRegisterFinalize();
        _curvePhase();
        _graduateAndSeed();
        _poolSwaps();
        _royaltyTail();
        vm.warp(block.timestamp + FeeSplitHook(dep.hook).DISTRIBUTE_COOLDOWN() + 1);
        _postBurnDistribute();
        _heartbeat();
        _report();
    }

    // -----------------------------------------------------------------------
    // stages
    // -----------------------------------------------------------------------

    function _load() internal {
        requireTestnet();
        dep = readDeployment();
        require(dep.factory.code.length > 0, "no factory at the manifest address");
    }

    function _currentAgentId() internal view returns (uint256 id) {
        id = vm.envOr("AGENT_ID", uint256(0));
        if (id == 0) id = AgentFactory(dep.factory).agentCount();
        require(id != 0, "no agent created yet - run phase1 first");
    }

    /// @dev Dust ETH so the two scripted EOAs can pay for their own transactions, and the USDG
    ///      the drill trades with. Both guarded, so a re-run after a partial phase is a no-op.
    function _fundActors() internal {
        uint256 pk = deployerKey();
        address me = vm.addr(pk);
        MockUSDG usdg = MockUSDG(dep.usdg);

        vm.startBroadcast(pk);
        if (dep.treasuryEOA.balance < EOA_GAS_FUNDING / 2) {
            payable(dep.treasuryEOA).transfer(EOA_GAS_FUNDING);
        }
        if (dep.secondOwnerEOA.balance < EOA_GAS_FUNDING / 2) {
            payable(dep.secondOwnerEOA).transfer(EOA_GAS_FUNDING);
        }
        if (usdg.balanceOf(me) < MINT_AMOUNT / 2) {
            usdg.mint(me, MINT_AMOUNT);
        }
        if (usdg.allowance(me, dep.factory) < CREATION_FEE) {
            usdg.approve(dep.factory, type(uint256).max);
        }
        vm.stopBroadcast();

        console2.log("-- 0. actors funded --");
        console2.log("  creator/deployer :", me);
        console2.log("  treasury EOA     :", dep.treasuryEOA);
        console2.log("  second owner EOA :", dep.secondOwnerEOA);
        console2.log("  creator USDG     :", usdgStr(usdg.balanceOf(me)));
    }

    function _createRegisterFinalize() internal {
        uint256 pk = deployerKey();
        address me = vm.addr(pk);
        AgentFactory f = AgentFactory(dep.factory);
        AgentRegistry registry = AgentRegistry(dep.registry);

        agentId = vm.envOr("AGENT_ID", uint256(0));
        if (agentId == 0) {
            vm.startBroadcast(pk);
            agentId = f.createAgent{value: GENESIS_GAS_VALUE}(
                "Drill Agent One", "DRILL1", IMAGE_URI, keccak256("m1-drill-config"), me, dep.treasuryEOA
            );
            vm.stopBroadcast();
        }

        if (!registry.isRegistered(agentId)) {
            vm.startBroadcast(TREASURY_KEY);
            registry.registerInstance(agentId, dep.treasuryEOA, vm.addr(ACTION_KEY), CODE_HASH, ATTESTATION);
            vm.stopBroadcast();
        }

        if (f.tokenOf(agentId) == address(0)) {
            vm.startBroadcast(pk);
            f.finalize(agentId);
            vm.stopBroadcast();
        }

        console2.log("-- 1. create / register / finalize --");
        console2.log("  agentId          :", agentId);
        console2.log("  AGENT token      :", f.tokenOf(agentId));
        console2.log("  bonding curve    :", f.curveOf(agentId));
        console2.log("  NFT owner        :", AgentNFT(dep.nft).ownerOf(agentId));
        console2.log("  generation       :", registry.instanceOf(agentId).generation);
        console2.log("  creation fee     :", usdgStr(CREATION_FEE), "-> platformFeeRecipient");
    }

    function _curvePhase() internal {
        uint256 pk = deployerKey();
        address me = vm.addr(pk);
        AgentFactory f = AgentFactory(dep.factory);
        AgentBondingCurve curve = AgentBondingCurve(f.curveOf(agentId));
        AgentToken token = AgentToken(f.tokenOf(agentId));
        MockUSDG usdg = MockUSDG(dep.usdg);
        RoyaltyDistributor dist = RoyaltyDistributor(dep.distributor);

        if (curve.readyToGraduate()) {
            console2.log("-- 2. curve phase already closed, skipping --");
            return;
        }

        vm.startBroadcast(pk);
        if (usdg.allowance(me, address(curve)) < BUY_1 + BUY_2) {
            usdg.approve(address(curve), type(uint256).max);
        }
        curve.buy(BUY_1, 0, me);
        curve.buy(BUY_2, 0, me);
        vm.stopBroadcast();

        (uint256 reserve1,) = curve.reserves();
        uint256 accrued1 = dist.accrued(agentId);
        console2.log("-- 2. curve buys --");
        console2.log("  bought (2 txs)   :", usdgStr(BUY_1 + BUY_2));
        console2.log("  real reserve     :", usdgStr(reserve1));
        console2.log("  AGENT held/1e18  :", token.balanceOf(me) / 1e18);
        console2.log("  buyback leg      :", usdgStr(usdg.balanceOf(dep.treasuryBuyback)));
        console2.log("  treasury leg     :", usdgStr(usdg.balanceOf(dep.treasuryEOA) - 0));
        console2.log("  royalty accrued  :", usdgStr(accrued1));

        // 3. the creator claims the curve's royalty leg
        uint256 before = usdg.balanceOf(me);
        vm.broadcast(pk);
        dist.claim(agentId);
        console2.log("-- 3. royalty claim (creator owns the NFT) --");
        console2.log("  paid to creator  :", usdgStr(usdg.balanceOf(me) - before));

        _curveSellAndClose(pk, me, curve, token, usdg);
    }

    function _curveSellAndClose(uint256 pk, address me, AgentBondingCurve curve, AgentToken token, MockUSDG usdg)
        internal
    {
        uint256 sellAmount = token.balanceOf(me) / 20;
        uint256 usdgBefore = usdg.balanceOf(me);

        vm.startBroadcast(pk);
        if (token.allowance(me, address(curve)) < sellAmount) {
            token.approve(address(curve), type(uint256).max);
        }
        curve.sell(sellAmount, 0, me);
        vm.stopBroadcast();

        (uint256 reserveAfterSell,) = curve.reserves();
        console2.log("-- 4. curve sell (still below threshold) --");
        console2.log("  sold AGENT/1e18  :", sellAmount / 1e18);
        console2.log("  received         :", usdgStr(usdg.balanceOf(me) - usdgBefore));
        console2.log("  real reserve     :", usdgStr(reserveAfterSell));

        // 5. the buy that takes the curve over GRADUATION_THRESHOLD and closes it
        uint256 need = GRADUATION_THRESHOLD - reserveAfterSell;
        uint256 finalBuy = (need * 10_000) / 9_700 + 1_000e6;
        vm.broadcast(pk);
        curve.buy(finalBuy, 0, me);

        (uint256 finalReserve,) = curve.reserves();
        require(curve.readyToGraduate(), "curve did not reach the threshold");
        console2.log("-- 5. closing buy --");
        console2.log("  spent            :", usdgStr(finalBuy));
        console2.log("  real reserve     :", usdgStr(finalReserve));
        console2.log("  readyToGraduate  : true");
    }

    function _graduateAndSeed() internal {
        uint256 pk = deployerKey();
        AgentFactory f = AgentFactory(dep.factory);
        AgentToken token = AgentToken(f.tokenOf(agentId));
        PoolKey memory key = poolKeyOf(address(token), dep.usdg, dep.hook);
        (uint160 sqrtPrice,,,) = IPoolManager(POOL_MANAGER).getSlot0(key.toId());

        if (sqrtPrice == 0) {
            uint256 supplyBefore = token.totalSupply();
            (uint256 swept,) = f.sweptOf(agentId);
            if (swept == 0) {
                vm.broadcast(pk);
                f.graduate(agentId);
            }
            (uint256 sweptUsdg, uint256 poolTokens) = f.sweptOf(agentId);
            console2.log("-- 6. graduate (sweep + burn) --");
            console2.log("  swept USDG       :", usdgStr(sweptUsdg));
            console2.log("  pool AGENT/1e18  :", poolTokens / 1e18);
            console2.log("  burned AGENT/1e18:", (supplyBefore - token.totalSupply()) / 1e18);

            vm.broadcast(pk);
            f.createGraduatedPool(agentId);
            (sqrtPrice,,,) = IPoolManager(POOL_MANAGER).getSlot0(key.toId());
        }

        require(sqrtPrice != 0, "pool not initialized");
        (uint256 s0, uint256 s1) = f.sweptOf(agentId);
        require(s0 == 0 && s1 == 0, "swept state not cleared");

        console2.log("-- 7. graduated pool seeded + locked --");
        console2.log("  poolId           :", vm.toString(PoolId.unwrap(key.toId())));
        console2.log("  sqrtPriceX96     :", sqrtPrice);
        console2.log("  locked liquidity :", LiquidityLocker(dep.locker).lockedLiquidity(agentId));
        console2.log("  AGENT supply/1e18:", token.totalSupply() / 1e18);
    }

    function _poolSwaps() internal {
        uint256 pk = deployerKey();
        address me = vm.addr(pk);
        AgentFactory f = AgentFactory(dep.factory);
        AgentToken token = AgentToken(f.tokenOf(agentId));
        PoolKey memory key = poolKeyOf(address(token), dep.usdg, dep.hook);
        bool agentIsCurrency0 = address(token) < dep.usdg;

        vm.startBroadcast(pk);
        if (MockUSDG(dep.usdg).allowance(me, dep.swapRouter) < POOL_SWAP_USDG) {
            MockUSDG(dep.usdg).approve(dep.swapRouter, type(uint256).max);
        }
        if (token.allowance(me, dep.swapRouter) < POOL_SWAP_AGENT) {
            token.approve(dep.swapRouter, type(uint256).max);
        }
        vm.stopBroadcast();

        _swap(pk, key, !agentIsCurrency0, -int256(POOL_SWAP_USDG)); // USDG in  -> AGENT-side fee
        _swap(pk, key, agentIsCurrency0, -int256(POOL_SWAP_AGENT)); // AGENT in -> USDG-side fee

        bytes32 poolId = PoolId.unwrap(key.toId());
        FeeSplitHook hook = FeeSplitHook(dep.hook);
        console2.log("-- 8. pool swaps, both directions --");
        console2.log("  USDG in          :", usdgStr(POOL_SWAP_USDG));
        console2.log("  AGENT in /1e18   :", POOL_SWAP_AGENT / 1e18);
        console2.log("  pending USDG fees:", usdgStr(hook.pendingFees(poolId, dep.usdg)));
        console2.log("  pending AGENT/1e18:", hook.pendingFees(poolId, address(token)) / 1e18);
    }

    function _swap(uint256 pk, PoolKey memory key, bool zeroForOne, int256 amountSpecified) internal {
        vm.broadcast(pk);
        PoolSwapTest(dep.swapRouter)
            .swap(
                key,
                IPoolManager.SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: amountSpecified,
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
    }

    /// @dev NFT transfer -> the new owner's claim -> first distribute -> burn. The burn lands
    ///      after the distribute on purpose, so the emancipation sweep carries the freshly
    ///      credited royalties to the treasury instead of sweeping zero.
    function _royaltyTail() internal {
        uint256 pk = deployerKey();
        address me = vm.addr(pk);
        AgentNFT nft = AgentNFT(dep.nft);
        RoyaltyDistributor dist = RoyaltyDistributor(dep.distributor);
        MockUSDG usdg = MockUSDG(dep.usdg);

        if (nft.ownerOf(agentId) == me) {
            vm.broadcast(pk);
            nft.transferFrom(me, dep.secondOwnerEOA, agentId);
        }
        require(nft.ownerOf(agentId) == dep.secondOwnerEOA, "NFT transfer failed");

        uint256 pending = dist.accrued(agentId);
        if (pending > 0) {
            uint256 before = usdg.balanceOf(dep.secondOwnerEOA);
            vm.broadcast(pk);
            dist.claim(agentId);
            console2.log("-- 9. NFT transferred; claim follows the owner --");
            console2.log("  new owner        :", dep.secondOwnerEOA);
            console2.log("  paid to new owner:", usdgStr(usdg.balanceOf(dep.secondOwnerEOA) - before));
        }

        _firstDistributeAndBurn(pk);
    }

    function _firstDistributeAndBurn(uint256 pk) internal {
        AgentFactory f = AgentFactory(dep.factory);
        AgentToken token = AgentToken(f.tokenOf(agentId));
        PoolKey memory key = poolKeyOf(address(token), dep.usdg, dep.hook);
        bytes32 poolId = PoolId.unwrap(key.toId());
        FeeSplitHook hook = FeeSplitHook(dep.hook);
        RoyaltyDistributor dist = RoyaltyDistributor(dep.distributor);
        MockUSDG usdg = MockUSDG(dep.usdg);

        if (hook.lastDistribute(poolId) == 0) {
            uint256 buybackBefore = usdg.balanceOf(dep.treasuryBuyback);
            uint256 treasuryBefore = usdg.balanceOf(dep.treasuryEOA);
            vm.broadcast(pk);
            hook.distribute(poolId, 0);
            uint256 leg = usdg.balanceOf(dep.treasuryBuyback) - buybackBefore;
            console2.log("-- 10. distribute #1 (AGENT converted, split in thirds) --");
            console2.log("  leg, each of 3   :", usdgStr(leg));
            console2.log("  treasury received:", usdgStr(usdg.balanceOf(dep.treasuryEOA) - treasuryBefore));
            console2.log("  royalty accrued  :", usdgStr(dist.accrued(agentId)));
            console2.log("  AGENT left /1e18 :", hook.pendingFees(poolId, address(token)) / 1e18);
        }

        if (!dist.emancipated(agentId)) {
            uint256 unclaimed = dist.accrued(agentId);
            uint256 treasuryBefore = usdg.balanceOf(dep.treasuryEOA);
            vm.broadcast(SECOND_OWNER_KEY);
            AgentNFT(dep.nft).burn(agentId);
            require(dist.emancipated(agentId), "burn did not emancipate");
            console2.log("-- 11. burn -> emancipated (one-way) --");
            console2.log("  swept to treasury:", usdgStr(usdg.balanceOf(dep.treasuryEOA) - treasuryBefore));
            console2.log("  (was unclaimed)  :", usdgStr(unclaimed));
        }

        // Leave fees pending for phase 3's distribute.
        bool agentIsCurrency0 = address(token) < dep.usdg;
        _swap(pk, key, !agentIsCurrency0, -int256(POOL_SWAP_USDG));
        _swap(pk, key, agentIsCurrency0, -int256(POOL_SWAP_AGENT));
        console2.log("-- 12. two more swaps, fees left pending for phase 3 --");
        console2.log("  pending USDG fees:", usdgStr(hook.pendingFees(poolId, dep.usdg)));
        console2.log("  pending AGENT/1e18:", hook.pendingFees(poolId, address(token)) / 1e18);
    }

    function _postBurnDistribute() internal {
        uint256 pk = deployerKey();
        AgentFactory f = AgentFactory(dep.factory);
        AgentToken token = AgentToken(f.tokenOf(agentId));
        PoolKey memory key = poolKeyOf(address(token), dep.usdg, dep.hook);
        bytes32 poolId = PoolId.unwrap(key.toId());
        FeeSplitHook hook = FeeSplitHook(dep.hook);
        RoyaltyDistributor dist = RoyaltyDistributor(dep.distributor);
        MockUSDG usdg = MockUSDG(dep.usdg);

        require(dist.emancipated(agentId), "phase 2 must have burned the NFT first");
        uint256 elapsed = block.timestamp - hook.lastDistribute(poolId);
        require(elapsed >= hook.DISTRIBUTE_COOLDOWN(), "distribute cooldown has not elapsed yet");

        uint256 buybackBefore = usdg.balanceOf(dep.treasuryBuyback);
        uint256 treasuryBefore = usdg.balanceOf(dep.treasuryEOA);

        vm.broadcast(pk);
        hook.distribute(poolId, 0);

        uint256 leg = usdg.balanceOf(dep.treasuryBuyback) - buybackBefore;
        uint256 toTreasury = usdg.balanceOf(dep.treasuryEOA) - treasuryBefore;
        require(toTreasury == leg * 2, "royalty leg was not re-routed to the treasury");
        require(dist.accrued(agentId) == 0, "royalties still accruing after the burn");

        console2.log("-- 13. distribute #2, post-burn (royalty leg re-routed) --");
        console2.log("  seconds since #1 :", elapsed);
        console2.log("  leg, each of 3   :", usdgStr(leg));
        console2.log("  treasury received:", usdgStr(toTreasury), "(treasury leg + royalty leg)");
        console2.log("  distributor accr.:", usdgStr(dist.accrued(agentId)));
    }

    function _heartbeat() internal {
        AgentRegistry registry = AgentRegistry(dep.registry);
        vm.broadcast(TREASURY_KEY);
        registry.heartbeat(agentId);
        console2.log("-- 14. registry heartbeat from the treasury EOA --");
        console2.log("  lastHeartbeat    :", registry.instanceOf(agentId).lastHeartbeat);
        console2.log("  generation       :", registry.instanceOf(agentId).generation);
        console2.log("  NOTE             : revival needs a 7-day lapse - not runnable live");
    }

    function _report() internal view {
        MockUSDG usdg = MockUSDG(dep.usdg);
        console2.log("-- ledger --");
        console2.log("  buyback USDG     :", usdgStr(usdg.balanceOf(dep.treasuryBuyback)));
        console2.log("  treasury EOA USDG:", usdgStr(usdg.balanceOf(dep.treasuryEOA)));
        console2.log("  2nd owner USDG   :", usdgStr(usdg.balanceOf(dep.secondOwnerEOA)));
        console2.log("  platform fee USDG:", usdgStr(usdg.balanceOf(AgentFactory(dep.factory).platformFeeRecipient())));
        console2.log("  deployer ETH     :", vm.addr(deployerKey()).balance);
    }
}
