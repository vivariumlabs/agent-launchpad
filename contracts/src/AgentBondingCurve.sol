// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAgentBondingCurve, IAgentRegistry, IRoyaltyDistributor} from "./interfaces/ILaunchpad.sol";
import {CurveMath} from "./libraries/CurveMath.sol";

/// @dev Minimal ERC-20 surface used by the curve. Declared here so the curve
/// carries no external token dependency of its own.
interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title AgentBondingCurve
 * @notice Constant-product bonding curve for one agent launch: AGENT tokens
 * priced against (real USDG reserve + phantom quote). Deployed once as an
 * implementation and used per agent as an EIP-1167 clone, so every parameter
 * lives in storage and is set by `initialize` rather than by a constructor.
 *
 * @dev Money-path rules this contract is built around:
 *  - Fees are charged on the USDG leg of every trade (3%, `TOTAL_FEE_BPS`) and
 *    pushed out immediately in three legs: TreasuryBuyback, the agent's
 *    registered treasury EOA (looked up live, never stored) and the
 *    RoyaltyDistributor (transfer, then `credit`). Nothing accrues here.
 *  - Reserves are tracked in storage. `balanceOf` is read exactly twice: to
 *    seed the token reserve at `initialize`, and to verify transfer deltas.
 *    Donated USDG or AGENT can therefore never move the price, never bring
 *    graduation forward, and are never swept into the graduated pool.
 *  - The curve closes for both buys and sells the moment the real USDG reserve
 *    reaches `graduationThreshold`. The buy that crosses the threshold is
 *    filled in full; the overshoot simply seeds a deeper pool at graduation.
 */
