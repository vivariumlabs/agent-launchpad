"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseEventLogs } from "viem";
import { useAccount, useConfig, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { readContract, simulateContract, waitForTransactionReceipt } from "wagmi/actions";

import { ConnectButton } from "../ConnectButton";
import { TxHashText } from "../nfts/TxHashText";
import { DEMO_WALLET } from "@/lib/chatFixtures";
import {
  floorVaultAbi,
  formatTokenAmount,
  formatUsdgPrecise,
  parseTokenInput,
  payoutFor,
  platformTokenAbi,
  tokenInputOf,
} from "@/lib/floor";
import { sameHex, truncateAddress } from "@/lib/format";
import { rhTestnet } from "@/lib/wagmi";

// ---------------------------------------------------------------------------
// Controller contract shared by the live (wagmi) and fixtures (simulated)
// panels — the view never knows which one it is driving (NftCard pattern).
// ---------------------------------------------------------------------------

export type QuoteState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; value: bigint }
  | { kind: "error" };

export type RedeemPhase =
  | { kind: "idle" }
  | { kind: "approve-wallet" }
  | { kind: "approve-pending"; hash: string | null }
  | { kind: "redeem-wallet" }
  | { kind: "redeem-pending"; hash: string | null }
  | { kind: "done"; outcome: RedeemOutcome }
  /** `sent`: the redeem tx was broadcast before the failure — it may still land. */
  | { kind: "error"; message: string; sent: boolean; approved: boolean };

export interface RedeemOutcome {
  /** From the Redeemed log; null when the event was not found in the receipt. */
  paid: bigint | null;
  burned: bigint | null;
  hash: string | null;
}

interface RedeemController {
  simulated: boolean;
  wallet: string;
  symbol: string;
  /** null = loading; "error" = RPC read failed. */
  balance: bigint | null | "error";
  quote: QuoteState;
  /** Indexer says the vault holds 0 USDG (explains ZeroPayout). */
  vaultEmpty: boolean;
  redeem: (amount: bigint, onPhase: (p: RedeemPhase) => void) => Promise<RedeemOutcome>;
}

