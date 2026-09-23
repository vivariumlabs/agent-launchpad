#!/usr/bin/env bash
# SPEC-M3 §1/§3b — cut a runtime release record from a verified image digest (offline; pushes nothing).
#
#   scripts/release.sh --version vX.Y.Z --repo <registry>/<repo> --digest sha256:<64 hex>
#                      [--agent-id <N> --config-hash 0x<64 hex> [--image-id <64 hex>]]
#                      [--compose FILE] [--dockerfile FILE] [--out-dir DIR] [--force] [--allow-dirty]
#
# Writes (default DIR = runtime/releases, committed; releases are immutable without --force):
#   DIR/<version>.yml   docker-compose.oyster.yml with IMAGE_REPO@sha256:<placeholder> replaced by
#                       <repo>@<digest> — the ONLY change; these exact bytes get deployed + measured
#   DIR/<version>.json  digest, compose sha256, source commit + SOURCE_DATE_EPOCH (for rebuilders),
#                       and per-agent image-id(s) + config hash(es): the image-id covers BOTH attested
#                       init params, agent-id and config-hash (keys bind to (codeHash, agentId,
#                       configHash); scripts/compute-image-id.sh). agent.json + runtime.json stay
#                       UNATTESTED. --agent-id + --config-hash compute the image-id now (needs
#                       oyster-cvm; recorded as pending if the CLI is absent); --image-id records a
#                       value computed elsewhere. The config hash is taken as a value, not computed
#                       here (one implementation of canonicalEncode — the runtime's):
#                         node dist/main.js --print-config-hash --config agent.json  → CONFIG_HASH=0x…
#
# Refuses when the image inputs have uncommitted changes (the recorded commit would not be what was
# built) unless --allow-dirty (fixtures/tests only; recorded as inputsDirty: true).
#
# Exit codes: 0 ok · 1 usage/validation · 3 Dockerfile base not pinned · 4 dirty inputs ·
#             5 release exists
set -euo pipefail

RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION=""
REPO=""
DIGEST=""
AGENT_ID=""
CONFIG_HASH=""
IMAGE_ID=""
COMPOSE="$RUNTIME_DIR/docker-compose.oyster.yml"
DOCKERFILE="$RUNTIME_DIR/Dockerfile"
OUT_DIR="$RUNTIME_DIR/releases"
FORCE=0
ALLOW_DIRTY=0
TOKEN='IMAGE_REPO@sha256:PLACEHOLDER'
INPUTS=(package.json package-lock.json tsconfig.json tsconfig.build.json src Dockerfile .dockerignore)

log() { printf '[release] %s\n' "$*" >&2; }
die() { local code="$1"; shift; printf '[release] ERROR: %s\n' "$*" >&2; exit "$code"; }
usage() { sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die 1 "--version requires a value"; VERSION="$2"; shift ;;
    --repo) [ $# -ge 2 ] || die 1 "--repo requires a value"; REPO="$2"; shift ;;
    --digest) [ $# -ge 2 ] || die 1 "--digest requires a value"; DIGEST="$2"; shift ;;
    --agent-id) [ $# -ge 2 ] || die 1 "--agent-id requires a value"; AGENT_ID="$2"; shift ;;
    --config-hash) [ $# -ge 2 ] || die 1 "--config-hash requires a value"; CONFIG_HASH="$2"; shift ;;
    --config) die 1 "--config is gone: agent.json is an UNATTESTED init param — pass its hash as --config-hash (node dist/main.js --print-config-hash --config agent.json)" ;;
    --image-id) [ $# -ge 2 ] || die 1 "--image-id requires a value"; IMAGE_ID="$2"; shift ;;
    --compose) [ $# -ge 2 ] || die 1 "--compose requires a file"; COMPOSE="$2"; shift ;;
    --dockerfile) [ $# -ge 2 ] || die 1 "--dockerfile requires a file"; DOCKERFILE="$2"; shift ;;
    --out-dir) [ $# -ge 2 ] || die 1 "--out-dir requires a directory"; OUT_DIR="$2"; shift ;;
    --force) FORCE=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die 1 "unknown argument: $1" ;;
  esac
  shift
done

