# BUILD STATE — updated 2026-09-23 (session 7)

## Milestone: **M3 — session 1 done** (TEE integration groundwork, all local, no funds spent). 1171/1171 unit + 13/13 integration green. Next: M3 s2 (genesis orchestrator, Turbo/Arweave sink, TLS ingress, allowlist-update verification), then s3 (live CVM drills + testnet genesis — real spends, per-step confirmation with Juan).

## Done (M3 s1; M2 closed at `c27b6ec`)
- **`runtime/SPEC-M3.md`** (Fable, incl. rev 1 rulings).
- **Reproducible image pipeline (trust-model artifact):** 3-stage arm64 Dockerfile, everything digest-pinned (base `node:22-bookworm-slim@sha256:f71fb9ca…`, dockerfile frontend, BuildKit v0.33.0, GH Actions by SHA); `npm ci --ignore-scripts` with NO lifecycle scripts at all — better-sqlite3 prebuilt fetched via `ADD --checksum=sha256:7bdf1d50…` (binary sha256 also recorded), mode-forced 0755; SOURCE_DATE_EPOCH scoped to image inputs; OCI rewrite-timestamp, provenance/sbom off; build/verify(build-twice-diff)/release/compute-image-id scripts (graceful degradation — NO docker in this sandbox, image not yet built: s3 item); repo-root CI workflow; REPRODUCIBLE-BUILD.md third-party procedure; 34-check repro-lint test (validated by 9 planted violations, all caught). Deterministic `dist/` verified locally (two builds byte-identical).
- **Key-binding security model settled after two review rounds (THE decisions of this session):**
  1. First pass had agent.json ATTESTED ⇒ any config edit (even an RPC URL) would re-derive keys and orphan the treasury. Reversed.
  2. Plain-unattested config opened the opposite hole: a redeploy (revival path, D10) with attacker config gets real keys + attacker payTo. **Final model: config split.** `agent.json` (FROZEN: platform addresses, x402 allowlist, caps, agent identity/persona — all spend authority) hash-attested via init param `config-hash:1:0:utf8:0x…` ⇒ **keys bind to (codeHash, agentId, configHash)**; modified frozen config ⇒ useless keys; revival supplies the Arweave-published original. `runtime.json` (ops: RPCs, ports, dirs) unattested + non-authoritative (lying RPC ⇒ waste within caps, never redirection). Boot: tee⇒`/init-params` pinned (an unattested initParamsDir could shadow the check — closed), config-hash init param mandatory ("no unbound TEE boots"), all checks before KMS/db touch. Init-param flags confirmed from Marlin docs: `path:attest:encrypt:type:value`.
