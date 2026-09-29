# SPEC-M4B — M4 second slice: attestation tab (05 §5) + launch flow phase 1

> Authored by Fable, M4 session 11 (2026-09-29). Scope: indexer attestation-verification job +
> API, `genesis/` launch-helper service (secret-free), `web/` attestation tab + launch flow.
> Decisions cited: D5/D6 (attestation is the custody story), D8 (allowlist), 04 §1 (launch
> sequence), 05 §3 (moderation), 05 §5 (credibility product). `DEFAULT` = Juan-revisable.
> Subagents implement exactly this; concerns come back to Fable.

## 0. Build-level rulings (Fable, this spec)

- **R1 (honest checkmarks):** the attestation tab server-verifies ONLY what public data can
  prove: Arweave report ↔ chain cross-checks and release-table membership. Raw NSM quote
  signature re-verification (COSE/x509 to the AWS Nitro root) is NOT implemented this slice —
  the tab renders a **"verify yourself"** panel with the exact `oyster-cvm verify` +
  `curl /attestation` commands instead of a fake ✅. No check may render ✅ unless the indexer
  actually ran it. Quote re-verification = M4C candidate.
- **R2 (red banner):** any FAILING check (not "unverifiable": failing) on any agent whose
  status is `live` ⇒ `/api/attestation/summary` reports `alert: true` and web renders the
  site-wide red banner (05 §5 "must never silently fail"). Unreachable Arweave/GraphQL ⇒
  checks stay `pending`, never `fail` (transport ≠ compromise), warn loudly in the indexer log.
- **R3 (launch flow scope):** phase 1 ends at the on-chain `createAgent` tx + progress
  tracker driven by indexer rows. The orchestrator remains operator-run (04's trust boundary,
  documented in the UI). Image upload to Arweave: deferred (identicon in v1, 05 image slot
  reads imageURI when the launch form gains upload later).
- **R4 (launch-helper, secret-free):** predicting `configHash` / `imageId` /
  `expectedTreasuryEOA` requires the runtime's canonicalEncode, `oyster-cvm compute-image-id`,
  and the public Nautilus KMS derive endpoint. None needs a key. New small HTTP service in
  `genesis/` (it already imports the runtime's canonicalEncode — hash consistency stays
  single-sourced). web/ and indexer/ stay secret-free; web calls the helper only server-side.
- **R5 (moderation v1):** rule-based checks + a **versioned rubric committed at
  `docs/policy/persona-moderation.md`** (v1): reject on impersonation patterns of real named
  people, instruction-to-illegality phrases, harassment targeting, securities-pitch language;
  enforce length ≤ 2000 chars. Applied client-side at form time AND server-side in the
  launch-helper prepare call (which returns violations). LLM moderation = M4C+ when a platform
  inference path exists; the rubric file is the contract either way. Log rejections
  (launch-helper appends JSONL to its data dir).
- **R6:** no new prod deps anywhere without a Fable ruling. bigints end-to-end; no floats in
  money math.

## 1. indexer/ — attestation verification

### 1a. Release table

- New config key `releasesDir` (path, DEFAULT unset ⇒ release checks render "no release table").
  Points at `runtime/releases/` (e2e config: `../runtime/releases`). At boot and each verify pass,
  load every `v*.json`: `{version, imageDigest, imageRef, imageIds: {agentId: imageId}, commit}`.
- A codeHash (instanceOf.codeHash, = image-id) **matches** when it equals (0x-insensitive,
  case-insensitive) ANY value in ANY release's `imageIds` map. Store matched version + commit.
  (Image-ids are per-(agentId, configHash), so the per-release map is exactly the published set.)

### 1b. Verify job (`verify.ts`, own loop `verifySec DEFAULT 300`)

Per agent with an instances row, compute checks (results table `attestation_checks(agentId PK,
verifiedAt, refShape, itemFound, reportParses, eoasMatch, configHashMatch, imageIdMatch,
releaseMatch, releaseVersion, detail JSON)`; each check ∈ `pass|fail|pending|skip`):

1. `refShape`: attestationRef is 43-char base64url (drill-style local refs ⇒ `skip`, and all
   downstream checks `skip` — never `fail`; the UI says "local ref (drill)" — bounded honesty).
2. `itemFound`: GraphQL id lookup succeeds (owner recorded) AND gateway data fetch (one
   redirect allowed, the turboHttp rule) returns bytes ≤ 256 KiB.
3. `reportParses`: JSON with `kind == "agent-launchpad.attestation-report"`, has `eoas`,
   `configHash`, `imageId`.
4. `eoasMatch`: report.eoas.{treasury,action} == instances row EOAs (case-insensitive).
5. `configHashMatch`: report.configHash == agents.configHash (the factory-anchored value).
6. `imageIdMatch`: report.imageId (0x-stripped) == instances.codeHash (0x-stripped).
7. `releaseMatch`: §1a membership of instances.codeHash. Also store `releaseVersion`.

Transport failure anywhere ⇒ affected checks `pending` + LOUD warn (R2). Generation history:
API serves the InstanceRegistered events already in `events` (kind filter) — no new table.

### 1c. API additions (api.ts)

- `GET /api/agents/:id/attestation` → `{checks, verifiedAt, releaseVersion, attestationRef,
  arweaveUrl, generationHistory: [{generation, treasuryEOA, actionEOA, codeHash, ts, txHash}],
  verifyYourself: {imageId, enclaveIpHint: null, commands: [strings]}}` (commands templated
  from the real values; enclave IP is not on-chain — command shown with a placeholder).
