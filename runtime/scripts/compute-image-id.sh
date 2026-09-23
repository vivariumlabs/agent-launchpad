#!/usr/bin/env bash
# SPEC-M3 §1/§3b — compute the Oyster enclave image-id for one agent deployment, offline.
#
#   scripts/compute-image-id.sh --compose releases/<version>.yml --agent-id <N> --config-hash 0x<64 hex>
#                               [--arch arm64] [--preset blue] [--print-command]
#
# image-id = enclave measurement over (base enclave image of the preset/arch) + the docker-compose
# file bytes + every ATTESTED init param (M0 RESULTS: A1/A2/A3 identical, B differs by compose,
# C differs by agent-id). It is what the KMS binds keys to and what the registry records as codeHash.
# Init param flags are <enclave_path>:<attest>:<encrypt>:<type>:<value> (docs.marlin.org,
# "Initialization parameters"; attest=1 ⇒ part of the image-id). Deploy passes FOUR params, in order:
#
#   --init-params "agent-id:1:0:utf8:agent-<N>"            → /init-params/agent-id     ATTESTED (measured)
#   --init-params "config-hash:1:0:utf8:0x<hash>"          → /init-params/config-hash  ATTESTED (measured)
#   --init-params "agent.json:0:0:file:<agent.json>"       → /init-params/agent.json   UNATTESTED
#   --init-params "runtime.json:0:0:file:<runtime.json>"   → /init-params/runtime.json UNATTESTED
#
# Only the two attested ones enter the image-id, so only they are passed here (same order as deploy).
# Keys bind to (codeHash, agentId, configHash): config-hash = keccak256(canonicalEncode(agent.json)),
# the FROZEN config (print it: node dist/main.js --print-config-hash --config agent.json); boot refuses
# unless agent.json hashes to it. The files themselves stay unattested: runtime.json (ops) must never
# rotate keys, and the canonical hash is what genesis anchors on-chain. Init params are public: neither
# file may hold secrets.
#
# <N> is the decimal agentId with no padding; <hash> is 0x + 64 LOWERCASE hex (its utf8 bytes are
# measured — any other spelling is a different image-id). stdout: a single line IMAGE_ID=<64 hex>.
# Logs go to stderr.
# Exit codes: 0 ok · 1 usage · 2 oyster-cvm CLI absent (instructions printed) ·
#             3 compose is the unsubstituted template · 4 CLI output unparseable
set -euo pipefail

COMPOSE=""
AGENT_ID=""
CONFIG_HASH=""
ARCH="arm64"
PRESET="blue"
PRINT_ONLY=0

die() { local code="$1"; shift; printf '[compute-image-id] ERROR: %s\n' "$*" >&2; exit "$code"; }
usage() { sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --compose) [ $# -ge 2 ] || die 1 "--compose requires a file"; COMPOSE="$2"; shift ;;
    --agent-id) [ $# -ge 2 ] || die 1 "--agent-id requires a value"; AGENT_ID="$2"; shift ;;
    --config-hash) [ $# -ge 2 ] || die 1 "--config-hash requires a value"; CONFIG_HASH="$2"; shift ;;
    --config) die 1 "--config is gone: agent.json is an UNATTESTED init param — pass its hash as --config-hash (ATTESTED)" ;;
    --arch) [ $# -ge 2 ] || die 1 "--arch requires a value"; ARCH="$2"; shift ;;
    --preset) [ $# -ge 2 ] || die 1 "--preset requires a value"; PRESET="$2"; shift ;;
    --print-command) PRINT_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die 1 "unknown argument: $1" ;;
  esac
  shift
done

[ -n "$COMPOSE" ] && [ -n "$AGENT_ID" ] && [ -n "$CONFIG_HASH" ] || { usage >&2; die 1 "--compose, --agent-id and --config-hash are required"; }
[ -f "$COMPOSE" ] || die 1 "compose file not found: $COMPOSE"
case "$AGENT_ID" in ''|0*|*[!0-9]*) die 1 "--agent-id must be a positive decimal integer without padding, got '$AGENT_ID'" ;; esac
[[ "$CONFIG_HASH" =~ ^0x[0-9a-f]{64}$ ]] || die 1 "--config-hash must be 0x + 64 lowercase hex, got '$CONFIG_HASH'"
case "$ARCH" in arm64|amd64) ;; *) die 1 "--arch must be arm64 or amd64" ;; esac
if grep -q '@sha256:PLACEHOLDER' "$COMPOSE"; then
  die 3 "$COMPOSE is the unsubstituted template — run scripts/release.sh and pass releases/<version>.yml"
fi

CMD=(oyster-cvm compute-image-id
  --docker-compose "$COMPOSE"
  --arch "$ARCH"
  --preset "$PRESET"
  --init-params "agent-id:1:0:utf8:agent-$AGENT_ID"
  --init-params "config-hash:1:0:utf8:$CONFIG_HASH")

print_cmd() { printf '%q ' "${CMD[@]}"; printf '\n'; }

if [ "$PRINT_ONLY" -eq 1 ]; then print_cmd; exit 0; fi

if ! command -v oyster-cvm >/dev/null 2>&1; then
  {
    echo "[compute-image-id] oyster-cvm CLI not found — nothing computed."
    echo "Install it (github.com/marlinprotocol/oyster-monorepo, cli/oyster-cvm; release binaries at"
    echo "artifacts.marlin.org), then run exactly:"
    printf '  '; print_cmd
    echo "and read the 'Image ID: <hex>' log line. Record 'oyster-cvm --version' with the result: the"
    echo "base enclave image behind --preset $PRESET is part of the measurement."
  } >&2
  exit 2
fi

printf '[compute-image-id] %s\n' "$(oyster-cvm --version 2>&1 | head -1 || true)" >&2
OUTPUT="$("${CMD[@]}" 2>&1)" || { printf '%s\n' "$OUTPUT" >&2; die 4 "oyster-cvm compute-image-id failed"; }
printf '%s\n' "$OUTPUT" >&2
IMAGE_ID="$(printf '%s\n' "$OUTPUT" | LC_ALL=C sed $'s/\033\\[[0-9;]*m//g' | grep -oE 'Image ID: [0-9a-fA-F]{64}' | tail -1 | awk '{print $3}' | tr 'A-F' 'a-f')"
[ -n "$IMAGE_ID" ] || die 4 "could not find 'Image ID: <64 hex>' in oyster-cvm output"
printf 'IMAGE_ID=%s\n' "$IMAGE_ID"
