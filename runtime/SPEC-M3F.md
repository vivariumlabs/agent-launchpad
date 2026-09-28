# SPEC-M3F — native balance reads + degraded token reads (trading-drill findings)

> Authored by Fable, M3 session 10 (2026-09-28), during the agent-7 trading drill. Two live
> findings, one root-caused this session, one carried from agent 5 (2026-09-24). Both are
> state-reader correctness holes; neither changes policy semantics. Implement AFTER the M3 exit
> gate (v0.1.6 candidate) unless Juan pulls them earlier.

## 1. FINDING (live, agent 7): native balances are silently 0 in every live enclave

`chainStateReader` (boot.ts:612) reads native balances only when the injected ChainClient
implements the optional `NativeBalanceSource` interface — and **`RealChainClient` never
implements it**. No prod code does. Consequences, all confirmed live on agent 7 (2026-09-28)
and by offline engine-replay against live state:

- Every native balance in `WalletState` is 0, marked **fresh** (not stale — G5 never fires).
- Daemon step 2 (gas floors) can never act: the treasury always looks below floor on every
  chain with no surplus anywhere ⇒ notes only, no top-up, ever. Agent 6's "tick 1 gas legs
  didn't land (likely transient STALE)" was THIS, not a transient.
- G3 denies every native-asset spend (`gasTopUp`, `arweaveFunding` base-ETH leg, acrossBridge
  ETH legs): "balance 0 < amount". The Turbo self-top-up (M3D §2) and the bridge gas path are
  structurally dead in live enclaves.
- SPEC-M3C §10's registration gas wait short-circuits ("noBalanceSource") — it never actually
  waited in any live run.
- Runway/tier math understates holdings (conservative, so no spend risk — but wrong).

Registration/heartbeat/allowance still worked because gas fees are not balance-gated and USDG
is an ERC-20 read (those work), which is why four agents reached LIVE with this hole open.

### Fix

a. `RealChainClient` implements `NativeBalanceSource`: `getBalance(chain, address)` via viem
   `publicClient.getBalance` on that chain's transport (same retry/timeout policy as reads;
   M3C §6 httpRetryCount applies).
b. Move `NativeBalanceSource` from boot.ts into exec/chain.ts next to `ChainClient` (boot
   re-exports for compat). MockChainClient gains a settable balance map implementing it, so
   tests can exercise real native paths.
c. **Fail loud instead of silently zeroing**: in `chainStateReader`, when `runtime.tee` is true
   and the client lacks `NativeBalanceSource`, throw at READER CONSTRUCTION time (boot config
   error — this is a wiring bug, not a runtime degradation; M3C's tolerant-boot applies to
   network failures, not to a client that can never read). Non-tee/mocks keep the 0n fallback
   (existing unit-test fixtures unaffected).
d. Native read failures join the M3C §4 per-chain grouped try/catch like every other read on
   that chain (a chain is fresh only if ALL its reads succeeded — native included).

### Tests ("M3F §1: …")

RealChainClient.getBalance returns live-shaped bigint (mock transport); chainStateReader with
NativeBalanceSource populates native on all chains; native read throw ⇒ that chain stale,
cached-else-zero, warn; tee:true + no NativeBalanceSource ⇒ constructor throws; stepGas with
real balances above target sends gasTopUp (regression for the agent-7 stall); §10 wait engages
(no more "noBalanceSource" in tee).

## 2. FINDING (agent 5, 2026-09-24): deterministic token-read revert ⇒ permanent stale ⇒ G5 denies everything on rh

A frozen config carrying a bad `agentTokenAddress` (agent 5: curve implementation, not the
token) makes `balanceOf` REVERT deterministically; M3C §4 groups it into the rh read set ⇒ rh
permanently stale ⇒ G5 denies all rh spends including registration (§11 burned its whole
budget). Production frozen configs don't carry `agentTokenAddress` (not urgent), but the
failure mode is wrong: a deterministic revert is not "RPC unreachable".

### Fix

In `chainStateReader`'s rh read group, wrap the agent-token `balanceOf` reads (treasury +
action) in their OWN try/catch: on failure, LOUD warn ("agent token read reverted — tokens
omitted from state; check agentTokenAddress") and OMIT the `tokens` key from both slices for
this read; rh freshness is decided by the REMAINING reads only. Rules treat a missing token
entry as 0 today (verify; add test if untested). A flaky-RPC token failure is
indistinguishable from a revert here — accepted: omitting tokens understates holdings, which
is conservative (chat gate may false-deny during the flake; no spend can overshoot).

### Tests ("M3F §2: …")

Token read throws, everything else succeeds ⇒ rh FRESH, tokens absent, warn logged; engine on
such a state: registration/allowance/gasTopUp unaffected; chat-gate/tier math treats absent as
0; all-reads-fail still ⇒ rh stale (grouping intact).

## 3. Version

runtime/package.json 0.1.5 → 0.1.6 when implemented.
