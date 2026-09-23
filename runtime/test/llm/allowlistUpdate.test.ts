// SPEC-M3B §4 — signed allowlist updates: verification gates, atomic adoption, boot re-apply,
// daemon step-11 check, EndpointManager reload, and I2 next-call effectiveness.

import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { tick } from "../../src/daemon/daemon.js";
import type { ExecResult } from "../../src/exec/execute.js";
import {
  adoptedVersion,
  allowlistCheckDue,
  allowlistSigningMessage,
  fetchAndAdopt,
  independentOperators,
  KV_ALLOWLIST_ADOPTED,
  KV_ALLOWLIST_LAST_CHECK,
  KV_ALLOWLIST_VERSION,
  reapplyAdoptedAllowlist,
  runAllowlistCheck,
  verifySignedAllowlist,
  type AllowlistUpdateDeps,
} from "../../src/llm/allowlistUpdate.js";
import { EndpointManager } from "../../src/llm/endpoints.js";
import { kvGet, kvSet, openMemory, type MemoryDb } from "../../src/memory/db.js";
import { canonicalEncode } from "../../src/policy/approval.js";
import { evaluate } from "../../src/policy/engine.js";
import type { ProposedAction } from "../../src/policy/types.js";
import { daemonHarness } from "../daemon/harness.js";
import { DAY, mkCfg, mkLedger, mkState, NOW } from "../policy/helpers.js";
import {
  PLATFORM_ALLOWLIST_KEY,
  PLATFORM_ALLOWLIST_SIGNER,
  rawEntry,
  rawPayload,
  ROGUE_KEY,
  ScriptedAllowlistSource,
  signEnvelope,
  signedDoc,
  threeOps,
} from "./allowlistSigning.js";

const quietLog = { info: () => undefined, error: () => undefined };

interface Harness {
  deps: AllowlistUpdateDeps & { cfgNow: ResolvedConfig };
  db: MemoryDb;
  source: ScriptedAllowlistSource;
  applied: ResolvedConfig[];
  journals: string[];
  setNow(t: bigint): void;
}

function harness(opts: { optedIn?: boolean; signer?: `0x${string}` | null; cfg?: ResolvedConfig } = {}): Harness {
  const db = openMemory(":memory:");
  const source = new ScriptedAllowlistSource();
  const applied: ResolvedConfig[] = [];
  const journals: string[] = [];
  let now = NOW;
  const deps = {
    cfgNow: opts.cfg ?? mkCfg(),
    optedIn: opts.optedIn ?? true,
    signer: opts.signer === null ? undefined : (opts.signer ?? PLATFORM_ALLOWLIST_SIGNER),
    source,
    db,
    clock: () => now,
    cfg: () => deps.cfgNow,
    apply: (next: ResolvedConfig) => {
      applied.push(next);
      deps.cfgNow = next;
    },
    journal: async (text: string): Promise<ExecResult | null> => {
      journals.push(text);
      return null;
    },
  };
  return { deps, db, source, applied, journals, setNow: (t) => (now = t) };
}

function expectNothingAdopted(h: Harness, prevVersion = 0): void {
  expect(h.applied).toHaveLength(0);
  expect(h.journals).toHaveLength(0);
  expect(adoptedVersion(h.db)).toBe(prevVersion);
  if (prevVersion === 0) expect(kvGet(h.db, KV_ALLOWLIST_ADOPTED)).toBeUndefined();
}

const V1 = () => rawPayload(1, Number(NOW - DAY), threeOps());

// ---------------------------------------------------------------------------

