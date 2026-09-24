// SPEC-M3B §1 — wrapper around the `oyster-cvm` CLI (binary path from config), every invocation
// through the injected `Exec` (mocked in tests). Sources for every flag and output line:
//   - init params, order, attest/encrypt flags: runtime/SPEC-M3.md §3b, runtime/docker-compose.oyster.yml
//     header, runtime/scripts/compute-image-id.sh (CMD array) — test/oyster.test.ts asserts the
//     compute-image-id argv is byte-identical to the script's `--print-command` output;
//   - `deploy` / `list` / `verify` flags + sample output: oyster-monorepo cli/oyster-cvm/README.md
//     ("Job created with ID: 0x…", "IP address: a.b.c.d", "Verification successful");
//   - `verify --image-id`: runtime/spikes/m0-marlin-kms/RUNBOOK.md step 3 (M0-proven spelling);
//   - IP lookup: runtime/spikes/m0-marlin-kms/RESULTS.md — control plane `GET <cp>/ip?id=<jobId>&region=<r>`,
//     CP URL from the indexer GraphQL `providerById { cp }`.
// The wallet key is passed to the CLI as a FILE PATH (`--wallet-private-key-file`), never on argv.
// SPEC-M3C §7: optional `deploy --enclave-memory <MB>` / `--bandwidth <KBps>` (oyster-cvm 5.0.1;
// --bandwidth is KBps, default 10), pushed only when set; init params stay LAST.

import type { Exec } from "./exec.js";
import type { HttpClient } from "./http.js";

export interface OysterSettings {
  bin: string;
  deployment: string; // "arb"
  arch: "arm64" | "amd64";
  preset: string; // "blue"
  region: string;
  operator: string;
  instanceType?: string | undefined;
  rpc?: string | undefined;
  /** SPEC-M3C §7: `deploy --enclave-memory <MB>` (our image REQUIRES 3072; drill 2026-09-23). Unset ⇒ flag omitted (CLI default). */
  enclaveMemoryMb?: number | undefined;
  /** SPEC-M3C §7: `deploy --bandwidth <KBps>` (CLI 5.0.1: KBps, default 10). Unset ⇒ flag omitted. */
  bandwidthKbps?: number | undefined;
  indexerUrl: string;
  cpUrl?: string | undefined;
  deployTimeoutSec: number;
  verifyTimeoutSec: number;
  cliTimeoutSec: number;
  httpTimeoutSec: number;
}

export interface DeployParams {
  composePath: string;
  agentId: number;
  configHash: string;
  agentJsonPath: string;
  runtimeJsonPath: string;
  durationMin: number;
  walletKeyPath: string;
  jobName: string;
}

export interface DeployResult {
  ok: boolean;
  jobId: string | null;
  ip: string | null;
  detail: string;
}

export interface Oyster {
  computeImageId(p: { composePath: string; agentId: number; configHash: string }): Promise<string>;
  deploy(p: DeployParams): Promise<DeployResult>;
  listJobs(ownerAddress: string): Promise<string[]>;
  ip(jobId: string): Promise<string | null>;
  verify(ip: string, imageId: string): Promise<{ ok: boolean; detail: string }>;
}

const CONFIG_HASH_RE = /^0x[0-9a-f]{64}$/;
const IMAGE_ID_RE = /^[0-9a-f]{64}$/;
const JOB_ID_RE = /^0x[0-9a-fA-F]{1,64}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function canonicalAgentId(agentId: number): string {
  if (!Number.isSafeInteger(agentId) || agentId <= 0) throw new Error(`agentId must be a positive integer, got ${agentId}`);
  return agentId.toString(10); // canonical decimal, no padding (agent-7, never agent-007)
}

function lowerHash(configHash: string): string {
  const h = configHash.toLowerCase();
  if (!CONFIG_HASH_RE.test(h)) throw new Error(`configHash must be 0x + 64 hex, got ${configHash}`);
  return h;
}

function safePath(p: string, what: string): string {
  // Init param syntax is colon-separated (<path>:<attest>:<encrypt>:<type>:<value>): a colon in the
  // value would be ambiguous. Refuse rather than guess the CLI's parsing.
  if (p.length === 0 || p.includes(":") || p.includes("\n")) throw new Error(`${what} path unusable in an init param: ${JSON.stringify(p)}`);
  return p;
}

