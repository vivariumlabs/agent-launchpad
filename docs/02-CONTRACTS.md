# 02 — SMART CONTRACTS

> Foundry project in `contracts/`. Solidity ^0.8.24. Target: Robinhood Chain testnet (46630) first, mainnet (4663) after audit. Guiding rule: **fork audited patterns, minimize original code.** The custom surface is: FeeSplitHook, RoyaltyDistributor, AgentNFT, AgentRegistry, TreasuryBuyback, AgentFactory. Everything else (ERC-20, ERC-721 base, curve math) comes from OpenZeppelin + the PONS V2 pattern (github.com/ponsdotdev/pons-labs — study it in the first contracts session; adapt, credit, respect license).

Pre-build verification checklist (first contracts session):
- [ ] Confirm Uniswap v4 PoolManager address on RH testnet + mainnet (PONS graduates into v4, so it exists; find the canonical deployment).
- [ ] Confirm USDG address on both networks, and its decimals.
- [ ] Read PONS V1/V2 contracts + license.
- [ ] Confirm whether v4 hook fee-taking via `beforeSwap`/`afterSwap` deltas works as expected on this deployment (write a fork test on day one).

---

## 1. Contract inventory

| Contract | Type | Custody/admin |
|----------|------|---------------|
| `AgentFactory` | Singleton | Owner = platform multisig; owner can pause new creations only. Existing agents are never pausable. |
| `AgentToken` | Per-agent ERC-20 | None. Fixed supply minted to curve at creation. |
| `AgentBondingCurve` | Per-agent (clone) | None after init. Immutable params. |
| `FeeSplitHook` | Singleton v4 hook (all agent pools share it) | None after deploy. Immutable addresses. |
| `RoyaltyDistributor` | Singleton | None. Pure accounting. |
| `AgentNFT` | Singleton ERC-721 | Minting only by factory. |
| `AgentRegistry` | Singleton | None after deploy. Rules are immutable. |
| `TreasuryBuyback` | Singleton | Owner = platform multisig for parameter tuning ONLY (poke cap, reward). Cannot withdraw. |

Platform multisig: 2-of-3 Safe `DEFAULT` (Juan × 2 devices + 1 backup signer Juan controls). Its powers are deliberately tiny: pause *new* launches, tune buyback params. Document every power publicly.

## 2. AgentFactory

```solidity
function createAgent(
    string  name,          // token + agent name
    string  symbol,
    string  imageURI,      // pre-uploaded to Arweave by the website
    bytes32 configHash,    // keccak of the full agent config (persona, model list, archetype) — the config itself goes to the genesis service off-chain and to Arweave
    address creator
) external payable returns (uint256 agentId);
```

Flow (two-phase, because the agent's wallets don't exist until the TEE boots):
1. `createAgent` — collects creation fee (75 USDG `DEFAULT` via ERC-20 pull, plus small ETH for deploy gas), stores a `PendingAgent`, emits `AgentRequested(agentId, configHash, creator)`. **Nothing tradable exists yet.**
2. Genesis orchestrator (04) boots the CVM; the enclave calls `AgentRegistry.registerInstance(agentId, treasuryEOA, actionEOA, codeHash, attestationRef)`.
3. Anyone (in practice the orchestrator) then calls `factory.finalize(agentId)`, which requires a registered instance and: deploys `AgentToken` (full supply → curve), deploys curve clone with `feeRecipients = (treasuryBuyback, agentTreasuryEOA, royaltyDistributor)`, mints `AgentNFT#agentId` to creator, emits `AgentLive`.
4. Timeout path: if no instance registers within 24 h `DEFAULT`, creator can `cancel(agentId)` and reclaim the fee minus gas costs already spent.

## 3. Fee mechanics

### Curve phase
`AgentBondingCurve`: constant-product vs USDG (PONS V2 pattern). Every buy/sell takes 3% of the USDG side, transferring 1% each to the three recipients immediately. Simple, no accrual needed.

