"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  keccak256,
  parseEventLogs,
  stringToBytes,
  type EIP1193Provider,
} from "viem";
import { useAccount } from "wagmi";

import { ConnectButton } from "../ConnectButton";
import { CopyButton } from "../CopyButton";
import { formatUsdg, sameHex, truncateAddress } from "@/lib/format";
import {
  USDC_DECIMALS,
  formatDuration,
  payReadiness,
  refusalText,
  reviveIntentMessage,
  reviveTrackUrl,
  usdcAbi,
  type PayTarget,
} from "@/lib/revive";
import type { ReviveQuote, ReviveQuoteResult } from "@/lib/types";

// ---------------------------------------------------------------------------
// Cross-chain safety (SPEC-M4F §2 — the web app's first non-RH-chain tx).
//
// The wagmi config knows ONLY the RH testnet, and the payment chain must come
// from the quote (never hardcoded). So the payment bypasses wagmi's chain
// registry and talks to the connected wallet's EIP-1193 provider directly:
//   1. the wallet's live chain id is read from the provider (eth_chainId +
//      `chainChanged`), and the Pay button only exists when it EQUALS the
//      quote's chainId — otherwise a switch prompt (wallet_switchEthereumChain);
//   2. immediately before the token preflight reads AND again immediately
//      before the transfer, eth_chainId is re-read and the flow aborts on any
//      mismatch (nothing is signed);
//   3. the transfer is sent through a viem wallet client whose `chain` is built
//      from the quote's chainId, so viem's own assertCurrentChain refuses to
//      send if the wallet is anywhere else;
//   4. token preflight on that chain: decimals() must be 6 (the quote is in
//      micro-USDC) and balanceOf(payer) ≥ total;
//   5. the receipt is read only while the wallet is on the quote's chain, and
//      must carry a Transfer(payer → payTo, ≥ total) from the quote's token.
// ---------------------------------------------------------------------------

type Phase =
  | { kind: "idle"; notice?: string }
  | { kind: "requoting" }
  | { kind: "preflight" }
  | { kind: "switching" }
  | { kind: "signing" }
  | { kind: "confirming"; hash: string; note?: string }
  | { kind: "submitting"; hash: string }
  | { kind: "submitError"; hash: string; message: string; retryable: boolean; refund: boolean }
  | { kind: "error"; message: string };

interface Pending {
  tx: string;
  payer: string;
  chainId: number;
}

const RECEIPT_POLL_MS = 3000;
const RECEIPT_TIMEOUT_MS = 10 * 60 * 1000;

function pendingKey(agentId: number): string {
  return `revive-pending-${agentId}`;
}

function readPending(agentId: number): Pending | null {
  try {
    const raw = window.localStorage.getItem(pendingKey(agentId));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Pending>;
    if (
      typeof p.tx === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(p.tx) &&
      typeof p.payer === "string" &&
      /^0x[0-9a-fA-F]{40}$/.test(p.payer) &&
      typeof p.chainId === "number"
    ) {
      return { tx: p.tx, payer: p.payer, chainId: p.chainId };
    }
    return null;
  } catch {
    return null;
  }
}

function writePending(agentId: number, p: Pending | null): void {
  try {
    if (p === null) window.localStorage.removeItem(pendingKey(agentId));
    else window.localStorage.setItem(pendingKey(agentId), JSON.stringify(p));
  } catch {
    // per-viewer convenience only
  }
}

function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "shortMessage" in err && typeof err.shortMessage === "string") {
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

function errCode(err: unknown): number | null {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "number") return err.code;
  // viem wraps provider errors; the original is on `cause`.
  if (err && typeof err === "object" && "cause" in err) return errCode((err as { cause: unknown }).cause);
  return null;
}

function parseChainId(v: unknown): number | null {
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) {
    const n = Number.parseInt(v, 16);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  return null;
}

async function readWalletChain(p: EIP1193Provider): Promise<number | null> {
  try {
    return parseChainId(await p.request({ method: "eth_chainId" }));
  } catch {
    return null;
  }
}

/** A viem chain object built from the QUOTE's chain id — never a hardcoded chain. */
function quoteChain(id: number) {
  return defineChain({
    id,
    name: `Chain ${id}`,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });
}

