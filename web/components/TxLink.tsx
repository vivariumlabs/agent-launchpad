import { EXPLORER_TX_BASE_URL } from "@/lib/config";
import { truncateAddress } from "@/lib/format";

/** Explorer link when a base URL is configured; safe fallback to raw tx hash text otherwise (SPEC-M4A §2). */
export function TxLink({ txHash }: { txHash: string | null }) {
  if (!txHash) return null;
  if (!EXPLORER_TX_BASE_URL) {
    return <span className="font-mono text-xs text-slate-500">{truncateAddress(txHash, 6)}</span>;
  }
  return (
    <a
      href={`${EXPLORER_TX_BASE_URL}${txHash}`}
      target="_blank"
      rel="noreferrer noopener"
      className="font-mono text-xs text-accent hover:underline"
    >
      {truncateAddress(txHash, 6)} ↗
    </a>
  );
}
