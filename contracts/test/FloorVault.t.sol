// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {FloorVault} from "../src/FloorVault.sol";
import {IFloorVault} from "../src/interfaces/ILaunchpad.sol";
import {MockPlatformToken} from "../script/support/MockPlatformToken.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {
    FloorMockToken,
    FloorFeeOnTransferToken,
    FloorNoOpBurnToken,
    FloorDeadBurnToken,
    FloorReentrantToken
} from "./mocks/FloorVaultMocks.sol";

/// @notice Unit tests for FloorVault (D18, SPEC-M4G §1).
contract FloorVaultTest is Test {
    uint256 constant SUPPLY = 1_000_000_000e18;

    MockUSDG usdg;
    MockPlatformToken token;
    FloorVault vault;

    address holder = makeAddr("holder");
    address alice = makeAddr("alice");
    address donor = makeAddr("donor");

    function setUp() public {
        usdg = new MockUSDG();
        token = new MockPlatformToken(holder);
        vault = new FloorVault(address(usdg), address(token));

        vm.prank(holder);
        token.approve(address(vault), type(uint256).max);
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    function _donate(uint256 amount) internal {
        usdg.mint(donor, amount);
        vm.prank(donor);
        usdg.transfer(address(vault), amount);
    }

    function _redeem(address who, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return vault.redeem(amount);
    }

    // -----------------------------------------------------------------------
    // constructor
    // -----------------------------------------------------------------------

    function test_constructor_setsImmutables() public view {
        assertEq(vault.usdg(), address(usdg));
        assertEq(vault.token(), address(token));
        assertEq(vault.totalRedeemedUsdg(), 0);
        assertEq(vault.totalBurned(), 0);
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(holder), SUPPLY);
        assertEq(token.name(), "Vivarium Test Platform Token");
        assertEq(token.symbol(), "tVIV");
        assertEq(token.decimals(), 18);
    }

    function test_constructor_rejectsZeroUsdg() public {
        vm.expectRevert(FloorVault.ZeroAddress.selector);
        new FloorVault(address(0), address(token));
    }

    function test_constructor_rejectsZeroToken() public {
        vm.expectRevert(FloorVault.ZeroAddress.selector);
        new FloorVault(address(usdg), address(0));
    }

    function test_constructor_rejectsNon18DecimalToken() public {
        FloorMockToken six = new FloorMockToken(6);
        vm.expectRevert(FloorVault.WrongDecimals.selector);
        new FloorVault(address(usdg), address(six));

        FloorMockToken nineteen = new FloorMockToken(19);
        vm.expectRevert(FloorVault.WrongDecimals.selector);
        new FloorVault(address(usdg), address(nineteen));
    }

    function test_noAdminSurface() public {
        bytes[4] memory calls = [
            abi.encodeWithSignature("owner()"),
            abi.encodeWithSignature("withdraw(uint256)", 1),
            abi.encodeWithSignature("sweep(address)", address(usdg)),
            abi.encodeWithSignature("rescue(address,uint256)", address(usdg), 1)
        ];
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok,) = address(vault).call(calls[i]);
            assertFalse(ok, "unexpected admin entrypoint");
        }
    }

    // -----------------------------------------------------------------------
    // redeem
    // -----------------------------------------------------------------------

    function test_redeem_happyPath() public {
        _donate(1_000e6);
        uint256 amount = SUPPLY / 10;
        uint256 expected = 100e6; // 10% of the vault

        assertEq(vault.quoteRedeem(amount), expected, "quote");

        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20Transfer.Transfer(address(vault), address(0), amount);
        vm.expectEmit(true, false, false, true, address(vault));
        emit IFloorVault.Redeemed(holder, amount, expected);
        uint256 paid = _redeem(holder, amount);

        assertEq(paid, expected, "payout");
        assertEq(usdg.balanceOf(holder), expected, "holder USDG");
        assertEq(usdg.balanceOf(address(vault)), 900e6, "vault USDG");
        assertEq(token.totalSupply(), SUPPLY - amount, "supply not reduced");
        assertEq(token.balanceOf(holder), SUPPLY - amount, "holder tokens");
        assertEq(token.balanceOf(address(vault)), 0, "vault kept tokens");
        assertEq(vault.totalRedeemedUsdg(), expected);
        assertEq(vault.totalBurned(), amount);

        // second redemption: cumulative views
        uint256 paid2 = _redeem(holder, amount);
        assertEq(paid2, Math.mulDiv(amount, 900e6, SUPPLY - amount), "second payout");
        (uint256 b, uint256 s, uint256 redeemed, uint256 burned) = vault.state();
        assertEq(b, 900e6 - paid2);
        assertEq(s, SUPPLY - 2 * amount);
        assertEq(redeemed, expected + paid2);
        assertEq(burned, 2 * amount);
    }

    function test_redeem_zeroAmountReverts() public {
        _donate(1_000e6);
        vm.expectRevert(FloorVault.ZeroAmount.selector);
        _redeem(holder, 0);
    }

    /// @dev Dust amount against a funded vault: 1 wei of $TOKEN is worth 0 USDG base units.
    function test_redeem_zeroPayoutDust() public {
        _donate(1_000e6);
        vm.expectRevert(FloorVault.ZeroPayout.selector);
        _redeem(holder, 1);
        // the largest amount that still rounds to zero: floor(a * B / S) == 0 <=> a * B < S
        uint256 a = (SUPPLY - 1) / 1_000e6;
        assertEq(vault.quoteRedeem(a), 0);
        vm.expectRevert(FloorVault.ZeroPayout.selector);
        _redeem(holder, a);
        assertEq(vault.quoteRedeem(a + 1), 1);
    }

    /// @dev A meaningful amount against a vault holding 1 wei of USDG.
    function test_redeem_zeroPayoutTinyVault() public {
        _donate(1);
        vm.expectRevert(FloorVault.ZeroPayout.selector);
        _redeem(holder, SUPPLY / 10);
        // the whole supply is worth the single wei
        assertEq(vault.quoteRedeem(SUPPLY), 1);
    }

    function test_redeem_emptyVaultReverts() public {
        vm.expectRevert(FloorVault.ZeroPayout.selector);
        _redeem(holder, SUPPLY);
        assertEq(token.balanceOf(holder), SUPPLY);
    }

    function test_redeem_withoutApprovalReverts() public {
        _donate(1_000e6);
        vm.prank(holder);
        token.transfer(alice, 1e24);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, 1e24)
        );
        _redeem(alice, 1e24);
    }

    function test_redeem_moreThanBalanceReverts() public {
        _donate(1_000e6);
        vm.prank(holder);
        token.transfer(alice, 1e24);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 1e24, 1e24 + 1));
        _redeem(alice, 1e24 + 1);
    }

    function test_redeem_entireSupplyDrainsVaultToZero() public {
        _donate(1_234_567_891);
        uint256 paid = _redeem(holder, SUPPLY);
        assertEq(paid, 1_234_567_891, "did not receive the whole vault");
        assertEq(usdg.balanceOf(address(vault)), 0, "vault not drained");
        assertEq(token.totalSupply(), 0);
        assertEq(vault.floorPrice(), 0, "floor undefined at S == 0");
        assertEq(vault.quoteRedeem(1e18), 0);
        (uint256 b, uint256 s,,) = vault.state();
        assertEq(b, 0);
        assertEq(s, 0);
    }

    function test_donationRaisesFloorAndPayout() public {
        _donate(1_000e6);
        uint256 floor0 = vault.floorPrice();
        uint256 quote0 = vault.quoteRedeem(1e24);

        _donate(500e6); // a plain USDG transfer is a donation
        assertGt(vault.floorPrice(), floor0, "floor did not rise");
        assertGt(vault.quoteRedeem(1e24), quote0, "payout did not rise");
        assertEq(vault.quoteRedeem(1e24), Math.mulDiv(1e24, 1_500e6, SUPPLY));
    }

    // -----------------------------------------------------------------------
    // burnStray
    // -----------------------------------------------------------------------

    function test_burnStray_raisesFloorAndIsNotCountedAsRedeemed() public {
        _donate(1_000e6);
        uint256 floor0 = vault.floorPrice();

        vm.prank(holder);
        token.transfer(address(vault), SUPPLY / 2); // stray: a plain transfer, not a redeem
        assertEq(vault.floorPrice(), floor0, "a stray send moves B/S");

        vm.expectEmit(true, false, false, true, address(vault));
        emit IFloorVault.StrayBurned(alice, SUPPLY / 2);
        vm.prank(alice); // permissionless
        uint256 burned = vault.burnStray();

        assertEq(burned, SUPPLY / 2);
        assertEq(token.totalSupply(), SUPPLY / 2);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(vault.floorPrice(), 2 * floor0, "floor did not double");
        assertEq(vault.totalBurned(), 0, "stray counted in totalBurned");
        assertEq(vault.totalRedeemedUsdg(), 0);
        assertEq(usdg.balanceOf(address(vault)), 1_000e6, "burnStray moved USDG");
    }

    function test_burnStray_zeroWhenNoneReverts() public {
        vm.expectRevert(FloorVault.ZeroAmount.selector);
        vault.burnStray();
    }

    // -----------------------------------------------------------------------
    // views
    // -----------------------------------------------------------------------

    /// @dev B = 1 USDG, S = 1e9 whole tokens => 1e-9 USDG = 1e-3 base units per token
    ///      => floorPrice = 1e-3 * 1e18 = 1e15.
    function test_floorPrice_scalingGolden() public {
        _donate(1e6);
        assertEq(vault.floorPrice(), 1e15);

        _donate(999e6); // B = 1,000 USDG => 1 base unit per token
        assertEq(vault.floorPrice(), 1e18);
    }

    function test_floorPrice_zeroSupply() public {
        FloorMockToken t = new FloorMockToken(18);
        FloorVault v = new FloorVault(address(usdg), address(t));
        usdg.mint(address(v), 1e6);
        assertEq(v.floorPrice(), 0);
        assertEq(v.quoteRedeem(1), 0);
        vm.expectRevert(FloorVault.ZeroPayout.selector);
        v.redeem(1);
    }

    // -----------------------------------------------------------------------
    // hostile tokens
    // -----------------------------------------------------------------------

    function _hostileVault(FloorMockToken t) internal returns (FloorVault v) {
        v = new FloorVault(address(usdg), address(t));
        t.mint(holder, SUPPLY);
        usdg.mint(address(v), 1_000e6);
        vm.prank(holder);
        t.approve(address(v), type(uint256).max);
    }

    function test_hostile_feeOnTransferRevertsInexact() public {
        FloorFeeOnTransferToken t = new FloorFeeOnTransferToken();
        FloorVault v = _hostileVault(t);
        uint256 amount = 1e24;
        vm.expectRevert(
            abi.encodeWithSelector(FloorVault.InexactTransfer.selector, address(t), amount, amount - amount / 100)
        );
        vm.prank(holder);
        v.redeem(amount);
    }

    function test_hostile_noOpBurnRevertsBurnFailed() public {
        FloorNoOpBurnToken t = new FloorNoOpBurnToken();
        FloorVault v = _hostileVault(t);
        vm.expectRevert(FloorVault.BurnFailed.selector);
        vm.prank(holder);
        v.redeem(1e24);

        vm.prank(holder);
        t.transfer(address(v), 1e24);
        vm.expectRevert(FloorVault.BurnFailed.selector);
        v.burnStray();
    }

    function test_hostile_deadAddressBurnRevertsBurnFailed() public {
        FloorDeadBurnToken t = new FloorDeadBurnToken();
        FloorVault v = _hostileVault(t);
        vm.expectRevert(FloorVault.BurnFailed.selector);
        vm.prank(holder);
        v.redeem(1e24);

        vm.prank(holder);
        t.transfer(address(v), 1e24);
        vm.expectRevert(FloorVault.BurnFailed.selector);
        v.burnStray();
    }

    function test_hostile_reentrantTransferFromHitsGuard() public {
        FloorReentrantToken t = new FloorReentrantToken();
        FloorVault v = _hostileVault(t);
        t.arm(address(v), abi.encodeCall(IFloorVault.redeem, (1e24)));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(holder);
        v.redeem(1e24);

        t.arm(address(v), abi.encodeCall(IFloorVault.burnStray, ()));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(holder);
        v.redeem(1e24);

        // disarmed (a reverted re-entry rolls back the token's own disarm), it behaves
        t.arm(address(0), "");
        vm.prank(holder);
        assertEq(v.redeem(1e24), Math.mulDiv(1e24, 1_000e6, SUPPLY));
    }

    // -----------------------------------------------------------------------
    // gas
    // -----------------------------------------------------------------------

    /// @dev Recorded, not gated tightly: the first redeem pays the cold zero->nonzero writes of
    ///      both cumulative counters; later ones are the steady-state cost.
    function test_redeem_gas() public {
        _donate(1_000e6);
        vm.prank(holder);
        token.transfer(alice, 1e26);
        vm.startPrank(alice);
        token.approve(address(vault), type(uint256).max);
        uint256 g = gasleft();
        vault.redeem(1e25);
        uint256 first = g - gasleft();
        g = gasleft();
        vault.redeem(1e25);
        uint256 steady = g - gasleft();
        vm.stopPrank();
        console2.log("FloorVault.redeem gas, first (cold counters):", first);
        console2.log("FloorVault.redeem gas, steady state         :", steady);
        assertLt(first, 200_000, "redeem gas regression");
        assertLt(steady, first, "steady state not cheaper");
    }

    // -----------------------------------------------------------------------
    // fuzz: the R3 properties
    // -----------------------------------------------------------------------

    function testFuzz_redeem_exactProRataAndFloorNeverFalls(uint256 b, uint256 amount) public {
        b = bound(b, 1, 1e15); // up to 1e9 USDG
        amount = bound(amount, 1, SUPPLY);
        _donate(b);
        uint256 expected = Math.mulDiv(amount, b, SUPPLY);
        if (expected == 0) {
            vm.expectRevert(FloorVault.ZeroPayout.selector);
            _redeem(holder, amount);
            return;
        }
        uint256 paid = _redeem(holder, amount);
        assertEq(paid, expected);
        uint256 b1 = usdg.balanceOf(address(vault));
        uint256 s1 = token.totalSupply();
        assertEq(b1, b - paid);
        assertEq(s1, SUPPLY - amount);
        assertGe(b1 * SUPPLY, b * s1, "floor fell");
    }

    /// @dev For a fixed amount, the quote never decreases across redemptions, burns, stray
    ///      burns and donations.
    function testFuzz_quoteIsMonotone(uint256 b, uint256 r1, uint256 burnAmt, uint256 donation) public {
        b = bound(b, 1e6, 1e15);
        _donate(b);
        uint256 probe = 1e24;
        uint256 q0 = vault.quoteRedeem(probe);

        r1 = bound(r1, 1, SUPPLY / 2);
        if (vault.quoteRedeem(r1) > 0) _redeem(holder, r1);
        uint256 q1 = vault.quoteRedeem(probe);
        assertGe(q1, q0, "redeem lowered the quote");

        burnAmt = bound(burnAmt, 0, token.balanceOf(holder) / 2);
        vm.prank(holder);
        token.burn(burnAmt);
        uint256 q2 = vault.quoteRedeem(probe);
        assertGe(q2, q1, "burn lowered the quote");

        donation = bound(donation, 0, 1e12);
        if (donation > 0) _donate(donation);
        assertGe(vault.quoteRedeem(probe), q2, "donation lowered the quote");
    }
}

/// @dev Local event declaration for `vm.expectEmit` on the token's burn Transfer.
interface IERC20Transfer {
    event Transfer(address indexed from, address indexed to, uint256 value);
}
