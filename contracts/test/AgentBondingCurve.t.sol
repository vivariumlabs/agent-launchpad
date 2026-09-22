// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentBondingCurve} from "../src/AgentBondingCurve.sol";
import {IAgentBondingCurve} from "../src/interfaces/ILaunchpad.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";
import {CurveMockUSDG} from "./mocks/CurveMockUSDG.sol";
import {
    CurveMockAgentToken,
    CurveMockRegistry,
    CurveMockDistributor,
    CurveReenteringDistributor
} from "./mocks/CurveMocks.sol";

/// @dev Shared rig: an EIP-1167 clone of the curve, wired exactly the way the
/// factory wires one (full AGENT supply minted to the clone, then initialize).
abstract contract CurveTestBase is Test {
    // SPEC-M1.md parameters.
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant PHANTOM = 6_000e6;
    uint256 internal constant THRESHOLD = 42_000e6;
    uint256 internal constant AGENT_ID = 7;
    uint256 internal constant FEE_BPS = 300;

    AgentBondingCurve internal implementation;
    AgentBondingCurve internal curve;
    CurveMockUSDG internal usdg;
    CurveMockAgentToken internal token;
    CurveMockRegistry internal registry;
    CurveMockDistributor internal distributor;

    address internal factory = makeAddr("factory");
    address internal treasury = makeAddr("agentTreasury");
    address internal buyback = makeAddr("treasuryBuyback");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function _clone(address impl) internal returns (address instance) {
        bytes20 target = bytes20(impl);
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), target)
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        require(instance != address(0), "clone failed");
    }

    function _deployCurve(address distributor_) internal returns (AgentBondingCurve c, CurveMockAgentToken t) {
        c = AgentBondingCurve(_clone(address(implementation)));
        t = new CurveMockAgentToken(address(c), SUPPLY);
        vm.prank(factory);
        c.initialize(AGENT_ID, address(t), address(usdg), address(registry), distributor_, buyback, PHANTOM, THRESHOLD);
    }

    function _setUpBase() internal {
        implementation = new AgentBondingCurve();
        usdg = new CurveMockUSDG();
        registry = new CurveMockRegistry();
        registry.setTreasury(AGENT_ID, treasury);
        distributor = new CurveMockDistributor(address(usdg));
        (curve, token) = _deployCurve(address(distributor));
    }

    function _buy(address who, uint256 usdgIn, uint256 minOut) internal returns (uint256 tokensOut) {
        usdg.mint(who, usdgIn);
        vm.startPrank(who);
        usdg.approve(address(curve), usdgIn);
        tokensOut = curve.buy(usdgIn, minOut, who);
        vm.stopPrank();
    }

    function _sell(address who, uint256 tokensIn, uint256 minOut) internal returns (uint256 usdgOut) {
        vm.startPrank(who);
        token.approve(address(curve), tokensIn);
        usdgOut = curve.sell(tokensIn, minOut, who);
        vm.stopPrank();
    }

    function _k() internal view returns (uint256) {
        (uint256 real, uint256 tokens) = curve.reserves();
        return (real + PHANTOM) * tokens;
    }
}