# ---- validation (every value that reaches the output files is charset-restricted here) ----
RE_VERSION='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
RE_DIGEST='^sha256:[0-9a-f]{64}$'
# docker reference grammar, name only: [domain[:port]/]path — no tag, no digest.
RE_REPO='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]+)?(/[a-z0-9]+([._-]+[a-z0-9]+)*)+$'
RE_IMAGE_ID='^[0-9a-f]{64}$'
RE_AGENT_ID='^[1-9][0-9]*$'
RE_CONFIG_HASH='^0x[0-9a-f]{64}$'

[ -n "$VERSION" ] && [ -n "$REPO" ] && [ -n "$DIGEST" ] || { usage >&2; die 1 "--version, --repo and --digest are required"; }
[[ "$VERSION" =~ $RE_VERSION ]] || die 1 "--version must look like v1.2.3 (optional -suffix), got '$VERSION'"
[[ "$DIGEST" =~ $RE_DIGEST ]] || die 1 "--digest must be sha256:<64 lowercase hex>, got '$DIGEST'"
[[ "$REPO" =~ $RE_REPO ]] || die 1 "--repo must be a registry repository WITHOUT tag or digest (e.g. ghcr.io/org/agent-runtime), got '$REPO'"
if [ -n "$AGENT_ID" ]; then [[ "$AGENT_ID" =~ $RE_AGENT_ID ]] || die 1 "--agent-id must be a positive decimal integer without padding"; fi
if [ -n "$CONFIG_HASH" ]; then [[ "$CONFIG_HASH" =~ $RE_CONFIG_HASH ]] || die 1 "--config-hash must be 0x + 64 lowercase hex"; fi
# The image-id covers both attested params: one without the other cannot name an image-id.
if [ -n "$AGENT_ID" ] && [ -z "$CONFIG_HASH" ]; then die 1 "--agent-id needs --config-hash (the image-id covers both attested init params)"; fi
if [ -n "$CONFIG_HASH" ] && [ -z "$AGENT_ID" ]; then die 1 "--config-hash needs --agent-id (image-ids are per agent)"; fi
if [ -n "$IMAGE_ID" ]; then
  [[ "$IMAGE_ID" =~ $RE_IMAGE_ID ]] || die 1 "--image-id must be 64 lowercase hex (no 0x)"
  [ -n "$AGENT_ID" ] || die 1 "--image-id needs --agent-id and --config-hash (image-ids are per agent + config)"
fi
[ -f "$COMPOSE" ] || die 1 "compose template not found: $COMPOSE"
[ -f "$DOCKERFILE" ] || die 1 "Dockerfile not found: $DOCKERFILE"

if grep -q 'PLACEHOLDER' "$DOCKERFILE"; then
  die 3 "$DOCKERFILE still has a PLACEHOLDER base-image digest — no release from an unpinned base"
fi
N_TOKEN="$(grep -c "$TOKEN" "$COMPOSE" || true)"
[ "$N_TOKEN" = "1" ] || die 1 "compose template must contain exactly one '$TOKEN' line (found $N_TOKEN)"

mkdir -p "$OUT_DIR"
OUT_YML="$OUT_DIR/$VERSION.yml"
OUT_JSON="$OUT_DIR/$VERSION.json"
if [ "$FORCE" -ne 1 ] && { [ -e "$OUT_YML" ] || [ -e "$OUT_JSON" ]; }; then
  die 5 "release $VERSION already exists in $OUT_DIR (releases are immutable; --force to overwrite)"
fi

