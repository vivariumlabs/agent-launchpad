// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {RoyaltyDistributor} from "../src/RoyaltyDistributor.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";

contract RoyaltyDistributorTest is Test {
    RoyaltyDistributor distributor;
    AgentNFT nft;
    AgentRegistry registry;
    MockUSDG usdg;

    address factory = makeAddr("factory");
    address hook = makeAddr("hook");
    address curve = makeAddr("curve");
    address treasuryEOA = makeAddr("treasuryEOA");
    address actionEOA = makeAddr("actionEOA");
    address nftOwner = makeAddr("nftOwner");
    address stranger = makeAddr("stranger");

    uint256 constant AGENT_ID = 1;

    function setUp() public {
        usdg = new MockUSDG();
        nft = new AgentNFT();
        registry = new AgentRegistry();

        distributor = new RoyaltyDistributor(address(usdg), address(nft), address(registry));
        distributor.setFactory(factory);
        distributor.setHook(hook);

        nft.setFactory(factory);
        nft.setDistributor(address(distributor));

        registry.setFactory(factory);

        // Wire agent: mint NFT, register curve, register the treasury.
        vm.prank(factory);
        nft.mint(nftOwner, AGENT_ID, "ar://1");

        vm.prank(factory);
        distributor.setCurve(AGENT_ID, curve);

        vm.prank(factory);
        registry.openGenesis(AGENT_ID, uint64(block.timestamp) + 1 days, treasuryEOA);
        vm.prank(treasuryEOA);
        registry.registerInstance(AGENT_ID, treasuryEOA, actionEOA, keccak256("code"), "ar://att");
    }

    function _fundAndCredit(address caller, uint256 amount) internal {
        usdg.mint(address(distributor), amount);
        vm.prank(caller);
        distributor.credit(AGENT_ID, amount);
    }

    // ---- wiring ----

    function test_setFactory_onlyDeployerOnce() public {
        RoyaltyDistributor fresh = new RoyaltyDistributor(address(usdg), address(nft), address(registry));
        vm.prank(stranger);
        vm.expectRevert(RoyaltyDistributor.NotDeployer.selector);
        fresh.setFactory(factory);

        fresh.setFactory(factory);
        vm.expectRevert(RoyaltyDistributor.AlreadySet.selector);
        fresh.setFactory(factory);
    }

    function test_setHook_onlyDeployerOnce() public {
        RoyaltyDistributor fresh = new RoyaltyDistributor(address(usdg), address(nft), address(registry));
        vm.prank(stranger);
        vm.expectRevert(RoyaltyDistributor.NotDeployer.selector);
        fresh.setHook(hook);

        fresh.setHook(hook);
        vm.expectRevert(RoyaltyDistributor.AlreadySet.selector);
        fresh.setHook(hook);
    }

    function test_constructor_revertsZeroAddress() public {
        vm.expectRevert(RoyaltyDistributor.ZeroAddress.selector);
        new RoyaltyDistributor(address(0), address(nft), address(registry));
    }

    function test_setCurve_onlyFactoryOncePerAgent() public {
        vm.prank(stranger);
        vm.expectRevert(RoyaltyDistributor.NotFactory.selector);
        distributor.setCurve(2, curve);

        vm.prank(factory);
        distributor.setCurve(2, curve);

        vm.prank(factory);
        vm.expectRevert(RoyaltyDistributor.AlreadySet.selector);
        distributor.setCurve(2, curve);
    }

    // ---- credit ----

    function test_credit_revertsUnauthorizedCaller() public {
        usdg.mint(address(distributor), 100e6);
        vm.prank(stranger);
        vm.expectRevert(RoyaltyDistributor.NotAuthorized.selector);
        distributor.credit(AGENT_ID, 100e6);
    }

    function test_credit_byHook() public {
        _fundAndCredit(hook, 100e6);
        assertEq(distributor.accrued(AGENT_ID), 100e6);
        assertEq(distributor.accountedBalance(), 100e6);
    }

    function test_credit_byCurve() public {
        _fundAndCredit(curve, 100e6);
        assertEq(distributor.accrued(AGENT_ID), 100e6);
    }

    function test_credit_revertsWithoutTransfer() public {
        // No USDG actually sent to the distributor first.
        vm.prank(hook);
        vm.expectRevert(RoyaltyDistributor.InexactTransfer.selector);
        distributor.credit(AGENT_ID, 100e6);
    }

    function test_credit_revertsPartialTransfer() public {
        usdg.mint(address(distributor), 50e6);
        vm.prank(hook);
        vm.expectRevert(RoyaltyDistributor.InexactTransfer.selector);
        distributor.credit(AGENT_ID, 100e6);
    }

    function test_credit_accumulatesAccountedBalanceAcrossCredits() public {
        _fundAndCredit(hook, 100e6);
        _fundAndCredit(curve, 50e6);
        assertEq(distributor.accountedBalance(), 150e6);
        assertEq(distributor.accrued(AGENT_ID), 150e6);
    }

    function test_credit_emancipated_forwardsDirectlyToTreasury() public {
        // Emancipate first.
        vm.prank(nftOwner);
        nft.burn(AGENT_ID);
        assertTrue(distributor.emancipated(AGENT_ID));

        uint256 before = usdg.balanceOf(treasuryEOA);
        usdg.mint(address(distributor), 100e6);
        vm.prank(hook);
        distributor.credit(AGENT_ID, 100e6);

        assertEq(usdg.balanceOf(treasuryEOA), before + 100e6);
        assertEq(distributor.accrued(AGENT_ID), 0);
        assertEq(distributor.accountedBalance(), 0);
    }

    // ---- claim ----

    function test_claim_paysCurrentOwner_callableByAnyone() public {
        _fundAndCredit(hook, 100e6);

        vm.prank(stranger); // anyone can call claim
        distributor.claim(AGENT_ID);

        assertEq(usdg.balanceOf(nftOwner), 100e6);
        assertEq(distributor.accrued(AGENT_ID), 0);
        assertEq(distributor.accountedBalance(), 0);
    }

    function test_claim_paysNewOwnerAfterTransfer() public {
        _fundAndCredit(hook, 100e6);

        vm.prank(nftOwner);
        nft.transferFrom(nftOwner, stranger, AGENT_ID);

        distributor.claim(AGENT_ID);
        assertEq(usdg.balanceOf(stranger), 100e6);
        assertEq(usdg.balanceOf(nftOwner), 0);
    }

    function test_claim_revertsNothingToClaim() public {
        vm.expectRevert(RoyaltyDistributor.NothingToClaim.selector);
        distributor.claim(AGENT_ID);
    }

    function test_claim_zeroesAccruedPreventingDoubleClaim() public {
        _fundAndCredit(hook, 100e6);
        distributor.claim(AGENT_ID);

        vm.expectRevert(RoyaltyDistributor.NothingToClaim.selector);
        distributor.claim(AGENT_ID);
    }

    // ---- onBurn / emancipation ----

    function test_onBurn_onlyAgentNFT() public {
        vm.prank(stranger);
        vm.expectRevert(RoyaltyDistributor.NotAgentNFT.selector);
        distributor.onBurn(AGENT_ID);
    }

    function test_onBurn_sweepsAccruedToTreasury() public {
        _fundAndCredit(hook, 100e6);

        vm.prank(nftOwner);
        nft.burn(AGENT_ID); // triggers onBurn via AgentNFT

        assertEq(usdg.balanceOf(treasuryEOA), 100e6);
        assertEq(distributor.accrued(AGENT_ID), 0);
        assertEq(distributor.accountedBalance(), 0);
        assertTrue(distributor.emancipated(AGENT_ID));
    }

    function test_onBurn_withZeroAccrued_noTransfer() public {
        uint256 before = usdg.balanceOf(treasuryEOA);

        vm.prank(nftOwner);
        nft.burn(AGENT_ID);

        assertEq(usdg.balanceOf(treasuryEOA), before);
        assertTrue(distributor.emancipated(AGENT_ID));
    }

    function test_onBurn_isOneWay_cannotEmancipateTwice() public {
        vm.prank(address(nft));
        distributor.onBurn(AGENT_ID);
        assertTrue(distributor.emancipated(AGENT_ID));

        vm.prank(address(nft));
        vm.expectRevert(RoyaltyDistributor.AlreadyEmancipated.selector);
        distributor.onBurn(AGENT_ID);
    }

    function test_emancipation_isPermanentAcrossSubsequentCredits() public {
        vm.prank(nftOwner);
        nft.burn(AGENT_ID);

        // Even repeated credits keep forwarding, never re-accruing.
        for (uint256 i; i < 3; i++) {
            usdg.mint(address(distributor), 10e6);
            vm.prank(hook);
            distributor.credit(AGENT_ID, 10e6);
        }
        assertEq(distributor.accrued(AGENT_ID), 0);
        assertEq(usdg.balanceOf(treasuryEOA), 30e6);
    }
}
