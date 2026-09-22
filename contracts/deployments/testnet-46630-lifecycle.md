# M1 testnet lifecycle transcript — Robinhood Chain testnet (46630)

Real transactions against the live Uniswap v4 `PoolManager` at
`0x8366a39CC670B4001A1121B8F6A443A643e40951`. Produced by `script/Deploy.s.sol` and
`script/Lifecycle.s.sol`; every contract below is source-verified on the Blockscout
explorer at https://explorer.testnet.chain.robinhood.com.

## Deviations from the ideal drill

* **USDG is mocked.** The live USDG on this testnet is supply-controlled and
  unobtainable (the only candidate pool holds zero liquidity), so
  `script/support/MockUSDG.sol` — 6 decimals, single-minter — stands in. Mainnet passes
  the canonical token address to the same constructors; nothing in `src/` changes.
* **The hook is CREATE2-deployed through `script/support/HookDeployer.sol`, not the
  canonical `0x4e59b448…` singleton.** `FeeSplitHook` pins `deployer = msg.sender` in its
  constructor and gates its one-time `setFactory` on it, so deploying through the shared
  singleton would leave that wiring call permanently unreachable. The mined address must
  come from a CREATE2 deployer that can also make that one call.
* **Revival is not exercised.** `AgentRegistry.registerInstance`'s re-registration path
  needs `REVIVAL_WINDOW` = 7 days of heartbeat silence, which cannot be produced on a live
  chain inside a drill. Covered by `test/AgentRegistry.t.sol` and `test/Adversarial.t.sol`.
* **Two `distribute` calls, one hour apart.** `FeeSplitHook.DISTRIBUTE_COOLDOWN` is 1 h and
  there is no `vm.warp` on a live chain, so stage 3 ran a wall-clock hour after stage 2.
  The two royalty claims are funded from the curve's royalty leg and from the hook's
  credit respectively, which keeps the drill to a single cooldown wait while still
  exercising claim-follows-owner, a non-zero emancipation sweep, and the post-burn
  re-route.

## Addresses

| what | address |
|---|---|
| MockUSDG (6 dec, drill stand-in) | `0xe6f7E5832991f5af335C2A21d4F35cea3d47ccAb` |
| AgentRegistry | `0xDBA9680C0F1958Af7Bc34a225863D93df2B92f59` |
| AgentNFT | `0x08024EDD43dcc639d2b99f17f85b4E527301B1A5` |
| RoyaltyDistributor | `0x25138BDF01F7b7E0e7ea6761ef54Ac8e8250d53B` |
| LiquidityLocker | `0x6213D1fb7DDf2F46E65F99b11a48a9b301487a68` |
| TreasuryBuyback | `0xD10097D4692bF94f123Df5892CaCf9DbacaEA67D` |
| HookDeployer (CREATE2, script-only) | `0xD2444Ad60697fe0df6eC0a55d5ad2411442C1F2F` |
| FeeSplitHook (flag-mined) | `0x40053E41fa0Bcdcd2EB127954Ce624323e9aa044` |
| AgentFactory | `0x7b257abd9BDf3377Af03DD67e2D67a8D5717b118` |
| PoolSwapTest (v4-core router, drill-only) | `0xb37851154a9645719B7F83E469918347D7C736A7` |
| Uniswap v4 PoolManager (live, pre-existing) | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| deployer / creator EOA | `0x6930FD5C95a2D9d80F3d165597d55843e8A00154` |
| agent treasury EOA (scripted) | `0xDc4329B95325096C888f18eFBACBBe7A8e45e46d` |
| second NFT owner EOA (scripted) | `0xCFDfd411d7aB8d731271154987987c8580a60767` |
| genesis gas recipient EOA (scripted) | `0x4f91481Fd31Afc8c2018438F796F92Cc6694D1fA` |
| FeeSplitHook CREATE2 salt | `0x0000000000000000000000000000000000000000000000000000000000004895` |

Agent 1 artifacts: AGENT token `0x308ceBcf8258a91DE06ddF1194dE82b04B72a1b4`, bonding curve
clone `0x51D065A6BF579E2b3C31f9A7edA551CdeD5CEA4a`, curve implementation
`0xE667d10C2b7e4e925f0CE52379920F6359f73181`, pool id
`0xfcc61dbf0da5c1e3ecd33f8075227b84ef2408e5c54fa0f915db201cea803957`.