# ---- provenance for rebuilders (same formula as scripts/build-image.sh) ----
COMMIT="unknown"; INPUTS_COMMIT="unknown"; EPOCH="null"; DIRTY_NOTE="false"
if git -C "$RUNTIME_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  COMMIT="$(git -C "$RUNTIME_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  INPUTS_COMMIT="$(cd "$RUNTIME_DIR" && git log -1 --format=%H -- "${INPUTS[@]}" 2>/dev/null || true)"
  E="$(cd "$RUNTIME_DIR" && git log -1 --format=%ct -- "${INPUTS[@]}" 2>/dev/null || true)"
  [ -n "$E" ] && EPOCH="$E"
  [ -n "$INPUTS_COMMIT" ] || INPUTS_COMMIT="unknown"
  if [ -n "$(cd "$RUNTIME_DIR" && git status --porcelain --untracked-files=all -- "${INPUTS[@]}" 2>/dev/null)" ]; then
    [ "$ALLOW_DIRTY" -eq 1 ] || die 4 "image inputs have uncommitted changes — commit first (or --allow-dirty for fixtures)"
    DIRTY_NOTE="true"
    log "WARNING: image inputs have uncommitted changes — recorded as inputsDirty:true"
  fi
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# ---- substitution: exactly one token, nothing else touched ----
TMP_YML="$OUT_YML.tmp.$$"
WROTE=0; DONE=0
# All-or-nothing: a failure after the .yml is written removes this run's outputs.
on_exit() {
  rm -f "$TMP_YML"
  if [ "$WROTE" -eq 1 ] && [ "$DONE" -ne 1 ]; then rm -f "$OUT_YML" "$OUT_JSON"; fi
}
trap on_exit EXIT
sed "s|$TOKEN|$REPO@$DIGEST|" "$COMPOSE" > "$TMP_YML"
if grep -q -e 'PLACEHOLDER' -e 'IMAGE_REPO' "$TMP_YML"; then die 1 "substitution left a placeholder behind"; fi
grep -q "image: $REPO@$DIGEST\$" "$TMP_YML" || die 1 "substituted image line not found"
WROTE=1
mv "$TMP_YML" "$OUT_YML"
COMPOSE_SHA="$(sha256_of "$OUT_YML")"

# ---- image-id (per agent) ----
IMAGE_IDS="{}"
CONFIG_HASHES="{}"
[ -n "$AGENT_ID" ] && CONFIG_HASHES="{ \"$AGENT_ID\": \"$CONFIG_HASH\" }"
PENDING=0
if [ -n "$AGENT_ID" ] && [ -z "$IMAGE_ID" ]; then
  set +e
  CID_OUT="$("$RUNTIME_DIR/scripts/compute-image-id.sh" --compose "$OUT_YML" --agent-id "$AGENT_ID" --config-hash "$CONFIG_HASH")"
  CID_RC=$?
  set -e
  if [ "$CID_RC" -eq 0 ]; then
    IMAGE_ID="$(printf '%s\n' "$CID_OUT" | sed -n 's/^IMAGE_ID=//p' | tail -1)"
    [[ "$IMAGE_ID" =~ $RE_IMAGE_ID ]] || die 1 "compute-image-id returned '$IMAGE_ID'"
  elif [ "$CID_RC" -eq 2 ]; then
    log "oyster-cvm absent: image-id for agent $AGENT_ID recorded as pending (null; compute at genesis)"
    PENDING=1
  else
    die 1 "compute-image-id failed (exit $CID_RC)"
  fi
fi
if [ -n "$IMAGE_ID" ]; then IMAGE_IDS="{ \"$AGENT_ID\": \"$IMAGE_ID\" }"
elif [ "$PENDING" -eq 1 ]; then IMAGE_IDS="{ \"$AGENT_ID\": null }"; fi

cat > "$OUT_JSON" <<EOF
{
  "version": "$VERSION",
  "imageRepo": "$REPO",
  "imageDigest": "$DIGEST",
  "imageRef": "$REPO@$DIGEST",
  "platform": "linux/arm64",
  "composeFile": "$VERSION.yml",
  "composeSha256": "$COMPOSE_SHA",
  "commit": "$COMMIT",
  "inputsCommit": "$INPUTS_COMMIT",
  "inputsDirty": $DIRTY_NOTE,
  "sourceDateEpoch": $EPOCH,
  "oyster": { "arch": "arm64", "preset": "blue", "initParams": ["agent-id:1:0:utf8:agent-<agentId>", "config-hash:1:0:utf8:<configHash>", "agent.json:0:0:file:<agent.json>", "runtime.json:0:0:file:<runtime.json>"] },
  "imageIds": $IMAGE_IDS,
  "configHashes": $CONFIG_HASHES
}
EOF

DONE=1
log "wrote $OUT_YML (sha256 $COMPOSE_SHA)"
log "wrote $OUT_JSON"
printf 'RELEASE_COMPOSE=%s\n' "$OUT_YML"
printf 'RELEASE_RECORD=%s\n' "$OUT_JSON"
