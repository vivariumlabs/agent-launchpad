// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

/// @notice Shared interfaces for the agent launchpad (M1).
/// @dev Authored by Fable — implementation batches code against these exactly.
///      Any change requires Fable sign-off; do not edit in a subagent task.

interface IAgentRegistry {
    struct AgentInstance {
        address treasuryEOA;
        address actionEOA;
        bytes32 codeHash; // pinned at first registration; revival must match
        string attestationRef; // Arweave txid of quote + verification report
        uint64 lastHeartbeat;
        uint32 generation; // 1 on genesis, ++ per revival
    }

    event GenesisOpened(uint256 indexed agentId, uint64 deadline);
    event InstanceRegistered(
        uint256 indexed agentId, address treasuryEOA, address actionEOA, bytes32 codeHash, uint32 generation
    );
    event Heartbeat(uint256 indexed agentId, uint64 timestamp);

    /// @param expectedTreasuryEOA KMS-predicted treasury address for (runtime image, agentId),
    ///        computed off-chain via Marlin kms-derive and publicly recomputable by anyone.
    ///        First registration is only accepted from exactly this address, which closes the
    ///        genesis-window front-run (an attacker cannot register foreign EOAs for the agent).
    ///        A wrong prediction simply lets genesis time out into `cancel`.
    function openGenesis(uint256 agentId, uint64 deadline, address expectedTreasuryEOA) external; // factory only
    function registerInstance(
        uint256 agentId,
        address treasuryEOA,
        address actionEOA,
        bytes32 codeHash,
        string calldata attestationRef
    ) external; // msg.sender must equal treasuryEOA
    function heartbeat(uint256 agentId) external; // registered treasuryEOA only

    function isRegistered(uint256 agentId) external view returns (bool);
    /// @dev Reverts `NotRegistered` when the agent has no instance.
    function treasuryOf(uint256 agentId) external view returns (address);
    function instanceOf(uint256 agentId) external view returns (AgentInstance memory);
}

interface IRoyaltyDistributor {
    event Credited(uint256 indexed agentId, uint256 amount);
    event Claimed(uint256 indexed agentId, address indexed to, uint256 amount);
    event Emancipated(uint256 indexed agentId, uint256 sweptToTreasury);

    /// @notice Caller (hook or the agent's curve) must have transferred `amount` USDG
    ///         to this contract immediately before; verified by balance accounting.
    function credit(uint256 agentId, uint256 amount) external;
    function claim(uint256 agentId) external; // pays accrued to nft.ownerOf(agentId)
    function onBurn(uint256 agentId) external; // AgentNFT only; one-way re-route
    function setCurve(uint256 agentId, address curve) external; // factory only, once per agent

    function accrued(uint256 agentId) external view returns (uint256);
    function emancipated(uint256 agentId) external view returns (bool);
}

interface IAgentNFT {
    function mint(address to, uint256 agentId, string calldata tokenURI_) external; // factory only
    function burn(uint256 tokenId) external; // owner only; triggers distributor.onBurn
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IAgentBondingCurve {
    event Bought(address indexed buyer, uint256 usdgIn, uint256 tokensOut, uint256 fee);
    event Sold(address indexed seller, uint256 tokensIn, uint256 usdgOut, uint256 fee);
    event Graduated(uint256 usdgSwept, uint256 tokensSwept);

    function initialize(
        uint256 agentId,
        address agentToken,
        address usdg,
        address registry,
        address distributor,
        address treasuryBuyback,
        uint256 phantomQuote,
        uint256 graduationThreshold
    ) external; // factory only, once (clone pattern)

    function buy(uint256 usdgIn, uint256 minTokensOut, address recipient) external returns (uint256 tokensOut);
    function sell(uint256 tokensIn, uint256 minUsdgOut, address recipient) external returns (uint256 usdgOut);
    function graduate(address to) external returns (uint256 usdgSwept, uint256 tokensSwept); // factory only

    function readyToGraduate() external view returns (bool);
    function graduated() external view returns (bool);
    function reserves() external view returns (uint256 realUsdg, uint256 agentTokens);
    function quoteBuy(uint256 usdgIn) external view returns (uint256 tokensOut);
    function quoteSell(uint256 tokensIn) external view returns (uint256 usdgOut);
}

interface IFeeSplitHook {
    event PoolRegistered(bytes32 indexed poolId, uint256 indexed agentId, address agentToken);
    event FeeCollected(bytes32 indexed poolId, address currency, uint256 amount);
    event Distributed(
        bytes32 indexed poolId, uint256 buybackLeg, uint256 treasuryLeg, uint256 royaltyLeg, uint256 converted
    );

    function registerPool(PoolKey calldata key, uint256 agentId, address agentToken) external; // factory only
    function distribute(bytes32 poolId, uint256 minConversionOut) external; // permissionless

    function pendingFees(bytes32 poolId, address currency) external view returns (uint256);
}

interface ILiquidityLocker {
    event Locked(uint256 indexed agentId, bytes32 indexed poolId, uint128 liquidity);

    /// @notice Mints a full-range position directly on the PoolManager and holds it forever.
    ///         Factory-only, once per agent. The factory transfers both token amounts to the
    ///         locker immediately before this call; the locker settles them against the mint.
    ///         There is no removal, collect, or call surface of any kind — liquidity is locked
    ///         by construction. Rounding dust left after settlement is stranded here (wei-level;
    ///         equivalent to burned).
    function lock(uint256 agentId, PoolKey calldata key, uint256 amount0, uint256 amount1)
        external
        returns (uint128 liquidity);

    function lockedLiquidity(uint256 agentId) external view returns (uint128);
}

interface ITreasuryBuyback {
    event Poked(address indexed caller, uint256 usdgIn, uint256 tokensBurned, uint256 callerReward);

    function poke(uint256 minTokensOut) external; // permissionless; reverts until target pool set
    function setTargetPool(PoolKey calldata key) external; // multisig, one-time
}

interface IAgentFactory {
    struct PendingAgent {
        address creator;
        bytes32 configHash;
        string imageURI;
        string name;
        string symbol;
        uint64 genesisDeadline;
        bool feePaid;
    }

    event AgentRequested(uint256 indexed agentId, bytes32 configHash, address indexed creator);
    event AgentLive(uint256 indexed agentId, address token, address curve);
    event AgentCancelled(uint256 indexed agentId);
    event AgentGraduated(uint256 indexed agentId, uint256 poolUsdg, uint256 poolTokens, uint256 burned);

    /// @param expectedTreasuryEOA KMS-predicted treasury address for this agent's enclave
    ///        (see IAgentRegistry.openGenesis) — forwarded to the registry's genesis window.
    function createAgent(
        string calldata name,
        string calldata symbol,
        string calldata imageURI,
        bytes32 configHash,
        address creator,
        address expectedTreasuryEOA
    ) external payable returns (uint256 agentId);

    function finalize(uint256 agentId) external; // permissionless, requires registered instance
    function cancel(uint256 agentId) external; // creator only, after deadline, not finalized
    function graduate(uint256 agentId) external; // permissionless, phase 1 (sweep + burn)
    function createGraduatedPool(uint256 agentId) external; // permissionless, phase 2 (retryable)

    function tokenOf(uint256 agentId) external view returns (address);
    function curveOf(uint256 agentId) external view returns (address);
}
