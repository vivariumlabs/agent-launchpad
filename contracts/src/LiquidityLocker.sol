// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ILiquidityLocker} from "./interfaces/ILaunchpad.sol";

interface IERC721Min {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice Permanent home for graduated LP position NFTs. Holds forever —
///         intentionally no transfer, collect, or call surface of any kind.
///         The graduated pool's fee is fixed at 0 so the locked position
///         never accrues fees there would be no way to withdraw anyway.
contract LiquidityLocker is ILiquidityLocker {
    address public immutable positionManager;

    /// @dev Captured at deploy time; the only address allowed to call the
    ///      one-time wiring setter below.
    address public immutable deployer;
    address public factory;

    mapping(uint256 => uint256) public positionOf;
    mapping(uint256 => bool) public locked;

    event PositionLocked(uint256 indexed agentId, uint256 indexed positionId);

    error ZeroAddress();
    error AlreadySet();
    error NotDeployer();
    error NotFactory();
    error NotOwnerOfPosition();
    error AlreadyLocked();

    modifier onlyDeployer() {
        if (msg.sender != deployer) revert NotDeployer();
        _;
    }

    constructor(address _positionManager) {
        if (_positionManager == address(0)) revert ZeroAddress();
        positionManager = _positionManager;
        deployer = msg.sender;
    }

    function setFactory(address _factory) external onlyDeployer {
        if (factory != address(0)) revert AlreadySet();
        if (_factory == address(0)) revert ZeroAddress();
        factory = _factory;
    }

    /// @notice Lock a graduated position NFT forever. Factory-only. Verifies
    ///         the position has actually been transferred to this contract
    ///         before recording it.
    function lockPosition(uint256 agentId, uint256 positionId) external {
        if (msg.sender != factory) revert NotFactory();
        if (locked[agentId]) revert AlreadyLocked();
        if (IERC721Min(positionManager).ownerOf(positionId) != address(this)) {
            revert NotOwnerOfPosition();
        }

        locked[agentId] = true;
        positionOf[agentId] = positionId;
        emit PositionLocked(agentId, positionId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
