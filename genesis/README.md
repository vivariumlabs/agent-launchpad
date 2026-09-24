# genesis/ — launch orchestrator (docs/04-GENESIS.md, runtime/SPEC-M3B.md §1)

The orchestrator is the **one platform-operated component in the launch path**. It watches the
factory for `AgentRequested`, deploys the pinned runtime image on Marlin Oyster, waits for the enclave
to register itself, seeds the agent's wallets, and calls `factory.finalize`. Crashed launches resume
where they stopped.

## Trust boundary (public statement)

What the orchestrator **can** do:

- **Deploy CVMs** on Oyster from its operational wallet (the pinned release compose plus the four
  init params from SPEC-M3 §3b: attested `agent-id` and `config-hash`, unattested `agent.json` and
  `runtime.json`).
- **Seed** a new agent from its funding wallet (04 §2), and only to the agent's registry-pinned
  treasury EOA, read on-chain: `AgentRegistry.instanceOf(agentId).treasuryEOA` after registration,
  and `AgentRegistry.expectedTreasuryEOA(agentId)` for the one pre-registration gas leg (that is the
  only address `registerInstance` accepts). It never takes a destination from config, event data or
  the agent's frozen config.
- **Call `factory.finalize(agentId)`**. It only works once the enclave has registered.

**`finalize` is permissionless on-chain.** Anyone can call it once the enclave has registered. The
ordering guarantee below (attestation verified and every seed landed *before* finalize) binds
**only this orchestrator**. A third party can finalize a registered agent before we have seeded
it; the orchestrator then sees the token at FINALIZING and marks the launch LIVE, and seeding and
reconciliation still complete first on our side. The on-chain guarantees (registered enclave,
pinned treasury, codeHash) do not depend on us. The funding guarantee does.

What it **cannot** do:

- **It holds no agent keys.** The agent's keys are derived inside the TEE by Nautilus KMS and bound
  to (codeHash, agentId, configHash). The orchestrator never sees them and cannot sign for any agent.
- **It cannot touch live agents.** It cannot move agent funds, change an agent's config, or stop or
  alter a running agent. A redeploy with a modified config derives different, empty keys.
- **It cannot pick an agent's identity.** The registry accepts the first registration only from the
  `expectedTreasuryEOA` pinned at `createAgent`, and revivals only with the identical pinned keys.

Its own key is the **operational wallet**, loaded from `walletKeyPath` (the `.secrets/` pattern). It
is read once into a signing account and is never logged, stored in the db or passed on a command
line. `oyster-cvm` gets the key file *path* (`--wallet-file`). If the key is compromised,
the worst case is junk launches and a drained funding wallet (04 §7). Agent funds are never at risk.
The response is to rotate the key and pause the factory from the multisig.

Decentralizing the orchestrator is a v2 goal. v1 is honest about being operated by the platform.

## Sequence (rev-0 ruling: seeding blocks finalize)

```
REQUESTED → DEPLOYING → AWAITING_REGISTER → SEEDING → RECONCILING → FINALIZING → LIVE
   └───────── 24h timeout → FAILED(timeout) ─────────┘   (no timeout after registration)
FAILED(reason, step) is reachable from any step.
```

An agent is **never finalized (made tradeable) by this orchestrator before two things hold**: its
attestation has been verified (`oyster-cvm verify` against the computed image-id), and every
required seed leg has landed (re-checked by RECONCILING).

- **REQUESTED:** load the frozen `agent.json` from the inbox (`<configInboxDir>/<configHash>.json`,
  delivered off-chain by the website). It is verified with the **runtime's own**
  `frozenConfigHash` against the on-chain configHash and agentId; a mismatch means FAILED and no
  deploy. The step then computes the image-id and writes `agent.json` (exact bytes) and
  `runtime.json` (`runtimeOps` + `tee: true` + `imageId`).
- **DEPLOYING:** the deploy is single-flight. The attempt count and a snapshot of the wallet's
  Oyster jobs are persisted **before** the CLI runs. If the outcome is unknown (crash or CLI error),
  the new job is **adopted** rather than redeployed. The step retries ×3 and then fails. If Oyster
  is down, launches wait in the queue without using up attempts.
