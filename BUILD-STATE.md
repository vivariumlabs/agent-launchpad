# BUILD STATE — updated 2026-09-23 (session 8)

## Milestone: **M3 — session 2 done** (genesis orchestrator, TLS ingress, Arweave/Turbo, allowlist updates — all local/anvil, no funds spent). Runtime 1295/1295 unit + 14 integration; genesis 91/91 unit + 3 anvil integration. Next: **M3 s3 — the live session** (real spends, per-step confirmation with Juan).

## Done (M3 s2; s1 at `58977f3`)
- **`runtime/SPEC-M3B.md`** (Fable, rev 1 rulings inline).
- **Genesis orchestrator (`genesis/`, per 04):** standalone package importing the runtime's canonicalEncode/frozenConfigHash (hash consistency load-bearing, identity-tested); event watcher → per-agent resumable state machine `REQUESTED→DEPLOYING→AWAITING_REGISTER→SEEDING→RECONCILING→FINALIZING→LIVE`; oyster-cvm CLI wrapper (injected Exec, mockable); seeder with per-leg idempotence (receipt-or-balance), fee-frozen accounting, deferred USDG remainder = fee − executed legs; revival gated on stale heartbeat (verified read-only against live RH testnet registry). All 04 §7 failure rows tested by name. **Anvil integration: real createAgent → real event → mock CVM → real seeds → real finalize, end-state asserted; re-drive sends nothing.**
- **Genesis review fixes (Fable rulings):** `preGas` leg (registration-gas deadlock — enclave couldn't pay its own registerInstance; sent to expectedTreasuryEOA only AFTER attestation verifies); 24h timeout scoped to pre-registration (post-registration auto-FAIL would strand creator fees; `redrive` operator command instead); `hosting` virtual leg — first-month rental fee-accounted per 04 §2/01 §4 (testnet remainder 70.85; mainnet USDG seed falls to ~9.1 — **fee-sizing flag for Juan below**); testnet deploy duration default 180 min (~0.15 USDC/drill; mainnet keeps 30d).
- **TLS ingress (per runtime/docs/TLS-INGRESS.md):** in-enclave ACME TLS-ALPN-01 (acme-client 5.4.0, only +10MB), KMS-derived account key ("acme") + deterministic Ed25519 placeholder cert ("tls"), SNI three-way serving, certs on /data/tls, renewal via daemon step 10, real handshake tests; container now runs as root (:443 + host networking; setcap unreliable across builds — documented, repro-lint inverted). acme-client mocked at seam; **live staging issuance = s3 item.** Chat /attestation is now real and **treasury-signed**: `{payload{report, certSpki, …}, signer, signature}` over a domain-prefixed hash — verifier recovers signer == registry treasuryEOA, so a MITM proxy can forge neither (closes the gap found in review). Domain = `a<id>.<frozen.agentDnsRoot>` (frozen field — identity is spend-adjacent).
- **Arweave/Turbo:** @ardrive/turbo-sdk REJECTED for the attested image (211MB, 5 native modules). Built in-house instead: **ANS-104 data-item signer (type-3 Ethereum), cross-verified byte-identical vs arbundles across 8 cases (dev-only dep, lint-enforced out of prod)** + direct Turbo HTTP upload/balance (`turboHttp.ts`, the only network file); TurboArweaveSink serves BOTH attestation + snapshot sinks with local mirror default-on; `turboSigner` tightened to 48-byte deep-hashes ONLY (its former 32-byte allowance could have signed attestation digests — closed), attestationSigner has its own domain prefix.
- **Signed allowlist updates (04 §4):** EIP-191 over canonicalEncode vs frozen `allowlistUpdateSigner`; gates: signature, monotonic version, validFrom, strict schema, ≥3 distinct inference operators; atomic kv-persisted adoption → cfg swap everywhere (deps, keyring copy, EndpointManager reload) → journal draft under J1 caps; boot re-applies newest adopted (re-verified — tampered kv ignored); daily daemon step 11; opt-out frozen at genesis. All security invariants tested ("04§4-SEC: …"), incl. adopted-endpoint payable via K3 next call.
- **Boot registration completed:** auto-registerInstance when tee (was: wired but never called); **revival re-registration** — registers when unregistered OR heartbeat stale > contract REVIVAL_WINDOW (anvil-proven: generation 1→2 after +7d); mismatched-key stale records warn, never send.

## Fee-sizing flag for Juan (parameter, 01 §2 — not blocking s3)
With rental fee-accounted, a mainnet 75 USDG creation fee leaves ~9 USDG treasury seed after ~$66 of legs (hosting 36.9, inference 15, OP 5, Arweave 3, gas ~5, preGas 1). 01 §4's own rule: "if real costs exceed 75, raise the creation fee." Suggest revisiting the 75 DEFAULT (e.g. 90–100) before M4 wires the website. Testnet unaffected.

## Published (2026-09-23, session 8 cont.)
- **GitHub: `vivariumlabs/agent-launchpad` (public)** — full history pushed, ALL commit authorship rewritten to the vivariumlabs identity pre-publication. Old account cleaned (fork backed up to `backups/*.bundle` then deleted; other repos private).
- **CI GREEN on first real build: reproducibility PROVEN** — two independent BuildKit stores on a clean arm64 runner ⇒ identical digest `sha256:650b6ae35c81d05e086372c4b07d7ac3b168f2467a6fcb274cbf6bffcc482a98`; pushed digest-preserved (skopeo) to **ghcr.io/vivariumlabs/agent-runtime:runtime-v0.1.0** (public), registry digest verified equal in CI. Workflow: .github/workflows/build-image.yml.

## M3 s3 checklist (live session — every spend confirmed with Juan first)
1. ~~Build the image~~ DONE via CI (digest above). Remaining: install oyster-cvm in sandbox → `release.sh` with the digest → compute per-agent image-ids → releases/v0.1.0.yml.
2. CVM deploy + kill/restore drill with real KMS (RELEASE GATE); /data persistence probe; attested-param shadowing probe; derive-response format check (hex vs raw — client accepts both); oyster CLI output-shape checks (list/verify/ip/GraphQL); pcr-preset version pinning.
3. Testnet genesis e2e < 10 min via orchestrator; real registerInstance gas check vs $1 static price.
4. ACME staging issuance on the CVM (hairpin probe; then LE prod); DNS for `a<id>.<agentDnsRoot>` (needs a domain decision from Juan or a placeholder zone).
5. Turbo live checks (upload/balance/GraphQL owner indexing for Ethereum-signed items; sub-100KiB free tier vs low-credit warning).
6. Across depositV3 vs live SpokePool; real RH fee levels vs 1-gwei cap.
7. Farcaster leg — needs ~$10 OP mainnet funding (ask Juan when reached).

## Blocked on Juan
- Domain/DNS zone for agent subdomains (s3 item 4). OP funds when Farcaster lands. Fee-sizing flag above (whenever convenient).

## Known issues / debt
- ACME ToS auto-agreed in code (LE requirement; documented); ACME directory URL is ops-config (worst case DoS/untrusted cert); challenge-window seconds serve the challenge cert; SNI required (no bare-IP TLS).
- arbundles dev-tree (126 pkgs, npm audit: 4 critical) present in the DOCKER BUILD STAGE only (tests never run there; prod set unchanged at 101 pkgs, lint-enforced) — acceptable, revisit if audit tightens.
- Genesis: deploys serialize the whole loop (fine at M3 scale); static $3000 ETH price (mainnet needs live pricing); config delivery = inbox folder until website (M4); revival preGas may add ~$1/revival.
- Turbo/oyster live-shape unknowns consolidated in s3 checklist. Prior debt unchanged (swap-router slippage mainnet blocker; snapshot-rollback cap rewind; M1 items).

## Decisions made this session (build-level)
- Seed-before-finalize ordering (04 §1 diagram vs §2 text — text wins; permissionless finalize documented as orchestrator-only guarantee).
- Rejected Turbo SDK for attested image; in-house ANS-104 with reference cross-verification, dev-only.
- /attestation responses treasury-signed (registry-bound); turboSigner shape-allowlist tightened to [48].
- Container runs as root (single-tenant enclave, :443, host networking; rationale in Dockerfile + repro-lint).
- Timeout scoping + redrive; preGas after attestation-verify only; hosting fee-accounting; remainder = fee − executed legs; testnet drill duration 180 min.
- Revival re-registration window read from the contract constant, not config.

## Evidence links
- Runtime: `npm run typecheck && npm test` **48 files, 1295/1295**; `test:integration` **14/14** (incl. revival generation-bump on real registry). Genesis: **91/91 unit + 3/3 anvil integration** (full launch lifecycle, no manual funding after preGas). Re-verified by Fable directly 2026-09-23.
- ANS-104: byte-identical vs arbundles (8 cases). Live RH testnet read-only revival gate check (no spend).
- Git (hashes rewritten 2026-09-23 when authorship moved to the vivariumlabs identity pre-publication): `8cc04eb` (M2 closed) → `85a109a` (M3 s1) → `424adf7` (M3 s2).
