// SPEC-M3 §1 — reproducible-image lint (unit, no docker): digest-pinned bases, no floating tags
// anywhere in the build/deploy artifacts, the Dockerfile's determinism rules, .dockerignore
// hygiene, and scripts/release.sh substitution on a fixture.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** The CI workflow lives at the monorepo root (GitHub only runs <repo root>/.github/workflows). */
const WORKFLOW = "../.github/workflows/build-image.yml";
const DIGEST_RE = /@sha256:[0-9a-f]{64}\b/;
const TEMPLATE_TOKEN = "IMAGE_REPO@sha256:PLACEHOLDER";
/** sha256 of better-sqlite3-v11.10.0-node-v127-linux-arm64.tar.gz (downloaded + hashed 2026-09-23). */
const BS3_PREBUILD_SHA256 = "7bdf1d50d7ba21f91a4d3c31da7b1acc1c10d7ef51dd887a6e07d851a75388da";

/** Non-comment, non-blank lines (shell/Dockerfile/YAML `#` comments; `# syntax=` kept separately). */
function codeLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

/** Join Dockerfile `\` continuations into logical instructions. */
function instructions(dockerfile: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const raw of dockerfile.split("\n")) {
    const l = raw.trim();
    if (cur === "" && (l === "" || l.startsWith("#"))) continue;
    if (l.endsWith("\\")) {
      cur += l.slice(0, -1) + " ";
      continue;
    }
    out.push((cur + l).trim());
    cur = "";
  }
  if (cur !== "") out.push(cur.trim());
  return out;
}

const dockerfile = read("Dockerfile");
const instrs = instructions(dockerfile);

