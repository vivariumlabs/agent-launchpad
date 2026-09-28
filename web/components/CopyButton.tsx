"use client";

import { useState } from "react";

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — fail silently, no crash.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded px-1.5 py-0.5 text-xs text-slate-500 transition hover:bg-slate-800 hover:text-slate-300"
      aria-label={label ? `Copy ${label}` : "Copy to clipboard"}
      title={copied ? "Copied!" : "Copy"}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
