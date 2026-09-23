#!/usr/bin/env bash
# SPEC-M2C §4. Installs Foundry (forge/anvil/cast) for the chain-integration suite
# (`npm run test:integration`). Pinned to the version the M1 contracts were built
# with (contracts/README.md: Foundry 1.8.3). Idempotent.
#
# Route 1: the official foundryup installer.
# Route 2 (fallback, if foundryup is blocked): the release tarball from GitHub.
set -euo pipefail

FOUNDRY_VERSION="${FOUNDRY_VERSION:-v1.8.3}"
FOUNDRY_DIR="${FOUNDRY_DIR:-$HOME/.foundry}"
BIN="$FOUNDRY_DIR/bin"

if [ -x "$BIN/forge" ] && [ -x "$BIN/anvil" ] && [ -x "$BIN/cast" ]; then
  echo "foundry already installed: $("$BIN/forge" --version | head -1)"
  exit 0
fi

mkdir -p "$BIN"

install_foundryup() {
  curl -fsSL https://foundry.paradigm.xyz | bash
  "$BIN/foundryup" --install "$FOUNDRY_VERSION"
}

install_tarball() {
  local os arch
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "unsupported OS" >&2; return 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported arch" >&2; return 1 ;; esac
  local url="https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_${os}_${arch}.tar.gz"
  echo "fetching $url"
  curl -fsSL "$url" | tar -xz -C "$BIN"
}

install_foundryup || { echo "foundryup failed; falling back to release tarball" >&2; install_tarball; }

"$BIN/forge" --version | head -1
"$BIN/anvil" --version | head -1
echo "add to PATH: export PATH=\"$BIN:\$PATH\""
