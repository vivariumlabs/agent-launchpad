// SPEC-M3D §2 — daemon step 12: Turbo self-top-up over the TurboHttpUploader payment seam (MockHttp =
// injected fetch), the real engine and keyring, and the MockChainClient.

import { describe, expect, it } from "vitest";
import { TurboHttpUploader } from "../../src/attestation/turboHttp.js";
import { tick, type DaemonStepHook, type StepReport } from "../../src/daemon/daemon.js";
import {
  DEFAULT_TURBO_LOW_WATERMARK_WINC,
  DEFAULT_TURBO_TOPUP_AMOUNT_WEI,
  KV_TURBO_TOPUP_AT,
  runTurboTopUp,
  turboTopUpDue,
  TURBO_FUND_RETRY_MS,
} from "../../src/daemon/turboTopUp.js";
import { kvGet } from "../../src/memory/db.js";
import { ARWEAVE, CP, DAY, NOW } from "../policy/helpers.js";
import { daemonHarness, type DaemonHarness } from "./harness.js";

interface Call {
  url: string;
  method: string;
  body: string | null;
}

/** MockHttp for the Turbo payment service. */
function mockTurbo(opts: { balance?: bigint | Error; baseEth?: string | null; fund?: number[]; balanceAfter?: bigint }) {
  const calls: Call[] = [];
  const fundStatuses = [...(opts.fund ?? [202])];
  let balanceReads = 0;
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    const c: Call = { url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null };
    calls.push(c);
    if (url.includes("/account/balance/ethereum")) {
      balanceReads++;
      if (balanceReads > 1 && opts.balanceAfter !== undefined) return new Response(JSON.stringify({ winc: opts.balanceAfter.toString() }), { status: 200 });
      if (opts.balance instanceof Error) return new Response("boom", { status: 503 });
      if (opts.balance === undefined) return new Response("User Not Found", { status: 404 });
      return new Response(JSON.stringify({ winc: opts.balance.toString() }), { status: 200 });
    }
    if (url.endsWith("/info")) {
      const addresses: Record<string, string> = { ethereum: CP };
      if (opts.baseEth !== null) addresses["base-eth"] = opts.baseEth ?? ARWEAVE;
      return new Response(JSON.stringify({ version: "t", addresses }), { status: 200 });
    }
    if (url.endsWith("/account/balance/base-eth") && c.method === "POST") {
      const st = fundStatuses.shift() ?? 202;
      return new Response(JSON.stringify(st < 300 ? { creditedTransaction: {} } : { error: "tx not found" }), { status: st });
    }
    return new Response("?", { status: 599 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

interface Wired {
  h: DaemonHarness;
  calls: Call[];
  warns: string[];
  infos: string[];
  sleeps: number[];
  step(r: Awaited<ReturnType<typeof tick>>): StepReport;
}

async function wire(turbo: Parameters<typeof mockTurbo>[0], caps: Record<string, unknown> = {}, clock?: () => bigint): Promise<Wired> {
  const h = await daemonHarness({ caps, lastSnapshotAt: NOW, ...(clock !== undefined ? { clock } : {}) });
  const m = mockTurbo(turbo);
  const payment = new TurboHttpUploader(h.kr.turboSigner(), { fetchImpl: m.fetchImpl });
  const warns: string[] = [];
  const infos: string[] = [];
  const sleeps: number[] = [];
  const hook: DaemonStepHook = {
    due: (now) => turboTopUpDue(h.db, now),
    run: (now) =>
      runTurboTopUp(
        {
          payment,
          exec: h.deps,
          db: h.db,
          lowWatermarkWinc: DEFAULT_TURBO_LOW_WATERMARK_WINC,
          amountWei: DEFAULT_TURBO_TOPUP_AMOUNT_WEI,
          logger: { info: (x) => infos.push(x), warn: (x) => warns.push(x) },
          sleep: async (ms) => void sleeps.push(ms),
        },
        now,
      ),
  };
  h.deps.turboTopUp = hook;
  return {
    h,
    calls: m.calls,
    warns,
    infos,
    sleeps,
    step: (r) => {
      const s = r.steps.find((x) => x.step === "turboTopUp");
      if (s === undefined) throw new Error("no turboTopUp step");
      return s;
    },
  };
}

const topUps = (h: DaemonHarness) => h.chain.sent.filter((t) => t.chain === "base" && t.to?.toLowerCase() === ARWEAVE.toLowerCase());

describe("M3D: daemon step 12 — Turbo self-top-up (SPEC-M3D §2)", () => {
  it("M3D: under the watermark ⇒ GET /info check → arweaveFunding transfer (base ETH) through the engine → POST {tx_id}; credited balance logged", async () => {
    const w = await wire({ balance: 10n, balanceAfter: 123_456_789_000n });
    const r = await tick(w.h.deps, NOW);
    const st = w.step(r);
    expect(st.status).toBe("ran");
    // runs after the snapshot (step 8) and the tier step
    const names = r.steps.map((s) => s.step);
    expect(names.indexOf("turboTopUp")).toBeGreaterThan(names.indexOf("snapshot"));
    const sent = topUps(w.h);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.value).toBe(DEFAULT_TURBO_TOPUP_AMOUNT_WEI);
    expect(sent[0]!.data).toBe("0x");
    expect(sent[0]!.from.toLowerCase()).toBe(w.h.cfg.treasury.toLowerCase());
    expect(w.calls.map((c) => `${c.method} ${c.url.replace("https://payment.ardrive.io/v1", "")}`)).toEqual([
      `GET /account/balance/ethereum?address=${w.h.cfg.treasury}`,
      "GET /info",
      "POST /account/balance/base-eth",
      `GET /account/balance/ethereum?address=${w.h.cfg.treasury}`,
    ]);
    expect(JSON.parse(w.calls[2]!.body!)).toEqual({ tx_id: sent[0]!.hash });
    expect(w.h.ledger().treasurySpent.arweaveFunding).toBe(DEFAULT_TURBO_TOPUP_AMOUNT_WEI);
    expect(w.infos.join("\n")).toMatch(/credited balance 123456789000 winc/);
    expect(st.status === "ran" && st.results.map((x) => x.verdict.allow)).toEqual([true]);
    expect(kvGet(w.h.db, KV_TURBO_TOPUP_AT)).toBe(NOW.toString(10));
  });

  it("M3D: 404 \"User Not Found\" balance (never funded) counts as 0 ⇒ tops up", async () => {
    const w = await wire({});
    await tick(w.h.deps, NOW);
    expect(topUps(w.h)).toHaveLength(1);
  });

  it("M3D: payment-service base-eth address ≠ frozen arweaveFundingAddress ⇒ LOUD warn + skip, NO spend, no POST", async () => {
    for (const baseEth of [CP, null]) {
      const w = await wire({ balance: 1n, baseEth });
      const r = await tick(w.h.deps, NOW);
      expect(w.step(r)).toMatchObject({ status: "skipped", reason: "payment address mismatch (fail closed)" });
      expect(topUps(w.h)).toHaveLength(0);
      expect(w.calls.some((c) => c.method === "POST")).toBe(false);
      expect(w.warns.join("\n")).toMatch(/!!! TURBO TOP-UP SKIPPED/);
      expect(w.h.logs.some((l) => l.action.kind === "treasuryTransfer" && "purpose" in l.action && l.action.purpose === "arweaveFunding")).toBe(false);
    }
  });

  it("M3D: at/above the watermark ⇒ idle (balance read only)", async () => {
    const w = await wire({ balance: DEFAULT_TURBO_LOW_WATERMARK_WINC });
    const r = await tick(w.h.deps, NOW);
    expect(w.step(r)).toMatchObject({ status: "skipped" });
    expect(w.calls).toHaveLength(1);
    expect(topUps(w.h)).toHaveLength(0);
  });

  it("M3D: DEFAULT arweaveFundingDailyWei (0.002 ETH) allows the DEFAULT 0.0005 ETH top-up; the 5th same-day top-up (cumulative > 2e15 wei) ⇒ DAILY_CAP logged, nothing sent, no POST", async () => {
    // same UTC day, one second apart per run (distinct approval issuedAt ⇒ no K2 replay refusal)
    let t = NOW;
    const w = await wire({ balance: 1n }, {}, () => t);
    expect(w.h.cfg.arweaveFundingDailyWei).toBe(2_000_000_000_000_000n);
    const hook = w.h.deps.turboTopUp!;
    // runs via the hook directly (the daemon's daily due-gate would otherwise stop same-day reruns)
    for (let i = 1; i <= 4; i++) {
      t = NOW + BigInt(i);
      const out = await hook.run(t);
      expect(out.results.map((x) => x.verdict.allow)).toEqual([true]);
      expect(topUps(w.h)).toHaveLength(i);
    }
    expect(w.h.ledger().treasurySpent.arweaveFunding).toBe(4n * DEFAULT_TURBO_TOPUP_AMOUNT_WEI); // == 2e15 == cap
    const postsBefore = w.calls.filter((c) => c.method === "POST").length;
    expect(postsBefore).toBe(4);
    t = NOW + 5n;
    const fifth = await hook.run(t);
    expect(fifth.results).toHaveLength(1);
    expect(fifth.results[0]!.verdict).toMatchObject({ allow: false, code: "DAILY_CAP" });
    expect(topUps(w.h)).toHaveLength(4);
    expect(w.calls.filter((c) => c.method === "POST")).toHaveLength(postsBefore);
    expect(w.warns.join("\n")).toMatch(/turbo top-up denied: DAILY_CAP/);
    expect(w.h.logs.filter((l) => !l.verdict.allow && l.verdict.code === "DAILY_CAP")).toHaveLength(1);
  });

  it("M3D: POST {tx_id} retried ≤ 5 × 15 s while the service waits for confirmations; 5 failures ⇒ LOUD warn, never paid twice", async () => {
    const ok = await wire({ balance: 1n, fund: [404, 400, 202] });
    await tick(ok.h.deps, NOW);
    expect(ok.calls.filter((c) => c.method === "POST")).toHaveLength(3);
    expect(ok.sleeps).toEqual([TURBO_FUND_RETRY_MS, TURBO_FUND_RETRY_MS]);
    expect(TURBO_FUND_RETRY_MS).toBe(15_000);

    const bad = await wire({ balance: 1n, fund: [404, 404, 404, 404, 404, 404] });
    await tick(bad.h.deps, NOW);
    expect(bad.calls.filter((c) => c.method === "POST")).toHaveLength(5);
    expect(bad.sleeps).toHaveLength(4);
    expect(bad.warns.join("\n")).toMatch(/PAID but NOT credited after 5 attempts/);
    // same day again: not due ⇒ no second payment
    const r2 = await tick(bad.h.deps, NOW + 6n * 3600n);
    expect(bad.step(r2)).toMatchObject({ status: "skipped", reason: "turbo top-up checked within the interval" });
    expect(topUps(bad.h)).toHaveLength(1);
  });

  it("M3D: daily cadence — due after 24 h; a failed balance read is a step error that leaves the marker unset (retried next tick)", async () => {
    const w = await wire({ balance: new Error("down") });
    const r = await tick(w.h.deps, NOW);
    expect(w.step(r)).toMatchObject({ status: "error" });
    expect(kvGet(w.h.db, KV_TURBO_TOPUP_AT)).toBeUndefined();
    expect(turboTopUpDue(w.h.db, NOW)).toBe(true);

    const idle = await wire({ balance: 10n ** 15n });
    await tick(idle.h.deps, NOW);
    expect(turboTopUpDue(idle.h.db, NOW + DAY - 1n)).toBe(false);
    expect(turboTopUpDue(idle.h.db, NOW + DAY)).toBe(true);
  });

  it("M3D: no hook wired (arweave disabled) ⇒ no step 12 in the report", async () => {
    const h = await daemonHarness({ lastSnapshotAt: NOW });
    const r = await tick(h.deps, NOW);
    expect(r.steps.some((s) => s.step === "turboTopUp")).toBe(false);
  });
});
