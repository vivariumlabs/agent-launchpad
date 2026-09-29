# SPEC-M4E — self-serve launch completion (config → Arweave) + NFT dashboard (claim/burn)

> Authored by Fable, M4 session 14 (2026-09-29). Targets the two biggest M4 exit-gate gaps
> ("a stranger with a wallet could launch, chat, claim, burn, and revive with no help" — 07 §1):
> the launch flow's config never reaches the orchestrator without an operator (inbox folder), and
> claim/burn have no UI. Decisions cited: 02 §1 ("the config itself goes to the genesis service
> off-chain AND to Arweave"), 04 §1 (launch diagram: "image + config → Arweave"), D7 (burn ⇒
> royalty leg redirects to the agent forever), D10 (revival needs the Arweave-published original —
> this spec is what puts it there). `DEFAULT` = Juan-revisable. Subagents implement exactly this.

## 0. Rulings (Fable)

- **R1 (trust model):** the Arweave item is pure TRANSPORT. Trust comes ONLY from
  `verifyFrozen` (genesis/src/configSource.ts:73): keccak(canonicalEncode(item)) must equal the
  ON-CHAIN configHash, and agent.agentId must match. Tags/owner are untrusted hints. Tag spam is
  a bounded DoS at worst: discovery fetches ≤ `DEFAULT 5` newest candidates and hash-checks each.
- **R2 (who uploads, with what key):** the launch-helper uploads, signing the ANS-104 item with
  an EPHEMERAL in-memory secp256k1 key (fresh per process, discarded). The helper stays
  secret-free — the key holds nothing and proves nothing; R1's hash anchor is the security.
  Uploads are free (<100 KiB, proven since s3). REUSE the runtime's ans104 + Turbo HTTP code via
  a new narrow re-export seam `genesis/src/runtimeArweave.ts` (canonical.ts pattern); extend the
  genesis hygiene allowlist for exactly this file with a comment — do NOT duplicate crypto.