/** The two ATTESTED init params, in deploy order (SPEC-M3 §3b). They alone enter the image-id. */
export function attestedInitParams(agentId: number, configHash: string): string[] {
  return [`agent-id:1:0:utf8:agent-${canonicalAgentId(agentId)}`, `config-hash:1:0:utf8:${lowerHash(configHash)}`];
}

/** All FOUR init params, exactly as SPEC-M3 §3b / docker-compose.oyster.yml prescribe, in order. */
export function deployInitParams(agentId: number, configHash: string, agentJsonPath: string, runtimeJsonPath: string): string[] {
  return [
    ...attestedInitParams(agentId, configHash),
    `agent.json:0:0:file:${safePath(agentJsonPath, "agent.json")}`,
    `runtime.json:0:0:file:${safePath(runtimeJsonPath, "runtime.json")}`,
  ];
}

export function computeImageIdArgs(s: Pick<OysterSettings, "arch" | "preset">, p: { composePath: string; agentId: number; configHash: string }): string[] {
  // Mirrors runtime/scripts/compute-image-id.sh CMD=(oyster-cvm compute-image-id …) exactly.
  const [a, c] = attestedInitParams(p.agentId, p.configHash);
  return ["compute-image-id", "--docker-compose", p.composePath, "--arch", s.arch, "--preset", s.preset, "--init-params", a!, "--init-params", c!];
}

