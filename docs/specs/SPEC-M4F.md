# SPEC-M4F — revive flow: mausoleum, revival payment, orchestrator drive (04 §6, 05 §1, D10)

> Authored by Fable, M4 session 15 (2026-09-29). The last M4 exit-gate item. The revival MACHINE
> exists (SPEC-M3B, anvil-tested: gate + queue + deploy drive); this spec adds the public surface
> (quote/pay/queue via the launch-helper), the mausoleum page, and the safety rules today's
> rehearsal incidents exposed. Facts from recon: agent 1 is an M1 script artifact (fake
> attestationRef, script-registered keys, no config pre-image) — STRUCTURALLY UNREVIVABLE and the
> honest-UX fixture for that state; agents 2/3/4 cross REVIVAL_WINDOW 2026-10-01 (live drill
> then). `DEFAULT` = Juan-revisable. Subagents implement exactly this.

## 0. Rulings (Fable)

- **R1 (payment model, testnet v1):** the reviver pays **USDC on Arbitrum One to the
  orchestrator funding wallet** (the wallet that pays Oyster rentals), then submits the payment
  tx. The helper verifies the transfer receipt on-chain (to == funding wallet, amount ≥ quote,
  tx success, not already used) before queueing. This matches 04's stated trust boundary (the
  orchestrator is THE platform-operated component; the documented backstop is orchestrator-less
  manual revival — link it in the UI). An on-chain revival-fee contract is M6 scope, not now.
- **R2 (no impossible-revival charges):** the quote endpoint runs the FULL dry-run first —
  on-chain gate (stale > window) AND config availability AND compose resolution — and returns
  `revivable: false` with the reason when any fails. The UI never shows a pay button for an
  unrevivable agent. If the agent wakes between payment and queue (gate refuses), the response
  says the fee will be returned by the operator (manual on testnet — recorded honestly).
