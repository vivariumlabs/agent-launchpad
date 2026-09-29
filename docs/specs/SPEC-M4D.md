# SPEC-M4D — NSM quote re-verification in the indexer (05 §5) + launch-tooling hardening

> Authored by Fable, M4 session 13 (2026-09-29). Motivated by the agent-10 finding (session 12):
> a runtime that self-reports a stale/wrong imageId passes ALL M4B report↔chain cross-checks —
> self-consistent misreporting is invisible without verifying the raw NSM quote. This spec closes
> R1's caveat: the indexer now verifies the quote itself. Sources of truth for the semantics:
> Marlin oyster-monorepo `sdks/rs/src/attestation.rs` (`oyster::attestation::verify` — what the
> CLI runs) and `sdks/ts/attestation/mod.ts` (reference TS impl), read 2026-09-29; live-oracle
> validation below. `DEFAULT` = Juan-revisable. Subagents implement exactly this.

## 0. Verified facts (Fable, live oracle 2026-09-29 — tests pin these)

- The report's `quote` field is base64 of the raw AWS Nitro attestation document: a COSE_Sign1
  CBOR array `[protected: bstr, unprotected, payload: bstr, signature: bstr]`; payload CBOR-decodes
  to `{module_id: tstr, digest: tstr, timestamp: uint (ms), pcrs: map<uint, bstr48>, certificate:
  bstr, cabundle: [bstr], public_key: bstr|null, user_data: bstr|null, nonce: bstr|null}`.
- **image-id formula** (attestation.rs:102-107): `SHA256( be32(0x00010007) ‖ PCR0 ‖ PCR1 ‖ PCR2 ‖
  PCR16 )` — the bitflags word `(1<<0)|(1<<1)|(1<<2)|(1<<16)` big-endian, then the four 48-byte
  PCRs from the doc's own pcrs map. No preset needed: the doc carries all four.
- **COSE**: protected header alg MUST be ES384 (-35). Sig_structure = CBOR-encode of
  `["Signature1", protected_bytes, empty bstr, payload_bytes]`; ECDSA P-384 / SHA-384, WebCrypto
  raw (r‖s) signature, verified with the LEAF certificate's public key (raw 96-byte x‖y = SPKI
  rawData minus its fixed 24-byte P-384 prefix).
- **Chain**: `[leaf = payload.certificate, ...cabundle reversed]`; for each adjacent pair:
  signature verify against issuer pubkey, issuer==subject linkage, validity window checked AT the
  DOC TIMESTAMP (so historical quotes verify — Nitro leaf certs live ~3 h). Root cert's raw
  pubkey must equal the pinned key below.
- **AWS_ROOT_KEY (pin, 96 bytes)** =
  `fc0254eba608c1f36870e29ada90be46383292736e894bfff672d989444b5051e534a4b1f6dbe3c0bc581a32b7b176070ede12d69a3fea211b66e752cf7dd1dd095f6f1370f4170843d9dc100121e4cf63012809664487c9796284304dc53ff4`.
  Provenance (three independent agreements): Marlin SDK constant (rs + ts), every live
  `oyster-cvm verify` run this project has done prints it, and the golden quotes' own cabundle
  roots carry it. Record this provenance in a comment at the pin.
- **Golden oracle runs** (`oyster-cvm verify --attestation-hex-file … --max-age 99999999999`):
  agent-8 quote (Arweave `iCt3c0kzoGZRzPfhy8XFae6pjuUVhTgFDrBlMciUUzs`) → image-id
  `f489dc609c6b33a7016c113f0965a46de35c4cfd2ef8e8f4751bd845923a4350` ✓ (== its registered
  codeHash); agent-10 quote (Arweave `mAPIQaMePShyIlLUV7mUx0xQ3PQaAXrdlBZVu6kk6nA`) → image-id
  `0558ac2879f92c1fd638d522552a81bbcc5ad8d7d543604567375a0d3fa9cc4a` ✓ (≠ its registered
  `f489dc60…` — the misreport). Both verified successfully with root key == pin.

## 1. Rulings

- **R1 (in-house, reference-mirrored):** no new prod deps. Implement a minimal CBOR codec +
  COSE_Sign1/ES384 verify (Node built-in WebCrypto `crypto.webcrypto.subtle`, exactly the
  reference's import/verify calls) + chain walk via `node:crypto X509Certificate` (`.verify()`,
  `.issuer`/`.subject`, `.validFrom/.validTo` — Node 22 supports all of it server-side). Follows
  the ans104/protobuf in-house precedent. The CBOR decoder handles the NSM subset (definite-length
  uints/negints/bstr/tstr/arrays/maps, null; 64-bit lengths within Number.MAX_SAFE_INTEGER) and
  REJECTS indefinite lengths and tags loudly. The Sig_structure needs a tiny CBOR ENCODER for
  `[tstr, bstr, bstr, bstr]` only.
- **R2 (fail semantics):** the quote checks run on report bytes already fetched — no new
  transport, so they are never `pending` (except pre-first-run). Missing/oversize/undecodable
  quote, bad COSE, bad chain, wrong root, expired-at-timestamp certs ⇒ `fail` (data property).
  Drill refs / unparseable report keep the existing skip cascade.
