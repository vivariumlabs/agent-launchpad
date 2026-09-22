// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentNFT} from "../src/AgentNFT.sol";
import {RoyaltyDistributor} from "../src/RoyaltyDistributor.sol";
import {LiquidityLocker} from "../src/LiquidityLocker.sol";
import {TreasuryBuyback} from "../src/TreasuryBuyback.sol";
import {FeeSplitHook} from "../src/FeeSplitHook.sol";
import {AgentFactory} from "../src/AgentFactory.sol";

import {LaunchpadScript} from "./support/LaunchpadScript.sol";
import {MockUSDG} from "./support/MockUSDG.sol";
import {HookDeployer} from "./support/HookDeployer.sol";

/// @notice Deploys the whole M1 stack to Robinhood Chain testnet (46630), wires it, asserts the
///         complete wiring graph, and writes `deployments/testnet-46630.json`.
///
/// @dev Two deployment-shape notes that do not exist in the unit tests:
///
///      * **USDG is mocked.** The live USDG on this testnet is supply-controlled and
///        unobtainable, so a 6-decimal `MockUSDG` stands in. Mainnet passes the canonical
///        token address instead; nothing in `src/` changes.
///
///      * **The hook is CREATE2-deployed through `HookDeployer`, not the canonical
///        `0x4e59b448…` singleton.** `FeeSplitHook` pins `deployer = msg.sender` at
///        construction and gates its one-time `setFactory` on it; deploying through the
///        canonical singleton would make that wiring call unreachable forever. See
///        `script/support/HookDeployer.sol`.
///
/// Usage:
///   FOUNDRY_OUT=out-g FOUNDRY_CACHE_PATH=cache-g \
///   forge script script/Deploy.s.sol:Deploy --rpc-url rh_testnet --broadcast --slow
contract Deploy is LaunchpadScript {
    /// @dev Bound on the salt search: the flag match is 1-in-2^14, so this is ~30x headroom.
    uint256 internal constant MAX_SALT = 500_000;

    Deployment internal d;

    bytes32 internal hookSalt;

    function run() external {
        requireTestnet();

        uint256 pk = deployerKey();
        d.deployer = vm.addr(pk);
        d.treasuryEOA = treasuryEOA();
        d.secondOwnerEOA = secondOwnerEOA();
        d.genesisGasRecipient = genesisGasRecipientEOA();

        console2.log("deployer           :", d.deployer);
        console2.log("deployer balance   :", d.deployer.balance);

        _deployBase(pk);
        _deployHookAndFactory(pk);
        _wire(pk);
        _assertWiring();
        _writeManifest();
    }

    // -----------------------------------------------------------------------
    // deployment
    // -----------------------------------------------------------------------

    function _deployBase(uint256 pk) internal {
        vm.startBroadcast(pk);
        d.usdg = address(new MockUSDG(vm.addr(pk)));
        d.registry = address(new AgentRegistry());
        d.nft = address(new AgentNFT());
        d.distributor = address(new RoyaltyDistributor(d.usdg, d.nft, d.registry));
        d.locker = address(new LiquidityLocker(IPoolManager(POOL_MANAGER)));
        d.treasuryBuyback = address(new TreasuryBuyback(IPoolManager(POOL_MANAGER), d.usdg, vm.addr(pk), 500));
        d.hookDeployer = address(new HookDeployer());
        vm.stopBroadcast();

        console2.log("MockUSDG           :", d.usdg);
        console2.log("AgentRegistry      :", d.registry);
        console2.log("AgentNFT           :", d.nft);
        console2.log("RoyaltyDistributor :", d.distributor);
        console2.log("LiquidityLocker    :", d.locker);
        console2.log("TreasuryBuyback    :", d.treasuryBuyback);
        console2.log("HookDeployer       :", d.hookDeployer);
    }

    function _deployHookAndFactory(uint256 pk) internal {
        bytes memory initCode = abi.encodePacked(
            type(FeeSplitHook).creationCode,
            abi.encode(IPoolManager(POOL_MANAGER), d.usdg, d.registry, d.distributor, d.treasuryBuyback)
        );

        (bytes32 salt, address mined) = _mineHookSalt(d.hookDeployer, initCode);
        hookSalt = salt;
        console2.log("hook salt          :", uint256(salt));
        console2.log("hook address       :", mined);

        vm.startBroadcast(pk);
        address deployed = HookDeployer(d.hookDeployer).deploy(salt, initCode);
        require(deployed == mined, "mined hook address mismatch");
        d.hook = deployed;

        d.factory = address(
            new AgentFactory(
                d.usdg,
                POOL_MANAGER,
                d.registry,
                d.nft,
                d.distributor,
                d.hook,
                d.locker,
                d.treasuryBuyback,
                d.genesisGasRecipient,
                vm.addr(pk)
            )
        );
        d.swapRouter = address(new PoolSwapTest(IPoolManager(POOL_MANAGER)));
        vm.stopBroadcast();

        console2.log("FeeSplitHook       :", d.hook);
        console2.log("AgentFactory       :", d.factory);
        console2.log("PoolSwapTest       :", d.swapRouter);
    }

    /// @dev Brute-forces a salt whose CREATE2 address carries exactly `HOOK_FLAGS` in its low 14
    ///      bits — every other hook-permission bit must be zero, or v4 would call entrypoints
    ///      this hook does not implement. The `code.length` probe is deliberately inside the
    ///      flag branch: it is an RPC round trip on a fork, and only ~1 candidate in 2^14 reaches
    ///      it. Runs outside any broadcast, so it costs no gas.
    function _mineHookSalt(address create2Deployer, bytes memory initCode)
        internal
        view
        returns (bytes32 salt, address hookAddr)
    {
        bytes32 initCodeHash = keccak256(initCode);
        for (uint256 i = 0; i < MAX_SALT; ++i) {
            bytes32 candidateSalt = bytes32(i);
            address candidate = vm.computeCreate2Address(candidateSalt, initCodeHash, create2Deployer);
            if (uint160(candidate) & Hooks.ALL_HOOK_MASK != HOOK_FLAGS) continue;
            if (candidate.code.length != 0) continue; // a previous run already took this one
            return (candidateSalt, candidate);
        }
        revert("no hook salt found");
    }

    // -----------------------------------------------------------------------
    // wiring
    // -----------------------------------------------------------------------

    function _wire(uint256 pk) internal {
        vm.startBroadcast(pk);
        AgentRegistry(d.registry).setFactory(d.factory);
        AgentNFT(d.nft).setFactory(d.factory);
        AgentNFT(d.nft).setDistributor(d.distributor);
        RoyaltyDistributor(d.distributor).setFactory(d.factory);
        RoyaltyDistributor(d.distributor).setHook(d.hook);
        LiquidityLocker(d.locker).setFactory(d.factory);
        HookDeployer(d.hookDeployer).setHookFactory(d.hook, d.factory);
        vm.stopBroadcast();
    }

    // -----------------------------------------------------------------------
    // post-conditions — every edge of the wiring graph, cross-checked
    // -----------------------------------------------------------------------

    function _assertWiring() internal view {
        _assertHookAddress();
        _assertConstructorEdges();
        _assertOneTimeWiring();
        console2.log("wiring graph       : OK");
    }

    function _assertHookAddress() internal view {
        require(uint160(d.hook) & Hooks.ALL_HOOK_MASK == HOOK_FLAGS, "hook flags wrong");
        require(Hooks.isValidHookAddress(IHooks(d.hook), POOL_FEE), "hook address invalid for v4");
        require(d.hook.code.length > 0, "hook has no code");

        Hooks.Permissions memory p = FeeSplitHook(d.hook).getHookPermissions();
        require(p.beforeInitialize && p.afterSwap && p.afterSwapReturnDelta, "missing hook permission");
        require(
            !p.afterInitialize && !p.beforeAddLiquidity && !p.afterAddLiquidity && !p.beforeRemoveLiquidity
                && !p.afterRemoveLiquidity && !p.beforeSwap && !p.beforeDonate && !p.afterDonate
                && !p.beforeSwapReturnDelta && !p.afterAddLiquidityReturnDelta && !p.afterRemoveLiquidityReturnDelta,
            "extra hook permission"
        );
    }

    function _assertConstructorEdges() internal view {
        RoyaltyDistributor dist = RoyaltyDistributor(d.distributor);
        require(address(dist.usdg()) == d.usdg, "distributor.usdg");
        require(address(dist.nft()) == d.nft, "distributor.nft");
        require(address(dist.registry()) == d.registry, "distributor.registry");

        FeeSplitHook h = FeeSplitHook(d.hook);
        require(address(h.poolManager()) == POOL_MANAGER, "hook.poolManager");
        require(h.usdg() == d.usdg, "hook.usdg");
        require(address(h.registry()) == d.registry, "hook.registry");
        require(address(h.distributor()) == d.distributor, "hook.distributor");
        require(h.treasuryBuyback() == d.treasuryBuyback, "hook.treasuryBuyback");
        require(h.deployer() == d.hookDeployer, "hook.deployer must be the HookDeployer");

        require(address(LiquidityLocker(d.locker).poolManager()) == POOL_MANAGER, "locker.poolManager");
        require(address(TreasuryBuyback(d.treasuryBuyback).poolManager()) == POOL_MANAGER, "buyback.poolManager");
        require(TreasuryBuyback(d.treasuryBuyback).usdg() == d.usdg, "buyback.usdg");
        require(TreasuryBuyback(d.treasuryBuyback).maxImpactBps() == 500, "buyback.maxImpactBps");
        require(TreasuryBuyback(d.treasuryBuyback).owner() == d.deployer, "buyback.owner");

        _assertFactoryEdges();
    }

    function _assertFactoryEdges() internal view {
        AgentFactory f = AgentFactory(d.factory);
        require(address(f.usdg()) == d.usdg, "factory.usdg");
        require(address(f.poolManager()) == POOL_MANAGER, "factory.poolManager");
        require(address(f.registry()) == d.registry, "factory.registry");
        require(address(f.nft()) == d.nft, "factory.nft");
        require(address(f.distributor()) == d.distributor, "factory.distributor");
        require(address(f.hook()) == d.hook, "factory.hook");
        require(address(f.locker()) == d.locker, "factory.locker");
        require(f.treasuryBuyback() == d.treasuryBuyback, "factory.treasuryBuyback");
        require(f.genesisGasRecipient() == d.genesisGasRecipient, "factory.genesisGasRecipient");
        require(f.owner() == d.deployer, "factory.owner");
        require(f.platformFeeRecipient() == d.deployer, "factory.platformFeeRecipient");
        require(f.curveImplementation().code.length > 0, "factory.curveImplementation");
        require(f.agentCount() == 0, "factory.agentCount");
    }

    function _assertOneTimeWiring() internal view {
        require(AgentRegistry(d.registry).factory() == d.factory, "registry.factory");
        require(AgentRegistry(d.registry).deployer() == d.deployer, "registry.deployer");
        require(AgentNFT(d.nft).factory() == d.factory, "nft.factory");
        require(AgentNFT(d.nft).distributor() == d.distributor, "nft.distributor");
        require(RoyaltyDistributor(d.distributor).factory() == d.factory, "distributor.factory");
        require(RoyaltyDistributor(d.distributor).hook() == d.hook, "distributor.hook");
        require(LiquidityLocker(d.locker).factory() == d.factory, "locker.factory");
        require(FeeSplitHook(d.hook).factory() == d.factory, "hook.factory");
        require(MockUSDG(d.usdg).minter() == d.deployer, "usdg.minter");
        require(MockUSDG(d.usdg).decimals() == 6, "usdg.decimals");
        require(address(PoolSwapTest(d.swapRouter).manager()) == POOL_MANAGER, "swapRouter.manager");
    }

    // -----------------------------------------------------------------------
    // manifest
    // -----------------------------------------------------------------------

    function _writeManifest() internal {
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "deployedAtBlock", block.number);
        vm.serializeAddress(obj, "poolManager", POOL_MANAGER);
        vm.serializeAddress(obj, "deployer", d.deployer);
        vm.serializeAddress(obj, "usdg", d.usdg);
        vm.serializeAddress(obj, "registry", d.registry);
        vm.serializeAddress(obj, "nft", d.nft);
        vm.serializeAddress(obj, "distributor", d.distributor);
        vm.serializeAddress(obj, "locker", d.locker);
        vm.serializeAddress(obj, "treasuryBuyback", d.treasuryBuyback);
        vm.serializeAddress(obj, "hookDeployer", d.hookDeployer);
        vm.serializeAddress(obj, "hook", d.hook);
        vm.serializeBytes32(obj, "hookSalt", hookSalt);
        vm.serializeAddress(obj, "factory", d.factory);
        vm.serializeAddress(obj, "swapRouter", d.swapRouter);
        vm.serializeAddress(obj, "treasuryEOA", d.treasuryEOA);
        vm.serializeAddress(obj, "secondOwnerEOA", d.secondOwnerEOA);
        string memory json = vm.serializeAddress(obj, "genesisGasRecipient", d.genesisGasRecipient);
        vm.writeJson(json, DEPLOYMENT_PATH);
        console2.log("manifest           :", DEPLOYMENT_PATH);
    }
}
