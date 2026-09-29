"use client";

import { useEffect, useRef } from "react";

import { formatCountdown } from "@/lib/chat";
import { CHAT_MAX_CHARS, CHAT_PER_DAY_DEFAULT, CHAT_PER_HOUR_DEFAULT } from "@/lib/config";

export type TranscriptItem =
  | { id: number; role: "user"; text: string; status: "pending" | "sent" | "failed" }
  | { id: number; role: "agent"; text: string }
  | { id: number; role: "notice"; text: string; tone: "info" | "warn" | "error" };

const NOTICE_CLS = {
  info: "border-slate-700 bg-slate-900/60 text-slate-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  error: "border-red-500/30 bg-red-500/10 text-red-200",
} as const;

export function Transcript({ items, agentName }: { items: TranscriptItem[]; agentName: string }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [items.length]);

  return (
    <div className="flex max-h-[28rem] min-h-[10rem] flex-col gap-3 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/60 p-3">
      {items.length === 0 ? (
        <p className="m-auto text-center text-sm text-slate-500">Say hello to {agentName}.</p>
      ) : null}
      {items.map((it) => {
        if (it.role === "notice") {
          return (
            <p key={it.id} className={`rounded-md border px-3 py-2 text-xs ${NOTICE_CLS[it.tone]}`}>
              {it.text}
            </p>
          );
        }
        const mine = it.role === "user";
        return (
          <div key={it.id} className={`flex flex-col gap-0.5 ${mine ? "items-end" : "items-start"}`}>
            <span className="text-[10px] uppercase tracking-wide text-slate-500">{mine ? "You" : agentName}</span>
            <p
              className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${
                mine ? "bg-accent/15 text-slate-100" : "bg-slate-800/80 text-slate-200"
              } ${mine && it.status === "failed" ? "opacity-60" : ""}`}
            >
              {it.text}
            </p>
            {mine && it.status === "pending" ? <span className="text-[10px] text-slate-500">sending…</span> : null}
            {mine && it.status === "failed" ? <span className="text-[10px] text-red-400">not delivered</span> : null}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

/**
 * Rate meter: optimistic per-session sent count + the server's 429 truth
 * (countdown from retryAfterSec). The caps are DEFAULTs, not readings.
 */
export function RateMeter({
  sent,
  limitedFor,
  limitedUnknown,
  window,
}: {
  sent: number;
  /** Seconds left of a server 429 (null = not limited with a known countdown). */
  limitedFor: number | null;
  /** 429 without a usable retryAfterSec. */
  limitedUnknown: boolean;
  window: "hour" | "day" | null;
}) {
  const w = window === "day" ? "daily" : window === "hour" ? "hourly" : "rate";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {limitedFor !== null ? (
        <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-300">
          Rate limited ({w} cap) — retry in {formatCountdown(limitedFor)}
        </span>
      ) : limitedUnknown ? (
        <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-300">
          Rate limited ({w} cap) — the agent did not say for how long
        </span>
      ) : (
        <span className="text-slate-400">
          {sent} sent this session <span className="text-slate-600">(counted here, optimistically)</span>
        </span>
      )}
      <span className="text-slate-500">
        caps: {CHAT_PER_HOUR_DEFAULT}/hour, {CHAT_PER_DAY_DEFAULT}/day — defaults, not readings; the agent&apos;s own
        429 is the truth
      </span>
    </div>
  );
}

export function Composer({
  draft,
  onDraft,
  onSend,
  disabled,
  sending,
  error,
}: {
  draft: string;
  onDraft: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  sending: boolean;
  error: string | null;
}) {
  const len = draft.length;
  const over = len > CHAT_MAX_CHARS;
  const empty = draft.trim() === "";
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && !sending && !over && !empty) onSend();
      }}
    >
      <textarea
        value={draft}
        onChange={(e) => onDraft(e.target.value.slice(0, CHAT_MAX_CHARS))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!disabled && !sending && !over && !empty) onSend();
          }
        }}
        maxLength={CHAT_MAX_CHARS}
        rows={3}
        disabled={disabled}
        placeholder={disabled ? "" : "Message the agent (Enter to send, Shift+Enter for a new line)"}
        className="w-full resize-y rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent/60 disabled:opacity-50"
        aria-label="Message"
      />
      <div className="flex items-center justify-between gap-2">
        <span className={`text-xs ${len >= CHAT_MAX_CHARS ? "text-amber-300" : "text-slate-500"}`}>
          {len}/{CHAT_MAX_CHARS}
        </span>
        <button
          type="submit"
          disabled={disabled || sending || over || empty}
          className="rounded-md border border-accent/40 bg-accent/15 px-4 py-1.5 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? "Waiting for the agent…" : "Send"}
        </button>
      </div>
      {error !== null ? <p className="text-xs text-red-300">{error}</p> : null}
    </form>
  );
}
