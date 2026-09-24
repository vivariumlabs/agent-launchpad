// oyster.ts: exact argv (init params per SPEC-M3 §3b, key as a FILE path), parity with
// runtime/scripts/compute-image-id.sh, output parsing, control-plane IP lookup, verify.
// SPEC-M3C §7: optional --enclave-memory / --bandwidth deploy flags.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "../src/exec.js";
import type { HttpClient } from "../src/http.js";
import {
  attestedInitParams,
  computeImageIdArgs,
  deployArgs,
  deployInitParams,
  OysterCli,
  parseDeployOutput,
  parseImageId,
  parseListOutput,
  type OysterSettings,
} from "../src/oyster.js";

const RUNTIME = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "runtime");
const HASH = `0x${"a1".repeat(32)}`;

const S: OysterSettings = {
  bin: "/opt/oyster/oyster-cvm",
  deployment: "arb",
  arch: "arm64",
  preset: "blue",
  region: "ap-south-1",
  operator: "0xe10fa12f580e660ecd593ea4119cebc90509d642",
  indexerUrl: "https://indexer.oyster.marlin.org/graphql",
  deployTimeoutSec: 900,
  verifyTimeoutSec: 120,
  cliTimeoutSec: 60,
  httpTimeoutSec: 10,
};

class RecordingExec implements Exec {
  calls: Array<{ bin: string; args: readonly string[]; timeoutMs: number }> = [];
  constructor(private readonly reply: (args: readonly string[]) => ExecResult) {}
  async run(bin: string, args: readonly string[], opts: { timeoutMs: number }): Promise<ExecResult> {
    this.calls.push({ bin, args, timeoutMs: opts.timeoutMs });
    return this.reply(args);
  }
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });

