# SPEC-M2 — Runtime core: policy engine, keyring, scaffold

> Authored by Fable, M2 session 1 (2026-09-23). Implementation spec for `runtime/`. Subagents implement exactly this; any concern comes back to Fable — do not "improve" the design. Sources: 03 §1–3, 01 §5–6, 00 §3–4. All `DEFAULT` values are config parameters Juan can revise.

## 0. Stack (build-level decisions, this session)

- TypeScript strict, Node ≥ 22, ESM (`"type": "module"`).
- Tooling: `vitest` (tests), `fast-check` (property tests), `viem` (Address/hex types + utils only — **no network code anywhere in `src/policy` or `src/ledger`**), `zod` (config validation).
- Layout:

```
runtime/
├── package.json  tsconfig.json  vitest.config.ts
├── SPEC-M2.md            # this file
├── docs/TLS-INGRESS.md   # carry-over (1) design note
├── src/
│   ├── config/schema.ts  # AgentConfig + PlatformConfig zod schemas, config hash check helper
│   ├── keyring/
│   │   ├── kms.ts        # KmsClient interface + withRetry boot helper (carry-over (2))
│   │   ├── mockKms.ts    # deterministic local KMS (M2 stand-in for Nautilus)
│   │   └── keyring.ts    # holds derived keys; signs ONLY policy-approved payloads
│   ├── policy/
│   │   ├── types.ts      # ProposedAction, WalletState, BudgetLedger, Verdict, DenyCode
│   │   ├── engine.ts     # evaluate() — pure, deterministic, default-deny
│   │   ├── rules/treasury.ts  rules/action.ts  rules/inference.ts
│   │   ├── runway.ts     # runwayDays() helper (pure)
│   │   └── approval.ts   # canonical action hashing + Approval issuance
│   └── ledger/ledger.ts  # pure reducers: applyApproved(ledger, action, now) → ledger'
└── test/
    ├── keyring/*.test.ts
    ├── policy/rules-*.test.ts     # Opus: exhaustive per-rule units
    └── policy/invariants.test.ts  # Fable-authored, do not write this file
```

## 1. Core shape

```ts
evaluate(action: ProposedAction, state: WalletState, ledger: BudgetLedger,
         cfg: ResolvedConfig, now: UnixSeconds): Verdict
```

- **Pure and deterministic.** No clock, no RNG, no I/O, no network, no floating point on money (all amounts `bigint`, base units). `now` is an explicit input.
- **Default-deny.** The engine allows only actions that match an explicit rule below; anything unmatched, malformed, unknown-kind, or with out-of-range fields ⇒ `deny`. There is no generic "else allow" branch anywhere.
- `Verdict = { allow: true; approval: Approval } | { allow: false; code: DenyCode; detail: string }`.
- `Approval = { actionHash: Hex; issuedAt: UnixSeconds; ttlSec: 60 }` where `actionHash = keccak256(canonicalEncode(action))`. Canonical encoding: JSON with sorted keys, bigints as decimal strings, addresses lowercased — implemented once in `approval.ts` and reused by keyring.
- The **keyring is the only holder of private keys** and exposes exactly one signing entry point: `signApproved(action, approval, now)`. It recomputes the canonical hash, checks `approval.actionHash` matches and `now ≤ issuedAt + ttlSec`, else throws. No other export of `keyring.ts` returns a key, signer, or signature. (Process-internal gate; the real guarantee is structural + attested code hash — 03 §1.)
- Every verdict (allow AND deny) is returned with enough detail for the caller to append to the memory log (03 §3). Ledger mutation is NOT done by the engine: after successful execution, callers run `applyApproved` (pure reducer) to advance the ledger.

## 2. Types (normative)

