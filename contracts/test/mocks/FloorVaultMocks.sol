// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IFloorVault} from "../../src/interfaces/ILaunchpad.sol";
import {ILifecycleUsdgReceiver} from "./LifecycleMocks.sol";

/// @notice Minimal burnable ERC-20 (configurable decimals) with overridable transfer/burn
///         behaviour, the base for the FloorVault hostile-token mocks.
/// @dev Namespaced `Floor*` so it never collides with other suites' mocks.
contract FloorMockToken {
    string public name = "Floor Mock Token";
    string public symbol = "FMT";
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint8 decimals_) {
        decimals = decimals_;
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

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        _spendAllowance(from, amount);
        _transfer(from, to, amount);
        return true;
    }

    function burn(uint256 amount) public virtual {
        _burn(msg.sender, amount);
    }

    function _spendAllowance(address from, uint256 amount) internal {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
    }

    function _transfer(address from, address to, uint256 amount) internal virtual {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }
}

/// @notice Takes a 1% fee on every transfer (burned), so the recipient receives less.
contract FloorFeeOnTransferToken is FloorMockToken(18) {
    function _transfer(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
    }
}

/// @notice `burn` succeeds but does nothing.
contract FloorNoOpBurnToken is FloorMockToken(18) {
    function burn(uint256) public pure override {}
}

/// @notice `burn` moves the tokens to the dead address instead of destroying them.
contract FloorDeadBurnToken is FloorMockToken(18) {
    function burn(uint256 amount) public override {
        _transfer(msg.sender, 0x000000000000000000000000000000000000dEaD, amount);
    }
}

/// @notice `transferFrom` re-enters an armed target (e.g. `vault.redeem`) and bubbles its
///         revert, so the outer call fails with the inner reason.
contract FloorReentrantToken is FloorMockToken(18) {
    address public target;
    bytes public payload;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (target != address(0)) {
            address t = target;
            target = address(0);
            (bool ok, bytes memory data) = t.call(payload);
            if (!ok) {
                assembly {
                    revert(add(data, 32), mload(data))
                }
            }
        }
        return super.transferFrom(from, to, amount);
    }
}

interface IFloorApprovable {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice A redeemer contract that re-enters an armed target the moment USDG lands on it
///         (via `LifecycleNotifyingUSDG`), recording the outcome without bubbling it.
contract FloorHostileRedeemer is ILifecycleUsdgReceiver {
    IFloorVault public immutable vault;
    address public immutable token;

    address public target;
    bytes public payload;
    bool public armed;

    uint256 public attempts;
    uint256 public succeeded;
    bytes public lastRevertData;

    constructor(IFloorVault vault_, address token_) {
        vault = vault_;
        token = token_;
        IFloorApprovable(token_).approve(address(vault_), type(uint256).max);
    }

    function armOnce(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function redeem(uint256 amount) external returns (uint256) {
        return vault.redeem(amount);
    }

    function redeemTwice(uint256 a, uint256 b) external returns (uint256) {
        return vault.redeem(a) + vault.redeem(b);
    }

    function onUsdgReceived(address, uint256) external override {
        if (!armed) return;
        armed = false;
        attempts++;
        (bool ok, bytes memory data) = target.call(payload);
        if (ok) succeeded++;
        else lastRevertData = data;
    }
}
