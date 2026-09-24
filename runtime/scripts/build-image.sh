#!/usr/bin/env bash
# SPEC-M3 §1 — reproducible linux/arm64 build of the agent runtime image.
#
#   scripts/build-image.sh [--verify] [--smoke] [--out DIR] [--allow-dirty]
#
#   (default)      build once → OCI archive + print the image manifest digest
#   --verify       build TWICE in two fresh, separate BuildKit stores (no cache) and require
#                  identical digests — the reproducibility self-test (docs/REPRODUCIBLE-BUILD.md)
#   --smoke        additionally load the image into the local docker daemon and run
#                  `node dist/main.js --help` inside it
#   --out DIR      output directory (default: runtime/out, gitignored)
#   --allow-dirty  build even if the image inputs have uncommitted changes (the digest then
#                  corresponds to NO commit — never publish such a build)
#
# Determinism: BuildKit pinned by digest (the exporter's layer compression is part of the digest),
# SOURCE_DATE_EPOCH = committer timestamp of the last commit touching the image inputs,
# --output type=oci,rewrite-timestamp=true, --provenance=false, --sbom=false, --no-cache.
# Env: SOURCE_DATE_EPOCH may be preset only to build from a non-git source tree (verifiers
# working from a source archive); it must equal the value recorded in the release JSON.
#
# Exit codes: 0 ok · 1 usage/internal · 2 docker unavailable · 3 base image not pinned ·
#             4 dirty inputs · 5 no arm64 support · 6 NOT reproducible (digests differ)
set -euo pipefail

RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM="linux/arm64"
BUILDKIT_IMAGE="moby/buildkit:v0.33.0@sha256:6c2fa84a6b61ccd72899dde4239f8d5717f05f9a8ca6f3cad185fb1a95a94de3"
BINFMT_IMAGE="tonistiigi/binfmt:qemu-v10.2.3@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0"
BUILDER_A="agent-launchpad-repro-a"
BUILDER_B="agent-launchpad-repro-b"
# Exactly the files .dockerignore lets into the build context, plus the build recipe itself.
INPUTS=(package.json package-lock.json tsconfig.json tsconfig.build.json src Dockerfile .dockerignore)

VERIFY=0
SMOKE=0
ALLOW_DIRTY=0
OUT_DIR="$RUNTIME_DIR/out"

