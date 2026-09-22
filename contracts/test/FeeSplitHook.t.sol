// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

import {FeeSplitHook} from "../src/FeeSplitHook.sol";
import {IFeeSplitHook} from "../src/interfaces/ILaunchpad.sol";
import {
    HookMockERC20,
    HookMockRegistry,
    HookMockDistributor,
    HookReentrantDistributor,
    HookReentrantRegistry
} from "./mocks/HookMocks.sol";

/// @notice Local-PoolManager unit tests for FeeSplitHook.
/// @dev The pool mirrors a graduated agent: 1e9 AGENT (18d) against 2,000,000 USDG (6d),
///      full range, fee 0, tickSpacing 60. At that depth MAX_CONVERSION_PER_CALL is the
///      binding constraint on the conversion leg rather than MAX_IMPACT_BPS.
contract FeeSplitHookTest is Test {
    using PoolIdLibrary for PoolKey;
    using stdStorage for StdStorage;
    using StateLibrary for IPoolManager;

    uint160 constant HOOK_FLAGS =
        uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    uint256 constant AGENT_ID = 7;
    uint256 constant AGENT_RESERVE = 1_000_000_000e18; // 1e9 tokens
    uint256 constant USDG_RESERVE = 2_000_000e6; // $2m
    int24 constant TICK_SPACING = 60;

    PoolManager manager;
    PoolSwapTest swapRouter;
    PoolModifyLiquidityTest lpRouter;

    HookMockERC20 usdg;
    HookMockERC20 agent;
    HookMockRegistry registry;
    HookMockDistributor distributor;
    address constant TREASURY_BUYBACK = address(0xBB1);
    address constant AGENT_TREASURY = address(0x7EA);

    FeeSplitHook hook;
    PoolKey key;
    bytes32 poolId;
    bool agentIsCurrency0;
    uint128 seededLiquidity;

    uint160 hookNonce = 0x1000;

    function setUp() public {
        _deploy(true);
    }

    // -----------------------------------------------------------------------
    // Harness
    // -----------------------------------------------------------------------

    /// @param agentBelowUsdg whether the AGENT token should sort as currency0
    function _deploy(bool agentBelowUsdg) internal {
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);

        usdg = new HookMockERC20("Global Dollar", "USDG", 6);
        agent = _deployTokenSorted(address(usdg), agentBelowUsdg);
        agentIsCurrency0 = address(agent) < address(usdg);
        assertEq(agentIsCurrency0, agentBelowUsdg, "token ordering");

        registry = new HookMockRegistry();
        registry.setTreasury(AGENT_ID, AGENT_TREASURY);
        distributor = new HookMockDistributor(address(usdg));

        hook = _deployHook();
        hook.setFactory(address(this));

        key = _keyFor(address(agent), IHooks(address(hook)));
        poolId = PoolId.unwrap(key.toId());

        uint160 sqrtPriceX96 = _sqrtPriceX96For(AGENT_RESERVE, USDG_RESERVE, agentIsCurrency0);
        manager.initialize(key, sqrtPriceX96);
        hook.registerPool(key, AGENT_ID, address(agent));

        agent.mint(address(this), AGENT_RESERVE * 4);
        usdg.mint(address(this), USDG_RESERVE * 4);
        _approveAll(agent);
        _approveAll(usdg);

        seededLiquidity = _addFullRangeLiquidity(key, sqrtPriceX96, agentIsCurrency0, AGENT_RESERVE, USDG_RESERVE);
    }

    function _keyFor(address token, IHooks hooks) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = token < address(usdg)
            ? (Currency.wrap(token), Currency.wrap(address(usdg)))
            : (Currency.wrap(address(usdg)), Currency.wrap(token));
        return PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: TICK_SPACING, hooks: hooks});
    }

    function _approveAll(HookMockERC20 t) internal {
        t.approve(address(swapRouter), type(uint256).max);
        t.approve(address(lpRouter), type(uint256).max);
    }

    /// @dev Each call lands the hook at a fresh mined address so redeploying inside a single
    ///      test never inherits the previous hook's storage.
    function _deployHook() internal returns (FeeSplitHook) {
        address addr = address(HOOK_FLAGS | (hookNonce++ << 20));
        deployCodeTo(
            "FeeSplitHook.sol:FeeSplitHook",
            abi.encode(manager, address(usdg), address(registry), address(distributor), TREASURY_BUYBACK),
            addr
        );
        return FeeSplitHook(addr);
    }

    /// @dev CREATE2 salt search, so both currency orderings can be exercised.
    function _deployTokenSorted(address other, bool wantBelow) internal returns (HookMockERC20) {
        bytes memory args = abi.encode("Agent", "AGT", uint8(18));
        bytes32 initHash = keccak256(abi.encodePacked(type(HookMockERC20).creationCode, args));
        for (uint256 i = 1; i < 4096; i++) {
            bytes32 salt = bytes32(i);
            address predicted = vm.computeCreate2Address(salt, initHash, address(this));
            if (predicted.code.length == 0 && (predicted < other) == wantBelow) {
                return new HookMockERC20{salt: salt}("Agent", "AGT", 18);
            }
        }
        revert("no salt found");
    }

    function _sqrtPriceX96For(uint256 agentAmount, uint256 usdgAmount, bool agentIs0) internal pure returns (uint160) {
        (uint256 amount0, uint256 amount1) = agentIs0 ? (agentAmount, usdgAmount) : (usdgAmount, agentAmount);
        uint256 ratioX192 = FullMath.mulDiv(amount1, 1 << 192, amount0);
        return uint160(FixedPointMathLib.sqrt(ratioX192));
    }

    function _addFullRangeLiquidity(
        PoolKey memory k,
        uint160 sqrtPriceX96,
        bool agentIs0,
        uint256 agentAmount,
        uint256 usdgAmount
    ) internal returns (uint128 liquidity) {
        int24 lower = TickMath.minUsableTick(TICK_SPACING);
        int24 upper = TickMath.maxUsableTick(TICK_SPACING);
        (uint256 amount0, uint256 amount1) = agentIs0 ? (agentAmount, usdgAmount) : (usdgAmount, agentAmount);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0, amount1
        );
        lpRouter.modifyLiquidity(
            k,
            IPoolManager.ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: 0
            }),
            ""
        );
    }

    function _removeLiquidity(uint128 liquidity) internal {
        lpRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(TICK_SPACING),
                tickUpper: TickMath.maxUsableTick(TICK_SPACING),
                liquidityDelta: -int256(uint256(liquidity)),
                salt: 0
            }),
            ""
        );
    }

    function _addLiquidityAt(int24 lower, int24 upper, uint128 liquidity) internal {
        lpRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: 0
            }),
            ""
        );
    }

    /// @dev Mirrors `FeeSplitHook._impactCap`: MAX_IMPACT_BPS of the pool's live virtual AGENT
    ///      reserve, derived from slot0 + in-range liquidity.
    function _expectedImpactCap() internal view returns (uint256) {
        IPoolManager pm = IPoolManager(address(manager));
        (uint160 sqrtPriceX96,,,) = pm.getSlot0(PoolId.wrap(poolId));
        uint128 liquidity = pm.getLiquidity(PoolId.wrap(poolId));
        if (liquidity == 0) return 0;
        uint256 virtualAgentReserve = agentIsCurrency0
            ? FullMath.mulDiv(liquidity, FixedPoint96.Q96, sqrtPriceX96)
            : FullMath.mulDiv(liquidity, sqrtPriceX96, FixedPoint96.Q96);
        return FullMath.mulDiv(virtualAgentReserve, hook.MAX_IMPACT_BPS(), 10_000);
    }

    /// @param zeroForOne direction
    /// @param amountSpecified negative = exact input, positive = exact output
    function _swap(bool zeroForOne, int256 amountSpecified) internal {
        _swapOn(key, zeroForOne, amountSpecified);
    }

    function _swapOn(PoolKey memory k, bool zeroForOne, int256 amountSpecified) internal {
        swapRouter.swap(
            k,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _writePending(FeeSplitHook h, bytes32 pid, HookMockERC20 token, uint256 amount) internal {
        stdstore.target(address(h))
            .sig("pendingFees(bytes32,address)")
            .with_key(pid)
            .with_key(address(token))
            .checked_write(amount);
        token.mint(address(h), amount);
    }

    function _setPendingAgent(uint256 amount) internal {
        _writePending(hook, poolId, agent, amount);
    }

    function _setPendingUsdg(uint256 amount) internal {
        _writePending(hook, poolId, usdg, amount);
    }

    // -----------------------------------------------------------------------
    // Wiring / permissions
    // -----------------------------------------------------------------------

    function test_constructor_permissionsMatchAddress() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeInitialize && p.afterSwap && p.afterSwapReturnDelta);
        assertFalse(p.beforeSwap || p.afterInitialize || p.beforeAddLiquidity || p.afterAddLiquidity);
        assertFalse(p.beforeRemoveLiquidity || p.afterRemoveLiquidity || p.beforeDonate || p.afterDonate);
        assertEq(uint256(uint160(address(hook)) & Hooks.ALL_HOOK_MASK), uint256(HOOK_FLAGS));
    }

    function test_constants() public view {
        assertEq(hook.TOTAL_FEE_BPS(), 300);
        assertEq(hook.MAX_IMPACT_BPS(), 100);
        assertEq(hook.MAX_CONVERSION_PER_CALL(), 5_000e6);
        assertEq(hook.DISTRIBUTE_COOLDOWN(), 1 hours);
    }

    function test_setFactory_onlyDeployerAndOnce() public {
        FeeSplitHook fresh = _deployHook();
        vm.prank(address(0xDEAD));
        vm.expectRevert(FeeSplitHook.NotDeployer.selector);
        fresh.setFactory(address(this));

        fresh.setFactory(address(0xF00D));
        assertEq(fresh.factory(), address(0xF00D));

        vm.expectRevert(FeeSplitHook.AlreadySet.selector);
        fresh.setFactory(address(0xBEEF));
    }

    function test_beforeInitialize_onlyFactory() public {
        HookMockERC20 other = new HookMockERC20("Other", "OTH", 18);
        PoolKey memory k = _keyFor(address(other), IHooks(address(hook)));

        vm.prank(address(0xDEAD));
        vm.expectRevert();
        manager.initialize(k, TickMath.getSqrtPriceAtTick(0));

        // the factory (this test contract) can
        manager.initialize(k, TickMath.getSqrtPriceAtTick(0));
    }

    function test_disabledHookEntrypointsRevert() public {
        vm.expectRevert(FeeSplitHook.HookNotImplemented.selector);
        hook.afterInitialize(address(0), key, 0, 0);
        vm.expectRevert(FeeSplitHook.HookNotImplemented.selector);
        hook.beforeSwap(address(0), key, IPoolManager.SwapParams(true, -1, 0), "");
        vm.expectRevert(FeeSplitHook.HookNotImplemented.selector);
        hook.beforeDonate(address(0), key, 0, 0, "");
    }

    function test_afterSwap_onlyPoolManager() public {
        vm.expectRevert(FeeSplitHook.NotPoolManager.selector);
        hook.afterSwap(address(0), key, IPoolManager.SwapParams(true, -1, 0), toBalanceDelta(0, 0), "");
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(FeeSplitHook.NotPoolManager.selector);
        hook.unlockCallback("");
    }

    // -----------------------------------------------------------------------
    // registerPool validation
    // -----------------------------------------------------------------------

    function test_registerPool_notFactory() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(FeeSplitHook.NotFactory.selector);
        hook.registerPool(key, AGENT_ID, address(agent));
    }

    function test_registerPool_zeroAgentId() public {
        vm.expectRevert(FeeSplitHook.InvalidAgentId.selector);
        hook.registerPool(key, 0, address(agent));
    }

    function test_registerPool_wrongHook() public {
        PoolKey memory k = key;
        k.hooks = IHooks(address(0xBEEF));
        vm.expectRevert(FeeSplitHook.InvalidHookAddress.selector);
        hook.registerPool(k, AGENT_ID, address(agent));
    }

    function test_registerPool_nonZeroFee() public {
        PoolKey memory k = key;
        k.fee = 3000;
        vm.expectRevert(FeeSplitHook.InvalidFee.selector);
        hook.registerPool(k, AGENT_ID, address(agent));
    }

    function test_registerPool_wrongTickSpacing() public {
        PoolKey memory k = key;
        k.tickSpacing = 10;
        vm.expectRevert(FeeSplitHook.InvalidTickSpacing.selector);
        hook.registerPool(k, AGENT_ID, address(agent));
    }

    function test_registerPool_agentTokenNotInKey() public {
        HookMockERC20 other = new HookMockERC20("Other", "OTH", 18);
        vm.expectRevert(FeeSplitHook.InvalidCurrencies.selector);
        hook.registerPool(key, AGENT_ID, address(other));
    }

    function test_registerPool_quoteLegNotUsdg() public {
        HookMockERC20 other = new HookMockERC20("Other", "OTH", 18);
        PoolKey memory k = key;
        (Currency c0, Currency c1) = address(other) < address(agent)
            ? (Currency.wrap(address(other)), Currency.wrap(address(agent)))
            : (Currency.wrap(address(agent)), Currency.wrap(address(other)));
        k.currency0 = c0;
        k.currency1 = c1;
        vm.expectRevert(FeeSplitHook.InvalidCurrencies.selector);
        hook.registerPool(k, AGENT_ID, address(agent));
    }

    function test_registerPool_alreadyRegistered() public {
        vm.expectRevert(FeeSplitHook.AlreadyRegistered.selector);
        hook.registerPool(key, AGENT_ID, address(agent));
    }

    function test_registerPool_storesLayout() public view {
        (address token, bool isC0, bool registered, uint256 id) = hook.poolInfo(poolId);
        assertEq(token, address(agent));
        assertEq(isC0, agentIsCurrency0);
        assertTrue(registered);
        assertEq(id, AGENT_ID);
        assertEq(Currency.unwrap(hook.poolKeyOf(poolId).currency0), Currency.unwrap(key.currency0));
        assertEq(Currency.unwrap(hook.poolKeyOf(poolId).currency1), Currency.unwrap(key.currency1));
    }

    // -----------------------------------------------------------------------
    // afterSwap fee exactness
    // -----------------------------------------------------------------------

    /// @dev exact-in: the fee is charged on the OUTPUT (unspecified) currency.
    function test_afterSwap_exactIn_usdgToAgent() public {
        uint256 before = agent.balanceOf(address(this));
        _swap(!agentIsCurrency0, -10_000e6);
        uint256 received = agent.balanceOf(address(this)) - before;

        uint256 fee = hook.pendingFees(poolId, address(agent));
        assertGt(fee, 0, "no fee accrued");
        assertEq(hook.pendingFees(poolId, address(usdg)), 0, "fee on wrong side");
        assertEq(fee, ((received + fee) * 300) / 10_000, "fee != 300bps of unspecified");
        assertEq(agent.balanceOf(address(hook)), fee, "hook balance backs pending");
    }

    function test_afterSwap_exactIn_agentToUsdg() public {
        uint256 before = usdg.balanceOf(address(this));
        _swap(agentIsCurrency0, -1_000_000e18);
        uint256 received = usdg.balanceOf(address(this)) - before;

        uint256 fee = hook.pendingFees(poolId, address(usdg));
        assertGt(fee, 0);
        assertEq(hook.pendingFees(poolId, address(agent)), 0);
        assertEq(fee, ((received + fee) * 300) / 10_000);
        assertEq(usdg.balanceOf(address(hook)), fee);
    }

    /// @dev exact-out: the fee is charged on the INPUT (unspecified) currency.
    function test_afterSwap_exactOut_usdgToAgent() public {
        uint256 before = usdg.balanceOf(address(this));
        _swap(!agentIsCurrency0, int256(1_000_000e18));
        uint256 paid = before - usdg.balanceOf(address(this));

        uint256 fee = hook.pendingFees(poolId, address(usdg));
        assertGt(fee, 0);
        assertEq(hook.pendingFees(poolId, address(agent)), 0);
        assertEq(fee, ((paid - fee) * 300) / 10_000);
        assertEq(usdg.balanceOf(address(hook)), fee);
    }

    function test_afterSwap_exactOut_agentToUsdg() public {
        uint256 before = agent.balanceOf(address(this));
        _swap(agentIsCurrency0, int256(10_000e6));
        uint256 paid = before - agent.balanceOf(address(this));

        uint256 fee = hook.pendingFees(poolId, address(agent));
        assertGt(fee, 0);
        assertEq(hook.pendingFees(poolId, address(usdg)), 0);
        assertEq(fee, ((paid - fee) * 300) / 10_000);
    }

    function test_afterSwap_agentAsCurrency1() public {
        _deploy(false);
        assertFalse(agentIsCurrency0);

        uint256 before = agent.balanceOf(address(this));
        _swap(!agentIsCurrency0, -10_000e6);
        uint256 received = agent.balanceOf(address(this)) - before;
        uint256 fee = hook.pendingFees(poolId, address(agent));
        assertGt(fee, 0);
        assertEq(fee, ((received + fee) * 300) / 10_000);

        uint256 beforeUsdg = usdg.balanceOf(address(this));
        _swap(agentIsCurrency0, -1_000_000e18);
        uint256 recvUsdg = usdg.balanceOf(address(this)) - beforeUsdg;
        uint256 usdgFee = hook.pendingFees(poolId, address(usdg));
        assertEq(usdgFee, ((recvUsdg + usdgFee) * 300) / 10_000);
    }

    function test_afterSwap_unregisteredPoolTakesNothing() public {
        // A pool the factory initialized on this hook but never registered: no fee may move.
        HookMockERC20 other = new HookMockERC20("Other", "OTH", 18);
        bool otherIs0 = address(other) < address(usdg);
        PoolKey memory k = _keyFor(address(other), IHooks(address(hook)));
        uint160 sp = _sqrtPriceX96For(AGENT_RESERVE, USDG_RESERVE, otherIs0);
        manager.initialize(k, sp);

        other.mint(address(this), AGENT_RESERVE * 2);
        _approveAll(other);
        _addFullRangeLiquidity(k, sp, otherIs0, AGENT_RESERVE, USDG_RESERVE);

        uint256 hookOtherBefore = other.balanceOf(address(hook));
        uint256 hookUsdgBefore = usdg.balanceOf(address(hook));
        _swapOn(k, !otherIs0, -10_000e6);

        assertEq(other.balanceOf(address(hook)), hookOtherBefore, "fee taken on unregistered pool");
        assertEq(usdg.balanceOf(address(hook)), hookUsdgBefore);
        bytes32 otherId = PoolId.unwrap(k.toId());
        assertEq(hook.pendingFees(otherId, address(other)), 0);
        assertEq(hook.pendingFees(otherId, address(usdg)), 0);
    }

    // -----------------------------------------------------------------------
    // distribute
    // -----------------------------------------------------------------------

    function test_distribute_unknownPool() public {
        vm.expectRevert(FeeSplitHook.UnknownPool.selector);
        hook.distribute(bytes32(uint256(1)), 0);
    }

    function test_distribute_nothingPending() public {
        vm.expectRevert(FeeSplitHook.NothingPending.selector);
        hook.distribute(poolId, 0);
    }

    function test_distribute_dustBelowThreeWeiIsRejected() public {
        _setPendingUsdg(2);
        vm.expectRevert(FeeSplitHook.NothingPending.selector);
        hook.distribute(poolId, 0);
    }

    function test_distribute_usdgOnlyPath() public {
        _swap(agentIsCurrency0, -1_000_000e18); // AGENT in -> USDG fee
        uint256 pending = hook.pendingFees(poolId, address(usdg));
        assertGt(pending, 0);
        assertEq(hook.pendingFees(poolId, address(agent)), 0);

        uint256 leg = pending / 3;
        vm.expectEmit(true, false, false, true, address(hook));
        emit IFeeSplitHook.Distributed(poolId, leg, leg, leg, 0);
        hook.distribute(poolId, 0);

        assertEq(usdg.balanceOf(TREASURY_BUYBACK), leg, "buyback leg");
        assertEq(usdg.balanceOf(AGENT_TREASURY), leg, "treasury leg");
        assertEq(usdg.balanceOf(address(distributor)), leg, "royalty leg");
        assertEq(distributor.credited(AGENT_ID), leg, "credited");

        uint256 remainder = hook.pendingFees(poolId, address(usdg));
        assertEq(leg * 3, pending - remainder, "thirds sum to distributed total");
        assertLt(remainder, 3);
        assertEq(usdg.balanceOf(address(hook)), remainder, "hook balance == pending");
    }

    function test_distribute_thirdsSumExactly_everyRemainder() public {
        for (uint256 r = 0; r < 3; r++) {
            _deploy(true);
            uint256 amount = 1_000_000 + r;
            _setPendingUsdg(amount);
            hook.distribute(poolId, 0);

            uint256 leg = amount / 3;
            uint256 paid = usdg.balanceOf(TREASURY_BUYBACK) + usdg.balanceOf(AGENT_TREASURY)
                + usdg.balanceOf(address(distributor));
            assertEq(paid, leg * 3, "legs sum");
            assertEq(hook.pendingFees(poolId, address(usdg)), amount - leg * 3, "remainder retained");
            assertLt(amount - leg * 3, 3);
        }
    }

    function test_distribute_conversionPath() public {
        _swap(!agentIsCurrency0, -10_000e6); // USDG in -> AGENT fee
        uint256 pendingAgent = hook.pendingFees(poolId, address(agent));
        assertGt(pendingAgent, 0);
        uint256 spot = hook.quoteAgentToUsdg(poolId, pendingAgent);
        assertLt(spot, hook.MAX_CONVERSION_PER_CALL(), "test sizing: cap must not bind here");

        hook.distribute(poolId, 0);

        assertEq(hook.pendingFees(poolId, address(agent)), 0, "agent not fully converted");
        assertEq(agent.balanceOf(address(hook)), 0, "stranded agent");

        uint256 leg = usdg.balanceOf(TREASURY_BUYBACK);
        assertGt(leg, 0);
        assertEq(usdg.balanceOf(AGENT_TREASURY), leg);
        assertEq(usdg.balanceOf(address(distributor)), leg);
        assertEq(distributor.credited(AGENT_ID), leg);

        uint256 converted = leg * 3 + hook.pendingFees(poolId, address(usdg));
        assertGe(converted, (spot * 9900) / 10_000, "below impact floor");
        assertLe(converted, spot, "cannot beat spot on a constant-product pool");
    }

    function test_distribute_conversionCapLeavesRemainder() public {
        // ~10,000 USDG of AGENT inventory: twice MAX_CONVERSION_PER_CALL.
        uint256 perToken = hook.quoteAgentToUsdg(poolId, 1e18);
        uint256 pendingAgent = (10_000e6 * 1e18) / perToken;
        _setPendingAgent(pendingAgent);
        assertGt(hook.quoteAgentToUsdg(poolId, pendingAgent), hook.MAX_CONVERSION_PER_CALL(), "cap must bind");

        hook.distribute(poolId, 0);

        uint256 leftover = hook.pendingFees(poolId, address(agent));
        assertGt(leftover, 0, "cap did not leave a remainder");
        assertEq(agent.balanceOf(address(hook)), leftover, "leftover not backed by balance");

        // re-quoted at the post-conversion price, so slightly under the cap
        uint256 convertedValue = hook.quoteAgentToUsdg(poolId, pendingAgent - leftover);
        assertLe(convertedValue, hook.MAX_CONVERSION_PER_CALL(), "converted above the cap");
        assertGt(convertedValue, (hook.MAX_CONVERSION_PER_CALL() * 95) / 100, "cap under-used");
    }

    /// @dev The old brick case: LPs pull 99.9% of the depth after AGENT fees accrued. The
    ///      conversion must no longer revert forever — it converts an impact-sized slice per
    ///      call and the leftover drains across cooldowns.
    function test_distribute_shallowPoolConvertsSliceAndLeavesRemainder() public {
        _swap(!agentIsCurrency0, -10_000e6); // accrue AGENT fees at deep-pool prices
        uint256 pendingAgent = hook.pendingFees(poolId, address(agent));
        assertGt(pendingAgent, 0);

        _removeLiquidity(seededLiquidity - seededLiquidity / 1000);

        uint256 cap = _expectedImpactCap();
        assertGt(cap, 0, "no impact cap");
        assertLt(cap, pendingAgent, "test sizing: impact cap must bind");
        uint256 spotOfSlice = hook.quoteAgentToUsdg(poolId, cap);

        hook.distribute(poolId, 0);

        uint256 leftover = hook.pendingFees(poolId, address(agent));
        assertEq(pendingAgent - leftover, cap, "converted != impact cap");
        assertGt(leftover, 0, "whole inventory converted on a 0.1%-depth pool");
        assertEq(agent.balanceOf(address(hook)), leftover, "leftover not backed by balance");

        // the slice actually paid out, inside the impact bound
        uint256 leg = usdg.balanceOf(TREASURY_BUYBACK);
        assertGt(leg, 0, "nothing distributed");
        uint256 converted = leg * 3 + hook.pendingFees(poolId, address(usdg));
        assertGe(converted, (spotOfSlice * 9_900) / 10_000, "slice below impact floor");
        assertLe(converted, spotOfSlice, "slice beat spot");
    }

    /// @dev Repeated calls on the same shallow pool drain the leftover to zero.
    function test_distribute_shallowPoolDrainsOverRepeatedCalls() public {
        _swap(!agentIsCurrency0, -10_000e6);
        uint256 pendingAgent = hook.pendingFees(poolId, address(agent));
        _removeLiquidity(seededLiquidity - seededLiquidity / 1000);

        uint256 calls;
        while (hook.pendingFees(poolId, address(agent)) != 0) {
            uint256 before = hook.pendingFees(poolId, address(agent));
            hook.distribute(poolId, 0);
            assertLt(hook.pendingFees(poolId, address(agent)), before, "no progress on this call");
            vm.warp(vm.getBlockTimestamp() + hook.DISTRIBUTE_COOLDOWN());
            calls++;
            assertLt(calls, 64, "drain did not terminate");
        }

        assertGt(calls, 1, "test sizing: should take more than one call");
        assertEq(agent.balanceOf(address(hook)), 0, "stranded agent after drain");
        assertGt(usdg.balanceOf(TREASURY_BUYBACK), 0, "nothing ever paid out");
        assertGt(pendingAgent, 0);
    }

    /// @dev On a shallow pool the impact cap, not the notional cap, is what binds, and the
    ///      converted size is MAX_IMPACT_BPS of the virtual AGENT reserve.
    function test_distribute_impactCapBindsBelowNotionalCap() public {
        _removeLiquidity(seededLiquidity - seededLiquidity / 1000);

        uint256 cap = _expectedImpactCap();
        // Inventory large enough that neither `pendingAgent` nor the notional cap can bind.
        uint256 pendingAgent = cap * 10;
        _setPendingAgent(pendingAgent);
        uint256 notionalAgent =
            FullMath.mulDiv(pendingAgent, hook.MAX_CONVERSION_PER_CALL(), hook.quoteAgentToUsdg(poolId, pendingAgent));
        assertGt(notionalAgent, cap, "test sizing: notional cap must be the looser one");

        uint256 spotOfSlice = hook.quoteAgentToUsdg(poolId, cap);
        hook.distribute(poolId, 0);

        uint256 consumed = pendingAgent - hook.pendingFees(poolId, address(agent));
        assertEq(consumed, cap, "did not convert exactly the impact cap");

        // ~1% of the virtual AGENT reserve, and the realized output inside MAX_IMPACT_BPS
        uint256 converted = usdg.balanceOf(TREASURY_BUYBACK) * 3 + hook.pendingFees(poolId, address(usdg));
        assertGe(converted, (spotOfSlice * 9_900) / 10_000, "realized output below the bound");
        assertLe(converted, spotOfSlice, "realized output beat spot");
    }

    /// @dev `ImpactTooHigh` is still reachable, and is not dead code: the sizing cap reads
    ///      *in-range* liquidity, so a pool whose depth is concentrated in a narrow band around
    ///      spot with a thin tail beyond it advertises far more depth than the swap traverses.
    function test_distribute_impactBoundStillRevertsOnConcentratedDepth() public {
        _removeLiquidity(seededLiquidity);

        (uint160 sqrtPriceX96, int24 tick,,) = IPoolManager(address(manager)).getSlot0(PoolId.wrap(poolId));
        int24 mid = (tick / TICK_SPACING) * TICK_SPACING;

        // L for a pool of 5e7 AGENT / 100k USDG, parked in a single tick-spacing band around
        // spot, plus a thousandth of it spread full range as the tail.
        uint128 band = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(TICK_SPACING)),
            TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(TICK_SPACING)),
            agentIsCurrency0 ? 50_000_000e18 : 100_000e6,
            agentIsCurrency0 ? 100_000e6 : 50_000_000e18
        );
        _addLiquidityAt(mid - TICK_SPACING, mid + TICK_SPACING, band);
        _addLiquidityAt(TickMath.minUsableTick(TICK_SPACING), TickMath.maxUsableTick(TICK_SPACING), band / 1000);

        // Sized off the fat in-range band; the swap escapes it into the thin tail.
        uint256 cap = _expectedImpactCap();
        _setPendingAgent(cap * 2);

        vm.expectPartialRevert(FeeSplitHook.ImpactTooHigh.selector);
        hook.distribute(poolId, 0);

        // nothing moved
        assertEq(usdg.balanceOf(TREASURY_BUYBACK), 0);
        assertEq(hook.pendingFees(poolId, address(agent)), cap * 2);
    }

    function test_distribute_minConversionOutEnforced() public {
        _swap(!agentIsCurrency0, -10_000e6);
        uint256 spot = hook.quoteAgentToUsdg(poolId, hook.pendingFees(poolId, address(agent)));
        vm.expectPartialRevert(FeeSplitHook.SlippageExceeded.selector);
        hook.distribute(poolId, spot * 2);
    }

    function test_distribute_cooldown() public {
        _setPendingUsdg(3_000e6);
        hook.distribute(poolId, 0);

        _setPendingUsdg(3_000e6);
        vm.expectRevert(FeeSplitHook.CooldownActive.selector);
        hook.distribute(poolId, 0);

        vm.warp(vm.getBlockTimestamp() + hook.DISTRIBUTE_COOLDOWN() - 1);
        vm.expectRevert(FeeSplitHook.CooldownActive.selector);
        hook.distribute(poolId, 0);

        vm.warp(vm.getBlockTimestamp() + 1);
        hook.distribute(poolId, 0);
        assertEq(usdg.balanceOf(TREASURY_BUYBACK), 2_000e6);
    }

    function test_distribute_usesLiveRegistryTreasury() public {
        _setPendingUsdg(3_000e6);
        hook.distribute(poolId, 0);
        assertEq(usdg.balanceOf(AGENT_TREASURY), 1_000e6);

        // the agent revives with a new treasury EOA
        address newTreasury = address(0xBEEF01);
        registry.setTreasury(AGENT_ID, newTreasury);

        vm.warp(vm.getBlockTimestamp() + hook.DISTRIBUTE_COOLDOWN());
        _setPendingUsdg(3_000e6);
        hook.distribute(poolId, 0);

        assertEq(usdg.balanceOf(AGENT_TREASURY), 1_000e6, "old treasury paid twice");
        assertEq(usdg.balanceOf(newTreasury), 1_000e6, "new treasury not paid");
    }

    function test_distribute_permissionless() public {
        _setPendingUsdg(3_000e6);
        vm.prank(address(0xCAFE));
        hook.distribute(poolId, 0);
        assertEq(usdg.balanceOf(TREASURY_BUYBACK), 1_000e6);
    }

    /// @dev The conversion swap runs against the taxed pool; if it were taxed again a 300bps
    ///      slice would be withheld and reappear as fresh USDG pending.
    function test_distribute_conversionSwapIsNotSelfTaxed() public {
        _swap(!agentIsCurrency0, -10_000e6);
        assertEq(hook.pendingFees(poolId, address(usdg)), 0);

        hook.distribute(poolId, 0);

        uint256 remainder = hook.pendingFees(poolId, address(usdg));
        assertLt(remainder, 3, "conversion was re-taxed");
        assertEq(usdg.balanceOf(address(hook)), remainder);
        assertGt(usdg.balanceOf(TREASURY_BUYBACK), 0);
    }

    // -----------------------------------------------------------------------
    // reentrancy
    // -----------------------------------------------------------------------

    function test_distribute_reentrancyViaDistributorCredit() public {
        HookReentrantDistributor bad = new HookReentrantDistributor();
        distributor = HookMockDistributor(address(bad));
        (FeeSplitHook h, bytes32 pid) = _redeployHookAndPool();

        bad.arm(address(h), pid);
        _writePending(h, pid, usdg, 3_000e6);

        h.distribute(pid, 0);
        assertTrue(bad.attempted(), "reentry not attempted");
        assertTrue(bad.reentryReverted(), "reentry was not blocked");
        assertEq(usdg.balanceOf(TREASURY_BUYBACK), 1_000e6, "outer distribution incomplete");
    }

    function test_distribute_registryStaticcallCannotReenter() public {
        HookReentrantRegistry badRegistry = new HookReentrantRegistry();
        registry = HookMockRegistry(address(badRegistry));
        (FeeSplitHook h, bytes32 pid) = _redeployHookAndPool();

        badRegistry.arm(address(h), pid, AGENT_TREASURY);
        _writePending(h, pid, usdg, 3_000e6);

        h.distribute(pid, 0);
        assertEq(usdg.balanceOf(AGENT_TREASURY), 1_000e6);
    }

    /// @dev Redeploys the hook against the current `registry`/`distributor` fields and wires a
    ///      fresh pool with the same currency layout.
    function _redeployHookAndPool() internal returns (FeeSplitHook h, bytes32 pid) {
        h = _deployHook();
        h.setFactory(address(this));
        PoolKey memory k = _keyFor(address(agent), IHooks(address(h)));
        uint160 sp = _sqrtPriceX96For(AGENT_RESERVE, USDG_RESERVE, agentIsCurrency0);
        manager.initialize(k, sp);
        h.registerPool(k, AGENT_ID, address(agent));
        pid = PoolId.unwrap(k.toId());
    }
}
