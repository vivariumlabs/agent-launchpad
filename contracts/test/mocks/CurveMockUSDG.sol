// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal 6-decimal USDG stand-in for curve tests, with an optional
/// fee-on-transfer mode so the curve's balance-delta accounting can be proved.
contract CurveMockUSDG {
    string public constant name = "Mock USDG";
    string public constant symbol = "USDG";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Basis points skimmed off every transfer, burned to the void.
    uint256 public feeOnTransferBps;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function setFeeOnTransferBps(uint256 bps) external {
        feeOnTransferBps = bps;
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
        uint256 skim = (amount * feeOnTransferBps) / 10_000;
        balanceOf[to] += amount - skim;
        if (skim != 0) balanceOf[address(0xdead)] += skim;
        emit Transfer(from, to, amount - skim);
    }
}