The hook address `0x40053E41fa0Bcdcd2EB127954Ce624323e9aa044` carries exactly
`BEFORE_INITIALIZE | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA` in its low 14 bits
(`0x2044`), and no other permission bit.

## Totals

**23,102,337 gas across all stages · 0.000231023 ETH at 0.01 gwei.**

## Stage 0 — deploy and wire the stack

```
  deployer           : 0x6930FD5C95a2D9d80F3d165597d55843e8A00154
  deployer balance   : 11000000000000000
  MockUSDG           : 0xe6f7E5832991f5af335C2A21d4F35cea3d47ccAb
  AgentRegistry      : 0xDBA9680C0F1958Af7Bc34a225863D93df2B92f59
  AgentNFT           : 0x08024EDD43dcc639d2b99f17f85b4E527301B1A5
  RoyaltyDistributor : 0x25138BDF01F7b7E0e7ea6761ef54Ac8e8250d53B
  LiquidityLocker    : 0x6213D1fb7DDf2F46E65F99b11a48a9b301487a68
  TreasuryBuyback    : 0xD10097D4692bF94f123Df5892CaCf9DbacaEA67D
  HookDeployer       : 0xD2444Ad60697fe0df6eC0a55d5ad2411442C1F2F
  hook salt          : 18581
  hook address       : 0x40053E41fa0Bcdcd2EB127954Ce624323e9aa044
  FeeSplitHook       : 0x40053E41fa0Bcdcd2EB127954Ce624323e9aa044
  AgentFactory       : 0x7b257abd9BDf3377Af03DD67e2D67a8D5717b118
  PoolSwapTest       : 0xb37851154a9645719B7F83E469918347D7C736A7
  wiring graph       : OK
  manifest           : deployments/testnet-46630.json
```

_17 transactions · 17,797,526 gas · 0.000177975 ETH_

| # | contract | call | gas | tx hash | |
|---|---|---|---|---|---|
| 1 | `MockUSDG` | deploy | 592,728 | `0x2235ec3014d0cdb5ca9795086ac0bbb431b4d3ac35588611dec19b28189ffed3` | ok |
| 2 | `AgentRegistry` | deploy | 828,924 | `0x0950de062a7f66b177777baef5f2bc4c4cfbe84074574d6bbde05056ca0328f5` | ok |
| 3 | `AgentNFT` | deploy | 1,270,145 | `0x94d5413d0a9060e81837998eb68db118a0847a0078649d9c97eab4b85ff1b651` | ok |
| 4 | `RoyaltyDistributor` | deploy | 850,226 | `0xd1ba54eb5b2994315ebf9c2cd0b349f046e7e3b142748d128714b63cd688df2e` | ok |
| 5 | `LiquidityLocker` | deploy | 1,453,974 | `0x51590f69be2cf992c39345e278bad5844b4f259cf800f61b5362bb944ae7ad4d` | ok |
| 6 | `TreasuryBuyback` | deploy | 2,077,763 | `0x38b175b21886ec907b3f4c81ce3ae84c784f325e65d1c746975a06c9363f8cbd` | ok |
| 7 | `HookDeployer` | deploy | 264,755 | `0x653cb998c5fc0e9af9010dd7a0c24f0430ed6515c970cb5dfe8ebfbd50dc5a6d` | ok |
| 8 | `HookDeployer` | `deploy` | 2,745,032 | `0x55f39c82cefb112582e54673aad6aef0f1d63608dfbfe8fbfeb67868580afe90` | ok |
| 9 | `AgentFactory` | deploy | 5,927,078 | `0xda9021383853b792978558349aa7fc2d87d9b8fbd84b119d2e0c6110d68c081d` | ok |
| 10 | `PoolSwapTest` | deploy | 1,440,496 | `0x8e10c70f55c8928595773e1557b4e6e2d174dbcaf578fdeb19e702f47deb4336` | ok |
| 11 | `AgentRegistry` | `setFactory` | 48,535 | `0xae696b6a27da1ed24a3f540b5ca044dabd70527e556b0cd87ba66017342bb42a` | ok |
| 12 | `AgentNFT` | `setFactory` | 48,493 | `0xfbf80e8a5586a2ec353e18aa3aa815be3800d401373c052e2c8e9776cc9b41c1` | ok |
| 13 | `AgentNFT` | `setDistributor` | 48,449 | `0x47e50c51414cb72fff7013cfa9bca38860bd42677d88f8ae69b6d38c0e39766e` | ok |
| 14 | `RoyaltyDistributor` | `setFactory` | 48,507 | `0x64d480934e6139c5549550f12ea74317bef72f689dbd294a6021114899b78903` | ok |
| 15 | `RoyaltyDistributor` | `setHook` | 48,465 | `0x01ab50709a62d527d5174c23ec444c6e71eaa0d0ac55e0a49696dc662eb1bb59` | ok |
| 16 | `LiquidityLocker` | `setFactory` | 49,606 | `0xc4ce86c9f31920742edfe09e1f2c90ed039457453432c518c2cb281412a72d51` | ok |
| 17 | `HookDeployer` | `setHookFactory` | 54,350 | `0xd9462079f753b7ef20fa5560f46bd82f7e613d58fce1bc0e0c0c88126b929eaa` | ok |

