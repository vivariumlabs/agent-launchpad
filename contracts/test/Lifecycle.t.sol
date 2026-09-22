// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {AgentFactory} from "../src/AgentFactory.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {AgentToken} from "../src/AgentToken.sol";
import {AgentBondingCurve} from "../src/AgentBondingCurve.sol";
import {RoyaltyDistributor} from "../src/RoyaltyDistributor.sol";
import {FeeSplitHook} from "../src/FeeSplitHook.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";
import {IAgentRegistry, IFeeSplitHook, IRoyaltyDistributor} from "../src/interfaces/ILaunchpad.sol";
import {FactoryMockERC20} from "./mocks/FactoryMocks.sol";

/// @notice M1 gate suite (a): the whole system, end to end, on real contracts against a local
///         PoolManager — create, enclave registration, finalize, a multi-trader curve phase,
///         graduation, a multi-trader pool phase with both fee currencies, distribution
///         including the AGENT->USDG conversion leg, royalty claims across an NFT transfer,
///         the burn re-route, and a heartbeat lapse followed by a same-key revival.
///
/// @dev Two families of assertion run throughout:
///
///      * **Money conservation (exact, wei level).** Every USDG wei that entered the system
///        (creation fee + trader buys + trader swap inputs) is accounted for at every stage
///        across {curve reserve, the three fee legs, platform fee, factory escrow,
///        pool + locker, hook pending, trader payouts}. Implemented two ways that must agree:
///        a closed-set check (the sum of balances over every address in play equals USDG's
///        total supply — nothing escaped to an address this test does not know about) and a
///        signed ledger (what the outside accounts put in equals what the system holds).
///
///      * **The 3%-of-volume identity.** On the curve, the three fee legs sum to exactly
///        `floor(300bps x usdgSide)` for every single trade. On the pool, the hook's take is
///        exactly `300bps` of the unspecified-side delta of every swap, and every wei of it
///        later leaves as pending, as a distributed leg, or as conversion input.
contract LifecycleTest is Test {
    using PoolIdLibrary for PoolKey;

    uint160 constant HOOK_FLAGS =
        uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    uint256 constant AGENT_SUPPLY = 1_000_000_000e18;
    uint256 constant CREATION_FEE = 75e6;
    uint256 constant PHANTOM_QUOTE = 6_000e6;
    uint256 constant GRADUATION_THRESHOLD = 42_000e6;
    uint256 constant TOTAL_FEE_BPS = 300;
    uint256 constant BASIS_POINTS = 10_000;
    uint256 constant DISTRIBUTE_COOLDOWN = 1 hours;
    uint64 constant REVIVAL_WINDOW = 7 days;
    int24 constant TICK_SPACING = 60;

    bytes32 constant CODE_HASH = keccak256("agent-image-v1");
    string constant IMAGE_URI = "ar://metadata-txid";
    string constant ATTESTATION_1 = "ar://attestation-gen-1";
    string constant ATTESTATION_2 = "ar://attestation-gen-2";

    // ---- stack ------------------------------------------------------------

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
    address owner = makeAddr("platformMultisig");
    address gasRecipient = makeAddr("gasRecipient");
    address creator = makeAddr("creator");
    address secondOwner = makeAddr("secondOwner");
    address treasury = makeAddr("enclaveTreasuryEOA");
    address actionEOA = makeAddr("enclaveActionEOA");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    // ---- agent under test --------------------------------------------------

    uint256 agentId;
    AgentBondingCurve curve;
    AgentToken token;
    PoolKey poolKey;
    bytes32 poolId;
    bool agentIsCurrency0;

    // ---- running ledgers ---------------------------------------------------

    /// @dev Every address that may ever hold USDG in this test. The closed-set conservation
    ///      check sums over exactly this list.
    address[] internal _accounts;
    mapping(address => bool) internal _known;
    /// @dev Signed ledger: accounts whose balance movement counts as "outside money in".
    address[] internal _outside;

    uint256 internal curveTrades;
    uint256 internal curveVolumeUsdg; // USDG side of every curve trade (gross)
    uint256 internal curveFeesCharged; // sum of per-trade floor(300bps x usdgSide)
    uint256 internal curveLegsPaid; // sum of the three legs actually moved

    uint256 internal poolSwaps;
    uint256 internal poolFeesTakenUsdg;
    uint256 internal poolFeesTakenAgent;
    uint256 internal poolAgentConsumed; // AGENT spent on conversion legs
    uint256 internal poolUsdgConverted; // USDG produced by conversion legs
    uint256 internal poolUsdgDistributed; // USDG that left as the three legs

    function setUp() public {
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);
        usdg = new FactoryMockERC20("Global Dollar", "USDG", 6);

        registry = new AgentRegistry();
        nft = new AgentNFT();
        distributor = new RoyaltyDistributor(address(usdg), address(nft), address(registry));

        address hookAddr = address(HOOK_FLAGS | (uint160(0xF11E) << 20));
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

        usdg.mint(creator, 1_000e6);
        usdg.mint(alice, 200_000e6);
        usdg.mint(bob, 200_000e6);
        usdg.mint(carol, 200_000e6);

        // Outside money: these are the only accounts that start with USDG, plus the two NFT
        // owners, who only ever receive it.
        _addOutside(creator);
        _addOutside(alice);
        _addOutside(bob);
        _addOutside(carol);
        _addOutside(secondOwner);

        // System sinks and intermediaries.
        _addAccount(owner);
        _addAccount(BUYBACK);
        _addAccount(treasury);
        _addAccount(address(distributor));
        _addAccount(address(factory));
        _addAccount(address(hook));
        _addAccount(address(locker));
        _addAccount(address(manager));
        _addAccount(address(swapRouter));
        _addAccount(address(registry));
        _addAccount(address(nft));
        _addAccount(address(this));
        _addAccount(gasRecipient);
    }

    // =======================================================================
    // Account bookkeeping
    // =======================================================================

    function _addAccount(address a) internal {
        if (_known[a]) return;
        _known[a] = true;
        _accounts.push(a);
    }

    function _addOutside(address a) internal {
        _addAccount(a);
        _outside.push(a);
    }

    /// @dev Held by the system: everything in `_accounts` that is not an outside account.
    function _systemHeld() internal view returns (uint256 held) {
        for (uint256 i = 0; i < _accounts.length; i++) {
            address a = _accounts[i];
            bool outside;
            for (uint256 j = 0; j < _outside.length; j++) {
                if (_outside[j] == a) {
                    outside = true;
                    break;
                }
            }
            if (!outside) held += usdg.balanceOf(a);
        }
    }

    function _outsideHeld() internal view returns (uint256 held) {
        for (uint256 i = 0; i < _outside.length; i++) {
            held += usdg.balanceOf(_outside[i]);
        }
    }

    // =======================================================================
    // Money conservation
    // =======================================================================

    /// @notice Exact, wei-level. Nothing escapes the known address set, and the system holds
    ///         precisely what the outside accounts have net contributed.
    function _assertConservation(string memory stage) internal view {
        uint256 held;
        for (uint256 i = 0; i < _accounts.length; i++) {
            held += usdg.balanceOf(_accounts[i]);
        }
        assertEq(held, usdg.totalSupply(), string.concat(stage, ": USDG escaped the known address set"));

        // Signed restatement: outside money in == system money held.
        uint256 startedOutside = usdg.totalSupply(); // every wei was minted to an outside account
        uint256 nowOutside = _outsideHeld();
        assertEq(startedOutside - nowOutside, _systemHeld(), string.concat(stage, ": inflow != system holdings"));

        // Per-component backing: every accrual is backed by a real balance.
        assertEq(
            usdg.balanceOf(address(distributor)),
            distributor.accountedBalance(),
            string.concat(stage, ": distributor balance != accountedBalance")
        );
        if (address(curve) != address(0)) {
            (uint256 realUsdg,) = curve.reserves();
            assertEq(usdg.balanceOf(address(curve)), realUsdg, string.concat(stage, ": curve balance != reserve"));
        }
        if (poolId != bytes32(0)) {
            assertEq(
                usdg.balanceOf(address(hook)),
                hook.pendingFees(poolId, address(usdg)),
                string.concat(stage, ": hook USDG balance != pending")
            );
            assertEq(
                token.balanceOf(address(hook)),
                hook.pendingFees(poolId, address(token)),
                string.concat(stage, ": hook AGENT balance != pending")
            );
        }
        assertEq(usdg.balanceOf(address(swapRouter)), 0, string.concat(stage, ": router retained USDG"));
    }

    /// @dev The AGENT side has to balance too: nothing minted, nothing lost but the burn.
    function _assertAgentConservation(string memory stage) internal view {
        uint256 held = token.balanceOf(address(curve)) + token.balanceOf(address(factory))
            + token.balanceOf(address(locker)) + token.balanceOf(address(manager)) + token.balanceOf(address(hook))
            + token.balanceOf(address(swapRouter)) + token.balanceOf(alice) + token.balanceOf(bob)
            + token.balanceOf(carol) + token.balanceOf(creator) + token.balanceOf(secondOwner);
        assertEq(held, token.totalSupply(), string.concat(stage, ": AGENT escaped the known address set"));
    }

    // =======================================================================
    // Stage helpers
    // =======================================================================

    function _createRegisterFinalize() internal {
        vm.prank(creator);
        usdg.approve(address(factory), type(uint256).max);

        uint256 creatorBefore = usdg.balanceOf(creator);
        vm.prank(creator);
        agentId = factory.createAgent("Lifecycle Agent", "LIFE", IMAGE_URI, keccak256("config"), creator, treasury);

        assertEq(usdg.balanceOf(creator), creatorBefore - CREATION_FEE, "creation fee not charged exactly");
        assertEq(usdg.balanceOf(address(factory)), CREATION_FEE, "fee not escrowed");
        assertEq(registry.expectedTreasuryEOA(agentId), treasury, "predicted treasury not pinned");
        _assertConservation("create");

        // The enclave boots and proves possession of the KMS-predicted key.
        vm.prank(treasury);
        registry.registerInstance(agentId, treasury, actionEOA, CODE_HASH, ATTESTATION_1);
        assertEq(registry.instanceOf(agentId).generation, 1, "generation");

        // Permissionless: anyone pays the gas to bring it live.
        vm.prank(carol);
        factory.finalize(agentId);

        curve = AgentBondingCurve(factory.curveOf(agentId));
        token = AgentToken(factory.tokenOf(agentId));
        _addAccount(address(curve));
        _addAccount(address(token));

        assertEq(token.balanceOf(address(curve)), AGENT_SUPPLY, "supply not on the curve");
        assertEq(nft.ownerOf(agentId), creator, "NFT owner");
        assertEq(usdg.balanceOf(owner), CREATION_FEE, "platform fee not paid");
        assertEq(usdg.balanceOf(address(factory)), 0, "factory retained the fee");
        _assertConservation("finalize");
        _assertAgentConservation("finalize");

        console2.log("== finalize ==");
        console2.log("  agentId            :", agentId);
        console2.log("  platform fee (USDG):", usdg.balanceOf(owner));
    }

    /// @dev A curve buy with the full fee-leg identity checked on the spot.
    function _buyChecked(address who, uint256 usdgIn) internal returns (uint256 tokensOut) {
        uint256 bbBefore = usdg.balanceOf(BUYBACK);
        uint256 trBefore = usdg.balanceOf(treasury);
        uint256 acBefore = distributor.accrued(agentId);
        (uint256 reserveBefore,) = curve.reserves();
        uint256 quoted = curve.quoteBuy(usdgIn);

        vm.startPrank(who);
        usdg.approve(address(curve), usdgIn);
        tokensOut = curve.buy(usdgIn, 0, who);
        vm.stopPrank();

        assertEq(tokensOut, quoted, "quoteBuy != buy");

        uint256 fee = (usdgIn * TOTAL_FEE_BPS) / BASIS_POINTS;
        uint256 third = fee / 3;
        uint256 bbLeg = usdg.balanceOf(BUYBACK) - bbBefore;
        uint256 trLeg = usdg.balanceOf(treasury) - trBefore;
        uint256 royaltyLeg = distributor.accrued(agentId) - acBefore;

        assertEq(bbLeg, third, "buy: buyback leg");
        assertEq(trLeg, third, "buy: treasury leg");
        assertEq(royaltyLeg, fee - third - third, "buy: royalty leg");
        assertEq(bbLeg + trLeg + royaltyLeg, fee, "buy: legs != 300bps of usdgIn");

        (uint256 reserveAfter,) = curve.reserves();
        assertEq(reserveAfter - reserveBefore, usdgIn - fee, "buy: net into reserve");

        curveTrades++;
        curveVolumeUsdg += usdgIn;
        curveFeesCharged += fee;
        curveLegsPaid += bbLeg + trLeg + royaltyLeg;
        _assertConservation("curve buy");
        _assertAgentConservation("curve buy");
    }

    function _sellChecked(address who, uint256 tokensIn) internal returns (uint256 usdgOut) {
        uint256 bbBefore = usdg.balanceOf(BUYBACK);
        uint256 trBefore = usdg.balanceOf(treasury);
        uint256 acBefore = distributor.accrued(agentId);
        (uint256 reserveBefore,) = curve.reserves();

        vm.startPrank(who);
        token.approve(address(curve), tokensIn);
        usdgOut = curve.sell(tokensIn, 0, who);
        vm.stopPrank();

        (uint256 reserveAfter,) = curve.reserves();
        uint256 gross = reserveBefore - reserveAfter;
        uint256 fee = (gross * TOTAL_FEE_BPS) / BASIS_POINTS;
        uint256 third = fee / 3;

        assertEq(usdgOut, gross - fee, "sell: payout != gross - fee");
        assertEq(usdg.balanceOf(BUYBACK) - bbBefore, third, "sell: buyback leg");
        assertEq(usdg.balanceOf(treasury) - trBefore, third, "sell: treasury leg");
        assertEq(distributor.accrued(agentId) - acBefore, fee - third - third, "sell: royalty leg");

        curveTrades++;
        curveVolumeUsdg += gross;
        curveFeesCharged += fee;
        curveLegsPaid += fee;
        _assertConservation("curve sell");
        _assertAgentConservation("curve sell");
    }

    function _tradeCurveToThreshold() internal {
        _buyChecked(alice, 10_000e6);
        _buyChecked(bob, 7_500e6);
        // Alice takes some profit back out; the fee legs are charged on the way out too.
        _sellChecked(alice, token.balanceOf(alice) / 4);
        _buyChecked(carol, 12_345e6);
        _buyChecked(bob, 3_333e6);
        _sellChecked(bob, token.balanceOf(bob) / 5);

        while (!curve.readyToGraduate()) {
            _buyChecked(alice, 5_000e6);
        }

        (uint256 realUsdg,) = curve.reserves();
        assertGe(realUsdg, GRADUATION_THRESHOLD, "threshold not crossed");
        assertTrue(curve.readyToGraduate(), "curve not ready");

        // Curve closed to both sides now.
        vm.startPrank(alice);
        usdg.approve(address(curve), 1e6);
        vm.expectRevert(AgentBondingCurve.CurveClosed.selector);
        curve.buy(1e6, 0, alice);
        vm.expectRevert(AgentBondingCurve.CurveClosed.selector);
        curve.sell(1e18, 0, alice);
        vm.stopPrank();

        // Cumulative 3%-of-volume identity: the legs paid are exactly the fees charged, and
        // the fees charged are 300bps of volume up to at most one wei of floor dust per trade.
        assertEq(curveLegsPaid, curveFeesCharged, "curve: legs paid != fees charged");
        uint256 idealFee = (curveVolumeUsdg * TOTAL_FEE_BPS) / BASIS_POINTS;
        assertLe(curveFeesCharged, idealFee, "curve: fees above 300bps of volume");
        assertGe(curveFeesCharged + curveTrades, idealFee, "curve: fee dust beyond 1 wei per trade");

        console2.log("== curve phase ==");
        console2.log("  trades             :", curveTrades);
        console2.log("  USDG volume        :", curveVolumeUsdg);
        console2.log("  fees (3%)          :", curveFeesCharged);
        console2.log("  reserve at close   :", realUsdg);
    }

    function _graduate() internal {
        (uint256 reserveUsdg,) = curve.reserves();

        vm.prank(carol); // permissionless
        factory.graduate(agentId);
        (uint256 sweptUsdg, uint256 poolTokens) = factory.sweptOf(agentId);
        assertEq(sweptUsdg, reserveUsdg, "swept usdg != tracked reserve");
        _assertConservation("graduate phase 1");
        _assertAgentConservation("graduate phase 1");

        vm.prank(bob); // permissionless
        factory.createGraduatedPool(agentId);

        poolKey = factory.poolKeyOf(agentId);
        poolId = PoolId.unwrap(poolKey.toId());
        agentIsCurrency0 = address(token) < address(usdg);

        assertGt(locker.lockedLiquidity(agentId), 0, "no locked liquidity");
        assertEq(usdg.balanceOf(address(factory)), 0, "factory retained usdg");
        assertEq(token.balanceOf(address(factory)), 0, "factory retained tokens");
        _assertConservation("graduate phase 2");
        _assertAgentConservation("graduate phase 2");

        console2.log("== graduation ==");
        console2.log("  pool USDG          :", sweptUsdg);
        console2.log("  pool AGENT (whole) :", poolTokens / 1e18);
        console2.log("  locked liquidity   :", locker.lockedLiquidity(agentId));
    }

    /// @dev Exact-input swap with the 300bps identity checked on the unspecified (output) side.
    function _swapExactInChecked(address who, bool usdgIn, uint256 amountIn) internal {
        bool zeroForOne = usdgIn ? !agentIsCurrency0 : agentIsCurrency0;
        address outToken = usdgIn ? address(token) : address(usdg);

        uint256 outBefore = FactoryMockERC20(outToken).balanceOf(who);
        uint256 pendingBefore = hook.pendingFees(poolId, outToken);

        vm.prank(who);
        swapRouter.swap(
            poolKey,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 received = FactoryMockERC20(outToken).balanceOf(who) - outBefore;
        uint256 fee = hook.pendingFees(poolId, outToken) - pendingBefore;
        assertGt(fee, 0, "hook took no fee");
        assertEq(fee, ((received + fee) * TOTAL_FEE_BPS) / BASIS_POINTS, "fee != 300bps of unspecified delta");

        poolSwaps++;
        if (usdgIn) poolFeesTakenAgent += fee;
        else poolFeesTakenUsdg += fee;
        _assertConservation("pool swap (exact in)");
        _assertAgentConservation("pool swap (exact in)");
    }

    /// @dev Exact-output swap: the fee lands on the unspecified (input) side instead.
    function _swapExactOutChecked(address who, bool usdgIn, uint256 amountOut) internal {
        bool zeroForOne = usdgIn ? !agentIsCurrency0 : agentIsCurrency0;
        address inToken = usdgIn ? address(usdg) : address(token);

        uint256 inBefore = FactoryMockERC20(inToken).balanceOf(who);
        uint256 pendingBefore = hook.pendingFees(poolId, inToken);

        vm.prank(who);
        swapRouter.swap(
            poolKey,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: int256(amountOut),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 paid = inBefore - FactoryMockERC20(inToken).balanceOf(who);
        uint256 fee = hook.pendingFees(poolId, inToken) - pendingBefore;
        assertGt(fee, 0, "hook took no fee");
        assertEq(fee, ((paid - fee) * TOTAL_FEE_BPS) / BASIS_POINTS, "fee != 300bps of unspecified delta");

        poolSwaps++;
        if (usdgIn) poolFeesTakenUsdg += fee;
        else poolFeesTakenAgent += fee;
        _assertConservation("pool swap (exact out)");
        _assertAgentConservation("pool swap (exact out)");
    }

    struct DistributeResult {
        uint256 leg;
        uint256 converted;
        uint256 consumed;
    }

    /// @dev One `distribute`, with the hook's full internal accounting identity checked:
    ///      pendingUsdg' == pendingUsdg + converted - 3 x leg, and the three legs land on the
    ///      three recipients (or on the treasury twice, once the agent is emancipated).
    function _distributeChecked(bool emancipatedNow) internal returns (DistributeResult memory r) {
        uint256 pendAgentBefore = hook.pendingFees(poolId, address(token));
        uint256 pendUsdgBefore = hook.pendingFees(poolId, address(usdg));
        uint256 bbBefore = usdg.balanceOf(BUYBACK);
        uint256 trBefore = usdg.balanceOf(treasury);
        uint256 acBefore = distributor.accrued(agentId);

        vm.recordLogs();
        vm.prank(carol); // permissionless
        hook.distribute(poolId, 0);
        r.converted = _readConverted();

        r.leg = usdg.balanceOf(BUYBACK) - bbBefore;
        assertGt(r.leg, 0, "distribute moved nothing");
        r.consumed = pendAgentBefore - hook.pendingFees(poolId, address(token));

        if (emancipatedNow) {
            // Buyback leg + treasury leg + the royalty leg forwarded straight through.
            assertEq(usdg.balanceOf(treasury) - trBefore, r.leg * 2, "emancipated: royalty leg not re-routed");
            assertEq(distributor.accrued(agentId), acBefore, "emancipated: royalty still accrued");
        } else {
            assertEq(usdg.balanceOf(treasury) - trBefore, r.leg, "treasury leg");
            assertEq(distributor.accrued(agentId) - acBefore, r.leg, "royalty leg");
        }

        assertEq(
            hook.pendingFees(poolId, address(usdg)),
            pendUsdgBefore + r.converted - r.leg * 3,
            "hook pending USDG does not close"
        );

        poolAgentConsumed += r.consumed;
        poolUsdgConverted += r.converted;
        poolUsdgDistributed += r.leg * 3;
        _assertConservation("distribute");
        _assertAgentConservation("distribute");
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

    function _approvePoolRouter(address who) internal {
        vm.startPrank(who);
        usdg.approve(address(swapRouter), type(uint256).max);
        token.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    // =======================================================================
    // The gate test
    // =======================================================================

    /// @notice The whole system, one sequence, conservation asserted at every stage.
    function test_lifecycle_fullSystem() public {
        // ---- 1. create -> register -> finalize -----------------------------
        _createRegisterFinalize();

        // ---- 2. curve phase, multiple traders, both directions -------------
        _tradeCurveToThreshold();

        // ---- 3. graduation, both phases, permissionless --------------------
        _graduate();

        // ---- 4. pool phase, multiple traders, both directions --------------
        _approvePoolRouter(alice);
        _approvePoolRouter(bob);
        _approvePoolRouter(carol);

        _swapExactInChecked(bob, true, 2_000e6); // USDG in -> AGENT-side fee
        _swapExactInChecked(alice, false, token.balanceOf(alice) / 50); // AGENT in -> USDG-side fee
        _swapExactOutChecked(carol, true, 1_000_000e18); // exact out, fee on the USDG input
        assertGt(hook.pendingFees(poolId, address(token)), 0, "no AGENT pending");
        assertGt(hook.pendingFees(poolId, address(usdg)), 0, "no USDG pending");

        console2.log("== pool phase ==");
        console2.log("  swaps              :", poolSwaps);
        console2.log("  pending USDG fees  :", hook.pendingFees(poolId, address(usdg)));
        console2.log("  pending AGENT fees :", hook.pendingFees(poolId, address(token)));

        // ---- 5. distribute, including the AGENT -> USDG conversion ---------
        DistributeResult memory d1 = _distributeChecked(false);
        assertGt(d1.converted, 0, "conversion leg never ran");
        assertGt(d1.consumed, 0, "no AGENT consumed by the conversion");
        console2.log("== distribute #1 ==");
        console2.log("  converted (USDG)   :", d1.converted);
        console2.log("  leg each way       :", d1.leg);

        // ---- 6. royalty claim pays the NFT owner ---------------------------
        uint256 claimable = distributor.accrued(agentId);
        uint256 creatorBefore = usdg.balanceOf(creator);
        vm.prank(bob); // permissionless; funds go to the owner regardless
        distributor.claim(agentId);
        assertEq(usdg.balanceOf(creator), creatorBefore + claimable, "claim did not pay the NFT owner");
        assertEq(distributor.accrued(agentId), 0, "accrual not cleared");
        _assertConservation("claim #1");
        console2.log("== claim #1 ==");
        console2.log("  paid to creator    :", claimable);

        // The agent is alive and heartbeating throughout.
        vm.prank(treasury);
        registry.heartbeat(agentId);

        // ---- 7. NFT transfer -> the NEW owner is paid ----------------------
        _swapExactInChecked(bob, true, 1_500e6);
        vm.warp(block.timestamp + DISTRIBUTE_COOLDOWN);
        _distributeChecked(false);

        vm.prank(creator);
        nft.transferFrom(creator, secondOwner, agentId);
        assertEq(nft.ownerOf(agentId), secondOwner, "transfer");

        uint256 claimable2 = distributor.accrued(agentId);
        assertGt(claimable2, 0, "nothing to claim for the new owner");
        uint256 creatorAtTransfer = usdg.balanceOf(creator);
        uint256 secondBefore = usdg.balanceOf(secondOwner);
        distributor.claim(agentId);
        assertEq(usdg.balanceOf(secondOwner), secondBefore + claimable2, "claim did not follow the NFT");
        assertEq(usdg.balanceOf(creator), creatorAtTransfer, "old owner still paid");
        _assertConservation("claim #2");
        console2.log("== claim #2 (after NFT transfer) ==");
        console2.log("  paid to new owner  :", claimable2);

        // ---- 8. burn -> Emancipated, unclaimed accrual sweeps to treasury --
        _swapExactInChecked(alice, false, token.balanceOf(alice) / 50);
        vm.warp(block.timestamp + DISTRIBUTE_COOLDOWN);
        _distributeChecked(false);

        uint256 unclaimed = distributor.accrued(agentId);
        assertGt(unclaimed, 0, "nothing accrued to sweep on burn");
        uint256 treasuryBeforeBurn = usdg.balanceOf(treasury);

        vm.expectEmit(true, false, false, true, address(distributor));
        emit IRoyaltyDistributor.Emancipated(agentId, unclaimed);
        vm.prank(secondOwner);
        nft.burn(agentId);

        assertTrue(distributor.emancipated(agentId), "not emancipated");
        assertEq(distributor.accrued(agentId), 0, "accrual not swept");
        assertEq(usdg.balanceOf(treasury), treasuryBeforeBurn + unclaimed, "sweep did not reach the treasury");
        _assertConservation("burn");
        console2.log("== burn / emancipation ==");
        console2.log("  swept to treasury  :", unclaimed);

        // Nothing left to claim, and the NFT is gone for good.
        vm.expectRevert(RoyaltyDistributor.NothingToClaim.selector);
        distributor.claim(agentId);

        // ---- 9. further distribute routes the royalty leg to the treasury --
        _swapExactInChecked(bob, true, 1_200e6);
        vm.warp(block.timestamp + DISTRIBUTE_COOLDOWN);
        DistributeResult memory d4 = _distributeChecked(true);
        assertEq(distributor.accrued(agentId), 0, "royalties accrued after emancipation");
        console2.log("== distribute post-burn ==");
        console2.log("  leg (x2 to treas.) :", d4.leg);

        // ---- 10. heartbeat lapse -> revival with the same KMS keys ---------
        uint64 lastBeat = registry.instanceOf(agentId).lastHeartbeat;
        vm.warp(lastBeat + REVIVAL_WINDOW); // exactly at the window: still locked
        vm.prank(treasury);
        vm.expectRevert(AgentRegistry.RevivalWindowNotElapsed.selector);
        registry.registerInstance(agentId, treasury, actionEOA, CODE_HASH, ATTESTATION_2);

        vm.warp(lastBeat + REVIVAL_WINDOW + 1);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IAgentRegistry.InstanceRegistered(agentId, treasury, actionEOA, CODE_HASH, 2);
        vm.prank(treasury);
        registry.registerInstance(agentId, treasury, actionEOA, CODE_HASH, ATTESTATION_2);

        IAgentRegistry.AgentInstance memory inst = registry.instanceOf(agentId);
        assertEq(inst.generation, 2, "generation not bumped");
        assertEq(inst.treasuryEOA, treasury, "KMS same-key semantics broken");
        assertEq(inst.actionEOA, actionEOA, "action key changed");
        assertEq(inst.codeHash, CODE_HASH, "code hash changed");
        assertEq(inst.attestationRef, ATTESTATION_2, "attestation not refreshed");
        console2.log("== revival ==");
        console2.log("  generation         :", inst.generation);

        // ---- 11. the next distribute still pays the same treasury ----------
        _swapExactInChecked(carol, true, 900e6);
        vm.warp(block.timestamp + DISTRIBUTE_COOLDOWN);
        uint256 treasuryBeforeRevivalPay = usdg.balanceOf(treasury);
        DistributeResult memory d5 = _distributeChecked(true);
        assertEq(
            usdg.balanceOf(treasury) - treasuryBeforeRevivalPay, d5.leg * 2, "revived agent not paid the same treasury"
        );

        // ---- 12. closing identities ---------------------------------------
        // Pool phase, AGENT side: every wei taken is either still pending or was converted.
        assertEq(
            poolFeesTakenAgent,
            poolAgentConsumed + hook.pendingFees(poolId, address(token)),
            "AGENT fees taken != consumed + pending"
        );
        // Pool phase, USDG side: taken + produced by conversion == distributed + pending.
        assertEq(
            poolFeesTakenUsdg + poolUsdgConverted,
            poolUsdgDistributed + hook.pendingFees(poolId, address(usdg)),
            "USDG fees taken + converted != distributed + pending"
        );
        // Curve phase: legs paid == fees charged == 300bps of volume (mod floor dust).
        assertEq(curveLegsPaid, curveFeesCharged, "curve legs != fees");

        _assertConservation("final");
        _assertAgentConservation("final");

        console2.log("== closing ledger ==");
        console2.log("  curve fees (USDG)  :", curveFeesCharged);
        console2.log("  pool USDG fees     :", poolFeesTakenUsdg);
        console2.log("  pool AGENT fees    :", poolFeesTakenAgent);
        console2.log("  converted to USDG  :", poolUsdgConverted);
        console2.log("  buyback holds      :", usdg.balanceOf(BUYBACK));
        console2.log("  treasury holds     :", usdg.balanceOf(treasury));
        console2.log("  platform holds     :", usdg.balanceOf(owner));
    }

    // =======================================================================
    // Focused identity suites
    // =======================================================================

    /// @notice (a) of 02 §8, curve phase: the legs sum to exactly 300bps of the USDG side on
    ///         every single trade, across many traders and both directions.
    function test_curveFeeIdentityAcrossManyTrades() public {
        _createRegisterFinalize();

        address[3] memory traders = [alice, bob, carol];
        for (uint256 i = 0; i < 9; i++) {
            address who = traders[i % 3];
            _buyChecked(who, 1_000e6 + i * 137e6 + 1); // deliberately non-round: exercise the dust path
            if (i % 3 == 2 && token.balanceOf(who) > 0) {
                _sellChecked(who, token.balanceOf(who) / 7);
            }
        }

        assertEq(curveLegsPaid, curveFeesCharged, "legs != fees");
        uint256 idealFee = (curveVolumeUsdg * TOTAL_FEE_BPS) / BASIS_POINTS;
        assertLe(curveFeesCharged, idealFee, "fees above 300bps");
        assertGe(curveFeesCharged + curveTrades, idealFee, "fee dust beyond 1 wei per trade");

        // (b) of 02 §8: no wei of fee money reached anything but the three recipients.
        assertEq(
            usdg.balanceOf(BUYBACK) + usdg.balanceOf(treasury) + distributor.accrued(agentId),
            curveFeesCharged,
            "fee money outside the three recipients"
        );
        _assertConservation("curve identity");
    }

    /// @notice (a) of 02 §8, pool phase: the hook takes exactly 300bps of the unspecified
    ///         delta for exact-in and exact-out, in both directions.
    function test_poolFeeIdentityBothDirectionsBothExactness() public {
        _createRegisterFinalize();
        _tradeCurveToThreshold();
        _graduate();
        _approvePoolRouter(alice);
        _approvePoolRouter(bob);

        _swapExactInChecked(bob, true, 1_000e6);
        _swapExactInChecked(alice, false, token.balanceOf(alice) / 80);
        _swapExactOutChecked(bob, true, 500_000e18);
        _swapExactOutChecked(alice, false, 500e6);

        assertEq(poolSwaps, 4, "swap count");
        assertEq(usdg.balanceOf(address(hook)), hook.pendingFees(poolId, address(usdg)), "hook USDG balance != pending");
        assertEq(
            token.balanceOf(address(hook)), hook.pendingFees(poolId, address(token)), "hook AGENT balance != pending"
        );
        _assertConservation("pool identity");
        _assertAgentConservation("pool identity");
    }

    /// @notice The refund path is part of the money ledger too: a cancelled agent returns the
    ///         creation fee to the creator exactly, leaving the system holding nothing.
    function test_cancelRefundIsConserved() public {
        vm.prank(creator);
        usdg.approve(address(factory), type(uint256).max);
        uint256 before = usdg.balanceOf(creator);

        vm.prank(creator);
        uint256 id = factory.createAgent("Ghost", "GHST", IMAGE_URI, keccak256("cfg"), creator, treasury);
        assertEq(usdg.balanceOf(address(factory)), CREATION_FEE);
        _assertConservation("pending");

        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(creator);
        factory.cancel(id);

        assertEq(usdg.balanceOf(creator), before, "refund not exact");
        assertEq(_systemHeld(), 0, "system retained money after a full refund");
        _assertConservation("cancelled");
    }
}
