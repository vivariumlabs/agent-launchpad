"use client";

import { CopyButton } from "../CopyButton";
import { truncateAddress } from "@/lib/format";

/**
 * Client-side tx hash display. The explorer base URL is server-only config
 * (lib/config.ts), so client cards show the hash + copy instead of a link.
 */
export function TxHashText({ hash, simulated }: { hash: string | null; simulated: boolean }) {
  if (simulated) return <span className="text-slate-500">(simulated — no transaction)</span>;
  if (!hash) return null;
  return (
    <span className="inline-flex items-center gap-1 text-slate-400">
      tx <span className="font-mono">{truncateAddress(hash, 6)}</span>
      <CopyButton value={hash} label="transaction hash" />
    </span>
  );
}
