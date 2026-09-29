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

// ---------------------------------------------------------------------------
// SPEC-M4C §2 — chat tab (client-safe constants: no secrets, NEXT_PUBLIC_ only).
// ---------------------------------------------------------------------------

/**
 * Agent DNS root (D14, SPEC-M4C R3 DEFAULT "vivarium.systems"). The default chat
 * endpoint is `https://a<agentId>.<AGENT_DNS_ROOT>`. NEXT_PUBLIC_ so the
 * browser bundle sees the same value (chat is browser → enclave only, R2).
 */
export const AGENT_DNS_ROOT =
  (process.env.NEXT_PUBLIC_AGENT_DNS_ROOT || "vivarium.systems").trim().replace(/^\.+|\.+$/g, "") ||
  "vivarium.systems";

/** Robinhood testnet chain id — the SIWE `Chain ID` the runtime checks (cfg.chainIds.rh). */
export const RH_CHAIN_ID = 46630;

/** Client-side input cap = runtime cfg.chatMaxChars DEFAULT (2000). */
export const CHAT_MAX_CHARS = 2000;

/** Runtime chat rate caps — DEFAULTs (cfg.chatPerHour / cfg.chatPerDay), labeled as such, never as readings. */
export const CHAT_PER_HOUR_DEFAULT = 20;
export const CHAT_PER_DAY_DEFAULT = 100;

/** D13 notice — VERBATIM (SPEC-M4C §2). */
export const D13_NOTICE =
  "This agent is autonomous; social-engineering its action wallet is part of the game; its survival wallet is out of reach.";

// ---------------------------------------------------------------------------
// SPEC-M4F §2 — mausoleum / revive flow. Payment token, recipient and chain id
// come ONLY from the launch-helper's quote payload — nothing chain-specific
// lives here. Revive mode = LAUNCH_MODE (same helper).
// ---------------------------------------------------------------------------

/** Orchestrator-less revival backstop (04 §6): the public rebuild procedure. `HEAD` = the repo's default branch. */
export const REPRODUCIBLE_BUILD_URL = `${REPO_URL}/blob/HEAD/runtime/docs/REPRODUCIBLE-BUILD.md`;

/** 04-GENESIS.md (§6 revival flow). */
export const GENESIS_DOC_URL = `${REPO_URL}/blob/HEAD/docs/04-GENESIS.md`;

/** Journal read size for the mausoleum's entry count (indexer max limit = 200). */
export const MAUSOLEUM_JOURNAL_LIMIT = 200;