### Pool phase — `FeeSplitHook` (the hard contract; test it to death)
- Registered on every agent pool at graduation. Pools are AGENT/USDG, full-range LP owned by a locker contract, LP NFT non-withdrawable (liquidity locked forever; fees on the LP position itself also route through the split — decide during build whether LP-fee tier is set to 0 and ALL fee-taking happens in the hook, which is cleaner: **recommended: pool fee = 0, hook takes 3%**).
- Implementation approach: `beforeSwap` returns a hook delta taking 3% of the *specified* amount; collected amounts accrue inside the hook per-pool, in both tokens.
- `distribute(poolId)` (permissionless, called by keepers/agents/anyone): converts accrued AGENT-side fees to USDG via the same pool (with slippage bound), then pushes thirds: TreasuryBuyback, the agent's treasury EOA (looked up live from `AgentRegistry` — NOT stored, so revival/re-registration keeps fees flowing to the right wallet), RoyaltyDistributor credit.
- Must handle: reentrancy (v4 lock model helps), tiny-amount rounding (accumulate, don't revert), the AGENT→USDG conversion moving the price (cap conversion size per call).
- Fork-test against the real PoolManager on testnet before writing anything else.

## 4. RoyaltyDistributor

- `credit(agentId, amount)` — only callable by hook/curve. Adds to `accrued[agentId]`.
- `claim(agentId)` — pays `accrued` to `AgentNFT.ownerOf(agentId)`. Pull-based only.
- On NFT burn: `AgentNFT` calls `distributor.onBurn(agentId)`; from then on `credit()` forwards directly to the agent treasury EOA (live registry lookup), and any unclaimed balance is swept to the agent. Emits `Emancipated(agentId)`.

## 5. AgentNFT

ERC-721 (OZ base). `mint` by factory only. `burn(tokenId)` by owner only → irreversible, triggers `onBurn` above. `tokenURI` → Arweave metadata written at genesis. No other logic. **No admin functions.**

## 6. AgentRegistry (identity, liveness, single-instance lock)

```solidity
struct AgentInstance {
    address treasuryEOA;
    address actionEOA;
    bytes32 codeHash;       // expected runtime measurement
    string  attestationRef; // Arweave txid of the attestation quote + verification report
    uint64  lastHeartbeat;
    uint32  generation;     // increments on each revival
}
```

- `registerInstance(agentId, ...)` — first registration: only during a pending-genesis window for that agentId. Re-registration (revival): allowed **only if** `block.timestamp - lastHeartbeat > REVIVAL_WINDOW` (7 days `DEFAULT`). This is the single-instance lock: a live agent heartbeating cannot be displaced.
- `heartbeat(agentId)` — must be sent from the registered `treasuryEOA`. Agents send it every pulse-tier interval (≤ 24h even when Dormant).
- `codeHash` verification: v1 pragmatic model — the registry stores the claimed measurement and the Arweave attestation reference; **verification is done off-chain** by the website's attestation page and by anyone independently (TDX quotes are publicly verifiable). On-chain attestation verification is v2 (Automata-style verifier contracts exist if wanted later). Document this trust boundary honestly.
- Registry is the source of truth for "where do this agent's fees go" (hook reads it) — which is what makes revival seamless: same code hash ⇒ same KMS-derived EOAs ⇒ re-registration restores the same addresses.

## 7. TreasuryBuyback

- Receives USDG (hook leg + swept PONS creator earnings).
- `poke()` — permissionless: swaps up to `maxPerPoke` (2,000 USDG `DEFAULT`) for $TOKEN in the PONS pool, reverts if execution price deviates > 5% `DEFAULT` from a short TWAP, burns the $TOKEN, pays caller reward (0.3% of swap, capped `DEFAULT`), cooldown 1 h `DEFAULT`.
- Multisig can tune caps/reward/cooldown within hardcoded bounds; **no withdrawal function exists**.

## 8. Testing requirements (gate for milestone completion)

- Unit tests for every contract; fork tests against RH testnet for anything touching v4 or PONS pools.
- Invariant/fuzz suites: (a) sum of fee legs == 3% of volume, always; (b) no path moves treasury/royalty funds to any address outside the three recipients; (c) single-instance lock cannot be bypassed while heartbeats are fresh; (d) burn re-route is one-way.
- An injection-style adversarial suite: attacker-controlled agent EOAs, attacker calling `distribute`/`poke`/`registerInstance` in hostile orders.
- Gas snapshots per swap (hook overhead must stay reasonable — target < 120k added gas, measure and record).
- External audit before mainnet launch (06). Non-negotiable given Juan cannot review code.
