// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {FloorVault} from "../src/FloorVault.sol";
import {MockPlatformToken} from "../script/support/MockPlatformToken.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";

/// @notice Drives a FloorVault with random redeems, donations, fee-leg inflows, $TOKEN
///         transfers, direct burns and stray send + `burnStray`, from several actors. Every
///         per-call property (I1 floor, I2 quote, I5 outflow) is checked inside the handler
///         across each single call and latched into a ghost flag; the invariants assert the
///         flags and the global ledgers (I3, I4).
contract FloorVaultHandler is Test {
    FloorVault public immutable vault;
    MockUSDG public immutable usdg;
    MockPlatformToken public immutable token;

    uint256 public constant PROBE = 1e24;
    uint256 public immutable initialSupply;

    address[] public actors;
    /// @dev Stand-ins for the hook / curve platform-leg senders.
    address public immutable feeSource = address(0xFEE5);
    address public immutable donor = address(0xD0D0);

    // ---- ghosts ----------------------------------------------------------
    uint256 public ghostInflows; // every USDG wei that entered the vault
    uint256 public ghostRedeemPaid; // USDG paid by redeem, summed from receipts
    uint256 public ghostRedeemBurned;
    uint256 public ghostStrayBurned;
    uint256 public ghostDirectBurned;

    bool public floorDecreased; // I1
    bool public quoteDecreased; // I2
    bool public usdgLeaked; // I5
    uint256 public redeems;
    uint256 public strayBurns;

    // per-call snapshot
    uint256 internal _b0;
    uint256 internal _s0;
    uint256 internal _q0;

    constructor(FloorVault vault_, MockUSDG usdg_, MockPlatformToken token_, address[] memory actors_) {
        vault = vault_;
        usdg = usdg_;
        token = token_;
        actors = actors_;
        initialSupply = token_.totalSupply();
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    // ---- per-call checks ---------------------------------------------------

    function _before() internal {
        _b0 = usdg.balanceOf(address(vault));
        _s0 = token.totalSupply();
        _q0 = vault.quoteRedeem(PROBE);
    }

    /// @dev I1 (cross-multiplied, S>0), I2, and I5 for every non-redeem action.
    function _after(bool isRedeem) internal {
        uint256 b1 = usdg.balanceOf(address(vault));
        uint256 s1 = token.totalSupply();
        if (s1 > 0 && _s0 > 0 && b1 * _s0 < _b0 * s1) floorDecreased = true;
        if (s1 > 0 && vault.quoteRedeem(PROBE) < _q0) quoteDecreased = true;
        if (!isRedeem && b1 < _b0) usdgLeaked = true;
    }

    // ---- actions -----------------------------------------------------------

    function redeem(uint256 actorSeed, uint256 amount) external {
        address who = _actor(actorSeed);
        uint256 bal = token.balanceOf(who);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        if (vault.quoteRedeem(amount) == 0) return;

        _before();
        uint256 whoBefore = usdg.balanceOf(who);
        vm.prank(who);
        uint256 paid = vault.redeem(amount);
        uint256 received = usdg.balanceOf(who) - whoBefore;
        uint256 left = _b0 - usdg.balanceOf(address(vault));
        // I5: the vault's outflow went to the redeemer, all of it, and only that.
        if (received != paid || left != paid) usdgLeaked = true;
        ghostRedeemPaid += received;
        ghostRedeemBurned += amount;
        redeems++;
        _after(true);
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, 1e12);
        _before();
        usdg.mint(donor, amount);
        vm.prank(donor);
        usdg.transfer(address(vault), amount);
        ghostInflows += amount;
        _after(false);
    }

    function feeLeg(uint256 amount) external {
        amount = bound(amount, 1, 1e10);
        _before();
        usdg.mint(feeSource, amount);
        vm.prank(feeSource);
        usdg.transfer(address(vault), amount);
        ghostInflows += amount;
        _after(false);
    }

    function transferToken(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 0, bal);
        _before();
        vm.prank(from);
        token.transfer(to, amount);
        _after(false);
    }

    function directBurn(uint256 actorSeed, uint256 amount) external {
        address who = _actor(actorSeed);
        uint256 bal = token.balanceOf(who);
        if (bal == 0) return;
        amount = bound(amount, 0, bal);
        _before();
        vm.prank(who);
        token.burn(amount);
        ghostDirectBurned += amount;
        _after(false);
    }

    function sendStray(uint256 actorSeed, uint256 amount) external {
        address who = _actor(actorSeed);
        uint256 bal = token.balanceOf(who);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        _before();
        vm.prank(who);
        token.transfer(address(vault), amount);
        _after(false);
    }

    function burnStray(uint256 actorSeed) external {
        uint256 stray = token.balanceOf(address(vault));
        if (stray == 0) return;
        _before();
        vm.prank(_actor(actorSeed));
        uint256 burned = vault.burnStray();
        ghostStrayBurned += burned;
        strayBurns++;
        _after(false);
    }

    function sumActorUsdg() external view returns (uint256 s) {
        for (uint256 i = 0; i < actors.length; i++) {
            s += usdg.balanceOf(actors[i]);
        }
    }
}

