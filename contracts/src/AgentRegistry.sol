// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IAgentRegistry} from "./interfaces/ILaunchpad.sol";

/// @notice TEE-attested agent instance registry. Pins `treasuryEOA`,
///         `actionEOA` and a code measurement hash at first registration
///         (inside the genesis window opened by the factory), and allows
///         permissionless revival with identical pinned keys once the
///         heartbeat has gone stale past `REVIVAL_WINDOW`. A fresh heartbeat
///         blocks displacement, giving a single-instance lock.
contract AgentRegistry is IAgentRegistry {
    uint64 public constant REVIVAL_WINDOW = 7 days;

    /// @dev Captured at deploy time; the only address allowed to call the
    ///      one-time wiring setter below.
    address public immutable deployer;
    address public factory;

    mapping(uint256 => AgentInstance) private _instances;
    mapping(uint256 => uint64) public genesisDeadline;
    /// @notice KMS-predicted treasury EOA per agent, pinned by the factory at genesis open.
    ///         First registration is only accepted from exactly this address; without it, any
    ///         EOA could front-run the enclave during the genesis window and hijack the
    ///         agent's fee stream (attestation is verified off-chain in v1, so the predicted
    ///         key — publicly recomputable via Marlin kms-derive — is the only on-chain anchor).
    mapping(uint256 => address) public expectedTreasuryEOA;

    error ZeroAddress();
    error ZeroCodeHash();
    error AlreadySet();
    error NotDeployer();
    error NotFactory();
    error NotTreasury();
    error GenesisNotOpened();
    error GenesisClosed();
    error RevivalWindowNotElapsed();
    error UnexpectedTreasury();
    error MismatchedRevivalKeys();
    error NotRegistered();

    modifier onlyDeployer() {
        if (msg.sender != deployer) revert NotDeployer();
        _;
    }

    constructor() {
        deployer = msg.sender;
    }

    function setFactory(address _factory) external onlyDeployer {
        if (factory != address(0)) revert AlreadySet();
        if (_factory == address(0)) revert ZeroAddress();
        factory = _factory;
    }

    function openGenesis(uint256 agentId, uint64 deadline, address expectedTreasuryEOA_) external {
        if (msg.sender != factory) revert NotFactory();
        if (expectedTreasuryEOA_ == address(0)) revert ZeroAddress();
        genesisDeadline[agentId] = deadline;
        expectedTreasuryEOA[agentId] = expectedTreasuryEOA_;
        emit GenesisOpened(agentId, deadline);
    }

    /// @notice Register (first time) or revive (subsequent times) an agent's
    ///         TEE instance. `msg.sender` must be `treasuryEOA` itself
    ///         (possession proof).
    function registerInstance(
        uint256 agentId,
        address treasuryEOA,
        address actionEOA,
        bytes32 codeHash,
        string calldata attestationRef
    ) external {
        if (msg.sender != treasuryEOA) revert NotTreasury();
        if (treasuryEOA == address(0) || actionEOA == address(0)) revert ZeroAddress();
        if (codeHash == bytes32(0)) revert ZeroCodeHash();

        AgentInstance storage inst = _instances[agentId];

        if (inst.lastHeartbeat == 0) {
            // First registration: must be inside the genesis window, and only from the
            // KMS-predicted treasury key (front-run protection — see expectedTreasuryEOA).
            uint64 deadline = genesisDeadline[agentId];
            if (deadline == 0) revert GenesisNotOpened();
            if (block.timestamp > deadline) revert GenesisClosed();
            if (treasuryEOA != expectedTreasuryEOA[agentId]) revert UnexpectedTreasury();

            inst.treasuryEOA = treasuryEOA;
            inst.actionEOA = actionEOA;
            inst.codeHash = codeHash;
            inst.attestationRef = attestationRef;
            inst.generation = 1;
            inst.lastHeartbeat = uint64(block.timestamp);
        } else {
            // Revival: only once stale, and only with identical pinned keys.
            if (block.timestamp - inst.lastHeartbeat <= REVIVAL_WINDOW) {
                revert RevivalWindowNotElapsed();
            }
            if (inst.treasuryEOA != treasuryEOA || inst.actionEOA != actionEOA || inst.codeHash != codeHash) {
                revert MismatchedRevivalKeys();
            }
            inst.attestationRef = attestationRef;
            inst.generation += 1;
            inst.lastHeartbeat = uint64(block.timestamp);
        }

        emit InstanceRegistered(agentId, treasuryEOA, actionEOA, codeHash, inst.generation);
    }

    function heartbeat(uint256 agentId) external {
        AgentInstance storage inst = _instances[agentId];
        if (inst.lastHeartbeat == 0) revert NotRegistered();
        if (msg.sender != inst.treasuryEOA) revert NotTreasury();
        inst.lastHeartbeat = uint64(block.timestamp);
        emit Heartbeat(agentId, inst.lastHeartbeat);
    }

    function isRegistered(uint256 agentId) public view returns (bool) {
        return _instances[agentId].lastHeartbeat != 0;
    }

    function treasuryOf(uint256 agentId) external view returns (address) {
        if (!isRegistered(agentId)) revert NotRegistered();
        return _instances[agentId].treasuryEOA;
    }

    function instanceOf(uint256 agentId) external view returns (AgentInstance memory) {
        return _instances[agentId];
    }
}
