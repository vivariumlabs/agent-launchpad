// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IAgentNFT, IRoyaltyDistributor} from "./interfaces/ILaunchpad.sol";

/// @notice ERC-721 for agent identities, built on the OpenZeppelin v5.1.0
///         {ERC721} base per the "fork audited patterns, minimize original
///         code" rule (docs/02). `tokenId == agentId` always. Per-token
///         metadata URI (Arweave) is set once at mint and is immutable
///         thereafter — stored in a plain mapping (not {ERC721URIStorage}, so
///         it is untouched by that extension's burn-clearing semantics).
///         Burning is irreversible, owner-only (approved operators cannot
///         burn), and triggers the royalty distributor's emancipation sweep.
///         No admin functions beyond the one-time wiring setters, no
///         base-URI setter.
contract AgentNFT is ERC721, IAgentNFT {
    /// @dev Captured at deploy time; the only address allowed to call the
    ///      one-time wiring setters below.
    address public immutable deployer;
    address public factory;
    address public distributor;

    /// @dev Set true on mint and never cleared, so a burned agentId can never
    ///      be re-minted (tracked separately from OZ's `_ownerOf`, which is
    ///      cleared to zero on burn).
    mapping(uint256 => bool) private _minted;
    mapping(uint256 => string) private _tokenURIs;

    error ZeroAddress();
    error AlreadySet();
    error NotDeployer();
    error NotFactory();
    error AlreadyMinted();
    error NotTokenOwner();

    modifier onlyDeployer() {
        if (msg.sender != deployer) revert NotDeployer();
        _;
    }

    constructor() ERC721("Agent Launchpad Agents", "AGENT") {
        deployer = msg.sender;
    }

    function setFactory(address _factory) external onlyDeployer {
        if (factory != address(0)) revert AlreadySet();
        if (_factory == address(0)) revert ZeroAddress();
        factory = _factory;
    }

    function setDistributor(address _distributor) external onlyDeployer {
        if (distributor != address(0)) revert AlreadySet();
        if (_distributor == address(0)) revert ZeroAddress();
        distributor = _distributor;
    }

    /// @notice Mint the agent's identity NFT. Factory-only, one-time per
    ///         agentId. `tokenURI_` is permanent — there is no setter.
    function mint(address to, uint256 agentId, string calldata tokenURI_) external {
        if (msg.sender != factory) revert NotFactory();
        if (_minted[agentId]) revert AlreadyMinted();

        _minted[agentId] = true;
        _tokenURIs[agentId] = tokenURI_;
        _mint(to, agentId); // OZ: reverts ERC721InvalidReceiver if `to == address(0)`
    }

    /// @notice Burn the token. Owner-only (no approved-operator burn).
    ///         Irreversible. Clears all token state (CEI, via OZ's `_burn`)
    ///         before notifying the royalty distributor, which one-way
    ///         emancipates the agent.
    function burn(uint256 tokenId) external {
        address tokenOwner = _ownerOf(tokenId);
        if (tokenOwner == address(0)) revert ERC721NonexistentToken(tokenId);
        if (msg.sender != tokenOwner) revert NotTokenOwner();

        _burn(tokenId);

        // Emancipation is one-way and load-bearing: burning without notifying the
        // distributor would strand the royalty re-route. Refuse to burn un-wired.
        if (distributor == address(0)) revert ZeroAddress();
        IRoyaltyDistributor(distributor).onBurn(tokenId);
    }

    /// @dev Reverts for a never-minted tokenId. A burned tokenId's URI stays
    ///      readable (matches the prior mapping-based implementation, which
    ///      never cleared `_tokenURIs` on burn) — only `_minted` gates this.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (!_minted[tokenId]) revert ERC721NonexistentToken(tokenId);
        return _tokenURIs[tokenId];
    }

    /// @dev Disambiguates `ownerOf`, declared on both `ERC721` and `IAgentNFT`
    ///      (same signature) — no behavior change, just satisfies solc.
    function ownerOf(uint256 tokenId) public view override(ERC721, IAgentNFT) returns (address) {
        return super.ownerOf(tokenId);
    }
}
