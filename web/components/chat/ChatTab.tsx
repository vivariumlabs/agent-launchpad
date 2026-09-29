"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

import { ConnectButton } from "../ConnectButton";
import { Composer, RateMeter, Transcript, type TranscriptItem } from "./ChatWindow";
import { EligibilityBanner, type Eligibility } from "./EligibilityBanner";
import { EndpointPanel, type HealthState } from "./EndpointPanel";
import { liveTransport, parseEndpoint, type ChatTransport } from "@/lib/chat";
import {
  CHAT_SCENARIOS,
  DEMO_SIGNATURE,
  DEMO_WALLET,
  fixtureTransport,
  type ChatScenario,
} from "@/lib/chatFixtures";
import { CHAT_MAX_CHARS, RH_CHAIN_ID } from "@/lib/config";
import { truncateAddress } from "@/lib/format";
import { buildSiweMessage, siweFieldsForEndpoint, siweStatement } from "@/lib/siwe";
import type { AgentStatus } from "@/lib/types";

export interface ChatAgent {
  agentId: number;
  name: string;
  symbol: string | null;
  token: string | null;
  /** Agent-token base units integer string (indexer), null if unknown. */
  totalSupply: string | null;
  status: AgentStatus;
}

interface Session {
  token: string;
  /** Unix seconds (server clock). */
  exp: number;
  wallet: string;
  simulated: boolean;
  message: string;
}

type Auth =
  | { kind: "idle" }
  | { kind: "nonce" }
  | { kind: "signing" }
  | { kind: "verifying" }
  | { kind: "error"; message: string }
  | { kind: "expired"; message: string };

const SIWE_REASON_COPY: Record<string, string> = {
  SIWE_DOMAIN:
    "the agent's configured chat domain is not this endpoint's host — the endpoint may point at a different agent or domain",
  SIWE_CHAIN: "chain id mismatch — the agent does not accept Robinhood testnet (46630) sign-ins",
  SIWE_WINDOW: "the sign-in window was rejected — check your device clock and try again",
  SIWE_NONCE: "the nonce expired or was already used — try again",
  SIWE_SIGNATURE: "the signature does not match the wallet address",
  SIWE_MALFORMED: "the agent could not parse the sign-in message",
};

const TOKEN_REASON_COPY: Record<string, string> = {
  TOKEN_EXPIRED: "session expired — sign again",
  TOKEN_MISSING: "no session token — sign again",
  TOKEN_MALFORMED: "session token rejected — sign again",
  TOKEN_BAD_MAC: "session token rejected (the agent may have restarted) — sign again",
};

function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "shortMessage" in err && typeof err.shortMessage === "string") return err.shortMessage;
  return err instanceof Error ? err.message : String(err);
}

