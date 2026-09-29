/**
 * NFT dashboard helpers (SPEC-M4E §3): inline ABI fragments + tolerant
 * parsers for the indexer's /api/contracts and /api/wallets/:address/nfts.
 *
 * ABI fragments are transcribed from the contract sources and inline on
 * purpose — no cross-package import into the Next bundle (SPEC-M4A §2, same
 * discipline as web/lib/factory.ts):
 *   - contracts/src/interfaces/ILaunchpad.sol  IRoyaltyDistributor:
 *       event Claimed(uint256 indexed agentId, address indexed to, uint256 amount)   :49
 *       event Emancipated(uint256 indexed agentId, uint256 sweptToTreasury)          :50
 *       function claim(uint256 agentId)            — permissionless, pays nft.ownerOf :55
 *       function accrued(uint256 agentId) view returns (uint256)                     :59
 *     (RoyaltyDistributor.sol: claim :101 reverts NothingToClaim() on 0; onBurn :117
 *      sweeps accrued to the registered treasury and emits Emancipated)
 *   - contracts/src/AgentNFT.sol:
 *       function burn(uint256 tokenId) — owner-only (NotTokenOwner), irreversible   :73
 *       function ownerOf(uint256 tokenId) view returns (address) — reverts once burned :96
 *     tokenId == agentId always (:9).
 *
 * R5: addresses come ONLY from /api/contracts — this file carries none.
 * SPEC-M4G dual-stack: claim/burn use the AGENT's stack addresses
 * (contractsForNft), not the primary manifest's.
 */
import { isAddress } from "./factory";
import { parseTimestamp } from "./format";
import { normalizeStack, normalizeStackInfo } from "./stack";
import type { ContractsResponse, StackInfo, WalletNft, WalletNftsResponse } from "./types";

export const distributorAbi = [
  {
    type: "function",
    name: "accrued",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Emancipated",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "sweptToTreasury", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  { type: "error", name: "NothingToClaim", inputs: [] },
  { type: "error", name: "AlreadyEmancipated", inputs: [] },
] as const;

export const agentNftAbi = [
  {
    type: "function",
    name: "burn",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  { type: "error", name: "NotTokenOwner", inputs: [] },
  {
    type: "error",
    name: "ERC721NonexistentToken",
    inputs: [{ name: "tokenId", type: "uint256" }],
  },
] as const;

/** The two addresses the dashboard needs, validated. */
export interface NftContracts {
  chainId: number;
  nft: `0x${string}`;
  distributor: `0x${string}`;
}

/**
 * Tolerant /api/contracts parse: null unless chainId is a safe integer and
 * some address record is present. The indexer serves the manifest's address
 * keys FLAT beside `chainId` (indexer/src/config.ts contractsViewOf); an
 * `addresses` sub-object (the SPEC-M4E pinned shape) is accepted too.
 * SPEC-M4G `stacks[]` is parsed when present (malformed entries dropped).
 */
export function normalizeContracts(raw: unknown): ContractsResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const chainId = typeof r.chainId === "string" && /^\d+$/.test(r.chainId) ? Number(r.chainId) : r.chainId;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId)) return null;
  const addresses: Record<string, string> = {};
  if (typeof r.addresses === "object" && r.addresses !== null && !Array.isArray(r.addresses)) {
    for (const [k, v] of Object.entries(r.addresses as Record<string, unknown>)) {
      if (typeof v === "string") addresses[k] = v;
    }
  } else {
    for (const [k, v] of Object.entries(r)) {
      if (k !== "chainId" && typeof v === "string" && isAddress(v)) addresses[k] = v;
    }
  }
  if (Object.keys(addresses).length === 0) return null;
  const stacks = Array.isArray(r.stacks)
    ? r.stacks.map(normalizeStackInfo).filter((s): s is StackInfo => s !== null)
    : null;
  return { chainId, addresses, stacks };
}

