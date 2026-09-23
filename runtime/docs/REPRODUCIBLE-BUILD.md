# Reproducible build & verification — agent runtime image

> SPEC-M3 §1, 06 §3.1. **The attested code hash must be reproducible from public source.** This page is
> the procedure for anyone (not just us) to rebuild the image, get the same digest, recompute the
> enclave image-id, and check it against what the on-chain registry and a live enclave report.

## 1. The chain of evidence

```
git commit ──(scripts/build-image.sh)──▶ image digest sha256:…      (content address of the OCI image)
                                              │ pinned in
                                              ▼
                     releases/<version>.yml  (compose; ONLY the image line differs from the template)
                                              │ + the ATTESTED init params agent-id + config-hash (NOT the files — §5a)
                                              │ + Oyster base enclave image (preset "blue", arm64)
                                              ▼ (oyster-cvm compute-image-id)
                                         image-id (32 bytes)
                          ├─ = AgentRegistry.instanceOf(agentId).codeHash   (on-chain)
                          ├─ = what `oyster-cvm verify --enclave-ip …` checks the live Nitro attestation against
                          └─ = what Nautilus KMS binds the agent's keys to (same image-id ⇒ same treasury key):
                               keys bind to (codeHash, agentId, configHash)
```

A mismatch at any arrow means the running agent is not the published code.

## 2. Prerequisites

- `git`, Docker Engine ≥ 24 with the `buildx` plugin (BuildKit itself is pinned by the script — you do
  not need a particular Docker version for byte-identical output).
- linux/arm64 execution: native on Apple Silicon / arm64 Linux. On x86_64 register QEMU once:
  `docker run --privileged --rm tonistiigi/binfmt:qemu-v10.2.3@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 --install arm64`
- For the image-id: the `oyster-cvm` CLI (github.com/marlinprotocol/oyster-monorepo, `cli/oyster-cvm`).
- ~3 GB free disk. Network access to Docker Hub, registry.npmjs.org and github.com (release assets).

## 3. Reproduce the image digest

```bash
git clone <public repo> agent-launchpad && cd agent-launchpad
V=v0.1.0                                     # the release under test
git checkout "$(jq -r .commit runtime/releases/$V.json)"
cd runtime
scripts/build-image.sh --verify              # builds twice in two fresh BuildKit stores, no cache
# → IMAGE_DIGEST=sha256:…   (also out/image-digest.txt, out/build-info.txt)
jq -r .imageDigest releases/$V.json          # must be identical
```

`--verify` already proves *your* two builds agree; comparing with `imageDigest` proves they agree with
ours. `out/build-info.txt` records `sourceDateEpoch` — it must equal `sourceDateEpoch` in the release JSON
(it is derived from git, see §6; a shallow clone can get it wrong — clone with full history).

Optional — confirm the registry serves those exact bytes:

```bash
skopeo inspect --raw "docker://$(jq -r .imageRef releases/$V.json)" | sha256sum   # = digest hex
```

## 4. Check the release compose

```bash
diff docker-compose.oyster.yml releases/$V.yml       # exactly one changed line: image: <repo>@<digest>
sha256sum releases/$V.yml                            # = composeSha256 in releases/$V.json
```

## 5. Recompute the image-id and compare