/** Max setTimeout delay (2^31−1 ms). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** /agent/[id]/chat — browser → enclave chat (SPEC-M4C §2). */
export function ChatTab({
  agent,
  fixtures,
  defaultEndpoint,
  endpointParam,
}: {
  agent: ChatAgent;
  fixtures: boolean;
  defaultEndpoint: string;
  endpointParam: string | null;
}) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [endpointRaw, setEndpointRaw] = useState(endpointParam ?? defaultEndpoint);
  const endpoint = useMemo(() => parseEndpoint(endpointRaw), [endpointRaw]);
  const [scenario, setScenario] = useState<ChatScenario>("happy");

  const transport: ChatTransport | null = useMemo(() => {
    if (!endpoint.ok) return null;
    return fixtures
      ? fixtureTransport({ scenario, host: endpoint.host, agentName: agent.name })
      : liveTransport(endpoint.origin);
  }, [endpoint, fixtures, scenario, agent.name]);

  const [health, setHealth] = useState<HealthState | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [auth, setAuth] = useState<Auth>({ kind: "idle" });
  const [eligibility, setEligibility] = useState<Eligibility>("unknown");
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const [rateUntilMs, setRateUntilMs] = useState<number | null>(null);
  const [rateUnknown, setRateUnknown] = useState(false);
  const [rateWindow, setRateWindow] = useState<"hour" | "day" | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  /** Bumped on every reset: late async results from an old endpoint/scenario are dropped. */
  const gen = useRef(0);
  const nextId = useRef(1);
  const newId = () => nextId.current++;

  // Reset everything when the transport (endpoint / scenario) changes, then probe /health.
  const probe = useCallback(async () => {
    if (transport === null) {
      setHealth(null);
      return;
    }
    const g = gen.current;
    setHealth({ kind: "probing" });
    const h = await transport.health();
    if (g === gen.current) setHealth(h);
  }, [transport]);

  useEffect(() => {
    gen.current += 1;
    setSession(null);
    setAuth({ kind: "idle" });
    setEligibility("unknown");
    setItems([]);
    setSending(false);
    setComposerError(null);
    setSent(0);
    setRateUntilMs(null);
    setRateUnknown(false);
    setRateWindow(null);
    void probe();
  }, [probe]);

  // A session token is bound to the wallet that signed it: switching wallets drops it.
  useEffect(() => {
    if (session !== null && !session.simulated && address?.toLowerCase() !== session.wallet.toLowerCase()) {
      setSession(null);
      setAuth({ kind: "expired", message: "wallet changed — sign again with the connected wallet" });
    }
  }, [address, session]);

  // Token expiry (exp is unix seconds): surface the re-auth affordance when it lapses.
  useEffect(() => {
    if (session === null) return;
    const ms = Math.min(MAX_TIMEOUT_MS, Math.max(0, session.exp * 1000 - Date.now()));
    const t = setTimeout(() => {
      setSession((s) => (s === session ? null : s));
      setAuth({ kind: "expired", message: "session expired — sign again" });
    }, ms);
    return () => clearTimeout(t);
  }, [session]);

  // 429 countdown tick.
  useEffect(() => {
    if (rateUntilMs === null) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNowMs(n);
      if (n >= rateUntilMs) setRateUntilMs(null);
    }, 1000);
    return () => clearInterval(t);
  }, [rateUntilMs]);

  const limitedFor = rateUntilMs !== null ? Math.max(0, Math.ceil((rateUntilMs - nowMs) / 1000)) : null;

  async function signIn(mode: "wallet" | "simulate") {
    if (transport === null || !endpoint.ok) return;
    const wallet = mode === "simulate" ? DEMO_WALLET : address;
    if (wallet === undefined) return;
    const g = gen.current;
    try {
      setAuth({ kind: "nonce" });
      const n = await transport.nonce();
      if (g !== gen.current) return;
      if (n.kind !== "ok") {
        setAuth({ kind: "error", message: `Could not get a sign-in nonce: ${n.detail}` });
        return;
      }
      const { domain, uri } = siweFieldsForEndpoint(endpoint.origin);
      const message = buildSiweMessage({
        domain,
        address: wallet,
        statement: siweStatement(agent.agentId),
        uri,
        chainId: RH_CHAIN_ID,
        nonce: n.nonce,
        issuedAt: new Date(),
      });
      setAuth({ kind: "signing" });
      let signature: string;
      if (mode === "simulate") {
        signature = DEMO_SIGNATURE;
      } else {
        try {
          signature = await signMessageAsync({ message });
        } catch (err) {
          if (g === gen.current) setAuth({ kind: "error", message: `Signature not given: ${errMessage(err)}` });
          return;
        }
      }
      if (g !== gen.current) return;
      setAuth({ kind: "verifying" });
      const s = await transport.session(message, signature);
      if (g !== gen.current) return;
      if (s.kind === "ok") {
        setSession({ token: s.token, exp: s.exp, wallet, simulated: mode === "simulate", message });
        setAuth({ kind: "idle" });
        return;
      }
      if (s.kind === "unauthorized") {
        const why = SIWE_REASON_COPY[s.reason] ?? s.reason;
        setAuth({ kind: "error", message: `Sign-in refused (${s.reason}): ${why}${s.detail ? ` — ${s.detail}` : ""}` });
        return;
      }
      setAuth({ kind: "error", message: `Sign-in failed: ${s.detail}` });
    } catch (err) {
      if (g === gen.current) setAuth({ kind: "error", message: `Sign-in failed: ${errMessage(err)}` });
    }
  }

  function patchUser(id: number, status: "sent" | "failed") {
    setItems((xs) => xs.map((x) => (x.id === id && x.role === "user" ? { ...x, status } : x)));
  }

  function push(item: TranscriptItem) {
    setItems((xs) => [...xs, item]);
  }

  function restoreDraft(text: string) {
    setDraft((d) => (d === "" ? text : d));
  }

  async function send() {
    if (transport === null || session === null || sending) return;
    const text = draft;
    if (text.trim() === "") return;
    if (text.length > CHAT_MAX_CHARS) {
      setComposerError(`Messages are capped at ${CHAT_MAX_CHARS} characters.`);
      return;
    }
    if (session.exp * 1000 <= Date.now()) {
      setSession(null);
      setAuth({ kind: "expired", message: "session expired — sign again" });
      return;
    }
    const g = gen.current;
    const uid = newId();
    push({ id: uid, role: "user", text, status: "pending" });
    setDraft("");
    setComposerError(null);
    setSending(true);
    const r = await transport.chat(session.token, text);
    if (g !== gen.current) return;
    setSending(false);
    switch (r.kind) {
      case "reply":
        patchUser(uid, "sent");
        push({ id: newId(), role: "agent", text: r.reply });
        setEligibility("eligible");
        setSent((n) => n + 1);
        setRateUnknown(false);
        break;
      case "bad_request":
        patchUser(uid, "failed");
        setComposerError(`The agent rejected the message: ${r.detail}`);
        restoreDraft(text);
        break;
      case "unauthorized":
        patchUser(uid, "failed");
        setSession(null);
        setAuth({ kind: "expired", message: TOKEN_REASON_COPY[r.reason] ?? `session rejected (${r.reason}) — sign again` });
        restoreDraft(text);
        break;
      case "insufficient":
        patchUser(uid, "failed");
        setEligibility("not_eligible");
        push({ id: newId(), role: "notice", tone: "warn", text: `Not eligible (403): ${r.reply}` });
        break;
      case "rate_limited":
        patchUser(uid, "failed");
        setEligibility("eligible"); // the gate runs before the rate limiter — a 429 means the gate passed
        setRateWindow(r.window);
        if (r.retryAfterSec !== null) {
          const until = Date.now() + r.retryAfterSec * 1000;
          setNowMs(Date.now());
          setRateUntilMs(until);
          setRateUnknown(false);
        } else {
          setRateUnknown(true);
        }
        push({ id: newId(), role: "notice", tone: "warn", text: `Rate limited (429): ${r.reply}` });
        restoreDraft(text);
        break;
      case "gate_unavailable":
        patchUser(uid, "failed");
        setEligibility("gate_unavailable");
        push({
          id: newId(),
          role: "notice",
          tone: "error",
          text: `Balance gate unavailable — the agent fails closed (503).${r.reply ? ` ${r.reply}` : ""}`,
        });
        restoreDraft(text);
        break;
      case "unavailable":
        // Past the gate and the rate limiter (the server already counted it).
        patchUser(uid, "failed");
        setEligibility("eligible");
        setSent((n) => n + 1);
        push({ id: newId(), role: "notice", tone: "error", text: `The agent could not answer (503 ${r.error}): ${r.reply}` });
        break;
      case "error":
        patchUser(uid, "failed");
        push({ id: newId(), role: "notice", tone: "error", text: r.detail });
        restoreDraft(text);
        break;
    }
  }

  const reachable = health !== null && (health.kind === "ok" || health.kind === "unhealthy");
  const busyAuth = auth.kind === "nonce" || auth.kind === "signing" || auth.kind === "verifying";
  const bannerWallet = session?.wallet ?? (isConnected && address ? address : null);

  return (
    <div className="flex flex-col gap-6">
      {fixtures ? (
        <FixtureControls scenario={scenario} onScenario={setScenario} />
      ) : null}

      <EligibilityBanner
        eligibility={eligibility}
        wallet={bannerWallet}
        token={agent.token}
        symbol={agent.symbol}
        totalSupply={agent.totalSupply}
        fixtureScenario={fixtures ? scenario : null}
      />

      <EndpointPanel
        endpoint={endpoint}
        inputInitial={endpointRaw}
        defaultEndpoint={defaultEndpoint}
        onApply={setEndpointRaw}
        health={health}
        onRetry={() => void probe()}
        status={agent.status}
        fixtures={fixtures}
      />

      {reachable ? (
        <section className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          {session === null ? (
            <SignInPanel
              fixtures={fixtures}
              connected={isConnected && address !== undefined}
              auth={auth}
              busy={busyAuth}
              onSignIn={signIn}
              agentName={agent.name}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              Signed in as <span className="font-mono text-slate-200">{truncateAddress(session.wallet)}</span>
              {session.simulated ? <span className="text-slate-500">(simulated demo wallet)</span> : null}
              <span className="text-slate-500">· session until {new Date(session.exp * 1000).toLocaleTimeString()}</span>
              <details className="w-full">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-300">Signed SIWE message</summary>
                <pre className="mt-1 overflow-x-auto rounded-md bg-slate-950 p-2 font-mono text-[11px] leading-relaxed text-slate-300">
                  {session.message}
                </pre>
              </details>
            </div>
          )}

          <Transcript items={items} agentName={agent.name} />
          <p className="text-xs text-slate-500">
            History lives inside the enclave; this view is this session. Nothing here is stored by this website.
          </p>

          <Composer
            draft={draft}
            onDraft={setDraft}
            onSend={() => void send()}
            disabled={session === null || limitedFor !== null}
            sending={sending}
            error={composerError}
          />
          <RateMeter sent={sent} limitedFor={limitedFor} limitedUnknown={rateUnknown} window={rateWindow} />
        </section>
      ) : null}
    </div>
  );
}

