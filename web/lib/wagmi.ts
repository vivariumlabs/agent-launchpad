"use client";

import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { defineChain } from "viem";

/**
 * Robinhood testnet (chain 46630), per contracts/deployments/testnet-46630.json.
 * SPEC-M4B: the launch flow is the first wallet-gated functionality — the
 * allowance read and tx receipts go through this transport, so the default
 * is the public testnet RPC (same one indexer/e2e/testnet.json uses) rather
 * than a placeholder. Override with NEXT_PUBLIC_RH_RPC_URL.
 */
export const rhTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_RH_RPC_URL || "https://rpc.testnet.chain.robinhood.com"] },
  },
});

/** wagmi config: injected connector only (SPEC-M4A §2, M4B §3b) — no WalletConnect, no RainbowKit. */
export const wagmiConfig = createConfig({
  chains: [rhTestnet],
  connectors: [injected()],
  transports: {
    [rhTestnet.id]: http(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
