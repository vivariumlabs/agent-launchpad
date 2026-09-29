"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseEventLogs } from "viem";
import { useAccount, useConfig, useSwitchChain, useWriteContract } from "wagmi";
import { readContract, waitForTransactionReceipt } from "wagmi/actions";

import { ConnectButton } from "../ConnectButton";
import { CopyButton } from "../CopyButton";
import { ARWEAVE_GATEWAY } from "@/lib/config";
import { erc20Abi, factoryAbi, isAddress, isBytes32, parseUint } from "@/lib/factory";
import { formatUsdg } from "@/lib/format";
import { exactAgentJsonText, type PublishState } from "@/lib/launch";
import { rhTestnet } from "@/lib/wagmi";
import type { LaunchAgentInput, LaunchPrepared } from "@/lib/types";

type TxStep =
  | { kind: "idle" }
  | { kind: "allowance" }
  | { kind: "approving"; hash?: `0x${string}` }
  | { kind: "creating"; hash?: `0x${string}` }
  | { kind: "error"; message: string };

function Field({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-800 px-4 py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <span className={`break-all text-sm text-slate-200 ${mono ? "font-mono" : ""}`}>{value}</span>
        {mono ? <CopyButton value={value} label={label} /> : null}
      </span>
    </div>
  );
}

function trackUrl(agentId: string, since: number, predicted: number, tx?: string, ar?: string): string {
  const q = new URLSearchParams({ since: String(since), predicted: String(predicted) });
  if (tx) q.set("tx", tx);
  if (ar) q.set("ar", ar);
  return `/launch/track/${agentId}?${q.toString()}`;
}

