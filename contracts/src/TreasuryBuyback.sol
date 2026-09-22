// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Adapted from pons-labs (MIT): contractsV2/src/v2/hooks/PonsV2MemeHook.sol
// (unlock-callback exact-in swap, exact-transfer settle/take accounting)

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ITreasuryBuyback} from "./interfaces/ILaunchpad.sol";

/// @title TreasuryBuyback
/// @notice Terminal sink for the platform's USDG revenue. USDG arrives here passively (the
///         hook's buyback leg, the bonding curve's buyback leg, swept dust, later the PONS
///         creator-fee sweeps). Anyone may `poke` the contract, which spends a bounded slice
///         of that balance buying `$TOKEN` — the PONS-launched platform token — on its
///         `$TOKEN/USDG` Uniswap v4 pool and sends every bought unit to `0x..dEaD`.
///
/// @dev Design notes that matter for review:
///
///      * **There is no way out but the pool.** The complete external mutating surface is
///        `setTargetPool`, `setMaxPerPoke`, `setCooldown`, `setReward`, the two Ownable2Step
///        handover calls, `renounceOwnership` (disabled), `poke` and `unlockCallback`
///        (PoolManager-only, reachable only inside our own `poke`). There is deliberately no
///        sweep, rescue, withdraw or arbitrary-call function — not for the owner, not for
///        anyone. USDG held here can only ever move to the target pool, to the caller of
///        `poke` as its reward, and (as `$TOKEN`) to the burn address. An owner who wanted the
///        funds would have to persuade the pool to give them up at an honest price, which is
///        the point.
///
///      * **One-time pool wiring.** `setTargetPool` reverts `AlreadySet` on any repeat call,
///        so the owner cannot re-point the buyback at a pool they control after the fact. It
///        is the single piece of trust the multisig holds here and it is spent once.
///
///      * **The target pool carries someone else's hook.** On mainnet the `$TOKEN/USDG` pool
///        is a PONS pool and runs the PONS hook, which takes its own fee (roughly 1% plus a
///        creator tax) out of our swap. From this contract's side that is invisible: we call
///        `poolManager.swap` on the stored key and simply receive less `$TOKEN`. Their fee
///        therefore eats into the `maxImpactBps` budget below — see the note on that
///        immutable. Paying it is accepted (spec §TreasuryBuyback).
///
///      * **Accepted risk — bounded sandwich.** `poke` bounds its execution price against the
///        pool's *live* pre-swap spot (`maxImpactBps`). That is slippage control, not
///        manipulation resistance: an attacker who moves spot in the same transaction moves
///        the acceptance band with it. The loss is bounded by
///        `maxImpactBps x maxPerPoke` per `cooldown` window (<= 100 USDG per hour at the
///        default parameters), and a caller with an independent price can tighten it with
///        `minTokensOut`, which is mandatory and must be nonzero. Identical trade-off to
///        `FeeSplitHook.distribute`, knowingly accepted rather than mitigated: the
///        alternative is a privileged sweep operator, which this system does not want.
///
///      * **Exact-transfer accounting.** Every ERC-20 edge is balance-delta checked and
///        reverts `InexactTransfer` on a shortfall, including the final transfer to the burn
///        address. A fee-on-transfer `$TOKEN` would therefore make `poke` revert rather than
///        silently burn less than reported; the platform token is ours and is not
///        fee-on-transfer, and a pool-level (hook) fee is not a transfer fee.
contract TreasuryBuyback is ITreasuryBuyback, Ownable2Step, ReentrancyGuard, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;
    using SafeCast for uint256;

    // -----------------------------------------------------------------------
    // Constants — hardcoded bounds the owner can never widen
    // -----------------------------------------------------------------------

    uint256 public constant BASIS_POINTS = 10_000;

    /// @notice Where bought `$TOKEN` goes. Chosen over `token.burn()` so the buyback works
    ///         against any ERC-20, burnable or not.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice Absolute ceiling on `maxPerPoke`, whatever the owner sets.
    uint256 public constant MAX_PER_POKE_LIMIT = 10_000e6;
    /// @notice Floor on `cooldown`, whatever the owner sets.
    uint256 public constant MIN_COOLDOWN = 10 minutes;
    /// @notice Ceiling on `rewardBps`, whatever the owner sets.
    uint256 public constant MAX_REWARD_BPS = 100;
    /// @notice Absolute ceiling on a single caller reward, in USDG. Not tunable.
    uint256 public constant REWARD_CAP = 10e6;

    // -----------------------------------------------------------------------
    // Immutables
    // -----------------------------------------------------------------------

    IPoolManager public immutable poolManager;
    /// @notice The revenue currency (6 decimals).
    address public immutable usdg;

    /// @notice Maximum tolerated shortfall of a poke's execution against live pre-swap spot.
    /// @dev Set once at deploy time, not a constant: this contract is deployed before the
    ///      `$TOKEN/USDG` pool exists (`FeeSplitHook` pins this contract's address immutably,
    ///      so the buyback must be on-chain first), and the target pool's own hook fee is
    ///      charged inside the swap and shows up here as execution shortfall, spending from the
    ///      same impact budget. A hardcoded constant chosen before the pool's real fee terms
    ///      are known could undershoot them and brick every poke permanently, with no recovery
    ///      knob (there is deliberately no post-deploy admin setter for it — see the class of
    ///      tunables above). The deploy-time value is instead chosen at wiring time against the
    ///      `$TOKEN` launch's known fee terms and passed in as `maxImpactBps`. Bounded to
    ///      `(0, 1_000]` bps by the constructor (`InvalidBps`); the deployment default used in
    ///      tests and current wiring is 500.
    uint256 public immutable maxImpactBps;

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    /// @notice The `$TOKEN/USDG` pool this contract buys on. Set once, forever.
    PoolKey internal _targetPool;
    /// @notice True once `setTargetPool` has run.
    bool public targetPoolSet;
    /// @notice Which side of the target pool is USDG, i.e. the swap direction of every poke.
    bool public usdgIsCurrency0;
    /// @notice The other currency of the target pool — the token being bought and burned.
    address public token;

    /// @notice Timestamp of the last successful `poke` (0 = never).
    uint256 public lastPoke;

    /// @notice Maximum USDG spent per poke, reward included. Owner-tunable, `<= MAX_PER_POKE_LIMIT`.
    uint256 public maxPerPoke = 2_000e6;
    /// @notice Minimum spacing between successful pokes. Owner-tunable, `>= MIN_COOLDOWN`.
    uint256 public cooldown = 1 hours;
    /// @notice Caller reward, in bps of the poke's gross size. Owner-tunable, `<= MAX_REWARD_BPS`.
    uint256 public rewardBps = 30;

    // -----------------------------------------------------------------------
    // Errors / events
    // -----------------------------------------------------------------------

    error NotPoolManager();
    error NotUnlocking();
    error AlreadySet();
    error TargetNotSet();
    error InvalidCurrencies();
    error PoolNotInitialized();
    error CooldownActive();
    error MinimumOutputRequired();
    error NothingToBuy();
    error SwapFailed();
    error ImpactTooHigh(uint256 actualOut, uint256 minAcceptableOut);
    error SlippageExceeded(uint256 actualOut, uint256 minTokensOut);
    error InexactTransfer(address currency, uint256 expected, uint256 actual);
    error InvalidParameter();
    error RenounceDisabled();
    error InvalidBps();

    event TargetPoolSet(bytes32 indexed poolId, address indexed boughtToken, bool usdgSide0);
    event MaxPerPokeSet(uint256 maxPerPoke);
    event CooldownSet(uint256 cooldown);
    event RewardSet(uint256 rewardBps);

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    /// @param _poolManager The Uniswap v4 PoolManager the target pool lives on.
    /// @param _usdg The revenue currency; must be one of the target pool's two currencies.
    /// @param _owner The platform multisig. Its only powers are the one-time pool wiring and
    ///        the three bounded tunables below.
    /// @param _maxImpactBps The impact bound `poke` enforces against live pre-swap spot; see
    ///        `maxImpactBps` above. Must be in `(0, 1_000]` bps (`InvalidBps` otherwise), chosen
    ///        at wiring time against the target pool's known fee terms.
    constructor(IPoolManager _poolManager, address _usdg, address _owner, uint256 _maxImpactBps) Ownable(_owner) {
        if (address(_poolManager) == address(0) || _usdg == address(0)) revert InvalidParameter();
        if (_maxImpactBps == 0 || _maxImpactBps > 1_000) revert InvalidBps();
        poolManager = _poolManager;
        usdg = _usdg;
        maxImpactBps = _maxImpactBps;
    }

    /// @notice Disabled: an ownerless buyback could never be retuned or wired to its pool.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // -----------------------------------------------------------------------
    // Wiring
    // -----------------------------------------------------------------------

    /// @notice Binds this contract to the `$TOKEN/USDG` pool, once and for all.
    /// @param key The v4 pool key. Exactly one of its currencies must be `usdg`; the other is
    ///        taken to be `$TOKEN`. On mainnet that pool is PONS-launched and carries the PONS
    ///        hook — allowed and expected; their hook fee is simply paid out of our swap.
    /// @dev Owner-only and one-time (`AlreadySet`). The pool need not be initialized yet;
    ///      `poke` reverts `PoolNotInitialized` until it is.
    function setTargetPool(PoolKey calldata key) external onlyOwner {
        if (targetPoolSet) revert AlreadySet();

        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);

        address other;
        if (c0 == usdg && c1 != usdg) {
            usdgIsCurrency0 = true;
            other = c1;
        } else if (c1 == usdg && c0 != usdg) {
            usdgIsCurrency0 = false;
            other = c0;
        } else {
            revert InvalidCurrencies();
        }
        if (other == address(0)) revert InvalidCurrencies();

        _targetPool = key;
        token = other;
        targetPoolSet = true;

        emit TargetPoolSet(PoolId.unwrap(key.toId()), other, usdgIsCurrency0);
    }

    /// @notice The bound pool key (zeroed until `setTargetPool` runs).
    function targetPool() external view returns (PoolKey memory) {
        return _targetPool;
    }

    // -----------------------------------------------------------------------
    // Tunables — owner-only, always inside the hardcoded bounds above
    // -----------------------------------------------------------------------

    function setMaxPerPoke(uint256 newMaxPerPoke) external onlyOwner {
        if (newMaxPerPoke == 0 || newMaxPerPoke > MAX_PER_POKE_LIMIT) revert InvalidParameter();
        maxPerPoke = newMaxPerPoke;
        emit MaxPerPokeSet(newMaxPerPoke);
    }

    function setCooldown(uint256 newCooldown) external onlyOwner {
        if (newCooldown < MIN_COOLDOWN) revert InvalidParameter();
        cooldown = newCooldown;
        emit CooldownSet(newCooldown);
    }

    /// @dev Only the bps leg is tunable; the absolute `REWARD_CAP` is a constant.
    function setReward(uint256 newRewardBps) external onlyOwner {
        if (newRewardBps > MAX_REWARD_BPS) revert InvalidParameter();
        rewardBps = newRewardBps;
        emit RewardSet(newRewardBps);
    }

    // -----------------------------------------------------------------------
    // Buyback
    // -----------------------------------------------------------------------

    /// @notice Spends up to `maxPerPoke` USDG buying `$TOKEN` and burns every unit bought.
    /// @param minTokensOut Caller-supplied floor on the `$TOKEN` received. Must be nonzero:
    ///        a zero floor is how a poke gets sandwiched for everything the impact bound will
    ///        tolerate, so it is rejected outright (`MinimumOutputRequired`).
    /// @dev Permissionless, `nonReentrant`, rate-limited by `cooldown`.
    ///
    ///      Sizing, in order: `amountIn = min(maxPerPoke, balance)`;
    ///      `reward = min(amountIn * rewardBps / 10_000, REWARD_CAP)`; `amountIn -= reward`.
    ///      Taking the reward out of the same slice is what makes it *always* funded — the
    ///      contract never promises a reward it has not already withheld from the swap.
    ///
    ///      `lastPoke` is written before any external call (CEI): a reverting swap rolls it
    ///      back with everything else, and a successful one cannot be re-entered into.
    function poke(uint256 minTokensOut) external nonReentrant {
        if (!targetPoolSet) revert TargetNotSet();
        if (minTokensOut == 0) revert MinimumOutputRequired();

        uint256 last = lastPoke;
        if (last != 0 && block.timestamp < last + cooldown) revert CooldownActive();

        uint256 balance = IERC20Minimal(usdg).balanceOf(address(this));
        uint256 amountIn = balance < maxPerPoke ? balance : maxPerPoke;
        uint256 reward = (amountIn * rewardBps) / BASIS_POINTS;
        if (reward > REWARD_CAP) reward = REWARD_CAP;
        amountIn -= reward;
        if (amountIn == 0) revert NothingToBuy();

        // Effects before interactions.
        lastPoke = block.timestamp;

        PoolId poolId = _targetPool.toId();
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolId);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();

        (uint256 consumed, uint256 tokensOut) = _swapUsdgForToken(amountIn);
        if (consumed == 0 || tokensOut == 0) revert SwapFailed();

        // Bound the realized price against the pre-swap spot quote for what actually executed.
        uint256 spotOut = _quoteUsdgToToken(sqrtPriceX96, consumed);
        uint256 floorOut = (spotOut * (BASIS_POINTS - maxImpactBps)) / BASIS_POINTS;
        if (tokensOut < floorOut) revert ImpactTooHigh(tokensOut, floorOut);
        if (tokensOut < minTokensOut) revert SlippageExceeded(tokensOut, minTokensOut);

        _transferExact(token, DEAD, tokensOut);
        if (reward != 0) _transferExact(usdg, msg.sender, reward);

        emit Poked(msg.sender, consumed, tokensOut, reward);
    }

    /// @dev Exact-in USDG -> `$TOKEN` against the target pool, with the price limit wide open;
    ///      the `maxImpactBps` check in `poke` is what actually bounds the price.
    function _swapUsdgForToken(uint256 amountIn) private returns (uint256 consumed, uint256 tokensOut) {
        bytes memory result = poolManager.unlock(abi.encode(amountIn));
        (consumed, tokensOut) = abi.decode(result, (uint256, uint256));
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Only reachable from the PoolManager (which calls back exclusively to whoever
    ///      called `unlock`) while `poke` holds the reentrancy guard. Both are asserted.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (!_reentrancyGuardEntered()) revert NotUnlocking();

        uint256 amountIn = abi.decode(data, (uint256));
        PoolKey memory key = _targetPool;
        bool zeroForOne = usdgIsCurrency0;

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
        uint256 tokensOut = outputDelta > 0 ? uint256(uint128(outputDelta)) : 0;

        // A partial fill leaves the unspent USDG right here, for the next poke.
        if (consumed != 0) _settleExact(zeroForOne ? key.currency0 : key.currency1, consumed);
        if (tokensOut != 0) {
            Currency outCurrency = zeroForOne ? key.currency1 : key.currency0;
            _takeExact(outCurrency, Currency.unwrap(outCurrency), tokensOut);
        }

        return abi.encode(consumed, tokensOut);
    }

    // -----------------------------------------------------------------------
    // ERC-20 boundary helpers (balance-delta accounting at every edge)
    // -----------------------------------------------------------------------

    function _takeExact(Currency currency, address tokenAddr, uint256 amount) private {
        uint256 before = IERC20Minimal(tokenAddr).balanceOf(address(this));
        poolManager.take(currency, address(this), amount);
        uint256 received = IERC20Minimal(tokenAddr).balanceOf(address(this)) - before;
        if (received != amount) revert InexactTransfer(tokenAddr, amount, received);
    }

    function _settleExact(Currency currency, uint256 amount) private {
        address tokenAddr = Currency.unwrap(currency);
        uint256 before = IERC20Minimal(tokenAddr).balanceOf(address(poolManager));
        poolManager.sync(currency);
        currency.transfer(address(poolManager), amount);
        uint256 received = IERC20Minimal(tokenAddr).balanceOf(address(poolManager)) - before;
        if (received != amount) revert InexactTransfer(tokenAddr, amount, received);
        poolManager.settle();
    }

    /// @dev Plain transfer with the received amount verified at the destination, so a
    ///      fee-on-transfer token reverts the whole poke instead of under-burning.
    function _transferExact(address tokenAddr, address to, uint256 amount) private {
        uint256 before = IERC20Minimal(tokenAddr).balanceOf(to);
        Currency.wrap(tokenAddr).transfer(to, amount);
        uint256 received = IERC20Minimal(tokenAddr).balanceOf(to) - before;
        if (received != amount) revert InexactTransfer(tokenAddr, amount, received);
    }

    // -----------------------------------------------------------------------
    // Pricing
    // -----------------------------------------------------------------------

    /// @dev Spot value of `usdgAmount` USDG in `$TOKEN`, from the pool's sqrtPriceX96.
    ///      `price(token1/token0) = (sqrtPriceX96 / 2**96)**2`, evaluated in two `mulDiv`
    ///      steps so the intermediate never needs the full 2**192.
    function _quoteUsdgToToken(uint160 sqrtPriceX96, uint256 usdgAmount) private view returns (uint256) {
        if (usdgIsCurrency0) {
            uint256 inter = FullMath.mulDiv(usdgAmount, sqrtPriceX96, FixedPoint96.Q96);
            return FullMath.mulDiv(inter, sqrtPriceX96, FixedPoint96.Q96);
        } else {
            uint256 inter = FullMath.mulDiv(usdgAmount, FixedPoint96.Q96, sqrtPriceX96);
            return FullMath.mulDiv(inter, FixedPoint96.Q96, sqrtPriceX96);
        }
    }

    /// @notice Spot `$TOKEN` value of a USDG amount on the target pool. View helper for
    ///         callers sizing `minTokensOut`.
    function quoteUsdgToToken(uint256 usdgAmount) external view returns (uint256) {
        if (!targetPoolSet) revert TargetNotSet();
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(_targetPool.toId());
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        return _quoteUsdgToToken(sqrtPriceX96, usdgAmount);
    }
}