- **R3 (publish timing):** the web launch flow publishes AFTER prepare, BEFORE the createAgent
  tx (review screen shows `ar://<txid>` with a permanent-link label). A publish whose tx never
  lands is a harmless orphan. A tx whose publish failed is recoverable (re-publish any time —
  R1 doesn't care who uploads or when); the tracker surfaces "config not yet found on Arweave"
  from the orchestrator's perspective as a distinct step.
- **R4 (orchestrator):** keep DirConfigSource first (operator override / drills), then the new
  tag-discovery source. Arweave GraphQL indexing lags minutes — the machine's existing
  re-drive/poll behavior absorbs it (pre-registration timeout is 24 h); the source returning
  null is already a retry, not a failure.
- **R5 (NFT dashboard truth):** `tokenId == agentId` (AgentNFT.sol:9). Ownership from indexer
  NFT Transfer events; `accrued(agentId)` read CLIENT-side via wagmi (live view call — no
  indexer staleness on money numbers); lifetime earned = sum of indexer `Claimed` events;
  emancipated state from `Emancipated` events. Contract addresses come from the indexer (it owns
  the deployments manifest) via `/api/contracts` — web carries NO hardcoded addresses.
- **R6 (burn UX is a grave decision):** multi-step confirm per 05 §1: (1) explain — royalty leg
  redirects to the agent's treasury FOREVER, accrued unclaimed royalties sweep to the treasury
  NOW, the NFT can never be re-minted; (2) type the agent's symbol to arm; (3) send. Show the
  Emancipated event (swept amount) as the "emancipation reaction" when it lands. No dark
  patterns in reverse either: claim is one click (it's permissionless and pays the owner).
- **R7:** no new prod deps anywhere. Holders table + revive flow are OUT of this spec (revive =
  M4F, needs a live orchestrator + funds).

## 1. genesis/ — Arweave config publication + discovery

### 1a. `runtimeArweave.ts` seam + uploader

- Re-export from the runtime: the ANS-104 data-item signer (type-3 Ethereum) and the Turbo HTTP
  upload client (runtime/src/attestation/ans104.ts + turboHttp.ts — find the exact export
  names). Hygiene allowlist extended for this file only.
- `publishFrozenConfig(text: string, deps): Promise<{ txId: string }>` — signs with an ephemeral
  key, tags `{App: "agent-launchpad", Kind: "config", ConfigHash: <0x lowercase>}` (+ Timestamp),
  uploads via the payment-service-free path (<100 KiB enforced: reject larger with a clear
  error), returns the item id. Injectable HTTP/uploader for tests.

### 1b. Launch-helper endpoint

- `POST /api/launch/publish` body `{agentJson}` (object or exact text — accept BOTH: object ⇒
  canonical text is `JSON.stringify(agentJson, null, 2)`? NO — the deployed agent.json must be
  the EXACT bytes; ruling: accept `{agentJsonText: string}` ONLY, the same text prepare returned;
  validate it re-hashes via frozenConfigHash and moderation-passes) → uploads via §1a → 200
  `{txId, ref: "ar://<txId>", configHash}`. 413 over 100 KiB; 422 on hash/schema failure; 502 on
  upload failure. Log a JSONL line per publish.
- Prepare's response gains `agentJsonText` (the exact canonical file text it hashed) so the
  client round-trips bytes, not JSON.

### 1c. Orchestrator discovery source

- New `ArweaveTagConfigSource implements ConfigSource` (configSource.ts): GraphQL query by the
  §1a tags for `q.configHash` (lowercase), first `DEFAULT 5` edges newest-first; fetch each via
  the gateway (one-redirect rule), return the FIRST whose text passes a local pre-check
  (frozenConfigHash == configHash — cheap, before the caller's verifyFrozen runs again); none ⇒
  null (R4: null is retry). Config keys: reuse the existing arweave gateway/graphql settings
  (add to genesis config if absent; injectable HTTP).
- Wire into orchestrator.ts sources chain AFTER DirConfigSource. The recorded `ref` becomes
  `ar://<txid>` — which is exactly what revival (04 §6) wants.

### Tests ("M4E §1: …")

publish: exact-bytes round-trip (upload body byte-equal to input text), tag set, ephemeral key
varies per process, >100 KiB rejected, hash-mismatch 422; discovery: finds by tag + hash-checks
(a spoofed item with right tags/wrong bytes is SKIPPED and the right one still found), cap
respected, none ⇒ null, gateway error ⇒ null + warn (retry semantics); chained source order
(inbox wins when both exist); launch-helper publish endpoint status matrix; prepare returns
agentJsonText whose frozenConfigHash equals the returned configHash.

## 2. indexer/ — small additions

- `/api/contracts` → the manifest addresses `{factory, registry, nft, distributor, usdg, ...}`
  (whatever the manifest carries) + chainId. (R5: web gets addresses here.)
- NFT ownership: derive current owner per agentId from the already-ingested NFT Transfer events
  — table `nft_owners(agentId PK, owner, since, txHash)` maintained at ingest (+ migration v5,
  backfill from existing events at migration time); `/api/wallets/:address/nfts` →
  `[{agentId, name, symbol, since, emancipated: bool, lifetimeClaimed: string}]`
  (lifetimeClaimed = sum of Claimed events; emancipated from Emancipated events).
- Tests ("M4E §2: …"): owner derivation follows transfers (mint ⇒ from 0x0, transfer, burn ⇒
  owner null/removed), idempotent re-ingest, backfill on migration; endpoint shapes incl. empty
  wallet; contracts endpoint.

## 3. web/ — NFT dashboard `/nfts` + launch-flow publish step

- `/nfts`: connect → `/api/wallets/:address/nfts` → cards: agent name/symbol/link, ACCRUED
  royalties (live wagmi read `distributor.accrued(agentId)`, refreshed after claim), lifetime
  claimed, claim button (wagmi write `claim(agentId)`, permissionless), burn flow per R6 (wagmi
  `nft.burn(agentId)`, owner-only — hide for non-owners), emancipated badge + swept amount for
  burned ones. Empty state. ABI fragments inline (M4A discipline): accrued/claim (distributor),
  burn (nft), Emancipated/Claimed events for receipt parsing.
- Launch flow: insert the publish step per R3 — after prepare, call the (proxied, M4B pattern)
  helper publish with `agentJsonText`; review screen shows the `ar://` ref as "config published
  permanently ↗" (arweave.net link); tracker gains a "config discoverable on Arweave" hint line
  (client-side GraphQL check is overkill — just link the item; the orchestrator's Requested→
  DEPLOYING transition is the real signal, already tracked).
- Fixtures: nfts happy path (2 NFTs: one with accrued, one emancipated), empty wallet, burn-flow
  walkable via simulate; launch fixtures gain the publish step.
- Header/directory link to /nfts ("Your NFTs").

## 4. Acceptance (Fable review gate)

1. genesis typecheck+suite green (was 152; hygiene updated deliberately for runtimeArweave.ts
   only); indexer green (was 110) with migration v5 clean on the live e2e db; web build+tsc
   green, fixtures render all new states.
2. LIVE (this session, free): publish agent-8's committed agent.json text via the real helper →
   real Turbo upload (winc 0) → `ArweaveTagConfigSource` discovers it by configHash tag and the
   text round-trips byte-exact through verifyFrozen. (Deploy/e2e launch drill = next session,
   with the arb top-up.)
3. No secrets in genesis launch-helper path (ephemeral key only); no new deps.

## 5. Out of scope

Revive flow (M4F: mausoleum page + revival funding + orchestrator revival drive — the ar:// refs
this spec creates are its prerequisite); holders table; imageURI upload; orchestrator production
hosting (ops, M6).
