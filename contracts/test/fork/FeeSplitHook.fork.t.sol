// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

import {FeeSplitHook} from "../../src/FeeSplitHook.sol";
import {HookMockERC20, HookMockRegistry, HookMockDistributor} from "../mocks/HookMocks.sol";

/// @notice FeeSplitHook against the real Uniswap v4 PoolManager deployed on Robinhood Chain
///         testnet (chain 46630).
/// @dev Both pool currencies are mocks deployed in-fork: the live USDG cannot be minted from a
///      test and guessing its storage layout for `deal` is fragile. A 6-decimal mock reproduces
///      everything the hook depends on. If the RPC is unreachable every test skips rather than
///      failing.
contract FeeSplitHookForkTest is Test {
    using PoolIdLibrary for PoolKey;

    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    uint160 constant HOOK_FLAGS =
        uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    uint256 constant AGENT_ID = 42;
    uint256 constant AGENT_RESERVE = 1_000_000_000e18;
    uint256 constant USDG_RESERVE = 2_000_000e6;
    int24 constant TICK_SPACING = 60;
    address constant TREASURY_BUYBACK = address(0xBB1);
    address constant AGENT_TREASURY = address(0x7EA);

    bool forkUp;

    PoolSwapTest swapRouter;
    PoolModifyLiquidityTest lpRouter;
    HookMockERC20 usdg;
    HookMockERC20 agent;
    HookMockRegistry registry;
    HookMockDistributor distributor;

    FeeSplitHook hook;
    PoolKey hookedKey;
    PoolKey bareKey;
    bytes32 poolId;
    bool agentIsCurrency0;
    uint160 initialSqrtPrice;

    function setUp() public {
        try vm.createSelectFork(vm.rpcUrl("rh_testnet")) {
            forkUp = address(MANAGER).code.length > 0;
        } catch {
            forkUp = false;
        }
        if (!forkUp) return;

        swapRouter = new PoolSwapTest(MANAGER);
        lpRouter = new PoolModifyLiquidityTest(MANAGER);

        usdg = new HookMockERC20("Global Dollar", "USDG", 6);
        agent = new HookMockERC20("Agent", "AGT", 18);
        agentIsCurrency0 = address(agent) < address(usdg);

        registry = new HookMockRegistry();
        registry.setTreasury(AGENT_ID, AGENT_TREASURY);
        distributor = new HookMockDistributor(address(usdg));

        // --- mine the hook address and deploy there (v4-periphery at this pinned commit has
        //     no HookMiner; this is the M0 spike's approach) ---
        address hookAddr = address(HOOK_FLAGS | (uint160(0xA91E) << 20));
        assertEq(hookAddr.code.length, 0, "mined hook address is occupied");
        deployCodeTo(
            "FeeSplitHook.sol:FeeSplitHook",
            abi.encode(MANAGER, address(usdg), address(registry), address(distributor), TREASURY_BUYBACK),
            hookAddr
        );
        hook = FeeSplitHook(hookAddr);
        hook.setFactory(address(this));

        (Currency c0, Currency c1) = agentIsCurrency0
            ? (Currency.wrap(address(agent)), Currency.wrap(address(usdg)))
            : (Currency.wrap(address(usdg)), Currency.wrap(address(agent)));
        hookedKey =
            PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: TICK_SPACING, hooks: IHooks(address(hook))});
        bareKey = PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: TICK_SPACING, hooks: IHooks(address(0))});
        poolId = PoolId.unwrap(hookedKey.toId());

        initialSqrtPrice = _sqrtPriceX96For(AGENT_RESERVE, USDG_RESERVE);
        MANAGER.initialize(hookedKey, initialSqrtPrice);
        hook.registerPool(hookedKey, AGENT_ID, address(agent));
        MANAGER.initialize(bareKey, initialSqrtPrice);

        agent.mint(address(this), AGENT_RESERVE * 8);
        usdg.mint(address(this), USDG_RESERVE * 8);
        agent.approve(address(swapRouter), type(uint256).max);
        usdg.approve(address(swapRouter), type(uint256).max);
        agent.approve(address(lpRouter), type(uint256).max);
        usdg.approve(address(lpRouter), type(uint256).max);

        _addLiquidity(hookedKey);
        _addLiquidity(bareKey);
    }

    modifier onFork() {
        if (!forkUp) {
            vm.skip(true);
        }
        _;
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    function _sqrtPriceX96For(uint256 agentAmount, uint256 usdgAmount) internal view returns (uint160) {
        (uint256 amount0, uint256 amount1) = agentIsCurrency0 ? (agentAmount, usdgAmount) : (usdgAmount, agentAmount);
        return uint160(FixedPointMathLib.sqrt(FullMath.mulDiv(amount1, 1 << 192, amount0)));
    }

    function _addLiquidity(PoolKey memory k) internal {
        int24 lower = TickMath.minUsableTick(TICK_SPACING);
        int24 upper = TickMath.maxUsableTick(TICK_SPACING);
        (uint256 amount0, uint256 amount1) =
            agentIsCurrency0 ? (AGENT_RESERVE, USDG_RESERVE) : (USDG_RESERVE, AGENT_RESERVE);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            initialSqrtPrice, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0, amount1
        );
        lpRouter.modifyLiquidity(
            k,
            IPoolManager.ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: 0
            }),
            ""
        );
    }

    function _swap(PoolKey memory k, bool zeroForOne, int256 amountSpecified) internal {
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

    // -----------------------------------------------------------------------
    // tests
    // -----------------------------------------------------------------------

    function test_fork_isRobinhoodTestnetWithLivePoolManager() public onFork {
        assertEq(block.chainid, 46630, "wrong chain");
        assertGt(address(MANAGER).code.length, 0, "no PoolManager code");
        assertEq(uint256(uint160(address(hook)) & Hooks.ALL_HOOK_MASK), uint256(HOOK_FLAGS), "hook flags");
    }

    function test_fork_feeExactness_bothDirections() public onFork {
        // exact-in USDG -> AGENT: fee on the AGENT (output) leg
        uint256 beforeAgent = agent.balanceOf(address(this));
        _swap(hookedKey, !agentIsCurrency0, -50_000e6);
        uint256 agentOut = agent.balanceOf(address(this)) - beforeAgent;
        uint256 agentFee = hook.pendingFees(poolId, address(agent));
        assertGt(agentFee, 0);
        assertEq(agentFee, ((agentOut + agentFee) * 300) / 10_000, "agent-leg fee != 300bps");
        assertEq(agent.balanceOf(address(hook)), agentFee, "agent fee not held by hook");

        // exact-in AGENT -> USDG: fee on the USDG (output) leg
        uint256 beforeUsdg = usdg.balanceOf(address(this));
        _swap(hookedKey, agentIsCurrency0, -10_000_000e18);
        uint256 usdgOut = usdg.balanceOf(address(this)) - beforeUsdg;
        uint256 usdgFee = hook.pendingFees(poolId, address(usdg));
        assertGt(usdgFee, 0);
        assertEq(usdgFee, ((usdgOut + usdgFee) * 300) / 10_000, "usdg-leg fee != 300bps");
        assertEq(usdg.balanceOf(address(hook)), usdgFee, "usdg fee not held by hook");

        // exact-out AGENT -> USDG: fee on the AGENT (input) leg
        uint256 agentFeeBefore = agentFee;
        uint256 paidBefore = agent.balanceOf(address(this));
        _swap(hookedKey, agentIsCurrency0, int256(10_000e6));
        uint256 paid = paidBefore - agent.balanceOf(address(this));
        uint256 exactOutFee = hook.pendingFees(poolId, address(agent)) - agentFeeBefore;
        assertGt(exactOutFee, 0);
        assertEq(exactOutFee, ((paid - exactOutFee) * 300) / 10_000, "exact-out fee != 300bps");
    }

    function test_fork_distributeEndToEnd() public onFork {
        _swap(hookedKey, !agentIsCurrency0, -50_000e6); // AGENT-side fees
        _swap(hookedKey, agentIsCurrency0, -10_000_000e18); // USDG-side fees

        uint256 pendingAgent = hook.pendingFees(poolId, address(agent));
        uint256 pendingUsdg = hook.pendingFees(poolId, address(usdg));
        assertGt(pendingAgent, 0);
        assertGt(pendingUsdg, 0);

        uint256 spot = hook.quoteAgentToUsdg(poolId, pendingAgent);
        hook.distribute(poolId, (spot * 9_900) / 10_000);

        uint256 leg = usdg.balanceOf(TREASURY_BUYBACK);
        assertGt(leg, 0, "no buyback leg");
        assertEq(usdg.balanceOf(AGENT_TREASURY), leg, "treasury leg mismatch");
        assertEq(usdg.balanceOf(address(distributor)), leg, "royalty leg mismatch");
        assertEq(distributor.credited(AGENT_ID), leg, "credit mismatch");

        uint256 remainder = hook.pendingFees(poolId, address(usdg));
        assertLt(remainder, 3, "remainder above 2 wei");
        assertEq(usdg.balanceOf(address(hook)), remainder, "hook USDG balance != pending");
        assertEq(hook.pendingFees(poolId, address(agent)), 0, "agent side not fully converted");
        assertEq(agent.balanceOf(address(hook)), 0, "stranded agent tokens");

        // the three legs plus the retained remainder account for the pre-existing USDG and the
        // whole conversion output, and the conversion landed inside the impact bound
        uint256 total = leg * 3 + remainder;
        assertGe(total, pendingUsdg, "converted value went missing");
        uint256 converted = total - pendingUsdg;
        assertGe(converted, (spot * 9_900) / 10_000, "conversion below impact floor");
        assertLe(converted, spot, "conversion beat spot");

        // cooldown holds on the live chain clock too
        vm.expectRevert(FeeSplitHook.CooldownActive.selector);
        hook.distribute(poolId, 0);
    }

    function test_fork_gasAddedByHook() public onFork {
        // first swap on each pool: worst case, every slot the hook touches is cold
        uint256 c0 = gasleft();
        _swap(bareKey, !agentIsCurrency0, -1_000e6);
        uint256 bareCold = c0 - gasleft();

        uint256 c1 = gasleft();
        _swap(hookedKey, !agentIsCurrency0, -1_000e6);
        uint256 hookedCold = c1 - gasleft();

        console2.log("bare swap gas (cold)  :", bareCold);
        console2.log("hooked swap gas (cold):", hookedCold);
        console2.log("added by hook (cold)  :", hookedCold - bareCold);
        assertLt(hookedCold - bareCold, 120_000, "hook adds more than 120k gas (cold)");

        uint256 g0 = gasleft();
        _swap(bareKey, !agentIsCurrency0, -1_000e6);
        uint256 bareGas = g0 - gasleft();

        uint256 g1 = gasleft();
        _swap(hookedKey, !agentIsCurrency0, -1_000e6);
        uint256 hookedGas = g1 - gasleft();

        console2.log("bare swap gas (warm)  :", bareGas);
        console2.log("hooked swap gas (warm):", hookedGas);
        console2.log("added by hook (warm)  :", hookedGas - bareGas);

        assertGt(hookedGas, bareGas, "hook is free?");
        assertLt(hookedGas - bareGas, 120_000, "hook adds more than 120k gas (warm)");
    }

    function test_fork_unregisteredPoolOnLiveManagerTakesNothing() public onFork {
        HookMockERC20 other = new HookMockERC20("Other", "OTH", 18);
        (Currency c0, Currency c1) = address(other) < address(usdg)
            ? (Currency.wrap(address(other)), Currency.wrap(address(usdg)))
            : (Currency.wrap(address(usdg)), Currency.wrap(address(other)));
        PoolKey memory k =
            PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: TICK_SPACING, hooks: IHooks(address(hook))});

        // initialization is factory-gated even on the live manager
        vm.prank(address(0xDEAD));
        vm.expectRevert();
        MANAGER.initialize(k, initialSqrtPrice);
    }
}