function positiveSafeInt(n: number, what: string): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${what} must be a positive integer, got ${n}`);
  return n;
}

export function deployArgs(s: OysterSettings, p: DeployParams): string[] {
  if (!Number.isSafeInteger(p.durationMin) || p.durationMin <= 0) throw new Error(`durationMin must be a positive integer`);
  const args = [
    "deploy",
    "--deployment", s.deployment,
    "--wallet-private-key-file", p.walletKeyPath,
    "--duration-in-minutes", String(p.durationMin),
    "--docker-compose", p.composePath,
    "--arch", s.arch,
    "--preset", s.preset,
    "--region", s.region,
    "--operator", s.operator,
    "--job-name", p.jobName,
  ];
  if (s.instanceType !== undefined) args.push("--instance-type", s.instanceType);
  if (s.rpc !== undefined) args.push("--rpc", s.rpc);
  if (s.enclaveMemoryMb !== undefined) args.push("--enclave-memory", String(positiveSafeInt(s.enclaveMemoryMb, "enclaveMemoryMb")));
  if (s.bandwidthKbps !== undefined) args.push("--bandwidth", String(positiveSafeInt(s.bandwidthKbps, "bandwidthKbps")));
  for (const ip of deployInitParams(p.agentId, p.configHash, p.agentJsonPath, p.runtimeJsonPath)) args.push("--init-params", ip);
  return args;
}

export function parseDeployOutput(out: string): { jobId: string | null; ip: string | null } {
  const text = stripAnsi(out);
  const jobs = [...text.matchAll(/Job created with ID:\s*(0x[0-9a-fA-F]+)/g)];
  const ips = [...text.matchAll(/IP address:\s*(\d{1,3}(?:\.\d{1,3}){3})/g)];
  const jobId = jobs.length > 0 ? jobs[jobs.length - 1]![1]!.toLowerCase() : null;
  const ipRaw = ips.length > 0 ? ips[ips.length - 1]![1]! : null;
  return { jobId, ip: ipRaw !== null && IPV4_RE.test(ipRaw) ? ipRaw : null };
}

/** `oyster-cvm list` table: first cell of each row is the job id. */
export function parseListOutput(out: string): string[] {
  const ids: string[] = [];
  for (const line of stripAnsi(out).split("\n")) {
    const m = /^\s*\|\s*(0x[0-9a-fA-F]+)\s*\|/.exec(line);
    if (m !== null) ids.push(m[1]!.toLowerCase());
  }
  return ids;
}

export function parseImageId(out: string): string | null {
  const ms = [...stripAnsi(out).matchAll(/Image ID:\s*([0-9a-fA-F]{64})/g)];
  return ms.length > 0 ? ms[ms.length - 1]![1]!.toLowerCase() : null;
}

export class OysterCli implements Oyster {
  constructor(
    private readonly s: OysterSettings,
    private readonly exec: Exec,
    private readonly http: HttpClient,
  ) {}

  async computeImageId(p: { composePath: string; agentId: number; configHash: string }): Promise<string> {
    const r = await this.exec.run(this.s.bin, computeImageIdArgs(this.s, p), { timeoutMs: this.s.cliTimeoutSec * 1000 });
    const id = parseImageId(`${r.stdout}\n${r.stderr}`);
    if (r.code !== 0 || id === null) throw new Error(`oyster-cvm compute-image-id failed (exit ${r.code}${r.timedOut ? ", timed out" : ""})`);
    return id;
  }

  async deploy(p: DeployParams): Promise<DeployResult> {
    const r = await this.exec.run(this.s.bin, deployArgs(this.s, p), { timeoutMs: this.s.deployTimeoutSec * 1000 });
    const { jobId, ip } = parseDeployOutput(`${r.stdout}\n${r.stderr}`);
    const ok = r.code === 0 && jobId !== null;
    const tail = stripAnsi(`${r.stdout}\n${r.stderr}`).trim().split("\n").slice(-3).join(" | ");
    return { ok, jobId, ip, detail: `exit ${r.code}${r.timedOut ? " (timed out)" : ""}: ${tail}` };
  }

  async listJobs(ownerAddress: string): Promise<string[]> {
    if (!ADDRESS_RE.test(ownerAddress)) throw new Error(`listJobs: bad address ${ownerAddress}`);
    const r = await this.exec.run(this.s.bin, ["list", "--address", ownerAddress, "--deployment", this.s.deployment], {
      timeoutMs: this.s.cliTimeoutSec * 1000,
    });
    if (r.code !== 0) throw new Error(`oyster-cvm list failed (exit ${r.code}${r.timedOut ? ", timed out" : ""})`);
    return parseListOutput(`${r.stdout}\n${r.stderr}`);
  }

  private async controlPlane(): Promise<string> {
    if (this.s.cpUrl !== undefined) return this.s.cpUrl;
    const query = `query { providerById(id: "${this.s.operator.toLowerCase()}") { cp } }`;
    const res = await this.http.postJson(this.s.indexerUrl, { query }, this.s.httpTimeoutSec * 1000);
    if (res.status !== 200) throw new Error(`oyster indexer returned HTTP ${res.status}`);
    let cp: unknown;
    try {
      cp = (JSON.parse(res.text) as { data?: { providerById?: { cp?: unknown } | null } }).data?.providerById?.cp;
    } catch {
      throw new Error("oyster indexer: unparseable response");
    }
    if (typeof cp !== "string" || !/^https?:\/\/[^\s]+$/.test(cp)) throw new Error("oyster indexer: provider has no valid cp url");
    return cp.replace(/\/+$/, "");
  }

  /** Enclave IP for a job, or null when the control plane does not (yet) know it. */
  async ip(jobId: string): Promise<string | null> {
    if (!JOB_ID_RE.test(jobId)) throw new Error(`ip: bad job id ${jobId}`);
    const cp = await this.controlPlane();
    const url = `${cp}/ip?id=${encodeURIComponent(jobId)}&region=${encodeURIComponent(this.s.region)}`;
    const res = await this.http.get(url, this.s.httpTimeoutSec * 1000);
    if (res.status !== 200) return null;
    const body = res.text.trim();
    let cand: unknown = body;
    if (body.startsWith("{")) {
      try {
        cand = (JSON.parse(body) as { ip?: unknown }).ip;
      } catch {
        return null;
      }
    }
    return typeof cand === "string" && IPV4_RE.test(cand.trim()) ? cand.trim() : null;
  }

  async verify(ip: string, imageId: string): Promise<{ ok: boolean; detail: string }> {
    if (!IPV4_RE.test(ip)) throw new Error(`verify: bad ip ${ip}`);
    if (!IMAGE_ID_RE.test(imageId)) throw new Error(`verify: bad image id ${imageId}`);
    const r = await this.exec.run(this.s.bin, ["verify", "--enclave-ip", ip, "--image-id", imageId], {
      timeoutMs: this.s.verifyTimeoutSec * 1000,
    });
    const text = stripAnsi(`${r.stdout}\n${r.stderr}`);
    const ok = r.code === 0 && /Verification successful/.test(text);
    return { ok, detail: `exit ${r.code}${r.timedOut ? " (timed out)" : ""}: ${text.trim().split("\n").slice(-2).join(" | ")}` };
  }
}