describe("init params (SPEC-M3 §3b)", () => {
  it("builds EXACTLY the four params, in order, with canonical agent id + lowercase hash", () => {
    expect(deployInitParams(7, HASH.toUpperCase().replace("0X", "0x"), "/w/agent.json", "/w/runtime.json")).toEqual([
      "agent-id:1:0:utf8:agent-7",
      `config-hash:1:0:utf8:${HASH}`,
      "agent.json:0:0:file:/w/agent.json",
      "runtime.json:0:0:file:/w/runtime.json",
    ]);
  });

  it("refuses non-canonical agent ids, bad hashes and colon-bearing paths", () => {
    expect(() => attestedInitParams(0, HASH)).toThrow();
    expect(() => attestedInitParams(1.5, HASH)).toThrow();
    expect(() => attestedInitParams(1, "0x1234")).toThrow();
    expect(() => deployInitParams(1, HASH, "C:/agent.json", "/r.json")).toThrow(/init param/);
  });

  it("compute-image-id argv is identical to runtime/scripts/compute-image-id.sh --print-command", () => {
    const dir = mkdtempSync(join(tmpdir(), "genesis-cid-"));
    const compose = join(dir, "v1.2.3.yml");
    writeFileSync(compose, `services:\n  agent:\n    image: ghcr.io/x/agent-runtime@sha256:${"cd".repeat(32)}\n`);
    const r = spawnSync("bash", [join(RUNTIME, "scripts", "compute-image-id.sh"), "--compose", compose, "--agent-id", "7", "--config-hash", HASH, "--print-command"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const script = r.stdout.trim().split(/\s+/);
    expect(script[0]).toBe("oyster-cvm");
    expect(computeImageIdArgs(S, { composePath: compose, agentId: 7, configHash: HASH })).toEqual(script.slice(1));
  });
});

describe("deploy", () => {
  const p = {
    composePath: "/rel/v1.yml",
    agentId: 12,
    configHash: HASH,
    agentJsonPath: "/w/12/agent.json",
    runtimeJsonPath: "/w/12/runtime.json",
    durationMin: 43_200,
    walletKeyPath: "/secrets/funding.key",
    jobName: "agent-12",
  };

  it("argv: key passed as --wallet-file (never the key), compose, duration, init params last", () => {
    const a = deployArgs(S, p);
    expect(a.slice(0, 3)).toEqual(["deploy", "--deployment", "arb"]);
    expect(a[a.indexOf("--wallet-file") + 1]).toBe("/secrets/funding.key");
    expect(a).not.toContain("--wallet-private-key");
    expect(a[a.indexOf("--duration-in-minutes") + 1]).toBe("43200");
    expect(a[a.indexOf("--docker-compose") + 1]).toBe("/rel/v1.yml");
    expect(a[a.indexOf("--arch") + 1]).toBe("arm64");
    expect(a[a.indexOf("--preset") + 1]).toBe("blue");
    expect(a[a.indexOf("--job-name") + 1]).toBe("agent-12");
    const ips = a.filter((_, i) => a[i - 1] === "--init-params");
    expect(ips).toEqual(deployInitParams(12, HASH, p.agentJsonPath, p.runtimeJsonPath));
  });

  it("M3C-drift: --wallet-file replaces --wallet-private-key-file (oyster-cvm 5.0.1 CLI rename)", () => {
    const a = deployArgs(S, p);
    expect(a).toContain("--wallet-file");
    expect(a).not.toContain("--wallet-private-key-file");
  });

  it("M3C: --enclave-memory <MB> / --bandwidth <KBps> pushed when set (before the init params), omitted when unset", () => {
    const unset = deployArgs(S, p);
    expect(unset).not.toContain("--enclave-memory");
    expect(unset).not.toContain("--bandwidth");
    const a = deployArgs({ ...S, enclaveMemoryMb: 3072, bandwidthKbps: 250 }, p);
    expect(a[a.indexOf("--enclave-memory") + 1]).toBe("3072");
    expect(a[a.indexOf("--bandwidth") + 1]).toBe("250");
    expect(a.indexOf("--enclave-memory")).toBeLessThan(a.indexOf("--init-params"));
    expect(a.indexOf("--bandwidth")).toBeLessThan(a.indexOf("--init-params"));
    expect(a.slice(a.indexOf("--init-params"))).toEqual(unset.slice(unset.indexOf("--init-params")));
    const onlyMem = deployArgs({ ...S, enclaveMemoryMb: 3072 }, p);
    expect(onlyMem).toContain("--enclave-memory");
    expect(onlyMem).not.toContain("--bandwidth");
    expect(() => deployArgs({ ...S, enclaveMemoryMb: 0 }, p)).toThrow(/enclaveMemoryMb/);
    expect(() => deployArgs({ ...S, bandwidthKbps: 1.5 }, p)).toThrow(/bandwidthKbps/);
  });

  it("parses job id + IP from real-shaped (ANSI-coloured) output; missing id ⇒ not ok", async () => {
    const out = "\x1b[32m[INFO]\x1b[0m Job creation transaction: 0x38b…\n[INFO] Job created with ID: 0x000000000000000000000000000000000000000000000000000000000000037A\n[INFO] Found IP address: 13.232.1.2\n[INFO] Enclave is ready! IP address: 13.232.1.2\n";
    expect(parseDeployOutput(out)).toEqual({ jobId: `0x${"0".repeat(61)}37a`, ip: "13.232.1.2" });
    const cli = new OysterCli(S, new RecordingExec(() => ok(out)), { get: async () => ({ status: 500, text: "" }), postJson: async () => ({ status: 500, text: "" }) });
    const r = await cli.deploy(p);
    expect(r.ok).toBe(true);
    expect(r.jobId).toMatch(/37a$/);
    const bad = new OysterCli(S, new RecordingExec(() => ({ code: 1, stdout: "", stderr: "insufficient funds", timedOut: false })), { get: async () => ({ status: 500, text: "" }), postJson: async () => ({ status: 500, text: "" }) });
    expect((await bad.deploy(p)).ok).toBe(false);
  });

  it("list parses the job table", () => {
    const t = "+---+\n| ID | RATE |\n+---+\n| 0xABC1 | 0.05 | 1.00 USDC | AWS |\n| 0xdef2 | 0.05 | 2.00 USDC | AWS |\n+---+";
    expect(parseListOutput(t)).toEqual(["0xabc1", "0xdef2"]);
  });

  it("compute-image-id parses the Image ID log line; failure throws", async () => {
    expect(parseImageId(`[INFO] oyster_cvm::commands::image_id: Image ID: ${"AB".repeat(32)}`)).toBe("ab".repeat(32));
    const cli = new OysterCli(S, new RecordingExec(() => ({ code: 4, stdout: "", stderr: "boom", timedOut: false })), { get: async () => ({ status: 500, text: "" }), postJson: async () => ({ status: 500, text: "" }) });
    await expect(cli.computeImageId({ composePath: "/c.yml", agentId: 1, configHash: HASH })).rejects.toThrow(/compute-image-id failed/);
  });
});

describe("ip(jobId) via indexer GraphQL + control plane (M0 RESULTS)", () => {
  function http(cp: string | null, ipBody: string, status = 200): HttpClient & { urls: string[]; bodies: unknown[] } {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    return {
      urls,
      bodies,
      postJson: async (url, body) => {
        urls.push(url);
        bodies.push(body);
        return { status: 200, text: JSON.stringify({ data: { providerById: cp === null ? null : { cp } } }) };
      },
      get: async (url) => {
        urls.push(url);
        return { status, text: ipBody };
      },
    };
  }

  it("queries providerById(operator){cp} then GET <cp>/ip?id=<job>&region=<region>", async () => {
    const h = http("https://cp.example.com/", JSON.stringify({ id: "0x1", ip: "3.3.3.3" }));
    const cli = new OysterCli(S, new RecordingExec(() => ok("")), h);
    expect(await cli.ip("0x37a")).toBe("3.3.3.3");
    expect(h.urls[0]).toBe(S.indexerUrl);
    expect(JSON.stringify(h.bodies[0])).toContain(`providerById(id: \\"0xe10Fa12f580e660Ecd593Ea4119ceBC90509D642\\")`);
    expect(h.urls[1]).toBe("https://cp.example.com/ip?id=0x37a&region=ap-south-1");
  });

  it("M3C-drift: providerById query uses the EIP-55 checksummed operator address (lowercase config ⇒ checksummed query)", async () => {
    const h = http("https://cp.example.com/", JSON.stringify({ id: "0x1", ip: "3.3.3.3" }));
    const s: OysterSettings = { ...S, operator: "0xe10fa12f580e660ecd593ea4119cebc90509d642" };
    const cli = new OysterCli(s, new RecordingExec(() => ok("")), h);
    expect(await cli.ip("0x1")).toBe("3.3.3.3");
    expect(JSON.stringify(h.bodies[0])).toContain("0xe10Fa12f580e660Ecd593Ea4119ceBC90509D642");
  });

  it("plain-text IP accepted; garbage / non-200 ⇒ null; bad job id refused", async () => {
    expect(await new OysterCli(S, new RecordingExec(() => ok("")), http("https://cp", "4.4.4.4\n")).ip("0x1")).toBe("4.4.4.4");
    expect(await new OysterCli(S, new RecordingExec(() => ok("")), http("https://cp", "<html>")).ip("0x1")).toBeNull();
    expect(await new OysterCli(S, new RecordingExec(() => ok("")), http("https://cp", "", 404)).ip("0x1")).toBeNull();
    await expect(new OysterCli(S, new RecordingExec(() => ok("")), http("https://cp", "")).ip("0x1&x=y")).rejects.toThrow(/bad job id/);
    await expect(new OysterCli(S, new RecordingExec(() => ok("")), http(null, "")).ip("0x1")).rejects.toThrow(/no valid cp/);
  });

  it("configured cpUrl skips the indexer", async () => {
    const h = http("https://ignored", "5.5.5.5");
    expect(await new OysterCli({ ...S, cpUrl: "https://cp.fixed" }, new RecordingExec(() => ok("")), h).ip("0x2")).toBe("5.5.5.5");
    expect(h.urls).toEqual(["https://cp.fixed/ip?id=0x2&region=ap-south-1"]);
  });
});

describe("verify(ip, imageId)", () => {
  it("argv per M0 runbook; ok only on exit 0 AND 'Verification successful'", async () => {
    const ex = new RecordingExec(() => ok("[INFO] Verification successful ✓"));
    const cli = new OysterCli(S, ex, { get: async () => ({ status: 500, text: "" }), postJson: async () => ({ status: 500, text: "" }) });
    expect((await cli.verify("1.2.3.4", "ab".repeat(32))).ok).toBe(true);
    expect(ex.calls[0]!.args).toEqual(["verify", "--enclave-ip", "1.2.3.4", "--image-id", "ab".repeat(32)]);
    expect(ex.calls[0]!.bin).toBe(S.bin);
    const exitOkNoText = new OysterCli(S, new RecordingExec(() => ok("done")), { get: async () => ({ status: 500, text: "" }), postJson: async () => ({ status: 500, text: "" }) });
    expect((await exitOkNoText.verify("1.2.3.4", "ab".repeat(32))).ok).toBe(false);
    await expect(cli.verify("1.2.3.4; rm -rf /", "ab".repeat(32))).rejects.toThrow(/bad ip/);
  });
});
