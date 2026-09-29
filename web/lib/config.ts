/**
 * Server-side config. No secrets live here — both the indexer and this site
 * read public chain + public Arweave data only (SPEC-M4A §0).
 */

/** Unset => fixtures mode (SPEC-M4A §2). Read server-side only; the browser never calls the indexer. */
export const INDEXER_URL = process.env.INDEXER_URL?.replace(/\/+$/, "") || "";

/** Testnet explorer base URL, e.g. "https://explorer.example/tx/". DEFAULT "" (SPEC-M4A §2). */
export const EXPLORER_TX_BASE_URL = process.env.EXPLORER_TX_BASE_URL || "";

/** Explorer base URL for addresses, e.g. "https://explorer.example/address/". DEFAULT "". */
export const EXPLORER_ADDRESS_BASE_URL =
  process.env.EXPLORER_ADDRESS_BASE_URL || "";

export const FIXTURES_MODE = INDEXER_URL === "";

export const REPO_URL = "https://github.com/vivariumlabs/agent-launchpad";

export const CONVENIENCE_LAYER_DISCLAIMER =
  "The website is a convenience layer — every capability it exposes must also be possible without it (direct contract calls, direct CVM chat endpoint).";

/**
 * Launch-helper base URL (genesis/src/launchHelper.ts, SPEC-M4B §2). Server-side
 * ONLY (R4) — the browser reaches it through web/app/api/launch/* route handlers.
 * Unset in live mode => /launch renders "manual mode" (honest degradation).
 * In fixtures mode (INDEXER_URL unset) the launch flow uses mock helper
 * fixtures instead, so the whole flow is walkable without services.
 */
export const LAUNCH_HELPER_URL = process.env.LAUNCH_HELPER_URL?.replace(/\/+$/, "") || "";

export type LaunchMode = "fixtures" | "live" | "manual";

export const LAUNCH_MODE: LaunchMode = FIXTURES_MODE
  ? "fixtures"
  : LAUNCH_HELPER_URL !== ""
    ? "live"
    : "manual";

/** GitHub release page for a runtime version (SPEC-M4B §3a). */
export function runtimeReleaseUrl(version: string): string {
  const v = version.replace(/^v/, "");
  return `${REPO_URL}/releases/tag/runtime-${v}`;
}

export const ARWEAVE_GATEWAY = "https://arweave.net";

/** 43-char base64url — the Arweave item-id shape (SPEC-M4B §1b refShape, SPEC-M4A §3 rev 1). */
export function isArweaveItemId(ref: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(ref);
}

/** Orchestrator trust boundary — 04 header, verbatim. */
export const ORCHESTRATOR_TRUST_BOUNDARY =
  "The orchestrator is the one platform-operated component in the launch path. Its powers are deliberately minimal and fully auditable: it can deploy CVMs and call finalize; it cannot touch keys, funds, or live agents.";

/** Launch progress: soft timeout before the "taking longer than expected" message (SPEC-M4B §3b DEFAULT). */
export const LAUNCH_TIMEOUT_SECONDS = 15 * 60;
