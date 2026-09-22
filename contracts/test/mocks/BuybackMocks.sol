// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ITreasuryBuyback} from "../../src/interfaces/ILaunchpad.sol";

/// @notice Minimal, well-behaved ERC-20 with configurable decimals, for TreasuryBuyback tests.
/// @dev Namespaced `Buyback*` so it never collides with mocks other batches add in parallel.
contract BuybackMockERC20 {
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

/// @notice Caller that re-enters `poke` from inside its own reward transfer is impossible with
///         a plain ERC-20, so re-entrancy is probed the only way an attacker actually can:
///         a contract that calls `poke` twice in one transaction.
contract BuybackSpamCaller {
    ITreasuryBuyback public immutable buyback;

    constructor(ITreasuryBuyback _buyback) {
        buyback = _buyback;
    }

    /// @notice Two pokes, same block, same transaction. The second must revert on cooldown.
    function doublePoke(uint256 minTokensOut) external {
        buyback.poke(minTokensOut);
        buyback.poke(minTokensOut);
    }

    function singlePoke(uint256 minTokensOut) external {
        buyback.poke(minTokensOut);
    }
}