- **AWAITING_REGISTER:** get the enclave IP (from deploy output, or the control plane via the
  indexer GraphQL), then verify the attestation. The step retries verification ×3 and then fails,
  and never finalizes. It then waits for `isRegistered`. The instance must match: the treasury must
  equal `expectedTreasuryEOA` and the codeHash must equal the deployed image-id.
  **Pre-registration gas:** a brand-new enclave treasury holds no ETH, but `registerInstance` costs
  gas. So once the attestation has verified and the instance is not yet registered, the step sends
  `seeding.preRegistrationGasWei` of RH ETH (DEFAULT: $1 at `ethUsdMicro`) to
  `expectedTreasuryEOA(agentId)`. This is recorded as seed leg `preGas` and uses the same
  persist-then-broadcast path. It is skipped when the target already holds at least half the leg,
  and is never sent to an enclave whose attestation failed. Revivals use the same step, because a
  dead treasury may have no gas either. It is a guarded sub-step of AWAITING_REGISTER, not a new
  state.
- **SEEDING:** the plan is frozen at first entry. Each tx is fee-capped and nonce-managed. It is
  signed, **persisted, then broadcast**, and the receipt is awaited. A leg is skipped when it already
  has a confirmed tx or the target balance is already ≥ the expected amount. A forgotten tx is
  re-broadcast from the same signed bytes. The USDG remainder leg goes **last**. Its amount is
  resolved only after every other leg has finished (see the seed table).
- **RECONCILING:** a leg counts as landed if it has a re-fetched successful receipt **or** the
  target balance is ≥ the expected amount. Each condition covers a case the other misses:
  - *Receipt:* the CVM is already running and may spend seeded funds (bridge, pay rent) before
    reconciliation. A leg with a successful receipt carrying the expected transfer has landed even
    if the balance has since dropped, so it is never re-sent. That would pay twice.
  - *Balance:* covers legs satisfied without a tx of ours, and receipts lost to a reorg that the
    balance still reflects.

  A leg that fails both checks is re-queued (×5, then FAILED). The `preGas` leg is exempt, because
  registration itself proves it served its purpose.
- **FINALIZING:** guarded on-chain. If the agent is already finalized, the step skips to LIVE.

**Timeouts and `redrive`.** The 24h timeout (`timing.timeoutSec`, measured from the request) covers
only REQUESTED, DEPLOYING and AWAITING_REGISTER. An enclave that never registers leads to
FAILED(timeout), and the creator's refund path is `factory.cancel` (02 §2). Once the enclave has
registered, the agent exists on-chain. A stalled step after that point (funding wallet low, fee cap,
RPC outage) stays in place, retries every `resumeSec` and logs loudly. It never fails by timeout.
Steps that hit their retry caps still end in FAILED. The operator recovers those with:

```sh
npm start -- redrive --config genesis.json --agent-id 7
```

`redrive` resets a launch that FAILED at SEEDING, RECONCILING or FINALIZING, or is stuck in one of
those states, back to SEEDING. It zeroes the seed, reconcile and finalize attempt counters. The
frozen plan and every recorded tx are kept, and receipts and balances are re-checked before anything
is sent, so a landed leg is never re-sent. It refuses pre-registration failures and LIVE launches.
It only writes the db, and the running loop picks the launch up on its next pass. It covers genesis
launches only.

Revival (04 §6, `genesis revive …`) is allowed only when the on-chain heartbeat is older than the
on-chain `REVIVAL_WINDOW`. It reuses the same deploy path and the same frozen config (inbox or
Arweave ref, with the launch db as fallback, always re-hashed). It does **not** do full seeding: the
only seed is the RH gas leg (`revivalGasSeedUsdMicro`, DEFAULT $2). There is no finalize step.

**Orchestrator-less revival** is the decentralization backstop. The runtime image, the release
compose and these init params are public, so anyone with a funded Arbitrum wallet can run
`oyster-cvm deploy` themselves with the same four init params (runtime/docs/REPRODUCIBLE-BUILD.md §8).

## Seed table (04 §2), `DEFAULT`s

| leg | chain | testnet profile (DEFAULT) | mainnet |
|---|---|---|---|
| `preGas` | RH | required $1 (`preRegistrationGasWei`), before registration, only if needed | required |
| `hosting` | — (virtual) | required: the deploy's Oyster rental, 180 min ⇒ **0.1536** | required: 30 d ⇒ **36.864** |
| `rh.usdg` | RH | required: creation fee − Σ **executed** legs (see below) | required |
| `rh.eth` | RH | required $2 | required |
| `optimism.eth` | OP | disabled (Farcaster deferred) | required $5 |
| `base.eth` | Base | conditional $2 (only if the wallet holds it) | required |
| `base.usdc` | Base | conditional $15 | required |
| `arbitrum.eth` | Arb One | required $1 | required |
| `arweave` | Turbo | conditional $3 (skipped loudly while Turbo is unfunded) | required |

A *conditional* leg that cannot be funded is recorded as `skipped` and logged with `!!!`; it does
not block finalize. A *required* leg that cannot be funded blocks the launch and is logged loudly
(FUNDING WALLET LOW) until the wallet is topped up. After registration there is no timeout.