function SignInPanel({
  fixtures,
  connected,
  auth,
  busy,
  onSignIn,
  agentName,
}: {
  fixtures: boolean;
  connected: boolean;
  auth: Auth;
  busy: boolean;
  onSignIn: (mode: "wallet" | "simulate") => void;
  agentName: string;
}) {
  const label =
    auth.kind === "nonce"
      ? "Requesting nonce…"
      : auth.kind === "signing"
        ? "Sign the message in your wallet…"
        : auth.kind === "verifying"
          ? "Verifying with the agent…"
          : auth.kind === "expired"
            ? "Sign again"
            : "Sign in with Ethereum";

  return (
    <div className="flex flex-col gap-3">
      {auth.kind === "expired" ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          {auth.message.charAt(0).toUpperCase() + auth.message.slice(1)}.
        </p>
      ) : null}
      <p className="text-sm text-slate-400">
        Sign a short message (no transaction, no gas) so {agentName} knows which wallet it is talking to. The signature
        goes only to the agent&apos;s endpoint.
      </p>
      {connected ? (
        <button
          type="button"
          onClick={() => onSignIn("wallet")}
          disabled={busy}
          className="self-start rounded-md border border-accent/40 bg-accent/15 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {label}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-300">Connect a wallet to sign in.</span>
          <ConnectButton />
        </div>
      )}
      {fixtures ? (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
          <p className="text-xs text-slate-400">
            Fixtures mode — no wallet needed. Simulate uses a demo address and a placeholder signature against the
            in-tab mock endpoint.
          </p>
          <button
            type="button"
            onClick={() => onSignIn("simulate")}
            disabled={busy}
            className="self-start rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            {auth.kind === "expired" ? "Simulate sign-in again →" : "Simulate sign-in →"}
          </button>
        </div>
      ) : null}
      {auth.kind === "error" ? (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{auth.message}</p>
      ) : null}
    </div>
  );
}

function FixtureControls({ scenario, onScenario }: { scenario: ChatScenario; onScenario: (s: ChatScenario) => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
      <p className="text-xs text-slate-400">
        Fixtures mode: the chat endpoint is a mock inside this tab — nothing leaves your browser. Pick a scripted
        scenario (switching resets the session):
      </p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Fixture scenario">
        {CHAT_SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={scenario === s.id}
            onClick={() => onScenario(s.id)}
            className={`rounded-md border px-2.5 py-1 text-xs transition ${
              scenario === s.id
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-200"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
