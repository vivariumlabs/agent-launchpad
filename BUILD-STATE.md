# BUILD STATE — updated 2026-09-22

## Milestone: M0 (2 of 4 verified green; M0-4 redesigned & locked in — drills for M0-1 and M0-4 await Juan's accounts)

## Done
- Repo scaffolded per 00 §5: `contracts/`, `runtime/`, `genesis/`, `web/`, `indexer/`, `docs/`. Git initialized.
- **M0-2 ✅ Uniswap v4 on RH testnet — VERIFIED.** PoolManager live at `0x8366a39CC670B4001A1121B8F6A443A643e40951` on testnet 46630 (same deterministic address as the mainnet deployment listed on Uniswap's official deployments page). Fork test (`contracts/test/M0_RHTestnetV4.t.sol`) deploys a trivial custom hook (`CountingHook`, beforeSwap+afterSwap flags), initializes a pool on the *real* PoolManager, adds liquidity, executes a swap: hook fired exactly once per callback, swap output 0.99699e18 for 1e18 in (≈0.3% fee — correct). **3/3 tests pass** against a live fork of `https://rpc.testnet.chain.robinhood.com`.
- **M0-3 ✅ USDG mechanics — VERIFIED** (via docs.paxos.com + live RPC + fork test assertions):
  - Testnet token: `0x7E955252E15c84f5768B83c41a71F9eba181802F` (EIP-1967 proxy), supply control `0x4549bb98c667aAb626627C118102c28065E8f54C`.
  - name "Global Dollar", symbol "USDG", **decimals = 6** (⚠ propagate: all USDG amounts in contracts/runtime are 6-decimals).
  - **EIP-3009 supported**: `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` returns the canonical `0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267`; `DOMAIN_SEPARATOR()` set. x402 settlement viable.
- **M0-1 🟡 Phala KMS — docs confirm the property, empirical drill prepared but blocked on Juan.** dstack KMS docs confirm deterministic keys bound to app identity/compose hash, portable across TEE nodes (exactly what D5/D6/D10 need). Full kill/redeploy drill is scripted and ready: `runtime/spikes/m0-phala-kms/` (app + compose + RUNBOOK, ~30 min once an account exists).
- **M0-4 🔴 OpenRouter — PARTIALLY FAILED as designed.** Key provisioning via management API: exists, documented, drill script ready (`runtime/spikes/m0-openrouter/provision-drill.sh`). **But the Crypto Payments API that D8's self-funding relies on has been REMOVED** — `POST /api/v1/credits/coinbase` returns 410 Gone (verified live 2026-09-22); only interactive web checkout remains. OpenRouter is publicly transitioning to x402 pay-per-use (USDC on Base, reported May 2026) but has no official x402 docs yet. **Redesign RESOLVED same day — Juan locked in the platform-run x402 gateway (D8 amended in 00 §3):** agent pays per call in USDC on Base (x402/EIP-3009) to a platform gateway in an attested Phala CVM; gateway meters against the agent's provisioned key; org balance self-refills via OpenRouter auto top-up (card). Docs updated: 00 (D8/diagram/money-flow 2), 01 §4, 03 §1/§3/§8, 04 §2/§3, 06 §1/§3.7/§4, 07 M0.4. Details: `runtime/spikes/m0-openrouter/FINDINGS.md`. Remaining M0-4 evidence: provisioning drill + local gateway spike with one paid testnet-USDC call.

## In progress / next steps
- Juan: create Phala Cloud account + billing → run the M0-1 drill (RUNBOOK ready).
- Juan: create OpenRouter org + management key + ~$20 + saved card with auto top-up → run provision-drill.sh.
- Claude: build local x402→OpenRouter gateway spike (base: ekailabs/x402-openrouter), one paid testnet-USDC inference call end-to-end (closes M0-4).
- Then close M0 and start M1 (contracts, per 02-CONTRACTS.md; study PONS repo first). M1 does not depend on the two blocked drills.

## Blocked on Juan
- Phala Cloud account/billing (M0-1 empirical drill).
- OpenRouter org + management key + ~$20 + auto top-up card (M0-4 remaining drill).

## Known issues / debt
- `contracts/lib/` (forge-std, v4-core, v4-periphery) is not committed — run `forge install uniswap/v4-core uniswap/v4-periphery` per `contracts/README.md`; commit hashes used for the green run are pinned there.
- M0 fork tests hit the public RPC; fine for now, get a dedicated RPC key by M1 (06 §runbook).
- Repo has git initialized but no commits yet.

## Decisions made this session (mirrored to 00 decision log)
- **D8 amended (Juan, 2026-09-22):** inference funding = platform-run x402 gateway fronting OpenRouter (per-call USDC on Base, EIP-3009), gateway in attested Phala CVM with pinned public code, org self-refills via auto top-up card; retire gateway via adapter URL change if OpenRouter ships native x402. Mirrored into 00 §3 D8.
- CLAUDE.md added at repo root: response style + Fable/Opus/Sonnet delegation policy for all future sessions.

## Evidence links (test runs, tx hashes, attestation refs)
- Fork test suite: `contracts/test/M0_RHTestnetV4.t.sol` — `forge test` 2026-09-22: 3 passed / 0 failed (chainid assert 46630; hook counters 1/1; swap out 996990060009101709 wei; USDG decimals/typehash asserts). Toolchain: Foundry 1.8.3, solc 0.8.26, evm cancun. Dep commits pinned in `contracts/README.md`.
- RPC checks 2026-09-22 against `https://rpc.testnet.chain.robinhood.com`: `eth_chainId` → 0xb626 (46630); block ≈ 0x7500e2d; PoolManager code present (24,009 bytes, sha256 `6eb21c69…585b`); USDG `name/symbol/decimals/DOMAIN_SEPARATOR/TRANSFER_WITH_AUTHORIZATION_TYPEHASH` eth_calls as above.
- OpenRouter 410: live `curl -X POST https://openrouter.ai/api/v1/credits/coinbase` 2026-09-22 → `{"error":{"code":410,…"removed"…}}`.
- Sources: developers.uniswap.org/docs/protocols/v4/deployments · docs.paxos.com/guides/stablecoin/usdg/testnet · docs.phala.com/dstack/overview · openrouter.ai/docs (llms.txt index + crypto-api page) · cryptobriefing.com/x402-protocol-50m-payments-openrouter (2026-05-22).
