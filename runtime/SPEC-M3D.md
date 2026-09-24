# SPEC-M3D — Farcaster module + live-probe fixes (v0.1.4)

> Authored by Fable, M3 session 9 (2026-09-24), after the item 4-7 live probes. Decisions D15
> (snapchain hub allowlist; Neynar-keyed APIs never in the pipeline) and D16 (fname skipped, FID-only)
> are settled — do not revisit. The ON-CHAIN onboarding flow was live-proven today on OP mainnet
> (FID 3352486: IdGateway.register price 0.000075 ETH incl. 1 storage unit; KeyGateway.add with a
> SELF-signed SignedKeyRequestMetadata, requestFid = own fid — validator-verified). `DEFAULT` = config.

## 1. Live-probe fixes (runtime)

a. **turboHttp balance**: HTTP 404 ⇒ return 0n WITHOUT parsing the body (live body is plain-text
   "User Not Found"). Any other non-2xx or non-JSON stays an error.
b. **turboHttp download**: follow AT MOST ONE redirect, and only when the Location is https and its
   host ends with `.arweave.net` (the gateway 302s to a sandbox subdomain per item — live-proven).
   Everything else keeps `redirect: "error"`.
c. **buildAcrossDeposit quoteTimestamp**: `quoteTimestamp = now − ACROSS_QUOTE_SAFETY_SEC (60n)`
   (fillDeadline unchanged at now + 4h). Live-proven: a clock ahead of chain time reverts
   `InvalidQuoteTimestamp()` (0xf722177f) and would brick the bridge leg. K2 recomputes buildTx from
   approval.issuedAt, so signer and executor shift identically — no other change.
d. **T2 `arweaveFunding` repoint** (rules/treasury.ts): the leg becomes the LIVE Turbo crypto
   top-up: require `chain === "base"`, `asset === "ETH"`, `to === cfg.arweaveFundingAddress`
   (unchanged frozen field — its VALUE in real configs becomes Turbo's payment wallet, today
   `0x6A0A10FFD285c971B841bee8892878c0d583Bf67`; fixtures may keep fixture addresses). Caps and
   T0-exemption unchanged.

## 2. Turbo self-top-up (runtime; replaces the genesis "arweave" seed leg long-term)

Rationale: the Turbo payment service credits the SENDER of the payment tx, so genesis cannot top up
the agent's account from the funding wallet. The agent tops itself up from its own base ETH
(seeded by the base.eth leg). Genesis change: NONE (its arweave leg stays "skip if Turbo unfunded";
mark the log line "agent self-serves via daemon" — one-line genesis edit, optional).

- Ops config `runtime.turboTopUp`: `{ lowWatermarkWinc: bigintLike DEFAULT 50_000_000_000n,
  amountWei: bigintLike DEFAULT 500_000_000_000_000n (0.0005 ETH), enabled DEFAULT true when
  runtime.arweave.enabled }`.
- Daemon step 12 (daily, after snapshots): if arweave enabled AND `balanceWinc() < lowWatermarkWinc`:
  1. GET `<paymentUrl>/info` → `addresses["base-eth"]`; if ≠ `cfg.arweaveFundingAddress` ⇒ LOUD warn
     + skip (fail closed: never pay an unverified dynamic address).
  2. `execute({kind:"treasuryTransfer", purpose:"arweaveFunding", chain:"base", asset:"ETH",
     to: cfg.arweaveFundingAddress, amount: amountWei})` through the normal engine (T2 caps apply).
  3. On success: POST `<paymentUrl>/account/balance/base-eth` body `{tx_id}` (retry ≤5 × 15s while
     the service waits for confirmations; 202 = accepted). Log credited balance.
  All HTTP via the existing turboHttp seam (network allowlist already covers the file).

## 3. Farcaster module (runtime/src/social/)

### 3a. Message encoding — `fcMessage.ts` (pure, no network)