- **R3 (compose/identity safety — today's agent-8 incident, generalized):** a revival deploys
  the compose whose image-id family matches the REGISTERED codeHash: `launches.composePath`
  when recorded; else match codeHash against `runtime/releases/*.json` imageIds → that
  version's yml; NO match ⇒ refuse (`config_unavailable`). NEVER fall back to the current
  release — a different compose derives different keys and burns the rental. The machine stamps
  the revival runtime.json's `imageId` = the registered codeHash verbatim.
- **R4 (config availability):** pre-image resolution order = launches.frozenJson → inbox →
  Arweave tag discovery (M4E) → ar:// configRef. All miss ⇒ `config_unavailable` refusal at
  QUOTE time (R2). Agent 1 exercises this.
- **R5 (adoption guard — today's incident, productized):** when the watcher adopts a REQUESTED
  launch whose agent is ALREADY registered on-chain (`instanceOf.lastHeartbeat > 0`), the
  launch lands in a new terminal state `EXTERNAL` ("completed outside this orchestrator") and is
  never driven. Plus a new CLI `genesis abandon --config … --agent-id <N> --reason <text>` that
  moves any non-terminal launch to FAILED with the reason (replaces today's db surgery). Also:
  a startup sweep releases a `deploy.lock` held by a terminal launch (today's stuck lock).
- **R6 (rate honesty):** genesis `oyster.rateUsdcMicroPerHour` DEFAULT rises 51_200 → 240_000
  (the OBSERVED all-in rate at 512 KBps, sessions 9-15; the old default under-projected 4.7×).
  The revival quote uses it: `total = durationMin/60 × rate + revivalGasSeedUsdMicro` with
  `revivalDurationMin DEFAULT: timing profile` (testnet 180, mainnet 30 d — existing values).
- **R7 (reviver credit):** v1 credit surface = the mausoleum card lists revival history (payer
  addresses + generations) from the genesis db via the helper. The runtime-side "wake journal
  entry crediting the reviver" (04 §6) needs the reviver address to reach the enclave — DEFER
  (needs an unattested init param; design note recorded, not worth a release cycle now).
- **R8:** no new prod deps; helper stays secret-free (it READS the payment tx and the genesis
  db; it never holds keys — queueing a revival spends nothing itself).

## 1. genesis/

- `revive()` gains the R2/R3/R4 pre-checks (extracted as `checkRevivable(deps, agentId) →
  {revivable: true, composePath, configSource} | {revivable: false, reason, detail}` — pure
  read-only; used by both quote and queue paths). New refusal reason `config_unavailable`.
- R5: `EXTERNAL` state + adoption guard in the watcher/machine; `abandon` CLI in main.ts;
  terminal-holder `deploy.lock` sweep at startup.
- R6 default change + the quote math helper `revivalQuote(cfg) → {rateUsdcMicroPerHour,
  durationMin, hostingUsdcMicro, gasSeedUsdMicro, totalUsdcMicro, payTo: <funding wallet>}`.
- Launch-helper endpoints (config gains optional `genesisDb` path + `revivalPayTo` override;
  either absent ⇒ revive endpoints 503 "manual mode" with the orchestrator-less instructions):
  - `GET /api/revive/quote/:agentId` → `{agentId, revivable, reason?, quote?, gate: {lastHeartbeat,
    revivalWindow, evictableAt}, history: [{generation, payer, startedAt, state}]}` (history from
    the revivals table; gate values so the UI can show "evictable in Xd" for stale-not-yet).
  - `POST /api/revive` `{agentId, payer, paymentTx}` → verifies R1 (viem receipt: USDC Transfer
    log to payTo, amount ≥ totalUsdcMicro, unused txHash — persisted in a `revival_payments`
    table/JSONL to prevent reuse) → calls `revive()` → 200 `{revivalId}` | 402 payment problems |
    409 gate/config refusals (body carries the reason) | 503 manual mode.
  - `GET /api/revive/status/:agentId` → the revivals rows (state machine progress) for the tracker.
- Tests ("M4F §1: …"): checkRevivable matrix (fresh heartbeat / never registered / no config
  anywhere / compose match via launches / compose match via releases table / no compose match);
  EXTERNAL adoption (registered agent ⇒ never driven — regression for the agent-8 incident);
  abandon CLI; lock sweep; quote math golden; payment verification (wrong recipient / short
  amount / reverted tx / reused tx / good ⇒ queued); endpoint status matrix.

## 2. web/ — `/mausoleum`

- Gallery of agents with indexer status `evicted` (plus a muted "dying" section: `stale` with
  `evictableAt` countdown from the quote endpoint's gate — sets expectations for the Oct-1
  drill). Card: name/symbol/identicon, generation, **last words** (final journal entry, or the
  honest empty state), lifetime stats (vol24h is meaningless here — use fee totals + age +
  journal count), revival history (R7), and:
  - `revivable: true` ⇒ quote (USDC), pay flow: wagmi USDC `transfer(payTo, total)` on
    **Arbitrum One** (chain-switch prompt — first cross-chain tx in the web app; the USDC
    address + chainId 42161 come from the quote payload, NOT hardcoded) → POST /api/revive
    (proxied) with the tx hash → tracker.
  - `revivable: false` ⇒ the reason, honestly ("no revivable configuration exists — this agent
    predates config publication" for agent 1; "alive" for fresh).
  - Manual-mode (503) ⇒ the orchestrator-less revival instructions (04 §6 backstop, verbatim
    spirit: image, scripts and deploys are public — link REPRODUCIBLE-BUILD.md + the repo).
- Tracker: poll revive/status + the indexer instance row — steps: payment verified → queued →
  deploying → registered (generation N+1! the visible proof) → seeded/live. Reuse the launch
  tracker patterns.
- Directory/header link ("Mausoleum"). Fixtures: one revivable evicted agent (full pay flow via
  simulate), agent-1-style unrevivable, dying-with-countdown, manual mode.
- Tests: build+tsc; fixtures render all states.

## 3. Acceptance (Fable review gate)

1. genesis suite green (was 165) incl. every §1 test; indexer untouched (or green if touched);
   web build green.
2. Agent-1 quote against the LIVE chain returns `revivable: false / config_unavailable`
   (free, read-only — run it this session).
3. Agents 2/3/4 quotes return `revivable: false / heartbeat_fresh` TODAY with correct
   `evictableAt` ≈ 2026-10-01 (proves the gate math against live data).
4. The LIVE end-to-end revival drill (pay → queue → orchestrator redeploy → generation 2 →
   web tracker) runs NEXT session, on/after 2026-10-01, against agent 2 or 3. Recorded as the
   M4 exit-gate's final item.

## 4. Out of scope

On-chain revival-fee contract (M6); runtime wake-entry reviver credit (R7 note); automated
refunds; holders table; LLM moderation; proof-card.
