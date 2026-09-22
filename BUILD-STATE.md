# BUILD STATE — updated 2026-09-22

## Milestone: M0 (2 of 4 verified green; M0-1 and M0-4 drills ready — await throwaway-wallet funding, no accounts needed)

## Done
- Repo scaffolded per 00 §5: `contracts/`, `runtime/`, `genesis/`, `web/`, `indexer/`, `docs/`. Git initialized.
- **M0-2 ✅ Uniswap v4 on RH testnet — VERIFIED.** PoolManager live at `0x8366a39CC670B4001A1121B8F6A443A643e40951` on testnet 46630 (same deterministic address as the mainnet deployment listed on Uniswap's official deployments page). Fork test (`contracts/test/M0_RHTestnetV4.t.sol`) deploys a trivial custom hook (`CountingHook`, beforeSwap+afterSwap flags), initializes a pool on the *real* PoolManager, adds liquidity, executes a swap: hook fired exactly once per callback, swap output 0.99699e18 for 1e18 in (≈0.3% fee — correct). **3/3 tests pass** against a live fork of `https://rpc.testnet.chain.robinhood.com`.
- **M0-3 ✅ USDG mechanics — VERIFIED** (via docs.paxos.com + live RPC + fork test assertions):
  - Testnet token: `0x7E955252E15c84f5768B83c41a71F9eba181802F` (EIP-1967 proxy), supply control `0x4549bb98c667aAb626627C118102c28065E8f54C`.
  - name "Global Dollar", symbol "USDG", **decimals = 6** (⚠ propagate: all USDG amounts in contracts/runtime are 6-decimals).
  - **EIP-3009 supported**: `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` returns the canonical `0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267`; `DOMAIN_SEPARATOR()` set. x402 settlement viable.
- **M0-1 🟡 Nautilus KMS (Marlin Oyster, D5).** Docs confirm the load-bearing property: Image variant defines an application as (enclave measurement, user data), so `(codeHash, agentId)` binds keys — same keys on any redeploy by anyone (permissionless revival), different keys for modified code or different agentId. Deploys are wallet-only (USDC + ETH on Arbitrum One), no account. Empirical kill/redeploy drill ready: `runtime/spikes/m0-marlin-kms/RUNBOOK.md` (asserts all three derivation cases; pins live rental pricing; probes disk persistence). Awaits wallet funding.
- **M0-4 🟡 x402 inference (D8).** Verified live: a pay-per-call x402 inference market exists on Base — no accounts, no API keys, wallet = identity (DeepSeek-V4-Flash at ~$0.10/1M tokens; BlockRun 100+ models pay-per-call; multiple independent operators for the N≥3 allowlist requirement). Remaining evidence: paid e2e inference calls against ≥2 allowlisted endpoints from a throwaway wallet. Awaits wallet funding.

## In progress / next steps
- Juan funds ONE throwaway wallet Claude generates: ~$5 USDC on **Base** (M0-4 x402 inference calls) + ~$5 USDC and 0.005 ETH on **Arbitrum One** (M0-1 Marlin KMS drill), with explicit OK to spend. No accounts, cards or KYC anywhere.
- Claude: run M0-1 per `runtime/spikes/m0-marlin-kms/RUNBOOK.md`; run M0-4 paid calls against ≥2 allowlisted x402 endpoints; write evidence here; close M0.
- Design follow-ups queued for M2: in-enclave TLS/cert flow for chat ingress on Oyster (03 §5); x402 endpoint allowlist curation process (06 §1).
- Start M1 (contracts, per 02-CONTRACTS.md; study PONS repo first). M1 depends on none of the above.

## Blocked on Juan
- Fund the drill wallet `0x6930FD5C95a2D9d80F3d165597d55843e8A00154` (key in local-only `.secrets/`, gitignored): ~$5 USDC on **Base** + ~$5 USDC and 0.005 ETH on **Arbitrum One**; spend approval already implicit in funding, Claude will confirm before first spend.

## Known issues / debt
- `contracts/lib/` (forge-std, v4-core, v4-periphery) is not committed — run `forge install uniswap/v4-core uniswap/v4-periphery` per `contracts/README.md`; commit hashes used for the green run are pinned there.
- M0 fork tests hit the public RPC; fine for now, get a dedicated RPC key by M1 (06 §runbook).
- Repo has git initialized but no commits yet.

## Decisions made this session (mirrored to 00 decision log)
- **D8 (Juan, 2026-09-22):** decentralized x402 inference — agents pay N≥3 independent x402 endpoints directly (USDC on Base, per call); DeepSeek-V4-Flash default thinking model, other open models open to future discussion; no accounts/card/KYC/intermediary anywhere in the inference pipeline. Mirrored into 00 §3 D8.
- **Standing constraint (Juan):** the whole agent pipeline must run with no card and no KYC — maximum decentralization.
- **D5 (Juan, 2026-09-22):** hosting = **Marlin Oyster** — wallet-based USDC rentals on Arbitrum One; Nautilus KMS Image variant provides the (codeHash, agentId) key binding; upgrade authority = renounced or Nautilus Contract variant behind public timelock (pick before mainnet). Mirrored into 00 §3 D5.
- CLAUDE.md added at repo root: response style + Fable/Opus/Sonnet delegation policy for all future sessions.

## Evidence links (test runs, tx hashes, attestation refs)
- Fork test suite: `contracts/test/M0_RHTestnetV4.t.sol` — `forge test` 2026-09-22: 3 passed / 0 failed (chainid assert 46630; hook counters 1/1; swap out 996990060009101709 wei; USDG decimals/typehash asserts). Toolchain: Foundry 1.8.3, solc 0.8.26, evm cancun. Dep commits pinned in `contracts/README.md`.
- RPC checks 2026-09-22 against `https://rpc.testnet.chain.robinhood.com`: `eth_chainId` → 0xb626 (46630); block ≈ 0x7500e2d; PoolManager code present (24,009 bytes, sha256 `6eb21c69…585b`); USDG `name/symbol/decimals/DOMAIN_SEPARATOR/TRANSFER_WITH_AUTHORIZATION_TYPEHASH` eth_calls as above.
- Sources: developers.uniswap.org/docs/protocols/v4/deployments · docs.paxos.com/guides/stablecoin/usdg/testnet · docs.marlin.org/oyster (quickstart + nautilus).