In-house protobuf encoder (varint + length-delimited only — ans104.ts discipline) for the SUBSET:
- `MessageData { type, fid, timestamp, network=1(MAINNET), body }` with bodies:
  `CastAddBody { text (≤ 320 BYTES utf8), parentCastId {fid, hash}? (castReply) }` and
  `UserDataBody { type, value }` (types: 2 DISPLAY, 3 BIO). Timestamp = FARCASTER_EPOCH seconds:
  `unix − 1_609_459_200` (uint32-checked).
- `Message { data_bytes, hash = blake3(data_bytes, dkLen 20), hash_scheme=1, signature,
  signature_scheme=1(ED25519), signer = fc pubkey (32B) }`. Serialize via `data_bytes` (not nested
  `data`) so hash covers exact bytes.
- blake3 from `@noble/hashes/blake3` — NEW direct dependency (pure JS/TS, no native modules; already
  in the tree transitively via viem's noble family; verify install size is trivial).
- **Cross-verification**: byte-identical vs `@farcaster/core` (DEV-ONLY dep, lint-enforced out of
  prod EXACTLY like arbundles) across ≥6 vectors: short cast, 320-byte cast, unicode/emoji cast,
  reply with parentCastId, DISPLAY UserDataAdd, BIO UserDataAdd. Hash + full Message bytes equal.

### 3b. K4 semantic change (keyring)

`signCastApproved` now signs `blake3_20(messageBytes)` (the FC hash) instead of raw messageBytes —
castPost/castReply/fcUserData are Farcaster-only. The K4 gate is UNCHANGED: approval required,
`keccak256(messageBytes) == action.contentHash`. Update K4 docs + existing tests accordingly.
Signature returned is the 64-byte ed25519 sig hex. Add scoped getter reuse: `fcPublicKey()` exists.

### 3c. Hub client + sink — `hubClient.ts`, `fcSink.ts`

- Frozen config additive optional: `platform.farcaster = { idGateway, keyGateway, idRegistry,
  keyRegistry, validator: addresses; hubs: [{id, url, operator}] (min 1); registerMaxWei: bigintLike
  DEFAULT 200_000_000_000_000n }`. ABSENT ⇒ whole module disabled (current behavior preserved).
- `hubClient`: POST `<hub.url>/v1/submitMessage`, body = serialized Message, content-type
  application/octet-stream, https-only (allowInsecureHttp for tests), 15s timeout, NO redirects.
  Try hubs in order; first 2xx wins; all fail ⇒ error (the draft stays queued/logged — casts are
  best-effort). Hygiene: network allowlist entry for the one fetch file.
- `fcSink` implements CastSink: `publish(action, messageBytes, sig)` — messageBytes IS the
  serialized MessageData (built by the caller, §3e); assemble Message{data_bytes, blake3-20,
  schemes, sig, signer=keyring.fcPublicKey()} and submit via hubClient. Boot wires it as the
  castSink when farcaster config present AND runtime.tee (else memoryCastSink stays; overrides win).
  Memory-log mirror: keep writing the draft row as today (sink wraps memoryCastSink first — casts
  remain auditable locally even when hub submit fails).

### 3d. On-chain onboarding — `fcOnboard.ts` + engine kinds + daemon step 13

- NEW ProposedAction kinds (treasury wallet, chain optimism, EXCLUDED from the LLM tool schema):
  - `{ kind: "fcRegister", priceWei: bigint }` → K2 builds `IdGateway.register(recovery = treasury)`
    with `value = priceWei`. T-rule: farcaster config present, `priceWei ≤ registerMaxWei`, target =
    frozen idGateway. T0-exempt.
  - `{ kind: "fcAddKey", key: Hex(32B), metadata: Hex }` → K2 builds `KeyGateway.add(1, key, 1,
    metadata)`, value 0. T-rule: farcaster config present, `key == keyring.fcPublicKey()`, target =
    frozen keyGateway. T0-exempt.
  - `chainsTouched`: both → `["optimism"]`. buildTx-consistency test covers them.
- Keyring: NEW scoped method `signFcKeyRequest(requestFid, key, deadline)` — EIP-712
  (domain: "Farcaster SignedKeyRequestValidator"/"1"/chainId 10/frozen validator address; type
  `SignedKeyRequest(uint256 requestFid,bytes key,uint256 deadline)`) signed by the TREASURY account.
  Narrow like turboSigner: refuses unless `key == fcPublicKey()`. Metadata ABI-encoding
  (tuple requestFid, requestSigner=treasury, signature, deadline) in fcOnboard (pure viem).
- Daemon step 13 (daily; only when farcaster config present + tee): state from kv `fc.fid`:
  1. fid unknown: read `idRegistry.idOf(treasury)`; 0 ⇒ read `idGateway.price()` (skip+warn if >
     registerMaxWei) ⇒ execute fcRegister ⇒ re-read idOf. Non-zero ⇒ kv `fc.fid`.
  2. fid known, key not added (`keyRegistry.keyDataOf(fid, fcPublicKey).state != 1`): deadline =
     now + 1h; sig = signFcKeyRequest; execute fcAddKey.
  3. key added, kv `fc.userDataSent` absent: queue DISPLAY UserDataAdd (= agent.name) through the
     normal engine as kind `fcUserData` (next bullet) and set the kv on success.
  All reads through deps.chain ("optimism"); every failure = warn + retry next tick (04 §7 row:
  agent live anyway, social pending).
- NEW social kind `{ kind: "fcUserData", contentHash, sizeBytes }` — fc wallet, pace cap
  `userDataPerDay DEFAULT 4` (social.ts, own counter in BudgetLedger like journalToday — ADDITIVE
  ledger field `fcUserDataToday` with G4 roll), K4-signed, published via fcSink like casts.
  `chainsTouched` → [].

### 3e. Cast building (pulse seam)

`buildCastAddData(text, fid, now)` / `buildCastReplyData(...)` / `buildUserDataAdd(...)` exported
from fcMessage.ts. The pulse's contentAction path gains fid injection: where castPost/castReply
extras.messageBytes are currently produced, produce serialized MessageData via these builders when
`kv fc.fid` exists; when it does not, keep TODAY's bytes (drafts stay local; hub sink refuses to
publish without a fid — logged, not an error). Minimal edit, do not restructure pulse.