describe("signing scheme: EIP-191 personal_sign over canonicalEncode(raw payload)", () => {
  it("the signed message is canonicalEncode(payload) — key order / whitespace independent", async () => {
    const p = V1();
    expect(allowlistSigningMessage(p)).toBe(canonicalEncode(p));
    const reordered = { entries: p.entries, validFrom: p.validFrom, version: p.version };
    const env = await signEnvelope(p);
    const v = await verifySignedAllowlist({ payload: reordered, signature: env.signature }, PLATFORM_ALLOWLIST_SIGNER);
    expect(v.ok).toBe(true);
    // independent of the helper: viem's signMessage over the same canonical string
    const sig2 = await privateKeyToAccount(PLATFORM_ALLOWLIST_KEY).signMessage({ message: JSON.stringify(JSON.parse(canonicalEncode(p))) });
    expect(sig2).toBe(env.signature);
  });

  it("happy path: adopts v1, persists envelope + version, swaps cfg (allowlist ONLY), journals", async () => {
    const h = harness();
    const before = h.deps.cfgNow;
    h.source.push(await signedDoc(V1()));
    const r = await fetchAndAdopt(h.deps);
    expect(r).toMatchObject({ status: "adopted", version: 1, previousVersion: 0, added: ["ep-1", "ep-2", "ep-3"], removed: ["inf-cheap", "inf-std", "data-1"], operators: 3 });
    expect(h.applied).toHaveLength(1);
    const next = h.applied[0]!;
    expect(next.x402Allowlist.map((e) => e.id)).toEqual(["ep-1", "ep-2", "ep-3"]);
    expect(next.x402Allowlist[0]!.maxPricePerMTokUsd).toBe(1_000_000n); // zod-coerced
    for (const k of Object.keys(before) as Array<keyof ResolvedConfig>) if (k !== "x402Allowlist") expect(next[k]).toBe(before[k]);
    expect(adoptedVersion(h.db)).toBe(1);
    expect(JSON.parse(kvGet(h.db, KV_ALLOWLIST_ADOPTED)!)).toEqual(JSON.parse(await signedDoc(V1())));
    expect(h.journals).toHaveLength(1);
    expect(h.journals[0]).toMatch(/adopted the platform-signed endpoint allowlist v1 .*3 endpoints across 3 independent operators/);
  });
});

describe("04§4-SEC: only a valid signature by the FROZEN signer is ever adopted", () => {
  it("04§4-SEC: unsigned payload (bare payload / missing signature) is never adopted", async () => {
    const h = harness();
    h.source.push(JSON.stringify(V1()), JSON.stringify({ payload: V1() }), JSON.stringify({ payload: V1(), signature: "0x" }));
    for (let i = 0; i < 3; i++) expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "MALFORMED" });
    expectNothingAdopted(h);
  });

  it("04§4-SEC: bad signature (payload tampered after signing: payTo redirected) is never adopted", async () => {
    const h = harness();
    const env = await signEnvelope(V1());
    const tampered = structuredClone(env) as { payload: { entries: Array<Record<string, unknown>> }; signature: string };
    tampered.payload.entries[0]!["payTo"] = "0x000000000000000000000000000000000000dead";
    h.source.push(JSON.stringify(tampered));
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "SIGNATURE" });
    // garbage 65-byte signature (unrecoverable)
    h.source.push(JSON.stringify({ payload: V1(), signature: `0x${"00".repeat(65)}` }));
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "SIGNATURE" });
    // extra top-level envelope field (strict)
    h.source.push(JSON.stringify({ ...env, note: "x" }));
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "MALFORMED" });
    expectNothingAdopted(h);
  });

  it("04§4-SEC: a well-formed signature by the WRONG signer is never adopted", async () => {
    const h = harness();
    h.source.push(await signedDoc(V1(), ROGUE_KEY));
    const r = await fetchAndAdopt(h.deps);
    expect(r).toMatchObject({ status: "rejected", code: "SIGNATURE" });
    expect((r as { detail: string }).detail).toContain(privateKeyToAccount(ROGUE_KEY).address);
    expectNothingAdopted(h);
  });

  it("04§4-SEC: no frozen signer ⇒ nothing is verifiable ⇒ never fetches, never adopts", async () => {
    const h = harness({ signer: null });
    h.source.push(await signedDoc(V1()));
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "NO_SIGNER" });
    expect(h.source.calls).toBe(0);
    expectNothingAdopted(h);
  });

  it("transport failures / non-JSON are rejections, nothing adopted", async () => {
    const h = harness();
    h.source.push(new Error("ECONNRESET"), "<html>not json</html>");
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "FETCH" });
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "MALFORMED" });
    expectNothingAdopted(h);
  });
});

