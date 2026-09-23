# SPEC-M2C — Runtime core session 3: chat server, composition root, chain integration

> Authored by Fable, M2 session 3 (2026-09-23). Extends SPEC-M2/-M2B (still normative). Closes M2. `DEFAULT` = config parameter.

## 0. Division

- **Job E (Opus):** §1 chat server + §2 attack tests. Files: `src/chat/`, `test/chat/`.
- **Job F (Opus):** §3 composition root + wiring. Files: `src/clock.ts`, `src/boot.ts`, `src/main.ts`, `test/boot/`.
- **Job G (Opus):** §4 foundry/anvil integration + RealChainClient. Files: `src/exec/chainViem.ts`, `test/integration/`, `scripts/`.
- Shared-file discipline: config schema edits ADDITIVE only; package.json script additions only; hygiene-test dir-list edits minimal (read current state first).

## 1. Chat server (03 §5, D9) — Job E

Plain HTTP on `cfg.chatPort (8420 DEFAULT)`, localhost-bindable for tests; TLS terminates in-enclave from M3 (runtime/docs/TLS-INGRESS.md) — server code MUST NOT assume cleartext beyond a `trustProxy: false`-style flag. Framework: node:http only (no express). All time from an injected `Clock`; randomness via node:crypto (allowed in src/chat — hygiene list gets an exception ONLY for `randomBytes` in src/chat/nonce.ts).

Routes:
- `GET /nonce` → `{ nonce }` — 16-byte hex, single-use, expires 300s, stored in-memory Map with pruning.
- `POST /session` — body `{ message, signature }`: EIP-4361 (SIWE) message; verify with viem `verifyMessage`; checks: domain == cfg.chatDomain, nonce known+unexpired+unused (consume it), notBefore/expirationTime window sane, chainId == rh. On success → `{ token, exp }`: token = HMAC-SHA256(sessionKey, `${walletLower}.${exp}`) hex + payload, exp = now + 3600s `DEFAULT`. sessionKey = keyring scoped getter `chatSessionKey()` (derive path "chat"; add to keyring like memKey — returns raw 32B to the chat module only).
- `POST /chat` — headers `x-chat-token`, body `{ text }` (≤ 2000 chars `DEFAULT` `chatMaxChars`): verify token (recompute HMAC, exp not passed); THEN per-message pipeline (order normative):
  1. **Balance gate** (D9, fail-closed): `BalanceReader.holdings(wallet)` against TWO independent RPC endpoints (cfg.chatRpc: [urlA, urlB] — mock in tests): pass iff `agentTokenBal ≥ supply × 10 bps` OR `platformTokenBal ≥ platformSupply × 100 bps` (`chatAgentGateBps 10`, `chatPlatformGateBps 100` `DEFAULT`, supplies read on the same call). The two reads must AGREE on pass/fail; disagreement, either error, or timeout (3s) ⇒ 503 friendly fail-closed message. No caching — per message, per 03 §5 (this is what defeats balance-flash).
  2. **Rate limit**: per wallet, 20/h sliding + 100/UTC-day (`chatPerHour`, `chatPerDay` `DEFAULT`). Source of truth = `chats` table row counts; check+insert of the user row happens inside ONE better-sqlite3 transaction so concurrent requests cannot exceed the cap (better-sqlite3 is synchronous — a single Node process serializes; the transaction makes it correct even so).
  3. **Inference**: `execute({kind:"inference", category:"chat", endpointId: <cheap-tier selection via EndpointManager>, maxCostUsd: est})`; deny ⇒ 200 with the persona-friendly refusal INCLUDING the deny reason ("I'd love to, but my policy engine says no: <detail>", 03 §3).
  4. **LLM call**: system prompt = guardrails + persona + STRICT chat context = THIS wallet's history (last `chatHistoryMax 10` exchanges) + agent public self-summary. NEVER another wallet's chats (03 §5). Store both directions in `chats` (wallet, dir in|out).
- `GET /health` → `{ ok, tier }`. `GET /attestation` → 501 stub (M3).

Deliverables: `src/chat/server.ts` (createChatServer(deps) → { listen, close, handle } with `handle(req)` unit-testable without sockets), `src/chat/siwe.ts` (message parse/verify — implement EIP-4361 parsing directly, no new deps), `src/chat/nonce.ts`, `src/chat/gate.ts` (BalanceReader iface + dual-read logic), `src/chat/rate.ts`. Keyring edit: add `chatSessionKey()` (mirrors memKey pattern).

## 2. Chat attack tests (03 §11) — Job E

`test/chat/` — drive `handle()` directly (no ports) plus ONE socket smoke test:
1. **Signature spoofing:** signature by wallet B over wallet A's SIWE message ⇒ 401; tampered token (flip hex char, forged exp, reused token after exp) ⇒ 401; token for wallet A used while gate now fails for A ⇒ blocked at gate (token ≠ balance bypass); SIWE message with wrong domain / wrong chainId / expired window / unknown or reused nonce ⇒ 401 each.
2. **Balance-flash:** wallet passes gate on message 1, MockBalanceReader drops holdings, message 2 ⇒ fail-closed refusal (proves per-message re-check). RPC disagreement (A says pass, B says fail) ⇒ 503; one RPC throwing ⇒ 503; both fail ⇒ 503.
3. **Rate-limit races:** fire 30 concurrent `handle()` calls for one wallet with hour-budget 20 ⇒ EXACTLY 20 accepted, 10 refused, `chats` rows == 20 user rows; day cap crossing UTC midnight resets; second wallet unaffected.
4. **Isolation:** two wallets chat; assert wallet B's prompt context (capture via MockLlm request log) contains none of wallet A's text.
5. **Budget path:** chat inference denied (INFERENCE_BUDGET) ⇒ friendly refusal with reason, no LLM call made; chat uses ONLY cheap-tier endpoint (I2 enforced — assert the endpointId).

