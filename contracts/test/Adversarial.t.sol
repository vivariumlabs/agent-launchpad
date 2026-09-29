// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

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
import {FloorVault} from "../src/FloorVault.sol";
import {IAgentFactory, IFeeSplitHook, IFloorVault} from "../src/interfaces/ILaunchpad.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MockPlatformToken} from "../script/support/MockPlatformToken.sol";
import {FloorHostileRedeemer} from "./mocks/FloorVaultMocks.sol";
import {LifecycleNotifyingUSDG, LifecycleHostileTreasury, LifecycleDoubleDistributor} from "./mocks/LifecycleMocks.sol";

/// @notice M1 gate suite (b): hostile ordering against the live system. Attacker EOAs and
///         attacker contracts call every entrypoint out of order, directly, twice, at cooldown
///         edges, and re-entrantly. The bar for every case is the same — no contract loses
///         funds and no contract locks up: the attack reverts and the honest path still
///         completes afterwards.
///
/// @dev Two deliberate escalations over production reality, so the guards are actually
///      exercised rather than assumed:
///
///      * USDG here is `LifecycleNotifyingUSDG`, which calls back into armed recipients on
///        receipt. The real USDG has no transfer hooks; without one, the reentrancy paths
///        through a fee leg are unreachable and untestable.
///      * The agent treasury is a contract (`LifecycleHostileTreasury`) that registers itself
///        with the registry. In production it is a KMS-derived EOA, but nothing on-chain
///        forbids a contract, so the case is tested.
contract AdversarialTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 constant HOOK_FLAGS =
        uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    uint256 constant CREATION_FEE = 75e6;
    uint256 constant PHANTOM_QUOTE = 6_000e6;
    uint256 constant GRADUATION_THRESHOLD = 42_000e6;
    uint256 constant TOTAL_FEE_BPS = 300;
    uint256 constant BASIS_POINTS = 10_000;
    uint256 constant DISTRIBUTE_COOLDOWN = 1 hours;
    uint64 constant GENESIS_WINDOW = 24 hours;
    int24 constant TICK_SPACING = 60;

    uint256 constant PLATFORM_SUPPLY = 1_000_000_000e18;

    bytes32 constant CODE_HASH = keccak256("agent-image-v1");
    string constant IMAGE_URI = "ar://metadata-txid";
    string constant ATTESTATION = "ar://attestation";

    PoolManager manager;
    PoolSwapTest swapRouter;

    LifecycleNotifyingUSDG usdg;
    MockPlatformToken platformToken;
    AgentRegistry registry;
    AgentNFT nft;
    RoyaltyDistributor distributor;
    FeeSplitHook hook;
    LiquidityLocker locker;
    FloorVault vault;
    AgentFactory factory;

    address owner = makeAddr("platformMultisig");
    address gasRecipient = makeAddr("gasRecipient");
    address creator = makeAddr("creator");
    address trader = makeAddr("trader");
    address attacker = makeAddr("attacker");
    address actionEOA = makeAddr("actionEOA");
    address treasuryEOA = makeAddr("treasuryEOA");
    /// @dev Honest `$TOKEN` holder: starts with the whole platform-token supply.
    address holder = makeAddr("platformHolder");

    LifecycleHostileTreasury hostile;

    function setUp() public {
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);

        usdg = new LifecycleNotifyingUSDG();
        platformToken = new MockPlatformToken(holder);
        vault = new FloorVault(address(usdg), address(platformToken));

        registry = new AgentRegistry();
        nft = new AgentNFT();
        distributor = new RoyaltyDistributor(address(usdg), address(nft), address(registry));

        address hookAddr = address(HOOK_FLAGS | (uint160(0xADAD) << 20));
        deployCodeTo(
            "FeeSplitHook.sol:FeeSplitHook",
            abi.encode(manager, address(usdg), address(registry), address(distributor), address(vault)),
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
            address(vault),
            1,
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

        hostile = new LifecycleHostileTreasury();

        usdg.mint(creator, 10_000e6);
        usdg.mint(trader, 5_000_000e6);
        usdg.mint(attacker, 5_000_000e6);

        vm.prank(creator);
        usdg.approve(address(factory), type(uint256).max);
    }

    // =======================================================================
    // Harness
    // =======================================================================

    function _create(address expectedTreasury) internal returns (uint256 agentId) {
        vm.prank(creator);
        agentId = factory.createAgent("Agent", "AGT", IMAGE_URI, keccak256("cfg"), creator, expectedTreasury);
    }

    function _live(address treasury) internal returns (uint256 agentId) {
        agentId = _create(treasury);
        vm.prank(treasury);
        registry.registerInstance(agentId, treasury, actionEOA, CODE_HASH, ATTESTATION);
        factory.finalize(agentId);
    }

    function _liveWithHostileTreasury() internal returns (uint256 agentId) {
        agentId = _create(address(hostile));
        hostile.register(address(registry), agentId, actionEOA, CODE_HASH, ATTESTATION);
        factory.finalize(agentId);
        usdg.setNotify(address(hostile), true);
    }

    function _curve(uint256 agentId) internal view returns (AgentBondingCurve) {
        return AgentBondingCurve(factory.curveOf(agentId));
    }

    function _buy(uint256 agentId, address who, uint256 usdgIn) internal {
        AgentBondingCurve c = _curve(agentId);
        vm.startPrank(who);
        usdg.approve(address(c), usdgIn);
        c.buy(usdgIn, 0, who);
        vm.stopPrank();
    }

    function _buyToThreshold(uint256 agentId) internal {
        AgentBondingCurve c = _curve(agentId);
        while (!c.readyToGraduate()) {
            _buy(agentId, trader, 5_000e6);
        }
    }

    /// @dev Buys up to, but not through, the graduation threshold, so the caller can arm an
    ///      attack on the exact trade that crosses it.
    function _buyToOneTradeBeforeThreshold(uint256 agentId, uint256 step) internal {
        AgentBondingCurve c = _curve(agentId);
        uint256 net = step - (step * TOTAL_FEE_BPS) / BASIS_POINTS;
        while (true) {
            (uint256 reserve,) = c.reserves();
            if (reserve + net >= GRADUATION_THRESHOLD) break;
            _buy(agentId, trader, step);
        }
    }

    function _graduated(uint256 agentId) internal returns (PoolKey memory key, bytes32 poolId) {
        factory.graduate(agentId);
        factory.createGraduatedPool(agentId);
        key = factory.poolKeyOf(agentId);
        poolId = PoolId.unwrap(key.toId());
    }

    function _poolSwapUsdgIn(uint256 agentId, address who, uint256 amountIn) internal {
        PoolKey memory key = factory.poolKeyOf(agentId);
        bool agentIsCurrency0 = factory.tokenOf(agentId) < address(usdg);
        bool zeroForOne = !agentIsCurrency0;
        vm.startPrank(who);
        usdg.approve(address(swapRouter), type(uint256).max);
        AgentToken(factory.tokenOf(agentId)).approve(address(swapRouter), type(uint256).max);
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    function _readConverted() internal view returns (uint256 converted) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == IFeeSplitHook.Distributed.selector && logs[i].emitter == address(hook)) {
                (,,, converted) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                return converted;
            }
        }
        revert("no Distributed event");
    }

    function _selector(bytes memory data) internal pure returns (bytes4 sel) {
        require(data.length >= 4, "no selector in revert data");
        sel = bytes4(bytes.concat(data[0], data[1], data[2], data[3]));
    }

    // =======================================================================
    // 1 — creation / finalize / cancel, out of order
    // =======================================================================

    function test_attacker_finalizeBeforeRegistrationReverts() public {
        uint256 agentId = _create(treasuryEOA);
        vm.prank(attacker);
        vm.expectRevert(AgentFactory.NotRegistered.selector);
        factory.finalize(agentId);

        // and the honest path still completes afterwards
        vm.prank(treasuryEOA);
        registry.registerInstance(agentId, treasuryEOA, actionEOA, CODE_HASH, ATTESTATION);
        vm.prank(attacker); // permissionless — the attacker may pay the gas, it changes nothing
        factory.finalize(agentId);
        assertEq(nft.ownerOf(agentId), creator, "NFT still goes to the creator");
    }

    /// @dev The genesis front-run: an attacker registering their own EOA inside the window.
    function test_attacker_registersNonPredictedEOA_thenRealEnclaveSucceeds() public {
        uint256 agentId = _create(treasuryEOA);

        vm.prank(attacker);
        vm.expectRevert(AgentRegistry.UnexpectedTreasury.selector);
        registry.registerInstance(agentId, attacker, actionEOA, CODE_HASH, ATTESTATION);

        // An attacker cannot register *for* the enclave's address either: possession is proven
        // by msg.sender.
        vm.prank(attacker);
        vm.expectRevert(AgentRegistry.NotTreasury.selector);
        registry.registerInstance(agentId, treasuryEOA, actionEOA, CODE_HASH, ATTESTATION);

        // The real enclave registers unimpeded.
        vm.prank(treasuryEOA);
        registry.registerInstance(agentId, treasuryEOA, actionEOA, CODE_HASH, ATTESTATION);
        assertEq(registry.treasuryOf(agentId), treasuryEOA, "treasury hijacked");
        assertEq(registry.instanceOf(agentId).generation, 1);

        factory.finalize(agentId);
        _buy(agentId, trader, 1_000e6);
        assertGt(usdg.balanceOf(treasuryEOA), 0, "fee stream not reaching the real enclave");
    }

    function test_attacker_registerAfterGenesisClosedReverts() public {
        uint256 agentId = _create(treasuryEOA);
        vm.warp(block.timestamp + GENESIS_WINDOW + 1);
        vm.prank(treasuryEOA);
        vm.expectRevert(AgentRegistry.GenesisClosed.selector);
        registry.registerInstance(agentId, treasuryEOA, actionEOA, CODE_HASH, ATTESTATION);
    }

    function test_creatorCancels_thenAttackerFinalizeReverts() public {
        uint256 agentId = _create(treasuryEOA);
        vm.warp(block.timestamp + GENESIS_WINDOW + 1);

        uint256 creatorBefore = usdg.balanceOf(creator);
        vm.prank(creator);
        factory.cancel(agentId);
        assertEq(usdg.balanceOf(creator), creatorBefore + CREATION_FEE, "refund not exact");

        vm.prank(attacker);
        vm.expectRevert(AgentFactory.NoPendingAgent.selector);
        factory.finalize(agentId);

        // and the refund cannot be taken twice
        vm.prank(creator);
        vm.expectRevert(AgentFactory.NoPendingAgent.selector);
        factory.cancel(agentId);
        assertEq(usdg.balanceOf(address(factory)), 0, "factory left holding money");
    }

    function test_attacker_cancelsSomeoneElsesPendingReverts() public {
        uint256 agentId = _create(treasuryEOA);
        vm.warp(block.timestamp + GENESIS_WINDOW + 1);

        vm.prank(attacker);
        vm.expectRevert(AgentFactory.NotCreator.selector);
        factory.cancel(agentId);

        // the real creator still can
        vm.prank(creator);
        factory.cancel(agentId);
    }

    /// @dev Cancelling out from under a registered enclave would strand a live agent.
    function test_cancelAfterRegistrationReverts() public {
        uint256 agentId = _create(treasuryEOA);
        vm.prank(treasuryEOA);
        registry.registerInstance(agentId, treasuryEOA, actionEOA, CODE_HASH, ATTESTATION);
        vm.warp(block.timestamp + GENESIS_WINDOW + 1);

        vm.prank(creator);
        vm.expectRevert(AgentFactory.AlreadyRegistered.selector);
        factory.cancel(agentId);

        factory.finalize(agentId);
        assertTrue(factory.curveOf(agentId) != address(0), "agent not live");
    }

    // =======================================================================
    // 2 — graduation, out of order
    // =======================================================================

    function test_attacker_graduatePreThresholdReverts() public {
        uint256 agentId = _live(treasuryEOA);
        _buy(agentId, trader, 5_000e6);

        vm.prank(attacker);
        vm.expectRevert(AgentFactory.NotReadyToGraduate.selector);
        factory.graduate(agentId);

        vm.prank(attacker);
        vm.expectRevert(AgentFactory.NothingSwept.selector);
        factory.createGraduatedPool(agentId);
    }

    function test_attacker_doubleGraduateReverts() public {
        uint256 agentId = _live(treasuryEOA);
        _buyToThreshold(agentId);

        AgentBondingCurve c = _curve(agentId);

        vm.prank(attacker);
        factory.graduate(agentId);
        vm.prank(attacker);
        vm.expectRevert(AgentFactory.AlreadySwept.selector);
        factory.graduate(agentId);

        // and directly on the curve, which is where the money actually is
        vm.prank(attacker);
        vm.expectRevert(AgentBondingCurve.NotFactory.selector);
        c.graduate(attacker);
    }

    function test_attacker_curveGraduateDirectlyReverts() public {
        uint256 agentId = _live(treasuryEOA);
        _buyToThreshold(agentId);
        AgentBondingCurve c = _curve(agentId);
        (uint256 reserveBefore,) = c.reserves();

        vm.prank(attacker);
        vm.expectRevert(AgentBondingCurve.NotFactory.selector);
        c.graduate(attacker);

        (uint256 reserveAfter,) = c.reserves();
        assertEq(reserveAfter, reserveBefore, "reserve moved");
        assertEq(usdg.balanceOf(attacker), 5_000_000e6, "attacker gained USDG");
    }

    function test_attacker_doubleCreateGraduatedPoolReverts() public {
        uint256 agentId = _live(treasuryEOA);
        _buyToThreshold(agentId);
        factory.graduate(agentId);

        vm.prank(attacker);
        factory.createGraduatedPool(agentId);
        vm.prank(attacker);
        vm.expectRevert(AgentFactory.NothingSwept.selector);
        factory.createGraduatedPool(agentId);
    }

    /// @dev The window between the two graduation phases: the pool does not exist yet, so
    ///      `distribute` must bounce cleanly and leave phase 2 able to run.
    function test_distributeBetweenGraduationPhases_revertsCleanly() public {
        uint256 agentId = _live(treasuryEOA);
        _buyToThreshold(agentId);
        factory.graduate(agentId);

        (uint256 sweptUsdg, uint256 poolTokens) = factory.sweptOf(agentId);
        bytes32 poolId = PoolId.unwrap(factory.poolKeyOf(agentId).toId());

        vm.prank(attacker);
        vm.expectRevert(FeeSplitHook.UnknownPool.selector);
        hook.distribute(poolId, 0);

        // Nothing moved: the swept state and the factory's balances survive untouched.
        (uint256 s0, uint256 s1) = factory.sweptOf(agentId);
        assertEq(s0, sweptUsdg, "swept usdg lost");
        assertEq(s1, poolTokens, "pool tokens lost");
        assertEq(usdg.balanceOf(address(factory)), sweptUsdg, "factory usdg lost");
        assertEq(AgentToken(factory.tokenOf(agentId)).balanceOf(address(factory)), poolTokens, "factory tokens lost");

        // and phase 2 still succeeds
        vm.prank(attacker);
        factory.createGraduatedPool(agentId);
        assertGt(locker.lockedLiquidity(agentId), 0, "phase 2 blocked by the failed distribute");
        assertEq(usdg.balanceOf(address(factory)), 0, "factory retained usdg");
    }

    /// @dev A pool that exists but has never been swapped has nothing to distribute; a caller
    ///      must not be able to burn the cooldown on an empty call.
    function test_distributeWithNothingPendingReverts() public {
        uint256 agentId = _live(treasuryEOA);
        _buyToThreshold(agentId);
        (, bytes32 poolId) = _graduated(agentId);

        vm.prank(attacker);
        vm.expectRevert(FeeSplitHook.NothingPending.selector);
        hook.distribute(poolId, 0);
        assertEq(hook.lastDistribute(poolId), 0, "cooldown burned by an empty call");
    }

    // =======================================================================
    // 3 — direct calls to privileged entrypoints
    // =======================================================================

    function test_attacker_privilegedEntrypointsAllRevert() public {
        uint256 agentId = _live(treasuryEOA);
        _buyToThreshold(agentId);
        (PoolKey memory key,) = _graduated(agentId);
        address token = factory.tokenOf(agentId);
        AgentBondingCurve impl = AgentBondingCurve(factory.curveImplementation());

        vm.startPrank(attacker);

        vm.expectRevert(LiquidityLocker.NotFactory.selector);
        locker.lock(agentId, key, 1, 1);

        vm.expectRevert(FeeSplitHook.NotFactory.selector);
        hook.registerPool(key, agentId, token);

        vm.expectRevert(RoyaltyDistributor.NotFactory.selector);
        distributor.setCurve(agentId, attacker);

        vm.expectRevert(RoyaltyDistributor.NotAuthorized.selector);
        distributor.credit(agentId, 1);

        vm.expectRevert(RoyaltyDistributor.NotAgentNFT.selector);
        distributor.onBurn(agentId);

        vm.expectRevert(AgentRegistry.NotFactory.selector);
        registry.openGenesis(99, uint64(block.timestamp + 1 days), attacker);

        vm.expectRevert(AgentRegistry.NotTreasury.selector);
        registry.heartbeat(agentId);

        vm.expectRevert(AgentNFT.NotFactory.selector);
        nft.mint(attacker, 99, "ar://stolen");

        vm.expectRevert(AgentNFT.NotTokenOwner.selector);
        nft.burn(agentId);

        vm.expectRevert(AgentBondingCurve.AlreadyInitialized.selector);
        impl.initialize(1, token, address(usdg), address(registry), address(distributor), address(vault), 1, 1);

        vm.expectRevert(FeeSplitHook.NotPoolManager.selector);
        hook.unlockCallback("");

        vm.expectRevert(LiquidityLocker.NotPoolManager.selector);
        locker.unlockCallback("");

        vm.expectRevert(FeeSplitHook.NotDeployer.selector);
        hook.setFactory(attacker);

        vm.expectRevert(LiquidityLocker.NotDeployer.selector);
        locker.setFactory(attacker);

        vm.expectRevert(AgentRegistry.NotDeployer.selector);
        registry.setFactory(attacker);

        vm.expectRevert(RoyaltyDistributor.NotDeployer.selector);
        distributor.setFactory(attacker);

        vm.expectRevert(RoyaltyDistributor.NotDeployer.selector);
        distributor.setHook(attacker);

        vm.expectRevert(AgentNFT.NotDeployer.selector);
        nft.setFactory(attacker);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        factory.pause();

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        factory.setPlatformFeeRecipient(attacker);

        vm.stopPrank();

        // The floor vault has no privileged surface at all: no owner, no withdrawal, no sweep.
        (bool ok,) = address(vault).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "floor vault exposes owner()");
        (ok,) = address(vault).call(abi.encodeWithSignature("withdraw(uint256)", 1));
        assertFalse(ok, "floor vault exposes withdraw()");

        // Even the deployer cannot rewire anything a second time.
        vm.expectRevert(FeeSplitHook.AlreadySet.selector);
        hook.setFactory(attacker);
        vm.expectRevert(LiquidityLocker.AlreadySet.selector);
        locker.setFactory(attacker);
        vm.expectRevert(AgentRegistry.AlreadySet.selector);
        registry.setFactory(attacker);
    }

    /// @dev Opening an agent pool without going through the factory would give an untaxed pool.
    function test_attacker_cannotOpenAgentPoolDirectly() public {
        uint256 agentId = _live(treasuryEOA);
        _buyToThreshold(agentId);
        factory.graduate(agentId);

        PoolKey memory key = factory.poolKeyOf(agentId);
        vm.prank(attacker);
        vm.expectRevert();
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));

        factory.createGraduatedPool(agentId);
        assertGt(locker.lockedLiquidity(agentId), 0);
    }

    // =======================================================================
    // 4 — cooldown-edge spam
    // =======================================================================

    function test_distributeSpamAtCooldownBoundary() public {
        uint256 agentId = _live(treasuryEOA);
        _buyToThreshold(agentId);
        (, bytes32 poolId) = _graduated(agentId);
        _poolSwapUsdgIn(agentId, trader, 2_000e6);

        vm.prank(attacker);
        hook.distribute(poolId, 0);
        uint256 t0 = block.timestamp;
        assertEq(hook.lastDistribute(poolId), t0);

        _poolSwapUsdgIn(agentId, trader, 2_000e6);

        vm.prank(attacker);
        vm.expectRevert(FeeSplitHook.CooldownActive.selector);
        hook.distribute(poolId, 0);

        vm.warp(t0 + DISTRIBUTE_COOLDOWN - 1);
        vm.prank(attacker);
        vm.expectRevert(FeeSplitHook.CooldownActive.selector);
        hook.distribute(poolId, 0);

        vm.warp(t0 + DISTRIBUTE_COOLDOWN);
        uint256 vaultBefore = usdg.balanceOf(address(vault));
        vm.prank(attacker);
        hook.distribute(poolId, 0);
        assertGt(usdg.balanceOf(address(vault)), vaultBefore, "boundary call did not distribute");
    }

    /// @dev Two `distribute` calls inside one transaction — the atomic version of the same spam.
    function test_doubleDistributeInOneTransactionReverts() public {
        uint256 agentId = _live(treasuryEOA);
        _buyToThreshold(agentId);
        (, bytes32 poolId) = _graduated(agentId);
        _poolSwapUsdgIn(agentId, trader, 2_000e6);

        LifecycleDoubleDistributor spam = new LifecycleDoubleDistributor(IFeeSplitHook(address(hook)));
        vm.expectRevert(FeeSplitHook.CooldownActive.selector);
        spam.doubleDistribute(poolId);

        // nothing consumed: the whole transaction rolled back, so a single call still works
        spam.singleDistribute(poolId);
        assertEq(hook.lastDistribute(poolId), block.timestamp);
    }

    // =======================================================================
    // 4b — floor vault (D18): hostile redeem / burnStray orderings
    // =======================================================================

    function _floorState() internal view returns (uint256 b, uint256 s) {
        b = usdg.balanceOf(address(vault));
        s = platformToken.totalSupply();
    }

    /// @dev Floor comparison by cross multiplication, never via the rounded `floorPrice`.
    function _assertFloorNotLower(uint256 b0, uint256 s0, string memory stage) internal view {
        (uint256 b1, uint256 s1) = _floorState();
        if (s1 == 0) return;
        assertGe(b1 * s0, b0 * s1, string.concat(stage, ": floor fell"));
    }

    /// @dev A redeem with the pro-rata payout, the exact receipt and the floor all asserted.
    function _redeemChecked(address who, uint256 amount) internal returns (uint256 paid) {
        (uint256 b0, uint256 s0) = _floorState();
        uint256 whoBefore = usdg.balanceOf(who);
        vm.startPrank(who);
        platformToken.approve(address(vault), amount);
        paid = vault.redeem(amount);
        vm.stopPrank();
        assertEq(paid, FullMath.mulDiv(amount, b0, s0), "payout != pro rata");
        assertEq(usdg.balanceOf(who) - whoBefore, paid, "redeemer not paid exactly");
        assertEq(platformToken.totalSupply(), s0 - amount, "tokens not burned");
        _assertFloorNotLower(b0, s0, "redeem");
    }

    /// @notice An attacker holding 30% of `$TOKEN` redeems in slices interleaved with every
    ///         hostile ordering of `distribute`, `registerInstance`, `finalize` and `cancel`,
    ///         plus a stray send + `burnStray`. Every slice is paid exactly pro rata, the floor
    ///         never falls at any step, and the attacker's total take is bounded by its
    ///         tokens' worth at the final floor.
    function test_floor_hostileRedeemOrderingsAcrossLifecycle() public {
        vm.prank(holder);
        platformToken.transfer(attacker, (PLATFORM_SUPPLY * 3) / 10);
        uint256 stack = platformToken.balanceOf(attacker);
        floorSlice = stack / 10;

        uint256 agentId = _live(treasuryEOA);

        // Empty vault: nothing to take, nothing consumed.
        vm.startPrank(attacker);
        platformToken.approve(address(vault), stack);
        vm.expectRevert(FloorVault.ZeroPayout.selector);
        vault.redeem(stack);
        vm.stopPrank();
        assertEq(platformToken.balanceOf(attacker), stack, "tokens consumed by a failed redeem");

        // Curve phase funds the vault through the platform leg.
        _buyToThreshold(agentId);
        (floorFirstB, floorFirstS) = _floorState();
        assertGt(floorFirstB, 0, "curve platform leg never reached the vault");
        _attackerRedeemSlice();

        // Pool phase: redeem on both sides of a distribute.
        (, bytes32 poolId) = _graduated(agentId);
        _poolSwapUsdgIn(agentId, trader, 2_000e6);
        _attackerRedeemSlice();
        (uint256 b0, uint256 s0) = _floorState();
        vm.prank(attacker);
        hook.distribute(poolId, 0);
        _assertFloorNotLower(b0, s0, "distribute");
        assertGt(usdg.balanceOf(address(vault)), b0, "pool platform leg never reached the vault");
        _attackerRedeemSlice();

        _floorSecondAgentOrderings();
        _floorStrayOrdering();

        // The attacker exits completely.
        floorExtracted += _redeemChecked(attacker, platformToken.balanceOf(attacker));
        floorRedeemedTokens += stack - floorSlice; // everything but the stray slice
        assertEq(platformToken.balanceOf(attacker), 0);

        // Bounded by the tokens' worth at the final floor: extracted * S <= redeemed * B.
        (uint256 bEnd, uint256 sEnd) = _floorState();
        assertLe(floorExtracted * sEnd, floorRedeemedTokens * bEnd, "attacker beat pro rata");
        assertEq(usdg.balanceOf(attacker), 5_000_000e6 + floorExtracted, "attacker USDG != start + redemptions");
        assertEq(vault.totalRedeemedUsdg(), floorExtracted, "totalRedeemedUsdg");

        // The honest holder is never worse off than at the first funded floor.
        uint256 hb = platformToken.balanceOf(holder);
        assertGe(vault.quoteRedeem(hb), FullMath.mulDiv(hb, floorFirstB, floorFirstS), "honest holder's floor fell");
    }

    uint256 internal floorSlice;
    uint256 internal floorExtracted;
    uint256 internal floorRedeemedTokens;
    uint256 internal floorFirstB;
    uint256 internal floorFirstS;

    /// @dev Redeems one slice for the attacker (bookkeeping only; the checks live in
    ///      `_redeemChecked`). The final exit accounts for the slices by subtraction.
    function _attackerRedeemSlice() internal {
        floorExtracted += _redeemChecked(attacker, floorSlice);
    }

    /// @dev A second agent redeemed around (create, registerInstance, finalize) and a third
    ///      that times out, redeemed around `cancel`.
    function _floorSecondAgentOrderings() internal {
        address t2 = makeAddr("treasury2");
        uint256 second = _create(t2);
        _attackerRedeemSlice();
        vm.prank(t2);
        registry.registerInstance(second, t2, actionEOA, CODE_HASH, ATTESTATION);
        _attackerRedeemSlice();
        (uint256 b0, uint256 s0) = _floorState();
        factory.finalize(second);
        _buy(second, trader, 3_000e6);
        _assertFloorNotLower(b0, s0, "finalize + curve trade");

        uint256 third = _create(makeAddr("treasury3"));
        vm.warp(block.timestamp + GENESIS_WINDOW + 1);
        _attackerRedeemSlice();
        (b0, s0) = _floorState();
        vm.prank(creator);
        factory.cancel(third);
        _assertFloorNotLower(b0, s0, "cancel");
    }

    /// @dev Stray tokens sent to the vault leave B/S unchanged; burning them only raises it.
    function _floorStrayOrdering() internal {
        vm.prank(attacker);
        platformToken.transfer(address(vault), floorSlice);
        (uint256 b0, uint256 s0) = _floorState();
        uint256 burnedBefore = vault.totalBurned();
        vm.prank(attacker);
        assertEq(vault.burnStray(), floorSlice, "stray amount");
        (uint256 b1, uint256 s1) = _floorState();
        assertEq(s1, s0 - floorSlice, "stray not burned");
        assertGt(b1 * s0, b0 * s1, "burnStray did not raise the floor");
        assertEq(vault.totalBurned(), burnedBefore, "stray counted as redeemed");
    }

    /// @notice Splitting a redemption can never extract more than redeeming the same amount in
    ///         one call: rounding dust from the first slice stays with every remaining holder.
    function testFuzz_floor_splitRedeemNeverBeatsOneShot(uint256 total, uint256 first) public {
        uint256 agentId = _live(treasuryEOA);
        _buy(agentId, trader, 20_000e6);
        vm.prank(attacker);
        usdg.transfer(address(vault), 12_345_677); // odd donation to exercise rounding

        FloorHostileRedeemer r = new FloorHostileRedeemer(IFloorVault(address(vault)), address(platformToken));
        vm.prank(holder);
        platformToken.transfer(address(r), PLATFORM_SUPPLY / 2);

        total = bound(total, 2e22, PLATFORM_SUPPLY / 2);
        first = bound(first, 1e22, total - 1e22);

        uint256 snap = vm.snapshotState();
        uint256 oneShot = r.redeem(total);
        vm.revertToState(snap);
        uint256 split = r.redeemTwice(first, total - first);

        assertLe(split, oneShot, "split redeem beat the one-shot payout");
        assertEq(vault.totalBurned(), total);
    }

    /// @notice A redeemer contract re-enters `redeem` and `burnStray` the moment its USDG
    ///         payout lands: both reentries bounce on the guard and the outer redeem pays
    ///         exactly once.
    function test_floor_hostileRedeemerReentersOnPayout() public {
        uint256 agentId = _live(treasuryEOA);
        _buyToThreshold(agentId);

        FloorHostileRedeemer r = new FloorHostileRedeemer(IFloorVault(address(vault)), address(platformToken));
        vm.prank(holder);
        platformToken.transfer(address(r), PLATFORM_SUPPLY / 4);
        usdg.setNotify(address(r), true);

        uint256 amount = PLATFORM_SUPPLY / 10;
        (uint256 b0, uint256 s0) = _floorState();
        uint256 expected = FullMath.mulDiv(amount, b0, s0);

        r.armOnce(address(vault), abi.encodeCall(IFloorVault.redeem, (amount)));
        uint256 paid = r.redeem(amount);

        assertEq(r.attempts(), 1, "reentry never attempted");
        assertEq(r.succeeded(), 0, "reentrant redeem succeeded");
        assertEq(_selector(r.lastRevertData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "wrong revert");
        assertEq(paid, expected, "payout");
        assertEq(usdg.balanceOf(address(r)), expected, "paid more than once");
        assertEq(platformToken.totalSupply(), s0 - amount, "burned more than once");
        assertEq(vault.totalBurned(), amount);
        _assertFloorNotLower(b0, s0, "reentrant redeem");

        // burnStray re-entered from inside redeem's payout is guarded too.
        vm.prank(holder);
        platformToken.transfer(address(vault), 1e18);
        r.armOnce(address(vault), abi.encodeCall(IFloorVault.burnStray, ()));
        r.redeem(amount);
        assertEq(r.attempts(), 2);
        assertEq(r.succeeded(), 0, "reentrant burnStray succeeded");
        assertEq(_selector(r.lastRevertData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "wrong revert");
        assertEq(platformToken.balanceOf(address(vault)), 1e18, "stray touched by the guarded path");
        // and outside the guard anyone may still burn it
        vm.prank(attacker);
        vault.burnStray();
        assertEq(platformToken.balanceOf(address(vault)), 0);
    }

    /// @notice A hostile agent treasury calls `burnStray` from inside `distribute`'s treasury
    ///         leg. It is permissionless and only raises the floor; the distribution still
    ///         closes exactly.
    function test_floor_hostileTreasuryBurnsStrayMidDistribute() public {
        uint256 agentId = _liveWithHostileTreasury();
        _buyToThreshold(agentId);
        (, bytes32 poolId) = _graduated(agentId);
        _poolSwapUsdgIn(agentId, trader, 2_000e6);

        vm.prank(holder);
        platformToken.transfer(address(vault), 1_000e18);
        hostile.armOnce(address(vault), abi.encodeCall(IFloorVault.burnStray, ()));

        (uint256 b0, uint256 s0) = _floorState();
        uint256 hostileBefore = usdg.balanceOf(address(hostile));
        vm.prank(attacker);
        hook.distribute(poolId, 0);

        assertEq(hostile.attempts(), 1, "reentry never attempted");
        assertEq(hostile.succeeded(), 1, "permissionless burnStray should land");
        assertEq(platformToken.totalSupply(), s0 - 1_000e18, "stray not burned");
        uint256 leg = usdg.balanceOf(address(vault)) - b0;
        assertGt(leg, 0, "floor leg not paid");
        assertEq(usdg.balanceOf(address(hostile)) - hostileBefore, leg, "treasury leg wrong");
        assertEq(
            usdg.balanceOf(address(hook)), hook.pendingFees(poolId, address(usdg)), "hook balance != pending after"
        );
        _assertFloorNotLower(b0, s0, "burnStray mid-distribute");
    }

    /// @notice Dust and unapproved redeems revert without consuming anything.
    function test_floor_dustAndUnapprovedRedeemsConsumeNothing() public {
        uint256 agentId = _live(treasuryEOA);
        _buyToThreshold(agentId);
        vm.prank(holder);
        platformToken.transfer(attacker, 1_000_000e18);
        (uint256 b0, uint256 s0) = _floorState();

        vm.startPrank(attacker);
        platformToken.approve(address(vault), type(uint256).max);
        vm.expectRevert(FloorVault.ZeroPayout.selector);
        vault.redeem(1); // 1 wei of $TOKEN is worth 0 USDG base units
        vm.expectRevert(FloorVault.ZeroAmount.selector);
        vault.redeem(0);
        platformToken.approve(address(vault), 0);
        vm.expectRevert();
        vault.redeem(1_000_000e18);
        vm.expectRevert(FloorVault.ZeroAmount.selector);
        vault.burnStray();
        vm.stopPrank();

        (uint256 b1, uint256 s1) = _floorState();
        assertEq(b1, b0, "vault USDG moved");
        assertEq(s1, s0, "supply moved");
        assertEq(platformToken.balanceOf(attacker), 1_000_000e18, "attacker tokens moved");
        assertEq(vault.totalBurned(), 0);
        assertEq(vault.totalRedeemedUsdg(), 0);
    }

    // =======================================================================
    // 5 — reentrancy through a hostile treasury contract
    // =======================================================================

    /// @dev The treasury fee leg lands mid-`buy`; the treasury immediately calls `buy` again.
    function test_hostileTreasuryReentersCurveBuy() public {
        uint256 agentId = _liveWithHostileTreasury();
        AgentBondingCurve c = _curve(agentId);

        vm.prank(trader);
        usdg.approve(address(c), type(uint256).max);
        usdg.mint(address(hostile), 1_000e6);
        vm.prank(address(hostile));
        usdg.approve(address(c), type(uint256).max);

        hostile.armOnce(address(c), abi.encodeCall(AgentBondingCurve.buy, (100e6, 0, address(hostile))));

        (uint256 reserveBefore,) = c.reserves();
        vm.prank(trader);
        c.buy(1_000e6, 0, trader);

        assertEq(hostile.attempts(), 1, "reentry never attempted");
        assertEq(hostile.succeeded(), 0, "reentrant buy succeeded");
        assertEq(_selector(hostile.lastRevertData()), AgentBondingCurve.Reentrancy.selector, "wrong revert");

        // The honest trade completed exactly once and the curve's books are intact.
        uint256 fee = (1_000e6 * TOTAL_FEE_BPS) / BASIS_POINTS;
        (uint256 reserveAfter,) = c.reserves();
        assertEq(reserveAfter - reserveBefore, 1_000e6 - fee, "reserve corrupted by the reentry attempt");
        assertEq(usdg.balanceOf(address(c)), reserveAfter, "curve balance != reserve");
        assertEq(usdg.balanceOf(address(hostile)), 1_000e6 + fee / 3, "treasury leg wrong");
    }

    /// @dev The treasury fee leg of the *threshold-crossing* buy re-enters `factory.graduate`.
    ///      The curve's `graduate` is deliberately not reentrancy-guarded (the factory sweeps
    ///      from inside its own guard), so this call can land — and must still be sound: the
    ///      buy has already debited `_tokenReserve` and credited `_realUsdg`, so the sweep
    ///      takes exactly the post-trade reserves and the curve keeps exactly the royalty leg
    ///      it has yet to pay. Asserted wei for wei below.
    struct MidBuySnapshot {
        uint256 reserve;
        uint256 tokens;
        uint256 accrued;
        uint256 treasuryBal;
        uint256 tokensOut;
    }

    function test_hostileTreasuryReentersGraduateMidBuy() public {
        uint256 agentId = _liveWithHostileTreasury();
        AgentBondingCurve c = _curve(agentId);

        _buyToOneTradeBeforeThreshold(agentId, 5_000e6);
        hostile.armOnce(address(factory), abi.encodeCall(IAgentFactory.graduate, (agentId)));

        MidBuySnapshot memory s;
        (s.reserve, s.tokens) = c.reserves();
        s.accrued = distributor.accrued(agentId);
        s.treasuryBal = usdg.balanceOf(address(hostile));

        vm.startPrank(trader);
        usdg.approve(address(c), type(uint256).max);
        s.tokensOut = c.buy(5_000e6, 0, trader);
        vm.stopPrank();

        assertEq(hostile.attempts(), 1, "reentry never attempted");
        assertEq(hostile.succeeded(), 1, "graduate mid-buy was expected to land");

        _assertMidBuySweepSound(agentId, s);

        // and phase 2 still runs normally on top of it
        factory.createGraduatedPool(agentId);
        assertGt(locker.lockedLiquidity(agentId), 0, "pool not seeded after the reentrant sweep");
        assertEq(usdg.balanceOf(address(factory)), 0, "factory retained usdg");
    }

    function _assertMidBuySweepSound(uint256 agentId, MidBuySnapshot memory s) internal view {
        AgentBondingCurve c = AgentBondingCurve(factory.curveOf(agentId));
        AgentToken token = AgentToken(factory.tokenOf(agentId));

        uint256 fee = (5_000e6 * TOTAL_FEE_BPS) / BASIS_POINTS;
        uint256 third = fee / 3;

        // The sweep took exactly the post-trade reserves, no more, no less.
        (uint256 sweptUsdg, uint256 poolTokens) = factory.sweptOf(agentId);
        uint256 expectedUsdg = s.reserve + (5_000e6 - fee);
        assertEq(sweptUsdg, expectedUsdg, "swept usdg != post-trade reserve");
        assertEq(
            poolTokens,
            FullMath.mulDiv(s.tokens - s.tokensOut, expectedUsdg, expectedUsdg + PHANTOM_QUOTE),
            "pool tokens != formula on the post-trade reserve"
        );

        // The curve is drained to zero and all three fee legs were still paid in full.
        assertEq(usdg.balanceOf(address(c)), 0, "curve retained USDG");
        assertEq(token.balanceOf(address(c)), 0, "curve retained AGENT");
        assertEq(usdg.balanceOf(address(hostile)) - s.treasuryBal, third, "treasury leg short");
        assertEq(distributor.accrued(agentId) - s.accrued, fee - third - third, "royalty leg short");
        assertEq(
            usdg.balanceOf(address(distributor)), distributor.accountedBalance(), "distributor accounting corrupted"
        );
        assertTrue(c.graduated(), "curve not graduated");
    }

    /// @dev The treasury fee leg lands mid-`distribute`; the treasury calls `distribute` again.
    function test_hostileTreasuryReentersHookDistribute() public {
        uint256 agentId = _liveWithHostileTreasury();
        _buyToThreshold(agentId);
        (, bytes32 poolId) = _graduated(agentId);
        _poolSwapUsdgIn(agentId, trader, 2_000e6);

        hostile.armOnce(address(hook), abi.encodeCall(IFeeSplitHook.distribute, (poolId, 0)));

        uint256 vaultBefore = usdg.balanceOf(address(vault));
        uint256 hostileBefore = usdg.balanceOf(address(hostile));
        vm.prank(attacker);
        hook.distribute(poolId, 0);

        assertEq(hostile.attempts(), 1, "reentry never attempted");
        assertEq(hostile.succeeded(), 0, "reentrant distribute succeeded");
        assertEq(_selector(hostile.lastRevertData()), FeeSplitHook.Reentrancy.selector, "wrong revert");

        uint256 leg = usdg.balanceOf(address(vault)) - vaultBefore;
        assertGt(leg, 0, "outer distribute moved nothing");
        assertEq(usdg.balanceOf(address(hostile)) - hostileBefore, leg, "treasury leg wrong");
        assertEq(
            usdg.balanceOf(address(hook)), hook.pendingFees(poolId, address(usdg)), "hook balance != pending after"
        );
    }

    // =======================================================================
    // 6 — donation attacks
    // =======================================================================

    /// @dev Donated USDG or AGENT must not move the curve's price, bring graduation forward,
    ///      or be swept into the pool at graduation.
    function test_donationToCurveChangesNothing() public {
        uint256 agentId = _live(treasuryEOA);
        AgentBondingCurve c = _curve(agentId);
        AgentToken token = AgentToken(factory.tokenOf(agentId));

        _buy(agentId, trader, 10_000e6);
        _buy(agentId, attacker, 1_000e6); // the attacker needs AGENT to donate

        (uint256 reserveBefore, uint256 tokensBefore) = c.reserves();
        uint256 quoteBefore = c.quoteBuy(1_000e6);
        bool readyBefore = c.readyToGraduate();

        uint256 usdgDonation = 100_000e6; // more than the graduation threshold on its own
        uint256 agentDonation = token.balanceOf(attacker) / 2;
        vm.startPrank(attacker);
        usdg.transfer(address(c), usdgDonation);
        token.transfer(address(c), agentDonation);
        vm.stopPrank();

        (uint256 reserveAfter, uint256 tokensAfter) = c.reserves();
        assertEq(reserveAfter, reserveBefore, "donation moved the USDG reserve");
        assertEq(tokensAfter, tokensBefore, "donation moved the token reserve");
        assertEq(c.quoteBuy(1_000e6), quoteBefore, "donation moved the price");
        assertEq(c.readyToGraduate(), readyBefore, "donation brought graduation forward");
        assertFalse(c.readyToGraduate(), "graduation opened by a donation");

        // Trading still prices off the tracked reserves only.
        _buy(agentId, trader, 1_000e6);
        _buyToThreshold(agentId);

        (uint256 reserveAtClose,) = c.reserves();
        factory.graduate(agentId);
        (uint256 sweptUsdg,) = factory.sweptOf(agentId);
        assertEq(sweptUsdg, reserveAtClose, "donation was swept into the pool");
        assertEq(usdg.balanceOf(address(c)), usdgDonation, "donated USDG did not stay stranded");
        assertEq(token.balanceOf(address(c)), agentDonation, "donated AGENT did not stay stranded");

        factory.createGraduatedPool(agentId);
        assertGt(locker.lockedLiquidity(agentId), 0);
    }

    /// @dev Donations to the hook must not inflate a distribution: only `pendingFees` pays out.
    function test_donationToHookDoesNotInflateDistribution() public {
        uint256 agentId = _live(treasuryEOA);
        _buyToThreshold(agentId);
        (, bytes32 poolId) = _graduated(agentId);
        _poolSwapUsdgIn(agentId, trader, 2_000e6);

        AgentToken token = AgentToken(factory.tokenOf(agentId));
        uint256 pendingAgentBefore = hook.pendingFees(poolId, address(token));
        uint256 pendingUsdgBefore = hook.pendingFees(poolId, address(usdg));

        uint256 usdgDonation = 50_000e6;
        vm.prank(attacker);
        usdg.transfer(address(hook), usdgDonation);

        assertEq(hook.pendingFees(poolId, address(usdg)), pendingUsdgBefore, "donation credited as pending");
        assertEq(hook.pendingFees(poolId, address(token)), pendingAgentBefore, "agent pending moved");

        uint256 vaultBefore = usdg.balanceOf(address(vault));
        vm.recordLogs();
        vm.prank(attacker);
        hook.distribute(poolId, 0);
        uint256 converted = _readConverted();
        uint256 leg = usdg.balanceOf(address(vault)) - vaultBefore;

        // The legs are bounded by what was actually earned — pending plus the conversion's own
        // output — not by the hook's balance, which the donation inflated.
        assertEq(
            hook.pendingFees(poolId, address(usdg)),
            pendingUsdgBefore + converted - leg * 3,
            "distribution did not close against pending + converted"
        );
        assertEq(
            usdg.balanceOf(address(hook)),
            hook.pendingFees(poolId, address(usdg)) + usdgDonation,
            "donation was paid out or lost"
        );
    }

    /// @dev Donations to the locker and the factory mid-flow must not change the seeded pool.
    function test_donationToLockerAndFactoryMidFlow() public {
        uint256 agentId = _live(treasuryEOA);
        _buyToThreshold(agentId);

        uint256 factoryDonation = 12_345e6;
        vm.prank(attacker);
        usdg.transfer(address(factory), factoryDonation);

        AgentBondingCurve c = _curve(agentId);
        (uint256 reserveAtClose,) = c.reserves();
        factory.graduate(agentId);

        (uint256 sweptUsdg, uint256 poolTokens) = factory.sweptOf(agentId);
        assertEq(sweptUsdg, reserveAtClose, "factory donation entered the swept state");

        uint256 lockerDonation = 7_777e6;
        vm.prank(attacker);
        usdg.transfer(address(locker), lockerDonation);

        PoolKey memory key = factory.poolKeyOf(agentId);
        address token = factory.tokenOf(agentId);
        (uint256 amount0, uint256 amount1) = token < address(usdg) ? (poolTokens, sweptUsdg) : (sweptUsdg, poolTokens);

        factory.createGraduatedPool(agentId);

        (uint160 sqrtPriceX96,,,) = IPoolManager(address(manager)).getSlot0(key.toId());
        assertEq(
            locker.lockedLiquidity(agentId),
            LiquidityAmounts.getLiquidityForAmounts(
                sqrtPriceX96,
                TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(TICK_SPACING)),
                TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(TICK_SPACING)),
                amount0,
                amount1
            ),
            "donation changed the seeded liquidity"
        );
        assertEq(usdg.balanceOf(address(locker)), lockerDonation, "locker donation not stranded");
        assertEq(usdg.balanceOf(address(factory)), factoryDonation, "factory donation not stranded");
    }
}
