# SPEC-M4C — M4 third slice: chat tab (05 §1/§4, D9) + chat-server CORS (runtime v0.1.7)

> Authored by Fable, M4 session 12 (2026-09-29). Scope: one ADDITIVE runtime change (chat-server
> CORS — without it 05 §4's "browser → CVM directly" is structurally impossible), the web chat
> tab, and the live drill plan (agent 9). Decisions cited: D9 (holders-only gate), D13 (injection
> as a feature — the notice), D14 (agent DNS), 05 §4 (no platform relay — chats never transit
> platform servers). `DEFAULT` = Juan-revisable. Subagents implement exactly this; concerns come
> back to Fable.

## 0. Build-level rulings (Fable)

- **R1 (CORS shape):** `Access-Control-Allow-Origin: *` on EVERY chat-server response (success
  and error alike), plus `Access-Control-Allow-Headers: content-type, x-chat-token`,
  `Access-Control-Allow-Methods: GET, POST, OPTIONS`; `OPTIONS <any known route>` ⇒ 204 with
  those headers + `Access-Control-Max-Age: 600`, no auth, no body. Wildcard is correct here: no
  cookies or ambient credentials exist — the session token is an explicit header, the gate is
  balance-based, and the endpoint is public by design. `trustProxy` stays false; no other
  behavior changes.
- **R2 (no relay, ever):** the web app never proxies chat. All chat traffic is browser →
  enclave. No Next API route may touch /nonce, /session, or /chat. (The launch-helper proxy
  precedent does NOT extend here — 05 §4 is explicit.)
- **R3 (endpoint resolution):** default endpoint = `https://a<agentId>.<NEXT_PUBLIC_AGENT_DNS_ROOT
  DEFAULT "vivarium.systems">` (D14). The tab offers an "agent endpoint" override (advanced
  field, also settable via `?endpoint=` query param) for drill agents and self-verifiers —
  consistent with the convenience-layer stance. Overrides live in component state only (no
  storage). http:// overrides are allowed (drills); the UI labels non-TLS endpoints "unencrypted
  (drill)".
- **R4 (honest eligibility):** the CVM's own responses are the only eligibility truth (403
  insufficient / 503 unavailable / 200). The banner explains the D9 rule (≥0.1% of the agent
  token, or ≥1% of $TOKEN) and, when the indexer knows the agent's token, shows the connected
  wallet's balance of it (client-side read) — labeled "indicative: the agent checks its own
  frozen config inside the TEE". No client-side pass/fail verdict.
- **R5 (drill gate wiring, documented trick):** drill agents that must exercise the gate freeze
  `agentTokenAddress` = an EXISTING graduated token (agent 9 → DRILL1
  `0x308ceBcf8258a91DE06ddF1194dE82b04B72a1b4`, drill wallet holds 8959 bps ≥ 10 bps). This is a
  drill-only config trick (production configs get their own token at graduation); note it in the
  agent's persona/journal copy so nobody reads it as production behavior.
- **R6:** no new prod deps. The SIWE message the tab builds MUST byte-match what
  `runtime/src/chat/siwe.ts` verifies — read that file and mirror its grammar exactly; a golden
  cross-test pins it (below).

## 1. Runtime (ADDITIVE) — chat-server CORS, v0.1.7

- `src/chat/server.ts`: per R1. OPTIONS handling lives beside the existing method/route table
  (unknown path ⇒ 404 as today; known path + OPTIONS ⇒ 204 preflight). All existing responses
  gain the CORS headers via one helper (single place).
- Tests ("M4C §1: …"): preflight 204 + exact headers on every route; headers present on 200,
  400, 401, 403, 429, 503, 501 responses; unknown-route OPTIONS 404; no other header/behavior
  drift (pick two existing golden responses and assert byte-equal bodies).
- `package.json` 0.1.6 → 0.1.7. Release flow after merge: tag `runtime-v0.1.7` → CI → verify
  digest A==B==registry → `scripts/release.sh` with `--agent-id 9 --config-hash <agent-9 hash>`
  → commit releases/v0.1.7.{yml,json}.

