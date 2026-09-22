// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal stand-in for a Uniswap v4 PositionManager, just enough
///         surface (mint + ownerOf + transferFrom) to exercise LiquidityLocker.
contract MockPositionManager {
    mapping(uint256 => address) public ownerOf;

    error NotOwner();

    function mint(address to, uint256 tokenId) external {
        ownerOf[tokenId] = to;
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        if (ownerOf[tokenId] != from) revert NotOwner();
        ownerOf[tokenId] = to;
    }
}
