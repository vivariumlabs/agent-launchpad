# SPEC-M4A — M4 first vertical slice: indexer + website (directory & agent profile), journal Arweave sink

> Authored by Fable, M4 session 10 (2026-09-28). Scope: `indexer/` package, `web/` package
> (Directory + Agent profile pages per 05 §1), and one ADDITIVE runtime piece (journal → Arweave,
> the D17 data source). Decisions cited: D9 (chat gate — out of this slice), D14 (vivarium.systems),
> D17 (journal feed IS the v1 social surface). `DEFAULT` = Juan-revisable. Subagents implement
> exactly this; concerns come back to Fable, do not improvise.

## 0. Build-level decisions (Fable rulings, this spec)

- **Indexer**: custom viem-based (05 permits "Ponder or equivalent"), mirroring `genesis/` patterns
  (injected deps, better-sqlite3, resumable cursor, vitest). **SQLite is the dev/testnet DEFAULT**;
  the db seam stays narrow enough that a Postgres adapter is a deploy-time task, noted in BUILD-STATE
  (05 names Postgres for hosted deploys — not reopened, deferred).
- **API**: plain `node:http` JSON endpoints (no framework dep), same discipline as the runtime's
  chat server. CORS `*` for GET.
- **web/**: Next.js (App Router) + TypeScript + Tailwind. wagmi/viem + a minimal injected-wallet
  connect button are INSTALLED and wired but nothing in this slice requires a wallet (profile/
  directory are read-only). No RainbowKit yet (heavy; revisit at launch-flow slice).
- **Tier badge (indexer approximation)**: the true tier is runtime-internal (runway). The site
  derives from on-chain data only: `live` = lastHeartbeat within `3 × caps.daemonIntervalSec`
  fallback 1800 s when unknown `DEFAULT staleAfterSec 1800`; `stale` = older than that but within
  REVIVAL_WINDOW; `evicted` = older than REVIVAL_WINDOW (7 d, read from the registry constant);
  `pending` = launch row exists, not registered. Label it "status" in the UI, not "tier" (bounded
  honesty — we don't know runway from chain).
- **No server-side custody, no secrets in web/ or indexer/** — both read public chain + public
  Arweave only. State the convenience-layer disclaimer (05 header) in the site footer.

## 1. `indexer/` package (new top-level, `npm`-workspaced like genesis)

Layout (mirror genesis/):

```
indexer/
├── package.json          # name "agent-indexer", type module, deps: better-sqlite3, viem, zod, tsx; dev: vitest, @types/*
├── tsconfig.json         # copy genesis/tsconfig.json
├── vitest.config.ts
├── src/
│   ├── config.ts         # zod: chain rpc URL(s), contracts (from deployments manifest path like genesis), dbPath, port, pollMs DEFAULT 3000, balanceRefreshSec DEFAULT 300, arweave { graphqlUrl DEFAULT "https://arweave.net/graphql", gatewayUrl DEFAULT "https://arweave.net", enabled DEFAULT true }, staleAfterSec DEFAULT 1800
│   ├── abi.ts            # transcribed events (source-cited like genesis/src/abi.ts): AgentRequested, AgentLive, AgentCancelled, AgentGraduated (factory, ILaunchpad.sol:143-146); GenesisOpened, InstanceRegistered, Heartbeat (registry, ILaunchpad.sol:20-24); PoolRegistered, FeeCollected, Distributed (hook, ILaunchpad.sol:97-101); Credited, Claimed, Emancipated (distributor, ILaunchpad.sol:48-50); Bought, Sold, Graduated (curve, ILaunchpad.sol:70-72); Poked (buyback, ILaunchpad.sol:126); PoolManager Swap (v4-core IPoolManager.sol:90-99); NFT Transfer; + view fns: instanceOf, isRegistered, REVIVAL_WINDOW, tokenOf, curveOf, agentCount, erc20 balanceOf/totalSupply
│   ├── db.ts             # better-sqlite3 wrapper, WAL, migrations-in-code (genesis db.ts pattern). Tables:
│   │                     #   cursor(k,v)                              — watcher block cursor + meta
│   │                     #   agents(agentId PK, name, symbol, imageURI, creator, configHash, token, curve, poolId, state, requestTx, requestBlock, createdAt)   — state: requested|live|cancelled|graduated  (from factory events; name/symbol from pendingAgent() at ingest or AgentLive read of token)
│   │                     #   instances(agentId PK, treasuryEOA, actionEOA, codeHash, attestationRef, lastHeartbeat, generation)  — upsert from InstanceRegistered + Heartbeat (+ periodic instanceOf reconcile)
│   │                     #   events(id PK autoinc, agentId, kind, txHash, blockNumber, ts, data JSON)  — normalized activity feed rows (every decoded event lands here with its agentId when resolvable; poolId→agentId via pools)
│   │                     #   pools(poolId PK, agentId, agentToken)     — from hook PoolRegistered
│   │                     #   swaps(txHash+logIndex PK, poolId, agentId, ts, blockNumber, amount0, amount1, sqrtPriceX96)  — PoolManager Swap filtered to known poolIds
│   │                     #   trades_curve(txHash+logIndex PK, agentId, side, usdg, tokens, fee, ts)  — Bought/Sold (curve address→agentId via curveOf at ingest)
│   │                     #   fees(agentId, poolId, buybackLeg, treasuryLeg, royaltyLeg, ts, txHash)  — Distributed
│   │                     #   balances(agentId PK, treasuryUsdg, treasuryRhEth, actionUsdg, actionRhEth, actionToken, updatedAt)  — RPC refresh loop (rh chain only, this slice)
│   │                     #   journal(itemId PK, agentId, ts, kind, text, raw JSON, fetchedAt)  — enrichment (§3)
│   │                     #   journal_owner(agentId PK, owner)          — pinned Arweave owner per agent (§3 trust chain)
│   ├── watcher.ts        # viem getLogs poller, one address-set query per poll, cursor-resumed, per-block orderly ingest; injectable clock+client (genesis watcher.ts discipline). Never throws out of the loop; per-poll try/catch + LOUD warn + backoff.
│   ├── derive.ts         # pure functions (unit-tested): status(instance, now, revivalWindow, staleAfterSec); price from latest swap (sqrtPriceX96 + token/USDG ordering via pool key sides — document the token0/token1 resolution) fallback last curve trade; volume24h(swaps+curve trades, now); mcap = price × totalSupply (totalSupply cached on agents row at ingest); feeTotals per leg
│   ├── enrich.ts         # journal fetch job (§3), injectable HTTP
│   ├── api.ts            # node:http server: GET /api/agents, /api/agents/:id, /api/agents/:id/activity?limit, /api/agents/:id/journal?limit, /api/status (cursor lag, counts). JSON, bigints as strings, CORS GET *, 404/400 on bad ids. No mutation endpoints.
│   └── main.ts           # config load → db → start watcher loop + balance refresh loop + enrich loop + api; SIGINT clean close
└── test/                 # vitest: derive.test.ts (pure fns, incl. sqrtPrice golden), db.test.ts (migrations + upserts idempotent), watcher.test.ts (mock client: event batch → rows, cursor resume, reorg-tolerant re-scan window 30 blocks), api.test.ts (real http against temp db), enrich.test.ts (mock gql/gateway: discovery→pin→fetch→verify; bad item skipped LOUDLY)
```

Rules: no floats in money math (bigint end-to-end; format at the API edge as strings); every
external read behind an injectable seam; `npm run typecheck && npm test` green required.
Reorg handling: re-scan a trailing window of 30 blocks each poll `DEFAULT`; event rows upsert by
(txHash, logIndex) so re-ingest is idempotent.

## 2. `web/` package (new top-level)

Next.js 15 App Router, TS strict, Tailwind; `INDEXER_URL` env (server-side fetch, no client CORS
dependence). Dark theme default, mobile-first (05 §6). NO secrets.

Pages (05 §1, this slice only):
- `/` Directory: agent cards — image (fallback identicon from agentId), name, symbol, status badge
  (§0 wording), mcap, 24h volume, treasury USDG, generation. Sort: newest | mcap | volume. Server
  component fetching `/api/agents`; revalidate 30 s.
- `/agent/[id]` Profile: header (name, symbol, status, generation, addresses with copy buttons,
  token + explorer links); stat row (price, mcap, 24h vol, treasury USDG, action USDG, fee totals
  per leg); **Journal feed as the page's centerpiece** (D17): reverse-chron cards (ts, text,
  Arweave item link "permanent ↗"), `/api/agents/:id/journal`; empty state: "No journal entries
  published yet — this agent's feed is written to Arweave, permanently, by the agent itself."
  Below: Activity feed (swaps/trades/fees/heartbeats/registrations from `/api/agents/:id/activity`,
  humanized rows + tx links). Attestation/Chat/holders tabs = later slices; render disabled tab
  stubs labeled "soon" so the layout is honest about what's coming.
- Footer (site-wide): convenience-layer disclaimer (05 header sentence, verbatim), link to repo.
- Explorer links: testnet explorer base URL in config with a safe fallback to raw tx hash text if
  unset `DEFAULT ""`.

Wallet: wagmi config + injected connector + a header ConnectButton (address truncation only). No
gated functionality this slice.

Fixtures dev mode: `INDEXER_URL` unset ⇒ pages render from `web/fixtures/*.json` (one agent with a
rich journal, one pending, one evicted) so UI work needs no chain. Fixtures match API shapes
EXACTLY (typecheck via shared `web/lib/types.ts` — keep API types duplicated there deliberately;
no cross-package import into the Next bundle).

## 3. Journal → Arweave (runtime, ADDITIVE) + indexer trust chain

Runtime (small, own commit; version bump shared with next release):
- `TurboKind` gains `"journal"`. New `TurboJournalSink implements JournalSink` (attestation/turbo.ts):
  `write(entry, now)` uploads UTF-8 JSON `{v:1, agentId, ts, text}` with `turboTags("journal",
  agentId, now)`; plaintext, expected ≪100 KiB (free tier). Boot wires it (like fcSink) ONLY when
  `runtime.arweave.enabled && runtime.tee`, WRAPPING memoryJournalSink so local rows remain the
  audit source (mirror-first: memory write succeeds even if upload fails; upload failure = warn,
  entry queued nowhere — next entries still try; journaling is best-effort on Arweave, guaranteed
  locally). J1 caps and the K4-adjacent gates unchanged — this is a sink swap, zero policy change.
- Tests: sink uploads exact bytes+tags (MockUploader); boot wiring on/off matrix; upload failure ⇒
  memory row still written + warn.

Indexer discovery/trust chain (enrich.ts):
1. Per agent with a registered instance: pin the Arweave **owner** once — **rev 1 (Fable ruling
   2026-09-28, closes the pin-spoof hole found in review): the ONLY pin source is the item whose
   id EQUALS the on-chain `instance.attestationRef`** (fetched by id, no tag query for pinning;
   attestationRef must look like an Arweave item id — 43-char base64url — else no pin) AND whose
   JSON payload `eoas.treasury` equals the agent's registered treasuryEOA (case-insensitive; the
   report is the top-level JSON, runtime attestation.ts:70/94). Anyone can upload arbitrary
   tagged items, but only the agent (registering from inside the enclave) controls attestationRef,
   so the chain anchors the pin. Until attestationRef resolves to such an item, journal items are
   ingested UNPINNED and marked `unverified: true` in the API row (UI renders a subtle
   "unverified" chip).
   Once pinned, only pinned-owner items are ingested and prior unverified rows from other owners
   are deleted. (Live agents today have no Arweave items at all — the pin path activates on the
   first arweave-enabled agent; until then the fixture path covers UI.)
2. Fetch item data via gateway (follow ONE redirect to `*.arweave.net`, the turboHttp rule), parse
   JSON `{v:1, agentId, ts, text}`; reject (LOUD, skipped) on: agentId mismatch, non-JSON, text >
   4096 chars (render cap), ts outside [item block time − 1d, + 1d] when block time available.
3. Poll every `enrichSec DEFAULT 120`, incremental via GraphQL cursor per agent.

## 4. Ops / dev commands

- `indexer`: `npm start -- --config indexer/e2e/testnet.json` (config committed, points at RH
  testnet RPC + deployments manifest `contracts/deployments/testnet-46630.json`, dbPath
  `indexer/e2e/data/indexer.sqlite` gitignored, startBlock = deployedAtBlock from manifest —
  historical backfill in chunked getLogs of 10k blocks `DEFAULT`).
- `web`: `npm run dev` (fixtures) / `INDEXER_URL=http://localhost:8425 npm run dev` (live). API
  port `DEFAULT 8425`.
- Root README gains a two-line "run the site" section. No CI changes this slice.

## 5. Acceptance (Fable review gate)

1. `indexer`: typecheck + tests green; started against RH testnet it backfills agents 2/3/4/5/6/7
   (5 shows cancelled/pending state per its failed launch), instances rows carry the real EOAs,
   agent 7 shows the 2026-09-28 pool swap (tx `0xc6f5e3e0…85d0`) in swaps + activity, fee row from
   the FeeSplitHook leg if Distributed fired (else pendingFees ignored — events only), balances
   populated.
2. `web`: builds; directory renders live agents from the local indexer; agent-7 profile shows the
   swap in activity, correct addresses, status badge consistent with heartbeat age; journal feed
   renders fixtures in dev mode and the empty state against live (no Arweave items yet).
3. Runtime journal sink: tests green, no policy-path diffs (`npm test` full suite).
4. No new prod deps beyond: better-sqlite3/viem/zod (indexer), next/react/tailwind/wagmi/viem
   (web). Anything else needs a Fable ruling first.