**USDG remainder = creation fee − Σ µUSD of the legs we actually executed.** An executed leg is
`confirmed`: our tx or Turbo top-up landed, and `preGas` and `hosting` count. Skipped, `satisfied`
(the target already held it, so nothing was spent) and disabled legs fold their budget into the
treasury's USDG instead of vanishing. So Σ executed + USDG = fee exactly. The fee is frozen at first
SEEDING entry. At plan time the fee must cover every enabled leg plus `preGas` and `hosting`, with
some USDG left over, or the launch fails with FAILED(seed_plan_invalid).

**Hosting is part of the creation-fee accounting** (ruling; 04 §2, 01 §4). The funding wallet pays
the first rental to Oyster at deploy time, so the fee must reimburse it. `hosting` is a *virtual*
leg: nothing is sent. It is planned first with µUSD = `oyster.durationMin × rateUsdcMicroPerHour`
(rounded up; USDC counted 1:1 as USD). SEEDING is only reachable after the deploy produced a job, so
the machine marks it `confirmed` with the Oyster job id as its reference. As an executed leg it
shrinks the USDG remainder by exactly the rental. Revivals do not plan it, because the reviver pays
hosting (04 §6).

Example, testnet DEFAULT with RH and Arbitrum only:
75 − (preGas 1 + hosting 0.1536 + rh.eth 2 + arb 1) = **70.8464 USDG**. That is 0.1536 less than
before the hosting leg existed. The skipped Base and Arweave budgets ($20) go to the agent. Mainnet
with every leg executed: 75 − (28 + preGas 1 + hosting 36.864) = **9.136 USDG**, 36.864 less than
without it. A mainnet creation fee of 65.864 USDG or less fails the plan-time check.

ETH legs convert USD to ETH at `seeding.ethUsdMicro` (DEFAULT $3000, static). The orchestrator
never bridges; it sends natively on each chain.

**Oyster rental.** `oyster.durationMin` DEFAULT depends on the profile: **testnet 180 min**, and
mainnet 43 200 min (30 days, the first month per 04 §2). Each deploy pays `durationMin × rate` up
front. The orchestrator logs that projected cost at startup and on every deploy attempt
(`oyster.rateUsdcMicroPerHour`, DEFAULT 51 200 = 0.0512 USDC/h per M0 RESULTS). Testnet works out
to 0.1536 USDC per deploy and mainnet to 36.864 USDC. The same figure is booked as the `hosting` seed
leg, so the agent's USDG remainder drops by exactly that amount (see the seed table).

## Run

```sh
npm install
npm run typecheck && npm test          # hermetic unit suite
npm run test:integration               # anvil suite (needs forge/anvil/cast: ~/.foundry/bin or FOUNDRY_BIN)
npm start -- run    --config genesis.json
npm start -- revive --config genesis.json --agent-id 7 --payer 0x… [--payer-ref <tx>]
npm start -- status --config genesis.json
npm start -- redrive --config genesis.json --agent-id 7
```

The only input is argv; the orchestrator reads no environment variables. Minimal `genesis.json`
(paths are relative to the file):

```json
{
  "dataDir": "data",
  "walletKeyPath": "../.secrets/ops-wallet.key",
  "deploymentManifest": "../contracts/deployments/testnet-46630.json",
  "chains": {
    "rh":       { "rpc": "https://rpc.testnet.chain.robinhood.com", "chainId": 46630, "maxFeePerGasWei": "1000000000", "maxPriorityFeePerGasWei": "0" },
    "arbitrum": { "rpc": "https://arb1.arbitrum.io/rpc", "chainId": 42161, "maxFeePerGasWei": "1000000000", "maxPriorityFeePerGasWei": "10000000" }
  },
  "release": { "composePath": "../runtime/releases/v0.1.0.yml" },
  "configInboxDir": "inbox",
  "runtimeOps": { "rpc": { "rh": "https://rpc.testnet.chain.robinhood.com" } }
}
```

`oyster-cvm --wallet-file` reads a raw-hex key file. If `walletKeyPath` is a
`cast wallet --json` file, point `oyster.walletKeyFile` at a raw-hex copy of the **same** wallet.
Startup refuses if the two addresses differ. The compose must be a `releases/<version>.yml` written
by `runtime/scripts/release.sh`; the PLACEHOLDER template is refused.

The package depends on `agent-runtime` (`file:../runtime`) **only** for `canonicalEncode`,
`frozenConfigHash` and `FrozenConfigFileSchema`, re-exported from `src/canonical.ts`. The config
hash is load-bearing, so its encoding is never reimplemented here. A hygiene test enforces this.