describe("04§4-SEC: version replay", () => {
  it("04§4-SEC: version ≤ adopted is rejected (same version re-served, older validly-signed version replayed)", async () => {
    const h = harness();
    const v1 = await signedDoc(V1());
    const v2 = await signedDoc(rawPayload(2, Number(NOW - DAY), threeOps("v2")));
    h.source.push(v2, v2, v1);
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "adopted", version: 2 });
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "NOT_NEWER" });
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "NOT_NEWER" });
    expect(h.applied).toHaveLength(1);
    expect(h.deps.cfgNow.x402Allowlist.map((e) => e.id)).toEqual(["v2-1", "v2-2", "v2-3"]);
    expect(adoptedVersion(h.db)).toBe(2);
  });

  it("04§4-SEC: a corrupted adoptedVersion never lowers the replay floor", async () => {
    const h = harness();
    kvSet(h.db, KV_ALLOWLIST_VERSION, "garbage");
    h.source.push(await signedDoc(V1()));
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "NOT_NEWER" });
    expect(h.applied).toHaveLength(0);
  });

  it("version must be a positive safe integer (0, negative, fractional, string ⇒ SCHEMA)", async () => {
    const h = harness();
    for (const version of [0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 2]) {
      h.source.push(await signedDoc({ ...V1(), version }));
      expect(await fetchAndAdopt(h.deps), String(version)).toMatchObject({ status: "rejected", code: "SCHEMA" });
    }
    expectNothingAdopted(h);
  });
});

describe("validFrom ≤ now", () => {
  it("a future validFrom is not adopted until the clock reaches it", async () => {
    const h = harness();
    const doc = await signedDoc(rawPayload(1, Number(NOW + DAY), threeOps()));
    h.source.push(doc);
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "NOT_YET_VALID" });
    expectNothingAdopted(h);
    h.setNow(NOW + DAY);
    h.source.push(doc);
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "adopted", version: 1 });
  });
});

describe("04§4-SEC: entries failing the schema are rejected atomically", () => {
  it("04§4-SEC: one bad entry among good ones ⇒ nothing adopted; the previously adopted list stays in force", async () => {
    const h = harness();
    h.source.push(await signedDoc(V1()));
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "adopted", version: 1 });
    const adoptedV1 = kvGet(h.db, KV_ALLOWLIST_ADOPTED);
    const cfgV1 = h.deps.cfgNow;
    const bads: Array<Record<string, unknown>> = [
      rawEntry("bad", "op-four", { payTo: "0x1234" }),
      rawEntry("bad", "op-four", { kind: "admin" }),
      rawEntry("bad", "op-four", { maxPricePerMTokUsd: "lots" }),
      rawEntry("bad", "op-four", { tier: "premium" }),
      (() => {
        const e = rawEntry("bad", "op-four");
        delete e["url"];
        return e;
      })(),
    ];
    for (const bad of bads) {
      h.source.push(await signedDoc(rawPayload(2, Number(NOW - DAY), [...threeOps("v2"), bad])));
      expect(await fetchAndAdopt(h.deps), JSON.stringify(bad)).toMatchObject({ status: "rejected", code: "SCHEMA" });
    }
    // unknown top-level payload key (strict) ⇒ SCHEMA as well
    h.source.push(await signedDoc({ ...rawPayload(2, Number(NOW - DAY), threeOps("v2")), extra: true }));
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "SCHEMA" });
    expect(h.applied).toHaveLength(1);
    expect(h.deps.cfgNow).toBe(cfgV1);
    expect(adoptedVersion(h.db)).toBe(1);
    expect(kvGet(h.db, KV_ALLOWLIST_ADOPTED)).toBe(adoptedV1);
  });
});

