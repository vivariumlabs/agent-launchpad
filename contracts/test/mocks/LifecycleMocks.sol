// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAgentRegistry, IFeeSplitHook} from "../../src/interfaces/ILaunchpad.sol";

/// @notice Callback a `LifecycleNotifyingUSDG` fires on armed recipients.
interface ILifecycleUsdgReceiver {
    function onUsdgReceived(address from, uint256 amount) external;
}

/// @notice USDG stand-in (6 decimals) that can be told to call back into specific recipients
///         on receipt.
/// @dev The real USDG has no transfer hooks, so this is deliberately *worse* than production:
///      it is the only way to reach the money paths' reentrancy guards from a treasury address,
///      and it makes the adversarial suite's reentrancy cases executable rather than notional.
///      With no recipient armed it behaves exactly like any other well-behaved ERC-20.
contract LifecycleNotifyingUSDG {
    string public name = "Global Dollar";
    string public symbol = "USDG";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    /// @notice Recipients that get an `onUsdgReceived` callback after their balance is credited.
    mapping(address => bool) public notify;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function setNotify(address who, bool on) external {
        notify[who] = on;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        // Balances are settled before the callback, so the recipient sees a consistent token
        // state and the only thing under test is the callee's own guard.
        if (notify[to]) ILifecycleUsdgReceiver(to).onUsdgReceived(from, amount);
    }
}

/// @notice A contract masquerading as an agent's enclave treasury: it registers itself with the
///         registry (nothing stops a contract from proving possession of its own address) and
///         re-enters an arbitrary target the moment a fee leg lands on it.
/// @dev In production the treasury is a KMS-derived EOA and USDG has no hooks, so neither half
///      of this is reachable. It exists to prove the money paths hold even if both assumptions
///      were false.
contract LifecycleHostileTreasury is ILifecycleUsdgReceiver {
    address public target;
    bytes public payload;
    bool public armed;

    uint256 public attempts;
    uint256 public succeeded;
    uint256 public reverted;
    bytes public lastRevertData;

    /// @notice Prove possession of this address to the registry, exactly as an enclave would.
    function register(
        address registry,
        uint256 agentId,
        address actionEOA,
        bytes32 codeHash,
        string calldata attestationRef
    ) external {
        IAgentRegistry(registry).registerInstance(agentId, address(this), actionEOA, codeHash, attestationRef);
    }

    function heartbeat(address registry, uint256 agentId) external {
        IAgentRegistry(registry).heartbeat(agentId);
    }

    /// @notice Fire `payload_` at `target_` on the next USDG receipt, then disarm (so a nested
    ///         receipt cannot recurse forever and the counters stay readable).
    function armOnce(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    function onUsdgReceived(address, uint256) external override {
        if (!armed) return;
        armed = false;
        attempts++;
        (bool ok, bytes memory data) = target.call(payload);
        if (ok) {
            succeeded++;
        } else {
            reverted++;
            lastRevertData = data;
        }
    }
}

/// @notice Calls `distribute` twice inside one transaction — the only way an attacker can
///         actually reach the cooldown edge atomically.
contract LifecycleDoubleDistributor {
    IFeeSplitHook public immutable hook;

    constructor(IFeeSplitHook _hook) {
        hook = _hook;
    }

    function doubleDistribute(bytes32 poolId) external {
        hook.distribute(poolId, 0);
        hook.distribute(poolId, 0);
    }

    function singleDistribute(bytes32 poolId) external {
        hook.distribute(poolId, 0);
    }
}
