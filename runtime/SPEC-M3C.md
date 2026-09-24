# SPEC-M3C — tolerant boot / degraded chain state (drill fix) + genesis deploy flags

> Authored by Fable, M3 session 9 (2026-09-24). Root cause of the s3 crash-loop: `execute()` awaits
> `deps.getState()` uncaught (execute.ts:146); `ensureRegistered` calls `execute` outside its
> try/catch (boot.ts:829); `chainStateReader` does ~11 serial RPC reads across 4 chains with viem
> transport `retryCount: 0`. One throttled datacenter-IP read at boot ⇒ throw out of `boot()` ⇒
> process exit ⇒ `restart: unless-stopped` crash-loop (jobs 31a6/31a7/31a8, :8420 never listened).
> Fix: getState never throws; degradation is per-chain, visible, and FAIL-CLOSED for spends.

## 1. `WalletState.staleChains` (policy/types.ts)

`WalletState` gains OPTIONAL `staleChains?: readonly Chain[]` — chains whose balances in this state
object are NOT fresh reads (cached or zeroed). Absent/empty ⇒ all fresh. Existing fixtures unaffected.

## 2. `chainsTouched` (policy — new pure fn, rules/common.ts or types.ts)

`chainsTouched(a: ProposedAction): readonly Chain[]` — the chains whose balances the rules read
and/or where the tx lands. Ruling (exact, do not re-derive):

- `heartbeat`, `registerInstance`, `distribute`, `allowance`, `treasurySwap`, `treasuryApprove`,
  `actionTransfer`, `actionSwap`, `actionLp`, `actionMint`, `actionApprove` → `["rh"]`
- `treasuryTransfer` → `[a.chain]`, plus `a.destChain` when present (acrossBridge) → `[a.chain, a.destChain]`
- `inference` → `["base"]` (x402 pays Base USDC)
- `castPost`, `castReply`, `journalWrite` → `[]` (no chain balances; never stale-blocked)

## 3. Engine gate `STATE_STALE` (policy/engine.ts + types.ts)

Add `"STATE_STALE"` to `DenyCode`. In `evaluate`, AFTER G1 validation and BEFORE the rule modules:
if `state.staleChains` intersects `chainsTouched(a)` ⇒
`deny("STATE_STALE", "G5: balances for <chains> are stale (RPC unreachable) — refusing to act on degraded state")`.
Social kinds pass (empty intersection by construction). Engine stays pure; no other rule changes.
Rationale: zeros alone are NOT safe — e.g. the daemon would see native=0 on a merely-unreadable
chain and fire a real gas-top-up/bridge spend. Degraded data must never trigger a spend.

## 4. Tolerant `chainStateReader` (boot.ts)

Rewrite so it NEVER throws:
- Group reads per chain: for each chain c, ALL of c's reads (treasury native+USDC; on rh also
  treasury USDG + agent token, and the action EOA's native/USDG/token) in ONE try/catch — a chain is
  fresh only if every read on it succeeded (no half-fresh chains).
- Per-reader in-memory cache `Map<Chain, slice>` updated on each success. On failure: LOUD warn
  (`!!! getState: <chain> reads FAILED (<err>) — using <cached values (age Ns)|zeros>; spends touching <chain> deny STATE_STALE !!!`),
  serve the cached slice else zeros, and mark c stale. Cached values still mark stale (spends stay
  closed; cache only keeps runway/tier from cratering spuriously).
- Result includes `staleChains` ONLY when non-empty (omit the key when all fresh).
- hosting fields unchanged. Runway/tier math needs no change: understated balances are conservative,
  and recovery is automatic (next daemon tick / pulse re-reads; Loop already retries).

## 5. `ensureRegistered` honors "never throws" (boot.ts)

Wrap the `execute({kind:"registerInstance"})` call in try/catch → LOUD warn + return `"sendFailed"`.
(Defense in depth; with §4 the getState path no longer throws, but chain.sendRaw/getNonce still can.)

## 6. Transport retry (exec/chainViem.ts)

`RealChainClientOptions.httpRetryCount?: number` DEFAULT 2 → viem `http(url, { retryCount })`.
Retrying `eth_sendRawTransaction` is safe (same signed bytes ⇒ same tx hash, idempotent). Update the
header comment (it claims no-retry semantics implicitly).

## 7. Genesis deploy wrapper flags (genesis/src/oyster.ts + config.ts)

`OysterSettings` gains `enclaveMemoryMb?: number`, `bandwidthKbps?: number` (positive safe ints,
zod-validated in config.ts). `deployArgs` pushes `--enclave-memory <mb>` / `--bandwidth <kbps>`
when set, omits when unset (CLI 5.0.1: `--bandwidth` is KBps, default 10; `--enclave-memory` in MB —
our image REQUIRES 3072, drill finding 2026-09-23).

## 8. Version bump

runtime/package.json (+lockfile) `0.1.0` → `0.1.1`.

## 9. Tests (all named "M3C: …")

