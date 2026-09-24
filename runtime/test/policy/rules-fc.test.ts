// SPEC-M3D §3d — engine kinds fcRegister (T6) / fcAddKey (T7) / fcUserData (S3), their ledger bookkeeping,
// chainsTouched, buildTx goldens, and the LLM-schema exclusion.

import { encodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/schema.js";
import { buildTx, NoTxError } from "../../src/exec/build.js";
import { applyApproved, emptyLedger, rollLedger } from "../../src/ledger/ledger.js";
import { deserializeLedger, serializeLedger } from "../../src/memory/db.js";
import { chainsTouched, walletForAction, type ProposedAction } from "../../src/policy/types.js";
import { TOOL_TABLE, toolSchemaFor } from "../../src/pulse/tools.js";
import {
  ACTION, CP, DAY, DAY0, FC, FC_PUBKEY, FC_REGISTER_MAX_WEI, NOW, TREASURY,
  agentJson, cfg, ev, expectAllow, expectDeny, mkLedger, mkRunwayState, mkState, platformJson, raw,
} from "./helpers.js";

const noFc = (() => {
  const p = platformJson() as Record<string, unknown>;
  delete p.farcaster;
  return resolveConfig({ platform: p, agent: agentJson, ownAddresses: { treasury: TREASURY, action: ACTION, fcPublicKey: FC_PUBKEY } });
})();
const noPubkey = resolveConfig({ platform: platformJson(), agent: agentJson, ownAddresses: { treasury: TREASURY, action: ACTION } });

const REG = (priceWei: bigint): ProposedAction => ({ kind: "fcRegister", priceWei });
const META = `0x${"ab".repeat(192)}` as const;
const ADD = (key: `0x${string}` = FC_PUBKEY): ProposedAction => ({ kind: "fcAddKey", key, metadata: META });
const UD: ProposedAction = { kind: "fcUserData", contentHash: `0x${"55".repeat(32)}`, sizeBytes: 20n };

describe("M3D-fc: T6 fcRegister (SPEC-M3D §3d)", () => {
  it("M3D-fc: priceWei ≤ registerMaxWei (DEFAULT 0.0002 ETH) ⇒ allow; == max allow; max + 1 ⇒ PER_TX_CAP", () => {
    expect(cfg.farcaster?.registerMaxWei).toBe(FC_REGISTER_MAX_WEI);
    expectAllow(ev(REG(75_000_000_000_000n)));
    expectAllow(ev(REG(FC_REGISTER_MAX_WEI)));
    expectDeny(ev(REG(FC_REGISTER_MAX_WEI + 1n)), "PER_TX_CAP");
  });
  it("M3D-fc: platform.farcaster absent ⇒ NO_RULE (module disabled)", () => {
    expectDeny(ev(REG(1n), { cfg: noFc }), "NO_RULE");
  });
  it("M3D-fc: wrong target — the action carries none; a caller-supplied target / to / value ⇒ MALFORMED (K2 hardcodes the frozen idGateway)", () => {
    for (const extra of [{ to: CP }, { target: CP }, { idGateway: CP }, { value: 1n }]) expectDeny(ev(raw({ ...REG(1n), ...extra })), "MALFORMED");
    expectDeny(ev(raw({ kind: "fcRegister", priceWei: 0n })), "MALFORMED");
    expectDeny(ev(raw({ kind: "fcRegister", priceWei: 1 })), "MALFORMED");
  });
  it("M3D-fc: T0-exempt (negative runway) and not a balance check; G5 — optimism stale ⇒ STATE_STALE, other chains stale ⇒ allow", () => {
    expectAllow(ev(REG(1n), { state: mkRunwayState(0n, 0n, NOW - 30n * DAY) }));
    expectDeny(ev(REG(1n), { state: mkState({ staleChains: ["optimism"] }) }), "STATE_STALE");
    expectAllow(ev(REG(1n), { state: mkState({ staleChains: ["rh", "base", "arbitrum"] }) }));
  });
});

describe("M3D-fc: T7 fcAddKey (SPEC-M3D §3d)", () => {
  it("M3D-fc: key == own fc pubkey (any hex case) ⇒ allow", () => {
    expectAllow(ev(ADD()));
    expectAllow(ev(ADD(`0x${FC_PUBKEY.slice(2).toUpperCase()}`)));
  });
  it("M3D-fc: wrong key ⇒ WHITELIST; cfg without fcPublicKey ⇒ WHITELIST (fail closed); no farcaster ⇒ NO_RULE", () => {
    expectDeny(ev(ADD(`0x${"01".repeat(32)}`)), "WHITELIST");
    expectDeny(ev(ADD(), { cfg: noPubkey }), "WHITELIST");
    expectDeny(ev(ADD(), { cfg: noFc }), "NO_RULE");
  });
  it("M3D-fc: wrong target / malformed key or metadata ⇒ MALFORMED", () => {
    expectDeny(ev(raw({ ...ADD(), to: CP })), "MALFORMED");
    expectDeny(ev(raw({ ...ADD(), keyGateway: CP })), "MALFORMED");
    expectDeny(ev(raw({ kind: "fcAddKey", key: `0x${"fc".repeat(31)}`, metadata: META })), "MALFORMED");
    expectDeny(ev(raw({ kind: "fcAddKey", key: FC_PUBKEY, metadata: "0x" })), "MALFORMED");
    expectDeny(ev(raw({ kind: "fcAddKey", key: FC_PUBKEY, metadata: "0xabc" })), "MALFORMED");
  });
  it("M3D-fc: T0-exempt; optimism stale ⇒ STATE_STALE", () => {
    expectAllow(ev(ADD(), { state: mkRunwayState(0n, 0n, NOW - 30n * DAY) }));
    expectDeny(ev(ADD(), { state: mkState({ staleChains: ["optimism"] }) }), "STATE_STALE");
  });
});

describe("M3D-fc: S3 fcUserData pace cap + ledger (SPEC-M3D §3d)", () => {
  it("M3D-fc: fcUserDataToday < userDataPerDay (DEFAULT 4) ⇒ allow; == cap ⇒ PACE_CAP; configurable", () => {
    expect(cfg.userDataPerDay).toBe(4);
    expectAllow(ev(UD, { ledger: mkLedger({ fcUserDataToday: 3n }) }));
    expectDeny(ev(UD, { ledger: mkLedger({ fcUserDataToday: 4n }) }), "PACE_CAP");
    const c1 = resolveConfig({ platform: platformJson({ userDataPerDay: 1 }), agent: agentJson, ownAddresses: { treasury: TREASURY, action: ACTION } });
    expectDeny(ev(UD, { cfg: c1, ledger: mkLedger({ fcUserDataToday: 1n }) }), "PACE_CAP");
  });
  it("M3D-fc: never stale-blocked, no balances; malformed contentHash / sizeBytes ⇒ MALFORMED", () => {
    expectAllow(ev(UD, { state: mkState({ staleChains: ["rh", "base", "arbitrum", "optimism"] }) }));
    expectDeny(ev(raw({ ...UD, sizeBytes: 0n })), "MALFORMED");
    expectDeny(ev(raw({ ...UD, contentHash: "0x1234" })), "MALFORMED");
  });
  it("M3D-fc: applyApproved increments fcUserDataToday; the G4 forward roll resets it; rewound clock keeps it", () => {
    const L1 = applyApproved(mkLedger(), UD, NOW);
    expect(L1.fcUserDataToday).toBe(1n);
    expect(applyApproved(L1, UD, NOW).fcUserDataToday).toBe(2n);
    expect(rollLedger(L1, DAY0 + DAY).fcUserDataToday).toBe(0n);
    expect(rollLedger(L1, NOW - DAY)).toBe(L1);
    expect(emptyLedger(NOW).fcUserDataToday).toBe(0n);
    // fcRegister / fcAddKey carry no budget bucket
    expect(applyApproved(mkLedger(), REG(1n), NOW)).toEqual(mkLedger());
    expect(applyApproved(mkLedger(), ADD(), NOW)).toEqual(mkLedger());
  });
  it("M3D-fc: ledger (de)serialization round-trips fcUserDataToday; a pre-M3D row (field absent) reads as 0n", () => {
    const L = { ...mkLedger(), fcUserDataToday: 3n };
    expect(deserializeLedger(serializeLedger(L))).toEqual(L);
    const legacy = JSON.parse(serializeLedger(L)) as Record<string, unknown>;
    delete legacy.fcUserDataToday;
    expect(deserializeLedger(JSON.stringify(legacy)).fcUserDataToday).toBe(0n);
  });
});

describe("M3D-fc: wallets, chainsTouched, buildTx, LLM-schema exclusion", () => {
  it("M3D-fc: fcRegister/fcAddKey ⇒ treasury wallet, [optimism]; fcUserData ⇒ fc wallet, []", () => {
    expect(walletForAction("fcRegister")).toBe("treasury");
    expect(walletForAction("fcAddKey")).toBe("treasury");
    expect(walletForAction("fcUserData")).toBe("fc");
    expect(chainsTouched(REG(1n))).toEqual(["optimism"]);
    expect(chainsTouched(ADD())).toEqual(["optimism"]);
    expect(chainsTouched(UD)).toEqual([]);
  });
  it("M3D-fc: buildTx golden — fcRegister = IdGateway.register(recovery = treasury){value: priceWei}; fcAddKey = KeyGateway.add(1, key, 1, metadata); chain optimism (10)", () => {
    const IDG = parseAbi(["function register(address recovery) payable returns (uint256 fid, uint256 overpayment)"]);
    const KG = parseAbi(["function add(uint32 keyType, bytes key, uint8 metadataType, bytes metadata)"]);
    const r = buildTx(REG(75_000_000_000_000n), cfg, NOW);
    expect(r).toEqual({ chain: "optimism", chainId: 10, to: FC.idGateway, value: 75_000_000_000_000n, data: encodeFunctionData({ abi: IDG, functionName: "register", args: [TREASURY] }) });
    const a = buildTx(ADD(), cfg, NOW);
    expect(a).toEqual({ chain: "optimism", chainId: 10, to: FC.keyGateway, value: 0n, data: encodeFunctionData({ abi: KG, functionName: "add", args: [1, FC_PUBKEY, 1, META] }) });
    expect(() => buildTx(REG(1n), noFc, NOW)).toThrow(/platform\.farcaster/);
    expect(() => buildTx(ADD(), noFc, NOW)).toThrow(/platform\.farcaster/);
    expect(() => buildTx(UD, cfg, NOW)).toThrow(NoTxError);
  });
  it("M3D-fc: EXCLUDED from the LLM tool schema — no tool maps to fcRegister / fcAddKey / fcUserData, in any tier", () => {
    const banned = new Set(["fcRegister", "fcAddKey", "fcUserData"]);
    for (const t of TOOL_TABLE) for (const k of t.mapsTo) expect(banned.has(k), `${t.name} → ${k}`).toBe(false);
    for (const tier of ["Active", "Conserving", "Dormant", "Evicted"] as const) {
      const names = toolSchemaFor(tier).map((t) => t.name).join(" ");
      expect(names).not.toMatch(/fc|farcaster|register|key/i);
    }
  });
});
