// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDG
/// @notice Stand-in for the 6-decimal Global Dollar on Robinhood Chain testnet, where the real
///         USDG is supply-controlled and unobtainable. Deployment tooling only — this file lives
///         under `script/` so it never enters the audited `src/` surface, and it is never used on
///         mainnet, where the canonical USDG address is passed to the factory instead.
/// @dev Minting is restricted to a single minter fixed by the deployer at construction.
contract MockUSDG is ERC20 {
    error NotMinter();

    /// @notice The only address allowed to mint. Immutable, set at construction.
    address public immutable minter;

    constructor(address minter_) ERC20("Mock Global Dollar", "USDG") {
        minter = minter_;
    }

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint `amount` (6-decimal) units to `to`. Minter only.
    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }
}