## 4. Version + deps

runtime/package.json 0.1.3 → 0.1.4; `@noble/hashes` direct dep (pin exact); `@farcaster/core`
devDependency ONLY (repro-lint asserts it out of the prod tree, arbundles pattern).

## 5. Tests (names "M3D: …" / "M3D-fc: …")

1. §1a/b: balance 404-plain-text ⇒ 0n; download follows exactly one https *.arweave.net redirect,
   refuses http/other-host/second redirect. §1c: buildTx acrossBridge quoteTimestamp == now−60
   (adapt existing golden). §1d: T2 base/ETH/turbo-address allowed; rh/USDG now denied; wrong `to`
   denied.
2. §2: daemon step 12 — under-watermark triggers info-check → transfer → POST tx_id (MockHttp);
   address-mismatch skips LOUDLY, no spend; above-watermark idle; engine denies over-cap.
3. §3a: cross-verification vectors byte-identical vs @farcaster/core (≥6, incl. hash equality).
4. §3b: K4 signs blake3-20 (verify against the fc pubkey with noble ed25519); gate regressions.
5. §3c: hub rotation (first fails ⇒ second wins), all-fail error, octet-stream body is exact
   Message bytes; sink refuses without fid (logged); memory mirror row still written.
6. §3d: onboarding on mock chain: full flow → fid + key + userData kvs; idempotent re-run does
   nothing; register-price-over-cap skips; engine denies wrong target / wrong key / over-price;
   buildTx-consistency for the 2 new kinds; signFcKeyRequest refuses foreign keys; EIP-712 digest
   golden (recompute with viem hashTypedData).
7. Existing suites stay green; K4 and any castSink-shape tests adapted per §3b (list every change).

## 6. Out of scope (explicitly)

Live hub submission (needs the platform snapchain node — infra, next session); mentions/reads;
Farcaster testnet flag; genesis changes beyond the optional log line; embeds/mentions in casts.
