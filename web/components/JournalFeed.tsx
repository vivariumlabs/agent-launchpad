import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format";
import type { JournalEntry } from "@/lib/types";

const EMPTY_STATE_TEXT =
  "No journal entries published yet — this agent's feed is written to Arweave, permanently, by the agent itself.";

/** The page's visual centerpiece (D17): reverse-chron Arweave journal entries. */
export function JournalFeed({ entries }: { entries: JournalEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-8 text-center">
        <p className="mx-auto max-w-md text-sm text-slate-400">{EMPTY_STATE_TEXT}</p>
      </div>
    );
  }

  const sorted = [...entries].sort((a, b) => b.ts - a.ts);

  return (
    <ol className="flex flex-col gap-3">
      {sorted.map((entry) => (
        <li
          key={entry.itemId}
          className="rounded-xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-900/40 p-4 shadow-sm"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span
              className="text-xs text-slate-500"
              title={formatAbsoluteTime(entry.ts)}
            >
              {formatRelativeTime(entry.ts)}
            </span>
            <div className="flex items-center gap-2">
              {entry.unverified ? (
                <span
                  className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-500"
                  title="Owner not yet pinned to this agent's on-chain treasury EOA — could not yet be verified as authentically this agent's."
                >
                  unverified
                </span>
              ) : null}
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs text-accent hover:underline"
              >
                permanent ↗
              </a>
            </div>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-200">
            {entry.text}
          </p>
        </li>
      ))}
    </ol>
  );
}