## Stage 1 — create, register, finalize, curve trading, first royalty claim

```
  === PHASE 1 - curve ===
  -- 0. actors funded --
    creator/deployer : 0x6930FD5C95a2D9d80F3d165597d55843e8A00154
    treasury EOA     : 0xDc4329B95325096C888f18eFBACBBe7A8e45e46d
    second owner EOA : 0xCFDfd411d7aB8d731271154987987c8580a60767
    creator USDG     : 250000.000000 USDG
  -- 1. create / register / finalize --
    agentId          : 1
    AGENT token      : 0x308ceBcf8258a91DE06ddF1194dE82b04B72a1b4
    bonding curve    : 0x51D065A6BF579E2b3C31f9A7edA551CdeD5CEA4a
    NFT owner        : 0x6930FD5C95a2D9d80F3d165597d55843e8A00154
    generation       : 1
    creation fee     : 75.000000 USDG -> platformFeeRecipient
  -- 2. curve buys --
    bought (2 txs)   : 30000.000000 USDG
    real reserve     : 29100.000000 USDG
    AGENT held/1e18  : 829059829
    buyback leg      : 300.000000 USDG
    treasury leg     : 300.000000 USDG
    royalty accrued  : 300.000000 USDG
  -- 3. royalty claim (creator owns the NFT) --
    paid to creator  : 300.000000 USDG
  -- 4. curve sell (still below threshold) --
    sold AGENT/1e18  : 41452991
    received         : 6644.987928 USDG
    real reserve     : 22249.496982 USDG
  -- 5. closing buy --
    spent            : 21361.343317 USDG
    real reserve     : 42970.000000 USDG
    readyToGraduate  : true
  -- ledger --
    buyback USDG     : 582.118463 USDG
    treasury EOA USDG: 582.118463 USDG
    2nd owner USDG   : 0.000000 USDG
    platform fee USDG: 205583.644611 USDG
    deployer ETH     : 10402024740000000
```

_14 transactions · 3,099,645 gas · 0.000030996 ETH_