function sameTarget(a: PayTarget, b: PayTarget): boolean {
  return a.total === b.total && sameHex(a.payTo, b.payTo) && sameHex(a.token, b.token) && a.chainId === b.chainId;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Revival payment (SPEC-M4F §2, R1/R2): quote → USDC transfer on the quote's
 * chain to the quote's payTo → POST /api/revive (proxied) with the tx hash →
 * tracker. Rendered ONLY for a quote with `revivable: true`; if a fresh
 * re-quote says otherwise, the pay flow disappears in favour of the reason.
 */
export function RevivePanel({
  agentId,
  agentName,
  currentGeneration,
  initialQuote,
  fixtures,
  simulatedPayer,
  fixtureSubmitConflict = false,
}: {
  agentId: number;
  agentName: string;
  currentGeneration: number | null;
  initialQuote: ReviveQuote;
  fixtures: boolean;
  /** Fixtures only: the payer the simulated flow submits. */
  simulatedPayer: string | null;
  /** Fixtures only (`/mausoleum?submit=conflict`): the POST answers 409, to walk the refund copy. */
  fixtureSubmitConflict?: boolean;
}) {
  const router = useRouter();
  const { address, isConnected, connector } = useAccount();
  const [quote, setQuote] = useState<ReviveQuote>(initialQuote);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [walletChain, setWalletChain] = useState<number | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [tokenSymbol, setTokenSymbol] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const readiness = payReadiness(quote);
  const target = readiness.ok ? readiness.target : null;

  // Live wallet chain, straight from the provider (the wagmi config does not know the payment chain).
  const getProvider = useCallback(async (): Promise<EIP1193Provider | null> => {
    if (!connector) return null;
    try {
      const p = (await connector.getProvider()) as EIP1193Provider | undefined;
      return p && typeof p.request === "function" ? p : null;
    } catch {
      return null;
    }
  }, [connector]);

  useEffect(() => {
    if (fixtures || !isConnected) {
      setWalletChain(null);
      return;
    }
    let off: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const p = await getProvider();
      if (!p || cancelled) return;
      setWalletChain(await readWalletChain(p));
      const onChange = (v: unknown) => setWalletChain(parseChainId(v));
      p.on?.("chainChanged", onChange as never);
      off = () => p.removeListener?.("chainChanged", onChange as never);
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, [fixtures, isConnected, getProvider]);

  useEffect(() => {
    if (!fixtures) setPending(readPending(agentId));
  }, [fixtures, agentId]);

  const busy =
    phase.kind === "requoting" ||
    phase.kind === "preflight" ||
    phase.kind === "switching" ||
    phase.kind === "signing" ||
    phase.kind === "confirming" ||
    phase.kind === "submitting";

  /** R2: re-read the quote right before paying. Returns the target to pay, or null (phase already set). */
  async function requote(current: PayTarget): Promise<PayTarget | null> {
    setPhase({ kind: "requoting" });
    let result: ReviveQuoteResult | null = null;
    try {
      const res = await fetch(`/api/revive/quote/${agentId}`, { cache: "no-store" });
      result = (await res.json().catch(() => null)) as ReviveQuoteResult | null;
    } catch {
      result = null;
    }
    if (!result || typeof result !== "object" || !("kind" in result)) {
      setPhase({ kind: "error", message: "Could not re-confirm the quote right now. Nothing was paid — try again." });
      return null;
    }
    if (result.kind === "manual") {
      setPhase({ kind: "error", message: "The revival service switched to manual mode. Nothing was paid." });
      return null;
    }
    if (result.kind === "unavailable") {
      setPhase({ kind: "error", message: `Could not re-confirm the quote (${result.message}). Nothing was paid.` });
      return null;
    }
    setQuote(result.quote);
    const fresh = payReadiness(result.quote);
    if (!fresh.ok) {
      setPhase({ kind: "idle" }); // the card now renders the refusal / disabled reason instead of a pay button
      return null;
    }
    if (!sameTarget(fresh.target, current)) {
      setPhase({
        kind: "idle",
        notice: `The quote changed since this page loaded (now ${formatUsdg(fresh.target.totalRaw)} USDC). Review it and press Pay again. Nothing was paid.`,
      });
      return null;
    }
    return fresh.target;
  }

  async function submit(hash: string, payer: string) {
    // M4F rev 1: the payer signs the revive intent (binds this payment tx to THIS agent).
    // Fixtures use a placeholder; live signing needs the paying wallet connected.
    setPhase({ kind: "submitting", hash });
    let signature: string;
    if (fixtures) {
      signature = "0x" + "11".repeat(65);
    } else {
      if (!address || address.toLowerCase() !== payer.toLowerCase()) {
        setPhase({ kind: "error", message: `Connect the wallet that paid (${truncateAddress(payer)}) to sign the revival request. The payment is safe — resubmit any time.` });
        return;
      }
      const prov = await getProvider();
      if (!prov) {
        setPhase({ kind: "error", message: "Wallet provider unavailable — reconnect and resubmit. The payment is safe." });
        return;
      }
      try {
        const wc = createWalletClient({ account: address, transport: custom(prov) });
        signature = await wc.signMessage({ message: reviveIntentMessage(agentId, hash) });
      } catch (err) {
        setPhase({ kind: "error", message: `The intent signature was refused (${errMessage(err)}). The payment is safe — resubmit any time.` });
        return;
      }
    }
    try {
      const res = await fetch("/api/revive", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(fixtures && fixtureSubmitConflict ? { "x-fixture-submit": "conflict" } : {}),
        },
        body: JSON.stringify({ agentId, payer, paymentTx: hash, signature }),
      });
      const body = (await res.json().catch(() => null)) as {
        revivalId?: unknown;
        error?: unknown;
        reason?: unknown;
        detail?: unknown;
      } | null;
      if (!alive.current) return;
      const detail = [body?.error, body?.reason, body?.detail]
        .filter((x): x is string => typeof x === "string" && x !== "")
        .join(" — ");
      if (res.ok) {
        const rid = body?.revivalId;
        const revivalId =
          typeof rid === "string" && rid !== "" ? rid : typeof rid === "number" && Number.isSafeInteger(rid) ? String(rid) : null;
        if (!fixtures) writePending(agentId, null);
        router.push(
          reviveTrackUrl({
            agentId,
            since: Math.floor(Date.now() / 1000),
            tx: fixtures ? null : hash,
            revivalId,
            gen: currentGeneration,
          }),
        );
        return;
      }
      if (res.status === 402) {
        setPhase({
          kind: "submitError",
          hash,
          retryable: true,
          refund: false,
          message: `The payment was not accepted yet${detail ? ` (${detail})` : ""}. If the transaction is still confirming, wait a minute and submit again — the same hash is safe to resubmit.`,
        });
      } else if (res.status === 409) {
        // Final: resubmitting the same hash cannot succeed — drop the "unsubmitted payment" reminder.
        if (!fixtures) writePending(agentId, null);
        setPending(null);
        const r = typeof body?.reason === "string" ? refusalText(body.reason).title : "refused";
        setPhase({
          kind: "submitError",
          hash,
          retryable: false,
          refund: true,
          // The helper's own `refund` note says the same as the refund paragraph rendered below.
          message: `The orchestrator refused the revival after your payment (${r}${detail ? ` — ${detail}` : ""}).`,
        });
      } else if (res.status === 503) {
        setPhase({
          kind: "submitError",
          hash,
          retryable: true,
          refund: true,
          message: "The revival service is in manual mode and cannot queue revivals right now.",
        });
      } else {
        setPhase({
          kind: "submitError",
          hash,
          retryable: true,
          refund: false,
          message: `Could not submit the payment (${res.status})${detail ? `: ${detail}` : ""}. Your payment is recorded on-chain; submit the same hash again.`,
        });
      }
    } catch (err) {
      if (!alive.current) return;
      setPhase({
        kind: "submitError",
        hash,
        retryable: true,
        refund: false,
        message: `Could not reach the site's revive endpoint (${errMessage(err)}). Your payment is on-chain; submit the same hash again.`,
      });
    }
  }

  async function switchChain() {
    if (!target) return;
    const p = await getProvider();
    if (!p) {
      setPhase({ kind: "error", message: "No wallet provider available." });
      return;
    }
    setPhase({ kind: "switching" });
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${target.chainId.toString(16)}` }] });
      setWalletChain(await readWalletChain(p));
      setPhase({ kind: "idle" });
    } catch (err) {
      const code = errCode(err);
      setPhase({
        kind: "error",
        message:
          code === 4902
            ? `Your wallet does not know chain ${target.chainId}. Add it in your wallet (this site ships no RPC endpoints for it), then switch.`
            : code === 4001
              ? "Chain switch rejected in the wallet. Nothing was paid."
              : `Could not switch chains: ${errMessage(err)}`,
      });
    }
  }

  async function pay() {
    if (!target || !address) return;
    const t = await requote(target);
    if (!t) return;

    const p = await getProvider();
    if (!p) {
      setPhase({ kind: "error", message: "No wallet provider available. Nothing was paid." });
      return;
    }
    const chain = quoteChain(t.chainId);
    const assertChain = async (): Promise<boolean> => {
      const now = await readWalletChain(p);
      setWalletChain(now);
      if (now !== t.chainId) {
        setPhase({
          kind: "error",
          message: `Your wallet is on chain ${now ?? "unknown"}, not the quote's chain ${t.chainId}. Nothing was sent — switch and try again.`,
        });
        return false;
      }
      return true;
    };

    // Guard 2a: before any read on "the payment chain".
    if (!(await assertChain())) return;
    const publicClient = createPublicClient({ chain, transport: custom(p) });
    setPhase({ kind: "preflight" });
    try {
      const [decimals, symbol, balance] = await Promise.all([
        publicClient.readContract({ address: t.token, abi: usdcAbi, functionName: "decimals" }),
        publicClient.readContract({ address: t.token, abi: usdcAbi, functionName: "symbol" }).catch(() => null),
        publicClient.readContract({ address: t.token, abi: usdcAbi, functionName: "balanceOf", args: [address] }),
      ]);
      setTokenSymbol(typeof symbol === "string" ? symbol : null);
      if (decimals !== USDC_DECIMALS) {
        setPhase({
          kind: "error",
          message: `The quote's token reports ${decimals} decimals on chain ${t.chainId}; the quote is priced in ${USDC_DECIMALS}-decimal USDC units. Refusing to pay.`,
        });
        return;
      }
      if (balance < t.total) {
        setPhase({
          kind: "error",
          message: `Insufficient balance: this wallet holds ${formatUsdg(balance.toString())} ${typeof symbol === "string" ? symbol : "USDC"} on chain ${t.chainId}; the revival costs ${formatUsdg(t.totalRaw)}. Nothing was paid.`,
        });
        return;
      }
    } catch (err) {
      setPhase({ kind: "error", message: `Could not read the payment token on chain ${t.chainId} (${errMessage(err)}). Nothing was paid.` });
      return;
    }

    // Guard 2b: re-check right before signing (the user may have switched during preflight).
    if (!(await assertChain())) return;
    setPhase({ kind: "signing" });
    let hash: `0x${string}`;
    try {
      const walletClient = createWalletClient({ account: address, chain, transport: custom(p) });
      // Guard 3: viem asserts the wallet's current chain === chain.id before sending.
      hash = await walletClient.writeContract({
        address: t.token,
        abi: usdcAbi,
        functionName: "transfer",
        args: [t.payTo, t.total],
      });
    } catch (err) {
      const code = errCode(err);
      setPhase({
        kind: "error",
        message: code === 4001 ? "Transfer rejected in the wallet. Nothing was paid." : `Transfer not sent: ${errMessage(err)}`,
      });
      return;
    }
    const pend: Pending = { tx: hash, payer: address, chainId: t.chainId };
    writePending(agentId, pend);
    setPending(pend);
    setPhase({ kind: "confirming", hash });

    // Guard 5: read the receipt only while on the quote's chain; verify the Transfer.
    const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
    while (alive.current && Date.now() < deadline) {
      const now = await readWalletChain(p);
      if (now !== t.chainId) {
        setPhase({
          kind: "confirming",
          hash,
          note: `Your wallet switched to chain ${now ?? "unknown"} — switch back to chain ${t.chainId} to see the confirmation. The payment itself is unaffected.`,
        });
        await sleep(RECEIPT_POLL_MS);
        continue;
      }
      let receipt: Awaited<ReturnType<typeof publicClient.getTransactionReceipt>> | null = null;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash });
      } catch {
        receipt = null; // not mined yet
      }
      if (receipt) {
        if (receipt.status !== "success") {
          writePending(agentId, null);
          setPending(null);
          setPhase({ kind: "error", message: `The transfer reverted (tx ${hash}). No USDC moved; nothing to submit.` });
          return;
        }
        const paid = parseEventLogs({ abi: usdcAbi, logs: receipt.logs, eventName: "Transfer" }).some(
          (l) => sameHex(l.address, t.token) && sameHex(l.args.to, t.payTo) && sameHex(l.args.from, address) && l.args.value >= t.total,
        );
        if (!paid) {
          writePending(agentId, null);
          setPending(null);
          setPhase({
            kind: "submitError",
            hash,
            retryable: false,
            refund: false,
            message: "The receipt shows no USDC transfer of the quoted amount to the quoted recipient — not submitting. Check the transaction in an explorer.",
          });
          return;
        }
        await submit(hash, address);
        return;
      }
      setPhase({ kind: "confirming", hash });
      await sleep(RECEIPT_POLL_MS);
    }
    if (alive.current) {
      setPhase({
        kind: "submitError",
        hash,
        retryable: true,
        refund: false,
        message: "No confirmation seen yet. When the transaction is mined, submit it — the same hash is safe to resubmit.",
      });
    }
  }

  async function simulate() {
    if (!target) return;
    const t = await requote(target);
    if (!t) return;
    setPhase({ kind: "switching" });
    await sleep(700);
    setPhase({ kind: "preflight" });
    await sleep(600);
    setPhase({ kind: "signing" });
    await sleep(900);
    const hash = keccak256(stringToBytes(`fixture-revive-${agentId}-${Date.now()}`));
    setPhase({ kind: "confirming", hash });
    await sleep(1200);
    await submit(hash, simulatedPayer ?? "0x0000000000000000000000000000000000000000");
  }

  // ------------------------------------------------------------------ render

  if (!quote.revivable) {
    // Re-quote flipped it (R2): the card's parent renders refusals for SSR quotes; this covers the live flip.
    const r = refusalText(quote.reason);
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-sm">
        <p className="font-medium text-slate-300">{r.title}</p>
        <p className="mt-1 text-xs text-slate-500">{r.body}</p>
      </div>
    );
  }

  const q = quote.quote;
  const chainOk = !fixtures && target !== null && walletChain === target.chainId;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-accent/20 bg-accent/5 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-slate-500">Revival cost</span>
        <span className="text-lg font-semibold text-slate-100">
          {q?.totalUsdcMicro !== null && q?.totalUsdcMicro !== undefined ? `${formatUsdg(q.totalUsdcMicro)} USDC` : "—"}
        </span>
      </div>
      {q ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-slate-500">Hosting</dt>
          <dd className="text-right text-slate-300">
            {q.durationMin !== null ? formatDuration(q.durationMin * 60) : "—"}
            {q.rateUsdcMicroPerHour !== null ? ` × ${formatUsdg(q.rateUsdcMicroPerHour)}/h` : ""}
            {q.hostingUsdcMicro !== null ? ` = ${formatUsdg(q.hostingUsdcMicro)}` : ""}
          </dd>
          <dt className="text-slate-500">Gas seed</dt>
          <dd className="text-right text-slate-300">{q.gasSeedUsdMicro !== null ? formatUsdg(q.gasSeedUsdMicro) : "—"}</dd>
          <dt className="text-slate-500">Pay to</dt>
          <dd className="flex items-center justify-end gap-1 font-mono text-slate-300">
            {q.payTo ? (
              <>
                {truncateAddress(q.payTo, 6)}
                <CopyButton value={q.payTo} label="recipient" />
              </>
            ) : (
              "—"
            )}
          </dd>
          <dt className="text-slate-500">Token</dt>
          <dd className="flex items-center justify-end gap-1 font-mono text-slate-300">
            {q.usdc ? (
              <>
                {tokenSymbol ? `${tokenSymbol} ` : ""}
                {truncateAddress(q.usdc, 6)}
                <CopyButton value={q.usdc} label="token address" />
              </>
            ) : (
              "—"
            )}
          </dd>
          <dt className="text-slate-500">Chain</dt>
          <dd className="text-right font-mono text-slate-300">{q.chainId !== null ? q.chainId : "—"}</dd>
        </dl>
      ) : null}
      <p className="text-[11px] leading-relaxed text-slate-500">
        Paid in USDC to the orchestrator&apos;s funding wallet — the wallet that pays hosting rentals. The launch helper
        verifies the transfer on-chain before queueing. If {agentName} wakes on its own between your payment and the
        queue, the operator returns the fee (by hand, on testnet).
      </p>

      {!readiness.ok ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">{readiness.why}</p>
      ) : pending && phase.kind === "idle" ? (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
          <span>
            This browser sent a payment that has not been accepted yet:{" "}
            <span className="font-mono">{truncateAddress(pending.tx, 8)}</span>{" "}
            <CopyButton value={pending.tx} label="transaction hash" />. Submit it instead of paying again.
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              onClick={() => void submit(pending.tx, pending.payer)}
              className="rounded-md border border-amber-500/40 px-2.5 py-1 text-amber-100 hover:bg-amber-500/20"
            >
              Submit that payment
            </button>
            <button
              type="button"
              onClick={() => {
                writePending(agentId, null);
                setPending(null);
              }}
              className="text-amber-300/70 hover:text-amber-100"
            >
              Dismiss
            </button>
          </span>
        </div>
      ) : fixtures ? (
        <button
          type="button"
          onClick={() => void simulate()}
          disabled={busy}
          className="self-start rounded-md border border-accent/40 bg-accent/15 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? phaseLabel(phase, target) : "Simulate payment →"}
        </button>
      ) : !isConnected || !address ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-300">Connect a wallet to revive.</span>
          <ConnectButton />
        </div>
      ) : !chainOk && !busy ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => void switchChain()}
            className="self-start rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-300"
          >
            Switch wallet to chain {target?.chainId}
          </button>
          <span className="text-[11px] text-slate-500">
            The revival is paid on chain {target?.chainId} (from the quote), not on the agents&apos; chain. Your wallet is on
            chain {walletChain ?? "unknown"}.
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void pay()}
          disabled={busy}
          className="self-start rounded-md border border-accent/40 bg-accent/15 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? phaseLabel(phase, target) : `Pay ${target ? formatUsdg(target.totalRaw) : ""} USDC & revive`}
        </button>
      )}

      {fixtures ? (
        <p className="text-[11px] text-slate-500">
          Fixtures mode — no wallet, no chain. The real flow checks the token on the quote&apos;s chain, asks your
          wallet to switch there, sends one USDC transfer, waits for the receipt and submits its hash.
        </p>
      ) : null}

      {phase.kind === "idle" && phase.notice ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">{phase.notice}</p>
      ) : null}
      {phase.kind === "confirming" ? (
        <p className="text-xs text-slate-400">
          Payment tx <span className="font-mono">{truncateAddress(phase.hash, 8)}</span>{" "}
          <CopyButton value={phase.hash} label="transaction hash" />
          {phase.note ? <span className="mt-1 block text-amber-300">{phase.note}</span> : null}
        </p>
      ) : null}
      {phase.kind === "error" ? (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">{phase.message}</p>
      ) : null}
      {phase.kind === "submitError" ? (
        <div className="flex flex-col gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-200">
          <span>{phase.message}</span>
          {phase.refund ? (
            <span>
              Your USDC went to the operator&apos;s funding wallet and will be returned by the operator (manual on
              testnet). Keep this payment transaction hash as your receipt.
            </span>
          ) : null}
          <span className="flex items-center gap-1">
            Payment tx <span className="font-mono">{truncateAddress(phase.hash, 8)}</span>
            <CopyButton value={phase.hash} label="transaction hash" />
          </span>
          {phase.retryable ? (
            <button
              type="button"
              onClick={() => void submit(phase.hash, fixtures ? (simulatedPayer ?? "") : (pending?.payer ?? address ?? ""))}
              className="self-start rounded-md border border-red-400/40 px-2.5 py-1 text-red-100 hover:bg-red-500/20"
            >
              Submit the same payment again
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function phaseLabel(phase: Phase, target: PayTarget | null): string {
  switch (phase.kind) {
    case "requoting":
      return "Re-checking the quote…";
    case "switching":
      return `Switching to chain ${target?.chainId ?? ""}…`;
    case "preflight":
      return "Checking the token…";
    case "signing":
      return "Confirm the USDC transfer in your wallet…";
    case "confirming":
      return "Waiting for the receipt…";
    case "submitting":
      return "Verifying payment…";
    default:
      return "Working…";
  }
}
