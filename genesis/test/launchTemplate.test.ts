import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { assertLaunchPlatform, createLaunchHelper, LAUNCH_REQUIRED_PLATFORM_KEYS } from "../src/launchHelper.js";
import { memoryLogger } from "../src/log.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const TEMPLATE = join(REPO, "genesis", "e2e", "platform-template.testnet.json");
const AGENT8 = JSON.parse(readFileSync(join(here, "fixtures", "agent-8.json"), "utf8")) as { platform: Record<string, unknown> };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The committed testnet genesis config with launchHelper.platformTemplate pointed at `template`. */
function helperWith(template: unknown): () => unknown {
  const d = mkdtempSync(join(tmpdir(), "lh-m4d-"));
  dirs.push(d);
  const p = join(d, "tpl.json");
  writeFileSync(p, JSON.stringify(template));
  const cfg = loadConfig(join(REPO, "genesis", "e2e", "genesis.testnet.json"));
  const withTpl = { ...cfg, launchHelper: { ...cfg.launchHelper!, platformTemplate: p } };
  return () => createLaunchHelper(withTpl, memoryLogger(), { factory: { agentCount: async () => 7n } });
}

describe("M4D §3: launch template", () => {
  it("M4D §3: launch-helper template validation rejects a platform missing agentDnsRoot (absent / empty / non-string); the committed template carries vivarium.systems", () => {
    expect(LAUNCH_REQUIRED_PLATFORM_KEYS).toContain("agentDnsRoot");
    // agent 8's frozen platform predates the key ⇒ refused as a launch template.
    expect(AGENT8.platform.agentDnsRoot).toBeUndefined();
    expect(helperWith(AGENT8)).toThrow(/lacks launch-required platform keys: agentDnsRoot/);
    expect(helperWith({ platform: { ...AGENT8.platform, agentDnsRoot: "" } })).toThrow(/agentDnsRoot/);
    expect(helperWith({ platform: { ...AGENT8.platform, agentDnsRoot: 7 } })).toThrow(/agentDnsRoot/);
    expect(helperWith({ platform: { ...AGENT8.platform, agentDnsRoot: "vivarium.systems" } })).not.toThrow();
    // The committed testnet template.
    const committed = JSON.parse(readFileSync(TEMPLATE, "utf8")) as { platform: Record<string, unknown> };
    expect(committed.platform.agentDnsRoot).toBe("vivarium.systems");
    expect(() => assertLaunchPlatform(committed.platform)).not.toThrow();
    expect(() => assertLaunchPlatform(AGENT8.platform)).toThrow(/agentDnsRoot/);
  });
});
