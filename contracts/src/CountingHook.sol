// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";

/// @notice M0 spike: trivial hook that counts swaps. Proves custom hooks work
/// against the PoolManager deployed on Robinhood Chain testnet (46630).
/// Only beforeSwap/afterSwap flags are set on its address, so the manager
/// never calls any other hook entrypoint.
contract CountingHook {
    IPoolManager public immutable manager;
    uint256 public beforeSwapCount;
    uint256 public afterSwapCount;

    constructor(IPoolManager _manager) {
        manager = _manager;
    }

    modifier onlyManager() {
        require(msg.sender == address(manager), "not manager");
        _;
    }

    function beforeSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata)
        external
        onlyManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        beforeSwapCount++;
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        onlyManager
        returns (bytes4, int128)
    {
        afterSwapCount++;
        return (IHooks.afterSwap.selector, 0);
    }
}
