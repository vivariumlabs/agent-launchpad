"use client";

import Link from "next/link";
import { useState } from "react";
import { parseEventLogs } from "viem";
import { useConfig, useReadContract, useWriteContract } from "wagmi";
import { simulateContract, waitForTransactionReceipt } from "wagmi/actions";

import { AgentAvatar } from "../AgentAvatar";
import { TxHashText } from "./TxHashText";
import { BurnDialog, type BurnPhase } from "./BurnDialog";
import { formatAbsoluteTime, formatRelativeTime, formatUsdg, sameHex } from "@/lib/format";
import { agentNftAbi, displayName, distributorAbi, type NftContracts } from "@/lib/nfts";
import { rhTestnet } from "@/lib/wagmi";
import type { WalletNft } from "@/lib/types";

// ---------------------------------------------------------------------------
// Controller contract shared by the live (wagmi) and fixtures (simulated)
// cards — the view below never knows which one it is driving.
// ---------------------------------------------------------------------------

export type AccruedState =
  | { kind: "loading" }
  | { kind: "ok"; value: bigint }
  | { kind: "unavailable"; reason: string };

/** On-chain ownerOf(agentId) vs the viewing wallet. */
export type OwnerState = "loading" | "owner" | "not-owner" | "unknown";

export interface ClaimOutcome {
  amount: bigint;
  to: string | null;
  hash: string | null;
}

export interface BurnOutcome {
  /** Emancipated.sweptToTreasury from the receipt; null if the event was not found. */
  swept: bigint | null;
  hash: string | null;
}

export interface NftController {
  accrued: AccruedState;
  owner: OwnerState;
  /** null = writes allowed; otherwise why claim/burn are disabled. */
  writeBlocked: string | null;
  simulated: boolean;
  claim: (onSent: (hash: string | null) => void) => Promise<ClaimOutcome>;
  burn: (onSent: (hash: string | null) => void) => Promise<BurnOutcome>;
}

function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "shortMessage" in err && typeof err.shortMessage === "string") {
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Live controller: wagmi reads (accrued, ownerOf) + writes (claim, burn).
// ---------------------------------------------------------------------------

export function LiveNftCard({
  nft,
  contracts,
  wallet,
  writeBlocked,
}: {
  nft: WalletNft;
  contracts: NftContracts | null;
  wallet: `0x${string}`;
  writeBlocked: string | null;
}) {
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const id = BigInt(nft.agentId);
  const readsEnabled = contracts !== null && !nft.emancipated;

  const accruedQ = useReadContract({
    address: contracts?.distributor,
    abi: distributorAbi,
    functionName: "accrued",
    args: [id],
    chainId: rhTestnet.id,
    query: { enabled: readsEnabled },
  });
  const ownerQ = useReadContract({
    address: contracts?.nft,
    abi: agentNftAbi,
    functionName: "ownerOf",
    args: [id],
    chainId: rhTestnet.id,
    query: { enabled: readsEnabled, retry: 1 },
  });

  const accrued: AccruedState =
    contracts === null
      ? { kind: "unavailable", reason: "contract addresses unavailable" }
      : accruedQ.data !== undefined
        ? { kind: "ok", value: accruedQ.data }
        : accruedQ.isError
          ? { kind: "unavailable", reason: "RPC read failed" }
          : { kind: "loading" };

  const owner: OwnerState =
    contracts === null
      ? "unknown"
      : ownerQ.data !== undefined
        ? sameHex(ownerQ.data, wallet)
          ? "owner"
          : "not-owner"
        : ownerQ.isError
          ? // ownerOf reverts (ERC721NonexistentToken) once burned — either way, not ours to burn.
            "unknown"
          : "loading";

  const controller: NftController = {
    accrued,
    owner,
    writeBlocked: contracts === null ? "contract addresses unavailable" : writeBlocked,
    simulated: false,
    async claim(onSent) {
      if (!contracts) throw new Error("contract addresses unavailable");
      const { request } = await simulateContract(config, {
        address: contracts.distributor,
        abi: distributorAbi,
        functionName: "claim",
        args: [id],
        account: wallet,
        chainId: rhTestnet.id,
      });
      const hash = await writeContractAsync(request);
      onSent(hash);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: rhTestnet.id });
      if (receipt.status !== "success") throw new Error("claim reverted");
      const ev = parseEventLogs({ abi: distributorAbi, logs: receipt.logs, eventName: "Claimed" }).find(
        (l) => sameHex(l.address, contracts.distributor) && l.args.agentId === id,
      );
      await accruedQ.refetch();
      return { amount: ev?.args.amount ?? 0n, to: ev?.args.to ?? null, hash };
    },
    async burn(onSent) {
      if (!contracts) throw new Error("contract addresses unavailable");
      const { request } = await simulateContract(config, {
        address: contracts.nft,
        abi: agentNftAbi,
        functionName: "burn",
        args: [id],
        account: wallet,
        chainId: rhTestnet.id,
      });
      const hash = await writeContractAsync(request);
      onSent(hash);
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: rhTestnet.id });
      if (receipt.status !== "success") throw new Error("burn reverted");
      const ev = parseEventLogs({ abi: distributorAbi, logs: receipt.logs, eventName: "Emancipated" }).find(
        (l) => sameHex(l.address, contracts.distributor) && l.args.agentId === id,
      );
      return { swept: ev ? ev.args.sweptToTreasury : null, hash };
    },
  };

  return <NftCardView nft={nft} c={controller} />;
}