| # | contract | call | gas | tx hash | |
|---|---|---|---|---|---|
| 1 | `—` | `transfer` | 24,432 | `0x8a12c5e452e72fb10d7f651c231e8b5b325309df89d1b0fd954705599c46f1fe` | ok |
| 2 | `—` | `transfer` | 24,432 | `0xaadc68b00a4247620dff14edd8f68a924d856c5bb0a62c71fbea4df1a75402f1` | ok |
| 3 | `—` | `mint` | 73,763 | `0xfb61fdb1b6c1aaf8eb56a6bb0d40edd82ca0b9ba1857838b21daeb4c9054c92b` | ok |
| 4 | `—` | `approve` | 52,010 | `0xc97faee43975b2526650048df6a5b84a41aeddec1212f66cbafa140f02d96ac8` | ok |
| 5 | `—` | `createAgent` | 323,899 | `0xd862ae18b784884f45b4b33b5be47aeb254637c5283ce41ba7bca43cf30acb77` | ok |
| 6 | `—` | `registerInstance` | 152,302 | `0xc12a2e9a5ed51263a5d18660a219bbcfbdec947fd7692a59e6b6e913060ac37a` | ok |
| 7 | `—` | `finalize` | 1,454,511 | `0xaf996fcbe3a11645a1affd565ce4c3075de3f8f64e8287db71167d3611a6411c` | ok |
| 8 | `—` | `approve` | 52,010 | `0xbda421f365a1a38cc45b3e5c19f5d578bf908df377212ee1aa14d470e6e3cc2c` | ok |
| 9 | `—` | `buy` | 300,291 | `0x2cdf47873b6166f4f511df839c7b006049fc96aa5e5ec55bbca8b82c5deeb88b` | ok |
| 10 | `—` | `buy` | 163,491 | `0x28e01184775e46cd622ba475f268b1cde1859ebebd75be17d388ed1d744f3230` | ok |
| 11 | `—` | `claim` | 48,378 | `0x7504854eb2e56388ddcc20eb2b699eb9bbda14063a8a030e7ebd7aaf90193401` | ok |
| 12 | `AgentToken` | `approve` | 52,011 | `0xe9dc6a85bd96de663caf17fcf443edb08e8fc898e0c26e9641433d4a0cce0863` | ok |
| 13 | `—` | `sell` | 214,612 | `0x7e2d1ed05a08a4b32352454e400c3302235c88777a08d8f615a51cff6611d8db` | ok |
| 14 | `—` | `buy` | 163,503 | `0x3440ab2ce9589713d95ef0ebfe4082f2fefac585c01d386c419f3fa247aff972` | ok |

## Stage 2 — graduation, pool seed and lock, swaps, NFT transfer, claim, distribute #1, burn

```
  === PHASE 2 - graduation, pool, royalty tail ===
  -- 6. graduate (sweep + burn) --
    swept USDG       : 42970.000000 USDG
    pool AGENT/1e18  : 107511865
    burned AGENT/1e18: 15012129
  -- 7. graduated pool seeded + locked --
    poolId           : 0xfcc61dbf0da5c1e3ecd33f8075227b84ef2408e5c54fa0f915db201cea803957
    sqrtPriceX96     : 1583922990388897761225
    locked liquidity : 2149368475548204523
    AGENT supply/1e18: 984987870
  -- 8. pool swaps, both directions --
    USDG in          : 2000.000000 USDG
    AGENT in /1e18   : 2000000
    pending USDG fees: 25.763299 USDG
    pending AGENT/1e18: 143444
  -- 9. NFT transferred; claim follows the owner --
    new owner        : 0xCFDfd411d7aB8d731271154987987c8580a60767
    paid to new owner: 282.118463 USDG
  -- 10. distribute #1 (AGENT converted, split in thirds) --
    leg, each of 3   : 28.699315 USDG
    treasury received: 28.699315 USDG
    royalty accrued  : 28.699315 USDG
    AGENT left /1e18 : 0
  -- 11. burn -> emancipated (one-way) --
    swept to treasury: 28.699315 USDG
    (was unclaimed)  : 28.699315 USDG
  -- 12. two more swaps, fees left pending for phase 3 --
    pending USDG fees: 27.004272 USDG
    pending AGENT/1e18: 136640
  -- ledger --
    buyback USDG     : 610.817778 USDG
    treasury EOA USDG: 639.517093 USDG
    2nd owner USDG   : 282.118463 USDG
    platform fee USDG: 203289.796057 USDG
    deployer ETH     : 10372551310000000
```

_12 transactions · 1,989,010 gas · 0.000019890 ETH_