## 2. web/ — chat tab (`/agent/[id]/chat`, replaces its TabStub)

- **Connect step:** existing injected connector. Disconnected ⇒ explain + connect button.
- **Health probe:** GET `<endpoint>/health` (browser-side). Unreachable ⇒ tier-appropriate
  message per 05 §4 using the indexer status ("dormant — holding ≥0.1% will be honored when it
  wakes" for stale/evicted; "unreachable" + endpoint hint for live). Reachable ⇒ show tier.
- **SIWE session:** GET /nonce → build the SIWE message per R6 (domain = the ENDPOINT's host,
  uri = the endpoint origin, chainId 46630, version "1", issuedAt from Date, nonce verbatim) →
  wagmi `signMessage` → POST /session → keep `{token, exp}` in memory; 401 replies and token
  expiry surface a "session expired — sign again" re-auth affordance.
- **Eligibility banner (R4):** rule text, indicative balance when available, D13 notice
  VERBATIM: "This agent is autonomous; social-engineering its action wallet is part of the game;
  its survival wallet is out of reach."
- **Chat UI:** session-local transcript (the server keeps per-wallet history for its own context;
  no history endpoint exists — say "history lives inside the enclave; this view is this
  session"). Input capped at 2000 chars client-side (server chatMaxChars). POST /chat with
  x-chat-token; render `{reply}`; refusal bodies (200 with refusal text) render as normal agent
  replies.
- **Error mapping:** 400 (shape/length) inline; 401 re-auth; 403 insufficient ⇒ banner state
  "not eligible"; 429 ⇒ meter turns into a countdown from `retryAfterSec`; 503 ⇒ "balance gate
  unavailable — the agent fails closed". Rate meter: optimistic per-session sent-count plus the
  server's 429 truth; label the caps (20/hour, 100/day DEFAULTs) as defaults, not readings.
- **Fixtures mode:** an in-tab mock endpoint (no network) scripting: happy flow, 403, 429 with
  countdown, 503, expired-token re-auth. Fixtures walkable without wallet via a "simulate"
  affordance like the launch flow's.
- **Golden SIWE cross-test:** a vitest in web/ (or a small node script under web/test/ if no
  vitest is set up — match existing conventions; if web has NO test runner, put the golden in
  `runtime/test/chat/` instead: build the message with the web's builder copied inline and
  assert `verifySiwe` accepts it) — the point is ONE test that fails if the two grammars drift.
- Build + tsc green; no null/NaN leakage.

## 3. Drill plan (operator steps, Fable-driven — not subagent scope)

Agent 9 on v0.1.7: frozen config = agent-8 shape with agentId 9, chat persona, R5 gate wiring
(agentTokenAddress = DRILL1), chatRpc = [rh public RPC ×2], arweave on. createAgent (fee 75
MockUSDG) → pre-seed (85 USDG, 0.0002 rh preGas, 0.1 base USDC) → deploy (v0.1.7 compose,
3072/512) → verify → script-driven live proof: CORS preflight via curl; /nonce → SIWE (drill
wallet, viem) → /session → /chat 200 reply (gate pass at 8959 bps, dexl-free inference); fresh
empty wallet ⇒ /session ok, /chat 403 insufficient (deny proof); 429 after burst (optional).
Web tab pointed at the live endpoint via R3 override for a rendered-page check (server-fetch
pages render; the in-browser wallet click-through is out of sandbox reach — noted, Juan can run
it from his machine against the same endpoint while the rental lives if he wants). Stop +
withdraw --max after.

## 4. Out of scope (recorded)

Chat history endpoint; holders table (its own slice); production TLS endpoint drill (needs a
registered vivarium.systems A record — the ACME path is already live-proven, s3 item 4); mixed
production UI copy for non-TLS overrides beyond the label; NSF quote re-verification and the
other M4C candidates listed in BUILD-STATE (naming: those move to M4D).
