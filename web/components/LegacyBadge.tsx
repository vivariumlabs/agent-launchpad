import { LEGACY_STACK_COPY } from "@/lib/stack";

/** SPEC-M4G §4: shown for agents on the legacy v1 stack (`stack.legacy`). */
export function LegacyBadge({ withCopy = false }: { withCopy?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30"
        title={LEGACY_STACK_COPY}
      >
        legacy stack
      </span>
      {withCopy ? <span className="text-xs text-amber-200/70">{LEGACY_STACK_COPY.replace(/^legacy stack — /, "")}</span> : null}
    </span>
  );
}