- `GET /api/attestation/summary` → `{alert: bool, agents: [{agentId, status, worst: pass|fail|
  pending|skip, failing: [checkNames]}], verifiedAt}`. `alert` = any live agent with a `fail`.

### 1d. Tests ("M4B §1: …")

Release table load + membership (0x/case variants); verify pass against mock gql/gateway:
all-pass fixture; each single-check failure isolated; transport error ⇒ pending not fail;
drill-style ref ⇒ skip cascade; summary alert only on live+fail (live+pending ⇒ no alert,
stale+fail ⇒ no alert but reported); api endpoints (real http, temp db) incl. 404.

## 2. genesis/ — launch-helper (`src/launchHelper.ts` + `launch-helper` npm script)

node:http JSON, port `DEFAULT 8426`, CORS GET/POST from `DEFAULT *`, config via a small zod
section in the genesis config (`launchHelper: {port, composePath, kmsEndpoint, oysterBin,
releasesTemplate}`). NO wallet, NO secrets, NO spend paths. Endpoints:

- `GET /api/launch/template` → `{platform: <the platform section genesis would freeze — from
  the genesis config's manifest + committed allowlist draft>, defaults: {archetypes, models:
  [from x402Allowlist entries], creationFeeUsdg: "75000000"}, composeVersion}`.
- `POST /api/launch/prepare` body `{agent: {name, symbol, archetype, persona, models}}` →
  server re-runs R5 moderation (reject ⇒ 422 `{violations}`) → builds the frozen agent.json
  `{platform: template.platform, agent: {...body.agent, agentId: <next: factory agentCount()+1
  via RPC>}}` → `{agentId, agentJson, configHash (canonicalEncode+keccak — the runtime's, as
  genesis already imports), imageId (oyster-cvm compute-image-id via injected Exec),
  expectedTreasuryEOA, actionEOA (public KMS derive HTTP), createArgs: {factory, usdg,
  fee: "75000000"}}`.
- **Race honesty:** agentId prediction can race a concurrent create; the UI must re-check after
  tx receipt (AgentRequested carries the real id) — document in the response (`predicted: true`).
- Tests ("M4B §2: …"): template shape; prepare happy path with mocked Exec+KMS+RPC (golden
  configHash fixture — MUST equal runtime canonicalEncode output for the same json); moderation
  422s; KMS/exec failure ⇒ 502 with reason, never a partial prediction.

## 3. web/ — attestation tab + launch flow

### 3a. Attestation tab (replaces its TabStub on `/agent/[id]`)

- Checks list with ✅/❌/⏳/— rows (pass/fail/pending/skip), release version + GitHub release
  link (`https://github.com/vivariumlabs/agent-launchpad/releases/tag/runtime-<version>`),
  attestationRef → Arweave link, EOAs vs registry values side-by-side, generation history
  table, heartbeat freshness (reuse status derivation), "verify yourself" panel (monospace
  command block, copy button; states the quote-signature caveat per R1).
- Site-wide red banner component in the root layout, driven by `/api/attestation/summary`
  (server fetch, revalidate 60 `DEFAULT`): giant, unmissable, names the failing agents. Renders
  nothing when `alert` false or the endpoint is unreachable (a dead indexer is not a
  compromise; footer already says convenience layer).
- Fixtures: all-pass agent, one failing (banner state), one drill/skip, one pending.

### 3b. Launch flow (`/launch`)

- Form: name (≤32), symbol (≤8, upper), archetype picker, persona textarea with live R5
  moderation feedback + char count, model primary/fallback pickers (template models, distinct
  operators enforced ≥? — v1: primary + ≥1 fallback, warn under 3 operators), cost preview
  (75 USDG + "gas"). LAUNCH_HELPER_URL unset ⇒ the form renders in "manual mode": builds
  nothing, shows the documented operator instructions instead (honest degradation).
- Submit: POST prepare → review screen (predicted agentId, treasury EOA, configHash, imageId,
  full agent.json expandable) → wagmi: USDG `approve(factory, fee)` if allowance short, then
  `createAgent(name, symbol, "", configHash, connectedAddress, expectedTreasuryEOA)` →
  progress tracker.
- Progress tracker: poll `/api/agents/:id` (indexer) — steps: Requested (row exists) → TEE
  booted & attested (instances row) → checks green (attestation endpoint) → Live (state).
  Timeout messaging after 15 min DEFAULT with the 24 h refund note (02 §2). Orchestrator trust
  boundary sentence displayed (04 header).
- Wallet: the existing injected connector; the flow is the first gated functionality — no
  RainbowKit still (revisit later, M4A ruling stands).

### 3c. Acceptance

Build + tsc green; fixtures mode renders all attestation states + full launch form flow (mock
helper via fixture json); against live indexer: agent 8 attestation tab shows refShape ✓,
itemFound ✓, reportParses ✓, eoasMatch ✓, configHashMatch ✓, imageIdMatch ✓, releaseMatch ✓
(v0.1.6); agents 2/3/4 render their local-ref `skip` state honestly; no site-wide banner.

## 4. Out of scope (recorded)

Proof-card share image; NSM quote re-verification in the indexer; LLM persona moderation;
Arweave image upload; orchestrator-as-a-service. M4A debt items (a)–(g) unchanged.
