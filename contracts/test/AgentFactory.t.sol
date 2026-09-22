// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
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
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {AgentFactory} from "../src/AgentFactory.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {AgentToken} from "../src/AgentToken.sol";
import {AgentBondingCurve} from "../src/AgentBondingCurve.sol";
import {RoyaltyDistributor} from "../src/RoyaltyDistributor.sol";
import {FeeSplitHook} from "../src/FeeSplitHook.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";
import {GraduationMath} from "../src/libraries/GraduationMath.sol";
import {IAgentFactory, IAgentBondingCurve, IFeeSplitHook, ILiquidityLocker} from "../src/interfaces/ILaunchpad.sol";
import {FactoryMockERC20, FactoryRejectingRecipient} from "./mocks/FactoryMocks.sol";

/// @notice Full-stack unit tests for AgentFactory against a local PoolManager and the real
///         registry, NFT, distributor, curve implementation, hook and locker — only USDG is a
///         mock (6 decimals) and TreasuryBuyback is a plain address, since the factory only
///         ever transfers to it.
contract AgentFactoryTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 constant HOOK_FLAGS =
        uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    uint256 constant AGENT_SUPPLY = 1_000_000_000e18;
    uint256 constant CREATION_FEE = 75e6;
    uint256 constant PHANTOM_QUOTE = 6_000e6;
    uint256 constant GRADUATION_THRESHOLD = 42_000e6;
    int24 constant TICK_SPACING = 60;

    bytes32 constant CODE_HASH = keccak256("agent-image-v1");
    string constant IMAGE_URI = "ar://metadata-txid";
    string constant ATTESTATION = "ar://attestation-txid";

    PoolManager manager;
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
    address stranger = makeAddr("stranger");
    address actionEOA = makeAddr("actionEOA");

    uint256 treasuryNonce;

    function setUp() public {
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);
        usdg = new FactoryMockERC20("Global Dollar", "USDG", 6);

        registry = new AgentRegistry();
        nft = new AgentNFT();
        distributor = new RoyaltyDistributor(address(usdg), address(nft), address(registry));

        address hookAddr = address(HOOK_FLAGS | (uint160(0xF00D) << 20));
        deployCodeTo(
            "FeeSplitHook.sol:FeeSplitHook",
            abi.encode(manager, address(usdg), address(registry), address(distributor), BUYBACK),
            hookAddr
        );
        hook = FeeSplitHook(hookAddr);

        locker = new LiquidityLocker(IPoolManager(address(manager)));

        factory = new AgentFactory(
            address(usdg),
            address(manager),
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

        usdg.mint(creator, 10_000e6);
        usdg.mint(trader, 5_000_000e6);
        vm.prank(creator);
        usdg.approve(address(factory), type(uint256).max);
    }

    // -----------------------------------------------------------------------
    // Harness
    // -----------------------------------------------------------------------

    function _nextTreasury() internal returns (address) {
        return vm.addr(uint256(keccak256(abi.encode("treasury", ++treasuryNonce))));
    }

    function _create(address expectedTreasury, uint256 ethValue) internal returns (uint256 agentId) {
        vm.deal(creator, creator.balance + ethValue);
        vm.prank(creator);
        agentId = factory.createAgent{value: ethValue}(
            "Agent One", "AG1", IMAGE_URI, keccak256("config"), creator, expectedTreasury
        );
    }

    function _register(uint256 agentId, address treasury) internal {
        vm.prank(treasury);
        registry.registerInstance(agentId, treasury, actionEOA, CODE_HASH, ATTESTATION);
    }

    /// @dev create -> register -> finalize, returning the live agent id and its treasury.
    function _liveAgent() internal returns (uint256 agentId, address treasury) {
        treasury = _nextTreasury();
        agentId = _create(treasury, 0);
        _register(agentId, treasury);
        factory.finalize(agentId);
    }

    /// @dev A live agent whose AGENT token sorts on the requested side of USDG. The token
    ///      address falls out of the factory's nonce, so this just keeps launching until the
    ///      ordering comes up; both are reached within a handful of tries.
    function _liveAgentWithOrdering(bool tokenIsCurrency0) internal returns (uint256 agentId) {
        for (uint256 i = 0; i < 40; i++) {
            (uint256 id,) = _liveAgent();
            if ((factory.tokenOf(id) < address(usdg)) == tokenIsCurrency0) return id;
        }
        revert("no agent with the requested currency ordering");
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

    function _sorted(uint256 agentId, uint256 usdgAmount, uint256 tokenAmount)
        internal
        view
        returns (uint256 amount0, uint256 amount1)
    {
        return factory.tokenOf(agentId) < address(usdg) ? (tokenAmount, usdgAmount) : (usdgAmount, tokenAmount);
    }

    function _swept(uint256 agentId) internal view returns (uint256 usdgAmount, uint256 poolTokens) {
        return factory.sweptOf(agentId);
    }

    // -----------------------------------------------------------------------
    // Wiring / constants
    // -----------------------------------------------------------------------

    function test_constants() public view {
        assertEq(factory.CREATION_FEE(), 75e6);
        assertEq(factory.PHANTOM_QUOTE(), 6_000e6);
        assertEq(factory.GRADUATION_THRESHOLD(), 42_000e6);
        assertEq(factory.GENESIS_WINDOW(), 24 hours);
        assertEq(factory.TICK_SPACING(), 60);
        assertEq(factory.POOL_FEE(), 0);
        assertEq(factory.owner(), owner);
        assertEq(factory.platformFeeRecipient(), owner);
        assertGt(factory.curveImplementation().code.length, 0);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(AgentFactory.ZeroAddress.selector);
        new AgentFactory(
            address(0),
            address(manager),
            address(registry),
            address(nft),
            address(distributor),
            address(hook),
            address(locker),
            BUYBACK,
            gasRecipient,
            owner
        );
    }

    /// @dev The cloned implementation is bricked by its own constructor.
    function test_curveImplementationIsNotInitializable() public {
        AgentBondingCurve impl = AgentBondingCurve(factory.curveImplementation());
        vm.expectRevert(AgentBondingCurve.AlreadyInitialized.selector);
        impl.initialize(1, address(usdg), address(usdg), address(registry), address(distributor), BUYBACK, 1, 1);
    }

    // -----------------------------------------------------------------------
    // createAgent
    // -----------------------------------------------------------------------

    function test_createAgent_pullsFeeForwardsEthAndOpensGenesis() public {
        address treasury = _nextTreasury();
        uint256 creatorBefore = usdg.balanceOf(creator);

        vm.expectEmit(true, false, false, true, address(factory));
        emit IAgentFactory.AgentRequested(1, keccak256("config"), creator);
        uint256 agentId = _create(treasury, 0.01 ether);

        assertEq(agentId, 1, "ids start at 1");
        assertEq(factory.agentCount(), 1);
        assertEq(usdg.balanceOf(creator), creatorBefore - CREATION_FEE, "creator not charged exactly");
        assertEq(usdg.balanceOf(address(factory)), CREATION_FEE, "fee not escrowed");
        assertEq(gasRecipient.balance, 0.01 ether, "ETH not forwarded");
        assertEq(address(factory).balance, 0, "ETH retained");

        assertEq(registry.genesisDeadline(agentId), uint64(block.timestamp + 24 hours), "deadline");
        assertEq(registry.expectedTreasuryEOA(agentId), treasury, "expected treasury not pinned");

        IAgentFactory.PendingAgent memory p = factory.pendingAgent(agentId);
        assertEq(p.creator, creator);
        assertEq(p.imageURI, IMAGE_URI);
        assertEq(p.name, "Agent One");
        assertEq(p.symbol, "AG1");
        assertEq(p.configHash, keccak256("config"));
        assertTrue(p.feePaid);

        // second request gets id 2
        assertEq(_create(_nextTreasury(), 0), 2);
    }

    function test_createAgent_zeroEthIsFine() public {
        _create(_nextTreasury(), 0);
        assertEq(gasRecipient.balance, 0);
    }

    function test_createAgent_rejectsZeroCreatorOrTreasury() public {
        vm.startPrank(creator);
        vm.expectRevert(AgentFactory.ZeroAddress.selector);
        factory.createAgent("a", "b", IMAGE_URI, bytes32(0), address(0), _nextTreasury());
        vm.expectRevert(AgentFactory.ZeroAddress.selector);
        factory.createAgent("a", "b", IMAGE_URI, bytes32(0), creator, address(0));
        vm.stopPrank();
    }

    function test_createAgent_revertsWhenGasForwardFails() public {
        FactoryRejectingRecipient bad = new FactoryRejectingRecipient();
        AgentFactory f2 = new AgentFactory(
            address(usdg),
            address(manager),
            address(registry),
            address(nft),
            address(distributor),
            address(hook),
            address(locker),
            BUYBACK,
            address(bad),
            owner
        );
        vm.startPrank(creator);
        usdg.approve(address(f2), type(uint256).max);
        vm.deal(creator, 1 ether);
        vm.expectRevert(AgentFactory.GasForwardFailed.selector);
        f2.createAgent{value: 1 wei}("a", "b", IMAGE_URI, bytes32(0), creator, _nextTreasury());
        vm.stopPrank();
    }

    function test_createAgent_pauseGate() public {
        vm.prank(owner);
        factory.pause();

        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createAgent("a", "b", IMAGE_URI, bytes32(0), creator, _nextTreasury());

        vm.prank(owner);
        factory.unpause();
        assertEq(_create(_nextTreasury(), 0), 1);
    }

    /// @dev Pausing must never trap an agent that is already in flight.
    function test_pause_doesNotBlockFinalizeCancelOrGraduate() public {
        address treasury = _nextTreasury();
        uint256 agentId = _create(treasury, 0);
        _register(agentId, treasury);

        vm.prank(owner);
        factory.pause();

        factory.finalize(agentId);
        _buyToThreshold(agentId);
        factory.graduate(agentId);
        factory.createGraduatedPool(agentId);

        // and cancel still works for a separate, unregistered agent
        vm.prank(owner);
        factory.unpause();
        uint256 other = _create(_nextTreasury(), 0);
        vm.prank(owner);
        factory.pause();
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(creator);
        factory.cancel(other);
    }

    // -----------------------------------------------------------------------
    // finalize
    // -----------------------------------------------------------------------

    function test_finalize_happyPath() public {
        address treasury = _nextTreasury();
        uint256 agentId = _create(treasury, 0);
        _register(agentId, treasury);

        vm.prank(stranger); // permissionless
        factory.finalize(agentId);

        address token = factory.tokenOf(agentId);
        address curve = factory.curveOf(agentId);
        assertTrue(token != address(0) && curve != address(0), "not deployed");

        // curve initialized with the whole supply as its token reserve
        AgentToken t = AgentToken(token);
        assertEq(t.totalSupply(), AGENT_SUPPLY, "supply");
        assertEq(t.balanceOf(curve), AGENT_SUPPLY, "supply not held by curve");
        assertEq(t.name(), "Agent One");
        assertEq(t.symbol(), "AG1");
        (uint256 realUsdg, uint256 tokenReserve) = IAgentBondingCurve(curve).reserves();
        assertEq(realUsdg, 0);
        assertEq(tokenReserve, AGENT_SUPPLY, "token reserve not seeded from balanceOf");

        AgentBondingCurve c = AgentBondingCurve(curve);
        assertEq(c.factory(), address(factory), "factory not the initializer");
        assertEq(c.agentId(), agentId);
        assertEq(c.agentToken(), token);
        assertEq(c.phantomQuote(), PHANTOM_QUOTE);
        assertEq(c.graduationThreshold(), GRADUATION_THRESHOLD);
        assertEq(c.treasuryBuyback(), BUYBACK);

        // NFT minted to the creator with the Arweave metadata URI
        assertEq(nft.ownerOf(agentId), creator, "nft owner");
        assertEq(nft.tokenURI(agentId), IMAGE_URI, "tokenURI != imageURI");

        // distributor bound to this curve
        assertEq(distributor.curveOf(agentId), curve, "curve not authorized on distributor");

        // creation fee forwarded to the platform, nothing retained
        assertEq(usdg.balanceOf(owner), CREATION_FEE, "platform fee");
        assertEq(usdg.balanceOf(address(factory)), 0, "factory retained fee");

        // pending record cleared
        assertEq(factory.pendingAgent(agentId).creator, address(0), "pending not cleared");
    }

    function test_finalize_emitsAgentLive() public {
        address treasury = _nextTreasury();
        uint256 agentId = _create(treasury, 0);
        _register(agentId, treasury);

        vm.recordLogs();
        factory.finalize(agentId);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == IAgentFactory.AgentLive.selector) {
                (address token, address curve) = abi.decode(logs[i].data, (address, address));
                assertEq(token, factory.tokenOf(agentId));
                assertEq(curve, factory.curveOf(agentId));
                found = true;
            }
        }
        assertTrue(found, "AgentLive not emitted");
    }

    function test_finalize_beforeRegistrationReverts() public {
        uint256 agentId = _create(_nextTreasury(), 0);
        vm.expectRevert(AgentFactory.NotRegistered.selector);
        factory.finalize(agentId);
    }

    function test_finalize_unknownAgentReverts() public {
        vm.expectRevert(AgentFactory.NoPendingAgent.selector);
        factory.finalize(99);
    }

    function test_finalize_twiceReverts() public {
        (uint256 agentId,) = _liveAgent();
        vm.expectRevert(AgentFactory.NoPendingAgent.selector);
        factory.finalize(agentId);
    }

    function test_finalize_usesLivePlatformFeeRecipient() public {
        address newRecipient = makeAddr("platformFees");
        vm.prank(owner);
        factory.setPlatformFeeRecipient(newRecipient);

        _liveAgent();
        assertEq(usdg.balanceOf(newRecipient), CREATION_FEE);
        assertEq(usdg.balanceOf(owner), 0);
    }

    // -----------------------------------------------------------------------
    // cancel
    // -----------------------------------------------------------------------

    function test_cancel_refundsCreatorAfterDeadline() public {
        uint256 before = usdg.balanceOf(creator);
        uint256 agentId = _create(_nextTreasury(), 0);
        vm.warp(block.timestamp + 24 hours + 1);

        vm.prank(creator);
        vm.expectEmit(true, false, false, false, address(factory));
        emit IAgentFactory.AgentCancelled(agentId);
        factory.cancel(agentId);

        assertEq(usdg.balanceOf(creator), before, "refund not exact");
        assertEq(usdg.balanceOf(address(factory)), 0);
        assertEq(factory.pendingAgent(agentId).creator, address(0));
    }

    function test_cancel_onlyCreator() public {
        uint256 agentId = _create(_nextTreasury(), 0);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(stranger);
        vm.expectRevert(AgentFactory.NotCreator.selector);
        factory.cancel(agentId);
    }

    function test_cancel_onlyAfterDeadline() public {
        uint256 agentId = _create(_nextTreasury(), 0);
        vm.prank(creator);
        vm.expectRevert(AgentFactory.GenesisStillOpen.selector);
        factory.cancel(agentId);

        // exactly at the deadline is still "open"
        vm.warp(block.timestamp + 24 hours);
        vm.prank(creator);
        vm.expectRevert(AgentFactory.GenesisStillOpen.selector);
        factory.cancel(agentId);
    }

    function test_cancel_onlyWhileUnregistered() public {
        address treasury = _nextTreasury();
        uint256 agentId = _create(treasury, 0);
        _register(agentId, treasury);
        vm.warp(block.timestamp + 24 hours + 1);

        vm.prank(creator);
        vm.expectRevert(AgentFactory.AlreadyRegistered.selector);
        factory.cancel(agentId);
    }

    function test_cancel_thenFinalizeImpossible() public {
        uint256 agentId = _create(_nextTreasury(), 0);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(creator);
        factory.cancel(agentId);

        vm.expectRevert(AgentFactory.NoPendingAgent.selector);
        factory.finalize(agentId);
    }

    function test_finalize_thenCancelImpossible() public {
        (uint256 agentId,) = _liveAgent();
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(creator);
        vm.expectRevert(AgentFactory.NoPendingAgent.selector);
        factory.cancel(agentId);
    }

    function test_cancel_twiceReverts() public {
        uint256 agentId = _create(_nextTreasury(), 0);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.startPrank(creator);
        factory.cancel(agentId);
        vm.expectRevert(AgentFactory.NoPendingAgent.selector);
        factory.cancel(agentId);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // graduate — phase 1
    // -----------------------------------------------------------------------

    function test_graduate_requiresFinalizedAndReady() public {
        uint256 unknown = 42;
        vm.expectRevert(AgentFactory.NotFinalized.selector);
        factory.graduate(unknown);

        (uint256 agentId,) = _liveAgent();
        vm.expectRevert(AgentFactory.NotReadyToGraduate.selector);
        factory.graduate(agentId);
    }

    function test_graduate_sweepsBurnsAndRecords() public {
        (uint256 agentId,) = _liveAgent();
        _buyToThreshold(agentId);

        AgentBondingCurve curve = AgentBondingCurve(factory.curveOf(agentId));
        AgentToken token = AgentToken(factory.tokenOf(agentId));
        (uint256 reserveUsdg, uint256 reserveTokens) = curve.reserves();
        uint256 expectedPoolTokens = FullMath.mulDiv(reserveTokens, reserveUsdg, reserveUsdg + PHANTOM_QUOTE);
        uint256 expectedBurn = reserveTokens - expectedPoolTokens;
        uint256 supplyBefore = token.totalSupply();

        vm.expectEmit(true, false, false, true, address(factory));
        emit IAgentFactory.AgentGraduated(agentId, reserveUsdg, expectedPoolTokens, expectedBurn);
        vm.prank(stranger); // permissionless
        factory.graduate(agentId);

        (uint256 sweptUsdg, uint256 poolTokens) = _swept(agentId);
        assertEq(sweptUsdg, reserveUsdg, "swept usdg");
        assertEq(poolTokens, expectedPoolTokens, "pool tokens formula");
        assertGt(poolTokens, 0);

        assertEq(token.totalSupply(), supplyBefore - expectedBurn, "burn not applied to supply");
        assertEq(token.balanceOf(address(factory)), expectedPoolTokens, "factory holds pool tokens");
        assertEq(usdg.balanceOf(address(factory)), reserveUsdg, "factory holds swept usdg");
        assertEq(token.balanceOf(address(curve)), 0, "curve retains tokens");
        assertEq(usdg.balanceOf(address(curve)), 0, "curve retains usdg");
        assertTrue(curve.graduated());

        // the burned share is exactly the phantom-backed fraction
        assertEq(expectedBurn, reserveTokens - FullMath.mulDiv(reserveTokens, reserveUsdg, reserveUsdg + PHANTOM_QUOTE));
        assertApproxEqRel(poolTokens, (reserveTokens * reserveUsdg) / (reserveUsdg + PHANTOM_QUOTE), 1e12);
    }

    function test_graduate_twiceReverts() public {
        (uint256 agentId,) = _liveAgent();
        _buyToThreshold(agentId);
        factory.graduate(agentId);

        vm.expectRevert(AgentFactory.AlreadySwept.selector);
        factory.graduate(agentId);
    }

    /// @dev Once the pool exists the swept state is gone, but the curve is empty and closed, so
    ///      a second sweep cannot start either.
    function test_graduate_afterPoolCreationReverts() public {
        (uint256 agentId,) = _liveAgent();
        _buyToThreshold(agentId);
        factory.graduate(agentId);
        factory.createGraduatedPool(agentId);

        vm.expectRevert(AgentFactory.NotReadyToGraduate.selector);
        factory.graduate(agentId);
    }

    function test_graduate_closesTheCurveToTrading() public {
        (uint256 agentId,) = _liveAgent();
        _buyToThreshold(agentId);
        AgentBondingCurve curve = AgentBondingCurve(factory.curveOf(agentId));

        vm.prank(trader);
        vm.expectRevert(AgentBondingCurve.CurveClosed.selector);
        curve.buy(1e6, 0, trader);
    }

    // -----------------------------------------------------------------------
    // createGraduatedPool — phase 2
    // -----------------------------------------------------------------------

    function test_createGraduatedPool_requiresSweptState() public {
        (uint256 agentId,) = _liveAgent();
        vm.expectRevert(AgentFactory.NothingSwept.selector);
        factory.createGraduatedPool(agentId);
    }

    function test_createGraduatedPool_seedsAndLocks() public {
        (uint256 agentId,) = _liveAgent();
        _buyToThreshold(agentId);
        factory.graduate(agentId);

        (uint256 sweptUsdg, uint256 poolTokens) = _swept(agentId);
        (uint256 amount0, uint256 amount1) = _sorted(agentId, sweptUsdg, poolTokens);
        uint160 expectedPrice = GraduationMath.sqrtPriceX96FromAmounts(amount0, amount1);

        vm.prank(stranger); // permissionless
        factory.createGraduatedPool(agentId);

        _assertPoolSeeded(agentId, expectedPrice, amount0, amount1);

        // swept state zeroed, factory drained of this agent's assets
        (uint256 s0, uint256 s1) = _swept(agentId);
        assertEq(s0, 0);
        assertEq(s1, 0);
        assertEq(usdg.balanceOf(address(factory)), 0, "factory retained usdg");
        assertEq(AgentToken(factory.tokenOf(agentId)).balanceOf(address(factory)), 0, "factory retained tokens");

        // retry is closed
        vm.expectRevert(AgentFactory.NothingSwept.selector);
        factory.createGraduatedPool(agentId);
    }

    function _assertPoolSeeded(uint256 agentId, uint160 expectedPrice, uint256 amount0, uint256 amount1) internal view {
        bytes32 poolId = PoolId.unwrap(_poolKeyOf(agentId).toId());

        // pool opened at the seed price
        (uint160 sqrtPriceX96,,,) = IPoolManager(address(manager)).getSlot0(PoolId.wrap(poolId));
        assertApproxEqAbs(sqrtPriceX96, expectedPrice, 1, "pool price");

        // hook knows the pool
        (address tokenAddr,, bool registered, uint256 id) = hook.poolInfo(poolId);
        assertTrue(registered, "pool not registered on the hook");
        assertEq(tokenAddr, factory.tokenOf(agentId));
        assertEq(id, agentId);

        // liquidity is in the locker's position
        uint128 liquidity = locker.lockedLiquidity(agentId);
        assertGt(liquidity, 0, "no locked liquidity");
        assertEq(IPoolManager(address(manager)).getLiquidity(PoolId.wrap(poolId)), liquidity, "pool liquidity");
        assertEq(_positionLiquidity(poolId, agentId), liquidity, "position not held by locker under salt(agentId)");
        assertEq(
            liquidity,
            LiquidityAmounts.getLiquidityForAmounts(
                sqrtPriceX96,
                TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(TICK_SPACING)),
                TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(TICK_SPACING)),
                amount0,
                amount1
            ),
            "liquidity != LiquidityAmounts on the seeded amounts"
        );
    }

    function _positionLiquidity(bytes32 poolId, uint256 agentId) internal view returns (uint128 liquidity) {
        (liquidity,,) = IPoolManager(address(manager))
            .getPositionInfo(
                PoolId.wrap(poolId),
                address(locker),
                TickMath.minUsableTick(TICK_SPACING),
                TickMath.maxUsableTick(TICK_SPACING),
                bytes32(agentId)
            );
    }

    /// @dev ORDERING (binding): `hook.registerPool` must be emitted before the PoolManager's
    ///      `Initialize`, otherwise the pool could be swapped untaxed in between.
    function test_createGraduatedPool_registersHookBeforeInitialize() public {
        (uint256 agentId,) = _liveAgent();
        _buyToThreshold(agentId);
        factory.graduate(agentId);

        vm.recordLogs();
        factory.createGraduatedPool(agentId);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 registeredAt = type(uint256).max;
        uint256 initializeAt = type(uint256).max;
        uint256 lockedAt = type(uint256).max;
        for (uint256 i = 0; i < logs.length; i++) {
            bytes32 t = logs[i].topics[0];
            if (t == IFeeSplitHook.PoolRegistered.selector && logs[i].emitter == address(hook)) registeredAt = i;
            if (t == IPoolManager.Initialize.selector && logs[i].emitter == address(manager)) initializeAt = i;
            if (t == ILiquidityLocker.Locked.selector && logs[i].emitter == address(locker)) lockedAt = i;
        }
        assertLt(registeredAt, type(uint256).max, "no PoolRegistered");
        assertLt(initializeAt, type(uint256).max, "no Initialize");
        assertLt(lockedAt, type(uint256).max, "no Locked");
        assertLt(registeredAt, initializeAt, "hook registered after pool init");
        assertLt(initializeAt, lockedAt, "liquidity locked before pool init");
    }

    /// @dev Phase two is retryable: a failure leaves the swept state intact and anyone can call
    ///      again. The locker is made to revert once to prove it.
    function test_createGraduatedPool_isRetryableAfterFailure() public {
        (uint256 agentId,) = _liveAgent();
        _buyToThreshold(agentId);
        factory.graduate(agentId);
        (uint256 sweptUsdg, uint256 poolTokens) = _swept(agentId);

        vm.mockCallRevert(address(locker), abi.encodeWithSelector(ILiquidityLocker.lock.selector), "boom");
        vm.expectRevert();
        factory.createGraduatedPool(agentId);
        vm.clearMockedCalls();

        // nothing moved: the swept state and the factory's balances are untouched
        (uint256 s0, uint256 s1) = _swept(agentId);
        assertEq(s0, sweptUsdg, "swept usdg lost");
        assertEq(s1, poolTokens, "pool tokens lost");
        assertEq(usdg.balanceOf(address(factory)), sweptUsdg, "usdg lost");
        assertEq(AgentToken(factory.tokenOf(agentId)).balanceOf(address(factory)), poolTokens, "tokens lost");
        bytes32 poolId = PoolId.unwrap(_poolKeyOf(agentId).toId());
        (,, bool registered,) = hook.poolInfo(poolId);
        assertFalse(registered, "hook registration survived the revert");

        // and the retry succeeds
        vm.prank(stranger);
        factory.createGraduatedPool(agentId);
        assertGt(locker.lockedLiquidity(agentId), 0);
    }

    function test_createGraduatedPool_bothCurrencyOrderings() public {
        uint256 tokenIsC0 = _liveAgentWithOrdering(true);
        uint256 tokenIsC1 = _liveAgentWithOrdering(false);

        uint256[2] memory ids = [tokenIsC0, tokenIsC1];
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 agentId = ids[i];
            _buyToThreshold(agentId);
            factory.graduate(agentId);
            (uint256 sweptUsdg, uint256 poolTokens) = _swept(agentId);
            (uint256 amount0, uint256 amount1) = _sorted(agentId, sweptUsdg, poolTokens);
            uint160 expected = GraduationMath.sqrtPriceX96FromAmounts(amount0, amount1);

            factory.createGraduatedPool(agentId);

            PoolKey memory key = _poolKeyOf(agentId);
            (uint160 sqrtPriceX96,,,) = IPoolManager(address(manager)).getSlot0(key.toId());
            assertApproxEqAbs(sqrtPriceX96, expected, 1, "price for this ordering");
            assertGt(locker.lockedLiquidity(agentId), 0);
            (, bool agentIsCurrency0,,) = hook.poolInfo(PoolId.unwrap(key.toId()));
            assertEq(agentIsCurrency0, factory.tokenOf(agentId) < address(usdg), "ordering recorded wrong");
        }
    }

    // -----------------------------------------------------------------------
    // Full local lifecycle
    // -----------------------------------------------------------------------

    /// @dev create -> register -> finalize -> buys -> graduate -> pool -> swap -> hook fee.
    function test_lifecycle_endToEnd() public {
        address treasury = _nextTreasury();
        uint256 agentId = _create(treasury, 0.005 ether);
        _register(agentId, treasury);
        factory.finalize(agentId);
        _buyToThreshold(agentId);

        // the curve already paid its three fee legs while trading
        assertGt(usdg.balanceOf(BUYBACK), 0, "buyback leg never paid");
        assertGt(usdg.balanceOf(treasury), 0, "treasury leg never paid");
        assertGt(distributor.accrued(agentId), 0, "royalty leg never accrued");

        factory.graduate(agentId);
        factory.createGraduatedPool(agentId);

        PoolKey memory key = _poolKeyOf(agentId);
        bytes32 poolId = PoolId.unwrap(key.toId());
        address token = factory.tokenOf(agentId);
        bool agentIsCurrency0 = token < address(usdg);

        // swap USDG -> AGENT on the graduated pool; the hook must take its cut
        vm.startPrank(trader);
        usdg.approve(address(swapRouter), type(uint256).max);
        AgentToken(token).approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: !agentIsCurrency0,
                amountSpecified: -1_000e6,
                sqrtPriceLimitX96: !agentIsCurrency0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        uint256 pendingAgent = hook.pendingFees(poolId, token);
        assertGt(pendingAgent, 0, "hook took no fee on the graduated pool");
        assertEq(AgentToken(token).balanceOf(address(hook)), pendingAgent, "fee not backed by balance");

        // and the fee splits three ways out of the pool phase too
        uint256 buybackBefore = usdg.balanceOf(BUYBACK);
        uint256 treasuryBefore = usdg.balanceOf(treasury);
        uint256 accruedBefore = distributor.accrued(agentId);
        hook.distribute(poolId, 0);

        uint256 leg = usdg.balanceOf(BUYBACK) - buybackBefore;
        assertGt(leg, 0, "nothing distributed");
        assertEq(usdg.balanceOf(treasury) - treasuryBefore, leg, "treasury leg");
        assertEq(distributor.accrued(agentId) - accruedBefore, leg, "royalty leg");

        // the NFT owner can claim the royalties
        uint256 claimable = distributor.accrued(agentId);
        uint256 creatorBefore = usdg.balanceOf(creator);
        distributor.claim(agentId);
        assertEq(usdg.balanceOf(creator), creatorBefore + claimable, "royalties not paid to the NFT owner");
    }

    // -----------------------------------------------------------------------
    // Owner surface
    // -----------------------------------------------------------------------

    function test_onlyOwnerFunctions() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.unpause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        factory.setPlatformFeeRecipient(stranger);
        vm.stopPrank();
    }

    function test_setPlatformFeeRecipient_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(AgentFactory.ZeroAddress.selector);
        factory.setPlatformFeeRecipient(address(0));
    }

    function test_renounceOwnershipDisabled() public {
        vm.prank(owner);
        vm.expectRevert(AgentFactory.RenounceDisabled.selector);
        factory.renounceOwnership();
        assertEq(factory.owner(), owner);
    }

    function test_ownershipTransferIsTwoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        factory.transferOwnership(newOwner);
        assertEq(factory.owner(), owner, "transfer took effect immediately");
        assertEq(factory.pendingOwner(), newOwner);

        vm.prank(newOwner);
        factory.acceptOwnership();
        assertEq(factory.owner(), newOwner);
    }
}
