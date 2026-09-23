# syntax=docker/dockerfile:1.26.0@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
#
# Agent Launchpad runtime image — THE trust-model artifact (SPEC-M3 §1, 06 §3.1).
# The attested code hash must be reproducible from public source: build ONLY via
# scripts/build-image.sh (pinned BuildKit, SOURCE_DATE_EPOCH, OCI rewrite-timestamp,
# provenance/SBOM off). Third-party steps: docs/REPRODUCIBLE-BUILD.md.
#
# Base image (all three stages, same bytes):
#   tag     node 22-bookworm-slim   (Node 22.23.2, npm 10 bundled; bookworm/glibc, NOT alpine)
#   digest  linux/arm64/v8 platform manifest, pinned below
#   index   sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 (multi-arch, informational)
#   resolved 2026-09-23 from registry-1.docker.io. Bumping the base = new release = new image-id.
#
# better-sqlite3 install path (SPEC-M3 §1): PINNED PREBUILT, no lifecycle scripts at all. Every
# package installs with --ignore-scripts (better-sqlite3's own `prebuild-install || node-gyp rebuild`
# never runs — its download is unpinned). The native binary comes from exactly one file:
#   better-sqlite3-v11.10.0-node-v127-linux-arm64.tar.gz (Node 22 ABI = 127, glibc, aarch64 ELF)
#   sha256 7bdf1d50d7ba21f91a4d3c31da7b1acc1c10d7ef51dd887a6e07d851a75388da  (tarball, 1 041 023 B)
#   contents: build/Release/better_sqlite3.node sha256 2bdcfde76d902d1b83aa957fc359aa37b98e7291d6103f57da4a802ee1cb1aef
# fetched by BuildKit `ADD --checksum` (build FAILS on any byte difference), extracted into the
# package, then smoke-tested. No compiler in the image, ever. Bumping better-sqlite3 in the lockfile
# = bump this URL + checksum (the lint test cross-checks the version against package-lock.json).
#
# Determinism: lockfile-only installs (npm ci), no apt-get at all, no cache mounts, npm cache
# removed in the same layer, runtime stage is COPY-only plus one network-less RUN.

# ---- stage 1: compile TypeScript → dist/ (dev deps needed for tsc; nothing here ships) ----
FROM --platform=linux/arm64 node@sha256:f71fb9ca71b1b47d4d1a009af78147ed6cdc74f9c7cfc36cbde78ff985169051 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --update-notifier=false --loglevel=warn \
 && rm -rf /root/.npm /tmp/*
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
 && rm -rf /root/.npm /tmp/*

# ---- stage 2: production node_modules in a clean tree (no dev deps ever present) ----
FROM --platform=linux/arm64 node@sha256:f71fb9ca71b1b47d4d1a009af78147ed6cdc74f9c7cfc36cbde78ff985169051 AS deps
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --update-notifier=false --loglevel=warn \
 && rm -rf /root/.npm /tmp/*
ADD --checksum=sha256:7bdf1d50d7ba21f91a4d3c31da7b1acc1c10d7ef51dd887a6e07d851a75388da https://github.com/WiseLibs/better-sqlite3/releases/download/v11.10.0/better-sqlite3-v11.10.0-node-v127-linux-arm64.tar.gz /tmp/better-sqlite3-prebuild.tar.gz
RUN --network=none tar -xzf /tmp/better-sqlite3-prebuild.tar.gz -C node_modules/better-sqlite3 --no-same-owner --no-same-permissions build/Release/better_sqlite3.node \
 && chmod 0755 node_modules/better-sqlite3/build/Release/better_sqlite3.node \
 && node -e "const D=require('better-sqlite3');const d=new D(':memory:');if(d.prepare('select 1 as x').get().x!==1)process.exit(1);d.close();" \
 && rm -rf /tmp/*

# ---- stage 3: runtime (no network: COPY-only + one --network=none RUN) ----
FROM --platform=linux/arm64 node@sha256:f71fb9ca71b1b47d4d1a009af78147ed6cdc74f9c7cfc36cbde78ff985169051 AS runtime
WORKDIR /app
# Code and deps stay root-owned and read-only to the app user.
COPY --from=deps /deps/package.json ./package.json
COPY --from=deps /deps/node_modules ./node_modules
COPY --from=build /src/dist ./dist
# /data = agent db + snapshots (compose mounts the agent-data volume here); /app/config = mount
# point for the attested init-param config file (compose binds /init-params/agent.json).
RUN --network=none mkdir -p /data /app/config \
 && chown node:node /data \
 && chmod 0700 /data
USER node
CMD ["node", "dist/main.js", "--config", "/app/config/agent.json", "--db", "/data/agent.db"]
