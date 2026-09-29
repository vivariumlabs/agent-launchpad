// SPEC-M3F §1: native balances. RealChainClient implements NativeBalanceSource (eth_getBalance over the
// same client ⇒ same chainId check + http retry policy); MockChainClient gains an opt-in balance map;
// chainStateReader fails LOUD at construction when tee:true and the client cannot read native balances;
// native reads join their chain's M3C §4 group. Regressions: the agent-7 gas-step stall, and the M3C §10
// registration wait engaging for a RealChainClient-shaped (tee) client.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import {
  boot,
  chainStateReader,
  REGISTRATION_GAS_FLOOR_WEI,
  waitForRegistrationGas,
  type BootLogger,
  type NativeBalanceSource as BootNativeBalanceSource,
  type Runtime,
  type TimerApi,
} from "../../src/boot.js";
import { frozenConfigHash } from "../../src/config/schema.js";
import { tick, type StepName, type StepReport, type TickReport } from "../../src/daemon/daemon.js";
import { hasNativeBalance, MockChainClient, type NativeBalanceSource, type ReadContractRequest } from "../../src/exec/chain.js";
import { RealChainClient } from "../../src/exec/chainViem.js";
import type { Chain, UnixSeconds } from "../../src/policy/types.js";
import { MockNautilusServer } from "../attestation/mockNautilus.js";
import { daemonHarness } from "../daemon/harness.js";
import { ACTION, AGENT_TOKEN, DAY, E6, NOW, TREASURY, USDC, USDG_RH, mkCfg } from "../policy/helpers.js";

const CHAINS: readonly Chain[] = ["rh", "base", "arbitrum", "optimism"];
const HOSTING = { paidUntil: NOW + 50n * DAY, ratePerDay: 1_700_000n };
const FIXTURE = join(__dirname, "fixtures", "runtime.config.json");
const MILLI_ETH = 10n ** 15n;