describe("04§4-SEC: N ≥ 3 independent operators", () => {
  it("04§4-SEC: a payload shrinking operators below 3 is rejected", async () => {
    const h = harness();
    const two = [rawEntry("a", "op-one"), rawEntry("b", "op-two"), rawEntry("c", "op-two")];
    h.source.push(await signedDoc(rawPayload(1, Number(NOW - DAY), two)));
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "OPERATORS" });
    // spelling variants of one operator are not independent
    const variants = [rawEntry("a", "OpenOps"), rawEntry("b", " openops "), rawEntry("c", "OPENOPS"), rawEntry("d", "op-two")];
    h.source.push(await signedDoc(rawPayload(1, Number(NOW - DAY), variants)));
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "OPERATORS" });
    // data endpoints do not count toward the inference-operator floor
    const withData = [rawEntry("a", "op-one"), rawEntry("b", "op-two"), rawEntry("d", "op-three", { kind: "data" })];
    h.source.push(await signedDoc(rawPayload(1, Number(NOW - DAY), withData)));
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "OPERATORS" });
    // empty list
    h.source.push(await signedDoc(rawPayload(1, Number(NOW - DAY), [])));
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "OPERATORS" });
    expectNothingAdopted(h);
  });

  it("04§4-SEC: after adopting a 3-operator list, a later 2-operator list is rejected (the floor holds at all times)", async () => {
    const h = harness();
    h.source.push(await signedDoc(V1()), await signedDoc(rawPayload(2, Number(NOW - DAY), threeOps("v2").slice(0, 2))));
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "adopted", version: 1 });
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "OPERATORS" });
    expect(independentOperators(h.deps.cfgNow.x402Allowlist)).toBe(3);
    expect(adoptedVersion(h.db)).toBe(1);
  });
});

describe("opt-out", () => {
  it("opted-out agent never fetches (source never called), never adopts", async () => {
    const h = harness({ optedIn: false });
    h.source.fallback = await signedDoc(V1());
    for (let i = 0; i < 3; i++) expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "rejected", code: "OPTED_OUT" });
    expect(h.source.calls).toBe(0);
    expectNothingAdopted(h);
  });
});

describe("04§4-SEC: adoption is a persona-visible event", () => {
  it("04§4-SEC: every adoption drafts exactly one journal entry naming the version and the added/removed endpoints; rejections draft none", async () => {
    const h = harness();
    h.source.push(await signedDoc(V1(), ROGUE_KEY), await signedDoc(V1()));
    await fetchAndAdopt(h.deps);
    expect(h.journals).toHaveLength(0);
    await fetchAndAdopt(h.deps);
    expect(h.journals).toHaveLength(1);
    expect(h.journals[0]).toContain("v1");
    expect(h.journals[0]).toContain("Added: ep-1, ep-2, ep-3");
    expect(h.journals[0]).toContain("Removed: inf-cheap, inf-std, data-1");
  });
});

// ---------------------------------------------------------------------------

describe("I2 next-call effectiveness (cfg swap)", () => {
  const inf = (endpointId: string): ProposedAction => ({ kind: "inference", category: "pulse", endpointId, maxCostUsd: 100_000n });

  it("newly-adopted endpoint: denied(ENDPOINT) before, allowed on the NEXT evaluate; removed endpoint: allowed before, denied after", async () => {
    const h = harness();
    const ev = (id: string) => evaluate(inf(id), mkState(), mkLedger(), h.deps.cfg(), NOW);
    expect(ev("ep-1")).toMatchObject({ allow: false, code: "ENDPOINT" });
    expect(ev("inf-cheap").allow).toBe(true);
    h.source.push(await signedDoc(rawPayload(1, Number(NOW - DAY), [...threeOps(), rawEntry("inf-std", "op", { payTo: "0xee00000200000000000000000000000000000000", tier: "standard" })])));
    expect(await fetchAndAdopt(h.deps)).toMatchObject({ status: "adopted" });
    expect(ev("ep-1").allow).toBe(true);
    expect(ev("inf-cheap")).toMatchObject({ allow: false, code: "ENDPOINT" });
    expect(ev("inf-std").allow).toBe(true); // survived
  });

  it("a rejected update changes nothing for the next evaluate", async () => {
    const h = harness();
    h.source.push(await signedDoc(V1(), ROGUE_KEY));
    await fetchAndAdopt(h.deps);
    expect(evaluate(inf("ep-1"), mkState(), mkLedger(), h.deps.cfg(), NOW)).toMatchObject({ allow: false, code: "ENDPOINT" });
    expect(evaluate(inf("inf-cheap"), mkState(), mkLedger(), h.deps.cfg(), NOW).allow).toBe(true);
  });
});

