"use client";

import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { defineChain } from "viem";

/**
 * Robinhood testnet (chain 46630), per contracts/deployments/testnet-46630.json.
 * Only used for chain metadata / address display — this slice has no
 * wallet-gated reads or writes (SPEC-M4A §2).
 */
export const rhTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_RH_RPC_URL || "https://rh-testnet.invalid"] },
  },
});

/** wagmi config: injected connector only (SPEC-M4A §2) — no WalletConnect, no RainbowKit. */
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
