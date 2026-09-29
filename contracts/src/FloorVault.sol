// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IFloorVault} from "./interfaces/ILaunchpad.sol";

/// @title FloorVault
/// @notice The platform token's redemption floor (D18). Every platform fee leg — the bonding
///         curves' and the FeeSplitHook's — lands here as USDG. Any `$TOKEN` holder may redeem
///         at any time for a strictly pro-rata share of the vault: `amount` tokens are burned
///         and `mulDiv(amount, B, S)` USDG is paid out, where `B` is the vault's USDG balance
///         and `S` the token's total supply, both read before any state change.
///
/// @dev Properties that matter for review and for users:
///
///      * **No owner, no withdrawal.** There is no owner, no setter, no pause, and no sweep,
///        rescue or withdrawal of USDG of any kind. USDG leaves this contract only through
///        `redeem`, and only to its caller. There is no swap, no market interaction and no
///        oracle: the floor is pure balance arithmetic. The only state is the two immutables
///        (`usdg`, `token`) and two cumulative counters.
///
///      * **The floor only rises.** `payout = mulDiv(amount, B, S)` rounds down, so
///        `payout * S <= amount * B` and therefore `(B - payout) / (S - amount) >= B / S`:
///        redeeming never lowers the floor for the remaining holders; rounding dust always
///        stays with them. Inflows (fee legs, donations) only raise `B`; burns anywhere only
///        lower `S`. Hence, for a fixed `amount`, the payout is non-decreasing over time — a
///        redeem can only ever pay *more* by the time it is included than when it was quoted.
///        That is why `redeem` takes no min-out parameter.
///
///      * **Mint caveat.** The monotone property holds as long as `token` cannot mint. The
///        platform token has a fixed supply (PONS launch, 01 §1; the testnet mock is fixed
///        supply too). A mintable token would let new supply dilute the floor.
///
///      * **Donations are plain USDG transfers.** Anyone may raise the floor by transferring
///        USDG to this contract; there is no deposit function and none is needed.
///
///      * **Burn semantics.** Redeemed tokens are pulled with `transferFrom` (balance-delta
///        checked, exact) and destroyed with the token's own ERC20Burnable `burn`; the vault
///        then asserts `totalSupply` fell by exactly `amount`. A token whose burn is a no-op
///        or a dead-address transfer is rejected (`BurnFailed`). Never the dead-address
///        pattern. `$TOKEN` sent here by plain transfer would depress the floor forever, so
///        `burnStray` (permissionless) burns it — it can only raise the floor.
contract FloorVault is IFloorVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -----------------------------------------------------------------------
    // Immutables
    // -----------------------------------------------------------------------

    /// @notice The backing currency (USDG, 6 decimals).
    address public immutable usdg;
    /// @notice The platform token redeemed against the floor (18 decimals, fixed supply).
    address public immutable token;

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    /// @notice Cumulative USDG paid out by `redeem`.
    uint256 public totalRedeemedUsdg;
    /// @notice Cumulative `$TOKEN` burned by `redeem` (stray burns are not counted).
    uint256 public totalBurned;

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error ZeroPayout();
    error InexactTransfer(address token, uint256 expected, uint256 actual);
    error BurnFailed();
    error WrongDecimals();

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    /// @param usdg_ The backing currency.
    /// @param token_ The platform token; must report 18 decimals (`WrongDecimals`).
    constructor(address usdg_, address token_) {
        if (usdg_ == address(0) || token_ == address(0)) revert ZeroAddress();
        if (IERC20Metadata(token_).decimals() != 18) revert WrongDecimals();
        usdg = usdg_;
        token = token_;
    }

    // -----------------------------------------------------------------------
    // Redemption
    // -----------------------------------------------------------------------

    /// @inheritdoc IFloorVault
    /// @notice Burns `amount` of the caller's `$TOKEN` and pays `mulDiv(amount, B, S)` USDG.
    ///         Requires a prior `approve` of at least `amount` to this vault.
    /// @dev No min-out parameter by design: for a fixed `amount` the payout can only grow
    ///      between quote and inclusion (see the contract natspec). Reverts `ZeroAmount` on
    ///      0 and `ZeroPayout` when the pro-rata share rounds to zero (dust, or an empty vault).
    function redeem(uint256 amount) external nonReentrant returns (uint256 usdgPaid) {
        if (amount == 0) revert ZeroAmount();

        // Read before any state change (R3).
        uint256 b = IERC20(usdg).balanceOf(address(this));
        uint256 s = IERC20(token).totalSupply();

        usdgPaid = _quote(amount, b, s);
        if (usdgPaid == 0) revert ZeroPayout();

        // Effects.
        totalRedeemedUsdg += usdgPaid;
        totalBurned += amount;

        // Interactions: pull exact, burn, verify the supply actually fell, pay.
        _pullExact(msg.sender, amount);
        ERC20Burnable(token).burn(amount);
        if (IERC20(token).totalSupply() != s - amount) revert BurnFailed();

        IERC20(usdg).safeTransfer(msg.sender, usdgPaid);

        emit Redeemed(msg.sender, amount, usdgPaid);
    }

    /// @inheritdoc IFloorVault
    /// @notice Burns every `$TOKEN` held by the vault (sent here by plain transfer). Only ever
    ///         raises the floor. Permissionless; reverts `ZeroAmount` when there is none.
    /// @dev Not counted in `totalBurned`, which tracks redemptions only.
    function burnStray() external nonReentrant returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert ZeroAmount();

        uint256 s = IERC20(token).totalSupply();
        ERC20Burnable(token).burn(amount);
        if (IERC20(token).totalSupply() != s - amount) revert BurnFailed();

        emit StrayBurned(msg.sender, amount);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// @inheritdoc IFloorVault
    /// @dev Live `mulDiv(amount, B, S)`; 0 when the supply is 0.
    function quoteRedeem(uint256 amount) external view returns (uint256 usdgPaid) {
        return _quote(amount, IERC20(usdg).balanceOf(address(this)), IERC20(token).totalSupply());
    }

    /// @inheritdoc IFloorVault
    function floorPrice() external view returns (uint256) {
        uint256 s = IERC20(token).totalSupply();
        if (s == 0) return 0;
        return Math.mulDiv(IERC20(usdg).balanceOf(address(this)), 1e36, s);
    }

    /// @inheritdoc IFloorVault
    function state()
        external
        view
        returns (uint256 usdgBalance, uint256 tokenSupply, uint256 totalRedeemedUsdg_, uint256 totalBurned_)
    {
        return (IERC20(usdg).balanceOf(address(this)), IERC20(token).totalSupply(), totalRedeemedUsdg, totalBurned);
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /// @dev Floor-rounded pro-rata share; 0 when `s == 0` (floor undefined).
    function _quote(uint256 amount, uint256 b, uint256 s) private pure returns (uint256) {
        if (s == 0) return 0;
        return Math.mulDiv(amount, b, s);
    }

    /// @dev `transferFrom` with the received amount verified by balance delta (exact).
    function _pullExact(address from, uint256 amount) private {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        uint256 afterBal = IERC20(token).balanceOf(address(this));
        uint256 received = afterBal > before ? afterBal - before : 0;
        if (received != amount) revert InexactTransfer(token, amount, received);
    }
}
