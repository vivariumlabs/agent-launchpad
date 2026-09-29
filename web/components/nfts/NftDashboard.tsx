"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";

import { ConnectButton } from "../ConnectButton";
import { FixtureNftCard, LiveNftCard } from "./NftCard";
import { DEMO_WALLET } from "@/lib/chatFixtures";
import { truncateAddress } from "@/lib/format";
import { contractsForNft, normalizeWalletNfts } from "@/lib/nfts";
import { rhTestnet } from "@/lib/wagmi";
import type { ContractsResponse, WalletNft } from "@/lib/types";

type FixtureScenario = "happy" | "empty";

const FIXTURE_SCENARIOS: { id: FixtureScenario; label: string }[] = [
  { id: "happy", label: "3 NFTs (legacy + v2, one emancipated)" },
  { id: "empty", label: "Empty wallet" },
];

type ListState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; nfts: WalletNft[] }
  | { kind: "error"; message: string };

/**
 * /nfts (SPEC-M4E §3): connect → the wallet's agent NFTs (indexer, via the
 * web's /api/wallets/:address/nfts proxy) → per-card live accrued read,
 * one-click claim, R6 burn flow. Addresses come only from /api/contracts (R5).
 */
export function NftDashboard({
  contracts,
  fixtures,
  fixtureChain,
}: {
  contracts: ContractsResponse | null;
  fixtures: boolean;
  fixtureChain: { accrued: Record<string, string>; ownerOf: Record<string, string> } | null;
}) {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();
  const [simulate, setSimulate] = useState(false);
  const [scenario, setScenario] = useState<FixtureScenario>("happy");
  const [list, setList] = useState<ListState>({ kind: "idle" });
  const gen = useRef(0);

  // SPEC-M4G dual-stack: each card resolves ITS agent's stack addresses (contractsForNft).
  const chainMismatch = contracts !== null && contracts.chainId !== rhTestnet.id;
  const usable = contracts !== null && !chainMismatch ? contracts : null;

  const wallet: `0x${string}` | null =
    fixtures && simulate ? (DEMO_WALLET as `0x${string}`) : isConnected && address ? address : null;

  const load = useCallback(async () => {
    if (!wallet) {
      setList({ kind: "idle" });
      return;
    }
    const my = ++gen.current;
    setList({ kind: "loading" });
    try {
      const q = fixtures && scenario === "empty" ? "?scenario=empty" : "";
      const res = await fetch(`/api/wallets/${wallet}/nfts${q}`, { cache: "no-store" });
      const body: unknown = await res.json().catch(() => null);
      if (my !== gen.current) return;
      if (!res.ok) {
        const e = (body as { error?: unknown } | null)?.error;
        setList({ kind: "error", message: typeof e === "string" ? e : `status ${res.status}` });
        return;
      }
      const parsed = normalizeWalletNfts(body, wallet);
      if (!parsed) {
        setList({ kind: "error", message: "unexpected response shape" });
        return;
      }
      setList({ kind: "ok", nfts: parsed.nfts });
    } catch (err) {
      if (my === gen.current) setList({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [wallet, fixtures, scenario]);

  useEffect(() => {
    void load();
  }, [load]);

  const wrongChain = !fixtures && isConnected && chainId !== rhTestnet.id;
  const writeBlocked =
    usable === null
      ? chainMismatch
        ? `The indexer reports chain ${contracts?.chainId ?? "unknown"}, but this site is configured for ${rhTestnet.name} (${rhTestnet.id}) — claim/burn disabled.`
        : "Contract addresses are unavailable (indexer unreachable) — claim/burn disabled."
      : wrongChain
        ? `Switch your wallet to ${rhTestnet.name} to claim or burn.`
        : null;

  return (
    <div className="flex flex-col gap-6">
      {fixtures ? (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3">
          <p className="text-xs text-slate-400">
            Fixtures mode: the indexer, chain and wallet are mocked — nothing is sent anywhere. Use the demo wallet to
            walk claim and the burn flow.
          </p>
          <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Fixture scenario">
            {FIXTURE_SCENARIOS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={scenario === s.id}
                onClick={() => setScenario(s.id)}
                className={`rounded-md border px-2.5 py-1 text-xs transition ${
                  scenario === s.id
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!wallet ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/40 p-6">
          <p className="text-sm text-slate-300">
            Connect the wallet that holds your agent NFTs to see accrued royalties, claim them, or emancipate an agent.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <ConnectButton />
            {fixtures ? (
              <button
                type="button"
                onClick={() => setSimulate(true)}
                className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-600 hover:text-slate-100"
              >
                Simulate with demo wallet
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-400">
              Wallet <span className="font-mono text-slate-200">{truncateAddress(wallet)}</span>
              {fixtures && simulate ? " (demo)" : ""}
            </p>
            <div className="flex items-center gap-2">
              {fixtures && simulate ? (
                <button type="button" onClick={() => setSimulate(false)} className="text-xs text-slate-400 hover:text-slate-200">
                  Stop simulating
                </button>
              ) : null}
              <button type="button" onClick={() => void load()} className="text-xs text-slate-400 hover:text-slate-200">
                Refresh
              </button>
            </div>
          </div>

          {wrongChain ? (
            <button
              type="button"
              disabled={switching}
              onClick={() => switchChain({ chainId: rhTestnet.id })}
              className="self-start rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-300 disabled:opacity-50"
            >
              {switching ? "Switching…" : `Switch to ${rhTestnet.name}`}
            </button>
          ) : null}

          {!fixtures && usable === null ? (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">{writeBlocked}</p>
          ) : null}

          {list.kind === "loading" || list.kind === "idle" ? (
            <p className="text-sm text-slate-500">Reading your NFTs…</p>
          ) : list.kind === "error" ? (
            <div className="flex items-center gap-3 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
              <span>Could not load NFTs ({list.message}).</span>
              <button type="button" onClick={() => void load()} className="underline">
                Retry
              </button>
            </div>
          ) : list.nfts.length === 0 ? (
            <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-6">
              <p className="text-sm text-slate-300">This wallet holds no agent NFTs.</p>
              <p className="text-xs text-slate-500">
                An agent&apos;s NFT is minted to its creator when the agent goes live, and can be transferred like any
                ERC-721. A transfer from the last few blocks may not be indexed yet.
              </p>
              <Link href="/launch" className="text-sm text-accent hover:underline">
                Launch an agent →
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {list.nfts.map((nft) =>
                fixtures && fixtureChain ? (
                  <FixtureNftCard key={`${scenario}-${nft.agentId}`} nft={nft} wallet={wallet} chain={fixtureChain} />
                ) : (
                  <LiveNftCard
                    key={nft.agentId}
                    nft={nft}
                    resolved={usable === null ? { contracts: null, reason: writeBlocked } : contractsForNft(nft, usable)}
                    wallet={wallet}
                    writeBlocked={writeBlocked}
                  />
                ),
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