describe("EndpointManager.reload", () => {
  it("survivors keep health, new endpoints start healthy, removed endpoints are gone", () => {
    const cfg = mkCfg();
    const withModels = (c: ResolvedConfig, primary: string, fallbacks: string[]): ResolvedConfig => ({ ...c, agent: { ...c.agent, models: { ...c.agent.models, primary, fallbacks } } });
    const c0 = withModels(cfg, "m1", ["m2"]);
    const m = new EndpointManager(c0);
    expect(m.candidates().map((e) => e.id)).toEqual(["inf-cheap", "inf-std"]);
    m.markUnhealthy("inf-std", "price", NOW);
    m.recordContractFailure("inf-cheap", NOW);
    const std = c0.x402Allowlist.find((e) => e.id === "inf-std")!;
    const fresh = { ...std, id: "inf-new", model: "m1", operator: "op-new" };
    m.reload({ ...c0, x402Allowlist: [std, fresh] });
    expect(m.candidates().map((e) => e.id)).toEqual(["inf-new", "inf-std"]);
    expect(m.health("inf-std", NOW + 1n)).toMatchObject({ status: "unhealthy", reason: "price" });
    expect(m.isHealthy("inf-new", NOW)).toBe(true);
    expect(() => m.health("inf-cheap", NOW)).toThrow(/unknown endpoint/);
    expect(m.consecutiveContractFailures("inf-cheap")).toBe(0);
    expect(m.select(NOW)?.id).toBe("inf-new");
  });
});

// ---------------------------------------------------------------------------

