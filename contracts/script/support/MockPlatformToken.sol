// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @title MockPlatformToken
/// @notice Testnet stand-in for the platform `$TOKEN` (the real one launches on PONS at M6).
///         Deployment tooling only — lives under `script/`, never in the audited `src/` surface.
/// @dev Fixed supply of 1,000,000,000 tokens (18 decimals) minted once to `holder`. No mint,
///      no owner. Burnable (ERC20Burnable) so FloorVault can redeem against it.
contract MockPlatformToken is ERC20, ERC20Burnable {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    constructor(address holder) ERC20("Vivarium Test Platform Token", "tVIV") {
        _mint(holder, TOTAL_SUPPLY);
    }
}