1. Tolerant reader (unit, mock ChainClient that throws per-chain on command): base throws ⇒
   staleChains ["base"], base zeroed, others real, warn logged; success-then-failure ⇒ cached slice
   served AND still stale; all-success ⇒ `staleChains` key ABSENT (exact).
2. Engine gate: every spend kind denied STATE_STALE when its touched chain is stale; rh kinds
   UNAFFECTED by staleChains ["optimism"]; castPost/castReply/journalWrite allowed with ALL chains
   stale; acrossBridge treasuryTransfer denied when only destChain is stale.
3. Consistency: for a fixture action of every tx-producing kind, `buildTx(a, cfg, now).chain` ∈
   `chainsTouched(a)` (exec test — both importable there; skip kinds buildTx doesn't build a tx for).
4. `ensureRegistered` with deps whose getState throws ⇒ resolves "sendFailed", never rejects.
5. deployArgs includes both flags when set, omits when unset; config.ts parses/rejects them.

Existing suites stay green untouched except where a test asserts the old throwing behavior.

## 10. Registration gas wait (e2e finding 2026-09-24, for v0.1.2)

Live e2e: the enclave booted 26 s BEFORE the orchestrator's preGas confirmed ⇒ boot's single
registerInstance attempt failed on gas and NOTHING retries ⇒ AWAITING_REGISTER deadlock (recovered
by redeploy). Oyster's :1300 comes up near-simultaneously with the app when the pull is fast, so the
"verify+preGas during pull" ordering is a coin flip, not a guarantee.

Fix in `ensureRegistered` (boot.ts), before sending registerInstance (genesis AND revival paths):
- If the chain client implements NativeBalanceSource and `getBalance("rh", treasury)` <
  `REGISTRATION_GAS_FLOOR_WEI = 100_000_000_000_000n` (0.0001 ETH; real cost ≈ 2e14 max at the
  1-gwei cap, preGas sends 3.33e14): poll the balance every 10 s (clock-injected, timers via the
  existing injectable clock — a plain awaited sleep loop reading `clock()` is fine in boot) up to
  `runtime.registrationGasWaitSec DEFAULT 600` (ops config — liveness knob, no spend authority).
  Log info every 30 s while waiting ("registration: waiting for preGas …").
- Funded ⇒ proceed. Timeout ⇒ attempt anyway with a LOUD warn (the send surfaces the real error).
- Balance read errors count as "not yet funded" (warn once, keep polling). Never throws.
- No NativeBalanceSource (mock chain) or already registered/fresh ⇒ no wait (existing behavior).

Tests ("M3C §10: …"): funded-after-N-polls ⇒ registerInstance sent (fake clock/sleep); timeout ⇒
attempted + warned; already-registered ⇒ no wait; tee:false unchanged; read-error-then-funded works.

## 11. Registration retry loop (second e2e finding 2026-09-24, for v0.1.3)

Agent-3 e2e on v0.1.2: preGas confirmed BEFORE the app booted, §10 wait passed (balance ≥ floor),
yet treasury nonce stayed 0 — the single registerInstance attempt failed some other way (instanceOf
read flake ⇒ "readFailed", or a transient rh RPC failure inside getState ⇒ G5 STATE_STALE deny ⇒
"sendFailed"; non-debug enclave, exact trigger unobservable). Twice today a one-shot boot
registration died to a transient; every variant needs the same cure: RETRY.

Fix in boot step (7): wrap the `ensureRegistered` call in a bounded retry loop —
- outcomes "registered" | "revived" | "alreadyRegistered" | "keyMismatch" ⇒ stop (keyMismatch is
  permanent: retrying cannot fix pinned-key divergence);
- "readFailed" | "sendFailed" ⇒ sleep `registrationRetryDelaySec DEFAULT 30` (same injectable
  SleepFn as §10) and retry, until `registrationRetrySec DEFAULT 900` total has elapsed (ops config,
  liveness knobs only). Each retry re-reads instanceOf first, so a send whose receipt was lost
  converges to "alreadyRegistered" instead of double-sending; a genuinely duplicate send reverts
  on-chain (RevivalWindowNotElapsed) and the NEXT read stops the loop. LOUD warn on final give-up.
- §10's gas wait runs inside `ensureRegistered` as today, but its `waitSec` budget only applies per
  attempt; keep DEFAULT 600 (first attempt) — pass a small `waitSec` (60) on retries so the loop's
  cadence dominates. Boot still never throws; chat/schedulers start after the loop as today.
- Debt (unchanged): the daemon never retries registration post-boot; revisit only if a live agent
  ends up unregistered after the boot window.

Tests ("M3C §11: …"): readFailed×2 then success ⇒ 3 calls, registered; sendFailed until budget ⇒
gives up with warn, boot continues; keyMismatch ⇒ no retry; alreadyRegistered on retry after a
lost-receipt send ⇒ loop stops without a second send; delays injected (fake sleep), total-budget
arithmetic exact.
