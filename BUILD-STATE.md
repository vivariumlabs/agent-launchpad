# BUILD STATE — updated 2026-09-22

## Milestone: M0 — **CLOSED, all four load-bearing assumptions verified with live evidence.** Next: M1 (contracts).

## Done
- Repo scaffolded per 00 §5: `contracts/`, `runtime/`, `genesis/`, `web/`, `indexer/`, `docs/`. Git initialized.
- **M0-2 ✅ Uniswap v4 on RH testnet — VERIFIED.** PoolManager live at `0x8366a39CC670B4001A1121B8F6A443A643e40951` on testnet 46630 (same deterministic address as the mainnet deployment listed on Uniswap's official deployments page). Fork test (`contracts/test/M0_RHTestnetV4.t.sol`) deploys a trivial custom hook (`CountingHook`, beforeSwap+afterSwap flags), initializes a pool on the *real* PoolManager, adds liquidity, executes a swap: hook fired exactly once per callback, swap output 0.99699e18 for 1e18 in (≈0.3% fee — correct). **3/3 tests pass** against a live fork of `https://rpc.testnet.chain.robinhood.com`.
- **M0-3 ✅ USDG mechanics — VERIFIED** (via docs.paxos.com + live RPC + fork test assertions):
  - Testnet token: `0x7E955252E15c84f5768B83c41a71F9eba181802F` (EIP-1967 proxy), supply control `0x4549bb98c667aAb626627C118102c28065E8f54C`.
  - name "Global Dollar", symbol "USDG", **decimals = 6** (⚠ propagate: all USDG amounts in contracts/runtime are 6-decimals).
  - **EIP-3009 supported**: `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` returns the canonical `0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267`; `DOMAIN_SEPARATOR()` set. x402 settlement viable.
- **M0-1 ✅ Nautilus KMS (Marlin Oyster, D5) — VERIFIED EMPIRICALLY.** Five live enclave deployments on Arbitrum One (wallet-only, no account): same image + same agent-id ⇒ **same derived key across three instances, including one deployed after the others died** (kill/redeploy passes); modified compose ⇒ different key; different agent-id (attested init param) ⇒ different key. Remote attestation verified against the offline-computed image-id; `kms-derive` predicts per-image addresses publicly with no deployment. Pricing pinned: 0.0512 USDC/hr small arm64 ≈ $37/mo. Full table + hashes + gotchas: `runtime/spikes/m0-marlin-kms/RESULTS.md`.
- **M0-4 ✅ x402 inference (D8) — VERIFIED EMPIRICALLY.** Two paid end-to-end inference calls from the drill wallet against **two independent x402 operators** on Base: OpenRelay (`deepseek-ai/DeepSeek-V4-Flash-0731`, $0.001/call) settlement tx `0x9373bb0b…3636`, AiSpace ($0.01/call) tx `0x40d4f6fa…8dd4` — both status 0x1, block ~51641300. No accounts, no keys; x402 v2 via `@x402/fetch` + `ExactEvmScheme` (gasless EIP-3009). Discovery works: CDP x402 Bazaar lists 800+ endpoints incl. several chat-completions operators (also found: rubric-protocol.com attested-inference — candidate for the attested-endpoint preference). ⚠ Live demo of the model-identity risk: OpenRelay's DeepSeek reply self-identified as a Gemini model — self-ID is unreliable in general, but this is exactly why 06 §4 carries the "endpoint serves degraded/wrong model" risk and the runtime needs output sanity checks.

## In progress / next steps
- **Start M1** (contracts, per 02-CONTRACTS.md): study PONS repo (github.com/ponsdotdev/pons-labs), then FeeSplitHook / AgentFactory / AgentNFT / RoyaltyDistributor / AgentRegistry / TreasuryBuyback with full tests on the RH-testnet fork (M0 fork-test scaffold already in `contracts/`).
- Design follow-ups queued for M2: in-enclave TLS/cert flow for chat ingress on Oyster (03 §5); derive-server retry-at-boot pattern (RESULTS.md gotcha); x402 endpoint allowlist curation (06 §1); output sanity checks for model identity.
- Drill wallet `0x6930FD5C95a2D9d80F3d165597d55843e8A00154` (key local-only in gitignored `.secrets/`) holds ~$4.99 USDC (Base) + ~$4.6 USDC (Arbitrum) + gas dust — reusable for M1/M3 ops.

## Blocked on Juan
- Nothing. (Next Juan items arrive with M1: platform multisig, deployer wallet, RPC key — 06 §1.)

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
- M0-1 evidence: `runtime/spikes/m0-marlin-kms/RESULTS.md` (jobs 0x…3196–0x…319a on Arbitrum One, image-ids, key hashes, attestation ✓, pricing).
- M0-4 evidence: Base settlement txs `0x9373bb0b47e5e9ad487942f2b44e635cbef76bde63c6c578635bd51f98653636` (OpenRelay/DeepSeek-V4-Flash) and `0x40d4f6fad63b582195caae1ac394835d5975644b3a426b65b5a2020b5c428dd4` (AiSpace), both status 0x1; total M0 drill spend ≈ $0.42 + gas dust.
- Sources: developers.uniswap.org/docs/protocols/v4/deployments · docs.paxos.com/guides/stablecoin/usdg/testnet · docs.marlin.org/oyster (quickstart, nautilus, persistent-keys) · CDP x402 Bazaar discovery API.
