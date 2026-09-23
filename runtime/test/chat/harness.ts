// Shared chat-server harness (not a test file). Mirrors test/pulse/harness.ts: MockKms keyring,
// resolved config from the policy fixtures + SPEC-M2C chat fields, MockChainClient, ":memory:"
// memory, MockLlm (request log = prompt capture), MockX402Transport, EndpointManager, two
// MockBalanceReaders and a manual gate timer.

import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { expect } from "vitest";
import { createChatServer, TOKEN_HEADER, type ChatHttpResponse, type ChatServer, type ChatServerDeps } from "../../src/chat/server.js";
import type { BalanceReader, GateTimer, Holdings, TimerHandle } from "../../src/chat/gate.js";
import { resolveConfig, type ResolvedConfig } from "../../src/config/schema.js";
import { MockChainClient } from "../../src/exec/chain.js";
import type { ExecDeps } from "../../src/exec/execute.js";
import { createKeyring, type Keyring } from "../../src/keyring/keyring.js";
import { MockKms } from "../../src/keyring/mockKms.js";
import { EndpointManager } from "../../src/llm/endpoints.js";
import { MockLlm, MockX402Transport } from "../../src/llm/mock.js";
import type { HttpClient, LlmRequest, LlmResponse } from "../../src/llm/types.js";
import { X402HttpInference } from "../../src/llm/x402Http.js";
import { openMemory, type MemoryDb } from "../../src/memory/db.js";
import type { BudgetLedger, WalletState } from "../../src/policy/types.js";
import { E18, E6, NOW, PAYTO_INF_CHEAP, PAYTO_INF_STD, addr, agentJson, mkLedger, mkState, platformJson } from "../policy/helpers.js";

export const EP_STD = "ep-std"; // primary (model m-main), standard tier
export const EP_CHEAP = "ep-cheap"; // fallback (model m-alt), cheap tier
export const PRICE_STD = 2_000_000n;
export const PRICE_CHEAP = 1_000_000n;
export const CHAT_DOMAIN = "agent.example.com";
export const RPC_A = "https://rpc-a.invalid";
export const RPC_B = "https://rpc-b.invalid";
export const PLATFORM_TOKEN = addr("70a70000", "0000a7a7");
export const RH_CHAIN_ID = 46630; // platformJson() fixture override
export const SUPPLY = 1_000_000_000n * E18;

const FAST_RETRY = { retry: { attempts: 3, delayMs: 1 } };

/** Deterministic test wallet (EOA) from a label. */
export function wallet(label: string): PrivateKeyAccount {
  return privateKeyToAccount(keccak256(stringToBytes(`chat-test-wallet|${label}`)));
}

// ---------------------------------------------------------------------------
// balance readers + timer
// ---------------------------------------------------------------------------

export type ReaderMode = "ok" | "throw" | "hang" | "reject" | "malformed";

/** Holdings that pass via the agent-token leg (1% ≥ 0.1%). */
export function holder(): Holdings {
  return { agentBal: SUPPLY / 100n, agentSupply: SUPPLY, platformBal: 0n, platformSupply: SUPPLY };
}

/** Holdings failing both legs. */
export function pauper(): Holdings {
  return { agentBal: 0n, agentSupply: SUPPLY, platformBal: 0n, platformSupply: SUPPLY };
}

export class MockBalanceReader implements BalanceReader {
  readonly calls: Address[] = [];
  mode: ReaderMode = "ok";
  private readonly table = new Map<string, Holdings>();
  constructor(readonly name: string) {}

  set(w: Address, h: Holdings): void {
    this.table.set(w.toLowerCase(), h);
  }

  holdings(w: Address): Promise<Holdings> {
    this.calls.push(w);
    switch (this.mode) {
      case "throw":
        throw new Error(`${this.name}: rpc exploded (sync)`);
      case "reject":
        return Promise.reject(new Error(`${this.name}: rpc 500`));
      case "hang":
        return new Promise<Holdings>(() => undefined);
      case "malformed":
        return Promise.resolve({ agentBal: -1n, agentSupply: SUPPLY, platformBal: 0n, platformSupply: SUPPLY });
      case "ok":
        return Promise.resolve(this.table.get(w.toLowerCase()) ?? pauper());
    }
  }
}

