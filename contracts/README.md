# contracts/

Foundry project. M1 contract suite per `docs/02-CONTRACTS.md` + `SPEC-M1.md` (binding implementation spec, includes review findings). M0 verification spike also lives here (`test/M0_RHTestnetV4.t.sol`).

## Setup

`lib/` is vendored as plain working trees (no `.git` — the workspace mount does not support git's lock semantics, so `forge install` fails there; clone elsewhere and copy, or just use the vendored copies). Pinned commits:

- forge-std `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b`
- v4-core `e50237c43811bd9b526eff40f26772152a42daba` (+ submodules)
- v4-periphery `9969eec44cfdf07e24b41de47f40276a58401976` (+ submodules)
- openzeppelin-contracts v5.1.0 `69c8def5f222ff96f2b5beff05dfba996368aa79`
- Foundry 1.8.3 (solc 0.8.26, evm cancun)

```bash
forge test -vv   # includes fork tests against https://rpc.testnet.chain.robinhood.com
```

## Known addresses (Robinhood Chain testnet, 46630)

| What | Address |
|------|---------|
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| USDG (Global Dollar, 6 decimals, EIP-3009) | `0x7E955252E15c84f5768B83c41a71F9eba181802F` |
| USDG supply control | `0x4549bb98c667aAb626627C118102c28065E8f54C` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

Mainnet (4663) Uniswap v4 addresses: PoolManager is the same deterministic address; full list at developers.uniswap.org/docs/protocols/v4/deployments.