| # | contract | call | gas | tx hash | |
|---|---|---|---|---|---|
| 1 | `—` | `graduate` | 177,561 | `0x37afd583bcc12e5d034511c5f9b91f7e35dcae12fb1d414c78c00976cc204f7b` | ok |
| 2 | `—` | `createGraduatedPool` | 506,847 | `0x02e49eb90fb4e6edc46b824ac06c6fdeef5cab961d7125efebf734eb44721de7` | ok |
| 3 | `—` | `approve` | 52,010 | `0xa0373650bc484ec70201bc1db6ef4280e80aaffc415fa1c927c8f9cb6e81439e` | ok |
| 4 | `—` | `approve` | 52,011 | `0x65e56af614536fa03d46233eee727d7e932d8daa4e2bbecaa3e257751e89ec6c` | ok |
| 5 | `—` | `swap` | 191,245 | `0x83252f8398798ed7c89654196c09ab7e291e10623137c3bbbc7180e8690830b5` | ok |
| 6 | `—` | `swap` | 190,780 | `0xe1ecf786b489c691ef0ffe8bfa52d6f9e0a8e9bb867d32e4b04419415350ecab` | ok |
| 7 | `—` | `transferFrom` | 61,383 | `0x7f0d2a1d7e60ddcb15d641f595c973aa212898ab02c59db3a18615a1fa748070` | ok |
| 8 | `—` | `claim` | 62,087 | `0x3b3e5a6b8149fee0a63699564add2a7f60acacc260bd5863d455dd15ed3d18fa` | ok |
| 9 | `—` | `distribute` | 252,942 | `0xca78fbef8c0eb92b2017debba0f9fa3d285effd10a363f432fce54aba07f2ec2` | ok |
| 10 | `—` | `burn` | 84,114 | `0x929711017f85dcc9d8de539c8e275c7f8e54ee684e9bcd236b4f8c6f42ecaa67` | ok |
| 11 | `—` | `swap` | 196,093 | `0xca87425ea872db12946918ae442dd9e5ad8de125e8fa781e771f796e3db4c0a6` | ok |
| 12 | `—` | `swap` | 161,937 | `0x6f5a867068ebecb82995fc19afebd346a619933ea001e371cb4fef85b228f542` | ok |

## Stage 3 — post-burn distribute (royalty leg re-routed) and heartbeat

```
  === PHASE 3 - post-burn distribute + heartbeat ===
  -- 13. distribute #2, post-burn (royalty leg re-routed) --
    seconds since #1 : 3661
    leg, each of 3   : 29.073282 USDG
    treasury received: 58.146564 USDG (treasury leg + royalty leg)
    distributor accr.: 0.000000 USDG
  -- 14. registry heartbeat from the treasury EOA --
    lastHeartbeat    : 1790088466
    generation       : 1
    NOTE             : revival needs a 7-day lapse - not runnable live
  -- ledger --
    buyback USDG     : 639.891060 USDG
    treasury EOA USDG: 697.663657 USDG
    2nd owner USDG   : 282.118463 USDG
    platform fee USDG: 203289.796057 USDG
    deployer ETH     : 10353502350000000
```

_2 transactions · 216,156 gas · 0.000002162 ETH_

| # | contract | call | gas | tx hash | |
|---|---|---|---|---|---|
| 1 | `—` | `distribute` | 180,194 | `0xa43e0b5439e23858026ca0ca18ee134021e92dccfbd41f0d21a0784aad23a9fd` | ok |
| 2 | `—` | `heartbeat` | 35,962 | `0x194d430991811fad59712c0ecf250bf8e2958c13751c5e8d6dd148536db1cabf` | ok |


## Source verification

Every contract is verified on Blockscout (`https://explorer.testnet.chain.robinhood.com`):
`MockUSDG`, `AgentRegistry`, `AgentNFT`, `RoyaltyDistributor`, `LiquidityLocker`,
`TreasuryBuyback`, `HookDeployer`, `FeeSplitHook`, `AgentFactory`, `PoolSwapTest`,
`AgentBondingCurve` (implementation) and agent 1's `AgentToken` — 12 of 12.

## Final on-chain state (read back after stage 3)

| check | value |
|---|---|
| `FeeSplitHook.factory()` | `0x7b257abd9BDf3377Af03DD67e2D67a8D5717b118` (the factory) |
| `RoyaltyDistributor.emancipated(1)` | `true` — burn is one-way |
| `RoyaltyDistributor.accrued(1)` | `0` — nothing accrues after emancipation |
| `LiquidityLocker.lockedLiquidity(1)` | `2149368475548204523`, held by the locker, no removal path |
| `AgentNFT.ownerOf(1)` | reverts `ERC721NonexistentToken(1)` — burned |
| `AgentRegistry.instanceOf(1)` | treasury `0xDc43…e46d`, generation `1`, heartbeat fresh |
| agent treasury EOA USDG | `697.663657` |
| TreasuryBuyback USDG | `639.891060` |
| second NFT owner USDG | `282.118463` (the royalty claim that followed the NFT) |
