// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {AgentFactory} from "../../src/AgentFactory.sol";
import {AgentRegistry} from "../../src/AgentRegistry.sol";
import {AgentNFT} from "../../src/AgentNFT.sol";
import {AgentToken} from "../../src/AgentToken.sol";
import {AgentBondingCurve} from "../../src/AgentBondingCurve.sol";
import {RoyaltyDistributor} from "../../src/RoyaltyDistributor.sol";
import {FeeSplitHook} from "../../src/FeeSplitHook.sol";
import {LiquidityLocker} from "../../src/LiquidityLocker.sol";
import {GraduationMath} from "../../src/libraries/GraduationMath.sol";
import {FactoryMockERC20} from "../mocks/FactoryMocks.sol";

/// @notice The whole agent lifecycle — create, register, finalize, trade the curve to the
///         graduation threshold, sweep + burn, seed and lock a pool, swap on it, distribute —
///         against the **real** Uniswap v4 PoolManager on Robinhood Chain testnet (46630).
/// @dev USDG is a 6-decimal mock deployed in-fork: the live USDG cannot be minted from a test
///      and guessing its storage layout for `deal` is fragile. Everything else is the real
///      contract. If the RPC is unreachable every test skips rather than failing.
contract GraduationForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    uint160 constant HOOK_FLAGS =
        uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    uint256 constant AGENT_SUPPLY = 1_000_000_000e18;
    uint256 constant CREATION_FEE = 75e6;
    uint256 constant PHANTOM_QUOTE = 6_000e6;
    int24 constant TICK_SPACING = 60;

    bytes32 constant CODE_HASH = keccak256("agent-image-v1");
    string constant IMAGE_URI = "ar://metadata-txid";

    bool forkUp;

    PoolSwapTest swapRouter;
    FactoryMockERC20 usdg;
    AgentRegistry registry;
    AgentNFT nft;
    RoyaltyDistributor distributor;
    FeeSplitHook hook;
    LiquidityLocker locker;
    AgentFactory factory;

    address constant BUYBACK = address(0xBB1);
    address owner = makeAddr("owner");
    address gasRecipient = makeAddr("gasRecipient");
    address creator = makeAddr("creator");
    address trader = makeAddr("trader");
    address treasury = makeAddr("treasuryEOA");
    address actionEOA = makeAddr("actionEOA");
    /// @dev Buyer of the agent NFT in the transcript test; also the address that burns it.
    address secondOwner = makeAddr("secondOwner");

    function setUp() public {
        try vm.createSelectFork(vm.rpcUrl("rh_testnet")) {
            forkUp = address(MANAGER).code.length > 0;
        } catch {
            forkUp = false;
        }
        if (!forkUp) return;

        swapRouter = new PoolSwapTest(MANAGER);
        usdg = new FactoryMockERC20("Global Dollar", "USDG", 6);

        registry = new AgentRegistry();
        nft = new AgentNFT();
        distributor = new RoyaltyDistributor(address(usdg), address(nft), address(registry));

        // v4-periphery at this pinned commit has no HookMiner; mine by hand as the M0 spike did.
        address hookAddr = address(HOOK_FLAGS | (uint160(0xC0DE) << 20));
        assertEq(hookAddr.code.length, 0, "mined hook address is occupied");
        deployCodeTo(
            "FeeSplitHook.sol:FeeSplitHook",
            abi.encode(MANAGER, address(usdg), address(registry), address(distributor), BUYBACK),
            hookAddr
        );
        hook = FeeSplitHook(hookAddr);

        locker = new LiquidityLocker(MANAGER);

        factory = new AgentFactory(
            address(usdg),
            address(MANAGER),
            address(registry),
            address(nft),
            address(distributor),
            address(hook),
            address(locker),
            BUYBACK,
            gasRecipient,
            owner
        );

        registry.setFactory(address(factory));
        nft.setFactory(address(factory));
        nft.setDistributor(address(distributor));
        distributor.setFactory(address(factory));
        distributor.setHook(address(hook));
        hook.setFactory(address(factory));
        locker.setFactory(address(factory));

        usdg.mint(creator, 1_000e6);
        usdg.mint(trader, 5_000_000e6);
        vm.prank(creator);
        usdg.approve(address(factory), type(uint256).max);
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

    function _live() internal returns (uint256 agentId) {
        vm.prank(creator);
        agentId = factory.createAgent("Agent One", "AG1", IMAGE_URI, keccak256("config"), creator, treasury);
        vm.prank(treasury);
        registry.registerInstance(agentId, treasury, actionEOA, CODE_HASH, "ar://attestation");
        factory.finalize(agentId);
    }

    function _buyToThreshold(uint256 agentId) internal {
        AgentBondingCurve curve = AgentBondingCurve(factory.curveOf(agentId));
        vm.startPrank(trader);
        usdg.approve(address(curve), type(uint256).max);
        while (!curve.readyToGraduate()) {
            curve.buy(5_000e6, 0, trader);
        }
        vm.stopPrank();
    }

    function _poolKeyOf(uint256 agentId) internal view returns (PoolKey memory) {
        address token = factory.tokenOf(agentId);
        (Currency c0, Currency c1) = token < address(usdg)
            ? (Currency.wrap(token), Currency.wrap(address(usdg)))
            : (Currency.wrap(address(usdg)), Currency.wrap(token));
        return PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: TICK_SPACING, hooks: IHooks(address(hook))});
    }

    function _swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified) internal {
        vm.prank(trader);
        swapRouter.swap(
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

    // -----------------------------------------------------------------------
    // tests
    // -----------------------------------------------------------------------

    function test_fork_isRobinhoodTestnetWithLivePoolManager() public onFork {
        assertEq(block.chainid, 46630, "wrong chain");
        assertGt(address(MANAGER).code.length, 0, "no PoolManager code");
        assertEq(uint256(uint160(address(hook)) & Hooks.ALL_HOOK_MASK), uint256(HOOK_FLAGS), "hook flags");
    }

    /// @dev The whole lifecycle in one transaction sequence against the live singleton.
    function test_fork_lifecycleThroughGraduatedPool() public onFork {
        uint256 agentId = _live();
        address token = factory.tokenOf(agentId);

        assertEq(AgentToken(token).totalSupply(), AGENT_SUPPLY);
        assertEq(AgentToken(token).balanceOf(factory.curveOf(agentId)), AGENT_SUPPLY);
        assertEq(nft.ownerOf(agentId), creator);
        assertEq(nft.tokenURI(agentId), IMAGE_URI);
        assertEq(usdg.balanceOf(owner), CREATION_FEE, "platform fee");

        _buyToThreshold(agentId);

        AgentBondingCurve curve = AgentBondingCurve(factory.curveOf(agentId));
        (uint256 reserveUsdg, uint256 reserveTokens) = curve.reserves();
        uint256 expectedPoolTokens = FullMath.mulDiv(reserveTokens, reserveUsdg, reserveUsdg + PHANTOM_QUOTE);
        uint256 supplyBefore = AgentToken(token).totalSupply();

        factory.graduate(agentId);

        (uint256 sweptUsdg, uint256 poolTokens) = factory.sweptOf(agentId);
        assertEq(sweptUsdg, reserveUsdg, "swept usdg");
        assertEq(poolTokens, expectedPoolTokens, "pool tokens");
        assertEq(AgentToken(token).totalSupply(), supplyBefore - (reserveTokens - expectedPoolTokens), "burn");

        (uint256 amount0, uint256 amount1) = token < address(usdg) ? (poolTokens, sweptUsdg) : (sweptUsdg, poolTokens);
        uint160 expectedPrice = GraduationMath.sqrtPriceX96FromAmounts(amount0, amount1);

        factory.createGraduatedPool(agentId);

        _assertPoolLocked(agentId, expectedPrice);

        console2.log("pool USDG          :", sweptUsdg);
        console2.log("pool AGENT (1e18)  :", poolTokens / 1e18);
    }

    function _assertPoolLocked(uint256 agentId, uint160 expectedPrice) internal view {
        bytes32 poolId = PoolId.unwrap(_poolKeyOf(agentId).toId());

        (uint160 sqrtPriceX96,,,) = MANAGER.getSlot0(PoolId.wrap(poolId));
        assertApproxEqAbs(sqrtPriceX96, expectedPrice, 1, "live pool opened at the wrong price");

        uint128 liquidity = locker.lockedLiquidity(agentId);
        assertGt(liquidity, 0, "no locked liquidity on the live manager");
        assertEq(MANAGER.getLiquidity(PoolId.wrap(poolId)), liquidity, "pool liquidity");
        (uint128 positionLiquidity,,) = MANAGER.getPositionInfo(
            PoolId.wrap(poolId),
            address(locker),
            TickMath.minUsableTick(TICK_SPACING),
            TickMath.maxUsableTick(TICK_SPACING),
            bytes32(agentId)
        );
        assertEq(positionLiquidity, liquidity, "position not held by the locker");
        console2.log("locked liquidity   :", liquidity);

        (uint256 s0, uint256 s1) = factory.sweptOf(agentId);
        assertEq(s0 + s1, 0, "swept state not cleared");
        assertEq(usdg.balanceOf(address(factory)), 0, "factory retained usdg");
        assertEq(AgentToken(factory.tokenOf(agentId)).balanceOf(address(factory)), 0, "factory retained tokens");
    }

    /// @dev Pool phase on the live manager: the hook taxes swaps and the three legs settle.
    function test_fork_graduatedPoolSwapsAndDistributes() public onFork {
        uint256 agentId = _live();
        _buyToThreshold(agentId);
        factory.graduate(agentId);
        factory.createGraduatedPool(agentId);

        address token = factory.tokenOf(agentId);
        bool agentIsCurrency0 = token < address(usdg);
        PoolKey memory key = _poolKeyOf(agentId);
        bytes32 poolId = PoolId.unwrap(key.toId());

        vm.startPrank(trader);
        usdg.approve(address(swapRouter), type(uint256).max);
        AgentToken(token).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();

        // USDG in -> AGENT-side fee, then AGENT in -> USDG-side fee
        _swap(key, !agentIsCurrency0, -1_000e6);
        uint256 pendingAgent = hook.pendingFees(poolId, token);
        assertGt(pendingAgent, 0, "hook took no AGENT fee");
        assertEq(AgentToken(token).balanceOf(address(hook)), pendingAgent, "fee not backed by balance");

        _swap(key, agentIsCurrency0, -100_000e18);
        uint256 pendingUsdg = hook.pendingFees(poolId, address(usdg));
        assertGt(pendingUsdg, 0, "hook took no USDG fee");

        uint256 buybackBefore = usdg.balanceOf(BUYBACK);
        uint256 treasuryBefore = usdg.balanceOf(treasury);
        uint256 accruedBefore = distributor.accrued(agentId);

        hook.distribute(poolId, 0);

        uint256 leg = usdg.balanceOf(BUYBACK) - buybackBefore;
        assertGt(leg, 0, "nothing distributed");
        assertEq(usdg.balanceOf(treasury) - treasuryBefore, leg, "treasury leg");
        assertEq(distributor.accrued(agentId) - accruedBefore, leg, "royalty leg");
        assertEq(AgentToken(token).balanceOf(address(hook)), hook.pendingFees(poolId, token), "stranded AGENT");

        // royalties reach the NFT owner
        uint256 claimable = distributor.accrued(agentId);
        uint256 creatorBefore = usdg.balanceOf(creator);
        distributor.claim(agentId);
        assertEq(usdg.balanceOf(creator), creatorBefore + claimable, "royalties not paid to the NFT owner");
    }

    /// @dev Nobody but the factory can open a pool on this hook, on the live manager either.
    function test_fork_poolCreationIsFactoryGated() public onFork {
        uint256 agentId = _live();
        _buyToThreshold(agentId);
        factory.graduate(agentId);

        PoolKey memory key = _poolKeyOf(agentId);
        vm.prank(address(0xDEAD));
        vm.expectRevert();
        MANAGER.initialize(key, TickMath.getSqrtPriceAtTick(0));

        // the factory still seeds it afterwards
        factory.createGraduatedPool(agentId);
        assertGt(locker.lockedLiquidity(agentId), 0);
    }

    // -----------------------------------------------------------------------
    // M1 gate artifact — the testnet lifecycle transcript
    // -----------------------------------------------------------------------

    /// @notice The full lifecycle tail on the live PoolManager: create, register, finalize,
    ///         curve, graduate, pool swaps, distribute, royalty claim, NFT transfer, claim to
    ///         the NEW owner, burn, and the post-burn re-route of the royalty leg straight to
    ///         the agent's treasury. Every stage logs its amounts, so `-vv` output is the
    ///         milestone's testnet transcript.
    function test_fork_lifecycleTranscript() public onFork {
        console2.log("=== agent-launchpad M1 testnet lifecycle transcript ===");
        console2.log("chain id           :", block.chainid);
        console2.log("PoolManager        :", address(MANAGER));

        uint256 agentId = _live();
        console2.log("-- 1. create / register / finalize --");
        console2.log("  agentId          :", agentId);
        console2.log("  AGENT token      :", factory.tokenOf(agentId));
        console2.log("  bonding curve    :", factory.curveOf(agentId));
        console2.log("  NFT owner        :", nft.ownerOf(agentId));
        console2.log("  creation fee paid:", usdg.balanceOf(owner));

        _buyToThreshold(agentId);
        _logCurvePhase(agentId);

        factory.graduate(agentId);
        factory.createGraduatedPool(agentId);
        _logGraduation(agentId);

        _transcriptPoolPhase(agentId);
        _transcriptRoyaltyTail(agentId);

        console2.log("=== end of transcript ===");
    }

    function _logCurvePhase(uint256 agentId) internal view {
        AgentBondingCurve curve = AgentBondingCurve(factory.curveOf(agentId));
        (uint256 reserveUsdg, uint256 reserveTokens) = curve.reserves();
        console2.log("-- 2. curve phase (closed at threshold) --");
        console2.log("  real USDG reserve:", reserveUsdg);
        console2.log("  AGENT reserve/1e18:", reserveTokens / 1e18);
        console2.log("  buyback leg (1%) :", usdg.balanceOf(BUYBACK));
        console2.log("  treasury leg (1%):", usdg.balanceOf(treasury));
        console2.log("  royalty leg (1%) :", distributor.accrued(agentId));
    }

    function _logGraduation(uint256 agentId) internal view {
        address token = factory.tokenOf(agentId);
        bytes32 poolId = PoolId.unwrap(_poolKeyOf(agentId).toId());
        (uint160 sqrtPriceX96,,,) = MANAGER.getSlot0(PoolId.wrap(poolId));
        console2.log("-- 3. graduation (sweep + burn, seed + lock) --");
        console2.log("  AGENT supply/1e18:", AgentToken(token).totalSupply() / 1e18);
        console2.log("  pool sqrtPriceX96:", sqrtPriceX96);
        console2.log("  locked liquidity :", locker.lockedLiquidity(agentId));
        console2.log("  pool USDG        :", usdg.balanceOf(address(MANAGER)));
    }

    function _transcriptPoolPhase(uint256 agentId) internal {
        address token = factory.tokenOf(agentId);
        bool agentIsCurrency0 = token < address(usdg);
        PoolKey memory key = _poolKeyOf(agentId);
        bytes32 poolId = PoolId.unwrap(key.toId());

        vm.startPrank(trader);
        usdg.approve(address(swapRouter), type(uint256).max);
        AgentToken(token).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();

        _swap(key, !agentIsCurrency0, -2_000e6); // USDG in  -> AGENT-side fee
        _swap(key, agentIsCurrency0, -250_000e18); // AGENT in -> USDG-side fee

        console2.log("-- 4. pool phase (hook takes 300bps of the unspecified side) --");
        console2.log("  pending USDG fees:", hook.pendingFees(poolId, address(usdg)));
        console2.log("  pending AGENT/1e18:", hook.pendingFees(poolId, token) / 1e18);

        uint256 buybackBefore = usdg.balanceOf(BUYBACK);
        hook.distribute(poolId, 0);
        uint256 leg = usdg.balanceOf(BUYBACK) - buybackBefore;
        console2.log("-- 5. distribute (AGENT converted, split in thirds) --");
        console2.log("  leg, each of 3   :", leg);
        console2.log("  AGENT left/1e18  :", hook.pendingFees(poolId, token) / 1e18);
        console2.log("  royalty accrued  :", distributor.accrued(agentId));
    }

    function _transcriptRoyaltyTail(uint256 agentId) internal {
        address token = factory.tokenOf(agentId);
        bool agentIsCurrency0 = token < address(usdg);
        PoolKey memory key = _poolKeyOf(agentId);
        bytes32 poolId = PoolId.unwrap(key.toId());

        // 6. the NFT owner claims
        uint256 claim1 = distributor.accrued(agentId);
        uint256 creatorBefore = usdg.balanceOf(creator);
        distributor.claim(agentId);
        assertEq(usdg.balanceOf(creator), creatorBefore + claim1, "claim did not pay the NFT owner");
        console2.log("-- 6. royalty claim --");
        console2.log("  paid to creator  :", claim1);

        // 7. the NFT changes hands; the next claim follows it
        vm.prank(creator);
        nft.transferFrom(creator, secondOwner, agentId);
        assertEq(nft.ownerOf(agentId), secondOwner, "NFT transfer");

        _swap(key, !agentIsCurrency0, -1_500e6);
        vm.warp(block.timestamp + hook.DISTRIBUTE_COOLDOWN());
        hook.distribute(poolId, 0);

        uint256 claim2 = distributor.accrued(agentId);
        uint256 secondBefore = usdg.balanceOf(secondOwner);
        uint256 creatorAtTransfer = usdg.balanceOf(creator);
        distributor.claim(agentId);
        assertEq(usdg.balanceOf(secondOwner), secondBefore + claim2, "claim did not follow the NFT");
        assertEq(usdg.balanceOf(creator), creatorAtTransfer, "old owner still paid");
        console2.log("-- 7. NFT transfer, claim follows the owner --");
        console2.log("  new owner        :", secondOwner);
        console2.log("  paid to new owner:", claim2);

        _transcriptBurnAndReroute(agentId);
    }

    function _transcriptBurnAndReroute(uint256 agentId) internal {
        address token = factory.tokenOf(agentId);
        bool agentIsCurrency0 = token < address(usdg);
        PoolKey memory key = _poolKeyOf(agentId);
        bytes32 poolId = PoolId.unwrap(key.toId());

        // 8. burn -> emancipation sweeps the unclaimed accrual to the treasury
        _swap(key, agentIsCurrency0, -250_000e18);
        vm.warp(block.timestamp + hook.DISTRIBUTE_COOLDOWN());
        hook.distribute(poolId, 0);

        uint256 unclaimed = distributor.accrued(agentId);
        assertGt(unclaimed, 0, "nothing accrued to sweep on burn");
        uint256 treasuryBeforeBurn = usdg.balanceOf(treasury);
        vm.prank(secondOwner);
        nft.burn(agentId);
        assertTrue(distributor.emancipated(agentId), "not emancipated");
        assertEq(usdg.balanceOf(treasury), treasuryBeforeBurn + unclaimed, "sweep missed the treasury");
        console2.log("-- 8. burn -> Emancipated (one-way) --");
        console2.log("  swept to treasury:", unclaimed);

        // 9. every later royalty leg goes straight to the treasury EOA
        _swap(key, !agentIsCurrency0, -1_000e6);
        vm.warp(block.timestamp + hook.DISTRIBUTE_COOLDOWN());
        uint256 buybackBefore = usdg.balanceOf(BUYBACK);
        uint256 treasuryBefore = usdg.balanceOf(treasury);
        hook.distribute(poolId, 0);
        uint256 leg = usdg.balanceOf(BUYBACK) - buybackBefore;
        assertEq(usdg.balanceOf(treasury) - treasuryBefore, leg * 2, "royalty leg not re-routed to the treasury");
        assertEq(distributor.accrued(agentId), 0, "royalties still accruing after the burn");
        console2.log("-- 9. post-burn distribute (royalty leg re-routed) --");
        console2.log("  leg, each of 3   :", leg);
        console2.log("  treasury received:", leg * 2);
        console2.log("  treasury total   :", usdg.balanceOf(treasury));
        console2.log("  buyback total    :", usdg.balanceOf(BUYBACK));
    }
}
