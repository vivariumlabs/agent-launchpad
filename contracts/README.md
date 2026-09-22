# contracts/

Foundry project. Currently contains the M0 verification spike (see `docs/07-BUILD-PLAN.md` M0 and `BUILD-STATE.md`); the real contract suite lands in M1 per `docs/02-CONTRACTS.md`.

## Setup

```bash
forge install uniswap/v4-core uniswap/v4-periphery
forge test -vv   # runs fork tests against https://rpc.testnet.chain.robinhood.com
```

Dependency commits used for the M0 run (pin if reproducing):

- forge-std `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b`
- v4-core `e50237c43811bd9b526eff40f26772152a42daba`
- v4-periphery `9969eec44cfdf07e24b41de47f40276a58401976`
- Foundry 1.8.3 (solc 0.8.26, evm cancun)

## Known addresses (Robinhood Chain testnet, 46630)

| What | Address |
|------|---------|
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| USDG (Global Dollar, 6 decimals, EIP-3009) | `0x7E955252E15c84f5768B83c41a71F9eba181802F` |
| USDG supply control | `0x4549bb98c667aAb626627C118102c28065E8f54C` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

Mainnet (4663) Uniswap v4 addresses: PoolManager is the same deterministic address; full list at developers.uniswap.org/docs/protocols/v4/deployments.
