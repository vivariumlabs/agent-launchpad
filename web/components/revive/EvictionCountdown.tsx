"use client";

import { useEffect, useState } from "react";

import { formatAbsoluteTime } from "@/lib/format";
import { formatCountdown } from "@/lib/revive";

/**
 * "Evictable in 2d 3h 04m" from the quote's gate (SPEC-M4F §2). First render
 * (SSR) shows the absolute time only — the ticking value appears client-side,
 * so there is no hydration mismatch and never a NaN.
 */
export function EvictionCountdown({ evictableAt }: { evictableAt: number }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const left = now === null ? null : evictableAt - now;
  return (
    <span className="inline-flex flex-col">
      <span className="font-mono text-sm text-amber-300/80">
        {left === null ? "…" : left > 0 ? `evictable in ${formatCountdown(left)}` : "revival window passed — evictable now"}
      </span>
      <span className="text-[11px] text-slate-500" title="On-chain gate: lastHeartbeat + REVIVAL_WINDOW">
        {formatAbsoluteTime(evictableAt)}
      </span>
    </span>
  );
}
