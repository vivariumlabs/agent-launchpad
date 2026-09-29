// Mirrors runtime's §6 hygiene grep (runtime/test/policy/engine-global.test.ts) for genesis/src:
// no Date.now / Math.random / fetch( / process.env / crypto randomness outside explicit seams, no
// `any`, child_process only in exec.ts, the runtime package reached ONLY through canonical.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const files = walk(SRC).map((f) => ({ rel: f.slice(SRC.length + 1), code: stripComments(readFileSync(f, "utf8")) }));

describe("genesis/src hygiene", () => {
  it("covers the SPEC-M3B §1 components", () => {
    const rel = files.map((f) => f.rel);
    for (const must of ["db.ts", "watcher.ts", "oyster.ts", "machine.ts", "seeder.ts", "revival.ts", "main.ts", "config.ts", "clock.ts", "exec.ts", "http.ts"]) expect(rel).toContain(must);
  });

  it("no Date.now / Math.random / fetch( / process.env / crypto randomness (explicit allowlist)", () => {
    const bans: Array<[string, RegExp]> = [
      ["Date.now", /Date\.now/],
      ["Math.random", /Math\.random/],
      ["fetch(", /fetch\(/],
      ["process.env", /process\.env/],
      ["randomBytes", /randomBytes|randomUUID|getRandomValues/],
    ];
    // clock.ts = the one wall-clock seam; http.ts = the one network seam (Oyster indexer/CP, Arweave).
    const allow: Record<string, readonly string[]> = { "clock.ts": ["Date.now"], "http.ts": ["fetch("] };
    const hits: string[] = [];
    for (const f of files) for (const [name, re] of bans) if (re.test(f.code) && !(allow[f.rel] ?? []).includes(name)) hits.push(`${f.rel}: ${name}`);
    expect(hits).toEqual([]);
  });

  it("no `any`", () => {
    const hits = files.filter((f) => /(:\s*any\b|\bas\s+any\b|<any>|any\[\])/.test(f.code)).map((f) => f.rel);
    expect(hits).toEqual([]);
  });

  it("child_process only in exec.ts; network modules nowhere (fetch lives in http.ts)", () => {
    const hits: string[] = [];
    for (const f of files) {
      if (/from\s+["'](node:)?child_process["']/.test(f.code) && f.rel !== "exec.ts") hits.push(`${f.rel}: child_process`);
      if (/from\s+["'](node:)?(http|https|net|dgram|tls)["']/.test(f.code)) hits.push(`${f.rel}: network module`);
    }
    expect(hits).toEqual([]);
  });

  it("the runtime package is imported ONLY by canonical.ts (canonical primitives only) and runtimeArweave.ts (ANS-104 + Turbo HTTP only)", () => {
    // SPEC-M4E R2 — DELIBERATE extension: runtimeArweave.ts is the second narrow re-export seam, so the
    // launch-helper's Arweave publication reuses the runtime's ANS-104 signer/encoder and Turbo HTTP
    // client instead of duplicating crypto. Its export list is pinned exactly like canonical.ts's.
    const SEAMS = ["canonical.ts", "runtimeArweave.ts"];
    const hits = files.filter((f) => /from\s+["']agent-runtime\//.test(f.code) && !SEAMS.includes(f.rel)).map((f) => f.rel);
    expect(hits).toEqual([]);
    const exported = (rel: string): string[] =>
      [...files.find((f) => f.rel === rel)!.code.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)].flatMap((m) => m[1]!.split(",").map((s) => s.trim())).filter(Boolean).sort();
    expect(exported("canonical.ts")).toEqual(["FrozenConfigFileSchema", "canonicalEncode", "frozenConfigHash"]);
    expect(exported("runtimeArweave.ts")).toEqual([
      "DEFAULT_ARWEAVE_GATEWAY_URL",
      "DEFAULT_TURBO_UPLOAD_URL",
      "TURBO_APP_TAG",
      "TurboHttpOptions",
      "TurboHttpUploader",
      "TurboSigner",
      "TurboTag",
      "TurboUploader",
      "createSignedDataItem",
      "parseDataItem",
      "verifyDataItem",
    ]);
    // Only the attestation modules (and the keyring TYPE) are reachable through it.
    const arw = files.find((f) => f.rel === "runtimeArweave.ts")!.code;
    const mods = [...arw.matchAll(/from\s+["'](agent-runtime\/[^"']+)["']/g)].map((m) => m[1]!);
    expect([...new Set(mods)].sort()).toEqual([
      "agent-runtime/src/attestation/ans104.js",
      "agent-runtime/src/attestation/turbo.js",
      "agent-runtime/src/attestation/turboHttp.js",
      "agent-runtime/src/keyring/keyring.js",
    ]);
    expect(arw).toMatch(/export\s+type\s*\{\s*TurboSigner\s*\}\s*from\s+["']agent-runtime\/src\/keyring\/keyring\.js["']/);
  });

  it("SPEC-M4E R2: key generation (generatePrivateKey) only in arweavePublish.ts — the ephemeral Arweave signer seam", () => {
    const hits = files.filter((f) => /generatePrivateKey/.test(f.code) && f.rel !== "arweavePublish.ts").map((f) => f.rel);
    expect(hits).toEqual([]);
  });

  it("main.ts is argv-only; no raw private-key argv flag anywhere", () => {
    for (const f of files) expect(f.code, f.rel).not.toMatch(/"--wallet-private-key"/);
    expect(files.find((f) => f.rel === "main.ts")!.code).toMatch(/process\.argv/);
  });
});
