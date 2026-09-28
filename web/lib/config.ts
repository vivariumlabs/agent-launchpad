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
