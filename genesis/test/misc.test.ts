// keyfile, watcher, canonical-primitive identity with the runtime, db basics.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalEncode as rtCanonicalEncode } from "../../runtime/src/policy/approval.js";
import { frozenConfigHash as rtFrozenConfigHash, FrozenConfigFileSchema as rtSchema, loadSplitConfig } from "../../runtime/src/config/schema.js";
import { canonicalEncode, frozenConfigHash, FrozenConfigFileSchema } from "../src/canonical.js";
import { verifyFrozen } from "../src/configSource.js";
import { GenesisDb } from "../src/db.js";
import { loadWallet } from "../src/keyfile.js";
import { memoryLogger } from "../src/log.js";
import { CURSOR_KEY, Watcher } from "../src/watcher.js";
import { FUNDING, FUNDING_PK } from "./helpers/harness.js";
import { MockWorld } from "./helpers/mockWorld.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "genesis-misc-"));

describe("canonical primitives are the RUNTIME's own (never reimplemented)", () => {
  it("same function objects as runtime/src (identity, not just equal output)", () => {
    expect(canonicalEncode).toBe(rtCanonicalEncode);
    expect(frozenConfigHash).toBe(rtFrozenConfigHash);
    expect(FrozenConfigFileSchema).toBe(rtSchema);
  });

  it("verifyFrozen accepts exactly what runtime loadSplitConfig accepts for the same expected hash", () => {
    const d = tmp();
    const cfg = { platform: { a: 1, Z: "0xABCDEF" }, agent: { agentId: 3, name: "n" } };
    const text = `{ "agent": { "name": "n", "agentId": 3 },\n  "platform": { "Z": "0xABCDEF", "a": 1 } }`;
    writeFileSync(join(d, "agent.json"), text);
    writeFileSync(join(d, "runtime.json"), "{}");
    const h = frozenConfigHash(cfg);
    expect(() => verifyFrozen(text, h, 3)).not.toThrow();
    // runtime's own loader computes the same frozenHash for the same bytes (it then fails schema
    // validation of the fixture's minimal platform/agent — irrelevant to the hash).
    expect(() => loadSplitConfig({ agentPath: join(d, "agent.json"), runtimePath: join(d, "runtime.json"), expectedHash: h })).not.toThrow(/config hash mismatch/);
  });
});

describe("keyfile", () => {
  it("raw hex (with/without 0x, whitespace) and cast-wallet JSON load to the same account", () => {
    const d = tmp();
    writeFileSync(join(d, "a"), `  ${FUNDING_PK}\n`);
    writeFileSync(join(d, "b"), FUNDING_PK.slice(2));
    writeFileSync(join(d, "c"), JSON.stringify({ schema_version: 1, success: true, data: [{ address: FUNDING, private_key: FUNDING_PK }], errors: [], warnings: [] }));
    expect(loadWallet(join(d, "a"))).toMatchObject({ format: "hex" });
    expect(loadWallet(join(d, "b")).account.address).toBe(FUNDING);
    const c = loadWallet(join(d, "c"));
    expect(c.format).toBe("json");
    expect(c.account.address).toBe(FUNDING);
  });

  it("the loaded account exposes no private key; errors never echo file contents", () => {
    const d = tmp();
    writeFileSync(join(d, "a"), FUNDING_PK);
    const { account } = loadWallet(join(d, "a"));
    expect(JSON.stringify(account).toLowerCase()).not.toContain(FUNDING_PK.slice(2));
    expect(Object.keys(account)).not.toContain("privateKey");
    writeFileSync(join(d, "bad"), `${FUNDING_PK.slice(0, 40)}zz-not-a-key`);
    try {
      loadWallet(join(d, "bad"));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/contents not shown/);
      expect((e as Error).message).not.toContain(FUNDING_PK.slice(2, 40));
    }
  });
});

describe("watcher", () => {
  function setup(confirmations = 0, range = 3): { w: MockWorld; db: GenesisDb; watcher: Watcher } {
    const w = new MockWorld();
    const db = new GenesisDb(join(tmp(), "g.sqlite"));
    return { w, db, watcher: new Watcher(db, w.launchpad(), { startBlock: 90n, confirmations, maxBlockRange: range }, memoryLogger()) };
  }

  it("inserts REQUESTED rows from AgentRequested logs, chunked, cursor persisted in kv", async () => {
    const { w, db, watcher } = setup();
    w.createAgent(`0x${"11".repeat(32)}`, FUNDING, FUNDING);
    w.mine();
    w.mine();
    w.createAgent(`0x${"22".repeat(32)}`, FUNDING, FUNDING);
    expect(await watcher.poll()).toEqual([1, 2]);
    expect(db.getLaunch(1)).toMatchObject({ state: "REQUESTED", configHash: `0x${"11".repeat(32)}`, creator: FUNDING });
    expect(db.getLaunch(2)!.requestBlock).toBe(Number(w.logs[1]!.blockNumber));
    expect(db.kvGet(CURSOR_KEY)).toBe((w.blockNumber + 1n).toString());
    expect(await watcher.poll()).toEqual([]);
  });

  it("replaying a range (cursor reset) never duplicates or resets a launch", async () => {
    const { w, db, watcher } = setup();
    w.createAgent(`0x${"11".repeat(32)}`, FUNDING, FUNDING);
    await watcher.poll();
    db.patchFlow({ kind: "genesis", id: 1 }, { state: "SEEDING" }, 1n);
    db.kvSet(CURSOR_KEY, "0");
    expect(await watcher.poll()).toEqual([]);
    expect(db.getLaunch(1)!.state).toBe("SEEDING");
  });

  it("stays `confirmations` blocks behind head", async () => {
    const { w, db, watcher } = setup(2);
    w.createAgent(`0x${"11".repeat(32)}`, FUNDING, FUNDING);
    expect(await watcher.poll()).toEqual([]);
    w.mine();
    w.mine();
    expect(await watcher.poll()).toEqual([1]);
    expect(db.getLaunch(1)).toBeDefined();
  });
});
