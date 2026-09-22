// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IFactorySettable {
    function setFactory(address factory) external;
}

/// @title HookDeployer
/// @notice CREATE2 deployer for `FeeSplitHook`, owned by the account that deploys it.
/// @dev Why this exists instead of the canonical CREATE2 deployer
///      (`0x4e59b44847b379578588920cA78FbF26c0B4956C`): `FeeSplitHook` records
///      `deployer = msg.sender` in its constructor and gates its one-time `setFactory` wiring on
///      that address. Deploying the hook through the canonical singleton would pin `deployer` to
///      a contract that can never call `setFactory`, permanently bricking the wiring. So the
///      mined hook address must come from a CREATE2 deployer that can also forward that one
///      call — this contract. After `setHookFactory` has run once, it is inert.
contract HookDeployer {
    error NotOwner();
    error DeployFailed();

    /// @notice The account allowed to deploy through this contract and to wire the hook.
    address public immutable owner;

    event HookDeployed(address indexed hook, bytes32 salt);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice CREATE2-deploy `initCode` at `salt`. The resulting address is
    ///         `keccak256(0xff, address(this), salt, keccak256(initCode))[12:]`.
    function deploy(bytes32 salt, bytes memory initCode) external onlyOwner returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        if (deployed == address(0)) revert DeployFailed();
        emit HookDeployed(deployed, salt);
    }

    /// @notice Forward the hook's one-time `setFactory` wiring call.
    function setHookFactory(address hook, address factory) external onlyOwner {
        IFactorySettable(hook).setFactory(factory);
    }
}
