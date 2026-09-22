// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IRoyaltyDistributor, IAgentRegistry, IAgentNFT} from "./interfaces/ILaunchpad.sol";

interface IERC20Min {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice USDG-denominated, pull-based royalty accrual for agent NFT owners.
///         Credited by the fee-split hook (pool-phase royalties) and by each
///         agent's bonding curve (pre-graduation royalties). Burning the
///         agent NFT "emancipates" the agent: future credits skip accrual
///         and forward straight to the registered treasury, and any
///         unclaimed balance sweeps there too.
contract RoyaltyDistributor is IRoyaltyDistributor {
    IERC20Min public immutable usdg;
    IAgentNFT public immutable nft;
    IAgentRegistry public immutable registry;

    /// @dev Captured at deploy time; the only address allowed to call the
    ///      one-time wiring setters below.
    address public immutable deployer;
    address public factory;
    address public hook;

    mapping(uint256 => address) public curveOf;
    mapping(uint256 => uint256) public accrued;
    mapping(uint256 => bool) public emancipated;

    /// @dev Running total of USDG this contract has accounted for as
    ///      accrued-but-unclaimed. Used to detect that a caller actually
    ///      transferred `amount` in before calling `credit`.
    uint256 public accountedBalance;

    error ZeroAddress();
    error AlreadySet();
    error NotDeployer();
    error NotFactory();
    error NotAuthorized();
    error InexactTransfer();
    error NotAgentNFT();
    error NothingToClaim();
    error AlreadyEmancipated();

    modifier onlyDeployer() {
        if (msg.sender != deployer) revert NotDeployer();
        _;
    }

    constructor(address _usdg, address _nft, address _registry) {
        if (_usdg == address(0) || _nft == address(0) || _registry == address(0)) revert ZeroAddress();
        usdg = IERC20Min(_usdg);
        nft = IAgentNFT(_nft);
        registry = IAgentRegistry(_registry);
        deployer = msg.sender;
    }

    function setFactory(address _factory) external onlyDeployer {
        if (factory != address(0)) revert AlreadySet();
        if (_factory == address(0)) revert ZeroAddress();
        factory = _factory;
    }

    function setHook(address _hook) external onlyDeployer {
        if (hook != address(0)) revert AlreadySet();
        if (_hook == address(0)) revert ZeroAddress();
        hook = _hook;
    }

    /// @notice Bind an agent's bonding curve as an authorized credit() caller.
    ///         Factory-only, one-time per agentId.
    function setCurve(uint256 agentId, address curve) external {
        if (msg.sender != factory) revert NotFactory();
        if (curveOf[agentId] != address(0)) revert AlreadySet();
        if (curve == address(0)) revert ZeroAddress();
        curveOf[agentId] = curve;
    }

    /// @notice Credit `amount` USDG to `agentId`. Caller must be `hook` or
    ///         the agent's registered curve, and must have already
    ///         transferred `amount` USDG to this contract.
    function credit(uint256 agentId, uint256 amount) external {
        if (msg.sender != hook && msg.sender != curveOf[agentId]) revert NotAuthorized();
        if (usdg.balanceOf(address(this)) < accountedBalance + amount) revert InexactTransfer();

        if (emancipated[agentId]) {
            address treasury = registry.treasuryOf(agentId);
            if (!usdg.transfer(treasury, amount)) revert InexactTransfer();
        } else {
            accrued[agentId] += amount;
            accountedBalance += amount;
        }

        emit Credited(agentId, amount);
    }

    /// @notice Pay all accrued royalties for `agentId` to the current NFT
    ///         owner. Callable by anyone; funds always go to the owner.
    function claim(uint256 agentId) external {
        uint256 amount = accrued[agentId];
        if (amount == 0) revert NothingToClaim();
        address owner = nft.ownerOf(agentId);

        accrued[agentId] = 0;
        accountedBalance -= amount;

        if (!usdg.transfer(owner, amount)) revert InexactTransfer();
        emit Claimed(agentId, owner, amount);
    }

    /// @notice AgentNFT-only. One-way emancipation: sweeps any unclaimed
    ///         accrual to the registered treasury and flips `emancipated`
    ///         permanently.
    function onBurn(uint256 agentId) external {
        if (msg.sender != address(nft)) revert NotAgentNFT();
        if (emancipated[agentId]) revert AlreadyEmancipated();
        emancipated[agentId] = true;

        uint256 swept = accrued[agentId];
        if (swept > 0) {
            accrued[agentId] = 0;
            accountedBalance -= swept;
            address treasury = registry.treasuryOf(agentId);
            if (!usdg.transfer(treasury, swept)) revert InexactTransfer();
        }

        emit Emancipated(agentId, swept);
    }
}