log() { printf '[build-image] %s\n' "$*" >&2; }
die() { local code="$1"; shift; printf '[build-image] ERROR: %s\n' "$*" >&2; exit "$code"; }
usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --verify) VERIFY=1 ;;
    --smoke) SMOKE=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --out) [ $# -ge 2 ] || die 1 "--out requires a directory"; OUT_DIR="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die 1 "unknown argument: $1" ;;
  esac
  shift
done

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

no_docker() {
  cat >&2 <<EOF
[build-image] $1
This build needs Docker Engine (>= 24) with the buildx plugin; BuildKit itself is pinned by
this script ($BUILDKIT_IMAGE). Nothing was built. Options:
  * Any machine with Docker: Apple Silicon / linux-arm64 hosts build natively; x86_64 hosts
    first register QEMU arm64 emulation:
      docker run --privileged --rm $BINFMT_IMAGE --install arm64
    then re-run: scripts/build-image.sh --verify
  * CI: <repo root>/.github/workflows/build-image.yml runs the same script on a tag push (arm64 runner).
Third-party verification steps: docs/REPRODUCIBLE-BUILD.md
EOF
  exit 2
}

case "$OUT_DIR" in /*) ;; *) OUT_DIR="$PWD/$OUT_DIR" ;; esac

# ---- 1. static preconditions (no docker needed) ----
cd "$RUNTIME_DIR"
if grep -q 'PLACEHOLDER' Dockerfile; then
  die 3 "Dockerfile still contains a PLACEHOLDER base digest — pin node 22-bookworm-slim linux/arm64 by digest first"
fi

# ---- 2. docker / buildx (checked before git so docker-less machines get the useful message) ----
command -v docker >/dev/null 2>&1 || no_docker "docker CLI not found."
docker info >/dev/null 2>&1 || no_docker "docker daemon not reachable (is Docker running?)."
docker buildx version >/dev/null 2>&1 || no_docker "docker buildx plugin not available."

# ---- 3. source provenance ----
if [ -n "${SOURCE_DATE_EPOCH:-}" ]; then
  EPOCH="$SOURCE_DATE_EPOCH"
  log "SOURCE_DATE_EPOCH preset by caller: $EPOCH (source-tree build; must match the release record)"
  COMMIT="${GIT_COMMIT:-unknown}"
  INPUTS_COMMIT="unknown"
else
  git -C "$RUNTIME_DIR" rev-parse --git-dir >/dev/null 2>&1 \
    || die 1 "not a git checkout — set SOURCE_DATE_EPOCH to the release's recorded value"
  EPOCH="$(git -C "$RUNTIME_DIR" log -1 --format=%ct -- "${INPUTS[@]}")"
  [ -n "$EPOCH" ] || die 1 "image inputs have no commit yet — commit them first"
  COMMIT="$(git -C "$RUNTIME_DIR" rev-parse HEAD)"
  INPUTS_COMMIT="$(git -C "$RUNTIME_DIR" log -1 --format=%H -- "${INPUTS[@]}")"
  DIRTY="$(git -C "$RUNTIME_DIR" status --porcelain --untracked-files=all -- "${INPUTS[@]}")"
  if [ -n "$DIRTY" ]; then
    if [ "$ALLOW_DIRTY" -eq 1 ]; then
      log "WARNING: uncommitted image inputs — this digest corresponds to NO commit; never publish it"
      COMMIT="$COMMIT-dirty"
    else
      printf '%s\n' "$DIRTY" >&2
      die 4 "uncommitted changes in image inputs (above); commit them or pass --allow-dirty"
    fi
  fi
fi
case "$EPOCH" in ''|*[!0-9]*) die 1 "SOURCE_DATE_EPOCH must be a unix timestamp, got '$EPOCH'" ;; esac
export SOURCE_DATE_EPOCH="$EPOCH"


CREATED_BUILDERS=()
cleanup() {
  local b
  for b in ${CREATED_BUILDERS[@]+"${CREATED_BUILDERS[@]}"}; do
    docker buildx rm "$b" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# Fresh builder = fresh, isolated BuildKit store running the pinned BuildKit image.
fresh_builder() {
  local name="$1"
  docker buildx rm "$name" >/dev/null 2>&1 || true
  docker buildx create --name "$name" --driver docker-container \
    --driver-opt "image=$BUILDKIT_IMAGE" >/dev/null
  CREATED_BUILDERS+=("$name")
  local info
  info="$(docker buildx inspect --bootstrap "$name")"
  if ! printf '%s\n' "$info" | grep -q 'linux/arm64'; then
    printf '%s\n' "$info" >&2
    die 5 "builder has no linux/arm64 support. On x86_64 run: docker run --privileged --rm $BINFMT_IMAGE --install arm64"
  fi
}

build_once() {
  local builder="$1" dest="$2"
  log "building with $builder (SOURCE_DATE_EPOCH=$EPOCH) → $dest"
  docker buildx build \
    --builder "$builder" \
    --platform "$PLATFORM" \
    --no-cache \
    --provenance=false \
    --sbom=false \
    --build-arg "SOURCE_DATE_EPOCH=$EPOCH" \
    --output "type=oci,dest=$dest,rewrite-timestamp=true" \
    --file "$RUNTIME_DIR/Dockerfile" \
    "$RUNTIME_DIR"
}

# Manifest digest from the OCI archive's index.json (single-platform, no attestations ⇒ exactly
# one descriptor). This is the digest a registry serves and the compose file pins.
oci_digest() {
  local idx n
  idx="$(tar -xOf "$1" index.json)"
  n="$(printf '%s' "$idx" | grep -oE '"digest": ?"sha256:[0-9a-f]{64}"' | wc -l | tr -d ' ')"
  [ "$n" = "1" ] || die 1 "unexpected OCI index layout in $1 ($n descriptors): $idx"
  printf '%s' "$idx" | grep -oE 'sha256:[0-9a-f]{64}' | head -1
}

mkdir -p "$OUT_DIR"
TAR_A="$OUT_DIR/agent-runtime.oci.tar"
rm -f "$TAR_A"

fresh_builder "$BUILDER_A"
build_once "$BUILDER_A" "$TAR_A"
DIGEST="$(oci_digest "$TAR_A")"
log "digest A: $DIGEST"

if [ "$VERIFY" -eq 1 ]; then
  TAR_B="$OUT_DIR/verify-b.oci.tar"
  rm -f "$TAR_B"
  fresh_builder "$BUILDER_B"
  build_once "$BUILDER_B" "$TAR_B"
  DIGEST_B="$(oci_digest "$TAR_B")"
  log "digest B: $DIGEST_B"
  if [ "$DIGEST" != "$DIGEST_B" ]; then
    log "NOT REPRODUCIBLE: $DIGEST != $DIGEST_B"
    log "inspect with e.g. diffoci (github.com/reproducible-containers/diffoci):"
    log "  diffoci diff --semantic oci-archive://$TAR_A oci-archive://$TAR_B"
    exit 6
  fi
  rm -f "$TAR_B"
  log "REPRODUCIBLE: two independent no-cache builds produced $DIGEST"
fi

if [ "$SMOKE" -eq 1 ]; then
  SMOKE_REF="agent-runtime-smoke:local"
  log "smoke: loading into docker as $SMOKE_REF and running --help"
  docker buildx build --builder "$BUILDER_A" --platform "$PLATFORM" \
    --provenance=false --sbom=false --build-arg "SOURCE_DATE_EPOCH=$EPOCH" \
    --load -t "$SMOKE_REF" --file "$RUNTIME_DIR/Dockerfile" "$RUNTIME_DIR" >&2
  docker run --rm --platform "$PLATFORM" "$SMOKE_REF" node dist/main.js --help
  docker image rm "$SMOKE_REF" >/dev/null 2>&1 || true
fi

printf '%s\n' "$DIGEST" > "$OUT_DIR/image-digest.txt"
{
  printf 'imageDigest=%s\n' "$DIGEST"
  printf 'platform=%s\n' "$PLATFORM"
  printf 'commit=%s\n' "$COMMIT"
  printf 'inputsCommit=%s\n' "$INPUTS_COMMIT"
  printf 'sourceDateEpoch=%s\n' "$EPOCH"
  printf 'buildkit=%s\n' "$BUILDKIT_IMAGE"
  printf 'dockerfileSha256=%s\n' "$(sha256_of "$RUNTIME_DIR/Dockerfile")"
  printf 'lockfileSha256=%s\n' "$(sha256_of "$RUNTIME_DIR/package-lock.json")"
  printf 'verified=%s\n' "$VERIFY"
} > "$OUT_DIR/build-info.txt"

log "wrote $TAR_A, $OUT_DIR/image-digest.txt, $OUT_DIR/build-info.txt"
log "publish (bit-exact, digest-preserving):"
log "  skopeo copy --preserve-digests oci-archive:$TAR_A docker://<registry>/<repo>:<version>"
log "then: scripts/release.sh --version <version> --repo <registry>/<repo> --digest $DIGEST"
printf 'IMAGE_DIGEST=%s\n' "$DIGEST"
