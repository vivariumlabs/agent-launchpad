// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {CountingHook} from "../src/CountingHook.sol";

contract SimpleERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

interface IUSDG {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// M0 assumption checks #2 (Uniswap v4 live on RH testnet, custom hook works)
/// and #3 (USDG address/decimals/EIP-3009), run against a fork of
/// Robinhood Chain testnet (chain id 46630).
contract M0_RHTestnetV4 is Test {
    // Uniswap v4 PoolManager — same deterministic address as RH mainnet per Uniswap deployments page.
    IPoolManager constant MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    // USDG per docs.paxos.com/guides/stablecoin/usdg/testnet
    IUSDG constant USDG = IUSDG(0x7E955252E15c84f5768B83c41a71F9eba181802F);
    // canonical EIP-3009 typehash: keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 constant EIP3009_TYPEHASH = 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    function setUp() public {
        vm.createSelectFork("rh_testnet");
    }

    function test_forkIsRobinhoodTestnet() public view {
        assertEq(block.chainid, 46630, "wrong chain");
        assertGt(address(MANAGER).code.length, 0, "no PoolManager code");
    }

    function test_usdg_decimals_and_eip3009() public view {
        assertEq(USDG.decimals(), 6, "USDG decimals");
        assertEq(keccak256(bytes(USDG.symbol())), keccak256("USDG"), "symbol");
        assertEq(USDG.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), EIP3009_TYPEHASH, "EIP-3009 typehash");
        assertTrue(USDG.DOMAIN_SEPARATOR() != bytes32(0), "domain separator");
    }

    function test_swapThroughCustomHook_onFork() public {
        // 1. deploy trivial hook at an address carrying exactly the beforeSwap|afterSwap flags
        address hookAddr = address(uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG) | (0x4444 << 20));
        deployCodeTo("CountingHook.sol:CountingHook", abi.encode(MANAGER), hookAddr);
        CountingHook hook = CountingHook(hookAddr);

        // 2. two fresh tokens, sorted
        SimpleERC20 a = new SimpleERC20("TokenA", "TKA");
        SimpleERC20 b = new SimpleERC20("TokenB", "TKB");
        (address t0, address t1) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));

        // 3. routers + funding
        PoolSwapTest swapRouter = new PoolSwapTest(MANAGER);
        PoolModifyLiquidityTest lpRouter = new PoolModifyLiquidityTest(MANAGER);
        SimpleERC20(t0).mint(address(this), 1_000_000e18);
        SimpleERC20(t1).mint(address(this), 1_000_000e18);
        SimpleERC20(t0).approve(address(swapRouter), type(uint256).max);
        SimpleERC20(t1).approve(address(swapRouter), type(uint256).max);
        SimpleERC20(t0).approve(address(lpRouter), type(uint256).max);
        SimpleERC20(t1).approve(address(lpRouter), type(uint256).max);

        // 4. init pool on the REAL RH-testnet PoolManager with our custom hook
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(t0),
            currency1: Currency.wrap(t1),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(hookAddr)
        });
        MANAGER.initialize(key, 79228162514264337593543950336); // 1:1

        // 5. add liquidity
        lpRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 100_000e18, salt: 0}),
            ""
        );

        // 6. swap
        assertEq(hook.beforeSwapCount(), 0);
        assertEq(hook.afterSwapCount(), 0);
        uint256 balBefore = SimpleERC20(t1).balanceOf(address(this));
        swapRouter.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: true,
                amountSpecified: -1e18, // exact input 1 TKA
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        uint256 got = SimpleERC20(t1).balanceOf(address(this)) - balBefore;

        // 7. hook fired, swap produced output
        assertEq(hook.beforeSwapCount(), 1, "beforeSwap not called");
        assertEq(hook.afterSwapCount(), 1, "afterSwap not called");
        assertGt(got, 0.9e18, "swap output implausibly low");
        console2.log("swap output (t1 wei):", got);
    }
}