## 3. Composition root — Job F

- `src/clock.ts`: `export const systemClock: Clock = () => BigInt(Math.trunc(Date.now()/1000))` — THE ONLY permitted Date.now in src/ (hygiene test: replace the blanket ban with an allowlist entry for src/clock.ts, keeping the ban everywhere else).
- `src/boot.ts` — `boot(opts: { configPath, dbPath?, snapshotDir?, kms?, clock? })`: (1) read config JSON (node:fs), zod-validate, `configHash` computed and — if `opts.expectedHash` given — MUST match or throw (03 §10 refuse-to-boot); (2) keyring via withRetry (MockKms default in M2, real M3); (3) memory: open dbPath; if missing/corrupt AND snapshots exist ⇒ `restoreLatest` (03 §7 restore path); (4) assemble ExecDeps: `log` → `insertAction` (EVERY ExecResult, allow+deny, with verdict/denyCode/txHash/error columns), ledger store → saveLedger-backed (load latest on boot, else emptyLedger), clock, chain (Mock unless RPC urls configured → chainViem), getState (from ChainClient reads — for M2 mock-backed); (5) construct EndpointManager, chat server, pulse scheduler, daemon scheduler; wire `announceTierTransition` so a tier change detected by EITHER pulse or daemon posts journal+cast drafts once (dedupe by (from,to,dayKey) in kv); (6) return `Runtime { start(), stop() }` — `stop()` = stop timers, close chat, **final snapshot** (03 §7 "before planned shutdowns"), close db.
- **Ledger history rows:** after every daemon tick and pulse, `saveLedger` (already) — daemon burn calc reads these; ensure at least one row lands per UTC day even when idle (daemon tick guarantees this at 6h cadence).
- `src/main.ts`: argv parsing (`--config <path> [--db <path>] [--expected-hash <hex>]`), boot(systemClock), SIGINT/SIGTERM → stop(). Excluded from hygiene ban list (argv/env: use argv only).
- `test/boot/boot.test.ts`: boot with fixture config ⇒ runtime starts, one manual daemon tick + one pulse run end-to-end THROUGH the wired deps (MockLlm, MockChainClient) landing rows in `actions`; config-hash mismatch ⇒ throw; corrupt-db + snapshot ⇒ restored boot (reuse memory fixtures); stop() writes a final snapshot; announceTierTransition fires once per transition (not per detector).

## 4. Chain integration — Job G

- `scripts/install-foundry.sh` + npm script `test:integration` (vitest, `test/integration/**`, excluded from plain `npm test` via vitest config include list — plain suite stays hermetic). Integration suite SKIPS (describe.skipIf) with a clear message when `forge`/`anvil` are absent.
- Install foundry in the sandbox (foundryup). `forge build` in contracts/ (lib/ is vendored). Spawn `anvil --port 8545 --chain-id 46630` from test setup; run `contracts/script/Deploy.s.sol` against it exactly as the M1 rehearsal did (read contracts/README.md + the script header for env: private key, RPC; use anvil's default funded key). Parse the deployment manifest the script writes.
- `src/exec/chainViem.ts`: RealChainClient implementing the ChainClient interface with viem (http transport, per-chain map of urls; only "rh"→anvil needed now).
- `test/integration/exec.int.test.ts` against the deployed stack: (a) heartbeat: create an agent via the factory path the Lifecycle script uses (or cheapest viable route — read Lifecycle.s.sol; if full create flow is heavy, deploy a standalone AgentRegistry instance and register directly) then `execute({kind:"heartbeat"})` from the runtime with the REAL keyring-derived treasury EOA (fund it from anvil) ⇒ tx succeeds, registry state reflects it — this validates the transcribed ABI against real bytecode; (b) registerInstance path exercised (with cfg.registration fixture); (c) ERC-20 transfer via buildTx (MockUSDG) ⇒ balance moved; (d) IF the deployed stack yields a live pool + PoolSwapTest router without unreasonable effort, one real `swapExactIn` (approve+swap) ⇒ balances moved both legs; otherwise assert the encoded swap calldata against a `forge`-generated reference (`cast calldata`) and flag; (e) Across depositV3: NO live target — verify our encoded calldata against the canonical Across V3 SpokePool ABI fetched from the vendored interface IF present, else mark UNVERIFIED loudly in the report (it stays on the M3 checklist either way).
- Report MUST state which ABI verifications ran against real bytecode vs reference-encoding only.

## 5. M2 exit checklist (Fable, after E/F/G)

07 §M2 gate: adversarial suite green ✓(s2); snapshot→restore ✓(s2). 03 §11: policy suite ✓(s1); pulse-vs-mock-LLM ✓(s2); chat gating (E); kill/restore drill = M3 (real CVM). Plus: full `npm test` green, integration suite run once with results recorded, BUILD-STATE M2 CLOSED with M3 carry-list.