- **R3 (two new checks, appended to CHECK_NAMES):**
  - `quoteValid` — full verification per §0 (parse + COSE + chain + root pin). Detail records
    `trueImageId`, doc timestamp, module_id, and `rootKeyOk`.
  - `measurementMatch` — `trueImageId == instances.codeHash` (0x/case-insensitive). `skip` unless
    quoteValid passed. Detail records both values and whether report.imageId ALSO diverges (the
    self-report). This is the check that catches agent 10.
  - The summary/banner rules are UNCHANGED (alert = live agent with any fail). Agent 10 is stale
    ⇒ reported, no alert — correct.
- **R4 (no age policy):** registration-time quotes are historical by design. We verify at doc
  timestamp; no max-age check. Freshness remains the heartbeat's job.
- **R5 (web copy):** the attestation tab's caveat row is REPLACED: the quote signature IS now
  re-verified server-side (chain to the pinned AWS Nitro root; say so), while "verify yourself"
  stays (independent verification is the product). New check labels; fixtures gain the two new
  checks incl. one measurementMatch-fail agent.

## 2. indexer/ implementation

- `indexer/src/nsm/cbor.ts` — decoder per R1 (+ the tiny encoder). Pure, no deps.
- `indexer/src/nsm/quote.ts` — `verifyQuote(quoteBytes, {now?}) → {trueImageId: hex, timestampMs,
  moduleId, rootKeyOk: true} | throws QuoteError(reason)` implementing §0 exactly. AWS_ROOT_KEY
  pinned here with provenance comment. Async (WebCrypto).
- `verify.ts`: decode report.quote (quoteEncoding must be "base64"; missing ⇒ quoteValid fail
  "no quote in report"), run verifyQuote, populate the two checks per R3. `parseReport` gains the
  quote fields.
- `db.ts`: schema v4 — `ALTER TABLE attestation_checks ADD COLUMN quoteValid TEXT NOT NULL
  DEFAULT 'pending'` + same for `measurementMatch`; CHECK_NAMES + row type + upsert + toChecks
  extended. Existing rows re-verify on the next pass (verify loop already re-runs).
- API: nothing structural — the checks list simply grows (web accepts the list shape).

### Tests ("M4D §2: …")
- cbor: golden decode of each supported major type incl. 48-byte bstr map values; indefinite
  length ⇒ throw; tag ⇒ throw; trailing bytes ⇒ throw; encoder round-trips the Sig_structure
  prefix against known bytes.
- quote: BOTH live fixtures (commit `indexer/test/fixtures/agent{8,10}-report.json` — already
  fetched at /tmp/agent{8,10}-report.json in this sandbox, copy them) → trueImageId equals §0's
  oracle values, rootKeyOk; tampered byte in signature ⇒ fail; truncated ⇒ fail; alg != -35 ⇒
  fail; root key swapped expectation ⇒ fail; cert validity checked at doc time (fixture is
  months old and MUST pass).
- verify integration: agent-8 fixture ⇒ quoteValid pass + measurementMatch pass; agent-10 fixture
  with registered codeHash f489dc60… ⇒ quoteValid pass + measurementMatch FAIL, detail carries
  both ids; report without quote ⇒ quoteValid fail; drill ref ⇒ both skip; summary alert fires
  ONLY when such an agent is live.
- migration v4: v3 db upgrades, old rows get pending on new columns.

## 3. Launch-tooling hardening (small, bundled)

- `genesis/e2e/platform-template.testnet.json`: ADD `agentDnsRoot: "vivarium.systems"`.
  launch-helper's required-platform-keys list gains `agentDnsRoot` (agent-9 lesson: TLS-enabled
  boot throws without it; every production config must carry it).
- New `genesis/e2e/stamp-runtime.mts` (ops helper, agent-10 lesson): given an agents/<id> dir +
  release yml, runs compute-image-id (PATH oyster-cvm) and REWRITES runtime.json's `imageId` to
  the computed value, printing before/after — so a copied runtime.json can never carry a stale
  measurement again. Document in the file header that this is drill-ops tooling.
- Tests: launch-helper template validation rejects a platform missing agentDnsRoot
  ("M4D §3: …").

## 4. Acceptance (Fable review gate)

1. indexer typecheck + full suite green (was 88); zero existing tests modified.
2. Live run against the e2e db: agent 8 ⇒ 9/9 checks pass; agent 10 ⇒ quoteValid pass,
   measurementMatch FAIL (reported, no site alert since stale); agents with drill refs ⇒ skip.
3. web build green; attestation tab shows the two new rows + updated caveat; fixtures cover a
   measurementMatch failure.
4. genesis suite green with the template/validation change.

## 5. Out of scope

Live-endpoint freshness polling (needs endpoint discovery design); revoking/re-registering agent
10's stale codeHash (impossible until REVIVAL_WINDOW; tombstone note stands); PCR-preset pinning
for DEPLOY-time checks (BUILD-STATE open item, unchanged).
