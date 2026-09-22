// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

import {
    IAgentFactory,
    IAgentRegistry,
    IAgentNFT,
    IRoyaltyDistributor,
    IAgentBondingCurve,
    IFeeSplitHook,
    ILiquidityLocker
} from "./interfaces/ILaunchpad.sol";
import {AgentToken} from "./AgentToken.sol";
import {AgentBondingCurve} from "./AgentBondingCurve.sol";
import {GraduationChecks} from "./libraries/GraduationChecks.sol";
import {GraduationMath} from "./libraries/GraduationMath.sol";

/// @title AgentFactory
/// @notice The launchpad's spine: it takes a creation request, opens the registry's genesis
///         window against the enclave's KMS-predicted treasury key, brings the agent live once
///         that enclave has registered, and later graduates its bonding curve into a locked
///         Uniswap v4 pool.
///
/// @dev Structure worth knowing before reading the code:
///
///      * **Two-step creation.** `createAgent` only escrows the creation fee and opens genesis;
///        nothing is deployed yet, because the agent's treasury EOA does not exist until the
///        enclave boots. `finalize` (permissionless) deploys the token and curve once the
///        registry has an instance; `cancel` (creator-only, after the deadline) refunds the fee
///        if the enclave never showed up. Both clear the pending record, so the two paths are
///        mutually exclusive by construction.
///
///      * **Two-phase graduation.** `graduate` does the irreversible half (sweep the curve,
///        burn the phantom-backed token overhang) and `createGraduatedPool` the retryable half
///        (register the pool with the hook, initialize it, seed and lock the liquidity). Both
///        are permissionless; phase two leaves the swept state intact if anything reverts, so
///        anyone can retry it forever. `GraduationChecks` runs before *both*, so an unseedable
///        pool is rejected while the sweep can still be avoided.
///
///      * **Ordering invariants.** In `finalize`, the full AGENT supply is minted to the curve
///        clone's address *before* `initialize`, because the curve seeds its token reserve from
///        `balanceOf`. In `createGraduatedPool`, `hook.registerPool` runs *before*
///        `poolManager.initialize`: the hook's `beforeInitialize` only gates by sender, so an
///        initialized-but-unregistered pool would swap untaxed.
///
///      * **Owner powers.** Pause/unpause `createAgent`, and re-point the platform fee
///        recipient. That is the entire admin surface — no sweep, no rescue, no parameter
///        setters, and `renounceOwnership` is disabled.
contract AgentFactory is IAgentFactory, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    // -----------------------------------------------------------------------
    // Parameters (see SPEC-M1 "Parameters"; DEFAULT = tunable between deploys)
    // -----------------------------------------------------------------------

    /// @notice USDG (6 decimals) charged per creation request, refundable only via `cancel`.
    uint256 public constant CREATION_FEE = 75e6;
    /// @notice Virtual USDG the curve prices against; also sets the graduated pool's token side.
    uint256 public constant PHANTOM_QUOTE = 6_000e6;
    /// @notice Real USDG reserve at which a curve closes and graduation opens.
    uint256 public constant GRADUATION_THRESHOLD = 42_000e6;
    /// @notice How long an agent's enclave has to register before the creator may cancel.
    uint64 public constant GENESIS_WINDOW = 24 hours;

    /// @notice Graduated pools carry no LP fee — the hook takes the swap fee instead.
    uint24 public constant POOL_FEE = 0;
    /// @notice Fixed tick spacing of every agent pool.
    int24 public constant TICK_SPACING = 60;

    // -----------------------------------------------------------------------
    // Immutables
    // -----------------------------------------------------------------------

    IERC20 public immutable usdg;
    IPoolManager public immutable poolManager;
    IAgentRegistry public immutable registry;
    IAgentNFT public immutable nft;
    IRoyaltyDistributor public immutable distributor;
    IFeeSplitHook public immutable hook;
    ILiquidityLocker public immutable locker;
    address public immutable treasuryBuyback;
    /// @notice Orchestrator gas address: every `msg.value` sent with `createAgent` is forwarded
    ///         here to fund the enclave launch. Never refundable — it is spent off-chain.
    address public immutable genesisGasRecipient;
    /// @notice The `AgentBondingCurve` implementation every agent's clone delegates to.
    address public immutable curveImplementation;

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    /// @notice Swept curve reserves waiting to be seeded into a pool (phase 1 -> phase 2).
    struct SweptState {
        uint256 usdg;
        uint256 poolTokens;
    }

    /// @notice Recipient of the creation fee at `finalize`. Owner-settable; that and pausing
    ///         are the only admin powers this contract has.
    address public platformFeeRecipient;

    /// @notice Last issued agent id. Ids start at 1; 0 is never valid.
    uint256 public agentCount;

    mapping(uint256 agentId => PendingAgent) private _pending;
    mapping(uint256 agentId => SweptState) public sweptOf;

    /// @inheritdoc IAgentFactory
    mapping(uint256 agentId => address) public tokenOf;
    /// @inheritdoc IAgentFactory
    mapping(uint256 agentId => address) public curveOf;

    // -----------------------------------------------------------------------
    // Errors / events
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error NoPendingAgent();
    error NotCreator();
    error NotRegistered();
    error AlreadyRegistered();
    error GenesisStillOpen();
    error NotFinalized();
    error AlreadySwept();
    error NothingSwept();
    error NotReadyToGraduate();
    error GasForwardFailed();
    error InexactTransfer(address token, uint256 expected, uint256 actual);
    error RenounceDisabled();

    /// @notice Emitted once a graduated agent's pool exists and its liquidity is locked.
    event GraduatedPoolCreated(
        uint256 indexed agentId, bytes32 indexed poolId, uint160 sqrtPriceX96, uint128 liquidity
    );
    event PlatformFeeRecipientSet(address indexed recipient);

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    /// @param owner_ Platform multisig. Also the initial `platformFeeRecipient`.
    constructor(
        address usdg_,
        address poolManager_,
        address registry_,
        address nft_,
        address distributor_,
        address hook_,
        address locker_,
        address treasuryBuyback_,
        address genesisGasRecipient_,
        address owner_
    ) Ownable(owner_) {
        if (
            usdg_ == address(0) || poolManager_ == address(0) || registry_ == address(0) || nft_ == address(0)
                || distributor_ == address(0) || hook_ == address(0) || locker_ == address(0)
                || treasuryBuyback_ == address(0) || genesisGasRecipient_ == address(0)
        ) revert ZeroAddress();

        usdg = IERC20(usdg_);
        poolManager = IPoolManager(poolManager_);
        registry = IAgentRegistry(registry_);
        nft = IAgentNFT(nft_);
        distributor = IRoyaltyDistributor(distributor_);
        hook = IFeeSplitHook(hook_);
        locker = ILiquidityLocker(locker_);
        treasuryBuyback = treasuryBuyback_;
        genesisGasRecipient = genesisGasRecipient_;

        // One implementation, cloned per agent (EIP-1167). Its constructor bricks itself, so the
        // implementation can never be initialized or traded against directly.
        curveImplementation = address(new AgentBondingCurve());

        platformFeeRecipient = owner_;
        emit PlatformFeeRecipientSet(owner_);
    }

    // -----------------------------------------------------------------------
    // Creation lifecycle
    // -----------------------------------------------------------------------

    /// @inheritdoc IAgentFactory
    /// @dev Escrows `CREATION_FEE` USDG here until `finalize` (pays the platform) or `cancel`
    ///      (refunds the creator), forwards any ETH to the orchestrator's gas address, and opens
    ///      the registry's genesis window pinned to `expectedTreasuryEOA`.
    function createAgent(
        string calldata name,
        string calldata symbol,
        string calldata imageURI,
        bytes32 configHash,
        address creator,
        address expectedTreasuryEOA
    ) external payable nonReentrant whenNotPaused returns (uint256 agentId) {
        if (creator == address(0) || expectedTreasuryEOA == address(0)) {
            revert ZeroAddress();
        }

        agentId = ++agentCount;
        uint64 deadline = uint64(block.timestamp) + GENESIS_WINDOW;

        _pending[agentId] = PendingAgent({
            creator: creator,
            configHash: configHash,
            imageURI: imageURI,
            name: name,
            symbol: symbol,
            genesisDeadline: deadline,
            feePaid: true
        });

        _pullExact(msg.sender, CREATION_FEE);

        if (msg.value != 0) {
            (bool ok,) = genesisGasRecipient.call{value: msg.value}("");
            if (!ok) revert GasForwardFailed();
        }

        registry.openGenesis(agentId, deadline, expectedTreasuryEOA);

        emit AgentRequested(agentId, configHash, creator);
    }

    /// @inheritdoc IAgentFactory
    /// @dev Permissionless — anyone may pay the gas to bring a registered agent live. The NFT's
    ///      token URI is `pending.imageURI`, which is the Arweave metadata URI the website
    ///      uploaded before calling `createAgent` (02 §5); it is permanent.
    function finalize(uint256 agentId) external nonReentrant {
        PendingAgent memory p = _pending[agentId];
        if (p.creator == address(0)) revert NoPendingAgent();
        if (!registry.isRegistered(agentId)) revert NotRegistered();

        // Cleared first: `cancel` and a second `finalize` both key off this record.
        delete _pending[agentId];

        // ORDERING (binding): the clone's address is known before it holds code, the token
        // constructor mints the entire supply to it, and only then does `initialize` run and
        // seed `_tokenReserve` from `balanceOf`. All three in this transaction.
        address curve = Clones.clone(curveImplementation);
        AgentToken token = new AgentToken(p.name, p.symbol, curve);
        IAgentBondingCurve(curve)
            .initialize(
                agentId,
                address(token),
                address(usdg),
                address(registry),
                address(distributor),
                treasuryBuyback,
                PHANTOM_QUOTE,
                GRADUATION_THRESHOLD
            );

        tokenOf[agentId] = address(token);
        curveOf[agentId] = curve;

        distributor.setCurve(agentId, curve);
        nft.mint(p.creator, agentId, p.imageURI);
        usdg.safeTransfer(platformFeeRecipient, CREATION_FEE);

        emit AgentLive(agentId, address(token), curve);
    }

    /// @inheritdoc IAgentFactory
    /// @dev Only the creator, only once the genesis window has lapsed with no instance
    ///      registered. Refunds the USDG creation fee; the ETH gas contribution is not
    ///      refundable, having already been spent launching the enclave.
    function cancel(uint256 agentId) external nonReentrant {
        PendingAgent memory p = _pending[agentId];
        if (p.creator == address(0)) revert NoPendingAgent();
        if (msg.sender != p.creator) revert NotCreator();
        if (block.timestamp <= p.genesisDeadline) revert GenesisStillOpen();
        if (registry.isRegistered(agentId)) revert AlreadyRegistered();

        delete _pending[agentId];

        usdg.safeTransfer(p.creator, CREATION_FEE);

        emit AgentCancelled(agentId);
    }

    // -----------------------------------------------------------------------
    // Graduation — phase 1 (irreversible)
    // -----------------------------------------------------------------------

    /// @inheritdoc IAgentFactory
    /// @dev Sweeps the curve's tracked reserves here and burns the share of the AGENT reserve
    ///      that the *phantom* quote was backing: only `sweptUsdg / (sweptUsdg + PHANTOM_QUOTE)`
    ///      of the remaining tokens have real USDG behind them, and the rest would otherwise
    ///      seed the pool at a price below the curve's last fill. The preflight runs on the
    ///      projected amounts *before* the sweep, because the sweep cannot be undone.
    function graduate(uint256 agentId) external nonReentrant {
        address curve = curveOf[agentId];
        if (curve == address(0)) revert NotFinalized();
        if (sweptOf[agentId].usdg != 0) revert AlreadySwept();
        if (!IAgentBondingCurve(curve).readyToGraduate()) revert NotReadyToGraduate();

        address token = tokenOf[agentId];

        // Preflight on the projected pool amounts. Nothing can move between this read and the
        // sweep below: the curve is closed to trading and this call holds the guard.
        (uint256 projUsdg, uint256 projTokens) = IAgentBondingCurve(curve).reserves();
        _assertSeedable(token, projUsdg, FullMath.mulDiv(projTokens, projUsdg, projUsdg + PHANTOM_QUOTE));

        uint256 usdgBefore = usdg.balanceOf(address(this));
        uint256 tokenBefore = IERC20(token).balanceOf(address(this));

        (uint256 usdgSwept, uint256 tokensSwept) = IAgentBondingCurve(curve).graduate(address(this));

        uint256 usdgReceived = usdg.balanceOf(address(this)) - usdgBefore;
        if (usdgReceived != usdgSwept) revert InexactTransfer(address(usdg), usdgSwept, usdgReceived);
        uint256 tokensReceived = IERC20(token).balanceOf(address(this)) - tokenBefore;
        if (tokensReceived != tokensSwept) revert InexactTransfer(token, tokensSwept, tokensReceived);

        uint256 poolTokens = FullMath.mulDiv(tokensSwept, usdgSwept, usdgSwept + PHANTOM_QUOTE);
        uint256 burned = tokensSwept - poolTokens;

        sweptOf[agentId] = SweptState({usdg: usdgSwept, poolTokens: poolTokens});

        emit AgentGraduated(agentId, usdgSwept, poolTokens, burned);

        if (burned != 0) ERC20Burnable(token).burn(burned);
    }

    // -----------------------------------------------------------------------
    // Graduation — phase 2 (retryable)
    // -----------------------------------------------------------------------

    /// @inheritdoc IAgentFactory
    /// @dev Retryable by anyone: the swept state is only cleared on a path that completes, so a
    ///      revert anywhere here rolls back to "swept, not yet seeded" and the next caller tries
    ///      again. `registerPool` deliberately precedes `initialize` — see the ordering note in
    ///      the contract docs.
    function createGraduatedPool(uint256 agentId) external nonReentrant {
        SweptState memory s = sweptOf[agentId];
        if (s.usdg == 0) revert NothingSwept();

        address token = tokenOf[agentId];

        // Same preflight as phase 1, now on the amounts that will actually be seeded.
        _assertSeedable(token, s.usdg, s.poolTokens);

        (uint256 amount0, uint256 amount1) = _sortAmounts(token, s.usdg, s.poolTokens);
        uint160 sqrtPriceX96 = GraduationMath.sqrtPriceX96FromAmounts(amount0, amount1);

        PoolKey memory key = _poolKey(token);

        // CEI: the amounts ride on the stack from here on.
        delete sweptOf[agentId];

        hook.registerPool(key, agentId, token);
        poolManager.initialize(key, sqrtPriceX96);

        IERC20(Currency.unwrap(key.currency0)).safeTransfer(address(locker), amount0);
        IERC20(Currency.unwrap(key.currency1)).safeTransfer(address(locker), amount1);
        uint128 liquidity = locker.lock(agentId, key, amount0, amount1);

        emit GraduatedPoolCreated(agentId, PoolId.unwrap(key.toId()), sqrtPriceX96, liquidity);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// @notice The pending creation record for `agentId`, or an all-zero struct once the agent
    ///         has been finalized or cancelled.
    function pendingAgent(uint256 agentId) external view returns (PendingAgent memory) {
        return _pending[agentId];
    }

    /// @notice The PoolKey a graduated agent's pool uses (or will use).
    function poolKeyOf(uint256 agentId) external view returns (PoolKey memory) {
        address token = tokenOf[agentId];
        if (token == address(0)) revert NotFinalized();
        return _poolKey(token);
    }

    // -----------------------------------------------------------------------
    // Owner surface (pause + fee recipient, nothing else)
    // -----------------------------------------------------------------------

    /// @notice Stops new creation requests. Does not touch `finalize`, `cancel`, `graduate` or
    ///         `createGraduatedPool` — an agent already in flight can always complete.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setPlatformFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        platformFeeRecipient = recipient;
        emit PlatformFeeRecipientSet(recipient);
    }

    /// @dev Disabled: an ownerless factory could never be paused or re-pointed again.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /// @dev Pulls exactly `amount` USDG from `from`, measured as a balance delta, so a
    ///      fee-on-transfer quote asset can never under-fund the escrow.
    function _pullExact(address from, uint256 amount) private {
        uint256 before = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(from, address(this), amount);
        uint256 received = usdg.balanceOf(address(this)) - before;
        if (received != amount) revert InexactTransfer(address(usdg), amount, received);
    }

    function _assertSeedable(address token, uint256 usdgAmount, uint256 tokenAmount) private view {
        (uint256 amount0, uint256 amount1) = _sortAmounts(token, usdgAmount, tokenAmount);
        GraduationChecks.assertSeedable(TICK_SPACING, amount0, amount1);
    }

    /// @dev Orders a (USDG, AGENT) pair the way the PoolKey will.
    function _sortAmounts(address token, uint256 usdgAmount, uint256 tokenAmount)
        private
        view
        returns (uint256 amount0, uint256 amount1)
    {
        return token < address(usdg) ? (tokenAmount, usdgAmount) : (usdgAmount, tokenAmount);
    }

    function _poolKey(address token) private view returns (PoolKey memory) {
        (Currency c0, Currency c1) = token < address(usdg)
            ? (Currency.wrap(token), Currency.wrap(address(usdg)))
            : (Currency.wrap(address(usdg)), Currency.wrap(token));
        return
            PoolKey({
                currency0: c0, currency1: c1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: IHooks(address(hook))
            });
    }
}