- **Nautilus KMS client (real):** localhost-only enforced (IPv4-pinned, no DNS/redirects, refuses lookalike hosts), hex OR raw-32-byte responses, boot withRetry unchanged; MockNautilusServer test double.
- **Attestation module:** raw-quote fetch (:1300, no in-enclave parsing), canonical-JSON report (imageId, frozenHash, EOAs, base64 quote), LocalDirSink + TurboArweaveSink skeleton (NotFunded until s2), boot tee-path wires REAL registerInstance codeHash/attestationRef (loud warning while sink is local).
- **x402 HTTP transport (real, wired):** 402→quote-validate (payTo/asset/network/EIP-712 domain vs allowlist; every mismatch ⇒ unhealthy, nothing signed)→engine execute quote-aware (min(estimate, quote))→K3 auth→one paid retry; free-200 metered via new meterOnly execute mode; RUNWAY-only pure dry-run BEFORE any HTTP (Dormant = no LLM, even free); sanitized X-PAYMENT-RESPONSE settlement annotated onto the logged action row; https-only default; wired through boot into pulse+chat behind `runtime.x402.enabled`.
- **Inference salt (root fix):** optional 16-byte salt on inference actions (deterministic constructions per call site) ⇒ unique action hashes/x402 nonces; chat µUSD bump removed. **Estimate fix:** output-token allowance included (old formula would have price-rejected every real quote — caught by a full-output-quote test). publicSelfSummary wiring closed (pulse output → kv, guardrail line added).
- Boot cross-checks `/init-params/agent-id` == `agent-<agentId>` (canonical, unpadded). `--print-config-hash` CLI for operators; release.sh takes the hash as a value (single canonical-encode implementation, the runtime's).

## Operational wallet (Juan-provided, key in gitignored `.secrets/`)
`0x6930FD5C…0154` — 2026-09-23: Arb One 4.57 USDC + 0.00074 ETH; Base 4.99 USDC + 0.0003 ETH; RH testnet 0.0104 ETH; **OP mainnet 0** (Farcaster leg needs ~$8–12 when we get there). Covers s3 CVM drills + x402 tests without top-up.

## In progress / next steps
- **M3 s2:** genesis orchestrator (`genesis/` per 04: event listener, per-agent resumable state machine, oyster-cvm deploy wrapper, seeding + reconciliation, finalize, revival, failure table 04 §7) + tests; TurboArweaveSink real impl; TLS ingress (runtime/docs/TLS-INGRESS.md; decide :443-as-nonroot: root vs setcap vs high-port); 04 §4 signed allowlist-update verification (allowlistUpdatePubkey — currently unverified field); estimate/canary polish.
- **M3 s3 (live, confirm spends with Juan):** build+publish image (needs docker on Juan's machine or CI — sandbox has none), CVM deploy + kill/restore drill w/ real KMS (RELEASE GATE), testnet genesis e2e < 10 min, Farcaster (needs OP funds), verify Across depositV3 vs live SpokePool, real RH fee levels, /data persistence probe, attested-param shadowing probe, `--pcr-preset` version pinning if supported.

## Blocked on Juan
- Docker access decision for s3 image build (his machine, or push repo to GitHub for the ready CI workflow — note: arm64 runners free only for public repos).
- OP mainnet ~$10 when the Farcaster leg lands (s3, will ask then).

## Known issues / debt
- Image never actually built (no docker here) — Dockerfile untested against a real build; first build may need iteration (s3).
- Snapshot-rollback cap reset: an operator restoring an older snapshot rewinds the daily-cap ledger (~1 extra day's caps per rollback; requires host control; predates this session). Possible hardening: monotonic on-chain anchor (heartbeat ts vs ledger dayKey) — M4+ candidate.
- runtime.json-supplied `imageId` becomes registration.codeHash — a wrong one registers an unverifiable instance (caught only by external verification; document in ops runbook).
- Config files are public (encrypt=0): no keyed RPC URLs; `runtime.json:0:1` (encrypted) is the future option if needed.
- Paid-but-failed x402 retry: provider may settle the signed auth with no response delivered (counted as failure, never re-paid; bounded by per-call cap).
- Prior debt unchanged (swap-router slippage blocker before mainnet real-money swaps; M1 items).

## Decisions made this session (build-level)
- Key binding = (codeHash, agentId, frozenConfigHash); config split frozen/ops as above (supersedes 03 §10's single-file wording operationally; on-chain anchor at genesis = frozenHash).
- No lifecycle scripts in the image; prebuilt binary hash-pinned; compose command carries `--runtime` (CMD unchanged).
- Free-endpoint LLM calls: Dormant gate enforced BEFORE any network; metered like paid calls.
- agent-id canonical form `agent-<decimal>`; salt constructions deterministic (no new randomness).
- Deviation from Oyster docs (they recommend attesting config wholesale) documented with rationale in compose + REPRODUCIBLE-BUILD.md §5a.

## Evidence links
- `npm run typecheck && npm test`: **36+ files, 1171/1171 green**; `npm run test:integration`: **13/13** (2026-09-23).
- Repro-lint validated by 9 planted violations; x402 transport ordering asserted via MockHttp logs; boot attack-regression tests (forged config-hash shadow, non-localhost KMS, unbound TEE boot).
- M0/M1/M2 evidence unchanged. Git: `c27b6ec` (M2 close) → this commit.
