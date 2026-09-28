/** Disabled tab stub for later slices (Attestation / Chat / Holders) — honest about what's coming (SPEC-M4A §2). */
export function TabStub({ label }: { label: string }) {
  return (
    <span className="flex cursor-not-allowed items-center gap-1.5 rounded-md border border-slate-800 px-3 py-1.5 text-sm text-slate-600">
      {label}
      <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
        soon
      </span>
    </span>
  );
}
