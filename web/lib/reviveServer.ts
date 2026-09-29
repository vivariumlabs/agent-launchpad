/**
 * SPEC-M4F §2 — SERVER-SIDE revive reads (launch-helper, M4B R4: the browser
 * never calls the helper). Used by the /mausoleum server page and the
 * web/app/api/revive/* route handlers. Do not import from client components
 * (it pulls in fixtures + server config).
 *
 * Modes follow LAUNCH_MODE (lib/config.ts):
 *   fixtures — web/fixtures/revive.json, parsed exactly like a live body
 *   live     — LAUNCH_HELPER_URL; a 503 from the helper = manual mode
 *              (no genesisDb / revivalPayTo configured there)
 *   manual   — helper unset: no quotes, orchestrator-less instructions
 */
import { LAUNCH_HELPER_URL, LAUNCH_MODE } from "./config";
import { fixtureRevive } from "./fixtures";
import { parseReviveQuote, parseRevivalRows } from "./revive";
import type { ReviveQuoteResult, RevivalRow } from "./types";

const HELPER_TIMEOUT_MS = 8000;

function errorText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { error?: unknown; reason?: unknown; message?: unknown };
  const parts = [b.error, b.reason, b.message].filter((x): x is string => typeof x === "string" && x !== "");
  return parts.length > 0 ? parts.join(" — ") : null;
}

/** Fixture quote body, with agent 2's gate re-based on `now` so the dying countdown stays meaningful. */
function fixtureQuoteRaw(agentId: number, now: number): unknown {
  const raw = fixtureRevive.quotes[String(agentId)];
  if (!raw) return null;
  const ago = raw.fixtureRelativeHeartbeatAgoSec;
  const gate = raw.gate as { revivalWindow?: unknown } | undefined;
  if (typeof ago === "number" && typeof gate?.revivalWindow === "number") {
    const lastHeartbeat = now - ago;
    return { ...raw, gate: { lastHeartbeat, revivalWindow: gate.revivalWindow, evictableAt: lastHeartbeat + gate.revivalWindow } };
  }
  return raw;
}

export async function getReviveQuote(agentId: number): Promise<ReviveQuoteResult> {
  if (LAUNCH_MODE === "manual") return { kind: "manual", message: null };

  if (LAUNCH_MODE === "fixtures") {
    const raw = fixtureQuoteRaw(agentId, Math.floor(Date.now() / 1000));
    if (raw === null) return { kind: "unavailable", message: "no quote for this agent (fixtures)" };
    const quote = parseReviveQuote(raw, agentId);
    return quote ? { kind: "ok", quote } : { kind: "unavailable", message: "malformed fixture quote" };
  }

  try {
    const res = await fetch(`${LAUNCH_HELPER_URL}/api/revive/quote/${agentId}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HELPER_TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 503) return { kind: "manual", message: errorText(body) };
    if (!res.ok) {
      const e = errorText(body);
      return { kind: "unavailable", message: `launch helper answered ${res.status}${e ? `: ${e}` : ""}` };
    }
    const quote = parseReviveQuote(body, agentId);
    return quote ? { kind: "ok", quote } : { kind: "unavailable", message: "the launch helper sent a malformed quote" };
  } catch (err) {
    return { kind: "unavailable", message: `launch helper unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export type RevivalRowsResult =
  | { kind: "ok"; rows: RevivalRow[] }
  | { kind: "manual"; message: string | null }
  | { kind: "unreachable"; message: string };

/** Live/manual only — fixtures mode simulates in the status route. */
export async function getRevivalRows(agentId: number): Promise<RevivalRowsResult> {
  if (LAUNCH_MODE !== "live") return { kind: "manual", message: null };
  try {
    const res = await fetch(`${LAUNCH_HELPER_URL}/api/revive/status/${agentId}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HELPER_TIMEOUT_MS),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.status === 503) return { kind: "manual", message: errorText(body) };
    if (!res.ok) {
      const e = errorText(body);
      return { kind: "unreachable", message: `launch helper answered ${res.status}${e ? `: ${e}` : ""}` };
    }
    return { kind: "ok", rows: parseRevivalRows(body) };
  } catch (err) {
    return { kind: "unreachable", message: `launch helper unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
