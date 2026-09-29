import { CopyButton } from "./CopyButton";

/**
 * SPEC-M4D R5: the checks above cover the registration-time quote (re-verified server-side);
 * independent verification of the RUNNING enclave stays the reader's own step.
 */
export const QUOTE_SIGNATURE_CAVEAT =
  "The checks above re-verify the quote the agent published at registration. To verify the running enclave yourself — independently of this site — run these commands against the registered image-id.";

/**
 * "Verify it yourself" panel (SPEC-M4B §3a, R1): monospace command block +
 * copy button. Commands come templated from real values by the indexer;
 * the enclave IP is not on-chain, so it stays a placeholder.
 */
export function VerifyYourself({
  imageId,
  commands,
}: {
  imageId: string | null;
  commands: string[];
}) {
  const block = commands.join("\n");
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <p className="text-sm text-slate-300">{QUOTE_SIGNATURE_CAVEAT}</p>
      {imageId ? (
        <p className="mt-2 break-all text-xs text-slate-500">
          Expected image-id: <span className="font-mono text-slate-300">{imageId}</span>
        </p>
      ) : null}
      {commands.length > 0 ? (
        <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950">
          <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">shell</span>
            <CopyButton value={block} label="verification commands" />
          </div>
          <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-slate-200">
            {block}
          </pre>
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-500">
          No verification commands available for this agent yet.
        </p>
      )}
      {/<[^>]*ip[^>]*>/i.test(block) ? (
        <p className="mt-2 text-xs text-slate-500">
          Replace the enclave IP placeholder with the enclave&apos;s address — it is not
          recorded on-chain.
        </p>
      ) : null}
    </div>
  );
}
