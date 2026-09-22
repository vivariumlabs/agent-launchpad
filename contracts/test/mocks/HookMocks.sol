// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IFeeSplitHook, IAgentRegistry, IRoyaltyDistributor} from "../../src/interfaces/ILaunchpad.sol";

/// @notice Minimal, well-behaved ERC-20 with configurable decimals, for FeeSplitHook tests.
/// @dev Namespaced `Hook*` so it never collides with mocks other batches add in parallel.
contract HookMockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
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
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @notice Registry stub exposing only what the hook reads, with a settable treasury so the
///         live-lookup property can be exercised.
contract HookMockRegistry {
    error NotRegistered();

    mapping(uint256 => address) public treasury;

    function setTreasury(uint256 agentId, address t) external {
        treasury[agentId] = t;
    }

    function treasuryOf(uint256 agentId) external view returns (address) {
        address t = treasury[agentId];
        if (t == address(0)) revert NotRegistered();
        return t;
    }
}

/// @notice Distributor stub that records credits and checks the hook actually transferred.
contract HookMockDistributor {
    error CreditUnfunded();

    address public immutable usdg;
    mapping(uint256 => uint256) public credited;
    uint256 public accountedBalance;

    constructor(address _usdg) {
        usdg = _usdg;
    }

    function credit(uint256 agentId, uint256 amount) external virtual {
        uint256 bal = HookMockERC20(usdg).balanceOf(address(this));
        if (bal < accountedBalance + amount) revert CreditUnfunded();
        accountedBalance += amount;
        credited[agentId] += amount;
    }
}

/// @notice Distributor whose `credit` re-enters `distribute` on the hook.
contract HookReentrantDistributor {
    address public hook;
    bytes32 public poolId;
    bool public attempted;
    bool public reentryReverted;

    function arm(address _hook, bytes32 _poolId) external {
        hook = _hook;
        poolId = _poolId;
    }

    function credit(uint256, uint256) external {
        attempted = true;
        try IFeeSplitHook(hook).distribute(poolId, 0) {
            reentryReverted = false;
        } catch {
            reentryReverted = true;
        }
    }
}

/// @notice Registry whose `treasuryOf` tries to re-enter the hook. Declared `view` on the
///         interface, so the call arrives as a staticcall and any state write reverts.
contract HookReentrantRegistry {
    address public hook;
    bytes32 public poolId;
    address public fallbackTreasury;

    function arm(address _hook, bytes32 _poolId, address _fallback) external {
        hook = _hook;
        poolId = _poolId;
        fallbackTreasury = _fallback;
    }

    function treasuryOf(uint256) external view returns (address) {
        // Deliberately attempts a state-changing re-entry from inside a staticcall.
        (bool ok,) = hook.staticcall(abi.encodeCall(IFeeSplitHook.distribute, (poolId, 0)));
        require(!ok, "reentry unexpectedly succeeded");
        return fallbackTreasury;
    }
}
