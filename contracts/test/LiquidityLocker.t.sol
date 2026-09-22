// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

import {LiquidityLocker} from "../src/LiquidityLocker.sol";
import {ILiquidityLocker} from "../src/interfaces/ILaunchpad.sol";
import {FactoryMockERC20} from "./mocks/FactoryMocks.sol";

/// @notice Unit tests for the rewritten locker: liquidity is minted directly on a local
///         PoolManager through the locker's own unlock callback, and there is no removal
///         surface of any kind. This test contract stands in for the factory.
contract LiquidityLockerTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 constant AGENT_ID = 7;
    int24 constant TICK_SPACING = 60;
    uint256 constant AGENT_AMOUNT = 500_000_000e18;
    uint256 constant USDG_AMOUNT = 42_000e6;

    PoolManager manager;
    LiquidityLocker locker;

    FactoryMockERC20 usdg;
    FactoryMockERC20 agent;
    bool agentIsCurrency0;

    PoolKey key;
    bytes32 poolId;
    uint160 sqrtPriceX96;

    address stranger = makeAddr("stranger");

    function setUp() public {
        manager = new PoolManager(address(this));
        locker = new LiquidityLocker(IPoolManager(address(manager)));
        locker.setFactory(address(this));

        usdg = new FactoryMockERC20("Global Dollar", "USDG", 6);
        agent = new FactoryMockERC20("Agent", "AGT", 18);
        agentIsCurrency0 = address(agent) < address(usdg);

        key = _key(TICK_SPACING);
        poolId = PoolId.unwrap(key.toId());

        (uint256 amount0, uint256 amount1) = _sorted(AGENT_AMOUNT, USDG_AMOUNT);
        sqrtPriceX96 = uint160(FixedPointMathLib.sqrt(FullMath.mulDiv(amount1, 1 << 192, amount0)));
        manager.initialize(key, sqrtPriceX96);
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    function _key(int24 tickSpacing) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = agentIsCurrency0
            ? (Currency.wrap(address(agent)), Currency.wrap(address(usdg)))
            : (Currency.wrap(address(usdg)), Currency.wrap(address(agent)));
        return PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: tickSpacing, hooks: IHooks(address(0))});
    }

    function _sorted(uint256 agentAmount, uint256 usdgAmount) internal view returns (uint256, uint256) {
        return agentIsCurrency0 ? (agentAmount, usdgAmount) : (usdgAmount, agentAmount);
    }

    /// @dev Funds the locker exactly the way the factory does, immediately before `lock`.
    function _fund(uint256 amount0, uint256 amount1) internal {
        FactoryMockERC20(Currency.unwrap(key.currency0)).mint(address(locker), amount0);
        FactoryMockERC20(Currency.unwrap(key.currency1)).mint(address(locker), amount1);
    }

    function _fullRange() internal pure returns (int24 lower, int24 upper) {
        lower = TickMath.minUsableTick(TICK_SPACING);
        upper = TickMath.maxUsableTick(TICK_SPACING);
    }

    function _liquidityFor(uint256 amount0, uint256 amount1) internal view returns (uint128) {
        (int24 lower, int24 upper) = _fullRange();
        return LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0, amount1
        );
    }

    function _positionLiquidity() internal view returns (uint128 liquidity) {
        (int24 lower, int24 upper) = _fullRange();
        (liquidity,,) = IPoolManager(address(manager))
            .getPositionInfo(PoolId.wrap(poolId), address(locker), lower, upper, bytes32(AGENT_ID));
    }

    // -----------------------------------------------------------------------
    // wiring
    // -----------------------------------------------------------------------

    function test_constructor_revertsZeroPoolManager() public {
        vm.expectRevert(LiquidityLocker.ZeroAddress.selector);
        new LiquidityLocker(IPoolManager(address(0)));
    }

    function test_setFactory_onlyDeployerOnceNonZero() public {
        LiquidityLocker fresh = new LiquidityLocker(IPoolManager(address(manager)));

        vm.prank(stranger);
        vm.expectRevert(LiquidityLocker.NotDeployer.selector);
        fresh.setFactory(address(this));

        vm.expectRevert(LiquidityLocker.ZeroAddress.selector);
        fresh.setFactory(address(0));

        fresh.setFactory(address(this));
        assertEq(fresh.factory(), address(this));

        vm.expectRevert(LiquidityLocker.AlreadySet.selector);
        fresh.setFactory(stranger);
    }

    // -----------------------------------------------------------------------
    // lock — access control
    // -----------------------------------------------------------------------

    function test_lock_onlyFactory() public {
        (uint256 a0, uint256 a1) = _sorted(AGENT_AMOUNT, USDG_AMOUNT);
        _fund(a0, a1);

        vm.prank(stranger);
        vm.expectRevert(LiquidityLocker.NotFactory.selector);
        locker.lock(AGENT_ID, key, a0, a1);
    }

    function test_lock_rejectsZeroAgentId() public {
        (uint256 a0, uint256 a1) = _sorted(AGENT_AMOUNT, USDG_AMOUNT);
        _fund(a0, a1);
        vm.expectRevert(LiquidityLocker.InvalidAgentId.selector);
        locker.lock(0, key, a0, a1);
    }

    function test_lock_revertsOnUninitializedPool() public {
        PoolKey memory other = _key(30); // different spacing => different, uninitialized pool id
        (uint256 a0, uint256 a1) = _sorted(AGENT_AMOUNT, USDG_AMOUNT);
        _fund(a0, a1);
        vm.expectRevert(LiquidityLocker.PoolNotInitialized.selector);
        locker.lock(AGENT_ID, other, a0, a1);
    }

    function test_lock_revertsOnZeroLiquidity() public {
        vm.expectRevert(LiquidityLocker.ZeroLiquidity.selector);
        locker.lock(AGENT_ID, key, 0, 0);
    }

    function test_lock_onlyOncePerAgent() public {
        (uint256 a0, uint256 a1) = _sorted(AGENT_AMOUNT, USDG_AMOUNT);
        _fund(a0, a1);
        locker.lock(AGENT_ID, key, a0, a1);

        _fund(a0, a1);
        vm.expectRevert(LiquidityLocker.AlreadyLocked.selector);
        locker.lock(AGENT_ID, key, a0, a1);
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(LiquidityLocker.NotPoolManager.selector);
        locker.unlockCallback("");
    }

    // -----------------------------------------------------------------------
    // lock — behaviour
    // -----------------------------------------------------------------------

    function test_lock_mintsFullRangePositionOwnedByLocker() public {
        (uint256 a0, uint256 a1) = _sorted(AGENT_AMOUNT, USDG_AMOUNT);
        uint128 expected = _liquidityFor(a0, a1);
        assertGt(expected, 0);
        _fund(a0, a1);

        vm.expectEmit(true, true, false, true, address(locker));
        emit ILiquidityLocker.Locked(AGENT_ID, poolId, expected);
        uint128 liquidity = locker.lock(AGENT_ID, key, a0, a1);

        assertEq(liquidity, expected, "returned liquidity");
        assertEq(locker.lockedLiquidity(AGENT_ID), expected, "view");
        assertEq(_positionLiquidity(), expected, "position not owned by locker under salt(agentId)");
        assertEq(IPoolManager(address(manager)).getLiquidity(PoolId.wrap(poolId)), expected, "pool liquidity");

        // full range for spacing 60
        (int24 lower, int24 upper) = _fullRange();
        assertEq(lower, -887220, "tickLower");
        assertEq(upper, 887220, "tickUpper");
    }

    /// @dev The mint must be settled out of the locker's own balance, exactly: the PoolManager
    ///      gains what the locker loses, and only rounding dust is left behind.
    function test_lock_settlesExactlyFromOwnBalance() public {
        (uint256 a0, uint256 a1) = _sorted(AGENT_AMOUNT, USDG_AMOUNT);
        _fund(a0, a1);

        FactoryMockERC20 t0 = FactoryMockERC20(Currency.unwrap(key.currency0));
        FactoryMockERC20 t1 = FactoryMockERC20(Currency.unwrap(key.currency1));
        uint256 pm0 = t0.balanceOf(address(manager));
        uint256 pm1 = t1.balanceOf(address(manager));

        locker.lock(AGENT_ID, key, a0, a1);

        uint256 used0 = t0.balanceOf(address(manager)) - pm0;
        uint256 used1 = t1.balanceOf(address(manager)) - pm1;
        assertGt(used0, 0);
        assertGt(used1, 0);
        assertLe(used0, a0, "settled more currency0 than provided");
        assertLe(used1, a1, "settled more currency1 than provided");

        // whatever was not consumed is stranded in the locker, and it is dust: under a
        // billionth of the side it sits on (the binding side is consumed to the wei).
        assertEq(t0.balanceOf(address(locker)), a0 - used0, "currency0 dust");
        assertEq(t1.balanceOf(address(locker)), a1 - used1, "currency1 dust");
        assertLe(a0 - used0, a0 / 1e9 + 1, "dust on currency0 above 1e-9 of the seed");
        assertLe(a1 - used1, a1 / 1e9 + 1, "dust on currency1 above 1e-9 of the seed");
    }

    /// @dev The pool price must not move: the seed sits symmetrically around spot.
    function test_lock_doesNotMoveSpot() public {
        (uint256 a0, uint256 a1) = _sorted(AGENT_AMOUNT, USDG_AMOUNT);
        _fund(a0, a1);
        locker.lock(AGENT_ID, key, a0, a1);

        (uint160 after_,,,) = IPoolManager(address(manager)).getSlot0(PoolId.wrap(poolId));
        assertEq(after_, sqrtPriceX96, "seeding moved the price");
    }

    function test_lock_secondAgentOnSamePoolUsesItsOwnSalt() public {
        (uint256 a0, uint256 a1) = _sorted(AGENT_AMOUNT, USDG_AMOUNT);
        _fund(a0, a1);
        uint128 first = locker.lock(AGENT_ID, key, a0, a1);

        _fund(a0, a1);
        uint128 second = locker.lock(AGENT_ID + 1, key, a0, a1);

        (int24 lower, int24 upper) = _fullRange();
        (uint128 l2,,) = IPoolManager(address(manager))
            .getPositionInfo(PoolId.wrap(poolId), address(locker), lower, upper, bytes32(AGENT_ID + 1));
        assertEq(l2, second, "second position");
        assertEq(_positionLiquidity(), first, "first position disturbed");
        assertEq(locker.lockedLiquidity(AGENT_ID + 1), second);
    }

    /// @dev Behavioural statement of the locked-forever property: after a lock, the only
    ///      external entrypoints on the locker are `setFactory` (already burnt), `lock`
    ///      (rejects the agent) and `unlockCallback` (rejects any caller but the PoolManager).
    ///      There is no path that decreases the position, so its liquidity is still there.
    function test_noRemovalSurface() public {
        (uint256 a0, uint256 a1) = _sorted(AGENT_AMOUNT, USDG_AMOUNT);
        _fund(a0, a1);
        uint128 liquidity = locker.lock(AGENT_ID, key, a0, a1);

        vm.expectRevert(LiquidityLocker.AlreadySet.selector);
        locker.setFactory(stranger);

        _fund(a0, a1);
        vm.expectRevert(LiquidityLocker.AlreadyLocked.selector);
        locker.lock(AGENT_ID, key, a0, a1);

        vm.prank(stranger);
        vm.expectRevert(LiquidityLocker.NotPoolManager.selector);
        locker.unlockCallback(abi.encode(AGENT_ID, key, int24(-887220), int24(887220), liquidity));

        // and a direct PoolManager call from the locker is impossible: only the locker's own
        // code can act as the locker, and it never asks for a negative liquidity delta.
        assertEq(_positionLiquidity(), liquidity, "position changed");
    }
}