// ---------------------------------------------------------------------------
// Fixtures controller: simulated chain (no RPC, no wallet).
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function FixtureNftCard({
  nft,
  wallet,
  chain,
}: {
  nft: WalletNft;
  wallet: string;
  chain: { accrued: Record<string, string>; ownerOf: Record<string, string> };
}) {
  const raw = chain.accrued[String(nft.agentId)];
  const [accruedValue, setAccruedValue] = useState<bigint>(() =>
    raw !== undefined && /^\d+$/.test(raw) ? BigInt(raw) : 0n,
  );
  const ownerRaw = chain.ownerOf[String(nft.agentId)];

  const controller: NftController = {
    accrued: { kind: "ok", value: accruedValue },
    owner: ownerRaw === undefined ? "unknown" : sameHex(ownerRaw, wallet) ? "owner" : "not-owner",
    writeBlocked: null,
    simulated: true,
    async claim(onSent) {
      if (accruedValue === 0n) throw new Error("NothingToClaim()");
      await sleep(700);
      onSent(null);
      await sleep(1200);
      const amount = accruedValue;
      setAccruedValue(0n);
      return { amount, to: wallet, hash: null };
    },
    async burn(onSent) {
      await sleep(900);
      onSent(null);
      await sleep(1600);
      const swept = accruedValue;
      setAccruedValue(0n);
      return { swept, hash: null };
    },
  };

  return <NftCardView nft={nft} c={controller} />;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

type ClaimPhase =
  | { kind: "idle" }
  | { kind: "wallet" }
  | { kind: "pending"; hash: string | null }
  | { kind: "done"; outcome: ClaimOutcome }
  | { kind: "error"; message: string; sent: boolean };

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="font-mono text-sm text-slate-200">{value}</dd>
    </div>
  );
}