/** Manual timer: timeouts fire only when the test calls fire(). */
export class ManualTimer implements GateTimer {
  readonly pending: Array<{ ms: number; resolve: () => void; cancelled: boolean }> = [];
  after(ms: number): TimerHandle {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const entry = { ms, resolve, cancelled: false };
    this.pending.push(entry);
    return {
      promise,
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }
  /** Fire every armed, uncancelled timer. Returns how many fired. */
  fire(): number {
    let n = 0;
    for (const p of this.pending) {
      if (!p.cancelled) {
        p.cancelled = true;
        p.resolve();
        n++;
      }
    }
    return n;
  }
  armed(): number {
    return this.pending.filter((p) => !p.cancelled).length;
  }
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

export interface ChatHarnessOpts {
  ledger?: BudgetLedger;
  state?: WalletState;
  caps?: Record<string, unknown>;
  /** Replace the inference allowlist (e.g. no cheap entry). */
  allowlist?: Array<Record<string, unknown>>;
  models?: { primary: string; fallbacks: string[]; chatTier: string };
  chatDomain?: string | null;
  /** Use the real setTimeout timer instead of the manual one. */
  realTimer?: boolean;
  llm?: (req: LlmRequest) => string | LlmResponse | Error;
  /** MockKms agent id (different ⇒ different chat session key). */
  kmsAgent?: string;
  /** Share a memory db (e.g. with a pulse harness). */
  db?: MemoryDb;
  /** Real x402 transport over this HttpClient (deps.paidInference); llm/x402 mocks then unused. */
  x402Http?: HttpClient;
}

export interface ChatHarness {
  cfg: ResolvedConfig;
  kr: Keyring;
  db: MemoryDb;
  llm: MockLlm;
  x402: MockX402Transport;
  endpoints: EndpointManager;
  chain: MockChainClient;
  exec: ExecDeps;
  readerA: MockBalanceReader;
  readerB: MockBalanceReader;
  timer: ManualTimer;
  server: ChatServer;
  now(): bigint;
  setNow(t: bigint): void;
  advance(sec: bigint): void;
  ledger(): BudgetLedger;
  setLedger(l: BudgetLedger): void;
  /** Sets the same holdings on BOTH readers. */
  setHoldings(w: Address, h: Holdings): void;
  get(path: string): Promise<ChatHttpResponse>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<ChatHttpResponse>;
  siwe(acct: PrivateKeyAccount, nonce: string, over?: Partial<SiweOverrides>): string;
  /** Full nonce → sign → session flow; returns the token (asserts 200). */
  login(acct: PrivateKeyAccount): Promise<string>;
  chat(token: string, text: string): Promise<ChatHttpResponse>;
}

export interface SiweOverrides {
  domain: string;
  chainId: number;
  address: Address;
  issuedAt: bigint;
  expirationTime: bigint;
  notBefore: bigint;
  statement: string;
  uri: string;
  scheme: string;
}

export function toDate(t: bigint): Date {
  return new Date(Number(t) * 1000);
}

export function defaultAllowlist(): Array<Record<string, unknown>> {
  return [
    { id: EP_STD, kind: "inference", operator: "op-a", url: "https://a", payTo: PAYTO_INF_STD, model: "m-main", tier: "standard", maxPricePerMTokUsd: PRICE_STD.toString(), attested: false },
    { id: EP_CHEAP, kind: "inference", operator: "op-b", url: "https://b", payTo: PAYTO_INF_CHEAP, model: "m-alt", tier: "cheap", maxPricePerMTokUsd: PRICE_CHEAP.toString(), attested: false },
    { id: "data-1", kind: "data", operator: "op", url: "https://c", payTo: "0xee000003000000000000000000000000000000e3", model: "search", tier: "cheap", maxPricePerMTokUsd: "1000000", attested: false },
  ];
}

/** Default MockLlm responder: echoes the last user message. */
export function echo(req: LlmRequest): string {
  const last = req.messages[req.messages.length - 1];
  return `echo: ${last?.content ?? ""}`;
}

export async function makeChatHarness(opts: ChatHarnessOpts = {}): Promise<ChatHarness> {
  const kr = await createKeyring(new MockKms("image-chat", opts.kmsAgent ?? "agent-chat"), FAST_RETRY);
  const platform = platformJson(opts.caps ?? {});
  platform["x402Allowlist"] = opts.allowlist ?? defaultAllowlist();
  if (opts.chatDomain !== null) platform["chatDomain"] = opts.chatDomain ?? CHAT_DOMAIN;
  platform["chatRpc"] = [RPC_A, RPC_B];
  platform["platformTokenAddress"] = PLATFORM_TOKEN;
  const cfg = resolveConfig({
    platform,
    agent: { ...agentJson, persona: "A cheerful test agent.", models: opts.models ?? { primary: "m-main", fallbacks: ["m-alt"], chatTier: "cheap" } },
    ownAddresses: kr.addresses(),
  });
  kr.attachConfig(cfg);

  let now = NOW;
  // Healthy fee income ⇒ chat budget well above the floor (25% × 100 USDG × 25% = 6.25 USD).
  let L = opts.ledger ?? mkLedger({ feeIncome7d: [100n * E6, 100n * E6, 100n * E6] });
  const state = opts.state ?? mkState();
  const chain = new MockChainClient();
  const db = opts.db ?? openMemory(":memory:");
  const llm = new MockLlm(opts.llm ?? echo);
  const x402 = new MockX402Transport([
    { id: EP_STD, payTo: PAYTO_INF_STD, price: PRICE_STD },
    { id: EP_CHEAP, payTo: PAYTO_INF_CHEAP, price: PRICE_CHEAP },
  ]);
  const endpoints = new EndpointManager(cfg);
  const readerA = new MockBalanceReader("rpc-a");
  const readerB = new MockBalanceReader("rpc-b");
  const timer = new ManualTimer();

  const exec: ExecDeps = {
    cfg,
    keyring: kr,
    chain,
    getState: () => state,
    ledger: { get: () => L, set: (l) => (L = l) },
    clock: () => now,
  };
  const deps: ChatServerDeps = { exec, db, llm, x402, endpoints, readers: [readerA, readerB], tier: undefined };
  if (opts.x402Http !== undefined) deps.paidInference = new X402HttpInference({ http: opts.x402Http, exec, endpoints });
  if (opts.realTimer !== true) deps.timer = timer;
  const server = createChatServer(deps);

  const h: ChatHarness = {
    cfg,
    kr,
    db,
    llm,
    x402,
    endpoints,
    chain,
    exec,
    readerA,
    readerB,
    timer,
    server,
    now: () => now,
    setNow: (t) => (now = t),
    advance: (s) => (now = now + s),
    ledger: () => L,
    setLedger: (l) => (L = l),
    setHoldings(w, hold) {
      readerA.set(w, hold);
      readerB.set(w, hold);
    },
    get: (path) => server.handle({ method: "GET", path, headers: {} }),
    post: (path, body, headers = {}) =>
      server.handle({ method: "POST", path, headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    siwe(acct, nonce, over = {}) {
      return createSiweMessage({
        domain: over.domain ?? CHAT_DOMAIN,
        address: over.address ?? acct.address,
        statement: over.statement ?? "Sign in to chat with the agent.",
        uri: over.uri ?? `https://${CHAT_DOMAIN}/chat`,
        version: "1",
        chainId: over.chainId ?? RH_CHAIN_ID,
        nonce,
        issuedAt: toDate(over.issuedAt ?? now),
        ...(over.expirationTime !== undefined ? { expirationTime: toDate(over.expirationTime) } : {}),
        ...(over.notBefore !== undefined ? { notBefore: toDate(over.notBefore) } : {}),
        ...(over.scheme !== undefined ? { scheme: over.scheme } : {}),
      });
    },
    async login(acct) {
      const n = await h.get("/nonce");
      expect(n.status).toBe(200);
      const nonce = n.body["nonce"] as string;
      const message = h.siwe(acct, nonce);
      const signature = await acct.signMessage({ message });
      const s = await h.post("/session", { message, signature });
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      return s.body["token"] as string;
    },
    chat: (token, text) => h.post("/chat", { text }, { [TOKEN_HEADER]: token }),
  };
  return h;
}

/** Fetch a fresh nonce through the route. */
export async function freshNonce(h: ChatHarness): Promise<string> {
  const r = await h.get("/nonce");
  return r.body["nonce"] as string;
}

export async function signed(acct: PrivateKeyAccount, message: string): Promise<Hex> {
  return acct.signMessage({ message });
}