describe("Dockerfile: pinned base + determinism rules", () => {
  it("no PLACEHOLDER digest remains (release.sh and build-image.sh refuse otherwise)", () => {
    expect(dockerfile).not.toMatch(/PLACEHOLDER/);
  });

  it("the # syntax= frontend is pinned by digest", () => {
    const first = dockerfile.split("\n")[0] ?? "";
    expect(first).toMatch(/^# syntax=docker\/dockerfile:[0-9.]+@sha256:[0-9a-f]{64}$/);
  });

  const froms = instrs.filter((i) => /^FROM\s/i.test(i));
  const stageNames: string[] = [];

  it("has the three stages build → deps → runtime, all --platform=linux/arm64", () => {
    expect(froms).toHaveLength(3);
    for (const f of froms) {
      const m = /^FROM\s+--platform=(\S+)\s+(\S+)\s+AS\s+(\S+)$/i.exec(f);
      expect(m, f).not.toBeNull();
      expect(m![1]).toBe("linux/arm64");
      stageNames.push(m![3]!);
    }
    expect(stageNames).toEqual(["build", "deps", "runtime"]);
  });

  it("every FROM pins the base BY DIGEST, and all stages use the same base bytes", () => {
    const digests = new Set<string>();
    for (const f of froms) {
      const image = f.split(/\s+/)[2]!;
      expect(image, f).toMatch(new RegExp(`^node${DIGEST_RE.source}$`));
      digests.add(image);
    }
    expect(digests.size).toBe(1);
  });

  it("no apt, no upgrades, no cache mounts, no curl/wget; the ONLY ADD is the checksum-pinned prebuild", () => {
    for (const i of instrs) {
      expect(i, i).not.toMatch(/apt-get|apt |apk |upgrade|--mount=type=cache|\bcurl\b|\bwget\b/);
    }
    const adds = instrs.filter((i) => /^ADD\s/i.test(i));
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatch(/^ADD --checksum=sha256:[0-9a-f]{64} https:\/\/github\.com\/WiseLibs\/better-sqlite3\/releases\/download\/v\S+\.tar\.gz \/tmp\/\S+$/);
  });

  it("better-sqlite3 prebuild: pinned sha256, version = lockfile, Node 22 ABI 127, linux-arm64; extracted + smoke-tested offline", () => {
    const add = instrs.find((i) => /^ADD\s/i.test(i))!;
    // PLACEHOLDER pattern (like the base digest): a non-hex checksum fails here and in "no PLACEHOLDER".
    const m = /^ADD --checksum=sha256:([0-9a-f]{64}) (\S+) (\S+)$/.exec(add);
    expect(m, add).not.toBeNull();
    expect(m![1]).toBe(BS3_PREBUILD_SHA256);
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string }> };
    const v = lock.packages["node_modules/better-sqlite3"]?.version;
    expect(v).toBeDefined();
    expect(m![2]).toBe(
      `https://github.com/WiseLibs/better-sqlite3/releases/download/v${v}/better-sqlite3-v${v}-node-v127-linux-arm64.tar.gz`,
    );
    const deps = instrs.slice(instrs.findIndex((i) => /^FROM\s.*\sAS\s+deps$/i.test(i)), instrs.findIndex((i) => /^FROM\s.*\sAS\s+runtime$/i.test(i)));
    expect(deps).toContain(add); // deps stage only — never in the shipped stage
    const extract = deps[deps.indexOf(add) + 1]!;
    expect(extract).toMatch(/^RUN --network=none tar -xzf /);
    expect(extract).toContain(m![3]!);
    expect(extract).toMatch(/-C node_modules\/better-sqlite3 /);
    expect(extract).toMatch(/--no-same-permissions/);
    expect(extract).toMatch(/chmod 0755 node_modules\/better-sqlite3\/build\/Release\/better_sqlite3\.node/);
    expect(extract).toMatch(/require\('better-sqlite3'\)/);
  });

  it("npm: lockfile-only installs, all with --ignore-scripts; NO lifecycle script runs (no npm rebuild)", () => {
    const runs = instrs.filter((i) => /^RUN\s/i.test(i)).join(" && ");
    const npmCmds = runs.split(/&&/).map((c) => c.trim()).filter((c) => /\bnpm\b/.test(c));
    const ci = npmCmds.filter((c) => /\bnpm ci\b/.test(c));
    expect(ci).toHaveLength(2);
    for (const c of ci) expect(c).toMatch(/--ignore-scripts/);
    expect(ci.filter((c) => /--omit=dev/.test(c))).toHaveLength(1);
    expect(runs).not.toMatch(/\bnpm (install|i|add|update)\b/);
    expect(runs).not.toMatch(/\bnpm rebuild\b|prebuild-install|node-gyp/);
    // npm cache removed in the same layer as every npm invocation
    for (const r of instrs.filter((i) => /^RUN\s/i.test(i) && /\bnpm\b/.test(i))) {
      expect(r).toMatch(/rm -rf \/root\/\.npm/);
    }
  });

  it("context COPYs are limited to the .dockerignore allowlist", () => {
    const allowed = new Set(["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "src"]);
    for (const c of instrs.filter((i) => /^COPY\s/i.test(i) && !/--from=/.test(i))) {
      const parts = c.split(/\s+/).slice(1).filter((p) => !p.startsWith("--"));
      for (const src of parts.slice(0, -1)) expect(allowed.has(src), `${c}: ${src}`).toBe(true);
    }
  });

  // SPEC-M3B §2 (rev 0 ruling) — INVERTED from s1's non-root assertion: the runtime runs as root so the
  // in-enclave TLS ingress can bind :443 (single-tenant enclave; Oyster host networking forbids port
  // mapping; setcap xattrs don't survive the reproducible build reliably). The USER line must be the
  // explicit `USER root` WITH its rationale comment, so the choice stays visible and deliberate.
  it("runtime stage: COPY --from only, every RUN is --network=none, explicit USER root (TLS :443), exact CMD", () => {
    const start = instrs.findIndex((i) => /^FROM\s.*\sAS\s+runtime$/i.test(i));
    const rt = instrs.slice(start + 1);
    for (const i of rt) {
      if (/^COPY\s/i.test(i)) expect(i, i).toMatch(/--from=(deps|build)\b/);
      if (/^RUN\s/i.test(i)) expect(i, i).toMatch(/^RUN --network=none\s/);
    }
    const users = rt.filter((i) => /^USER\s/i.test(i));
    expect(users).toEqual(["USER root"]);
    const userIdx = rt.findIndex((i) => /^USER\s/i.test(i));
    expect(dockerfile).toMatch(/# USER root — deliberate \(SPEC-M3B §2[\s\S]*binds :443[\s\S]*single-tenant[\s\S]*port mapping[\s\S]*setcap[\s\S]*\nUSER root\n/);
    const cmdIdx = rt.findIndex((i) => /^CMD\s/i.test(i));
    expect(cmdIdx).toBeGreaterThan(userIdx);
    expect(JSON.parse(rt[cmdIdx]!.replace(/^CMD\s+/, ""))).toEqual([
      "node", "dist/main.js", "--config", "/app/config/agent.json", "--db", "/data/agent.db",
    ]);
    expect(rt.some((i) => /^(ENTRYPOINT|ENV|ARG)\s/i.test(i))).toBe(false);
  });
});

describe("no floating tags anywhere (Dockerfile, compose, scripts, CI)", () => {
  const files = [
    "Dockerfile",
    "docker-compose.oyster.yml",
    "scripts/build-image.sh",
    "scripts/compute-image-id.sh",
    "scripts/release.sh",
    WORKFLOW,
  ];

  it("no :latest in any code line", () => {
    for (const f of files) for (const l of codeLines(read(f))) expect(l, `${f}: ${l}`).not.toMatch(/:latest\b/);
  });

  it("compose template: exactly one image line, the digest-pinned template token", () => {
    const images = codeLines(read("docker-compose.oyster.yml")).filter((l) => /^image:/.test(l));
    expect(images).toEqual([`image: ${TEMPLATE_TOKEN}`]);
  });

  it("scripts: every container image reference is digest-pinned", () => {
    for (const f of files.filter((x) => x.startsWith("scripts/"))) {
      for (const l of codeLines(read(f))) {
        const refs = l.match(/\b(moby\/buildkit|tonistiigi\/binfmt|docker\/dockerfile|node)(:[\w.-]+)?(@sha256:[0-9a-f]{64})?/g) ?? [];
        for (const r of refs) {
          if (r === "node" || !/[:@]/.test(r)) continue; // the bare word (e.g. `node dist/main.js`)
          expect(r, `${f}: ${l}`).toMatch(DIGEST_RE);
        }
      }
    }
  });

  it("workflow: every action is pinned to a full commit SHA", () => {
    const uses = codeLines(read(WORKFLOW)).filter((l) => /^(-\s+)?uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/uses:\s+[\w.-]+\/[\w.-]+@[0-9a-f]{40}(\s+#.*)?$/);
  });
});

describe("compose template (Oyster patterns from M0 fixed-a.yml)", () => {
  const c = read("docker-compose.oyster.yml");
  it("host networking, restart policy, /data volume, init-params mounts matching the compose command", () => {
    expect(c).toMatch(/^\s+network_mode: host$/m);
    expect(c).toMatch(/^\s+restart: unless-stopped$/m);
    expect(c).toMatch(/^\s+- agent-data:\/data$/m);
    expect(c).toMatch(/^\s+- \/init-params:\/init-params:ro$/m);
    expect(c).toMatch(/^\s+- \/init-params\/agent\.json:\/app\/config\/agent\.json:ro$/m);
    expect(c).toMatch(/^\s+- \/init-params\/runtime\.json:\/app\/config\/runtime\.json:ro$/m);
    expect(c).not.toMatch(/^\s+ports:/m); // host mode: publishing is meaningless
  });

  it("SPEC-M3 §3b: the (measured) compose command boots the split config: frozen agent.json + ops runtime.json", () => {
    const cmds = codeLines(c).filter((l) => /^command:/.test(l));
    expect(cmds).toHaveLength(1);
    expect(JSON.parse(cmds[0]!.replace(/^command:\s*/, ""))).toEqual([
      "node", "dist/main.js", "--config", "/app/config/agent.json", "--runtime", "/app/config/runtime.json", "--db", "/data/agent.db",
    ]);
  });
});

// Init param = <enclave_path>:<attest>:<encrypt>:<type>:<value> (docs.marlin.org "Initialization
// parameters"; attest=1 ⇒ part of the image-id ⇒ part of the KMS key binding).
const INIT_PARAM_RE = /\b(agent-id|config-hash|agent\.json|runtime\.json):([01]):([01]):(utf8|file):/g;
function initParams(text: string): Array<{ name: string; attest: string; encrypt: string; type: string }> {
  return [...text.matchAll(INIT_PARAM_RE)].map((m) => ({ name: m[1]!, attest: m[2]!, encrypt: m[3]!, type: m[4]! }));
}
const EXPECTED_PARAM: Record<string, string> = {
  "agent-id": "agent-id:1:0:utf8", // ATTESTED
  "config-hash": "config-hash:1:0:utf8", // ATTESTED (SPEC-M3 §3b)
  "agent.json": "agent.json:0:0:file", // UNATTESTED (its hash is attested)
  "runtime.json": "runtime.json:0:0:file", // UNATTESTED (ops, not hash-bound)
};

describe("init params: agent-id + config-hash ATTESTED, agent.json + runtime.json UNATTESTED", () => {
  // Keys bind to (codeHash, agentId, configHash): the frozen agent.json is bound through its attested
  // HASH (a modified file ⇒ boot refuses, or a different image-id ⇒ useless keys); runtime.json must
  // never be attested (ops changes would rotate every key and orphan the treasury).
  const files = ["docker-compose.oyster.yml", "scripts/compute-image-id.sh", "scripts/release.sh", "docs/REPRODUCIBLE-BUILD.md"];

  it("every init-param spelling in compose / scripts / docs has the right attest/encrypt/type", () => {
    const seen = new Set<string>();
    for (const f of files) {
      for (const p of initParams(read(f))) {
        seen.add(p.name);
        expect(`${f}: ${p.name}:${p.attest}:${p.encrypt}:${p.type}`).toBe(`${f}: ${EXPECTED_PARAM[p.name]}`);
      }
    }
    expect([...seen].sort()).toEqual(["agent-id", "agent.json", "config-hash", "runtime.json"]);
  });

  it("compose + scripts + docs each name all four params (config-hash included everywhere)", () => {
    for (const f of files) {
      const names = new Set(initParams(read(f)).map((p) => p.name));
      for (const n of ["agent-id", "config-hash"]) expect(names.has(n), `${f}: ${n}`).toBe(true);
      if (f !== "scripts/compute-image-id.sh") {
        for (const n of ["agent.json", "runtime.json"]) expect(names.has(n), `${f}: ${n}`).toBe(true);
      }
    }
  });

  it("compose documents the params and WHY: the (codeHash, agentId, configHash) binding; files unattested", () => {
    const c = read("docker-compose.oyster.yml");
    expect(c).toMatch(/agent-id:1:0:utf8:agent-<agentId>/);
    expect(c).toMatch(/config-hash:1:0:utf8:0x<64 hex>/);
    expect(c).toMatch(/agent\.json:0:0:file:/);
    expect(c).toMatch(/runtime\.json:0:0:file:/);
    expect(c).toMatch(/WHY config-hash IS ATTESTED BUT THE CONFIG FILES ARE NOT/);
    expect(c).toMatch(/\(codeHash, agentId, configHash\)/);
    expect(c).toMatch(/PUBLICLY VISIBLE/);
    const d = read("docs/REPRODUCIBLE-BUILD.md");
    expect(d).toMatch(/Why the config HASH is attested and the config files are not/);
    expect(d).toMatch(/\(codeHash, agentId, configHash\)/);
    expect(d).toMatch(/publicly visible/i);
  });

  it("release record lists all four params with the right attestation", () => {
    expect(read("scripts/release.sh")).toContain(
      `"initParams": ["agent-id:1:0:utf8:agent-<agentId>", "config-hash:1:0:utf8:<configHash>", "agent.json:0:0:file:<agent.json>", "runtime.json:0:0:file:<runtime.json>"]`,
    );
  });
});

describe(".dockerignore", () => {
  const lines = codeLines(read(".dockerignore"));
  it("is an allowlist: first rule `*`, negations only for the build inputs", () => {
    expect(lines[0]).toBe("*");
    const negations = lines.filter((l) => l.startsWith("!"));
    expect(negations.sort()).toEqual(["!package-lock.json", "!package.json", "!src", "!tsconfig.build.json", "!tsconfig.json"]);
  });
  it("explicitly excludes tests, secrets, .git, env files, build outputs", () => {
    for (const must of [".git", ".secrets", "**/.secrets", "test", "**/*.test.ts", "**/.env*", "**/*.pem", "node_modules", "dist", "out", "releases"]) {
      expect(lines, must).toContain(must);
    }
  });
});

describe("build pipeline wiring", () => {
  it("tsconfig.build.json compiles src only into dist/", () => {
    const t = JSON.parse(read("tsconfig.build.json")) as { extends: string; include: string[]; exclude: string[]; compilerOptions: Record<string, unknown> };
    expect(t.extends).toBe("./tsconfig.json");
    expect(t.include).toEqual(["src"]);
    expect(t.exclude).toContain("test");
    expect(t.compilerOptions.rootDir).toBe("src");
    expect(t.compilerOptions.outDir).toBe("dist");
  });
  it("ANS-104 cross-verification lib (@dha-team/arbundles) is DEV-only: never in dependencies, dev-flagged in the lockfile with its whole subtree, the runtime stage installs --omit=dev", () => {
    const p = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(Object.keys(p.dependencies).filter((d) => /arbundles|turbo-sdk|^arweave$/.test(d))).toEqual([]);
    expect(p.devDependencies["@dha-team/arbundles"]).toMatch(/^\d+\.\d+\.\d+$/); // exact pin
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { dev?: boolean; devOptional?: boolean }> };
    const arb = Object.entries(lock.packages).filter(([k]) => /(^|\/)node_modules\/(@dha-team\/arbundles|arweave|@ardrive\/turbo-sdk)$/.test(k));
    expect(arb.length).toBeGreaterThan(0);
    for (const [k, v] of arb) expect(v.dev === true, k).toBe(true);
    for (const [k, v] of Object.entries(lock.packages)) if (k.includes("node_modules/@dha-team/arbundles/")) expect(v.dev === true, k).toBe(true);
    // production node_modules come ONLY from the `deps` stage, whose npm ci omits dev dependencies
    const stages = dockerfile.split(/\n(?=FROM )/);
    const deps = stages.find((st) => /^FROM\s.*\sAS deps\b/m.test(st))!;
    const runtime = stages.find((st) => /^FROM\s.*\sAS runtime\b/m.test(st))!;
    const depsCi = instructions(deps).filter((i) => /\bnpm ci\b/.test(i));
    expect(depsCi).toHaveLength(1);
    expect(depsCi[0]).toMatch(/--omit=dev/);
    expect(instructions(runtime).filter((i) => /\bnpm\b/.test(i))).toEqual([]);
    const nmCopies = instructions(runtime).filter((i) => /^COPY\s/.test(i) && /node_modules/.test(i));
    expect(nmCopies.length).toBeGreaterThan(0);
    for (const c of nmCopies) expect(c).toMatch(/--from=deps\b/);
    expect(dockerfile).not.toMatch(/arbundles/);
  });

  it("M3D: Farcaster cross-verification lib (@farcaster/core) is DEV-only exactly like arbundles; @noble/hashes is a pinned PROD dependency (SPEC-M3D §3a/§4)", () => {
    const p = JSON.parse(read("package.json")) as { version: string; dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(p.version).toBe("0.1.4");
    expect(Object.keys(p.dependencies).filter((d) => /farcaster/.test(d))).toEqual([]);
    expect(p.devDependencies["@farcaster/core"]).toMatch(/^\d+\.\d+\.\d+$/); // exact pin
    expect(p.dependencies["@noble/hashes"]).toMatch(/^\d+\.\d+\.\d+$/); // exact pin, direct prod dep
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { dev?: boolean; devOptional?: boolean }> };
    const fc = Object.entries(lock.packages).filter(([k]) => /(^|\/)node_modules\/@farcaster\/core$/.test(k));
    expect(fc.length).toBeGreaterThan(0);
    for (const [k, v] of fc) expect(v.dev === true, k).toBe(true);
    for (const [k, v] of Object.entries(lock.packages)) if (k.includes("node_modules/@farcaster/core/")) expect(v.dev === true, k).toBe(true);
    const hashes = lock.packages["node_modules/@noble/hashes"];
    expect(hashes?.dev === true || hashes?.devOptional === true).toBe(false); // ships in the prod tree
    expect(dockerfile).not.toMatch(/farcaster/);
  });

  it("package.json has the build script the Dockerfile runs", () => {
    const p = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(p.scripts.build).toBe("tsc -p tsconfig.build.json");
  });
  it("all scripts parse (bash -n) and print usage on --help", () => {
    for (const s of ["build-image.sh", "compute-image-id.sh", "release.sh"]) {
      const f = join(ROOT, "scripts", s);
      expect(spawnSync("bash", ["-n", f]).status, s).toBe(0);
      const h = spawnSync("bash", [f, "--help"], { encoding: "utf8" });
      expect(h.status, s).toBe(0);
      expect(h.stdout, s).toMatch(/SPEC-M3/);
    }
  });
});

// ---- release.sh / compute-image-id.sh on fixtures ----

const tmp = mkdtempSync(join(tmpdir(), "repro-lint-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const DIGEST = `sha256:${"ab".repeat(32)}`;
const IMAGE_ID = "cd".repeat(32);
const CONFIG_HASH = `0x${"ef".repeat(32)}`;
const REPO = "ghcr.io/example-org/agent-runtime";

function release(args: string[], extra: { compose?: string; dockerfile?: string; outDir?: string } = {}) {
  return spawnSync(
    "bash",
    [
      join(ROOT, "scripts/release.sh"),
      "--compose", extra.compose ?? fixtureCompose,
      "--dockerfile", extra.dockerfile ?? join(ROOT, "Dockerfile"),
      "--out-dir", extra.outDir ?? join(tmp, "releases"),
      "--allow-dirty",
      ...args,
    ],
    { encoding: "utf8" },
  );
}

const fixtureCompose = join(tmp, "compose.template.yml");
copyFileSync(join(ROOT, "docker-compose.oyster.yml"), fixtureCompose);

describe("scripts/release.sh substitution (fixture)", () => {
  it("writes <version>.yml = template with ONLY the image token replaced, and a record JSON", () => {
    const r = release(["--version", "v1.2.3", "--repo", REPO, "--digest", DIGEST, "--agent-id", "7", "--config-hash", CONFIG_HASH, "--image-id", IMAGE_ID]);
    expect(r.status, r.stderr).toBe(0);
    const yml = readFileSync(join(tmp, "releases/v1.2.3.yml"), "utf8");
    const template = readFileSync(fixtureCompose, "utf8");
    expect(yml).toBe(template.replace(TEMPLATE_TOKEN, `${REPO}@${DIGEST}`));
    expect(yml).not.toMatch(/PLACEHOLDER|IMAGE_REPO/);
    const rec = JSON.parse(readFileSync(join(tmp, "releases/v1.2.3.json"), "utf8")) as Record<string, unknown>;
    expect(rec.version).toBe("v1.2.3");
    expect(rec.imageDigest).toBe(DIGEST);
    expect(rec.imageRef).toBe(`${REPO}@${DIGEST}`);
    expect(rec.composeFile).toBe("v1.2.3.yml");
    expect(rec.composeSha256).toBe(createHash("sha256").update(yml).digest("hex"));
    expect(rec.imageIds).toEqual({ "7": IMAGE_ID });
    expect(rec.configHashes).toEqual({ "7": CONFIG_HASH });
    expect(rec.platform).toBe("linux/arm64");
    expect(typeof rec.commit).toBe("string");
    expect(r.stdout).toMatch(/^RELEASE_COMPOSE=.*v1\.2\.3\.yml$/m);
  });

  it("releases are immutable: a second run for the same version exits 5 without touching files", () => {
    const before = readFileSync(join(tmp, "releases/v1.2.3.yml"), "utf8");
    const r = release(["--version", "v1.2.3", "--repo", "ghcr.io/other/x", "--digest", `sha256:${"ef".repeat(32)}`]);
    expect(r.status).toBe(5);
    expect(readFileSync(join(tmp, "releases/v1.2.3.yml"), "utf8")).toBe(before);
  });

  it("without an image-id source, records no image-ids", () => {
    const r = release(["--version", "v1.2.4", "--repo", REPO, "--digest", DIGEST]);
    expect(r.status, r.stderr).toBe(0);
    const rec = JSON.parse(readFileSync(join(tmp, "releases/v1.2.4.json"), "utf8")) as Record<string, unknown>;
    expect(rec.imageIds).toEqual({});
    expect(rec.configHashes).toEqual({});
  });

  it("--agent-id + --config-hash compute the image-id (oyster-cvm absent here ⇒ recorded as pending null)", () => {
    const r = spawnSync(
      "bash",
      [
        join(ROOT, "scripts/release.sh"),
        "--compose", fixtureCompose, "--dockerfile", join(ROOT, "Dockerfile"), "--out-dir", join(tmp, "releases"), "--allow-dirty",
        "--version", "v1.2.5", "--repo", REPO, "--digest", DIGEST, "--agent-id", "9", "--config-hash", CONFIG_HASH,
      ],
      { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" } },
    );
    expect(r.status, r.stderr).toBe(0);
    const rec = JSON.parse(readFileSync(join(tmp, "releases/v1.2.5.json"), "utf8")) as Record<string, unknown>;
    expect(rec.imageIds).toEqual({ "9": null });
    expect(rec.configHashes).toEqual({ "9": CONFIG_HASH });
  });

  it.each([
    ["--config (agent.json is not part of the image-id; its hash is)", ["--version", "v2.0.0", "--repo", REPO, "--digest", DIGEST, "--agent-id", "1", "--config-hash", CONFIG_HASH, "--config", join(ROOT, "test/boot/fixtures/agent.json")]],
    ["--agent-id without --config-hash (image-id covers both)", ["--version", "v2.0.0", "--repo", REPO, "--digest", DIGEST, "--agent-id", "1"]],
    ["--config-hash without --agent-id", ["--version", "v2.0.0", "--repo", REPO, "--digest", DIGEST, "--config-hash", CONFIG_HASH]],
    ["uppercase config hash (utf8 bytes are measured)", ["--version", "v2.0.0", "--repo", REPO, "--digest", DIGEST, "--agent-id", "1", "--config-hash", `0x${"EF".repeat(32)}`]],
    ["config hash without 0x", ["--version", "v2.0.0", "--repo", REPO, "--digest", DIGEST, "--agent-id", "1", "--config-hash", "ef".repeat(32)]],
    ["tag instead of bare repo", ["--version", "v2.0.0", "--repo", `${REPO}:latest`, "--digest", DIGEST]],
    ["digest inside repo", ["--version", "v2.0.0", "--repo", `${REPO}@${DIGEST}`, "--digest", DIGEST]],
    ["short digest", ["--version", "v2.0.0", "--repo", REPO, "--digest", "sha256:abcd"]],
    ["uppercase digest", ["--version", "v2.0.0", "--repo", REPO, "--digest", `sha256:${"AB".repeat(32)}`]],
    ["floating version", ["--version", "latest", "--repo", REPO, "--digest", DIGEST]],
    ["padded agent id", ["--version", "v2.0.0", "--repo", REPO, "--digest", DIGEST, "--agent-id", "007", "--config-hash", CONFIG_HASH, "--image-id", IMAGE_ID]],
    ["image-id without agent id", ["--version", "v2.0.0", "--repo", REPO, "--digest", DIGEST, "--image-id", IMAGE_ID]],
    ["0x image-id", ["--version", "v2.0.0", "--repo", REPO, "--digest", DIGEST, "--agent-id", "1", "--config-hash", CONFIG_HASH, "--image-id", `0x${IMAGE_ID}`]],
  ])("rejects %s (exit 1, nothing written)", (_name, args) => {
    const r = release(args);
    expect(r.status).toBe(1);
    expect(existsSync(join(tmp, "releases/v2.0.0.yml"))).toBe(false);
  });

  it("refuses while the Dockerfile base digest is a PLACEHOLDER (exit 3)", () => {
    const df = join(tmp, "Dockerfile.placeholder");
    writeFileSync(df, dockerfile.replace(/node@sha256:[0-9a-f]{64}/g, "node@sha256:PLACEHOLDER"));
    const r = release(["--version", "v3.0.0", "--repo", REPO, "--digest", DIGEST], { dockerfile: df });
    expect(r.status).toBe(3);
    expect(existsSync(join(tmp, "releases/v3.0.0.yml"))).toBe(false);
  });

  it("refuses a template without exactly one image token", () => {
    const bad = join(tmp, "compose.two.yml");
    const t = readFileSync(fixtureCompose, "utf8");
    writeFileSync(bad, t + `  sidecar:\n    image: ${TEMPLATE_TOKEN}\n`);
    expect(release(["--version", "v4.0.0", "--repo", REPO, "--digest", DIGEST], { compose: bad }).status).toBe(1);
    const none = join(tmp, "compose.none.yml");
    writeFileSync(none, t.replace(TEMPLATE_TOKEN, `${REPO}@${DIGEST}`));
    expect(release(["--version", "v4.0.1", "--repo", REPO, "--digest", DIGEST], { compose: none }).status).toBe(1);
  });
});

describe("scripts/compute-image-id.sh (no oyster-cvm needed)", () => {
  const script = join(ROOT, "scripts/compute-image-id.sh");
  const cfg = join(ROOT, "test/boot/fixtures/agent.json");
  const rel = (): string => join(tmp, "releases/v1.2.3.yml");

  it("refuses the unsubstituted template (exit 3)", () => {
    const r = spawnSync("bash", [script, "--compose", fixtureCompose, "--agent-id", "7", "--config-hash", CONFIG_HASH], { encoding: "utf8" });
    expect(r.status).toBe(3);
  });

  it("--print-command: EXACTLY the two attested params, agent-id then config-hash (the files are not measured)", () => {
    const r = spawnSync("bash", [script, "--compose", rel(), "--agent-id", "7", "--config-hash", CONFIG_HASH, "--print-command"], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const cmd = r.stdout.trim();
    expect(cmd).toMatch(/^oyster-cvm compute-image-id --docker-compose \S+v1\.2\.3\.yml --arch arm64 --preset blue /);
    expect(cmd).toMatch(new RegExp(` --init-params agent-id:1:0:utf8:agent-7 --init-params config-hash:1:0:utf8:${CONFIG_HASH}$`));
    expect(cmd).not.toMatch(/agent\.json|runtime\.json/);
    expect(cmd.match(/--init-params/g)).toHaveLength(2);
  });

  it("--config-hash is required and must be 0x + 64 lowercase hex", () => {
    for (const bad of [null, "ef".repeat(32), `0x${"EF".repeat(32)}`, "0x1234", `0x${"ef".repeat(32)}0`]) {
      const args = [script, "--compose", rel(), "--agent-id", "7", ...(bad === null ? [] : ["--config-hash", bad]), "--print-command"];
      const r = spawnSync("bash", args, { encoding: "utf8" });
      expect(r.status, String(bad)).toBe(1);
      expect(r.stderr).toMatch(/config-hash/);
    }
  });

  it("--config is refused (would suggest the config FILE is measured)", () => {
    const r = spawnSync("bash", [script, "--compose", rel(), "--agent-id", "7", "--config-hash", CONFIG_HASH, "--config", cfg, "--print-command"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/UNATTESTED/);
  });

  it("rejects a padded / non-numeric agent id", () => {
    for (const bad of ["0007", "x", "0"]) {
      const r = spawnSync("bash", [script, "--compose", rel(), "--agent-id", bad, "--config-hash", CONFIG_HASH, "--print-command"]);
      expect(r.status, bad).toBe(1);
    }
  });
});
