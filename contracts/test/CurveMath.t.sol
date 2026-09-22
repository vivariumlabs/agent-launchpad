// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurveMath} from "../src/libraries/CurveMath.sol";

/// @dev Library calls are inlined, so the reverting cases need an external
/// boundary for `expectRevert` to catch.
contract CurveMathHarness {
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        external
        pure
        returns (uint256)
    {
        return CurveMath.getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
    }

    function quoteAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        external
        pure
        returns (uint256)
    {
        return CurveMath.quoteAmountOut(amountIn, reserveIn, reserveOut, feeBps);
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        external
        pure
        returns (uint256)
    {
        return CurveMath.getAmountIn(amountOut, reserveIn, reserveOut, feeBps);
    }
}

contract CurveMathTest is Test {
    CurveMathHarness internal math;

    // Launch parameters from SPEC-M1.md.
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant PHANTOM = 6_000e6;

    function setUp() public {
        math = new CurveMathHarness();
    }

    /*//////////////////////////////////////////////////////////////
                              getAmountOut
    //////////////////////////////////////////////////////////////*/

    function test_GetAmountOut_ExactValue_FreshCurve() public view {
        // 1_000e6 USDG in, 3% taken outside the library => 970e6 priced.
        uint256 amountOut = math.getAmountOut(970e6, PHANTOM, SUPPLY, 0);
        assertEq(amountOut, 139_167_862_266_857_962_697_274_031, "fresh-curve buy quote");
        // Same number the plain constant-product formula gives.
        assertEq(amountOut, (970e6 * SUPPLY) / (PHANTOM + 970e6), "matches x*y/k");
    }

    function test_GetAmountOut_FeeBpsReducesOutput() public view {
        uint256 withoutFee = math.getAmountOut(1_000e6, PHANTOM, SUPPLY, 0);
        uint256 withFee = math.getAmountOut(1_000e6, PHANTOM, SUPPLY, 300);
        assertLt(withFee, withoutFee, "input-side fee must reduce output");
        // The curve nets the USDG leg itself and prices at feeBps = 0. Where
        // the fee divides exactly, the two routes agree to the wei.
        assertEq(withFee, math.getAmountOut(970e6, PHANTOM, SUPPLY, 0), "netting outside == feeBps inside");
    }

    /// @dev Where the fee does not divide exactly, netting the input outside
    /// the library (what the curve does) leaves the trader the truncated wei
    /// rather than the curve. Documented, not accidental.
    function test_GetAmountOut_NettedInputIsNotWorseForTrader() public view {
        uint256 amountIn = 34; // 34 * 300 / 10_000 == 1 (0.02 truncated away)
        uint256 net = amountIn - (amountIn * 300) / 10_000;
        assertGe(
            math.quoteAmountOut(net, PHANTOM, SUPPLY, 0),
            math.quoteAmountOut(amountIn, PHANTOM, SUPPLY, 300),
            "netted route must not be worse for the trader"
        );
    }

    function test_GetAmountOut_RevertsOnZeroInput() public {
        vm.expectRevert(CurveMath.InsufficientInputAmount.selector);
        math.getAmountOut(0, PHANTOM, SUPPLY, 0);
    }

    function test_GetAmountOut_RevertsOnEmptyReserves() public {
        vm.expectRevert(CurveMath.InsufficientLiquidity.selector);
        math.getAmountOut(1e6, 0, SUPPLY, 0);

        vm.expectRevert(CurveMath.InsufficientLiquidity.selector);
        math.getAmountOut(1e6, PHANTOM, 0, 0);
    }

    function test_GetAmountOut_RevertsWhenOutputRoundsToZero() public {
        // One wei of a huge-decimal input against a tiny output reserve.
        vm.expectRevert(CurveMath.InsufficientOutputAmount.selector);
        math.getAmountOut(1, 1e27, 1e6, 0);
    }

    function test_GetAmountOut_NeverDrainsOutputReserve() public view {
        uint256 amountOut = math.getAmountOut(type(uint128).max, PHANTOM, SUPPLY, 0);
        assertLt(amountOut, SUPPLY, "constant product can never empty a reserve");
    }

    /*//////////////////////////////////////////////////////////////
                             quoteAmountOut
    //////////////////////////////////////////////////////////////*/

    function test_QuoteAmountOut_MatchesGetAmountOut() public view {
        assertEq(math.quoteAmountOut(970e6, PHANTOM, SUPPLY, 0), math.getAmountOut(970e6, PHANTOM, SUPPLY, 0));
    }

    function test_QuoteAmountOut_ReturnsZeroWhereGetAmountOutReverts() public view {
        assertEq(math.quoteAmountOut(0, PHANTOM, SUPPLY, 0), 0, "zero input");
        assertEq(math.quoteAmountOut(1e6, 0, SUPPLY, 0), 0, "empty input reserve");
        assertEq(math.quoteAmountOut(1e6, PHANTOM, 0, 0), 0, "empty output reserve");
        assertEq(math.quoteAmountOut(1e6, PHANTOM, SUPPLY, 10_000), 0, "full fee");
    }

    /*//////////////////////////////////////////////////////////////
                              getAmountIn
    //////////////////////////////////////////////////////////////*/

    function test_GetAmountIn_RoundTripsUpward() public view {
        uint256 want = 1_000e18;
        uint256 amountIn = math.getAmountIn(want, PHANTOM, SUPPLY, 0);
        assertGe(math.getAmountOut(amountIn, PHANTOM, SUPPLY, 0), want, "input must cover the requested output");
    }

    function test_GetAmountIn_RevertsOnZeroOutput() public {
        vm.expectRevert(CurveMath.InsufficientOutputAmount.selector);
        math.getAmountIn(0, PHANTOM, SUPPLY, 0);
    }

    function test_GetAmountIn_RevertsWhenOutputExceedsReserve() public {
        vm.expectRevert(CurveMath.InsufficientLiquidity.selector);
        math.getAmountIn(SUPPLY, PHANTOM, SUPPLY, 0);
    }

    function test_GetAmountIn_RevertsOnFullFee() public {
        vm.expectRevert(CurveMath.InsufficientLiquidity.selector);
        math.getAmountIn(1e18, PHANTOM, SUPPLY, 10_000);
    }

    /*//////////////////////////////////////////////////////////////
                                  FUZZ
    //////////////////////////////////////////////////////////////*/

    /// @dev k must never fall: the product of reserves after a trade is at
    /// least what it was before. This is the property the curve's own
    /// invariant suite leans on.
    function testFuzz_KNeverDecreases(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public view {
        amountIn = bound(amountIn, 1, 1e30);
        reserveIn = bound(reserveIn, 1e6, 1e30);
        reserveOut = bound(reserveOut, 1e6, 1e30);

        uint256 amountOut = math.quoteAmountOut(amountIn, reserveIn, reserveOut, 0);
        vm.assume(amountOut != 0);
        assertLt(amountOut, reserveOut, "output reserve is never emptied");
        assertGe((reserveIn + amountIn) * (reserveOut - amountOut), reserveIn * reserveOut, "k decreased");
    }

    /// @dev More in never buys less out, at a strictly worse marginal price.
    function testFuzz_MonotonicInAmountIn(uint256 a, uint256 b) public view {
        a = bound(a, 1e6, 1e24);
        b = bound(b, 1e6, 1e24);
        (uint256 lo, uint256 hi) = a <= b ? (a, b) : (b, a);
        assertLe(
            math.quoteAmountOut(lo, PHANTOM, SUPPLY, 0),
            math.quoteAmountOut(hi, PHANTOM, SUPPLY, 0),
            "output must be monotonic in input"
        );
    }

    /// @dev Selling the output straight back can never return more than the
    /// original input: the rounding always favours the curve.
    function testFuzz_RoundTripNeverProfits(uint256 amountIn) public view {
        amountIn = bound(amountIn, 1e3, 100_000e6);
        uint256 reserveIn = PHANTOM;
        uint256 reserveOut = SUPPLY;

        uint256 out = math.quoteAmountOut(amountIn, reserveIn, reserveOut, 0);
        vm.assume(out != 0);
        uint256 back = math.quoteAmountOut(out, reserveOut - out, reserveIn + amountIn, 0);
        assertLe(back, amountIn, "round trip returned more than it took");
    }

    function testFuzz_GetAmountInCoversRequestedOutput(uint256 amountOut) public view {
        amountOut = bound(amountOut, 1e12, SUPPLY / 2);
        uint256 amountIn = math.getAmountIn(amountOut, PHANTOM, SUPPLY, 0);
        assertGe(math.getAmountOut(amountIn, PHANTOM, SUPPLY, 0), amountOut, "under-quoted input");
    }
}