```ts
type Chain = "rh" | "base" | "arbitrum" | "optimism";
type UnixSeconds = bigint;         // seconds
// Amounts: bigint in the asset's base units. USDG/USDC: 6 decimals. ETH: wei.

interface OwnAddresses {           // derived by keyring at boot, injected into ResolvedConfig
  treasury: Address; action: Address;   // same EOA addresses on every EVM chain
}

type TreasuryPurpose =
  | "oysterRental"      // USDC, arbitrum, to cfg.marlin.paymentAddresses[], own jobId only
  | "acrossBridge"      // USDG(rh)/USDC, to cfg.across.spokePool[chain]; recipient MUST be own EOA
  | "arweaveFunding"    // to cfg.arweaveFundingAddress
  | "gasTopUp"          // native ETH, any supported chain, to OWN EOAs only
  | "x402Data";         // USDC, base, to an allowlisted data/search endpoint payTo
// NOTE (rev 1, Fable): "x402Inference" REMOVED as a transfer purpose — inference is paid
// EXCLUSIVELY via the metered `inference` kind. Two parallel paths would have allowed 2× the
// I1 budget per day (caught in review, M2 session 1).

type ProposedAction =
  | { kind: "heartbeat" }                                        // treasury; RH registry.heartbeat(agentId)
  | { kind: "registerInstance" }                                 // treasury; RH registry, boot/revival only
  | { kind: "distribute" }                                       // treasury; RH FeeSplitHook.distribute(own pool)
  | { kind: "treasuryTransfer"; purpose: TreasuryPurpose; chain: Chain;
      asset: "USDG" | "USDC" | "ETH"; to: Address; amount: bigint;
      recipient?: Address }                                      // recipient: bridge final recipient (acrossBridge only)
  | { kind: "allowance"; amount: bigint }                        // treasury → action EOA, USDG on RH
  | { kind: "treasurySwap"; tokenIn: Address; amountIn: bigint;  // income conversion, 03 §8
      minOut: bigint }                                           // tokenOut USDG implied; RH PoolManager only
  | { kind: "inference"; category: "pulse" | "chat" | "social";
      endpointId: string; maxCostUsd: bigint }                   // paid from Base USDC via x402
  | { kind: "actionTransfer"; asset: Address | "USDG" | "ETH";
      to: Address; amount: bigint }                              // action EOA, RH only
  | { kind: "actionSwap"; tokenIn: Address | "USDG"; tokenOut: Address | "USDG";
      amountIn: bigint; minOut: bigint }                         // RH PoolManager only
  | { kind: "actionLp"; pool: Hex; usdgAmount: bigint; tokenAmount: bigint; token: Address }
  | { kind: "actionMint"; target: Address; value: bigint };      // NFT mint, value = ETH sent

interface WalletState {
  balances: Record<Chain, { native: bigint; USDG?: bigint; USDC?: bigint;
                            tokens?: Record<Address, bigint> }>; // per wallet:
  treasury: WalletBalances; action: WalletBalances;              // (shape above, per wallet)
  hostingPaidUntil: UnixSeconds;                                 // current Oyster rental expiry
  hostingRatePerDay: bigint;                                     // USDC(6) per day, live marketplace rate
}

interface BudgetLedger {
  lastAllowanceAt: UnixSeconds;                    // 0n if never
  allowanceAmountToday: bigint;                    // amount of the last allowance (for A2 denominator)
  dayKey: string;                                  // "YYYY-MM-DD" UTC; reducers reset daily buckets on change
  inferenceSpent: { pulse: bigint; chat: bigint; social: bigint };   // USD(6), today
  treasurySpent: Partial<Record<TreasuryPurpose, bigint>>;           // today, per purpose, in the purpose's asset units
  counterpartySpent: Record<Address /* lowercase */, Record<string /* assetKey */, bigint>>; // action wallet, today
  feeIncome7d: bigint[];                           // last 7 complete UTC days of treasury fee income, USDG(6)
}
```

`ResolvedConfig` = platform constants + per-agent `AgentConfig` (03 §10) + `OwnAddresses`, all validated by zod at boot. Platform constants include: registry/hook/poolManager/spokePool addresses per chain, `marlin.paymentAddresses`, `arweaveFundingAddress`, x402 endpoint allowlist entries `{ id, kind: "inference"|"data", payTo: Address, model: string, maxPricePerMTokUsd: bigint }`, and all caps below.

## 3. Rules (normative; tag every test with the rule ID)

