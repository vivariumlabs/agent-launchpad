// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IAgentBondingCurve} from "../../src/interfaces/ILaunchpad.sol";

/// @notice Minimal 18-decimal AGENT token stand-in. Full supply is minted to
/// the curve at construction, exactly as the factory does.
contract CurveMockAgentToken {
    string public constant name = "Mock Agent";
    string public constant symbol = "AGENT";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address curve, uint256 supply) {
        totalSupply = supply;
        balanceOf[curve] = supply;
        emit Transfer(address(0), curve, supply);
    }

    /// @dev Test-only: hands an address tokens the curve never issued, so the
    /// curve's "cannot pay out the phantom reserve" guard can be reached at
    /// all. No honest trade sequence gets there.
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
    }
}

/// @notice Registry stand-in: only `treasuryOf` matters to the curve, and it
/// reverts for an unregistered agent exactly as the real one does.
contract CurveMockRegistry {
    error NotRegistered();

    mapping(uint256 => address) private _treasury;

    function setTreasury(uint256 agentId, address treasury) external {
        _treasury[agentId] = treasury;
    }

    function treasuryOf(uint256 agentId) external view returns (address) {
        address t = _treasury[agentId];
        if (t == address(0)) revert NotRegistered();
        return t;
    }
}

/// @notice RoyaltyDistributor stand-in using the real accounted-balance
/// pattern: `credit` only succeeds if the USDG actually arrived first.
contract CurveMockDistributor {
    error Unfunded();

    address public immutable usdg;
    uint256 public accountedBalance;
    mapping(uint256 => uint256) public accrued;
    uint256 public creditCalls;

    constructor(address usdg_) {
        usdg = usdg_;
    }

    function credit(uint256 agentId, uint256 amount) external virtual {
        if (_balance() < accountedBalance + amount) revert Unfunded();
        accountedBalance += amount;
        accrued[agentId] += amount;
        creditCalls++;
    }

    function _balance() internal view returns (uint256) {
        (bool ok, bytes memory data) = usdg.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        require(ok, "balanceOf failed");
        return abi.decode(data, (uint256));
    }
}

/// @notice Hostile distributor: tries to re-enter the curve from inside
/// `credit`, i.e. from the middle of a trade's fee split.
contract CurveReenteringDistributor is CurveMockDistributor {
    IAgentBondingCurve public curve;
    bool public attempted;
    bool public succeeded;
    bytes public lastError;
    uint8 public mode; // 0 = buy, 1 = sell, 2 = graduate

    constructor(address usdg_) CurveMockDistributor(usdg_) {}

    function arm(address curve_, uint8 mode_) external {
        curve = IAgentBondingCurve(curve_);
        mode = mode_;
    }

    function credit(uint256 agentId, uint256 amount) external override {
        if (_balance() < accountedBalance + amount) revert Unfunded();
        accountedBalance += amount;
        accrued[agentId] += amount;
        creditCalls++;

        if (address(curve) != address(0) && !attempted) {
            attempted = true;
            if (mode == 0) {
                try curve.buy(1e6, 0, address(this)) {
                    succeeded = true;
                } catch (bytes memory err) {
                    lastError = err;
                }
            } else if (mode == 1) {
                try curve.sell(1e18, 0, address(this)) {
                    succeeded = true;
                } catch (bytes memory err) {
                    lastError = err;
                }
            } else {
                try curve.graduate(address(this)) {
                    succeeded = true;
                } catch (bytes memory err) {
                    lastError = err;
                }
            }
        }
    }
}
