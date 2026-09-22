// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Adapted from pons-labs (MIT): contractsV2/src/v2/hooks/PonsV2MemeHook.sol
// (afterSwap fee-take, internal-conversion unlock callback, exact-transfer accounting)

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";

import {IFeeSplitHook, IAgentRegistry, IRoyaltyDistributor} from "./interfaces/ILaunchpad.sol";

/// @title FeeSplitHook
/// @notice Singleton Uniswap v4 hook for every graduated agent pool. Takes a flat
///         `TOTAL_FEE_BPS` cut of each swap's unspecified currency, accrues it per pool,
///         and splits it in equal thirds between the treasury buyback, the agent's own
///         treasury and the royalty distributor when `distribute` is called.
///
/// @dev Design notes that matter for review:
///
///      * **No owner, no setters, no rescue.** Every address bar `factory` is immutable and
///        set in the constructor; `factory` is a one-time wiring setter callable only by the
///        deployer. There is deliberately no sweep/withdraw path — the only exit for accrued
///        fees is `distribute`, which is permissionless and retryable.
///
///      * **Self-call exemption.** The conversion swap in `distribute` runs against the very
///        pool this hook taxes. v4-core's `Hooks.afterSwap` short-circuits with
///        `if (msg.sender == address(self)) return (...)` (lib/v4-core/src/libraries/Hooks.sol),
///        so the hook is never invoked for its own swap and the conversion is not re-taxed.
///        Because that exemption lives in a dependency, `_afterSwap` additionally returns a
///        zero delta when `sender == address(this)`, which is a free (calldata-only) belt to
///        the library's braces.
///
///      * **Conversion sizing, not conversion reverting.** The AGENT->USDG leg is sized before
///        it is swapped: `min(pendingAgent, notional cap, impact cap)`, where the impact cap is
///        `MAX_IMPACT_BPS` of the pool's live virtual AGENT reserve (derived from slot0 +
///        liquidity). On a constant-product pool the exact-in shortfall against spot is
///        `amountIn / (virtualReserveIn + amountIn)`, so that cap keeps the realized price
///        inside the bound by construction. Whatever does not fit stays in `pendingFees` and
///        drains over later calls; a pool whose LPs have withdrawn almost all depth therefore
///        converts a thin slice per cooldown instead of bricking on `ImpactTooHigh` forever.
///        The post-swap check is kept as defence in depth: it still fires when in-range
///        liquidity overstates the depth actually traversed (concentrated positions) or when
///        the price moves between sizing and execution.
///
///      * **Accepted risk — bounded sandwich.** The conversion leg bounds execution price
///        against the pool's *live* spot (`MAX_IMPACT_BPS`). That is slippage control, not
///        manipulation resistance: an attacker who moves spot in the same transaction shifts
///        the whole acceptance band with it. The loss is bounded by
///        `MAX_IMPACT_BPS x MAX_CONVERSION_PER_CALL` per `DISTRIBUTE_COOLDOWN` window
///        (<= 50 USDG per hour per pool at the current constants), and a caller who does have
///        an independent price can tighten it further with `minConversionOut`. This is
///        knowingly accepted rather than mitigated, because the alternative (a trusted sweep
///        operator, as in PONS) would reintroduce a privileged role the launchpad does not want.
contract FeeSplitHook is IHooks, IFeeSplitHook, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;
    using SafeCast for uint256;

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint256 public constant BASIS_POINTS = 10_000;
    /// @notice Total swap fee taken by this hook, in bps of the unspecified-side delta.
    uint256 public constant TOTAL_FEE_BPS = 300;
    /// @notice Maximum tolerated shortfall of the conversion swap against live spot, in bps.
    /// @dev Doubles as the per-call conversion-size knob: the AGENT input is capped at this many
    ///      bps of the pool's live virtual AGENT reserve, which is what normally keeps the
    ///      post-swap shortfall inside the same bound.
    uint256 public constant MAX_IMPACT_BPS = 100;
    /// @notice Maximum USDG-equivalent notional converted from AGENT per `distribute` call.
    uint256 public constant MAX_CONVERSION_PER_CALL = 5_000e6;
    /// @notice Minimum spacing between successful `distribute` calls on the same pool.
    uint256 public constant DISTRIBUTE_COOLDOWN = 1 hours;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    // -----------------------------------------------------------------------
    // Immutables / wiring
    // -----------------------------------------------------------------------

    IPoolManager public immutable poolManager;
    /// @notice The quote currency of every agent pool (6 decimals).
    address public immutable usdg;
    IAgentRegistry public immutable registry;
    IRoyaltyDistributor public immutable distributor;
    address public immutable treasuryBuyback;
    /// @notice Only address permitted to call `setFactory`, fixed at construction.
    address public immutable deployer;

    /// @notice AgentFactory; the only address allowed to initialize pools on this hook and
    ///         to register them. Set once, after the factory is deployed.
    address public factory;

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    struct PoolInfo {
        address agentToken;
        bool agentIsCurrency0;
        bool registered;
        uint256 agentId;
    }

    mapping(bytes32 poolId => PoolInfo) public poolInfo;
    mapping(bytes32 poolId => PoolKey) internal _poolKeys;

    /// @notice Fees taken but not yet distributed, per pool and per currency.
    mapping(bytes32 poolId => mapping(address currency => uint256)) public pendingFees;

    /// @notice Timestamp of the last successful `distribute` per pool (0 = never).
    mapping(bytes32 poolId => uint256) public lastDistribute;

    uint256 private _status = _NOT_ENTERED;

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error NotPoolManager();
    error NotFactory();
    error NotDeployer();
    error AlreadySet();
    error AlreadyRegistered();
    error UnknownPool();
    error InvalidAgentId();
    error InvalidHookAddress();
    error InvalidFee();
    error InvalidTickSpacing();
    error InvalidCurrencies();
    error PoolNotInitialized();
    error CooldownActive();
    error NothingPending();
    error ConversionFailed();
    error ImpactTooHigh(uint256 actualOut, uint256 minAcceptableOut);
    error SlippageExceeded(uint256 actualOut, uint256 minConversionOut);
    error InexactTransfer(address token, uint256 expected, uint256 actual);
    error Reentrancy();
    error NotUnlocking();
    error HookNotImplemented();
    error ZeroAddress();

    /// @notice Emitted once, when the factory address is wired in.
    event FactorySet(address indexed factory);

    // -----------------------------------------------------------------------
    // Modifiers
    // -----------------------------------------------------------------------

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @dev Hand-rolled (no OZ dependency in this repo). `unlockCallback` deliberately runs
    ///      *inside* this guard rather than taking its own: it is only reachable from the
    ///      PoolManager re-entering us during our own `unlock`, and asserts exactly that.
    modifier nonReentrant() {
        if (_status == _ENTERED) revert Reentrancy();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    constructor(
        IPoolManager _poolManager,
        address _usdg,
        address _registry,
        address _distributor,
        address _treasuryBuyback
    ) {
        if (
            address(_poolManager) == address(0) || _usdg == address(0) || _registry == address(0)
                || _distributor == address(0) || _treasuryBuyback == address(0)
        ) revert ZeroAddress();

        poolManager = _poolManager;
        usdg = _usdg;
        registry = IAgentRegistry(_registry);
        distributor = IRoyaltyDistributor(_distributor);
        treasuryBuyback = _treasuryBuyback;
        deployer = msg.sender;

        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    /// @notice One-time wiring of the factory address.
    /// @dev Callable only by the deployer; reverts `AlreadySet` on any repeat call.
    function setFactory(address _factory) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (factory != address(0)) revert AlreadySet();
        if (_factory == address(0)) revert ZeroAddress();
        factory = _factory;
        emit FactorySet(_factory);
    }

    // -----------------------------------------------------------------------
    // Hook permissions
    // -----------------------------------------------------------------------

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    /// @notice Binds a pool id to its agent, fixing the currency layout used by every later
    ///         fee credit. Factory-only and once per pool.
    function registerPool(PoolKey calldata key, uint256 agentId, address agentToken) external {
        if (msg.sender != factory) revert NotFactory();
        if (agentId == 0) revert InvalidAgentId();
        if (address(key.hooks) != address(this)) revert InvalidHookAddress();
        if (key.fee != 0) revert InvalidFee();
        if (key.tickSpacing != 60) revert InvalidTickSpacing();

        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        bool agentIsCurrency0;
        if (c0 == agentToken && c1 == usdg) {
            agentIsCurrency0 = true;
        } else if (c1 == agentToken && c0 == usdg) {
            agentIsCurrency0 = false;
        } else {
            revert InvalidCurrencies();
        }

        bytes32 poolId = PoolId.unwrap(key.toId());
        if (poolInfo[poolId].registered) revert AlreadyRegistered();

        poolInfo[poolId] =
            PoolInfo({agentToken: agentToken, agentIsCurrency0: agentIsCurrency0, registered: true, agentId: agentId});
        _poolKeys[poolId] = key;

        emit PoolRegistered(poolId, agentId, agentToken);
    }

    /// @notice The stored PoolKey for a registered pool.
    function poolKeyOf(bytes32 poolId) external view returns (PoolKey memory) {
        return _poolKeys[poolId];
    }

    // -----------------------------------------------------------------------
    // IHooks — enabled entrypoints
    // -----------------------------------------------------------------------

    /// @dev Restricts pool creation on this hook to the factory, which guarantees every pool
    ///      carrying this hook has a matching `registerPool` record.
    function beforeInitialize(address sender, PoolKey calldata, uint160)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (sender != factory) revert NotFactory();
        return IHooks.beforeInitialize.selector;
    }

    /// @dev Takes `TOTAL_FEE_BPS` of the unspecified-side delta out of the PoolManager's
    ///      flash-accounting ledger and returns it as the hook's unspecified delta, so the
    ///      swapper pays for it. The fee lands in whichever currency is unspecified — AGENT
    ///      fees sit until a later `distribute` converts them to USDG in one batch.
    function afterSwap(
        address sender,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        // Belt to Hooks.afterSwap's braces: never tax our own conversion swap.
        if (sender == address(this)) return (IHooks.afterSwap.selector, 0);

        bytes32 poolId = PoolId.unwrap(key.toId());
        if (!poolInfo[poolId].registered) return (IHooks.afterSwap.selector, 0);

        bool specifiedIsCurrency0 = (params.amountSpecified < 0) == params.zeroForOne;
        (Currency feeCurrency, int128 unspecifiedAmount) =
            specifiedIsCurrency0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (unspecifiedAmount < 0) unspecifiedAmount = -unspecifiedAmount;
        if (unspecifiedAmount == 0) return (IHooks.afterSwap.selector, 0);

        uint256 feeAmount = (uint256(uint128(unspecifiedAmount)) * TOTAL_FEE_BPS) / BASIS_POINTS;
        if (feeAmount == 0) return (IHooks.afterSwap.selector, 0);

        address feeCurrencyAddr = Currency.unwrap(feeCurrency);
        _takeExact(feeCurrency, feeCurrencyAddr, feeAmount);
        pendingFees[poolId][feeCurrencyAddr] += feeAmount;

        emit FeeCollected(poolId, feeCurrencyAddr, feeAmount);
        return (IHooks.afterSwap.selector, feeAmount.toInt128());
    }

    // -----------------------------------------------------------------------
    // Distribution
    // -----------------------------------------------------------------------

    /// @notice Converts pending AGENT fees to USDG and splits all pending USDG into three
    ///         equal legs: treasury buyback, the agent's live treasury, royalty distributor.
    /// @param poolId The registered pool whose pending fees are being distributed.
    /// @param minConversionOut Caller-supplied floor on the USDG produced by the AGENT->USDG
    ///        conversion leg. Ignored when there is no AGENT-side pending balance.
    /// @dev Permissionless and retryable. The conversion leg is sized to the pool's live depth,
    ///      so a shallow pool converts a slice per call and leaves the rest pending rather than
    ///      failing outright. If the realized price still misses the bound the call reverts
    ///      whole: the fees stay pending and the next caller, one cooldown later, gets another
    ///      attempt at a price that clears it.
    function distribute(bytes32 poolId, uint256 minConversionOut) external nonReentrant {
        PoolInfo memory info = poolInfo[poolId];
        if (!info.registered) revert UnknownPool();

        uint256 last = lastDistribute[poolId];
        if (last != 0 && block.timestamp < last + DISTRIBUTE_COOLDOWN) revert CooldownActive();

        uint256 pendingAgent = pendingFees[poolId][info.agentToken];
        uint256 pendingUsdg = pendingFees[poolId][usdg];
        // Below three wei every leg rounds to zero, so a call that has nothing to convert and
        // cannot fund a single leg would only burn the pool's cooldown. Reject it instead.
        if (pendingAgent == 0 && pendingUsdg < 3) revert NothingPending();

        lastDistribute[poolId] = block.timestamp;

        uint256 converted;
        if (pendingAgent != 0) {
            converted = _convertAgentFees(poolId, info, pendingAgent, minConversionOut);
        }

        uint256 total = pendingUsdg + converted;
        uint256 leg = total / 3;
        // Remainder (0-2 wei) stays pending and rides along with the next distribution.
        pendingFees[poolId][usdg] = total - (leg * 3);

        if (leg != 0) {
            Currency usdgCurrency = Currency.wrap(usdg);
            // Live lookup, never cached: a revived agent's new treasury must be paid.
            address treasury = registry.treasuryOf(info.agentId);

            usdgCurrency.transfer(treasuryBuyback, leg);
            usdgCurrency.transfer(treasury, leg);
            usdgCurrency.transfer(address(distributor), leg);
            distributor.credit(info.agentId, leg);
        }

        emit Distributed(poolId, leg, leg, leg, converted);
    }

    /// @dev Converts `min(pendingAgent, notional cap, impact cap)` AGENT into USDG against the
    ///      pool's own liquidity. Anything above the binding cap stays pending and drains over
    ///      later calls; this function never reverts merely because the pool is thin.
    function _convertAgentFees(bytes32 poolId, PoolInfo memory info, uint256 pendingAgent, uint256 minConversionOut)
        private
        returns (uint256 usdgOut)
    {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(PoolId.wrap(poolId));
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();

        uint256 amountIn = pendingAgent;

        // Cap 1 — notional: at most MAX_CONVERSION_PER_CALL of USDG value at spot.
        uint256 spotValue = _quoteAgentToUsdg(sqrtPriceX96, info.agentIsCurrency0, amountIn);
        if (spotValue > MAX_CONVERSION_PER_CALL) {
            amountIn = FullMath.mulDiv(amountIn, MAX_CONVERSION_PER_CALL, spotValue);
        }

        // Cap 2 — impact: at most MAX_IMPACT_BPS of the pool's live virtual AGENT reserve.
        uint256 impactCap = _impactCap(poolId, sqrtPriceX96, info.agentIsCurrency0);
        // No in-range liquidity: there is nothing to trade against. Leave everything pending.
        if (impactCap == 0) return 0;
        if (amountIn > impactCap) amountIn = impactCap;

        spotValue = _quoteAgentToUsdg(sqrtPriceX96, info.agentIsCurrency0, amountIn);
        // Inventory worth less than one wei of USDG at spot: leave it pending rather than
        // spend a swap on it. The USDG legs below still run on whatever is already quoted.
        if (amountIn == 0 || spotValue == 0) return 0;

        (uint256 consumed, uint256 out) = _swapAgentForUsdg(poolId, amountIn);
        if (consumed == 0) revert ConversionFailed();

        uint256 spotForConsumed =
            consumed == amountIn ? spotValue : _quoteAgentToUsdg(sqrtPriceX96, info.agentIsCurrency0, consumed);
        // Hard check on what actually executed. The sizing above is what normally makes this
        // pass; it still bites when in-range liquidity overstated the depth the swap traversed
        // (concentrated positions just outside the band) or the price moved under us.
        uint256 floorOut = (spotForConsumed * (BASIS_POINTS - MAX_IMPACT_BPS)) / BASIS_POINTS;
        if (out < floorOut) revert ImpactTooHigh(out, floorOut);
        if (out < minConversionOut) revert SlippageExceeded(out, minConversionOut);

        pendingFees[poolId][info.agentToken] = pendingAgent - consumed;
        usdgOut = out;
    }

    /// @dev Largest AGENT exact-in whose expected constant-product shortfall against spot stays
    ///      within `MAX_IMPACT_BPS`.
    ///
    ///      For a CP pool, exact-in of `x` against virtual reserves `(X, Y)` returns
    ///      `Y*x/(X+x)` against a spot quote of `Y*x/X`, i.e. a shortfall of `x/(X+x)`.
    ///      Capping `x <= X * MAX_IMPACT_BPS / 10_000` gives a shortfall of
    ///      `MAX_IMPACT_BPS / (10_000 + MAX_IMPACT_BPS)`, which is strictly inside the bound.
    ///
    ///      The virtual reserves come from v4's live state: with `L` the in-range liquidity and
    ///      `sqrtP = sqrtPriceX96 / 2**96`, `X0 = L / sqrtP` and `X1 = L * sqrtP`.
    ///
    ///      Returns 0 when the pool has no in-range liquidity, which the caller reads as
    ///      "convert nothing this call".
    function _impactCap(bytes32 poolId, uint160 sqrtPriceX96, bool agentIsCurrency0) private view returns (uint256) {
        uint128 liquidity = poolManager.getLiquidity(PoolId.wrap(poolId));
        if (liquidity == 0) return 0;

        uint256 virtualAgentReserve = agentIsCurrency0
            ? FullMath.mulDiv(liquidity, FixedPoint96.Q96, sqrtPriceX96)
            : FullMath.mulDiv(liquidity, sqrtPriceX96, FixedPoint96.Q96);

        return FullMath.mulDiv(virtualAgentReserve, MAX_IMPACT_BPS, BASIS_POINTS);
    }

    function _swapAgentForUsdg(bytes32 poolId, uint256 amountIn) private returns (uint256 consumed, uint256 amountOut) {
        bytes memory result = poolManager.unlock(abi.encode(poolId, amountIn));
        (consumed, amountOut) = abi.decode(result, (uint256, uint256));
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Only reachable while `distribute` holds the reentrancy guard and only from the
    ///      PoolManager, which calls back exclusively to the address that called `unlock`.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        if (_status != _ENTERED) revert NotUnlocking();

        (bytes32 poolId, uint256 amountIn) = abi.decode(data, (bytes32, uint256));
        PoolInfo memory info = poolInfo[poolId];
        PoolKey memory key = _poolKeys[poolId];
        bool zeroForOne = info.agentIsCurrency0;

        BalanceDelta delta = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -amountIn.toInt256(),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        int128 inputDelta = zeroForOne ? delta.amount0() : delta.amount1();
        int128 outputDelta = zeroForOne ? delta.amount1() : delta.amount0();
        uint256 consumed = inputDelta < 0 ? uint256(uint128(-inputDelta)) : 0;
        uint256 amountOut = outputDelta > 0 ? uint256(uint128(outputDelta)) : 0;

        if (consumed != 0) _settleExact(zeroForOne ? key.currency0 : key.currency1, consumed);
        if (amountOut != 0) {
            Currency outCurrency = zeroForOne ? key.currency1 : key.currency0;
            _takeExact(outCurrency, Currency.unwrap(outCurrency), amountOut);
        }

        return abi.encode(consumed, amountOut);
    }

    // -----------------------------------------------------------------------
    // ERC-20 boundary helpers (balance-delta accounting at every edge)
    // -----------------------------------------------------------------------

    /// @dev `take` moves real tokens out of the PoolManager into this contract; accrued
    ///      `pendingFees` are therefore backed by this hook's own ERC-20 balance, which is
    ///      what `distribute` pays out with plain transfers.
    function _takeExact(Currency currency, address token, uint256 amount) private {
        uint256 before = IERC20Minimal(token).balanceOf(address(this));
        poolManager.take(currency, address(this), amount);
        uint256 received = IERC20Minimal(token).balanceOf(address(this)) - before;
        if (received != amount) revert InexactTransfer(token, amount, received);
    }

    function _settleExact(Currency currency, uint256 amount) private {
        address token = Currency.unwrap(currency);
        uint256 before = IERC20Minimal(token).balanceOf(address(poolManager));
        poolManager.sync(currency);
        currency.transfer(address(poolManager), amount);
        uint256 received = IERC20Minimal(token).balanceOf(address(poolManager)) - before;
        if (received != amount) revert InexactTransfer(token, amount, received);
        poolManager.settle();
    }

    // -----------------------------------------------------------------------
    // Pricing
    // -----------------------------------------------------------------------

    /// @dev Spot value of `agentAmount` AGENT in USDG, from the pool's sqrtPriceX96.
    ///      `price(token1/token0) = (sqrtPriceX96 / 2**96)**2`, evaluated in two `mulDiv`
    ///      steps so the intermediate never needs the full 2**192.
    function _quoteAgentToUsdg(uint160 sqrtPriceX96, bool agentIsCurrency0, uint256 agentAmount)
        private
        pure
        returns (uint256)
    {
        if (agentIsCurrency0) {
            uint256 inter = FullMath.mulDiv(agentAmount, sqrtPriceX96, FixedPoint96.Q96);
            return FullMath.mulDiv(inter, sqrtPriceX96, FixedPoint96.Q96);
        } else {
            uint256 inter = FullMath.mulDiv(agentAmount, FixedPoint96.Q96, sqrtPriceX96);
            return FullMath.mulDiv(inter, FixedPoint96.Q96, sqrtPriceX96);
        }
    }

    /// @notice Spot USDG value of an AGENT amount in a registered pool. View helper for
    ///         callers sizing `minConversionOut`.
    function quoteAgentToUsdg(bytes32 poolId, uint256 agentAmount) external view returns (uint256) {
        PoolInfo memory info = poolInfo[poolId];
        if (!info.registered) revert UnknownPool();
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(PoolId.wrap(poolId));
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        return _quoteAgentToUsdg(sqrtPriceX96, info.agentIsCurrency0, agentAmount);
    }

    // -----------------------------------------------------------------------
    // IHooks — disabled entrypoints
    // -----------------------------------------------------------------------

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata)
        external
        pure
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