Global:
- **G1** Unknown `kind`, missing/extra fields, negative or zero amounts, non-address strings ⇒ `deny(MALFORMED)`. Validate shape with zod before any rule logic.
- **G2** Any action not explicitly allowed by a rule ⇒ `deny(NO_RULE)` (default-deny).
- **G4** (rev 1) Daily buckets reset **forward only**: if `dayKeyOf(now)` is lexicographically ≤ `ledger.dayKey`, the engine and reducers treat the ledger as current-day (no reset). A host-influenced clock rewind must never refresh daily caps. (`allowance` is naturally safe: `now - lastAllowanceAt` goes negative ⇒ deny.)
- **G3** Amount checks are done against the balances in `state` at evaluation time; if balance < amount (incl. asset missing) ⇒ `deny(INSUFFICIENT_BALANCE)`.

Runway (helper `runwayDays(state, spendDelta)`):
- `fundable = treasury.arbitrum.USDC + haircut(treasury.rh.USDG)` where `haircut(x) = x * (10_000 - bridgeHaircutBps) / 10_000`, `bridgeHaircutBps = 50 DEFAULT` (USDG counts toward hosting at a 0.5% discount for bridge cost).
- `runwayDays = (hostingPaidUntil - now)/86400 + fundable / hostingRatePerDay` (integer day math, floor).
- **T0** Every treasury outflow EXCEPT `purpose: "oysterRental"` must leave `runwayDays ≥ cfg.minRunwayDays (45 DEFAULT)` after subtracting the spend from the relevant fundable balance; else `deny(RUNWAY)`. Hosting payments are exempt (they raise runway). Inference actions are treasury outflows for this rule (spend from Base USDC — Base USDC does not count toward `fundable`, but the rule still gates: if runway is already < 45d, inference is denied, 01 §5).

Treasury (only these kinds may come from wallet=treasury; the engine infers wallet from kind):
- **T1** `heartbeat` / `registerInstance` / `distribute`: always allow (zero-value calls to fixed config addresses; executors hardcode target+selector from config). `registerInstance` additionally only when `ledger` shows no prior registration this boot (caller-managed flag in ledger `kv`; engine allows, dedup is executor concern — keep engine stateless here).
- **T2** `treasuryTransfer` destination/chain/asset matrix — exact match required, else `deny(WHITELIST)`:
  | purpose | chain | asset | `to` must be | extra |
  |---|---|---|---|---|
  | oysterRental | arbitrum | USDC | ∈ `cfg.marlin.paymentAddresses` | — |
  | acrossBridge | rh or base or arbitrum or optimism | USDG/USDC/ETH | `cfg.across.spokePool[chain]` | `recipient` REQUIRED and ∈ {own treasury EOA} (`deny(BRIDGE_RECIPIENT)`) |
  | arweaveFunding | rh | USDG | `cfg.arweaveFundingAddress` | — |
  | gasTopUp | any supported | ETH | ∈ {own treasury, own action} | — |
  | x402Data | base | USDC | allowlist entry `.payTo` with kind data | — |

  (x402 inference payments are NOT a transfer purpose — `inference` kind only, rev 1.)