const dirs: string[] = [];
const runtimes: Runtime[] = [];
const nautili: MockNautilusServer[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.stop().catch(() => undefined);
  for (const s of nautili.splice(0)) await s.close();
  for (const s of servers.splice(0)) await new Promise<void>((res) => s.close(() => res()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Log extends BootLogger {
  infos: string[];
  warns: string[];
}
function capture(): Log {
  const infos: string[] = [];
  const warns: string[] = [];
  return { infos, warns, info: (m) => infos.push(m), warn: (m) => warns.push(m), error: () => undefined };
}

const key = (c: Chain, a: Address): string => `${c}:${a.toLowerCase()}`;

/** ERC-20 balanceOf responder over the mkCfg addresses: USDG 10_000, USDC 200 (every chain), agent token 7. */
function erc20Reads(c: Chain, req: ReadContractRequest): unknown {
  if (req.functionName !== "balanceOf") throw new Error(`unexpected read ${req.functionName}`);
  const t = req.address.toLowerCase();
  if (t === USDG_RH.toLowerCase()) return 10_000n * E6;
  if (t === USDC[c].toLowerCase()) return 200n * E6;
  if (t === AGENT_TOKEN.toLowerCase()) return 7n;
  throw new Error(`unexpected token ${req.address}`);
}

/** Distinct native balance per (chain, owner). */
function nativeOf(c: Chain, owner: "treasury" | "action"): bigint {
  return BigInt(CHAINS.indexOf(c) + 1) * MILLI_ETH + (owner === "action" ? 7n : 0n);
}

function balancesFor(treasury: Address, action: Address): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const c of CHAINS) {
    out[key(c, treasury)] = nativeOf(c, "treasury");
    out[key(c, action)] = nativeOf(c, "action");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC stub for RealChainClient (viem http transport → node:http, 127.0.0.1)
// ---------------------------------------------------------------------------

interface RpcStub {
  url: string;
  calls: Array<{ method: string; params: unknown[] }>;
  /** eth_getBalance results, consumed one per call (last repeats). */
  balances: bigint[];
  /** The next N requests (any method) answer HTTP 500. */
  fail500: number;
  chainId: number;
}

async function rpcStub(chainId: number, balances: bigint[]): Promise<RpcStub> {
  const stub: RpcStub = { url: "", calls: [], balances, fail500: 0, chainId };
  let i = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (stub.fail500 > 0) {
        stub.fail500--;
        res.writeHead(500, { "content-type": "text/plain" }).end("upstream hiccup");
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string; params?: unknown[] };
      stub.calls.push({ method: body.method, params: body.params ?? [] });
      let result: string;
      if (body.method === "eth_chainId") result = `0x${stub.chainId.toString(16)}`;
      else if (body.method === "eth_getBalance") result = `0x${stub.balances[Math.min(i++, stub.balances.length - 1)]!.toString(16)}`;
      else {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  servers.push(server);
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}

// ---------------------------------------------------------------------------
// §1a RealChainClient
// ---------------------------------------------------------------------------

describe("M3F §1: RealChainClient implements NativeBalanceSource (SPEC-M3F §1a)", () => {
  it("M3F §1: getBalance returns the node's eth_getBalance as a bigint (after the one-time chainId check)", async () => {
    const big = 123_456_789_012_345_678_901n; // > 2^64: no float/number round-trip anywhere
    const stub = await rpcStub(46630, [big]);
    const c = new RealChainClient({ rpcUrls: { rh: stub.url }, chainIds: { rh: 46630 } });
    expect(hasNativeBalance(c)).toBe(true);
    const b = await c.getBalance("rh", TREASURY);
    expect(typeof b).toBe("bigint");
    expect(b).toBe(big);
    expect(stub.calls.map((x) => x.method)).toEqual(["eth_chainId", "eth_getBalance"]);
    expect(String(stub.calls[1]!.params[0]).toLowerCase()).toBe(TREASURY.toLowerCase());
    expect(stub.calls[1]!.params[1]).toBe("latest");
    await c.getBalance("rh", ACTION); // chainId verified once
    expect(stub.calls.map((x) => x.method)).toEqual(["eth_chainId", "eth_getBalance", "eth_getBalance"]);
  });

  it("M3F §1: getBalance goes through the chainId check — a mis-pointed RPC throws", async () => {
    const stub = await rpcStub(1, [5n]);
    const c = new RealChainClient({ rpcUrls: { rh: stub.url }, chainIds: { rh: 46630 } });
    await expect(c.getBalance("rh", TREASURY)).rejects.toThrow(/rh RPC reports chainId 1, expected 46630/);
    expect(stub.calls.map((x) => x.method)).toEqual(["eth_chainId"]);
  });

  it("M3F §1: getBalance inherits the M3C §6 transport retry (one HTTP 500 absorbed at the DEFAULT retryCount)", async () => {
    const stub = await rpcStub(46630, [42n]);
    const c = new RealChainClient({ rpcUrls: { rh: stub.url }, chainIds: { rh: 46630 } });
    await c.getBalance("rh", TREASURY); // verify chainId first
    stub.fail500 = 1;
    expect(await c.getBalance("rh", TREASURY)).toBe(42n);
    expect(stub.fail500).toBe(0); // the 500 was actually served, then retried
  });

  it("M3F §1: NativeBalanceSource lives in exec/chain.ts; boot.ts re-exports the same type", () => {
    const viaChain: NativeBalanceSource = new MockChainClient({ balances: {} }) as MockChainClient & NativeBalanceSource;
    const viaBoot: BootNativeBalanceSource = viaChain;
    expect(typeof viaBoot.getBalance).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// §1b MockChainClient balance map
// ---------------------------------------------------------------------------

describe("M3F §1: MockChainClient opt-in balance map (SPEC-M3F §1b)", () => {
  it("M3F §1: constructed WITHOUT balances ⇒ no getBalance member at all; hasNativeBalance false", () => {
    const m = new MockChainClient();
    expect("getBalance" in m).toBe(false);
    expect(hasNativeBalance(m)).toBe(false);
    expect(hasNativeBalance(new MockChainClient({ reads: () => 0n }))).toBe(false);
  });

  it("M3F §1: balances (even {}) ⇒ NativeBalanceSource; keys are chain:lowercase address; missing ⇒ 0n", async () => {
    const m = new MockChainClient({ balances: { [`rh:${TREASURY.toUpperCase().replace("0X", "0x")}`]: 5n } });
    expect(hasNativeBalance(m)).toBe(true);
    expect(await m.getBalance!("rh", TREASURY)).toBe(5n);
    expect(await m.getBalance!("base", TREASURY)).toBe(0n);
    expect(await m.getBalance!("rh", ACTION)).toBe(0n);
    expect(hasNativeBalance(new MockChainClient({ balances: {} }))).toBe(true);
  });

  it("M3F §1: setBalance turns a plain mock into a NativeBalanceSource and updates in place", async () => {
    const m = new MockChainClient();
    m.setBalance("optimism", ACTION, 9n);
    expect(hasNativeBalance(m)).toBe(true);
    expect(await m.getBalance!("optimism", ACTION)).toBe(9n);
    m.setBalance("optimism", ACTION, 10n);
    expect(await m.getBalance!("optimism", ACTION)).toBe(10n);
  });
});

// ---------------------------------------------------------------------------
// §1c / §1d chainStateReader
// ---------------------------------------------------------------------------

describe("M3F §1: chainStateReader native balances (SPEC-M3F §1c/§1d)", () => {
  it("M3F §1: with a NativeBalanceSource, native is populated on all 4 chains (treasury) + rh (action); fresh", async () => {
    const chain = new MockChainClient({ balances: balancesFor(TREASURY, ACTION), reads: erc20Reads });
    const log = capture();
    const s = await chainStateReader(chain, mkCfg(), HOSTING, { logger: log, tee: true })();
    expect("staleChains" in s).toBe(false);
    for (const c of CHAINS) {
      expect(s.treasury[c].native).toBe(nativeOf(c, "treasury"));
      expect(s.action[c].native).toBe(c === "rh" ? nativeOf("rh", "action") : 0n); // action EOA: rh only, never read elsewhere
    }
    expect(s.treasury.rh).toEqual({ native: nativeOf("rh", "treasury"), USDC: 200n * E6, USDG: 10_000n * E6, tokens: { [AGENT_TOKEN]: 7n } });
    expect(log.warns).toEqual([]);
  });

  it("M3F §1: native read throw ⇒ that chain stale, zeros when uncached, LOUD warn; other chains fresh", async () => {
    const chain = new MockChainClient({ balances: balancesFor(TREASURY, ACTION), reads: erc20Reads });
    const inner = chain.getBalance!;
    chain.getBalance = async (c, a) => {
      if (c === "base") throw new Error("base eth_getBalance 503");
      return inner(c, a);
    };
    const log = capture();
    const s = await chainStateReader(chain, mkCfg(), HOSTING, { logger: log })();
    expect(s.staleChains).toEqual(["base"]);
    expect(s.treasury.base).toEqual({ native: 0n, USDC: 0n });
    for (const c of ["rh", "arbitrum", "optimism"] as const) expect(s.treasury[c].native).toBe(nativeOf(c, "treasury"));
    expect(log.warns).toEqual(["!!! getState: base reads FAILED (base eth_getBalance 503) — using zeros; spends touching base deny STATE_STALE !!!"]);
  });

  it("M3F §1: native read throw after a good read ⇒ cached slice served, still stale; the rh ACTION native alone stales all of rh", async () => {
    const chain = new MockChainClient({ balances: balancesFor(TREASURY, ACTION), reads: erc20Reads });
    const inner = chain.getBalance!;
    let failActionRh = false;
    chain.getBalance = async (c, a) => {
      if (failActionRh && c === "rh" && a.toLowerCase() === ACTION.toLowerCase()) throw new Error("rh getBalance timeout");
      return inner(c, a);
    };
    let now: UnixSeconds = NOW;
    const log = capture();
    const read = chainStateReader(chain, mkCfg(), HOSTING, { logger: log, clock: () => now });
    const first = await read();
    expect("staleChains" in first).toBe(false);

    chain.setBalance("rh", TREASURY, 999n); // would be visible on a fresh read
    failActionRh = true;
    now = NOW + 7n;
    const second = await read();
    expect(second.staleChains).toEqual(["rh"]);
    expect(second.treasury.rh).toEqual(first.treasury.rh); // cached, NOT 999
    expect(second.action.rh).toEqual(first.action.rh);
    expect(log.warns).toEqual([
      "!!! getState: rh reads FAILED (rh getBalance timeout) — using cached values (age 7s); spends touching rh deny STATE_STALE !!!",
    ]);

    failActionRh = false; // automatic recovery
    const third = await read();
    expect("staleChains" in third).toBe(false);
    expect(third.treasury.rh.native).toBe(999n);
  });

  it("M3F §1: tee:true + a client WITHOUT NativeBalanceSource ⇒ throws at construction (wiring bug), before any read", () => {
    const chain = new MockChainClient({ reads: () => 0n });
    let reads = 0;
    const counting = new MockChainClient({
      reads: () => {
        reads++;
        return 0n;
      },
    });
    expect(() => chainStateReader(chain, mkCfg(), HOSTING, { tee: true })).toThrow(
      /boot config error \(wiring bug\).*RealChainClient must implement NativeBalanceSource in tee/,
    );
    expect(() => chainStateReader(counting, mkCfg(), HOSTING, { tee: true })).toThrow(/NativeBalanceSource/);
    expect(reads).toBe(0);
  });

  it("M3F §1: tee:true accepts a RealChainClient (no network at construction) and a balance-map mock", () => {
    const real = new RealChainClient({ rpcUrls: { rh: "http://127.0.0.1:1" }, chainIds: { rh: 46630 } });
    expect(typeof chainStateReader(real, mkCfg(), HOSTING, { tee: true })).toBe("function");
    expect(typeof chainStateReader(new MockChainClient({ balances: {} }), mkCfg(), HOSTING, { tee: true })).toBe("function");
  });

  it("M3F §1: tee false/absent + no NativeBalanceSource ⇒ unchanged 0n native fallback, fresh", async () => {
    for (const opts of [{}, { tee: false }]) {
      const chain = new MockChainClient({ reads: erc20Reads });
      const s = await chainStateReader(chain, mkCfg(), HOSTING, { logger: capture(), ...opts })();
      expect("staleChains" in s).toBe(false);
      for (const c of CHAINS) expect(s.treasury[c].native).toBe(0n);
      expect(s.treasury.arbitrum.USDC).toBe(200n * E6);
    }
  });
});

// ---------------------------------------------------------------------------
// §1c boot wiring
// ---------------------------------------------------------------------------

class FakeTimers implements TimerApi {
  set(): unknown {
    return 1;
  }
  clear(): void {}
}

describe("M3F §1: boot wiring of the tee fail-loud guard (SPEC-M3F §1c)", () => {
  it("M3F §1: tee:true boot whose own client cannot read native (no runtime.rpc ⇒ MockChainClient fallback) ⇒ boot throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "al-boot3f-"));
    dirs.push(dir);
    const j = JSON.parse(readFileSync(FIXTURE, "utf8")) as { platform: Record<string, unknown>; agent: unknown; runtime: Record<string, unknown> };
    const s = new MockNautilusServer({ seed: "image-a|agent-1" });
    await s.start();
    nautili.push(s);
    delete j.runtime.mockKms;
    delete j.runtime.rpc;
    Object.assign(j.runtime, { tee: true, kmsUrl: s.baseUrl, attestationUrl: s.attestationUrl, imageId: `0x${"28e981ac".repeat(8)}`, registrationRetrySec: 0 });
    const initParamsDir = join(dir, "init");
    mkdirSync(initParamsDir);
    writeFileSync(join(initParamsDir, "agent-id"), "agent-1");
    writeFileSync(join(initParamsDir, "config-hash"), frozenConfigHash({ platform: j.platform, agent: j.agent }));
    const cfgPath = join(dir, "m3f.json");
    writeFileSync(cfgPath, JSON.stringify(j));
    mkdirSync(join(dir, "data"), { recursive: true });
    const log = capture();
    await expect(
      boot({
        configPath: cfgPath,
        dbPath: join(dir, "data", "agent.db"),
        snapshotDir: join(dir, "snapshots"),
        clock: () => NOW,
        kmsRetry: { attempts: 2, delayMs: 1 },
        initParamsDir,
        overrides: { timers: new FakeTimers(), logger: log, chatPort: 0 },
      }).then((rt) => {
        runtimes.push(rt);
        return rt;
      }),
    ).rejects.toThrow(/RealChainClient must implement NativeBalanceSource in tee/);
  });
});

// ---------------------------------------------------------------------------
// Regression: daemon step 2 (gas) with real native balances — the agent-7 stall
// ---------------------------------------------------------------------------

function step(r: TickReport, name: StepName): StepReport {
  const s = r.steps.find((x) => x.step === name);
  if (s === undefined) throw new Error(`no step ${name}`);
  return s;
}

describe("M3F §1: daemon gas step over chainStateReader (agent-7 regression)", () => {
  /** Treasury 0.02 ETH on every chain (above every target); action rh 0.0005 ETH (< 0.001 floor). */
  async function harness(withBalances: boolean) {
    const h = await daemonHarness({ tier: "Active", lastSnapshotAt: NOW, chain: { reads: erc20Reads, ...(withBalances ? { balances: {} } : {}) } });
    if (withBalances) {
      for (const c of CHAINS) h.chain.setBalance(c, h.cfg.treasury, 20n * MILLI_ETH);
      h.chain.setBalance("rh", h.cfg.action, MILLI_ETH / 2n);
    }
    h.deps.getState = chainStateReader(h.chain, h.cfg, HOSTING, { logger: capture(), tee: withBalances });
    return h;
  }

  it("M3F §1: real balances above target ⇒ step 2 proposes, the engine allows, and the chain receives gasTopUp (0.0025 ETH to the action EOA)", async () => {
    const h = await harness(true);
    const r = await tick(h.deps, NOW);
    const g = step(r, "gas");
    if (g.status !== "ran") throw new Error(`gas should run, got ${g.status}: ${"reason" in g ? g.reason : ""}`);
    expect(g.results.map((x) => x.action)).toEqual([
      { kind: "treasuryTransfer", purpose: "gasTopUp", chain: "rh", asset: "ETH", to: h.cfg.action, amount: 2_500_000_000_000_000n },
    ]);
    const res = g.results[0]!;
    if (!res.verdict.allow) throw new Error(`gasTopUp denied ${res.verdict.code}: ${res.verdict.detail}`);
    expect(res.error).toBeUndefined();
    const sent = h.chain.sent.find((t) => t.hash === res.txHash);
    expect(sent).toMatchObject({ chain: "rh", value: 2_500_000_000_000_000n });
    expect(sent!.from.toLowerCase()).toBe(h.cfg.treasury.toLowerCase());
    expect(sent!.to!.toLowerCase()).toBe(h.cfg.action.toLowerCase());
  });

  it("M3F §1: (the pre-M3F stall, for contrast) no NativeBalanceSource ⇒ every native reads 0 ⇒ notes only, nothing sent", async () => {
    const h = await harness(false);
    const r = await tick(h.deps, NOW);
    const g = step(r, "gas");
    expect(g.status).toBe("skipped");
    if (g.status === "skipped") expect(g.reason).toMatch(/treasury rh has no surplus above target/);
    expect(r.actions.filter((a) => a.action.kind === "treasuryTransfer" && (a.action as { purpose: string }).purpose === "gasTopUp")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression: M3C §10 registration wait engages for a RealChainClient (the tee client)
// ---------------------------------------------------------------------------

describe("M3F §1: M3C §10 registration gas wait with a RealChainClient (no more \"noBalanceSource\")", () => {
  function fakeTime() {
    let now: UnixSeconds = NOW;
    const sleeps: number[] = [];
    return {
      sleeps,
      opts: {
        clock: () => now,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          now += BigInt(ms / 1000);
        },
      },
    };
  }

  it("M3F §1: funded at the first eth_getBalance ⇒ \"funded\" (the wait engaged and read the treasury on rh)", async () => {
    const stub = await rpcStub(46630, [REGISTRATION_GAS_FLOOR_WEI]);
    const c = new RealChainClient({ rpcUrls: { rh: stub.url }, chainIds: { rh: 46630 } });
    const t = fakeTime();
    expect(await waitForRegistrationGas(c, TREASURY, 1, capture(), t.opts)).toBe("funded");
    const reads = stub.calls.filter((x) => x.method === "eth_getBalance");
    expect(reads).toHaveLength(1);
    expect(String(reads[0]!.params[0]).toLowerCase()).toBe(TREASURY.toLowerCase());
    expect(t.sleeps).toEqual([]);
  });

  it("M3F §1: unfunded then funded ⇒ polls every 10 s until the floor, then \"funded\"", async () => {
    const stub = await rpcStub(46630, [0n, REGISTRATION_GAS_FLOOR_WEI - 1n, REGISTRATION_GAS_FLOOR_WEI]);
    const c = new RealChainClient({ rpcUrls: { rh: stub.url }, chainIds: { rh: 46630 } });
    const t = fakeTime();
    const log = capture();
    expect(await waitForRegistrationGas(c, TREASURY, 1, log, t.opts)).toBe("funded");
    expect(stub.calls.filter((x) => x.method === "eth_getBalance")).toHaveLength(3);
    expect(t.sleeps).toEqual([10_000, 10_000]);
    expect(log.infos.some((m) => m.startsWith("registration: waiting for preGas"))).toBe(true);
  });
});