function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "shortMessage" in err && typeof err.shortMessage === "string") {
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Review screen + wallet txs (SPEC-M4B §3b): USDG approve(factory, fee) if
 * the allowance is short, then createAgent(name, symbol, "", configHash,
 * connectedAddress, expectedTreasuryEOA), then hand off to the tracker with
 * the REAL agentId from the receipt's AgentRequested (race honesty).
 */
export function LaunchReview({
  input,
  prepared,
  fixtures,
  publish,
  onRetryPublish,
  onBack,
}: {
  input: LaunchAgentInput;
  prepared: LaunchPrepared;
  fixtures: boolean;
  /** SPEC-M4E R3: the config must be on Arweave before the createAgent tx. */
  publish: PublishState;
  onRetryPublish: () => void;
  onBack: () => void;
}) {
  const router = useRouter();
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [step, setStep] = useState<TxStep>({ kind: "idle" });

  // Show the exact bytes that were hashed + published when the helper returned them.
  const agentJsonText =
    exactAgentJsonText(prepared) ?? JSON.stringify(prepared.agentJson, null, 2);
  const arTxId = publish.kind === "published" ? publish.txId : undefined;

  const { factory, usdg, fee } = prepared.createArgs;
  const feeAmount = parseUint(fee);
  const argsValid =
    isAddress(factory) &&
    isAddress(usdg) &&
    isBytes32(prepared.configHash) &&
    isAddress(prepared.expectedTreasuryEOA) &&
    feeAmount !== null;

  const busy = step.kind === "allowance" || step.kind === "approving" || step.kind === "creating";
  const published = publish.kind === "published";
  const wrongChain = isConnected && chainId !== rhTestnet.id;

  async function launch() {
    if (!address || !argsValid || feeAmount === null || !published) return;
    const factoryAddr = factory as `0x${string}`;
    const usdgAddr = usdg as `0x${string}`;
    try {
      setStep({ kind: "allowance" });
      let allowance: bigint | null = null;
      try {
        allowance = await readContract(config, {
          address: usdgAddr,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, factoryAddr],
          chainId: rhTestnet.id,
        });
      } catch {
        allowance = null; // unknown => approve the exact fee (never over-approve)
      }

      if (allowance === null || allowance < feeAmount) {
        setStep({ kind: "approving" });
        const approveHash = await writeContractAsync({
          address: usdgAddr,
          abi: erc20Abi,
          functionName: "approve",
          args: [factoryAddr, feeAmount],
          chainId: rhTestnet.id,
        });
        setStep({ kind: "approving", hash: approveHash });
        const r = await waitForTransactionReceipt(config, { hash: approveHash, chainId: rhTestnet.id });
        if (r.status !== "success") throw new Error("USDG approve reverted");
      }

      setStep({ kind: "creating" });
      const createHash = await writeContractAsync({
        address: factoryAddr,
        abi: factoryAbi,
        functionName: "createAgent",
        args: [
          input.name.trim(),
          input.symbol,
          "",
          prepared.configHash as `0x${string}`,
          address,
          prepared.expectedTreasuryEOA as `0x${string}`,
        ],
        chainId: rhTestnet.id,
      });
      setStep({ kind: "creating", hash: createHash });
      const receipt = await waitForTransactionReceipt(config, { hash: createHash, chainId: rhTestnet.id });
      if (receipt.status !== "success") throw new Error("createAgent reverted");

      // Race honesty: the helper's agentId was a prediction — trust the event.
      const requested = parseEventLogs({
        abi: factoryAbi,
        logs: receipt.logs,
        eventName: "AgentRequested",
      }).find((l) => l.address.toLowerCase() === factory.toLowerCase());
      const realId = requested ? requested.args.agentId.toString() : String(prepared.agentId);

      router.push(trackUrl(realId, Math.floor(Date.now() / 1000), prepared.agentId, createHash, arTxId));
    } catch (err) {
      setStep({ kind: "error", message: errMessage(err) });
    }
  }

  function simulate() {
    if (!published) return;
    router.push(trackUrl(String(prepared.agentId), Math.floor(Date.now() / 1000), prepared.agentId, undefined, arTxId));
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">Review</h2>
        <p className="mt-1 text-sm text-slate-500">
          Everything below is frozen by the configHash you are about to anchor on-chain. Check it
          before signing.
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/40">
        <Field label="Name / symbol" value={`${input.name.trim()} · ${input.symbol}`} mono={false} />
        <Field label="Predicted agent id" value={`#${prepared.agentId}`} mono={false} />
        <Field label="Treasury EOA (KMS-predicted)" value={prepared.expectedTreasuryEOA} />
        <Field label="Action EOA" value={prepared.actionEOA} />
        <Field label="Config hash" value={prepared.configHash} />
        <Field label="Image id" value={prepared.imageId} />
        <Field label="Factory" value={factory} />
        <Field label="Creation fee" value={`${formatUsdg(fee)} USDG`} mono={false} />
        <PublishRow publish={publish} onRetry={onRetryPublish} disabled={busy} />
      </div>
      <p className="-mt-3 text-xs text-slate-500">
        The agent id is a prediction (next factory id) — if someone else launches first, your
        transaction gets a different id; the tracker re-checks it from the receipt.
      </p>

      <details className="rounded-xl border border-slate-800 bg-slate-900/40">
        <summary className="cursor-pointer px-4 py-2 text-sm text-slate-300">
          Full agent.json (frozen config)
        </summary>
        <div className="border-t border-slate-800">
          <div className="flex justify-end px-3 py-1">
            <CopyButton value={agentJsonText} label="agent.json" />
          </div>
          <pre className="max-h-96 overflow-auto px-4 pb-4 font-mono text-xs leading-relaxed text-slate-300">
            {agentJsonText}
          </pre>
        </div>
      </details>

      {!published ? (
        <p className="-mt-3 text-xs text-slate-500">
          The launch transaction unlocks once your config is on Arweave — the orchestrator finds it there by its
          configHash and trusts only the hash you anchor on-chain.
        </p>
      ) : null}

      {!argsValid ? (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          The launch helper returned malformed transaction arguments — not submitting. Go back and
          try again.
        </p>
      ) : fixtures ? (
        <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <p className="text-sm text-slate-300">
            Fixtures mode — no chain. The real flow asks your wallet to approve{" "}
            {formatUsdg(fee)} USDG (if the allowance is short) and then call createAgent.
          </p>
          <button
            type="button"
            onClick={simulate}
            disabled={!published}
            className="self-start rounded-md border border-accent/40 bg-accent/15 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Simulate launch →
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          {!isConnected ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-slate-300">Connect a wallet to launch.</span>
              <ConnectButton />
            </div>
          ) : wrongChain ? (
            <button
              type="button"
              disabled={switching}
              onClick={() => switchChain({ chainId: rhTestnet.id })}
              className="self-start rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-300 disabled:opacity-50"
            >
              {switching ? "Switching…" : `Switch to ${rhTestnet.name}`}
            </button>
          ) : (
            <>
              <p className="text-sm text-slate-300">
                Creator (receives the agent NFT): <span className="font-mono">{address}</span>
              </p>
              <button
                type="button"
                onClick={launch}
                disabled={busy || !published}
                className="self-start rounded-md border border-accent/40 bg-accent/15 px-4 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {step.kind === "allowance"
                  ? "Checking allowance…"
                  : step.kind === "approving"
                    ? step.hash
                      ? "Waiting for approve…"
                      : "Approve USDG in your wallet…"
                    : step.kind === "creating"
                      ? step.hash
                        ? "Waiting for createAgent…"
                        : "Confirm createAgent in your wallet…"
                      : `Pay ${formatUsdg(fee)} USDG & launch`}
              </button>
            </>
          )}
          {step.kind === "error" ? (
            <p className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
              {step.message}
            </p>
          ) : null}
        </div>
      )}

      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        className="self-start text-sm text-slate-400 hover:text-slate-200 disabled:opacity-50"
      >
        ← Edit
      </button>
    </div>
  );
}

/**
 * SPEC-M4E R3 review row: the frozen config's permanent Arweave copy. The
 * item is pure transport (R1) — genesis re-hashes it against the on-chain
 * configHash, so this link is for the user's own verification and revival.
 */
function PublishRow({
  publish,
  onRetry,
  disabled,
}: {
  publish: PublishState;
  onRetry: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <span className="text-xs uppercase tracking-wide text-slate-500">Config on Arweave</span>
      {publish.kind === "publishing" ? (
        <span className="text-sm text-slate-400">Publishing to Arweave…</span>
      ) : publish.kind === "published" ? (
        <span className="flex min-w-0 flex-col items-start gap-0.5 sm:items-end">
          <span className="flex min-w-0 items-center gap-1">
            <span className="break-all font-mono text-sm text-slate-200">{publish.ref}</span>
            <CopyButton value={publish.ref} label="Arweave ref" />
          </span>
          <a
            href={`${ARWEAVE_GATEWAY}/${publish.txId}`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-accent hover:underline"
          >
            config published permanently ↗
          </a>
        </span>
      ) : (
        <span className="flex max-w-md flex-col items-start gap-1 sm:items-end">
          <span className="text-xs text-red-300 sm:text-right">{publish.message}</span>
          {publish.retryable ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={disabled}
              className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:border-slate-600 disabled:opacity-50"
            >
              Retry publish
            </button>
          ) : null}
        </span>
      )}
    </div>
  )
}
