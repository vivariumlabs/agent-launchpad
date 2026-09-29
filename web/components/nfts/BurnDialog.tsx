"use client";

import { useEffect, useRef, useState } from "react";

import { formatUsdg } from "@/lib/format";
import { burnArmPhrase, displayName } from "@/lib/nfts";
import type { WalletNft } from "@/lib/types";

export type BurnPhase =
  | { kind: "explain" }
  | { kind: "arm" }
  | { kind: "wallet" }
  | { kind: "pending"; hash: string | null }
  /** `sent`: the tx was broadcast before the failure — it may still land, so never claim "nothing was burned". */
  | { kind: "error"; message: string; sent: boolean };

/**
 * R6 burn confirm (05 §1): (1) explain the consequences, (2) type the agent's
 * symbol to arm, (3) send. Once the tx is sent the dialog cannot be dismissed
 * until the receipt lands (or fails). The card owns the tx; this is the UI.
 */
export function BurnDialog({
  nft,
  accrued,
  phase,
  onPhase,
  onSend,
  onClose,
  simulated,
}: {
  nft: WalletNft;
  /** Live accrued (USDG base units) at dialog time; null when unknown. */
  accrued: bigint | null;
  phase: BurnPhase;
  onPhase: (p: BurnPhase) => void;
  onSend: () => void;
  onClose: () => void;
  simulated: boolean;
}) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const phrase = burnArmPhrase(nft);
  const armed = typed.trim() === phrase;
  const sending = phase.kind === "wallet" || phase.kind === "pending";
  const name = displayName(nft);

  useEffect(() => {
    if (phase.kind === "arm") inputRef.current?.focus();
  }, [phase.kind]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !sending) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sending, onClose]);

  const accruedLine =
    accrued === null
      ? "Any unclaimed royalties (could not read the current amount) sweep to the agent's treasury NOW — not to you."
      : accrued === 0n
        ? "There are no unclaimed royalties right now, so nothing is swept."
        : `${formatUsdg(accrued.toString())} USDG of unclaimed royalties sweep to the agent's treasury NOW — not to you. Claim first if you want them.`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`burn-title-${nft.agentId}`}
    >
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-red-500/30 bg-slate-900 p-5 shadow-2xl">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id={`burn-title-${nft.agentId}`} className="text-lg font-semibold text-slate-50">
            Burn {name}&apos;s NFT
          </h2>
          <span className="text-xs text-slate-500">
            step {phase.kind === "explain" ? 1 : phase.kind === "arm" || phase.kind === "error" ? 2 : 3} of 3
          </span>
        </div>

        {phase.kind === "explain" ? (
          <>
            <p className="text-sm text-slate-300">
              Burning emancipates the agent. This is permanent — read it before you continue:
            </p>
            <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-slate-300">
              <li>
                The NFT royalty leg redirects to the agent&apos;s own treasury <strong>forever</strong>. You
                stop earning royalties from this agent.
              </li>
              <li>{accruedLine}</li>
              <li>
                The NFT can <strong>never be re-minted</strong> — not by you, not by anyone. Token #
                {nft.agentId} is gone for good.
              </li>
            </ul>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onPhase({ kind: "arm" })}
                className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/20"
              >
                I understand — continue
              </button>
            </div>
          </>
        ) : phase.kind === "arm" || phase.kind === "error" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (armed) onSend();
            }}
          >
            <label className="flex flex-col gap-1.5 text-sm text-slate-300">
              <span>
                Type <span className="font-mono font-semibold text-slate-50">{phrase}</span> to arm the burn:
              </span>
              <input
                ref={inputRef}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-red-500/60"
                aria-label={`Type ${phrase} to confirm`}
              />
            </label>
            {phase.kind === "error" ? (
              <p className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
                {phase.sent
                  ? `${phase.message} — the burn was sent but not confirmed; it may still land. Check your wallet before retrying.`
                  : `${phase.message} — nothing was burned.`}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!armed}
                className="rounded-md border border-red-500/60 bg-red-500/20 px-3 py-1.5 text-sm font-medium text-red-200 hover:bg-red-500/30 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {simulated ? `Simulate burn of #${nft.agentId}` : `Burn NFT #${nft.agentId}`}
              </button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-slate-300">
            {phase.kind === "wallet"
              ? simulated
                ? "Simulated wallet: signing…"
                : "Confirm the burn in your wallet…"
              : "Burn sent — waiting for the receipt. Don't close this page."}
          </p>
        )}
      </div>
    </div>
  );
}