contract AgentBondingCurve is IAgentBondingCurve {
    uint256 internal constant BASIS_POINTS = 10_000;
    /// @notice Total trade fee, charged on the USDG leg, split three ways.
    uint256 public constant TOTAL_FEE_BPS = 300;

    error NotFactory();
    error AlreadyInitialized();
    error NotInitialized();
    error ZeroAddress();
    error ZeroAmount();
    error CurveClosed();
    error AlreadyGraduated();
    error NotReadyToGraduate();
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error InexactTransfer(uint256 received, uint256 expected);
    error InsufficientRealReserve(uint256 required, uint256 available);
    error TransferFailed();
    error Reentrancy();

    /// @notice The factory that initialized this clone; the only caller of `graduate`.
    address public factory;
    /// @notice The agent this curve belongs to.
    uint256 public agentId;

    address public agentToken;
    address public usdg;
    address public registry;
    address public distributor;
    address public treasuryBuyback;

    /// @notice Virtual USDG added to the real reserve for pricing only.
    uint256 public phantomQuote;
    /// @notice Real USDG reserve at which the curve closes and graduation opens.
    uint256 public graduationThreshold;

    /// @notice Real USDG held as trading reserve (fees excluded — they leave every trade).
    uint256 private _realUsdg;
    /// @notice AGENT tokens held as tradeable reserve.
    uint256 private _tokenReserve;

    /// @inheritdoc IAgentBondingCurve
    bool public graduated;

    bool private _initialized;
    /// @dev `_ENTERED` while a guarded call is in flight, `_NOT_ENTERED`
    /// otherwise. A plain storage flag rather than transient storage: the
    /// curve must behave identically on chains whose EVM version predates
    /// cancun. The guard tests for `_ENTERED` rather than for `_NOT_ENTERED`
    /// because a fresh clone's storage is all zeroes — `initialize` warms the
    /// slot, and an uninitialized clone still reports `NotInitialized`.
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _lock;

    modifier nonReentrant() {
        if (_lock == _ENTERED) revert Reentrancy();
        _lock = _ENTERED;
        _;
        _lock = _NOT_ENTERED;
    }

    /// @dev Bricks the implementation contract: clones are the only usable form.
    constructor() {
        _initialized = true;
    }

    /// @inheritdoc IAgentBondingCurve
    /// @dev Callable once per clone. The caller becomes the factory, which is
    /// the clone-deployment pattern: the factory deploys and initializes in one
    /// transaction, so no other address can ever win the race.
    /// The token reserve is seeded from this curve's AGENT balance, which the
    /// factory mints in full to the clone immediately before this call.
    function initialize(
        uint256 agentId_,
        address agentToken_,
        address usdg_,
        address registry_,
        address distributor_,
        address treasuryBuyback_,
        uint256 phantomQuote_,
        uint256 graduationThreshold_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        if (
            agentToken_ == address(0) || usdg_ == address(0) || registry_ == address(0) || distributor_ == address(0)
                || treasuryBuyback_ == address(0)
        ) revert ZeroAddress();
        if (agentId_ == 0 || phantomQuote_ == 0 || graduationThreshold_ == 0) revert ZeroAmount();
        // Both legs are paid out with low-level calls, which a codeless
        // address would answer successfully and silently.
        if (agentToken_.code.length == 0 || usdg_.code.length == 0) revert ZeroAddress();

        _initialized = true;
        _lock = _NOT_ENTERED;
        factory = msg.sender;
        agentId = agentId_;
        agentToken = agentToken_;
        usdg = usdg_;
        registry = registry_;
        distributor = distributor_;
        treasuryBuyback = treasuryBuyback_;
        phantomQuote = phantomQuote_;
        graduationThreshold = graduationThreshold_;

        uint256 supply = IERC20Minimal(agentToken_).balanceOf(address(this));
        if (supply == 0) revert ZeroAmount();
        _tokenReserve = supply;
    }

    /// @inheritdoc IAgentBondingCurve
    /// @dev The whole of `usdgIn` is charged; `TOTAL_FEE_BPS` of it leaves as
    /// fees and the remainder joins the reserve and prices the trade. A buy
    /// that takes the real reserve past `graduationThreshold` is filled in
    /// full — no partial fills — and closes the curve behind it.
    function buy(uint256 usdgIn, uint256 minTokensOut, address recipient)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        _requireOpen();
        if (usdgIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        _pullExact(usdg, msg.sender, usdgIn);
        // `graduate` is not reentrancy-guarded, so a USDG that yields control
        // during `transferFrom` could in principle close the curve between the
        // check above and the reserve reads below. Cheap to re-check.
        if (_closed()) revert CurveClosed();

        uint256 fee = (usdgIn * TOTAL_FEE_BPS) / BASIS_POINTS;
        uint256 net = usdgIn - fee;

        tokensOut = CurveMath.getAmountOut(net, _realUsdg + phantomQuote, _tokenReserve, 0);
        if (tokensOut < minTokensOut) revert SlippageExceeded(tokensOut, minTokensOut);

        _realUsdg += net;
        _tokenReserve -= tokensOut;

        emit Bought(msg.sender, usdgIn, tokensOut, fee);

        _safeTransfer(agentToken, recipient, tokensOut);
        _splitFee(fee);
    }

    /// @inheritdoc IAgentBondingCurve
    /// @dev The gross USDG the constant product prices out is bounded by the
    /// real reserve: the phantom quote is virtual and can never be paid out.
    function sell(uint256 tokensIn, uint256 minUsdgOut, address recipient)
        external
        nonReentrant
        returns (uint256 usdgOut)
    {
        _requireOpen();
        if (tokensIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 gross = CurveMath.getAmountOut(tokensIn, _tokenReserve, _realUsdg + phantomQuote, 0);
        if (gross > _realUsdg) revert InsufficientRealReserve(gross, _realUsdg);

        uint256 fee = (gross * TOTAL_FEE_BPS) / BASIS_POINTS;
        usdgOut = gross - fee;
        if (usdgOut < minUsdgOut) revert SlippageExceeded(usdgOut, minUsdgOut);

        _realUsdg -= gross;
        _tokenReserve += tokensIn;

        emit Sold(msg.sender, tokensIn, usdgOut, fee);

        _pullExact(agentToken, msg.sender, tokensIn);
        _safeTransfer(usdg, recipient, usdgOut);
        _splitFee(fee);
    }

    /// @inheritdoc IAgentBondingCurve
    /// @dev Hands over the *tracked* reserves only. Anything force-sent to this
    /// curve stays stranded here rather than seeding the graduated pool, so a
    /// donation cannot move the price the pool opens at. Deliberately not
    /// `nonReentrant`: the factory may sweep from inside its own guarded
    /// graduation flow, and the curve is already closed to trading by the time
    /// this can succeed.
    function graduate(address to) external returns (uint256 usdgSwept, uint256 tokensSwept) {
        if (msg.sender != factory) revert NotFactory();
        if (graduated) revert AlreadyGraduated();
        if (!readyToGraduate()) revert NotReadyToGraduate();
        if (to == address(0)) revert ZeroAddress();

        graduated = true;

        usdgSwept = _realUsdg;
        tokensSwept = _tokenReserve;
        _realUsdg = 0;
        _tokenReserve = 0;

        emit Graduated(usdgSwept, tokensSwept);

        if (usdgSwept != 0) _safeTransfer(usdg, to, usdgSwept);
        if (tokensSwept != 0) _safeTransfer(agentToken, to, tokensSwept);
    }

    /// @inheritdoc IAgentBondingCurve
    function readyToGraduate() public view returns (bool) {
        return _realUsdg >= graduationThreshold;
    }

    /// @inheritdoc IAgentBondingCurve
    function reserves() external view returns (uint256 realUsdg, uint256 agentTokens) {
        return (_realUsdg, _tokenReserve);
    }

    /// @inheritdoc IAgentBondingCurve
    /// @dev Mirrors `buy` exactly. Returns zero — rather than reverting — for a
    /// closed curve or an unpriceable amount, so front-end reads never throw.
    function quoteBuy(uint256 usdgIn) external view returns (uint256 tokensOut) {
        if (_closed()) return 0;
        uint256 fee = (usdgIn * TOTAL_FEE_BPS) / BASIS_POINTS;
        return CurveMath.quoteAmountOut(usdgIn - fee, _realUsdg + phantomQuote, _tokenReserve, 0);
    }

    /// @inheritdoc IAgentBondingCurve
    /// @dev Mirrors `sell` exactly, including the real-reserve bound, which is
    /// reported as zero rather than as a revert.
    function quoteSell(uint256 tokensIn) external view returns (uint256 usdgOut) {
        if (_closed()) return 0;
        uint256 gross = CurveMath.quoteAmountOut(tokensIn, _tokenReserve, _realUsdg + phantomQuote, 0);
        if (gross == 0 || gross > _realUsdg) return 0;
        return gross - (gross * TOTAL_FEE_BPS) / BASIS_POINTS;
    }

    /// @dev True once the curve stops trading: graduated, or the real reserve
    /// has reached the graduation threshold.
    function _closed() private view returns (bool) {
        return graduated || readyToGraduate();
    }

    function _requireOpen() private view {
        if (factory == address(0)) revert NotInitialized();
        if (_closed()) revert CurveClosed();
    }

    /**
     * @dev Splits `fee` three ways and pushes each leg immediately. The
     * integer remainder (`fee - 2 * third`, at most 2 wei more than a third)
     * goes to the royalty leg, so the three legs always sum to exactly `fee`
     * and no dust is ever left behind on the curve. The agent treasury is
     * resolved live from the registry on every trade — never cached.
     */
    function _splitFee(uint256 fee) private {
        if (fee == 0) return;

        uint256 third = fee / 3;
        uint256 royaltyLeg = fee - third - third;

        if (third != 0) {
            _safeTransfer(usdg, treasuryBuyback, third);
            _safeTransfer(usdg, IAgentRegistry(registry).treasuryOf(agentId), third);
        }
        _safeTransfer(usdg, distributor, royaltyLeg);
        IRoyaltyDistributor(distributor).credit(agentId, royaltyLeg);
    }

    /**
     * @dev Pulls exactly `amount` of `token` from `from`, measured as a balance
     * delta. A fee-on-transfer or rebasing token would deliver less than the
     * curve is about to price against, so the trade is rejected outright rather
     * than credited for what arrived.
     */
    function _pullExact(address token, address from, uint256 amount) private {
        uint256 balanceBefore = IERC20Minimal(token).balanceOf(address(this));
        _safeTransferFrom(token, from, address(this), amount);
        uint256 received = IERC20Minimal(token).balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert InexactTransfer(received, amount);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool success, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
