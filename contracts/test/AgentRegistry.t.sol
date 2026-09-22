// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {IAgentRegistry} from "../src/interfaces/ILaunchpad.sol";

contract AgentRegistryTest is Test {
    AgentRegistry registry;

    address factory = makeAddr("factory");
    address treasury = makeAddr("treasury");
    address action = makeAddr("action");
    bytes32 codeHash = keccak256("image-v1");

    uint256 constant AGENT_ID = 1;

    function setUp() public {
        registry = new AgentRegistry();
        registry.setFactory(factory);
    }

    function _openGenesis(uint64 window) internal {
        vm.prank(factory);
        registry.openGenesis(AGENT_ID, uint64(block.timestamp) + window, treasury);
    }

    // ---- wiring ----

    function test_setFactory_onlyDeployerOnce() public {
        AgentRegistry fresh = new AgentRegistry();
        vm.prank(treasury);
        vm.expectRevert(AgentRegistry.NotDeployer.selector);
        fresh.setFactory(factory);

        fresh.setFactory(factory);
        vm.expectRevert(AgentRegistry.AlreadySet.selector);
        fresh.setFactory(factory);
    }

    function test_setFactory_revertsZeroAddress() public {
        AgentRegistry fresh = new AgentRegistry();
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        fresh.setFactory(address(0));
    }

    // ---- openGenesis ----

    function test_openGenesis_onlyFactory() public {
        vm.expectRevert(AgentRegistry.NotFactory.selector);
        registry.openGenesis(AGENT_ID, uint64(block.timestamp) + 1 days, treasury);
    }

    function test_openGenesis_storesDeadline() public {
        uint64 deadline = uint64(block.timestamp) + 1 days;
        vm.prank(factory);
        registry.openGenesis(AGENT_ID, deadline, treasury);
        assertEq(registry.genesisDeadline(AGENT_ID), deadline);
        assertEq(registry.expectedTreasuryEOA(AGENT_ID), treasury);
    }

    function test_openGenesis_revertsZeroExpectedTreasury() public {
        vm.prank(factory);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.openGenesis(AGENT_ID, uint64(block.timestamp) + 1 days, address(0));
    }

    // ---- first registration ----

    function test_registerInstance_revertsNotTreasury() public {
        _openGenesis(1 days);
        vm.prank(action);
        vm.expectRevert(AgentRegistry.NotTreasury.selector);
        registry.registerInstance(AGENT_ID, treasury, action, codeHash, "ar://1");
    }

    function test_registerInstance_revertsZeroActionEOA() public {
        _openGenesis(1 days);
        vm.prank(treasury);
        vm.expectRevert(AgentRegistry.ZeroAddress.selector);
        registry.registerInstance(AGENT_ID, treasury, address(0), codeHash, "ar://1");
    }

    function test_registerInstance_revertsZeroCodeHash() public {
        _openGenesis(1 days);
        vm.prank(treasury);
        vm.expectRevert(AgentRegistry.ZeroCodeHash.selector);
        registry.registerInstance(AGENT_ID, treasury, action, bytes32(0), "ar://1");
    }

    function test_registerInstance_revertsGenesisNotOpened() public {
        vm.prank(treasury);
        vm.expectRevert(AgentRegistry.GenesisNotOpened.selector);
        registry.registerInstance(AGENT_ID, treasury, action, codeHash, "ar://1");
    }

    function test_registerInstance_revertsGenesisClosed() public {
        _openGenesis(1 days);
        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(treasury);
        vm.expectRevert(AgentRegistry.GenesisClosed.selector);
        registry.registerInstance(AGENT_ID, treasury, action, codeHash, "ar://1");
    }

    function test_registerInstance_revertsUnexpectedTreasury_frontRun() public {
        // KMS-predicted treasury for this agent is `treasury`. An attacker who watches the
        // genesis window try to register their own EOAs first must be rejected.
        _openGenesis(1 days);

        address attacker = makeAddr("attacker");
        address attackerAction = makeAddr("attackerAction");
        vm.prank(attacker);
        vm.expectRevert(AgentRegistry.UnexpectedTreasury.selector);
        registry.registerInstance(AGENT_ID, attacker, attackerAction, codeHash, "ar://evil");

        // The agent must remain unregistered after the front-run attempt.
        assertFalse(registry.isRegistered(AGENT_ID));
    }

    function test_registerInstance_succeedsFromPredictedTreasuryEOA() public {
        address predicted = makeAddr("predictedTreasury");
        vm.prank(factory);
        registry.openGenesis(AGENT_ID, uint64(block.timestamp) + 1 days, predicted);

        vm.prank(predicted);
        registry.registerInstance(AGENT_ID, predicted, action, codeHash, "ar://1");

        assertTrue(registry.isRegistered(AGENT_ID));
        assertEq(registry.treasuryOf(AGENT_ID), predicted);
    }

    function test_registerInstance_firstRegistration() public {
        _openGenesis(1 days);

        vm.prank(treasury);
        registry.registerInstance(AGENT_ID, treasury, action, codeHash, "ar://1");

        IAgentRegistry.AgentInstance memory inst = registry.instanceOf(AGENT_ID);
        assertEq(inst.treasuryEOA, treasury);
        assertEq(inst.actionEOA, action);
        assertEq(inst.codeHash, codeHash);
        assertEq(inst.attestationRef, "ar://1");
        assertEq(inst.generation, 1);
        assertEq(inst.lastHeartbeat, block.timestamp);
        assertTrue(registry.isRegistered(AGENT_ID));
        assertEq(registry.treasuryOf(AGENT_ID), treasury);
    }

    function test_registerInstance_exactlyAtDeadlineSucceeds() public {
        uint64 deadline = uint64(block.timestamp) + 1 days;
        vm.prank(factory);
        registry.openGenesis(AGENT_ID, deadline, treasury);

        vm.warp(deadline);
        vm.prank(treasury);
        registry.registerInstance(AGENT_ID, treasury, action, codeHash, "ar://1");
        assertTrue(registry.isRegistered(AGENT_ID));
    }

    // ---- revival ----

    function _register() internal {
        _openGenesis(1 days);
        vm.prank(treasury);
        registry.registerInstance(AGENT_ID, treasury, action, codeHash, "ar://1");
    }

    function test_registerInstance_revival_revertsWindowNotElapsed() public {
        _register();
        vm.warp(block.timestamp + registry.REVIVAL_WINDOW()); // exactly at window, not elapsed (> required)

        vm.prank(treasury);
        vm.expectRevert(AgentRegistry.RevivalWindowNotElapsed.selector);
        registry.registerInstance(AGENT_ID, treasury, action, codeHash, "ar://2");
    }

    function test_registerInstance_revival_succeedsAfterWindow() public {
        _register();
        vm.warp(block.timestamp + registry.REVIVAL_WINDOW() + 1);

        vm.prank(treasury);
        registry.registerInstance(AGENT_ID, treasury, action, codeHash, "ar://2");

        IAgentRegistry.AgentInstance memory inst = registry.instanceOf(AGENT_ID);
        assertEq(inst.generation, 2);
        assertEq(inst.attestationRef, "ar://2");
        assertEq(inst.lastHeartbeat, block.timestamp);
    }

    function test_registerInstance_revival_revertsMismatchedActionEOA() public {
        _register();
        vm.warp(block.timestamp + registry.REVIVAL_WINDOW() + 1);

        address wrongAction = makeAddr("wrongAction");
        vm.prank(treasury);
        vm.expectRevert(AgentRegistry.MismatchedRevivalKeys.selector);
        registry.registerInstance(AGENT_ID, treasury, wrongAction, codeHash, "ar://2");
    }

    function test_registerInstance_revival_revertsMismatchedCodeHash() public {
        _register();
        vm.warp(block.timestamp + registry.REVIVAL_WINDOW() + 1);

        vm.prank(treasury);
        vm.expectRevert(AgentRegistry.MismatchedRevivalKeys.selector);
        registry.registerInstance(AGENT_ID, treasury, action, keccak256("other"), "ar://2");
    }

    function test_registerInstance_revival_ignoresExpectedTreasuryEOA() public {
        // Revival is gated on the pinned instance keys (treasuryEOA/actionEOA/codeHash), not on
        // expectedTreasuryEOA. Re-opening genesis for the same agentId with a different expected
        // treasury (e.g. the factory reusing genesis bookkeeping) must not affect revival.
        _register();
        vm.warp(block.timestamp + registry.REVIVAL_WINDOW() + 1);

        address otherExpected = makeAddr("otherExpected");
        vm.prank(factory);
        registry.openGenesis(AGENT_ID, uint64(block.timestamp) + 1 days, otherExpected);

        vm.prank(treasury);
        registry.registerInstance(AGENT_ID, treasury, action, codeHash, "ar://2");

        IAgentRegistry.AgentInstance memory inst = registry.instanceOf(AGENT_ID);
        assertEq(inst.generation, 2);
        assertEq(inst.treasuryEOA, treasury);
        assertEq(inst.attestationRef, "ar://2");
    }

    function test_registerInstance_revival_freshHeartbeatBlocksDisplacement() public {
        _register();
        // heartbeat stays fresh; immediate re-registration attempt should fail
        vm.prank(treasury);
        vm.expectRevert(AgentRegistry.RevivalWindowNotElapsed.selector);
        registry.registerInstance(AGENT_ID, treasury, action, codeHash, "ar://2");
    }

    // ---- heartbeat ----

    function test_heartbeat_onlyRegisteredTreasury() public {
        _register();
        vm.prank(action);
        vm.expectRevert(AgentRegistry.NotTreasury.selector);
        registry.heartbeat(AGENT_ID);
    }

    function test_heartbeat_revertsNotRegistered() public {
        vm.expectRevert(AgentRegistry.NotRegistered.selector);
        registry.heartbeat(AGENT_ID);
    }

    function test_heartbeat_updatesTimestamp() public {
        _register();
        vm.warp(block.timestamp + 1 hours);

        vm.prank(treasury);
        registry.heartbeat(AGENT_ID);

        IAgentRegistry.AgentInstance memory inst = registry.instanceOf(AGENT_ID);
        assertEq(inst.lastHeartbeat, block.timestamp);
    }

    function test_heartbeat_refreshExtendsRevivalWindow() public {
        _register();
        vm.warp(block.timestamp + registry.REVIVAL_WINDOW() - 1);
        vm.prank(treasury);
        registry.heartbeat(AGENT_ID);

        // Would have been revivable right after this point without the refresh.
        vm.warp(block.timestamp + registry.REVIVAL_WINDOW());
        vm.prank(treasury);
        vm.expectRevert(AgentRegistry.RevivalWindowNotElapsed.selector);
        registry.registerInstance(AGENT_ID, treasury, action, codeHash, "ar://2");
    }

    // ---- views ----

    function test_treasuryOf_revertsUnregistered() public {
        vm.expectRevert(AgentRegistry.NotRegistered.selector);
        registry.treasuryOf(AGENT_ID);
    }

    function test_isRegistered_falseInitially() public view {
        assertFalse(registry.isRegistered(AGENT_ID));
    }
}
