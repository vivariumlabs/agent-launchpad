// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice ERC-20 for AGENT tokens, built on OpenZeppelin v5.1.0 bases per the
///         "fork audited patterns, minimize original code" rule (docs/02).
///         The full fixed supply is minted to the bonding curve clone at
///         construction; there is no owner, no further mint function, and no
///         other admin logic.
/// @dev `burn`/`burnFrom` come from {ERC20Burnable}. `permit` (EIP-2612) comes
///      from {ERC20Permit} — OZ makes it free (no extra unaudited surface), so
///      it is now included even though nothing in the M1 flow currently
///      requires off-chain approvals for this token.
contract AgentToken is ERC20, ERC20Burnable, ERC20Permit {
    /// @dev Fixed total supply minted once, at construction, to `curve`.
    uint256 public constant AGENT_SUPPLY = 1_000_000_000e18;

    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, address curve) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (curve == address(0)) revert ZeroAddress();
        _mint(curve, AGENT_SUPPLY);
    }
}
