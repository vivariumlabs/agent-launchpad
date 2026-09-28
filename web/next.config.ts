import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  eslint: {
    // No ESLint config was scaffolded for this slice; `npx tsc --noEmit`
    // (run separately, per SPEC-M4A §2 acceptance) is the authoritative
    // type-check. Avoids `next build` attempting to auto-configure ESLint.
    ignoreDuringBuilds: true,
  },
  images: {
    // No agent images are hosted anywhere yet (imageURI is always empty for
    // current agents) — identicon fallback covers every card/profile. Add
    // remote patterns here once agents carry real imageURI values.
    remotePatterns: [],
  },
  webpack: (config) => {
    // wagmi's `wagmi/connectors` barrel only exports its full index (no deep
    // subpath), which statically pulls in every connector (Coinbase
    // baseAccount, MetaMask SDK, WalletConnect) even though we only ever
    // instantiate `injected()` (SPEC-M4A §2: injected connector only). Their
    // optional runtime deps below are not installed and never reached —
    // alias them away so webpack doesn't fail/warn resolving them at build
    // time. Standard mitigation for unreachable optional deps.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@coinbase/cdp-sdk": false,
      "@react-native-async-storage/async-storage": false,
      "pino-pretty": false,
    };
    return config;
  },
};

export default nextConfig;