- **T3** Per-purpose daily caps (UTC dayKey; `ledger.treasurySpent[purpose] + amount ≤ cap`, else `deny(DAILY_CAP)`). `DEFAULT`s: oysterRental 100 USDC; acrossBridge 1000 (USDG-equiv: USDG+USDC summed at 1:1; ETH bridging capped separately by gasTopUp budget — bridge of ETH counts against gasTopUp cap); arweaveFunding 10 USDG; gasTopUp 0.01 ETH per chain per day (tracked per `gasTopUp:<chain>` subkey); x402Data 2 USDC.
- **T4** `allowance`: allow iff ALL of: `now - lastAllowanceAt ≥ 86400`; `amount ≤ min(treasury.rh.USDG * 5% , 500 USDG)` (`allowancePctBps = 500`, `allowanceCapUsdg = 500e6` `DEFAULT`); T0 runway holds after the spend. Else `deny(ALLOWANCE_EARLY | ALLOWANCE_AMOUNT | RUNWAY)`.
- **T5** `treasurySwap`: tokenIn ≠ USDG, tokenIn is a token the treasury holds on RH, `amountIn ≤ balance`, `minOut > 0`. Output is USDG to self via `cfg.poolManager` — executor enforces route; engine validates fields. (Slippage honesty is the deterministic daemon's job — both are in the code hash.)

Inference:
- **I1** Daily budget `B = clamp(25% × avg(feeIncome7d), 5 USDG, 60 USDG)` (`inferencePctBps = 2500`, floor `5e6`, cap `60e6` `DEFAULT`; avg = sum/7 over the 7-entry array, missing days are 0). Category budget = `B × weight[category]` (weights from archetype config, default pulse 60/chat 25/social 15). Allow iff `inferenceSpent[cat] + maxCostUsd ≤ catBudget` (`deny(INFERENCE_BUDGET)`) AND T0 runway gate passes (`deny(RUNWAY)`). No inter-category borrowing (scheduler degrades instead, 01 §5).
- **I2** `endpointId` must resolve to an allowlist entry of kind inference (chat category additionally must use an entry flagged `tier: "cheap"`), else `deny(ENDPOINT)`. `maxCostUsd ≤ cfg.maxPerCallUsd (0.50 USD DEFAULT)`, else `deny(PER_CALL_CAP)`.

Action wallet (RH chain ONLY — any other chain ⇒ `deny(CHAIN)`, D12):
- **A1** Per-tx cap: outgoing amount ≤ `perTxPctBps (2000 DEFAULT)` × action-wallet balance **of that asset** at evaluation time. Applies to `actionTransfer.amount`, `actionSwap.amountIn`, `actionLp` (each leg vs its own asset balance), `actionMint.value` (vs native). Else `deny(PER_TX_CAP)`. (Per-asset basis — no price oracle in the engine; Fable decision, recorded in BUILD-STATE.)
- **A2** Per-counterparty daily cap — `actionTransfer` only: for USDG, `counterpartySpent[to][USDG] + amount ≤ counterpartyPctBps (3000 DEFAULT) × allowanceAmountToday`; for any other asset, `≤ 3000 bps × action balance of that asset at first send of the day` (reducer snapshots the denominator in the ledger on first spend: `counterpartySpent[to][asset+":denom"]`). Else `deny(COUNTERPARTY_CAP)`. Swaps/LP/mints route to canonical contracts (`cfg.poolManager`, mint targets) and are exempt from A2 (still A1-capped).
- **A3** Look-alike guard — `actionTransfer` and `actionMint.target`: deny if `to` equals ANY protected address, or shares the first 4 bytes OR last 4 bytes with one. Protected set = all T2 whitelist addresses + own treasury EOA + `cfg.across.spokePool[*]` + `cfg.marlin.paymentAddresses` + allowlist payTo's. `deny(LOOKALIKE)`. (Own action EOA self-sends: pointless but harmless — still denied for simplicity: it's in no rule ⇒ actually it passes A3 only if not colliding; keep A3 as stated and let self-send be allowed if caps pass.)
- **A4** `actionSwap`/`actionLp`: pool assets must include USDG or be RH-chain tokens; `minOut ≥ 0` accepted as given (bounded-slippage duty is the caller's; injection losses here are sanctioned gameplay, D13). `actionMint`: `value ≤ A1 cap`, target passes A3.

DenyCode enum (stable strings, logged + surfaced in chat per 03 §3): `MALFORMED, NO_RULE, INSUFFICIENT_BALANCE, RUNWAY, WHITELIST, BRIDGE_RECIPIENT, DAILY_CAP, ALLOWANCE_EARLY, ALLOWANCE_AMOUNT, INFERENCE_BUDGET, ENDPOINT, PER_CALL_CAP, CHAIN, PER_TX_CAP, COUNTERPARTY_CAP, LOOKALIKE`.

## 4. Ledger reducers (`src/ledger/ledger.ts`, pure)

- `applyApproved(ledger, action, now)`: rolls `dayKey` (UTC) resetting daily buckets; adds spends to the right buckets; for `allowance` sets `lastAllowanceAt = now`, `allowanceAmountToday = amount`; snapshots A2 denominators as described. Returns new ledger (no mutation).
- `recordFeeIncome(ledger, dayTotalUsdg)`: daemon-called at UTC rollover, pushes into `feeIncome7d` (keep last 7).
- Reducers are the ONLY way ledger changes; property tests drive engine+reducer together.

## 5. Keyring + mock KMS

- `KmsClient.derive(path: string): Promise<Hex32>` — real impl (M3) hits the in-enclave derive server `127.0.0.1:1100/derive/secp256k1?path=…`.
- **Carry-over (2), retry-at-boot (M0 gotcha):** `withRetry(fn, { attempts: 30, delayMs: 1000 })` wraps ALL boot-time derives — the Nautilus derive server comes up after containers start; first-touch without retry crash-loops (see `runtime/spikes/m0-marlin-kms/RESULTS.md`). Tests simulate a KMS that fails the first N calls.
- `MockKms(imageId: string, agentId: string)`: key = `keccak256(utf8("mock-kms|" + imageId + "|" + agentId + "|" + path))` — deterministic, so M2 tests get the same revival semantics as Nautilus (same (image, agentId, path) ⇒ same key; any change ⇒ different key).
- Keyring derives: `treasury = derive("treasury")`, `action = derive("action")`, `fc = derive("fc")`, `mem = derive("mem")` (agentId is bound at the KMS layer, matching Image-variant user-data binding). Exposes: `addresses(): OwnAddresses`, `signApproved(action, approval, now)` (§1), `farcasterPubkey()`, `memKey()` (for memory module later — returns the raw key ONLY to the memory module via a scoped getter; acceptable, it's not a chain key).

## 6. Test plan

- Opus (`test/policy/rules-*.test.ts`, `test/keyring/*.test.ts`): exhaustive unit coverage — every rule ID above gets its allow case, each deny code, and boundary values (exactly-at-cap allow, cap+1 deny, 86400 vs 86399 s, clamp edges 5/60, empty feeIncome7d, day rollover). Table-driven where natural. Keyring: approval-hash mismatch throws, TTL expiry throws, retry-at-boot converges, mock-KMS determinism matrix (same/same, diff image, diff agentId — mirror the M0 A/B/C drill).
- Fable (`test/policy/invariants.test.ts`): fast-check properties INV1–INV7:
  - INV1 fuzz arbitrary action sequences; every allowed treasury outflow's destination ∈ whitelist ∪ {actionEOA via allowance}. **No exception, ever** (03 §11).
  - INV2 ≤1 allowance per 24h window; each ≤ min(5%, 500).
  - INV3 Σ approved inference per UTC day ≤ clamp budget; per-category ≤ category budget.
  - INV4 after any approved non-hosting treasury spend, runway ≥ 45d.
  - INV5 every approved action-wallet spend ≤ 20% of that asset's balance at approval time.
  - INV6 determinism: evaluate(x) twice + on structuredClone ⇒ identical verdicts.
  - INV7 metamorphic default-deny: take any allowed action, mutate its destination/endpoint/chain to a random non-whitelisted value ⇒ deny.
- Exit for this session's scope: `npm test` fully green; no `any` in `src/policy`; no Date.now/Math.random/network imports in `src/policy` or `src/ledger` (enforce with a grep test).

## 7. Model-identity sanity checks (carry-over (4) — spec now, implement with the LLM client next session)

M0 evidence: OpenRelay's DeepSeek self-identified as Gemini ⇒ self-ID is worthless. Runtime-side checks, all deterministic, run by the LLM client per call/day:
1. **Price ceiling** per endpoint from the allowlist entry (`maxPricePerMTokUsd`); a 402 quote above it ⇒ treat endpoint unhealthy, rotate.
2. **Contract checks per response:** must parse as the requested tool-call schema; max-token and stop-sequence compliance; non-empty within timeout. 3 consecutive contract failures ⇒ mark unhealthy, rotate to next fallback, cast/journal nothing about it (ops log only).
3. **Daily capability canary:** 1 fixed prompt/day per active endpoint (from a small in-code set: exact-arithmetic + JSON-format + instruction-following), scored deterministically (string match). Persistent failure ⇒ unhealthy. Cost ≈ negligible, budgeted under pulse.
4. Health state feeds D8 rotation; allowlist migration toward TEE-attested endpoints stays the durable fix (06 §4).
