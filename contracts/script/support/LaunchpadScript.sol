// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @notice Shared constants, scripted-actor derivation and deployment-manifest I/O for the
///         Robinhood Chain testnet (46630) drill scripts.
/// @dev The actor keys below are derived from **public, non-secret** seed strings: anyone can
///      recompute them. They exist so every script run addresses the same EOAs without a
///      secrets file. They hold dust only, and nothing of value must ever be sent to them.
abstract contract LaunchpadScript is Script {
    /// @notice Live Uniswap v4 singleton on Robinhood Chain testnet.
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint256 internal constant TESTNET_CHAIN_ID = 46630;

    string internal constant DEPLOYMENT_PATH = "deployments/testnet-46630.json";

    /// @notice Flag bits a `FeeSplitHook` address must carry, and only those.
    uint160 internal constant HOOK_FLAGS =
        uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    int24 internal constant TICK_SPACING = 60;
    uint24 internal constant POOL_FEE = 0;

    uint256 internal constant CREATION_FEE = 75e6;
    uint256 internal constant PHANTOM_QUOTE = 6_000e6;
    uint256 internal constant GRADUATION_THRESHOLD = 42_000e6;

    /// @dev Public seeds — see the contract-level note.
    uint256 internal constant TREASURY_KEY = uint256(keccak256("agent-launchpad/m1-drill/treasury-eoa/v1"));
    uint256 internal constant SECOND_OWNER_KEY = uint256(keccak256("agent-launchpad/m1-drill/second-owner-eoa/v1"));
    uint256 internal constant GAS_RECIPIENT_KEY = uint256(keccak256("agent-launchpad/m1-drill/genesis-gas-eoa/v1"));

    struct Deployment {
        address usdg;
        address registry;
        address nft;
        address distributor;
        address locker;
        address treasuryBuyback;
        address hookDeployer;
        address hook;
        address factory;
        address swapRouter;
        address deployer;
        address treasuryEOA;
        address secondOwnerEOA;
        address genesisGasRecipient;
    }

    function treasuryEOA() internal pure returns (address) {
        return vm.addr(TREASURY_KEY);
    }

    function secondOwnerEOA() internal pure returns (address) {
        return vm.addr(SECOND_OWNER_KEY);
    }

    function genesisGasRecipientEOA() internal pure returns (address) {
        return vm.addr(GAS_RECIPIENT_KEY);
    }

    /// @notice Deployer private key, supplied out-of-band as `DEPLOYER_PK`. Never written down.
    function deployerKey() internal view returns (uint256) {
        return vm.envUint("DEPLOYER_PK");
    }

    function readDeployment() internal view returns (Deployment memory d) {
        string memory json = vm.readFile(DEPLOYMENT_PATH);
        d.usdg = vm.parseJsonAddress(json, ".usdg");
        d.registry = vm.parseJsonAddress(json, ".registry");
        d.nft = vm.parseJsonAddress(json, ".nft");
        d.distributor = vm.parseJsonAddress(json, ".distributor");
        d.locker = vm.parseJsonAddress(json, ".locker");
        d.treasuryBuyback = vm.parseJsonAddress(json, ".treasuryBuyback");
        d.hookDeployer = vm.parseJsonAddress(json, ".hookDeployer");
        d.hook = vm.parseJsonAddress(json, ".hook");
        d.factory = vm.parseJsonAddress(json, ".factory");
        d.swapRouter = vm.parseJsonAddress(json, ".swapRouter");
        d.deployer = vm.parseJsonAddress(json, ".deployer");
        d.treasuryEOA = vm.parseJsonAddress(json, ".treasuryEOA");
        d.secondOwnerEOA = vm.parseJsonAddress(json, ".secondOwnerEOA");
        d.genesisGasRecipient = vm.parseJsonAddress(json, ".genesisGasRecipient");
    }

    /// @notice The agent pool key: AGENT/USDG sorted, fee 0, tickSpacing 60, FeeSplitHook.
    function poolKeyOf(address agentToken, address usdg, address hook) internal pure returns (PoolKey memory) {
        (Currency c0, Currency c1) = agentToken < usdg
            ? (Currency.wrap(agentToken), Currency.wrap(usdg))
            : (Currency.wrap(usdg), Currency.wrap(agentToken));
        return PoolKey({currency0: c0, currency1: c1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: IHooks(hook)});
    }

    function requireTestnet() internal view {
        require(block.chainid == TESTNET_CHAIN_ID, "wrong chain: expected Robinhood Chain testnet 46630");
        require(POOL_MANAGER.code.length > 0, "no PoolManager code at the pinned address");
    }

    /// @dev 6-decimal USDG amounts, printed with a decimal point so the transcript reads plainly.
    function usdgStr(uint256 amount) internal pure returns (string memory) {
        return string.concat(vm.toString(amount / 1e6), ".", _pad6(amount % 1e6), " USDG");
    }

    function _pad6(uint256 frac) private pure returns (string memory s) {
        s = vm.toString(frac);
        while (bytes(s).length < 6) {
            s = string.concat("0", s);
        }
    }
}
