"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";

import { truncateAddress } from "@/lib/format";

/**
 * Header wallet connect button. Injected connector only, address truncation
 * only — nothing else in this slice uses the wallet (SPEC-M4A §2).
 */
export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button
        onClick={() => disconnect()}
        className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 font-mono text-sm text-slate-200 transition hover:border-slate-600 hover:bg-slate-700"
        title="Disconnect wallet"
      >
        {truncateAddress(address)}
      </button>
    );
  }

  const injectedConnector = connectors[0];

  return (
    <button
      onClick={() => injectedConnector && connect({ connector: injectedConnector })}
      disabled={!injectedConnector || isPending}
      className="rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {isPending ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