function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "shortMessage" in err && typeof err.shortMessage === "string") {
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface RedeemPanelProps {
  /** From /api/contracts ONLY (floorVault, platformToken); null when unavailable. */
  vault: `0x${string}` | null;
  token: `0x${string}` | null;
  /** Server-computed reason redeem is impossible (addresses missing, chain mismatch, …); null = OK. */
  blocked: string | null;
  symbol: string;
  /** Indexer snapshot (B, S) — fixtures simulate against it; live uses it only to explain ZeroPayout. */
  vaultUsdg: string | null;
  supply: string | null;
  fixtures: boolean;
  /** Fixtures: the demo wallet's balance/allowance. */
  demo: { balance: string; allowance: string } | null;
}

/** SPEC-M4G §4 redeem UI. */
export function RedeemPanel(props: RedeemPanelProps) {
  return props.fixtures ? <FixtureRedeem {...props} /> : <LiveRedeem {...props} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">Redeem at the floor</h2>
        <p className="mt-1 text-sm text-slate-500">
          Burn tokens through the vault and receive exactly their pro-rata share of its USDG, in one transaction.
        </p>
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Live: wagmi reads (balanceOf, quoteRedeem) + writes (approve?, redeem).
// ---------------------------------------------------------------------------

const QUOTE_REFRESH_MS = 12_000;

function LiveRedeem({ vault, token, blocked, symbol, vaultUsdg }: RedeemPanelProps) {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();

  if (blocked !== null || vault === null || token === null) {
    return (
      <Shell>
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          {blocked ?? "Contract addresses are unavailable (indexer unreachable) — redeem disabled."}
        </p>
      </Shell>
    );
  }
  if (!isConnected || !address) {
    return (
      <Shell>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-300">Connect the wallet that holds your {symbol} to redeem.</span>
          <ConnectButton />
        </div>
      </Shell>
    );
  }
  if (chainId !== rhTestnet.id) {
    return (
      <Shell>
        <p className="text-sm text-slate-300">Your wallet is on another network. Redeem runs on {rhTestnet.name}.</p>
        <button
          type="button"
          disabled={switching}
          onClick={() => switchChain({ chainId: rhTestnet.id })}
          className="self-start rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-300 disabled:opacity-50"
        >
          {switching ? "Switching…" : `Switch to ${rhTestnet.name}`}
        </button>
      </Shell>
    );
  }
  return <LiveConnected vault={vault} token={token} wallet={address} symbol={symbol} vaultEmpty={vaultUsdg === "0"} />;
}

function LiveConnected({
  vault,
  token,
  wallet,
  symbol,
  vaultEmpty,
}: {
  vault: `0x${string}`;
  token: `0x${string}`;
  wallet: `0x${string}`;
  symbol: string;
  vaultEmpty: boolean;
}) {
  const config = useConfig();
  const router = useRouter();
  const { writeContractAsync } = useWriteContract();
  const [amountText, setAmountText] = useState("");
  const amount = parseTokenInput(amountText);

  const balanceQ = useReadContract({
    address: token,
    abi: platformTokenAbi,
    functionName: "balanceOf",
    args: [wallet],
    chainId: rhTestnet.id,
    query: { refetchInterval: QUOTE_REFRESH_MS },
  });
  const quoteQ = useReadContract({
    address: vault,
    abi: floorVaultAbi,
    functionName: "quoteRedeem",
    args: [amount ?? 0n],
    chainId: rhTestnet.id,
    query: { enabled: amount !== null && amount > 0n, refetchInterval: QUOTE_REFRESH_MS },
  });

  const quote: QuoteState =
    amount === null || amount === 0n
      ? { kind: "idle" }
      : quoteQ.data !== undefined
        ? { kind: "ok", value: quoteQ.data }
        : quoteQ.isError
          ? { kind: "error" }
          : { kind: "loading" };

  const c: RedeemController = {
    simulated: false,
    wallet,
    symbol,
    balance: balanceQ.data !== undefined ? balanceQ.data : balanceQ.isError ? "error" : null,
    quote,
    vaultEmpty,
    async redeem(amt, onPhase) {
      let approved = false;
      // Approve ONLY when the allowance is short — read fresh, never trust a cached value.
      let allowance: bigint | null = null;
      try {
        allowance = await readContract(config, {
          address: token,
          abi: platformTokenAbi,
          functionName: "allowance",
          args: [wallet, vault],
          chainId: rhTestnet.id,
        });
      } catch {
        allowance = null; // unknown => approve the exact amount (never over-approve)
      }
      if (allowance === null || allowance < amt) {
        onPhase({ kind: "approve-wallet" });
        const approveHash = await writeContractAsync({
          address: token,
          abi: platformTokenAbi,
          functionName: "approve",
          args: [vault, amt],
          chainId: rhTestnet.id,
        });
        onPhase({ kind: "approve-pending", hash: approveHash });
        const r = await waitForTransactionReceipt(config, { hash: approveHash, chainId: rhTestnet.id });
        if (r.status !== "success") throw new Error("approve reverted");
        approved = true;
      }
      onPhase({ kind: "redeem-wallet" });
      let sent = false;
      try {
        const { request } = await simulateContract(config, {
          address: vault,
          abi: floorVaultAbi,
          functionName: "redeem",
          args: [amt],
          account: wallet,
          chainId: rhTestnet.id,
        });
        const hash = await writeContractAsync(request);
        sent = true;
        onPhase({ kind: "redeem-pending", hash });
        const receipt = await waitForTransactionReceipt(config, { hash, chainId: rhTestnet.id });
        if (receipt.status !== "success") throw new Error("redeem reverted");
        const ev = parseEventLogs({ abi: floorVaultAbi, logs: receipt.logs, eventName: "Redeemed" }).find(
          (l) => sameHex(l.address, vault) && sameHex(l.args.redeemer, wallet),
        );
        void balanceQ.refetch();
        void quoteQ.refetch();
        router.refresh();
        return { paid: ev ? ev.args.usdgPaid : null, burned: ev ? ev.args.tokensBurned : null, hash };
      } catch (err) {
        throw Object.assign(new Error(errMessage(err)), { sent, approved });
      }
    },
  };

  return (
    <Shell>
      <RedeemView c={c} amountText={amountText} onAmountText={setAmountText} amount={amount} />
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Fixtures: simulated wallet + vault (no RPC, nothing sent anywhere).
// ---------------------------------------------------------------------------

type DemoScenario = "holder" | "empty";

function bigOr0(v: string | null | undefined): bigint {
  return v && /^\d+$/.test(v) ? BigInt(v) : 0n;
}

function FixtureRedeem({ symbol, vaultUsdg, supply, demo }: RedeemPanelProps) {
  const [simulate, setSimulate] = useState(false);
  const [scenario, setScenario] = useState<DemoScenario>("holder");

  return (
    <Shell>
      <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-4 py-3">
        <p className="text-xs text-slate-400">
          Fixtures mode: the chain, vault and wallet are simulated — nothing is sent anywhere. Walk the redeem flow with
          the demo wallet.
        </p>
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Demo wallet">
          {(
            [
              { id: "holder", label: `Holds ${formatTokenAmount(demo?.balance ?? "0")} ${symbol}` },
              { id: "empty", label: "Holds nothing" },
            ] as { id: DemoScenario; label: string }[]
          ).map((s) => (
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
      {!simulate ? (
        <button
          type="button"
          onClick={() => setSimulate(true)}
          className="self-start rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-600 hover:text-slate-100"
        >
          Simulate with demo wallet
        </button>
      ) : (
        <FixtureSimulated
          key={scenario}
          symbol={symbol}
          initialBalance={scenario === "empty" ? 0n : bigOr0(demo?.balance)}
          initialAllowance={scenario === "empty" ? 0n : bigOr0(demo?.allowance)}
          initialB={bigOr0(vaultUsdg)}
          initialS={bigOr0(supply)}
          onStop={() => setSimulate(false)}
        />
      )}
    </Shell>
  );
}

function FixtureSimulated({
  symbol,
  initialBalance,
  initialAllowance,
  initialB,
  initialS,
  onStop,
}: {
  symbol: string;
  initialBalance: bigint;
  initialAllowance: bigint;
  initialB: bigint;
  initialS: bigint;
  onStop: () => void;
}) {
  const [amountText, setAmountText] = useState("");
  const [balance, setBalance] = useState(initialBalance);
  const [allowance, setAllowance] = useState(initialAllowance);
  const [vault, setVault] = useState({ B: initialB, S: initialS });
  const amount = parseTokenInput(amountText);

  const c: RedeemController = {
    simulated: true,
    wallet: DEMO_WALLET,
    symbol,
    balance,
    quote: amount === null || amount === 0n ? { kind: "idle" } : { kind: "ok", value: payoutFor(amount, vault.B, vault.S) },
    vaultEmpty: vault.B === 0n,
    async redeem(amt, onPhase) {
      let approved = false;
      if (allowance < amt) {
        onPhase({ kind: "approve-wallet" });
        await sleep(700);
        onPhase({ kind: "approve-pending", hash: null });
        await sleep(1000);
        setAllowance(amt);
        approved = true;
      }
      onPhase({ kind: "redeem-wallet" });
      await sleep(700);
      // Same order as the vault: read B, S before any state change (R3).
      const paid = payoutFor(amt, vault.B, vault.S);
      if (paid === 0n) throw Object.assign(new Error("ZeroPayout()"), { sent: false, approved });
      onPhase({ kind: "redeem-pending", hash: null });
      await sleep(1200);
      setVault({ B: vault.B - paid, S: vault.S - amt });
      setBalance((b) => b - amt);
      setAllowance((a) => a - amt);
      return { paid, burned: amt, hash: null };
    },
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-400">
          Wallet <span className="font-mono text-slate-200">{truncateAddress(DEMO_WALLET)}</span> (demo) · allowance to
          vault <span className="font-mono text-slate-300">{formatTokenAmount(allowance)}</span>
        </p>
        <button type="button" onClick={onStop} className="text-xs text-slate-400 hover:text-slate-200">
          Stop simulating
        </button>
      </div>
      <RedeemView c={c} amountText={amountText} onAmountText={setAmountText} amount={amount} />
    </>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function RedeemView({
  c,
  amountText,
  onAmountText,
  amount,
}: {
  c: RedeemController;
  amountText: string;
  onAmountText: (v: string) => void;
  amount: bigint | null;
}) {
  const [phase, setPhase] = useState<RedeemPhase>({ kind: "idle" });
  const busy =
    phase.kind === "approve-wallet" ||
    phase.kind === "approve-pending" ||
    phase.kind === "redeem-wallet" ||
    phase.kind === "redeem-pending";

  const balance = typeof c.balance === "bigint" ? c.balance : null;

  // Why redeem is disabled (null = enabled). Order: balance, input, bounds, quote.
  const reason: string | null =
    c.balance === null
      ? "Reading your balance…"
      : c.balance === "error"
        ? "Could not read your balance (RPC) — redeem disabled until it can be read."
        : c.balance === 0n
          ? `This wallet holds no ${c.symbol}.`
          : amountText.trim() === ""
            ? "Enter an amount."
            : amount === null
              ? "Not a valid amount (digits, one decimal point, at most 18 decimals)."
              : amount === 0n
                ? "Enter an amount above zero."
                : balance !== null && amount > balance
                  ? `That is more than your balance (${formatTokenAmount(balance)} ${c.symbol}).`
                  : c.quote.kind === "loading"
                    ? "Reading the live quote…"
                    : c.quote.kind === "error"
                      ? "Could not read the live quote (vault.quoteRedeem) — redeem disabled until it can be read."
                      : c.quote.kind === "ok" && c.quote.value === 0n
                        ? c.vaultEmpty
                          ? "The vault holds no USDG yet, so any redemption pays 0 and the vault rejects it (ZeroPayout). The floor starts rising with the first fee inflow or donation."
                          : "At the current floor this amount pays less than 0.000001 USDG (one USDG base unit), so the vault rejects it (ZeroPayout). Redeem a larger amount."
                        : null;

  async function send() {
    if (amount === null || reason !== null) return;
    setPhase({ kind: "idle" });
    try {
      const outcome = await c.redeem(amount, setPhase);
      setPhase({ kind: "done", outcome });
      onAmountText("");
    } catch (err) {
      const e = err as { sent?: unknown; approved?: unknown };
      setPhase({ kind: "error", message: errMessage(err), sent: e?.sent === true, approved: e?.approved === true });
    }
  }

  const quoteText =
    c.quote.kind === "ok"
      ? `${formatUsdgPrecise(c.quote.value)} USDG`
      : c.quote.kind === "loading"
        ? "reading…"
        : c.quote.kind === "error"
          ? "unavailable"
          : "—";

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <dt className="text-[11px] uppercase tracking-wide text-slate-500">Your {c.symbol} balance</dt>
          <dd className="mt-1 font-mono text-sm text-slate-100">
            {c.balance === null ? "reading…" : c.balance === "error" ? "unavailable" : formatTokenAmount(c.balance)}
          </dd>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3" title="Live vault.quoteRedeem(amount) view read">
          <dt className="text-[11px] uppercase tracking-wide text-slate-500">You receive (live quote)</dt>
          <dd className="mt-1 font-mono text-sm text-slate-100">{quoteText}</dd>
        </div>
      </dl>

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className="text-xs uppercase tracking-wide text-slate-500" htmlFor="redeem-amount">
          Amount to burn ({c.symbol})
        </label>
        <div className="flex gap-2">
          <input
            id="redeem-amount"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder="0.0"
            value={amountText}
            disabled={busy || balance === 0n}
            onChange={(e) => {
              onAmountText(e.target.value);
              if (phase.kind === "done" || phase.kind === "error") setPhase({ kind: "idle" });
            }}
            className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-accent/60 disabled:opacity-50"
          />
          <button
            type="button"
            disabled={busy || balance === null || balance === 0n}
            onClick={() => balance !== null && onAmountText(tokenInputOf(balance))}
            className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-slate-600 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Max
          </button>
        </div>
        <p className="text-xs text-slate-500">
          Your payout can only grow before inclusion: fee inflows and donations only add USDG, and burns only shrink the
          supply — so the quote above is the least this redemption pays when it lands. That is why redeem has no
          slippage or minimum-out setting.
        </p>

        <button
          type="submit"
          disabled={reason !== null || busy}
          className="mt-1 self-start rounded-md border border-accent/40 bg-accent/15 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {phase.kind === "approve-wallet"
            ? c.simulated
              ? "Simulated wallet: approving…"
              : `Approve ${c.symbol} in your wallet…`
            : phase.kind === "approve-pending"
              ? "Waiting for approve…"
              : phase.kind === "redeem-wallet"
                ? c.simulated
                  ? "Simulated wallet: signing redeem…"
                  : "Confirm redeem in your wallet…"
                : phase.kind === "redeem-pending"
                  ? "Waiting for receipt…"
                  : c.simulated
                    ? "Simulate redeem"
                    : "Redeem"}
        </button>
        {reason !== null && !busy ? <p className="text-xs text-amber-400">{reason}</p> : null}
        <p className="text-xs text-slate-500">
          If the vault&apos;s allowance is short you approve exactly this amount first (two transactions); otherwise it is
          one.
        </p>
      </form>

      {phase.kind === "done" ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-100">
          {phase.outcome.paid === null ? (
            <p>
              Redeem confirmed, but the Redeemed event was not found in the receipt — check your wallet&apos;s USDG
              balance.
            </p>
          ) : (
            <p>
              Burned{" "}
              <span className="font-mono">
                {formatTokenAmount(phase.outcome.burned)} {c.symbol}
              </span>{" "}
              and received <span className="font-mono">{formatUsdgPrecise(phase.outcome.paid)} USDG</span>.
            </p>
          )}
          <p className="mt-1 text-xs text-emerald-200/80">
            <TxHashText hash={phase.outcome.hash} simulated={c.simulated} />{" "}
            {c.simulated
              ? "The page's vault stats are fixtures and do not change; the quote above uses the simulated vault."
              : "Vault stats update when the indexer catches up."}
          </p>
        </div>
      ) : phase.kind === "error" ? (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
          {phase.sent
            ? `${phase.message} — the redeem was sent but not confirmed; it may still land. Check your wallet before retrying.`
            : phase.approved
              ? `${phase.message} — nothing was burned. (Any approval you confirmed stays in place; the next try skips it.)`
              : `${phase.message} — nothing was burned.`}
        </p>
      ) : null}
    </div>
  );
}