contract AgentBondingCurveTest is CurveTestBase {
    // Values computed off-chain from the SPEC parameters.
    uint256 internal constant BUY_1000_TOKENS_OUT = 139_167_862_266_857_962_697_274_031;
    uint256 internal constant CROSSING_BUY = 43_298_969_073; // nets 42_000_000_001 USDG
    uint256 internal constant CROSSING_TOKENS_OUT = 875_000_000_002_604_166_666_612_413;

    function setUp() public {
        _setUpBase();
    }

    /*//////////////////////////////////////////////////////////////
                              INITIALIZE
    //////////////////////////////////////////////////////////////*/

    function test_Initialize_SetsState() public view {
        assertEq(curve.factory(), factory, "factory");
        assertEq(curve.agentId(), AGENT_ID, "agentId");
        assertEq(curve.agentToken(), address(token), "agentToken");
        assertEq(curve.usdg(), address(usdg), "usdg");
        assertEq(curve.registry(), address(registry), "registry");
        assertEq(curve.distributor(), address(distributor), "distributor");
        assertEq(curve.treasuryBuyback(), buyback, "buyback");
        assertEq(curve.phantomQuote(), PHANTOM, "phantom");
        assertEq(curve.graduationThreshold(), THRESHOLD, "threshold");
        assertEq(curve.TOTAL_FEE_BPS(), FEE_BPS, "fee bps");

        (uint256 real, uint256 tokens) = curve.reserves();
        assertEq(real, 0, "opening usdg reserve");
        assertEq(tokens, SUPPLY, "opening token reserve seeded from balance");
        assertFalse(curve.graduated(), "not graduated");
        assertFalse(curve.readyToGraduate(), "not ready");
    }

    function test_Initialize_OnlyOnce() public {
        vm.prank(factory);
        vm.expectRevert(AgentBondingCurve.AlreadyInitialized.selector);
        curve.initialize(
            AGENT_ID,
            address(token),
            address(usdg),
            address(registry),
            address(distributor),
            buyback,
            PHANTOM,
            THRESHOLD
        );
    }

    function test_Initialize_ImplementationIsBricked() public {
        vm.expectRevert(AgentBondingCurve.AlreadyInitialized.selector);
        implementation.initialize(
            AGENT_ID,
            address(token),
            address(usdg),
            address(registry),
            address(distributor),
            buyback,
            PHANTOM,
            THRESHOLD
        );
    }

    function test_Initialize_RevertsOnZeroAddresses() public {
        AgentBondingCurve fresh = AgentBondingCurve(_clone(address(implementation)));
        vm.expectRevert(AgentBondingCurve.ZeroAddress.selector);
        fresh.initialize(
            AGENT_ID, address(0), address(usdg), address(registry), address(distributor), buyback, PHANTOM, THRESHOLD
        );
        vm.expectRevert(AgentBondingCurve.ZeroAddress.selector);
        fresh.initialize(
            AGENT_ID,
            address(token),
            address(usdg),
            address(registry),
            address(distributor),
            address(0),
            PHANTOM,
            THRESHOLD
        );
        // A codeless token address is rejected too: transfers are low-level
        // calls, which an EOA would answer successfully and silently.
        vm.expectRevert(AgentBondingCurve.ZeroAddress.selector);
        fresh.initialize(
            AGENT_ID, alice, address(usdg), address(registry), address(distributor), buyback, PHANTOM, THRESHOLD
        );
    }

    function test_Initialize_RevertsOnZeroParams() public {
        AgentBondingCurve fresh = AgentBondingCurve(_clone(address(implementation)));
        vm.expectRevert(AgentBondingCurve.ZeroAmount.selector);
        fresh.initialize(
            0, address(token), address(usdg), address(registry), address(distributor), buyback, PHANTOM, THRESHOLD
        );
        vm.expectRevert(AgentBondingCurve.ZeroAmount.selector);
        fresh.initialize(
            AGENT_ID, address(token), address(usdg), address(registry), address(distributor), buyback, 0, THRESHOLD
        );
        vm.expectRevert(AgentBondingCurve.ZeroAmount.selector);
        fresh.initialize(
            AGENT_ID, address(token), address(usdg), address(registry), address(distributor), buyback, PHANTOM, 0
        );
    }

    function test_Initialize_RevertsWithoutTokenSupply() public {
        AgentBondingCurve fresh = AgentBondingCurve(_clone(address(implementation)));
        // Token exists but its supply went somewhere else.
        CurveMockAgentToken orphan = new CurveMockAgentToken(alice, SUPPLY);
        vm.expectRevert(AgentBondingCurve.ZeroAmount.selector);
        fresh.initialize(
            AGENT_ID,
            address(orphan),
            address(usdg),
            address(registry),
            address(distributor),
            buyback,
            PHANTOM,
            THRESHOLD
        );
    }

    function test_Trade_RevertsBeforeInitialize() public {
        AgentBondingCurve fresh = AgentBondingCurve(_clone(address(implementation)));
        vm.expectRevert(AgentBondingCurve.NotInitialized.selector);
        fresh.buy(1e6, 0, alice);
        vm.expectRevert(AgentBondingCurve.NotInitialized.selector);
        fresh.sell(1e18, 0, alice);
    }

    /*//////////////////////////////////////////////////////////////
                                  BUY
    //////////////////////////////////////////////////////////////*/

    function test_Buy_ExactValues() public {
        uint256 usdgIn = 1_000e6;
        uint256 fee = 30e6; // 3%
        uint256 net = usdgIn - fee;

        usdg.mint(alice, usdgIn);
        vm.startPrank(alice);
        usdg.approve(address(curve), usdgIn);

        vm.expectEmit(true, false, false, true, address(curve));
        emit IAgentBondingCurve.Bought(alice, usdgIn, BUY_1000_TOKENS_OUT, fee);
        uint256 tokensOut = curve.buy(usdgIn, 0, alice);
        vm.stopPrank();

        assertEq(tokensOut, BUY_1000_TOKENS_OUT, "tokens out");
        assertEq(token.balanceOf(alice), BUY_1000_TOKENS_OUT, "trader token balance");

        (uint256 real, uint256 tokens) = curve.reserves();
        assertEq(real, net, "reserve credits the net, never the fee");
        assertEq(tokens, SUPPLY - BUY_1000_TOKENS_OUT, "token reserve");
        assertEq(usdg.balanceOf(address(curve)), net, "curve holds exactly the tracked reserve");
        assertEq(token.balanceOf(address(curve)), SUPPLY - BUY_1000_TOKENS_OUT, "curve token balance matches tracking");

        // 3% split three ways, 1% each.
        assertEq(usdg.balanceOf(buyback), 10e6, "buyback leg");
        assertEq(usdg.balanceOf(treasury), 10e6, "agent treasury leg");
        assertEq(usdg.balanceOf(address(distributor)), 10e6, "royalty leg held");
        assertEq(distributor.accrued(AGENT_ID), 10e6, "royalty leg credited");
        assertEq(distributor.creditCalls(), 1, "credited once");
        assertEq(usdg.balanceOf(alice), 0, "trader spent everything");
    }

    function test_Buy_QuoteMatchesExecution() public {
        uint256 quoted = curve.quoteBuy(1_000e6);
        uint256 actual = _buy(alice, 1_000e6, 0);
        assertEq(quoted, actual, "quoteBuy must mirror buy");
    }

    function test_Buy_RecipientMayDifferFromBuyer() public {
        usdg.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usdg.approve(address(curve), 1_000e6);
        uint256 tokensOut = curve.buy(1_000e6, 0, bob);
        vm.stopPrank();

        assertEq(token.balanceOf(bob), tokensOut, "recipient receives");
        assertEq(token.balanceOf(alice), 0, "buyer receives nothing");
    }

    function test_Buy_RevertsOnSlippage() public {
        usdg.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usdg.approve(address(curve), 1_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentBondingCurve.SlippageExceeded.selector, BUY_1000_TOKENS_OUT, BUY_1000_TOKENS_OUT + 1
            )
        );
        curve.buy(1_000e6, BUY_1000_TOKENS_OUT + 1, alice);
        vm.stopPrank();
    }

    function test_Buy_AcceptsExactMinimum() public {
        _buy(alice, 1_000e6, BUY_1000_TOKENS_OUT);
        assertEq(token.balanceOf(alice), BUY_1000_TOKENS_OUT, "min == out must pass");
    }

    function test_Buy_RevertsOnZeroAmountOrRecipient() public {
        vm.expectRevert(AgentBondingCurve.ZeroAmount.selector);
        curve.buy(0, 0, alice);

        usdg.mint(alice, 1e6);
        vm.startPrank(alice);
        usdg.approve(address(curve), 1e6);
        vm.expectRevert(AgentBondingCurve.ZeroAddress.selector);
        curve.buy(1e6, 0, address(0));
        vm.stopPrank();
    }

    function test_Buy_RevertsOnFeeOnTransferUsdg() public {
        usdg.setFeeOnTransferBps(100);
        usdg.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usdg.approve(address(curve), 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(AgentBondingCurve.InexactTransfer.selector, 990e6, 1_000e6));
        curve.buy(1_000e6, 0, alice);
        vm.stopPrank();
    }

    /// @dev Fee legs must still sum to the whole fee when a third of it does
    /// not divide cleanly. The remainder rides with the royalty leg.
    function test_Buy_FeeDustGoesToRoyaltyLeg() public {
        uint256 usdgIn = 1_000_034; // fee = 30_001, not divisible by three
        _buy(alice, usdgIn, 0);

        uint256 fee = (usdgIn * FEE_BPS) / 10_000;
        assertEq(fee, 30_001, "fee");
        assertEq(usdg.balanceOf(buyback), 10_000, "buyback third");
        assertEq(usdg.balanceOf(treasury), 10_000, "treasury third");
        assertEq(distributor.accrued(AGENT_ID), 10_001, "royalty leg absorbs the dust");
        assertEq(usdg.balanceOf(buyback) + usdg.balanceOf(treasury) + distributor.accrued(AGENT_ID), fee, "legs sum");
    }

    /// @dev A fee of one or two wei leaves nothing for the first two legs; the
    /// whole fee goes to royalties rather than being stranded on the curve.
    function test_Buy_SubWeiFeeSplit() public {
        _buy(alice, 34, 0); // fee == 1
        assertEq(usdg.balanceOf(buyback), 0, "no buyback leg");
        assertEq(usdg.balanceOf(treasury), 0, "no treasury leg");
        assertEq(distributor.accrued(AGENT_ID), 1, "royalty leg takes the whole wei");

        (uint256 real,) = curve.reserves();
        assertEq(usdg.balanceOf(address(curve)), real, "no fee dust left on the curve");
    }

    /// @dev A sell too small to price out a single wei of USDG must revert
    /// rather than take the tokens for nothing.
    function test_Sell_RevertsWhenOutputRoundsToZero() public {
        _buy(alice, 1_000e6, 0);
        assertEq(curve.quoteSell(1), 0, "quote reports unpriceable");
        vm.startPrank(alice);
        token.approve(address(curve), 1);
        vm.expectRevert(CurveMath.InsufficientOutputAmount.selector);
        curve.sell(1, 0, alice);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                  SELL
    //////////////////////////////////////////////////////////////*/

    function test_Sell_ExactValues() public {
        _buy(alice, 1_000e6, 0);
        uint256 tokensIn = BUY_1000_TOKENS_OUT / 2;

        uint256 gross = 521_272_166;
        uint256 fee = 15_638_164; // 3% of gross
        uint256 expectedOut = gross - fee;

        vm.startPrank(alice);
        token.approve(address(curve), tokensIn);
        vm.expectEmit(true, false, false, true, address(curve));
        emit IAgentBondingCurve.Sold(alice, tokensIn, expectedOut, fee);
        uint256 usdgOut = curve.sell(tokensIn, 0, alice);
        vm.stopPrank();

        assertEq(usdgOut, expectedOut, "usdg out");
        assertEq(usdg.balanceOf(alice), expectedOut, "trader paid");

        (uint256 real, uint256 tokens) = curve.reserves();
        assertEq(real, 970e6 - gross, "reserve debited the gross, fee included");
        assertEq(tokens, SUPPLY - BUY_1000_TOKENS_OUT + tokensIn, "token reserve restored");
        assertEq(usdg.balanceOf(address(curve)), real, "balance tracks reserve");

        // Fees from both trades: 30e6 from the buy, 15_638_164 from the sell.
        uint256 totalFee = 30e6 + fee;
        uint256 legs = usdg.balanceOf(buyback) + usdg.balanceOf(treasury) + distributor.accrued(AGENT_ID);
        assertEq(legs, totalFee, "all fee legs across both trades");
        assertEq(usdg.balanceOf(buyback), 10e6 + fee / 3, "buyback leg");
        assertEq(usdg.balanceOf(treasury), 10e6 + fee / 3, "treasury leg");
        assertEq(distributor.accrued(AGENT_ID), 10e6 + (fee - 2 * (fee / 3)), "royalty leg");
    }

    function test_Sell_QuoteMatchesExecution() public {
        _buy(alice, 1_000e6, 0);
        uint256 tokensIn = BUY_1000_TOKENS_OUT / 2;
        uint256 quoted = curve.quoteSell(tokensIn);
        uint256 actual = _sell(alice, tokensIn, 0);
        assertEq(quoted, actual, "quoteSell must mirror sell");
    }

    function test_Sell_RevertsOnSlippage() public {
        _buy(alice, 1_000e6, 0);
        uint256 tokensIn = BUY_1000_TOKENS_OUT / 2;
        uint256 expectedOut = 521_272_166 - 15_638_164;

        vm.startPrank(alice);
        token.approve(address(curve), tokensIn);
        vm.expectRevert(
            abi.encodeWithSelector(AgentBondingCurve.SlippageExceeded.selector, expectedOut, expectedOut + 1)
        );
        curve.sell(tokensIn, expectedOut + 1, alice);
        vm.stopPrank();
    }

    function test_Sell_RevertsOnZeroAmountOrRecipient() public {
        _buy(alice, 1_000e6, 0);
        vm.expectRevert(AgentBondingCurve.ZeroAmount.selector);
        curve.sell(0, 0, alice);

        vm.startPrank(alice);
        token.approve(address(curve), 1e18);
        vm.expectRevert(AgentBondingCurve.ZeroAddress.selector);
        curve.sell(1e18, 0, address(0));
        vm.stopPrank();
    }

    /// @dev The phantom quote prices trades but backs none of them: a sell
    /// whose gross exceeds the real reserve must revert, not pay out money the
    /// curve does not have. Unreachable through curve-issued tokens alone, so
    /// the mock hands the seller tokens the curve never sold.
    function test_Sell_RevertsWhenGrossExceedsRealReserve() public {
        _buy(alice, 1_000e6, 0);
        (uint256 real, uint256 tokens) = curve.reserves();

        token.mint(bob, tokens); // doubles the token side without paying in
        uint256 gross = CurveMath.getAmountOut(tokens, tokens, real + PHANTOM, 0);
        assertGt(gross, real, "test setup must exceed the real reserve");

        vm.startPrank(bob);
        token.approve(address(curve), tokens);
        vm.expectRevert(abi.encodeWithSelector(AgentBondingCurve.InsufficientRealReserve.selector, gross, real));
        curve.sell(tokens, 0, bob);
        vm.stopPrank();

        assertEq(curve.quoteSell(tokens), 0, "quoteSell reports zero rather than reverting");
    }

    function test_Sell_RevertsWithoutTokens() public {
        _buy(alice, 1_000e6, 0);
        vm.startPrank(bob);
        token.approve(address(curve), 1e18);
        vm.expectRevert(AgentBondingCurve.TransferFailed.selector);
        curve.sell(1e18, 0, bob);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                              GRADUATION
    //////////////////////////////////////////////////////////////*/

    function test_Graduation_CrossingBuyCompletesAndClosesCurve() public {
        uint256 tokensOut = _buy(alice, CROSSING_BUY, 0);
        assertEq(tokensOut, CROSSING_TOKENS_OUT, "crossing buy is filled in full");

        (uint256 real,) = curve.reserves();
        assertEq(real, 42_000_000_001, "overshoot stays in the reserve");
        assertTrue(curve.readyToGraduate(), "ready");
        assertFalse(curve.graduated(), "not yet swept");

        // Curve closed on both sides.
        usdg.mint(bob, 1_000e6);
        vm.startPrank(bob);
        usdg.approve(address(curve), 1_000e6);
        vm.expectRevert(AgentBondingCurve.CurveClosed.selector);
        curve.buy(1_000e6, 0, bob);
        vm.stopPrank();

        vm.startPrank(alice);
        token.approve(address(curve), tokensOut);
        vm.expectRevert(AgentBondingCurve.CurveClosed.selector);
        curve.sell(tokensOut, 0, alice);
        vm.stopPrank();

        assertEq(curve.quoteBuy(1_000e6), 0, "quoteBuy zero once closed");
        assertEq(curve.quoteSell(1e18), 0, "quoteSell zero once closed");
    }

    function test_Graduation_ThresholdIsInclusive() public {
        // 43_298_969_072 nets 42_000_000_000 == THRESHOLD exactly.
        _buy(alice, 43_298_969_072, 0);
        (uint256 real,) = curve.reserves();
        assertEq(real, THRESHOLD, "exactly at the threshold");
        assertTrue(curve.readyToGraduate(), "threshold is inclusive");
    }

    function test_Graduate_SweepsTrackedReserves() public {
        _buy(alice, CROSSING_BUY, 0);
        (uint256 real, uint256 tokens) = curve.reserves();
        address pool = makeAddr("poolSeeder");

        vm.expectEmit(false, false, false, true, address(curve));
        emit IAgentBondingCurve.Graduated(real, tokens);
        vm.prank(factory);
        (uint256 usdgSwept, uint256 tokensSwept) = curve.graduate(pool);

        assertEq(usdgSwept, real, "usdg swept == tracked");
        assertEq(tokensSwept, tokens, "tokens swept == tracked");
        assertEq(usdg.balanceOf(pool), real, "usdg delivered");
        assertEq(token.balanceOf(pool), tokens, "tokens delivered");
        assertEq(usdg.balanceOf(address(curve)), 0, "curve drained");
        assertEq(token.balanceOf(address(curve)), 0, "curve drained");
        assertTrue(curve.graduated(), "graduated");

        (uint256 realAfter, uint256 tokensAfter) = curve.reserves();
        assertEq(realAfter, 0, "reserves zeroed");
        assertEq(tokensAfter, 0, "reserves zeroed");
    }

    function test_Graduate_OnlyFactory() public {
        _buy(alice, CROSSING_BUY, 0);
        vm.prank(alice);
        vm.expectRevert(AgentBondingCurve.NotFactory.selector);
        curve.graduate(alice);
    }

    function test_Graduate_RevertsBeforeThreshold() public {
        _buy(alice, 1_000e6, 0);
        vm.prank(factory);
        vm.expectRevert(AgentBondingCurve.NotReadyToGraduate.selector);
        curve.graduate(makeAddr("pool"));
    }

    function test_Graduate_OnlyOnce() public {
        _buy(alice, CROSSING_BUY, 0);
        vm.startPrank(factory);
        curve.graduate(makeAddr("pool"));
        vm.expectRevert(AgentBondingCurve.AlreadyGraduated.selector);
        curve.graduate(makeAddr("pool"));
        vm.stopPrank();
    }

    function test_Graduate_RevertsOnZeroRecipient() public {
        _buy(alice, CROSSING_BUY, 0);
        vm.prank(factory);
        vm.expectRevert(AgentBondingCurve.ZeroAddress.selector);
        curve.graduate(address(0));
    }

    function test_Graduate_ClosesTradingPermanently() public {
        _buy(alice, CROSSING_BUY, 0);
        vm.prank(factory);
        curve.graduate(makeAddr("pool"));

        usdg.mint(bob, 1_000e6);
        vm.startPrank(bob);
        usdg.approve(address(curve), 1_000e6);
        vm.expectRevert(AgentBondingCurve.CurveClosed.selector);
        curve.buy(1_000e6, 0, bob);
        vm.stopPrank();

        vm.startPrank(alice);
        token.approve(address(curve), 1e18);
        vm.expectRevert(AgentBondingCurve.CurveClosed.selector);
        curve.sell(1e18, 0, alice);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                               DONATIONS
    //////////////////////////////////////////////////////////////*/

    function test_Donation_DoesNotMovePrice() public {
        uint256 quotedBefore = curve.quoteBuy(1_000e6);

        usdg.mint(address(curve), 10_000e6);
        token.mint(address(curve), 500_000_000e18);

        (uint256 real, uint256 tokens) = curve.reserves();
        assertEq(real, 0, "donation is not reserve");
        assertEq(tokens, SUPPLY, "donation is not reserve");
        assertEq(curve.quoteBuy(1_000e6), quotedBefore, "price unmoved");

        uint256 tokensOut = _buy(alice, 1_000e6, 0);
        assertEq(tokensOut, BUY_1000_TOKENS_OUT, "execution unmoved");
    }

    function test_Donation_CannotForceGraduation() public {
        usdg.mint(address(curve), THRESHOLD * 2);
        assertFalse(curve.readyToGraduate(), "donations cannot trigger graduation");
        vm.prank(factory);
        vm.expectRevert(AgentBondingCurve.NotReadyToGraduate.selector);
        curve.graduate(makeAddr("pool"));
    }

    function test_Donation_IsStrandedAtGraduation() public {
        _buy(alice, CROSSING_BUY, 0);
        uint256 usdgDonation = 1_234e6;
        uint256 tokenDonation = 5_678e18;
        usdg.mint(address(curve), usdgDonation);
        token.mint(address(curve), tokenDonation);

        (uint256 real, uint256 tokens) = curve.reserves();
        address pool = makeAddr("pool");
        vm.prank(factory);
        (uint256 usdgSwept, uint256 tokensSwept) = curve.graduate(pool);

        assertEq(usdgSwept, real, "sweep ignores donated usdg");
        assertEq(tokensSwept, tokens, "sweep ignores donated tokens");
        assertEq(usdg.balanceOf(address(curve)), usdgDonation, "donation stays stranded");
        assertEq(token.balanceOf(address(curve)), tokenDonation, "donation stays stranded");
    }

    /*//////////////////////////////////////////////////////////////
                             REENTRANCY
    //////////////////////////////////////////////////////////////*/

    /// @dev Arms the hostile distributor only after an opening trade, so the
    /// re-entry attempt fires from inside the fee split of the trade under
    /// test (a sell for mode 1, a buy otherwise).
    function _reenterCase(uint8 mode) internal returns (CurveReenteringDistributor hostile) {
        hostile = new CurveReenteringDistributor(address(usdg));
        (AgentBondingCurve c, CurveMockAgentToken t) = _deployCurve(address(hostile));

        usdg.mint(alice, 10_000e6);
        vm.startPrank(alice);
        usdg.approve(address(c), type(uint256).max);
        c.buy(1_000e6, 0, alice);

        hostile.arm(address(c), mode);
        if (mode == 1) {
            t.approve(address(c), type(uint256).max);
            c.sell(t.balanceOf(alice) / 2, 0, alice);
        } else {
            c.buy(1_000e6, 0, alice);
        }
        vm.stopPrank();
    }

    function test_Reentrancy_BuyFromCreditCallbackIsBlocked() public {
        CurveReenteringDistributor hostile = _reenterCase(0);
        assertTrue(hostile.attempted(), "callback ran");
        assertFalse(hostile.succeeded(), "reentrant buy must fail");
        assertEq(bytes4(hostile.lastError()), AgentBondingCurve.Reentrancy.selector, "guard, not an incidental revert");
    }

    function test_Reentrancy_SellFromCreditCallbackIsBlocked() public {
        CurveReenteringDistributor hostile = _reenterCase(1);
        assertTrue(hostile.attempted(), "callback ran");
        assertFalse(hostile.succeeded(), "reentrant sell must fail");
        assertEq(bytes4(hostile.lastError()), AgentBondingCurve.Reentrancy.selector, "guard, not an incidental revert");
    }

    function test_Reentrancy_GraduateFromCreditCallbackIsBlocked() public {
        CurveReenteringDistributor hostile = _reenterCase(2);
        assertTrue(hostile.attempted(), "callback ran");
        assertFalse(hostile.succeeded(), "reentrant graduate must fail");
        assertEq(bytes4(hostile.lastError()), AgentBondingCurve.NotFactory.selector, "factory-only");
    }

    /*//////////////////////////////////////////////////////////////
                                  FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev (a) the three legs sum to exactly the fee, and the fee is exactly
    /// 3% of the USDG side rounded down.
    function testFuzz_BuyFeeLegsSumExactly(uint256 usdgIn) public {
        usdgIn = bound(usdgIn, 1, THRESHOLD - 1);
        _buy(alice, usdgIn, 0);

        uint256 fee = (usdgIn * FEE_BPS) / 10_000;
        uint256 third = fee / 3;
        assertEq(usdg.balanceOf(buyback), third, "buyback leg is a third");
        assertEq(usdg.balanceOf(treasury), third, "treasury leg is a third");
        assertEq(distributor.accrued(AGENT_ID), fee - third - third, "royalty leg is the remainder");
        assertEq(
            usdg.balanceOf(buyback) + usdg.balanceOf(treasury) + distributor.accrued(AGENT_ID), fee, "legs sum to fee"
        );
        assertLe(fee - third - third - third, 2, "dust is at most two wei");

        (uint256 real,) = curve.reserves();
        assertEq(usdg.balanceOf(address(curve)), real, "no fee residue on the curve");
        assertEq(real, usdgIn - fee, "reserve is the net");
    }

    function testFuzz_SellFeeLegsSumExactly(uint256 usdgIn, uint256 sellBps) public {
        usdgIn = bound(usdgIn, 1e6, 10_000e6);
        sellBps = bound(sellBps, 1, 10_000);

        uint256 bought = _buy(alice, usdgIn, 0);
        uint256 buyFee = (usdgIn * FEE_BPS) / 10_000;

        uint256 tokensIn = (bought * sellBps) / 10_000;
        vm.assume(tokensIn != 0);
        vm.assume(curve.quoteSell(tokensIn) != 0);

        uint256 usdgOut = _sell(alice, tokensIn, 0);

        uint256 legs = usdg.balanceOf(buyback) + usdg.balanceOf(treasury) + distributor.accrued(AGENT_ID);
        // Gross is recoverable from the payout: legs across both trades must
        // equal the buy fee plus 3% of this sell's gross.
        uint256 grossOut = usdgOut + (legs - buyFee);
        assertEq(legs - buyFee, (grossOut * FEE_BPS) / 10_000, "sell fee is 3% of gross, rounded down");
        assertEq(usdg.balanceOf(address(curve)) + usdgOut + legs, usdgIn, "every wei accounted for");
    }

    /// @dev (b) k never decreases across trades.
    function testFuzz_KNeverDecreases(uint256 usdgIn, uint256 sellBps) public {
        usdgIn = bound(usdgIn, 1e6, 20_000e6);
        sellBps = bound(sellBps, 1, 10_000);

        uint256 kStart = _k();
        uint256 bought = _buy(alice, usdgIn, 0);
        uint256 kAfterBuy = _k();
        assertGe(kAfterBuy, kStart, "k fell on buy");

        uint256 tokensIn = (bought * sellBps) / 10_000;
        vm.assume(tokensIn != 0);
        vm.assume(curve.quoteSell(tokensIn) != 0);
        _sell(alice, tokensIn, 0);
        assertGe(_k(), kAfterBuy, "k fell on sell");
    }

    /// @dev (c) the curve's USDG balance always covers the tracked reserve.
    /// @dev (d) a buy-then-sell round trip never returns more than it took.
    function testFuzz_RoundTripNeverProfits(uint256 usdgIn) public {
        usdgIn = bound(usdgIn, 1e4, 20_000e6);
        uint256 bought = _buy(alice, usdgIn, 0);
        vm.assume(curve.quoteSell(bought) != 0);

        uint256 usdgOut = _sell(alice, bought, 0);
        assertLe(usdgOut, usdgIn, "round trip profited the trader");

        (uint256 real,) = curve.reserves();
        assertGe(usdg.balanceOf(address(curve)), real, "balance must cover the tracked reserve");
    }

    /// @dev (e) whatever sequence of trades gets there, the sweep hands over
    /// exactly the tracked reserves and nothing else.
    function testFuzz_SweptAmountsEqualTrackedReserves(uint256 seed) public {
        uint256 totalIn;
        for (uint256 i = 0; i < 12; i++) {
            if (curve.readyToGraduate()) break;
            uint256 amount = bound(uint256(keccak256(abi.encode(seed, i))), 1e6, 8_000e6);
            uint256 bought = _buy(alice, amount, 0);
            totalIn += amount;

            if (i % 3 == 2 && !curve.readyToGraduate()) {
                uint256 tokensIn = bought / 4;
                if (tokensIn != 0 && curve.quoteSell(tokensIn) != 0) _sell(alice, tokensIn, 0);
            }
        }
        // Finish the job so graduation is always reachable.
        while (!curve.readyToGraduate()) {
            uint256 amount = 8_000e6;
            _buy(alice, amount, 0);
            totalIn += amount;
        }

        (uint256 real, uint256 tokens) = curve.reserves();
        address pool = makeAddr("pool");
        vm.prank(factory);
        (uint256 usdgSwept, uint256 tokensSwept) = curve.graduate(pool);

        assertEq(usdgSwept, real, "swept usdg == tracked");
        assertEq(tokensSwept, tokens, "swept tokens == tracked");
        assertEq(usdg.balanceOf(pool), usdgSwept, "delivered");
        assertEq(token.balanceOf(pool), tokensSwept, "delivered");
        assertEq(usdg.balanceOf(address(curve)), 0, "nothing left behind");
        assertEq(token.balanceOf(address(curve)) + tokensSwept + token.balanceOf(alice), SUPPLY, "token supply closes");
        assertEq(
            usdgSwept + usdg.balanceOf(alice) + usdg.balanceOf(buyback) + usdg.balanceOf(treasury)
                + usdg.balanceOf(address(distributor)),
            totalIn,
            "usdg closes"
        );
    }
}

/*//////////////////////////////////////////////////////////////
                        INVARIANT SUITE
//////////////////////////////////////////////////////////////*/

/// @notice Drives random buy/sell sequences and records per-trade violations.
contract CurveHandler is Test {
    AgentBondingCurve public curve;
    CurveMockUSDG public usdg;
    CurveMockAgentToken public token;
    CurveMockDistributor public distributor;
    address public buyback;
    address public treasury;
    uint256 public agentId;

    address[3] public actors;

    uint256 public totalFeesCharged;
    uint256 public totalUsdgIn;
    uint256 public buys;
    uint256 public sells;

    bool public feeSplitViolated;
    bool public kDecreased;
    uint256 public lastK;

    constructor(
        AgentBondingCurve curve_,
        CurveMockUSDG usdg_,
        CurveMockAgentToken token_,
        CurveMockDistributor distributor_,
        address buyback_,
        address treasury_,
        uint256 agentId_
    ) {
        curve = curve_;
        usdg = usdg_;
        token = token_;
        distributor = distributor_;
        buyback = buyback_;
        treasury = treasury_;
        agentId = agentId_;
        actors = [makeAddr("h1"), makeAddr("h2"), makeAddr("h3")];
        lastK = _k();
    }

    function _k() internal view returns (uint256) {
        (uint256 real, uint256 tokens) = curve.reserves();
        return (real + curve.phantomQuote()) * tokens;
    }

    function _legs() internal view returns (uint256) {
        return usdg.balanceOf(buyback) + usdg.balanceOf(treasury) + distributor.accrued(agentId);
    }

    function _record(uint256 fee, uint256 legsBefore) internal {
        totalFeesCharged += fee;
        if (_legs() - legsBefore != fee) feeSplitViolated = true;
        uint256 k = _k();
        if (k < lastK) kDecreased = true;
        lastK = k;
    }

    function buy(uint256 actorSeed, uint256 amount) external {
        if (curve.readyToGraduate() || curve.graduated()) return;
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 1e4, 1_000e6);
        if (curve.quoteBuy(amount) == 0) return;

        uint256 fee = (amount * curve.TOTAL_FEE_BPS()) / 10_000;
        uint256 legsBefore = _legs();

        usdg.mint(actor, amount);
        vm.startPrank(actor);
        usdg.approve(address(curve), amount);
        curve.buy(amount, 0, actor);
        vm.stopPrank();

        totalUsdgIn += amount;
        buys++;
        _record(fee, legsBefore);
    }

    function sell(uint256 actorSeed, uint256 bps) external {
        if (curve.readyToGraduate() || curve.graduated()) return;
        address actor = actors[actorSeed % actors.length];
        uint256 balance = token.balanceOf(actor);
        if (balance == 0) return;
        uint256 tokensIn = (balance * bound(bps, 1, 10_000)) / 10_000;
        if (tokensIn == 0 || curve.quoteSell(tokensIn) == 0) return;

        uint256 gross = CurveMath.quoteAmountOut(tokensIn, _tokenReserve(), _realReserve() + curve.phantomQuote(), 0);
        uint256 fee = (gross * curve.TOTAL_FEE_BPS()) / 10_000;
        uint256 legsBefore = _legs();

        vm.startPrank(actor);
        token.approve(address(curve), tokensIn);
        curve.sell(tokensIn, 0, actor);
        vm.stopPrank();

        sells++;
        _record(fee, legsBefore);
    }

    function _realReserve() internal view returns (uint256 real) {
        (real,) = curve.reserves();
    }

    function _tokenReserve() internal view returns (uint256 tokens) {
        (, tokens) = curve.reserves();
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }
}

contract AgentBondingCurveInvariantTest is CurveTestBase {
    CurveHandler internal handler;

    function setUp() public {
        _setUpBase();
        handler = new CurveHandler(curve, usdg, token, distributor, buyback, treasury, AGENT_ID);

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = CurveHandler.buy.selector;
        selectors[1] = CurveHandler.sell.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 48
    function invariant_TrackedReservesMatchBalances() public view {
        (uint256 real, uint256 tokens) = curve.reserves();
        // No donations happen in this run, so the curve holds exactly what it tracks.
        assertEq(usdg.balanceOf(address(curve)), real, "usdg balance drifted from the tracked reserve");
        assertEq(token.balanceOf(address(curve)), tokens, "token balance drifted from the tracked reserve");
    }

    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 48
    function invariant_FeeLegsSumToTotalFees() public view {
        uint256 legs = usdg.balanceOf(buyback) + usdg.balanceOf(treasury) + distributor.accrued(AGENT_ID);
        assertEq(legs, handler.totalFeesCharged(), "fee legs drifted from the total fee charged");
        assertEq(usdg.balanceOf(address(distributor)), distributor.accrued(AGENT_ID), "royalty leg funded on credit");
        assertFalse(handler.feeSplitViolated(), "a trade's legs did not sum to its fee");
    }

    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 48
    function invariant_KNeverDecreases() public view {
        assertFalse(handler.kDecreased(), "k fell across a trade");
    }

    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 48
    function invariant_UsdgIsConserved() public view {
        uint256 held = usdg.balanceOf(address(curve)) + usdg.balanceOf(buyback) + usdg.balanceOf(treasury)
            + usdg.balanceOf(address(distributor));
        for (uint256 i = 0; i < 3; i++) {
            held += usdg.balanceOf(handler.actorAt(i));
        }
        assertEq(held, handler.totalUsdgIn(), "usdg left the known set of addresses");
    }

    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 48
    function invariant_TokensAreConserved() public view {
        uint256 held = token.balanceOf(address(curve));
        for (uint256 i = 0; i < 3; i++) {
            held += token.balanceOf(handler.actorAt(i));
        }
        assertEq(held, SUPPLY, "agent tokens left the known set of addresses");
    }
}
