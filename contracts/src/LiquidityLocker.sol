// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {ILiquidityLocker} from "./interfaces/ILaunchpad.sol";

/// @title LiquidityLocker
/// @notice Permanent home for every graduated agent pool's liquidity. The position is minted
///         **directly on the PoolManager** by this contract, under its own address and a salt
///         of `bytes32(agentId)`, and there is no removal, collect, donate or generic-call
///         surface of any kind: the liquidity is locked by construction rather than by policy.
///
/// @dev Design notes for review:
///
///      * **Why not a PositionManager NFT.** An ERC-721 position held by a contract with no
///        transfer surface is equally locked, but costs a Permit2 approval dance, ERC-721
///        custody and a periphery dependency that is not confirmed deployed on the target
///        chain. Minting straight on the singleton removes all three.
///
///      * **The pool's hook never sees this.** FeeSplitHook enables only `beforeInitialize`
///        and `afterSwap`, so `modifyLiquidity` runs with no hook callback at all — nothing
///        can interfere with, or re-enter through, the mint.
///
///      * **Dust.** `LiquidityAmounts.getLiquidityForAmounts` rounds the liquidity down, so the
///        settled amounts are at most a few wei below what the factory transferred in. That
///        remainder is stranded here forever (no withdrawal exists) and is equivalent to burned.
///
///      * **Fees.** Graduated pools carry `fee == 0`, so the locked position never accrues LP
///        fees there would be no way to collect. Swap revenue is taken by the hook instead.
contract LiquidityLocker is ILiquidityLocker, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    IPoolManager public immutable poolManager;

    /// @dev Captured at deploy time; the only address allowed to call the one-time wiring
    ///      setter below.
    address public immutable deployer;

    /// @notice AgentFactory; the only address allowed to lock. Set once, after the factory
    ///         is deployed.
    address public factory;

    /// @inheritdoc ILiquidityLocker
    /// @dev Nonzero exactly for agents whose liquidity has been locked — `lock` rejects a zero
    ///      result, so this doubles as the once-per-agent flag.
    mapping(uint256 agentId => uint128) public lockedLiquidity;

    uint256 private _status = _NOT_ENTERED;

    error ZeroAddress();
    error AlreadySet();
    error NotDeployer();
    error NotFactory();
    error NotPoolManager();
    error NotUnlocking();
    error AlreadyLocked();
    error InvalidAgentId();
    error PoolNotInitialized();
    error ZeroLiquidity();
    error InexactTransfer(address token, uint256 expected, uint256 actual);
    error Reentrancy();

    event FactorySet(address indexed factory);

    modifier nonReentrant() {
        if (_status == _ENTERED) revert Reentrancy();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    constructor(IPoolManager _poolManager) {
        if (address(_poolManager) == address(0)) revert ZeroAddress();
        poolManager = _poolManager;
        deployer = msg.sender;
    }

    /// @notice One-time wiring of the factory address.
    function setFactory(address _factory) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (factory != address(0)) revert AlreadySet();
        if (_factory == address(0)) revert ZeroAddress();
        factory = _factory;
        emit FactorySet(_factory);
    }

    /// @inheritdoc ILiquidityLocker
    /// @dev The factory transfers `amount0`/`amount1` to this contract immediately before the
    ///      call, inside the same transaction; the mint is settled out of those balances. The
    ///      liquidity is derived from the pool's **live** sqrtPrice, which the factory has just
    ///      initialized from the very same amounts.
    function lock(uint256 agentId, PoolKey calldata key, uint256 amount0, uint256 amount1)
        external
        nonReentrant
        returns (uint128 liquidity)
    {
        if (msg.sender != factory) revert NotFactory();
        if (agentId == 0) revert InvalidAgentId();
        if (lockedLiquidity[agentId] != 0) revert AlreadyLocked();

        PoolId poolId = key.toId();
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();

        // Full range for this pool's spacing, derived (never hardcoded) the same way v4 does:
        // MIN_TICK/MAX_TICK truncated toward zero onto a multiple of the spacing.
        int24 tickLower = TickMath.minUsableTick(key.tickSpacing);
        int24 tickUpper = TickMath.maxUsableTick(key.tickSpacing);

        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            amount0,
            amount1
        );
        if (liquidity == 0) revert ZeroLiquidity();

        // CEI: recorded before the PoolManager is touched.
        lockedLiquidity[agentId] = liquidity;

        poolManager.unlock(abi.encode(agentId, key, tickLower, tickUpper, liquidity));

        emit Locked(agentId, PoolId.unwrap(poolId), liquidity);
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Only reachable while `lock` holds the reentrancy guard, and only from the
    ///      PoolManager, which calls back exclusively to the address that called `unlock`.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (_status != _ENTERED) revert NotUnlocking();

        (uint256 agentId, PoolKey memory key, int24 tickLower, int24 tickUpper, uint128 liquidity) =
            abi.decode(data, (uint256, PoolKey, int24, int24, uint128));

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(agentId)
            }),
            ""
        );

        _resolve(key.currency0, delta.amount0());
        _resolve(key.currency1, delta.amount1());

        return "";
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /// @dev Pays a negative delta out of this contract's own balance. A positive delta cannot
    ///      arise from a fresh full-range mint (there are no fees to collect on a position that
    ///      has just been created), but it is taken rather than left unsettled so a surprise can
    ///      never brick the lock — anything taken is stranded here, i.e. burned.
    function _resolve(Currency currency, int128 amount) private {
        if (amount < 0) {
            _settleExact(currency, uint256(uint128(-amount)));
        } else if (amount > 0) {
            poolManager.take(currency, address(this), uint256(uint128(amount)));
        }
    }

    /// @dev sync -> transfer -> settle, with the PoolManager's balance delta checked: a
    ///      fee-on-transfer currency would credit less than v4 is owed and is rejected outright.
    function _settleExact(Currency currency, uint256 amount) private {
        address token = Currency.unwrap(currency);
        uint256 before = IERC20Minimal(token).balanceOf(address(poolManager));
        poolManager.sync(currency);
        currency.transfer(address(poolManager), amount);
        uint256 received = IERC20Minimal(token).balanceOf(address(poolManager)) - before;
        if (received != amount) revert InexactTransfer(token, amount, received);
        poolManager.settle();
    }
}