function NftCardView({ nft, c }: { nft: WalletNft; c: NftController }) {
  const [claim, setClaim] = useState<ClaimPhase>({ kind: "idle" });
  const [burnOpen, setBurnOpen] = useState(false);
  const [burnPhase, setBurnPhase] = useState<BurnPhase>({ kind: "explain" });
  const [burned, setBurned] = useState<BurnOutcome | null>(null);

  const name = displayName(nft);
  const emancipated = nft.emancipated || burned !== null;
  const claiming = claim.kind === "wallet" || claim.kind === "pending";
  const accruedValue = c.accrued.kind === "ok" ? c.accrued.value : null;
  const canClaim = !emancipated && c.writeBlocked === null && accruedValue !== null && accruedValue > 0n && !claiming;

  async function doClaim() {
    setClaim({ kind: "wallet" });
    let sent = false;
    try {
      const outcome = await c.claim((hash) => {
        sent = true;
        setClaim({ kind: "pending", hash });
      });
      setClaim({ kind: "done", outcome });
    } catch (err) {
      setClaim({ kind: "error", message: errMessage(err), sent });
    }
  }

  async function doBurn() {
    setBurnPhase({ kind: "wallet" });
    let sent = false;
    try {
      const outcome = await c.burn((hash) => {
        sent = true;
        setBurnPhase({ kind: "pending", hash });
      });
      setBurned(outcome);
      setBurnOpen(false);
      setBurnPhase({ kind: "explain" });
    } catch (err) {
      setBurnPhase({ kind: "error", message: errMessage(err), sent });
    }
  }

  const accruedText =
    c.accrued.kind === "ok"
      ? `${formatUsdg(c.accrued.value.toString())} USDG`
      : c.accrued.kind === "loading"
        ? "reading…"
        : "unavailable";

  const lifetimeText = nft.lifetimeClaimed === null ? "—" : `${formatUsdg(nft.lifetimeClaimed)} USDG`;
  const sweptKnown = burned ? burned.swept : nft.sweptToTreasury !== null ? BigInt(nft.sweptToTreasury) : null;

  return (
    <article
      className={`flex flex-col gap-4 rounded-xl border p-4 ${
        emancipated ? "border-violet-500/30 bg-violet-500/5" : "border-slate-800 bg-slate-900/60"
      }`}
    >
      <div className="flex items-center gap-3">
        <AgentAvatar agentId={nft.agentId} imageURI={null} name={nft.name} size={44} className="shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link href={`/agent/${nft.agentId}`} className="truncate font-medium text-slate-100 hover:text-white hover:underline">
              {name}
            </Link>
            {nft.symbol ? <span className="shrink-0 font-mono text-xs text-slate-500">{nft.symbol}</span> : null}
          </div>
          <p className="text-xs text-slate-500">NFT #{nft.agentId}</p>
        </div>
        {emancipated ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/15 px-2.5 py-0.5 text-xs font-medium text-violet-300 ring-1 ring-inset ring-violet-500/30">
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            Emancipated
          </span>
        ) : null}
      </div>

      <dl className="grid grid-cols-3 gap-2">
        {emancipated ? (
          <Stat label="Royalty leg" value="→ treasury" title="Every future royalty credit forwards to the agent's treasury" />
        ) : (
          <Stat label="Accrued" value={accruedText} title="Live distributor.accrued(agentId) view read" />
        )}
        <Stat label="Lifetime claimed" value={lifetimeText} title="Sum of indexed Claimed events" />
        <Stat
          label="Held since"
          value={nft.since === null ? "—" : formatRelativeTime(nft.since)}
          title={nft.since === null ? undefined : formatAbsoluteTime(nft.since)}
        />
      </dl>

      {burned ? (
        <div className="rounded-md border border-violet-500/30 bg-violet-500/10 p-3 text-sm text-violet-100">
          <p className="font-medium">{name} is emancipated.</p>
          <p className="mt-1 text-xs text-violet-200/80">
            {burned.swept === null
              ? "Burn confirmed, but the Emancipated event was not found in the receipt — check the agent's activity feed."
              : burned.swept === 0n
                ? "Nothing was left to sweep. From now on every royalty credit flows to its treasury."
                : `${formatUsdg(burned.swept.toString())} USDG swept to its treasury. From now on every royalty credit flows there too.`}{" "}
            <TxHashText hash={burned.hash} simulated={c.simulated} />
          </p>
        </div>
      ) : emancipated ? (
        <p className="text-xs text-slate-400">
          Burned — this agent&apos;s royalty leg flows to its own treasury forever.{" "}
          {sweptKnown !== null ? (
            <>Swept to treasury at burn: <span className="font-mono text-slate-200">{formatUsdg(sweptKnown.toString())} USDG</span>.</>
          ) : (
            <>
              Swept amount:{" "}
              <Link href={`/agent/${nft.agentId}`} className="text-accent hover:underline">
                see its activity feed →
              </Link>
            </>
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={doClaim}
              disabled={!canClaim}
              className="rounded-md border border-accent/40 bg-accent/15 px-3 py-1.5 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {claim.kind === "wallet"
                ? c.simulated
                  ? "Simulated wallet: signing…"
                  : "Confirm in your wallet…"
                : claim.kind === "pending"
                  ? "Waiting for receipt…"
                  : accruedValue === 0n
                    ? "Nothing to claim"
                    : c.simulated
                      ? "Simulate claim"
                      : "Claim"}
            </button>
            {c.owner === "owner" ? (
              <button
                type="button"
                onClick={() => {
                  setBurnPhase({ kind: "explain" });
                  setBurnOpen(true);
                }}
                disabled={c.writeBlocked !== null || claiming}
                className="rounded-md border border-red-500/30 px-3 py-1.5 text-sm text-red-300/90 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Burn &amp; emancipate…
              </button>
            ) : null}
          </div>
          {c.writeBlocked !== null ? <p className="text-xs text-amber-400">{c.writeBlocked}</p> : null}
          {c.owner === "not-owner" ? (
            <p className="text-xs text-amber-400">
              On-chain, this wallet no longer owns NFT #{nft.agentId} (the indexer may lag a transfer) — burn is
              hidden. Claim still pays whoever owns it.
            </p>
          ) : c.owner === "unknown" ? (
            <p className="text-xs text-slate-500">Could not verify ownership on-chain — burn hidden until it can be read.</p>
          ) : null}
          <p className="text-xs text-slate-500">
            Claim is permissionless: anyone may call it, and it always pays the current NFT owner.
          </p>
          {claim.kind === "done" ? (
            <p className="text-xs text-emerald-300">
              Claimed {formatUsdg(claim.outcome.amount.toString())} USDG
              {claim.outcome.to ? ` to ${claim.outcome.to.slice(0, 6)}…${claim.outcome.to.slice(-4)}` : ""}.{" "}
              <TxHashText hash={claim.outcome.hash} simulated={c.simulated} /> Lifetime total updates when the indexer
              catches up.
            </p>
          ) : claim.kind === "error" ? (
            <p className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
              {claim.sent
                ? `${claim.message} — the claim was sent but not confirmed; it may still land. Refresh before retrying.`
                : claim.message}
            </p>
          ) : null}
        </div>
      )}

      {burnOpen ? (
        <BurnDialog
          nft={nft}
          accrued={accruedValue}
          phase={burnPhase}
          onPhase={setBurnPhase}
          onSend={doBurn}
          onClose={() => setBurnOpen(false)}
          simulated={c.simulated}
        />
      ) : null}
    </article>
  );
}