Init params are `<enclave_path>:<attest>:<encrypt>:<type>:<value>` (docs.marlin.org, "Initialization
parameters"): `attest=1` puts the param into the enclave's identity (the image-id), `encrypt=1` makes it
readable only inside the enclave. Each agent is deployed with exactly four, in this order:

| Init param | attest | Inside the enclave | Measured? |
|---|---|---|---|
| `agent-id:1:0:utf8:agent-<N>` | **1** | `/init-params/agent-id` | yes — image-id is per agent |
| `config-hash:1:0:utf8:0x<64 hex>` | **1** | `/init-params/config-hash` | yes — image-id is per frozen config |
| `agent.json:0:0:file:<agent.json>` | **0** | `/init-params/agent.json` → `/app/config/agent.json` | **no** (its hash is) |
| `runtime.json:0:0:file:<runtime.json>` | **0** | `/init-params/runtime.json` → `/app/config/runtime.json` | **no** |

`<N>` is the canonical decimal agentId, no padding (`agent-7`, never `agent-007`). The config hash is
`keccak256(canonicalEncode(agent.json))` — key order and whitespace do not matter — written as `0x` + 64
**lowercase** hex (the utf8 bytes are measured; any other spelling is a different image-id). Compute it with
the runtime's own code (a built checkout, or the released image itself):

```bash
node dist/main.js --print-config-hash --config agent.json      # → CONFIG_HASH=0x…
docker run --rm -v "$PWD/agent.json:/a.json:ro" <imageRef> node dist/main.js --print-config-hash --config /a.json
```

Boot refuses to start unless `/init-params/agent-id` equals `agent-` + `agent.agentId` **and**
`/init-params/config-hash` equals the hash of the `agent.json` it was given; with `runtime.tee: true` and no
`config-hash` param it refuses outright (no unbound TEE boots). The image-id is therefore **per agent and
per frozen config** (M0 drill: same compose + different agent-id ⇒ different image-id ⇒ different keys; the
same holds for config-hash):

```bash
scripts/compute-image-id.sh --compose releases/$V.yml --agent-id <N> --config-hash 0x<hash>
# runs: oyster-cvm compute-image-id --docker-compose releases/$V.yml --arch arm64 --preset blue \
#         --init-params agent-id:1:0:utf8:agent-<N> --init-params config-hash:1:0:utf8:0x<hash>
# → IMAGE_ID=<64 hex>
```

### 5a. Why the config HASH is attested and the config files are not (do not change this)

> **Keys bind to (codeHash, agentId, configHash).** Nautilus KMS derives every agent key (treasury,
> action, fc, mem, chat) from the image-id, and the image-id covers every *attested* init param. The
> config is split in two (SPEC-M3 §3b):
>
> - **`agent.json` — the FROZEN identity config**: platform addresses (registry, hook, routers, USDC…),
>   the x402 allowlist with every `payTo`, all caps, the agent's identity/persona/models/social, and
>   `allowlistUpdatePubkey`. Exactly what genesis anchors on-chain (`AgentRequested.configHash`, 03 §10).
>   Its hash is attested. An attacker who deploys the same code with a **modified** `agent.json` (say, a
>   redirected `payTo`) has two options, both useless: keep the original `config-hash` — boot refuses,
>   the file does not match; or pass the modified file's hash — a different image-id, therefore
>   **different, empty keys**: that enclave controls none of the agent's funds. Revival must supply the
>   Arweave-published original (D10). The frozen config never changes; endpoint churn is handled by the
>   04 §4 signed allowlist updates, verified against `allowlistUpdatePubkey` — which lives in the frozen
>   file and so is covered by the same binding.
> - **`runtime.json` — mutable ops config**: RPC URLs, ports, dirs, KMS/attestation URLs, the x402 toggle,
>   the hosting stand-in, dbPath. Not attested and not hash-bound, so ops changes never produce a new
>   image-id (a new image-id ⇒ new keys ⇒ a new, empty treasury, orphaning the funds in the old one). It
>   holds **no spend authority**: a hostile `runtime.json` can lie about chain state (a fake RPC ⇒ wasted
>   pulses, denial of service, transactions that fail on the real chain) but can never redirect funds —
>   every destination and every cap comes from the frozen file, and the schema rejects any other key.
>
> Why attest the hash rather than the file: it is canonical (key order / whitespace free), 66 bytes, and
> anyone can recompute the image-id from the on-chain `configHash` + agentId + the release compose.
> `main --expected-hash` remains as an optional extra check (orchestrator convenience); the attested init
> param is the enforcement path.
>
> `test/build/repro-lint.test.ts` asserts agent-id and config-hash attested, agent.json and runtime.json
> unattested.

**Init params are publicly visible.** Unencrypted (`encrypt=0`) params are readable by anyone who can see
the deployment. `agent.json` and `runtime.json` must NEVER contain secrets: no API-keyed RPC URLs
(Alchemy/Infura keys in the path), no bearer tokens, no private keys. Use public/keyless RPC endpoints.

Compare against:

1. **Registry:** `AgentRegistry.instanceOf(<N>).codeHash` must equal `0x<IMAGE_ID>`, e.g.
   `cast call <registry> "instanceOf(uint256)((address,address,bytes32,string,uint64,uint32))" <N>`
   (third field; struct `AgentInstance` in contracts/src/interfaces/ILaunchpad.sol) or the
   `InstanceRegistered` event.
2. **Live enclave:** `oyster-cvm verify --enclave-ip <ip> --image-id <IMAGE_ID>` → "Verification successful"
   (Nitro attestation, AWS root of trust; attestation server on :1300).
3. **Keys (optional):** `oyster-cvm kms-derive --image-id <IMAGE_ID> --path treasury --key-type secp256k1/address/ethereum`
   should equal the registered `treasuryEOA` (keyring derive path names: `src/keyring/keyring.ts`).
4. **Config:** hash the Arweave-published `agent.json` (`--print-config-hash`) — it must equal the on-chain
   `AgentRequested.configHash` and the `config-hash` you passed to `compute-image-id.sh`.

`--preset blue --arch arm64` must match the deployment (the Oyster base enclave image is part of the
measurement). Record `oyster-cvm --version` with any published image-id.

## 6. What is pinned, and why

| Input | Pin | Where |
|---|---|---|
| Base image `node` 22-bookworm-slim (Node 22.23.2) | linux/arm64 manifest `sha256:f71fb9ca…9051` | `Dockerfile` (all 3 stages) |
| Dockerfile frontend | `docker/dockerfile:1.26.0@sha256:ecfaec9e…fc32` | `Dockerfile` line 1 |
| BuildKit (does the layer tar + gzip ⇒ decides layer digests) | `moby/buildkit:v0.33.0@sha256:6c2fa84a…4de3` | `scripts/build-image.sh` |
| npm dependencies | `package-lock.json` integrity hashes; `npm ci` only | `Dockerfile` |
| Timestamps | `SOURCE_DATE_EPOCH` = committer time of the last commit touching the image inputs (`git log -1 --format=%ct -- package.json package-lock.json tsconfig.json tsconfig.build.json src Dockerfile .dockerignore`) + `rewrite-timestamp=true` | `scripts/build-image.sh` |
| Build context | `.dockerignore` allowlist: package.json, package-lock.json, tsconfig*.json, src/ | `.dockerignore` |
| Attestations | `--provenance=false --sbom=false` (they embed build-time metadata) | `scripts/build-image.sh` |
| better-sqlite3 native binary | prebuild tarball sha256 `7bdf1d50…88da` via `ADD --checksum` | `Dockerfile` (deps stage) |
| CI actions | full commit SHAs | `<repo root>/.github/workflows/build-image.yml` |

Other determinism rules: no `apt-get` at all (nothing installed beyond the base), no cache mounts, npm
cache deleted in the same layer, the runtime stage is COPY-only plus one `RUN --network=none`, `tsc` output
is byte-stable (checked: two builds → identical `dist/`). Scoping the epoch to the image inputs means
commits that touch only other modules (contracts/, genesis/, docs) do not change the image digest.

**better-sqlite3 (the only native module) — pinned prebuild.** `better-sqlite3@11.10.0` publishes a
prebuilt binary for this exact target on its GitHub release:

| | |
|---|---|
| URL | `https://github.com/WiseLibs/better-sqlite3/releases/download/v11.10.0/better-sqlite3-v11.10.0-node-v127-linux-arm64.tar.gz` |
| tarball sha256 | `7bdf1d50d7ba21f91a4d3c31da7b1acc1c10d7ef51dd887a6e07d851a75388da` (1 041 023 bytes) |
| content | `build/Release/better_sqlite3.node` — ELF 64-bit aarch64, sha256 `2bdcfde76d902d1b83aa957fc359aa37b98e7291d6103f57da4a802ee1cb1aef` |
| target | Node 22 (ABI 127), linux, glibc, arm64 |

All packages install with `--ignore-scripts` — **no lifecycle script runs at all**, including
better-sqlite3's own `prebuild-install || node-gyp rebuild` (its download is not pinned by anything).
Instead the Dockerfile fetches the tarball with BuildKit `ADD --checksum=sha256:…` — the build fails on any
byte difference — extracts only `build/Release/better_sqlite3.node` into the package (mode 0755, root-owned),
and proves it loads with a `select 1` against `:memory:`. There is no compiler in the image. To check
the pin yourself:

```bash
curl -sSL -o bs3.tgz <URL above> && sha256sum bs3.tgz   # = 7bdf1d50…88da
```

Upgrading better-sqlite3 in `package-lock.json` requires updating the URL and checksum together; the lint
test fails if the Dockerfile's prebuild version differs from the lockfile's.

## 7. If digests differ

Run `scripts/build-image.sh --verify` first — if your own two builds differ, the non-determinism is local
(report it). If they agree with each other but not with the release, diff the images:

```bash
diffoci diff --semantic oci-archive://out/agent-runtime.oci.tar docker://<imageRef>
```

(github.com/reproducible-containers/diffoci). Typical causes: wrong commit, shallow clone (wrong epoch),
modified working tree (the script refuses unless `--allow-dirty`), different BuildKit (don't bypass the script).

## 8. Publishing (maintainers)

1. Commit everything; tag `runtime-vX.Y.Z`. CI (`<repo root>/.github/workflows/build-image.yml`) runs `build-image.sh
   --verify --smoke` on a native arm64 runner and uploads the OCI archive. Locally: `scripts/build-image.sh --verify --smoke`.
2. Two independent builds (CI + a maintainer machine) must print the same digest.
3. Push the verified bytes without re-encoding:
   `skopeo copy --preserve-digests oci-archive:out/agent-runtime.oci.tar docker://<registry>/<repo>:vX.Y.Z`
4. `scripts/release.sh --version vX.Y.Z --repo <registry>/<repo> --digest sha256:…` → writes
   `releases/vX.Y.Z.yml` + `releases/vX.Y.Z.json`; commit them. Per-agent image-ids are added at genesis:
   `--agent-id N --config-hash 0x<hash>` (the hash is passed as a value — computed with
   `--print-config-hash`, so there is exactly one canonicalEncode implementation), or
   `scripts/compute-image-id.sh --agent-id N --config-hash 0x<hash>`.
5. Deploy `releases/vX.Y.Z.yml` with the same attested init params used for the image-id, in the same order:
   `oyster-cvm deploy … --docker-compose releases/vX.Y.Z.yml --init-params agent-id:1:0:utf8:agent-<N> --init-params config-hash:1:0:utf8:0x<hash> --init-params agent.json:0:0:file:agent.json --init-params runtime.json:0:0:file:runtime.json`
   (agent.json + runtime.json UNATTESTED — §5a; neither may contain secrets).

Inside the enclave, init params appear under `/init-params/` (docs.marlin.org, "Initialization
parameters"); the compose mounts `/init-params` read-only, binds `/init-params/agent.json` and
`/init-params/runtime.json` to `/app/config/`, and its `command:` runs
`node dist/main.js --config /app/config/agent.json --runtime /app/config/runtime.json --db /data/agent.db`
(overriding the image's legacy single-file CMD; the compose is measured, so the command is too). Boot reads
`/init-params/agent-id` and `/init-params/config-hash` and refuses to start on a mismatch with the config —
or, with `runtime.tee`, when config-hash is absent. With `runtime.tee` the directory is fixed to
`/init-params`: `runtime.initParamsDir` (dev/test only) is refused, because the unattested runtime.json
could otherwise point boot at a forged `config-hash` while the real attested one keeps deriving the real keys.
