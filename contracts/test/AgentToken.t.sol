// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AgentToken} from "../src/AgentToken.sol";

contract AgentTokenTest is Test {
    AgentToken token;
    address curve = makeAddr("curve");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        token = new AgentToken("Test Agent", "TAGT", curve);
    }

    function test_constructor_mintsFixedSupplyToCurve() public view {
        assertEq(token.totalSupply(), token.AGENT_SUPPLY());
        assertEq(token.balanceOf(curve), token.AGENT_SUPPLY());
        assertEq(token.name(), "Test Agent");
        assertEq(token.symbol(), "TAGT");
        assertEq(token.decimals(), 18);
    }

    function test_constructor_revertsOnZeroCurve() public {
        vm.expectRevert(AgentToken.ZeroAddress.selector);
        new AgentToken("X", "X", address(0));
    }

    function test_transfer() public {
        vm.prank(curve);
        token.transfer(alice, 100e18);
        assertEq(token.balanceOf(alice), 100e18);
        assertEq(token.balanceOf(curve), token.AGENT_SUPPLY() - 100e18);
    }

    function test_transfer_revertsInsufficientBalance() public {
        vm.prank(alice);
        vm.expectPartialRevert(IERC20Errors.ERC20InsufficientBalance.selector);
        token.transfer(bob, 1);
    }

    function test_transfer_revertsToZeroAddress() public {
        vm.prank(curve);
        vm.expectPartialRevert(IERC20Errors.ERC20InvalidReceiver.selector);
        token.transfer(address(0), 1);
    }

    function test_approveAndTransferFrom() public {
        vm.prank(curve);
        token.approve(alice, 50e18);
        assertEq(token.allowance(curve, alice), 50e18);

        vm.prank(alice);
        token.transferFrom(curve, bob, 30e18);
        assertEq(token.balanceOf(bob), 30e18);
        assertEq(token.allowance(curve, alice), 20e18);
    }

    function test_transferFrom_infiniteAllowanceNotDecremented() public {
        vm.prank(curve);
        token.approve(alice, type(uint256).max);

        vm.prank(alice);
        token.transferFrom(curve, bob, 30e18);
        assertEq(token.allowance(curve, alice), type(uint256).max);
    }

    function test_transferFrom_revertsInsufficientAllowance() public {
        vm.prank(curve);
        token.approve(alice, 10);

        vm.prank(alice);
        vm.expectPartialRevert(IERC20Errors.ERC20InsufficientAllowance.selector);
        token.transferFrom(curve, bob, 11);
    }

    function test_burn() public {
        vm.prank(curve);
        token.burn(100e18);
        assertEq(token.balanceOf(curve), token.AGENT_SUPPLY() - 100e18);
        assertEq(token.totalSupply(), token.AGENT_SUPPLY() - 100e18);
    }

    function test_burn_revertsInsufficientBalance() public {
        vm.prank(alice);
        vm.expectPartialRevert(IERC20Errors.ERC20InsufficientBalance.selector);
        token.burn(1);
    }

    function test_burnFrom() public {
        vm.prank(curve);
        token.approve(alice, 50e18);

        vm.prank(alice);
        token.burnFrom(curve, 40e18);
        assertEq(token.balanceOf(curve), token.AGENT_SUPPLY() - 40e18);
        assertEq(token.allowance(curve, alice), 10e18);
        assertEq(token.totalSupply(), token.AGENT_SUPPLY() - 40e18);
    }

    function test_burnFrom_revertsInsufficientAllowance() public {
        vm.prank(curve);
        token.approve(alice, 10);

        vm.prank(alice);
        vm.expectPartialRevert(IERC20Errors.ERC20InsufficientAllowance.selector);
        token.burnFrom(curve, 11);
    }

    function test_permit() public {
        uint256 ownerPk = 0xA11CE;
        address owner_ = vm.addr(ownerPk);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 PERMIT_TYPEHASH =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner_, alice, 100e18, token.nonces(owner_), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        token.permit(owner_, alice, 100e18, deadline, v, r, s);

        assertEq(token.allowance(owner_, alice), 100e18);
        assertEq(token.nonces(owner_), 1);
    }

    function test_permit_revertsExpiredDeadline() public {
        uint256 ownerPk = 0xA11CE;
        address owner_ = vm.addr(ownerPk);
        uint256 deadline = block.timestamp; // will warp past this

        bytes32 PERMIT_TYPEHASH =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner_, alice, 100e18, token.nonces(owner_), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);

        vm.warp(deadline + 1);
        vm.expectPartialRevert(ERC20Permit.ERC2612ExpiredSignature.selector);
        token.permit(owner_, alice, 100e18, deadline, v, r, s);
    }

    function testFuzz_transferPreservesTotalSupply(uint256 amount) public {
        amount = bound(amount, 0, token.AGENT_SUPPLY());
        vm.prank(curve);
        token.transfer(alice, amount);
        assertEq(token.balanceOf(curve) + token.balanceOf(alice), token.AGENT_SUPPLY());
    }
}