contract FloorVaultInvariantTest is StdInvariant, Test {
    MockUSDG usdg;
    MockPlatformToken token;
    FloorVault vault;
    FloorVaultHandler handler;

    function setUp() public {
        usdg = new MockUSDG();
        address[] memory actors = new address[](4);
        actors[0] = makeAddr("actor0");
        actors[1] = makeAddr("actor1");
        actors[2] = makeAddr("actor2");
        actors[3] = makeAddr("actor3");

        token = new MockPlatformToken(actors[0]);
        vault = new FloorVault(address(usdg), address(token));

        // Spread the supply and approve the vault for every actor.
        uint256 quarter = token.totalSupply() / 4;
        for (uint256 i = 0; i < actors.length; i++) {
            if (i > 0) {
                vm.prank(actors[0]);
                token.transfer(actors[i], quarter);
            }
            vm.prank(actors[i]);
            token.approve(address(vault), type(uint256).max);
        }

        handler = new FloorVaultHandler(vault, usdg, token, actors);

        // Seed an initial inflow so redeems have something to pay from the first call.
        handler.feeLeg(10_000e6);

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = FloorVaultHandler.redeem.selector;
        selectors[1] = FloorVaultHandler.donate.selector;
        selectors[2] = FloorVaultHandler.feeLeg.selector;
        selectors[3] = FloorVaultHandler.transferToken.selector;
        selectors[4] = FloorVaultHandler.directBurn.selector;
        selectors[5] = FloorVaultHandler.sendStray.selector;
        selectors[6] = FloorVaultHandler.burnStray.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice I1: the floor never decreases across any call (B1*S0 >= B0*S1, S > 0).
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    function invariant_I1_floorNeverDecreases() public view {
        assertFalse(handler.floorDecreased(), "floor decreased across a call");
    }

    /// @notice I2: for a fixed probe amount, `quoteRedeem(probe)` never decreases.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    function invariant_I2_quoteNeverDecreases() public view {
        assertFalse(handler.quoteDecreased(), "quoteRedeem(probe) decreased across a call");
    }

    /// @notice I3: USDG conservation — vault balance + totalRedeemedUsdg == sum of inflows.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    function invariant_I3_usdgConservation() public view {
        assertEq(
            usdg.balanceOf(address(vault)) + vault.totalRedeemedUsdg(), handler.ghostInflows(), "USDG not conserved"
        );
        assertEq(vault.totalRedeemedUsdg(), handler.ghostRedeemPaid(), "totalRedeemedUsdg != receipts");
    }

    /// @notice I4: S == initialSupply - totalBurned - stray burned - direct burns.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    function invariant_I4_supplyLedger() public view {
        assertEq(
            token.totalSupply(),
            handler.initialSupply() - vault.totalBurned() - handler.ghostStrayBurned() - handler.ghostDirectBurned(),
            "supply ledger"
        );
        assertEq(vault.totalBurned(), handler.ghostRedeemBurned(), "totalBurned != redeemed amounts");
    }

    /// @notice I5: USDG only ever leaves the vault to the caller of `redeem`.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 64
    function invariant_I5_usdgOnlyLeavesToRedeemer() public view {
        assertFalse(handler.usdgLeaked(), "USDG left the vault other than to a redeemer");
        // Actors only ever receive USDG from redemptions.
        assertEq(handler.sumActorUsdg(), vault.totalRedeemedUsdg(), "actor USDG != redemptions");
    }
}