/** Case-insensitive address lookup in /api/contracts; null when absent or malformed. */
export function contractAddress(c: ContractsResponse | null, ...names: string[]): `0x${string}` | null {
  if (!c) return null;
  for (const name of names) {
    const v = Object.entries(c.addresses).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    if (v !== undefined && isAddress(v)) return v;
  }
  return null;
}

/** Pick the PRIMARY stack's nft + distributor (case-insensitive keys); null when either is missing/malformed. */
export function nftContracts(c: ContractsResponse | null): NftContracts | null {
  if (!c) return null;
  const nft = contractAddress(c, "nft", "agentNft");
  const distributor = contractAddress(c, "distributor", "royaltyDistributor");
  if (!nft || !distributor) return null;
  return { chainId: c.chainId, nft, distributor };
}

/**
 * SPEC-M4G dual-stack: claim/burn target addresses for ONE NFT — from the
 * agent's own `stack`. Only when the indexer predates dual-stack (no
 * `stacks` in /api/contracts: one stack, no ambiguity) does it fall back to
 * the manifest's top-level nft/distributor. Never guesses across stacks.
 */
export function contractsForNft(
  nft: Pick<WalletNft, "stack">,
  c: ContractsResponse | null,
): { contracts: NftContracts | null; reason: string | null } {
  if (!c) return { contracts: null, reason: "contract addresses unavailable" };
  if (nft.stack) {
    return { contracts: { chainId: c.chainId, nft: nft.stack.nft, distributor: nft.stack.distributor }, reason: null };
  }
  if (c.stacks === null) {
    const single = nftContracts(c);
    return single ? { contracts: single, reason: null } : { contracts: null, reason: "contract addresses unavailable" };
  }
  return { contracts: null, reason: "this agent's contract stack is unknown to the indexer — claim/burn disabled" };
}

function uintString(v: unknown): string | null {
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return v.trim();
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  return null;
}

function optString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function sinceSeconds(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.floor(v > 1e12 ? v / 1000 : v) : null;
  if (typeof v === "string") return parseTimestamp(v);
  return null;
}

/** One wire row -> WalletNft, or null when agentId is unusable (the row is dropped, never rendered as NaN). */
export function normalizeWalletNft(raw: unknown): WalletNft | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const idStr = uintString(r.agentId ?? r.tokenId);
  if (idStr === null) return null;
  const agentId = Number(idStr);
  if (!Number.isSafeInteger(agentId)) return null;
  return {
    agentId,
    name: optString(r.name),
    symbol: optString(r.symbol),
    since: sinceSeconds(r.since),
    emancipated: r.emancipated === true,
    lifetimeClaimed: uintString(r.lifetimeClaimed),
    sweptToTreasury: uintString(r.sweptToTreasury ?? r.swept),
    stack: normalizeStack(r.stack),
  };
}

/** Tolerant list parse; null = unusable body (callers show an error, not "empty"). */
export function normalizeWalletNfts(raw: unknown, address: string): WalletNftsResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r.nfts) ? r.nfts : Array.isArray(raw) ? (raw as unknown[]) : null;
  if (list === null) return null;
  const nfts = list.map(normalizeWalletNft).filter((n): n is WalletNft => n !== null);
  // One card per agentId (defensive against duplicate rows).
  const seen = new Set<number>();
  const unique = nfts.filter((n) => (seen.has(n.agentId) ? false : (seen.add(n.agentId), true)));
  unique.sort((a, b) => Number(a.emancipated) - Number(b.emancipated) || a.agentId - b.agentId);
  return { address: typeof r.address === "string" ? r.address : address, nfts: unique };
}

/** What the user must type to arm the burn (R6): the symbol, or a fallback when the agent has none. */
export function burnArmPhrase(nft: Pick<WalletNft, "agentId" | "symbol">): string {
  return nft.symbol ?? `BURN ${nft.agentId}`;
}

export function displayName(nft: Pick<WalletNft, "agentId" | "name">): string {
  return nft.name ?? `Agent #${nft.agentId}`;
}