describe("boot re-apply (reapplyAdoptedAllowlist)", () => {
  it("re-applies the stored adopted list onto the genesis cfg after full re-verification", async () => {
    const h = harness();
    h.source.push(await signedDoc(V1()));
    await fetchAndAdopt(h.deps);
    const genesis = mkCfg();
    const r = await reapplyAdoptedAllowlist({ optedIn: true, signer: PLATFORM_ALLOWLIST_SIGNER, db: h.db, base: genesis, logger: quietLog });
    expect(r?.version).toBe(1);
    expect(r?.cfg.x402Allowlist.map((e) => e.id)).toEqual(["ep-1", "ep-2", "ep-3"]);
    expect(r?.cfg.maxPerCallUsd).toBe(genesis.maxPerCallUsd);
    expect(await reapplyAdoptedAllowlist({ optedIn: true, signer: PLATFORM_ALLOWLIST_SIGNER, db: openMemory(":memory:"), base: genesis, logger: quietLog })).toBeNull();
  });

  it("04§4-SEC: a tampered stored list (db edited at rest) is NOT re-applied — genesis list, loud error", async () => {
    const h = harness();
    h.source.push(await signedDoc(V1()));
    await fetchAndAdopt(h.deps);
    const stored = JSON.parse(kvGet(h.db, KV_ALLOWLIST_ADOPTED)!) as { payload: { entries: Array<Record<string, unknown>> } };
    stored.payload.entries[0]!["payTo"] = "0x000000000000000000000000000000000000dead";
    kvSet(h.db, KV_ALLOWLIST_ADOPTED, JSON.stringify(stored));
    const errors: string[] = [];
    const r = await reapplyAdoptedAllowlist({ optedIn: true, signer: PLATFORM_ALLOWLIST_SIGNER, db: h.db, base: mkCfg(), logger: { info: () => undefined, error: (m) => errors.push(m) } });
    expect(r).toBeNull();
    expect(errors.join()).toMatch(/FAILED re-verification \(SIGNATURE/);
  });

  it("04§4-SEC: stored version ≠ kv adoptedVersion, opted out, or no signer ⇒ not re-applied", async () => {
    const h = harness();
    h.source.push(await signedDoc(V1()));
    await fetchAndAdopt(h.deps);
    const base = mkCfg();
    expect(await reapplyAdoptedAllowlist({ optedIn: false, signer: PLATFORM_ALLOWLIST_SIGNER, db: h.db, base, logger: quietLog })).toBeNull();
    expect(await reapplyAdoptedAllowlist({ optedIn: true, signer: undefined, db: h.db, base, logger: quietLog })).toBeNull();
    expect(await reapplyAdoptedAllowlist({ optedIn: true, signer: privateKeyToAccount(ROGUE_KEY).address, db: h.db, base, logger: quietLog })).toBeNull();
    kvSet(h.db, KV_ALLOWLIST_VERSION, "7");
    expect(await reapplyAdoptedAllowlist({ optedIn: true, signer: PLATFORM_ALLOWLIST_SIGNER, db: h.db, base, logger: quietLog })).toBeNull();
  });
});

describe("daemon step 11 (runAllowlistCheck + hook)", () => {
  it("allowlistCheckDue: first check due; then once per interval (DEFAULT 1 day)", () => {
    const db = openMemory(":memory:");
    expect(allowlistCheckDue(db, NOW)).toBe(true);
    kvSet(db, KV_ALLOWLIST_LAST_CHECK, NOW.toString());
    expect(allowlistCheckDue(db, NOW + DAY - 1n)).toBe(false);
    expect(allowlistCheckDue(db, NOW + DAY)).toBe(true);
    expect(allowlistCheckDue(db, NOW + 3600n, 3600n)).toBe(true);
  });

  it("records the check time first; NOT_NEWER ⇒ skip; security rejection ⇒ throws (step error); adoption ⇒ notes", async () => {
    const h = harness();
    h.source.push(await signedDoc(V1()), await signedDoc(V1()), await signedDoc(rawPayload(2, Number(NOW - DAY), threeOps()), ROGUE_KEY));
    const a = await runAllowlistCheck(h.deps, NOW);
    expect(a.skip).toBeUndefined();
    expect(a.notes[0]).toMatch(/adopted signed allowlist v1 \(was v0\)/);
    expect(kvGet(h.db, KV_ALLOWLIST_LAST_CHECK)).toBe(NOW.toString());
    const b = await runAllowlistCheck(h.deps, NOW + DAY);
    expect(b.skip).toMatch(/NOT_NEWER/);
    await expect(runAllowlistCheck(h.deps, NOW + 2n * DAY)).rejects.toThrow(/SIGNATURE/);
    expect(kvGet(h.db, KV_ALLOWLIST_LAST_CHECK)).toBe((NOW + 2n * DAY).toString());
  });

  it("tick(): step 11 appears only when the hook is wired, after step 10, gated by due(); a rejection is a step error that aborts nothing", async () => {
    const plain = await daemonHarness();
    expect((await tick(plain.deps, NOW)).steps.map((s) => s.step)).not.toContain("allowlistUpdate");

    const h = harness();
    h.source.push(await signedDoc(V1(), ROGUE_KEY), await signedDoc(V1()));
    const hook = { due: (now: bigint) => allowlistCheckDue(h.db, now), run: (now: bigint) => runAllowlistCheck(h.deps, now) };
    const d1 = await daemonHarness();
    const r1 = await tick({ ...d1.deps, allowlistUpdate: hook }, NOW);
    expect(r1.steps.at(-1)).toMatchObject({ step: "allowlistUpdate", status: "error" });
    expect((r1.steps.at(-1) as { error: string }).error).toMatch(/SIGNATURE/);
    expect(r1.steps.find((s) => s.step === "heartbeat")?.status).toBe("ran");
    const d2 = await daemonHarness();
    const r2 = await tick({ ...d2.deps, allowlistUpdate: hook }, NOW + 3600n);
    expect(r2.steps.at(-1)).toEqual({ step: "allowlistUpdate", status: "skipped", reason: "allowlist update checked within the interval" });
    expect(h.source.calls).toBe(1);
    const d3 = await daemonHarness();
    const r3 = await tick({ ...d3.deps, allowlistUpdate: hook }, NOW + DAY);
    expect(r3.steps.at(-1)).toMatchObject({ step: "allowlistUpdate", status: "ran" });
    expect(h.deps.cfgNow.x402Allowlist.map((e) => e.id)).toEqual(["ep-1", "ep-2", "ep-3"]);
  });
});
