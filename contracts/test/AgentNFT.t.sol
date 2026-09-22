// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {AgentNFT} from "../src/AgentNFT.sol";

contract MockDistributor {
    uint256 public lastBurnedAgentId;
    uint256 public callCount;

    function onBurn(uint256 agentId) external {
        lastBurnedAgentId = agentId;
        callCount++;
    }
}

contract RevertingReceiver {
    // No onERC721Received implemented -> reverts.
}

contract GoodReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

contract AgentNFTTest is Test {
    AgentNFT nft;
    MockDistributor distributor;

    address deployer = address(this);
    address factory = makeAddr("factory");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        nft = new AgentNFT();
        nft.setFactory(factory);
        distributor = new MockDistributor();
        nft.setDistributor(address(distributor));
    }

    // ---- wiring ----

    function test_setFactory_onlyDeployerOnce() public {
        AgentNFT fresh = new AgentNFT();
        vm.prank(alice);
        vm.expectRevert(AgentNFT.NotDeployer.selector);
        fresh.setFactory(factory);

        fresh.setFactory(factory);
        vm.expectRevert(AgentNFT.AlreadySet.selector);
        fresh.setFactory(factory);
    }

    function test_setFactory_revertsZeroAddress() public {
        AgentNFT fresh = new AgentNFT();
        vm.expectRevert(AgentNFT.ZeroAddress.selector);
        fresh.setFactory(address(0));
    }

    function test_setDistributor_onlyDeployerOnce() public {
        AgentNFT fresh = new AgentNFT();
        vm.prank(alice);
        vm.expectRevert(AgentNFT.NotDeployer.selector);
        fresh.setDistributor(address(distributor));

        fresh.setDistributor(address(distributor));
        vm.expectRevert(AgentNFT.AlreadySet.selector);
        fresh.setDistributor(address(distributor));
    }

    // ---- mint ----

    function test_mint_onlyFactory() public {
        vm.prank(alice);
        vm.expectRevert(AgentNFT.NotFactory.selector);
        nft.mint(alice, 1, "ar://1");
    }

    function test_mint_setsOwnerAndURI() public {
        vm.prank(factory);
        nft.mint(alice, 1, "ar://1");

        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.balanceOf(alice), 1);
        assertEq(nft.tokenURI(1), "ar://1");
    }

    function test_mint_revertsAlreadyMinted() public {
        vm.startPrank(factory);
        nft.mint(alice, 1, "ar://1");
        vm.expectRevert(AgentNFT.AlreadyMinted.selector);
        nft.mint(bob, 1, "ar://2");
        vm.stopPrank();
    }

    function test_mint_revertsZeroAddress() public {
        vm.prank(factory);
        vm.expectPartialRevert(IERC721Errors.ERC721InvalidReceiver.selector);
        nft.mint(address(0), 1, "ar://1");
    }

    function test_ownerOf_revertsNonexistent() public {
        vm.expectPartialRevert(IERC721Errors.ERC721NonexistentToken.selector);
        nft.ownerOf(999);
    }

    // ---- burn ----

    function test_burn_byOwner_callsDistributorAndClears() public {
        vm.prank(factory);
        nft.mint(alice, 1, "ar://1");

        vm.prank(alice);
        nft.burn(1);

        assertEq(distributor.lastBurnedAgentId(), 1);
        assertEq(distributor.callCount(), 1);
        assertEq(nft.balanceOf(alice), 0);
        vm.expectPartialRevert(IERC721Errors.ERC721NonexistentToken.selector);
        nft.ownerOf(1);
    }

    function test_burn_revertsNonOwner() public {
        vm.prank(factory);
        nft.mint(alice, 1, "ar://1");

        vm.prank(bob);
        vm.expectRevert(AgentNFT.NotTokenOwner.selector);
        nft.burn(1);
    }

    function test_burn_revertsApprovedButNotOwner() public {
        vm.prank(factory);
        nft.mint(alice, 1, "ar://1");

        vm.prank(alice);
        nft.approve(bob, 1);

        // Approved operator is NOT allowed to burn — owner only.
        vm.prank(bob);
        vm.expectRevert(AgentNFT.NotTokenOwner.selector);
        nft.burn(1);
    }

    function test_burn_revertsNonexistent() public {
        vm.expectPartialRevert(IERC721Errors.ERC721NonexistentToken.selector);
        nft.burn(1);
    }

    function test_burn_irreversible_cannotBurnTwice() public {
        vm.prank(factory);
        nft.mint(alice, 1, "ar://1");

        vm.prank(alice);
        nft.burn(1);

        vm.prank(alice);
        vm.expectPartialRevert(IERC721Errors.ERC721NonexistentToken.selector);
        nft.burn(1);
    }

    /// @dev Fable review 2026-09-22: emancipation is one-way and load-bearing, so burning
    ///      with no distributor wired must revert rather than silently skip the re-route.
    function test_burn_revertsWithoutDistributorWired() public {
        AgentNFT fresh = new AgentNFT();
        fresh.setFactory(factory);
        // distributor never set

        vm.prank(factory);
        fresh.mint(alice, 1, "ar://1");

        vm.prank(alice);
        vm.expectRevert(AgentNFT.ZeroAddress.selector);
        fresh.burn(1);

        // Token untouched by the failed burn.
        assertEq(fresh.ownerOf(1), alice);
    }

    // ---- transfers / approvals ----

    function test_transferFrom_byOwner() public {
        vm.prank(factory);
        nft.mint(alice, 1, "ar://1");

        vm.prank(alice);
        nft.transferFrom(alice, bob, 1);
        assertEq(nft.ownerOf(1), bob);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(nft.balanceOf(bob), 1);
    }

    function test_transferFrom_byApproved() public {
        vm.prank(factory);
        nft.mint(alice, 1, "ar://1");

        vm.prank(alice);
        nft.approve(bob, 1);

        vm.prank(bob);
        nft.transferFrom(alice, bob, 1);
        assertEq(nft.ownerOf(1), bob);
        // approval cleared after transfer
        assertEq(nft.getApproved(1), address(0));
    }

    function test_transferFrom_byOperator() public {
        vm.prank(factory);
        nft.mint(alice, 1, "ar://1");

        vm.prank(alice);
        nft.setApprovalForAll(bob, true);

        vm.prank(bob);
        nft.transferFrom(alice, bob, 1);
        assertEq(nft.ownerOf(1), bob);
    }

    function test_transferFrom_revertsNotApprovedOrOwner() public {
        vm.prank(factory);
        nft.mint(alice, 1, "ar://1");

        vm.prank(bob);
        vm.expectPartialRevert(IERC721Errors.ERC721InsufficientApproval.selector);
        nft.transferFrom(alice, bob, 1);
    }

    function test_transferFrom_revertsWrongFrom() public {
        vm.prank(factory);
        nft.mint(alice, 1, "ar://1");

        vm.prank(alice);
        vm.expectPartialRevert(IERC721Errors.ERC721IncorrectOwner.selector);
        nft.transferFrom(bob, alice, 1);
    }

    function test_safeTransferFrom_toGoodReceiver() public {
        vm.prank(factory);
        nft.mint(alice, 1, "ar://1");
        GoodReceiver receiver = new GoodReceiver();

        vm.prank(alice);
        nft.safeTransferFrom(alice, address(receiver), 1);
        assertEq(nft.ownerOf(1), address(receiver));
    }

    function test_safeTransferFrom_revertsOnBadReceiver() public {
        vm.prank(factory);
        nft.mint(alice, 1, "ar://1");
        RevertingReceiver receiver = new RevertingReceiver();

        vm.prank(alice);
        vm.expectPartialRevert(IERC721Errors.ERC721InvalidReceiver.selector);
        nft.safeTransferFrom(alice, address(receiver), 1);
    }

    function test_supportsInterface() public view {
        assertTrue(nft.supportsInterface(0x01ffc9a7)); // ERC165
        assertTrue(nft.supportsInterface(0x80ac58cd)); // ERC721
        assertTrue(nft.supportsInterface(0x5b5e139f)); // ERC721Metadata
        assertFalse(nft.supportsInterface(0xffffffff));
    }
}
