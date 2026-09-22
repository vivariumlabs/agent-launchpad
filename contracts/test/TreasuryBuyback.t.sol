// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {TreasuryBuyback} from "../src/TreasuryBuyback.sol";
import {ITreasuryBuyback} from "../src/interfaces/ILaunchpad.sol";
import {BuybackMockERC20, BuybackSpamCaller} from "./mocks/BuybackMocks.sol";

/// @notice Local-PoolManager unit tests for TreasuryBuyback.
/// @dev The stand-in for the PONS `$TOKEN/USDG` pool is hookless: from this contract's side a
///      hooked pool is identical bar the fee it charges inside the swap, which surfaces here
///      only as a smaller `tokensOut` (see MAX_IMPACT_BPS notes in the contract).
///      Pool depth: 1e9 TOKEN (18d) against 2,000,000 USDG (6d), full range, fee 0.
contract TreasuryBuybackTest is Test {
    using PoolIdLibrary for PoolKey;

    uint256 constant TOKEN_RESERVE = 1_000_000_000e18;
    uint256 constant USDG_RESERVE = 2_000_000e6;
    int24 constant TICK_SPACING = 60;

    address constant OWNER = address(0xA11CE);
    address constant POKER = address(0xB0B);
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    PoolManager manager;
    PoolSwapTest swapRouter;
    PoolModifyLiquidityTest lpRouter;

    BuybackMockERC20 usdg;
    BuybackMockERC20 token;
    bool usdgIsCurrency0;

    TreasuryBuyback buyback;
    PoolKey key;
    uint128 seededLiquidity;

    function setUp() public {
        _deploy(false); // TOKEN sorts as currency0 by default
    }

    // -----------------------------------------------------------------------
    // Harness
    // -----------------------------------------------------------------------

    /// @param usdgBelowToken whether USDG should sort as currency0
    function _deploy(bool usdgBelowToken) internal {
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);

        usdg = new BuybackMockERC20("Global Dollar", "USDG", 6);
        token = _deployTokenSorted(address(usdg), !usdgBelowToken);
        usdgIsCurrency0 = address(usdg) < address(token);
        assertEq(usdgIsCurrency0, usdgBelowToken, "token ordering");

        key = _keyFor(address(token));
        uint160 sqrtPriceX96 = _sqrtPriceX96For(TOKEN_RESERVE, USDG_RESERVE);
        manager.initialize(key, sqrtPriceX96);

        token.mint(address(this), TOKEN_RESERVE * 4);
        usdg.mint(address(this), USDG_RESERVE * 4);
        token.approve(address(lpRouter), type(uint256).max);
        usdg.approve(address(lpRouter), type(uint256).max);
        token.approve(address(swapRouter), type(uint256).max);
        usdg.approve(address(swapRouter), type(uint256).max);

        seededLiquidity = _addFullRangeLiquidity(sqrtPriceX96, TOKEN_RESERVE, USDG_RESERVE);

        buyback = _freshBuyback();
        vm.prank(OWNER);
        buyback.setTargetPool(key);
    }

    function _freshBuyback() internal returns (TreasuryBuyback) {
        return _freshBuyback(500);
    }

    function _freshBuyback(uint256 maxImpactBps) internal returns (TreasuryBuyback) {
        return new TreasuryBuyback(IPoolManager(address(manager)), address(usdg), OWNER, maxImpactBps);
    }

    function _keyFor(address other) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = other < address(usdg)
            ? (Currency.wrap(other), Currency.wrap(address(usdg)))
            : (Currency.wrap(address(usdg)), Currency.wrap(other));
        return PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: TICK_SPACING, hooks: IHooks(address(0))});
    }

    /// @dev CREATE2 salt search, so both currency orderings can be exercised.
    function _deployTokenSorted(address other, bool wantBelow) internal returns (BuybackMockERC20) {
        bytes memory args = abi.encode("Platform Token", "TOKEN", uint8(18));
        bytes32 initHash = keccak256(abi.encodePacked(type(BuybackMockERC20).creationCode, args));
        for (uint256 i = 1; i < 4096; i++) {
            bytes32 salt = bytes32(i);
            address predicted = vm.computeCreate2Address(salt, initHash, address(this));
            if (predicted.code.length == 0 && (predicted < other) == wantBelow) {
                return new BuybackMockERC20{salt: salt}("Platform Token", "TOKEN", 18);
            }
        }
        revert("no salt found");
    }

    function _sqrtPriceX96For(uint256 tokenAmount, uint256 usdgAmount) internal view returns (uint160) {
        (uint256 amount0, uint256 amount1) = usdgIsCurrency0 ? (usdgAmount, tokenAmount) : (tokenAmount, usdgAmount);
        uint256 ratioX192 = FullMath.mulDiv(amount1, 1 << 192, amount0);
        return uint160(FixedPointMathLib.sqrt(ratioX192));
    }

    function _addFullRangeLiquidity(uint160 sqrtPriceX96, uint256 tokenAmount, uint256 usdgAmount)
        internal
        returns (uint128 liquidity)
    {
        int24 lower = TickMath.minUsableTick(TICK_SPACING);
        int24 upper = TickMath.maxUsableTick(TICK_SPACING);
        (uint256 amount0, uint256 amount1) = usdgIsCurrency0 ? (usdgAmount, tokenAmount) : (tokenAmount, usdgAmount);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0, amount1
        );
        lpRouter.modifyLiquidity(
            key,
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

    function _fund(uint256 amount) internal {
        usdg.mint(address(buyback), amount);
    }

    /// @dev Pokes as POKER and returns the `Poked` event payload.
    function _poke(uint256 minTokensOut) internal returns (uint256 usdgIn, uint256 burned, uint256 reward) {
        vm.recordLogs();
        vm.prank(POKER);
        buyback.poke(minTokensOut);
        return _readPoked();
    }

    function _readPoked() internal view returns (uint256 usdgIn, uint256 burned, uint256 reward) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("Poked(address,uint256,uint256,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(buyback) && logs[i].topics[0] == topic) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), POKER, "Poked caller");
                return abi.decode(logs[i].data, (uint256, uint256, uint256));
            }
        }
        revert("Poked not emitted");
    }

    // -----------------------------------------------------------------------
    // Wiring — setTargetPool
    // -----------------------------------------------------------------------

    function test_setTargetPool_storesUsdgSideAndToken() public view {
        assertTrue(buyback.targetPoolSet());
        assertEq(buyback.usdgIsCurrency0(), usdgIsCurrency0);
        assertEq(buyback.token(), address(token));
        PoolKey memory stored = buyback.targetPool();
        assertEq(PoolId.unwrap(stored.toId()), PoolId.unwrap(key.toId()));
    }

    function test_setTargetPool_bothCurrencyOrderings() public {
        _deploy(true); // USDG as currency0
        assertTrue(buyback.usdgIsCurrency0());
        assertEq(buyback.token(), address(token));

        _fund(5_000e6);
        (, uint256 burned,) = _poke(1);
        assertEq(token.balanceOf(DEAD), burned, "burn on the other ordering");
    }

    function test_setTargetPool_onlyOwner() public {
        TreasuryBuyback fresh = _freshBuyback();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        fresh.setTargetPool(key);
    }

    function test_setTargetPool_isOneTime() public {
        vm.prank(OWNER);
        vm.expectRevert(TreasuryBuyback.AlreadySet.selector);
        buyback.setTargetPool(key);
    }

    function test_setTargetPool_rejectsPoolWithoutUsdg() public {
        BuybackMockERC20 other = new BuybackMockERC20("Other", "OTH", 18);
        (Currency c0, Currency c1) = address(other) < address(token)
            ? (Currency.wrap(address(other)), Currency.wrap(address(token)))
            : (Currency.wrap(address(token)), Currency.wrap(address(other)));
        PoolKey memory bad =
            PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: TICK_SPACING, hooks: IHooks(address(0))});

        TreasuryBuyback fresh = _freshBuyback();
        vm.prank(OWNER);
        vm.expectRevert(TreasuryBuyback.InvalidCurrencies.selector);
        fresh.setTargetPool(bad);
    }

    function test_setTargetPool_rejectsUsdgOnBothSides() public {
        PoolKey memory bad = PoolKey({
            currency0: Currency.wrap(address(usdg)),
            currency1: Currency.wrap(address(usdg)),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        TreasuryBuyback fresh = _freshBuyback();
        vm.prank(OWNER);
        vm.expectRevert(TreasuryBuyback.InvalidCurrencies.selector);
        fresh.setTargetPool(bad);
    }

    function test_poke_revertsUntilTargetSet() public {
        TreasuryBuyback fresh = _freshBuyback();
        usdg.mint(address(fresh), 5_000e6);
        vm.expectRevert(TreasuryBuyback.TargetNotSet.selector);
        fresh.poke(1);
    }

    function test_poke_revertsWhenPoolUninitialized() public {
        BuybackMockERC20 other = _deployTokenSorted(address(usdg), true);
        PoolKey memory unopened = _keyFor(address(other));
        TreasuryBuyback fresh = _freshBuyback();
        vm.prank(OWNER);
        fresh.setTargetPool(unopened);
        usdg.mint(address(fresh), 5_000e6);
        vm.expectRevert(TreasuryBuyback.PoolNotInitialized.selector);
        fresh.poke(1);
    }

    // -----------------------------------------------------------------------
    // Tunables — defaults and hardcoded bounds
    // -----------------------------------------------------------------------

    function test_defaultsMatchParameterTable() public view {
        assertEq(buyback.maxPerPoke(), 2_000e6);
        assertEq(buyback.cooldown(), 1 hours);
        assertEq(buyback.rewardBps(), 30);
        assertEq(buyback.REWARD_CAP(), 10e6);
        assertEq(buyback.MAX_PER_POKE_LIMIT(), 10_000e6);
        assertEq(buyback.MIN_COOLDOWN(), 10 minutes);
        assertEq(buyback.MAX_REWARD_BPS(), 100);
        assertEq(buyback.maxImpactBps(), 500);
    }

    // -----------------------------------------------------------------------
    // Construction — maxImpactBps
    // -----------------------------------------------------------------------

    function test_constructor_rejectsZeroImpactBps() public {
        vm.expectRevert(TreasuryBuyback.InvalidBps.selector);
        _freshBuyback(0);
    }

    function test_constructor_rejectsImpactBpsAboveThousand() public {
        vm.expectRevert(TreasuryBuyback.InvalidBps.selector);
        _freshBuyback(1_001);
    }

    function test_constructor_acceptsImpactBpsAtBounds() public {
        TreasuryBuyback low = _freshBuyback(1);
        assertEq(low.maxImpactBps(), 1);

        TreasuryBuyback high = _freshBuyback(1_000);
        assertEq(high.maxImpactBps(), 1_000);
    }

    function test_maxImpactBps_isLiveKnobAtDeploy() public {
        // Same pool, same swap size as test_poke_happyPath (natural execution shortfall there
        // is ~10bps against spot, comfortably inside the default 500bps bound). Wiring a fresh
        // buyback with a 5bps bound instead — still a valid, in-range constructor value — makes
        // that identical, normally-passing poke revert ImpactTooHigh: proof maxImpactBps is a
        // live, effective parameter and not a no-op.
        TreasuryBuyback tight = _freshBuyback(5);
        vm.prank(OWNER);
        tight.setTargetPool(key);
        usdg.mint(address(tight), 5_000e6);

        vm.expectPartialRevert(TreasuryBuyback.ImpactTooHigh.selector);
        vm.prank(POKER);
        tight.poke(1);

        // Sanity: the identical fund/poke against the default-bound buyback still passes.
        _fund(5_000e6);
        (, uint256 burned,) = _poke(1);
        assertGt(burned, 0);
    }

    function test_setMaxPerPoke_bounds() public {
        vm.startPrank(OWNER);
        vm.expectRevert(TreasuryBuyback.InvalidParameter.selector);
        buyback.setMaxPerPoke(0);
        vm.expectRevert(TreasuryBuyback.InvalidParameter.selector);
        buyback.setMaxPerPoke(10_000e6 + 1);
        buyback.setMaxPerPoke(10_000e6);
        assertEq(buyback.maxPerPoke(), 10_000e6);
        buyback.setMaxPerPoke(1);
        assertEq(buyback.maxPerPoke(), 1);
        vm.stopPrank();
    }

    function test_setCooldown_bounds() public {
        vm.startPrank(OWNER);
        vm.expectRevert(TreasuryBuyback.InvalidParameter.selector);
        buyback.setCooldown(10 minutes - 1);
        buyback.setCooldown(10 minutes);
        assertEq(buyback.cooldown(), 10 minutes);
        buyback.setCooldown(30 days);
        assertEq(buyback.cooldown(), 30 days);
        vm.stopPrank();
    }

    function test_setReward_bounds() public {
        vm.startPrank(OWNER);
        vm.expectRevert(TreasuryBuyback.InvalidParameter.selector);
        buyback.setReward(101);
        buyback.setReward(100);
        assertEq(buyback.rewardBps(), 100);
        buyback.setReward(0);
        assertEq(buyback.rewardBps(), 0);
        vm.stopPrank();
    }

    function test_setters_onlyOwner() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, POKER);
        vm.startPrank(POKER);
        vm.expectRevert(err);
        buyback.setMaxPerPoke(1_000e6);
        vm.expectRevert(err);
        buyback.setCooldown(1 hours);
        vm.expectRevert(err);
        buyback.setReward(10);
        vm.expectRevert(err);
        buyback.setTargetPool(key);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // poke
    // -----------------------------------------------------------------------

    function test_poke_happyPath() public {
        _fund(5_000e6);
        uint256 spot = buyback.quoteUsdgToToken(1_994e6);
        uint256 managerBefore = usdg.balanceOf(address(manager));

        (uint256 usdgIn, uint256 burned, uint256 reward) = _poke(1);

        // amountIn = min(2_000e6, 5_000e6) = 2_000e6; reward = 2_000e6 * 30bps = 6e6 (< cap).
        assertEq(reward, 6e6, "reward");
        assertEq(usdgIn, 1_994e6, "usdg swapped");
        assertEq(usdg.balanceOf(POKER), 6e6, "caller paid in USDG");
        assertEq(usdg.balanceOf(address(buyback)), 3_000e6, "remaining treasury balance");
        assertEq(usdg.balanceOf(address(manager)) - managerBefore, 1_994e6, "pool received the swap input");
        assertEq(token.balanceOf(DEAD), burned, "burned to dead address");
        assertEq(token.balanceOf(address(buyback)), 0, "no token retained");
        assertGt(burned, 0, "bought something");
        assertLt(burned, spot, "exact-in is below spot");
        assertGt(burned, (spot * 9_500) / 10_000, "inside the impact bound");
        assertEq(buyback.lastPoke(), block.timestamp, "cooldown armed");
    }

    function test_poke_rejectsZeroMinTokensOut() public {
        _fund(5_000e6);
        vm.expectRevert(TreasuryBuyback.MinimumOutputRequired.selector);
        buyback.poke(0);
    }

    function test_poke_enforcesMinTokensOut() public {
        _fund(5_000e6);
        uint256 spot = buyback.quoteUsdgToToken(1_994e6);
        vm.expectPartialRevert(TreasuryBuyback.SlippageExceeded.selector);
        buyback.poke(spot + 1);
        // Nothing moved.
        assertEq(usdg.balanceOf(address(buyback)), 5_000e6);
        assertEq(buyback.lastPoke(), 0);
    }

    function test_poke_revertsOnEmptyBalance() public {
        vm.expectRevert(TreasuryBuyback.NothingToBuy.selector);
        buyback.poke(1);
    }

    function test_poke_cooldownEnforced() public {
        _fund(10_000e6);
        _poke(1);
        uint256 first = buyback.lastPoke();

        vm.expectRevert(TreasuryBuyback.CooldownActive.selector);
        buyback.poke(1);

        vm.warp(first + 1 hours - 1);
        vm.expectRevert(TreasuryBuyback.CooldownActive.selector);
        buyback.poke(1);

        // Exactly at the edge it clears.
        vm.warp(first + 1 hours);
        _poke(1);
        assertEq(buyback.lastPoke(), first + 1 hours);
    }

    function test_poke_spamInOneTransactionBlocked() public {
        _fund(10_000e6);
        BuybackSpamCaller spammer = new BuybackSpamCaller(ITreasuryBuyback(address(buyback)));
        vm.expectRevert(TreasuryBuyback.CooldownActive.selector);
        spammer.doublePoke(1);

        // A single poke from the same contract is fine, and the next one still needs the wait.
        spammer.singlePoke(1);
        vm.expectRevert(TreasuryBuyback.CooldownActive.selector);
        spammer.singlePoke(1);
    }

    function test_poke_balanceBelowMaxPerPoke() public {
        _fund(500e6);
        (uint256 usdgIn, uint256 burned, uint256 reward) = _poke(1);
        assertEq(reward, 1.5e6, "reward on the smaller slice");
        assertEq(usdgIn, 498.5e6, "spent the whole balance minus reward");
        assertEq(usdg.balanceOf(address(buyback)), 0, "balance drained");
        assertGt(burned, 0);
    }

    function test_poke_dustBalance() public {
        _fund(100); // 1e-4 USDG: reward rounds to zero, the swap still executes
        (uint256 usdgIn, uint256 burned, uint256 reward) = _poke(1);
        assertEq(reward, 0, "no reward on dust");
        assertEq(usdgIn, 100);
        assertEq(usdg.balanceOf(POKER), 0);
        assertGt(burned, 0);
        assertEq(token.balanceOf(DEAD), burned);
    }

    function test_poke_rewardCapBinds() public {
        vm.startPrank(OWNER);
        buyback.setReward(100); // 1%
        buyback.setMaxPerPoke(10_000e6);
        vm.stopPrank();

        _fund(20_000e6);
        (uint256 usdgIn,, uint256 reward) = _poke(1);

        // Uncapped the reward would be 100e6; REWARD_CAP holds it at 10e6.
        assertEq(reward, 10e6, "reward capped");
        assertEq(usdgIn, 10_000e6 - 10e6, "swap sized after the reserved reward");
        assertEq(usdg.balanceOf(POKER), 10e6);
        assertEq(usdg.balanceOf(address(buyback)), 10_000e6, "leftover untouched");
    }

    function test_poke_rewardIsAlwaysFunded() public {
        // Balance exactly equal to maxPerPoke: the reward is withheld from the same slice,
        // so the swap can never leave the contract unable to pay it.
        _fund(2_000e6);
        (uint256 usdgIn,, uint256 reward) = _poke(1);
        assertEq(usdgIn + reward, 2_000e6);
        assertEq(usdg.balanceOf(address(buyback)), 0);
        assertEq(usdg.balanceOf(POKER), reward);
    }

    function test_poke_impactBoundRevertsOnThinPool() public {
        // Pull 99.99% of the depth: a 2,000 USDG poke then moves the price ~10x and executes
        // miles under spot, which MAX_IMPACT_BPS must reject.
        _removeLiquidity(seededLiquidity - seededLiquidity / 10_000);

        _fund(5_000e6);
        vm.expectPartialRevert(TreasuryBuyback.ImpactTooHigh.selector);
        buyback.poke(1);

        assertEq(usdg.balanceOf(address(buyback)), 5_000e6, "no funds moved");
        assertEq(token.balanceOf(DEAD), 0, "nothing burned");
        assertEq(buyback.lastPoke(), 0, "cooldown not consumed by a revert");
    }

    function test_poke_smallSliceStillClearsThinPool() public {
        // Same thin pool, but the owner retunes `maxPerPoke` down: the poke fits again.
        _removeLiquidity(seededLiquidity - seededLiquidity / 10_000);
        vm.prank(OWNER);
        buyback.setMaxPerPoke(1e6); // 1 USDG against a ~200 USDG reserve

        _fund(5_000e6);
        (uint256 usdgIn,, uint256 reward) = _poke(1);
        assertEq(reward, 3_000, "1 USDG * 30bps = 3000 wei");
        assertEq(usdgIn, 1e6 - 3_000);
        assertGt(token.balanceOf(DEAD), 0);
    }

    function test_poke_afterHostileSwapUsesFreshSpot() public {
        // A front-runner moves the price, then the poke runs. The bound is against live spot,
        // so the poke succeeds at the new (worse) price: the accepted bounded-sandwich risk
        // documented on the contract. minTokensOut is the caller's defence.
        _fund(5_000e6);
        uint256 spotBefore = buyback.quoteUsdgToToken(1_994e6);

        bool usdgForToken = usdgIsCurrency0;
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: usdgForToken,
                amountSpecified: -int256(100_000e6),
                sqrtPriceLimitX96: usdgForToken ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 spotAfter = buyback.quoteUsdgToToken(1_994e6);
        assertLt(spotAfter, spotBefore, "front-run moved spot against us");

        (, uint256 burned,) = _poke(1);
        assertGt(burned, (spotAfter * 9_500) / 10_000, "still inside the bound at the new spot");

        // And the caller-side floor does stop it when they know the honest price.
        vm.warp(block.timestamp + 1 hours);
        vm.expectPartialRevert(TreasuryBuyback.SlippageExceeded.selector);
        vm.prank(POKER);
        buyback.poke(spotBefore);
    }

    // -----------------------------------------------------------------------
    // Ownership
    // -----------------------------------------------------------------------

    function test_renounceOwnership_disabled() public {
        vm.prank(OWNER);
        vm.expectRevert(TreasuryBuyback.RenounceDisabled.selector);
        buyback.renounceOwnership();

        vm.prank(POKER);
        vm.expectRevert(TreasuryBuyback.RenounceDisabled.selector);
        buyback.renounceOwnership();

        assertEq(buyback.owner(), OWNER);
    }

    function test_ownershipHandoverIsTwoStep() public {
        address newOwner = address(0xC0FFEE);
        vm.prank(OWNER);
        buyback.transferOwnership(newOwner);
        assertEq(buyback.owner(), OWNER, "not transferred until accepted");
        assertEq(buyback.pendingOwner(), newOwner);

        vm.prank(POKER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, POKER));
        buyback.acceptOwnership();

        vm.prank(newOwner);
        buyback.acceptOwnership();
        assertEq(buyback.owner(), newOwner);
    }

    // -----------------------------------------------------------------------
    // No withdrawal path
    // -----------------------------------------------------------------------

    /// @notice The complete external mutating surface of TreasuryBuyback is:
    ///
    ///           setTargetPool(PoolKey)   owner, one-time, moves no funds
    ///           setMaxPerPoke(uint256)   owner, bounded, moves no funds
    ///           setCooldown(uint256)     owner, bounded, moves no funds
    ///           setReward(uint256)       owner, bounded, moves no funds
    ///           transferOwnership(addr)  owner, moves no funds
    ///           acceptOwnership()        pending owner, moves no funds
    ///           renounceOwnership()      reverts always
    ///           poke(uint256)            permissionless; the ONLY function that moves funds
    ///           unlockCallback(bytes)    PoolManager-only, and only inside our own poke
    ///
    ///         There is no sweep, rescue, withdraw, or arbitrary-call entrypoint, for the
    ///         owner or anyone else. This test asserts that behaviourally: every owner call
    ///         leaves the balance untouched, and the only USDG that ever leaves goes to the
    ///         PoolManager (the swap) or to the poke caller (the reward), with the bought
    ///         token going to the burn address and nowhere else.
    function test_noWithdrawalPath() public {
        _fund(5_000e6);
        uint256 startBalance = usdg.balanceOf(address(buyback));

        vm.startPrank(OWNER);
        buyback.setMaxPerPoke(10_000e6);
        buyback.setCooldown(10 minutes);
        buyback.setReward(100);
        buyback.transferOwnership(OWNER);
        vm.stopPrank();
        assertEq(usdg.balanceOf(address(buyback)), startBalance, "owner calls move nothing");

        // Nothing resembling a withdrawal exists in the ABI.
        address[3] memory victims = [OWNER, POKER, address(this)];
        bytes4[6] memory absent = [
            bytes4(keccak256("withdraw(uint256)")),
            bytes4(keccak256("withdraw(address,uint256)")),
            bytes4(keccak256("sweep(address)")),
            bytes4(keccak256("rescue(address,uint256)")),
            bytes4(keccak256("execute(address,bytes)")),
            bytes4(keccak256("call(address,uint256,bytes)"))
        ];
        for (uint256 v = 0; v < victims.length; v++) {
            for (uint256 i = 0; i < absent.length; i++) {
                vm.prank(victims[v]);
                (bool ok,) = address(buyback).call(abi.encodeWithSelector(absent[i], address(usdg), uint256(1)));
                assertFalse(ok, "no withdrawal-shaped entrypoint");
            }
        }
        assertEq(usdg.balanceOf(address(buyback)), startBalance, "still intact");

        uint256 managerBefore = usdg.balanceOf(address(manager));
        (uint256 usdgIn, uint256 burned, uint256 reward) = _poke(1);

        assertEq(usdg.balanceOf(address(manager)) - managerBefore, usdgIn, "pool leg");
        assertEq(usdg.balanceOf(POKER), reward, "reward leg");
        assertEq(usdg.balanceOf(address(buyback)), startBalance - usdgIn - reward, "residual leg");
        assertEq(token.balanceOf(DEAD), burned, "burn leg");
        assertEq(token.balanceOf(OWNER), 0, "owner receives nothing");
        assertEq(token.balanceOf(address(buyback)), 0, "nothing retained");
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(TreasuryBuyback.NotPoolManager.selector);
        buyback.unlockCallback(abi.encode(uint256(1_000e6)));
    }

    function test_unlockCallback_rejectsPoolManagerOutsidePoke() public {
        vm.prank(address(manager));
        vm.expectRevert(TreasuryBuyback.NotUnlocking.selector);
        buyback.unlockCallback(abi.encode(uint256(1_000e6)));
    }
}
