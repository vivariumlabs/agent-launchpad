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
 */
import { isAddress } from "./factory";
import { parseTimestamp } from "./format";
import type { ContractsResponse, WalletNft, WalletNftsResponse } from "./types";

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

/** Tolerant /api/contracts parse: null unless chainId is a safe integer and addresses is a string record. */
export function normalizeContracts(raw: unknown): ContractsResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const chainId = typeof r.chainId === "string" && /^\d+$/.test(r.chainId) ? Number(r.chainId) : r.chainId;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId)) return null;
  if (typeof r.addresses !== "object" || r.addresses === null) return null;
  const addresses: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.addresses as Record<string, unknown>)) {
    if (typeof v === "string") addresses[k] = v;
  }
  return { chainId, addresses };
}

/** Pick nft + distributor (case-insensitive keys); null when either is missing/malformed. */
export function nftContracts(c: ContractsResponse | null): NftContracts | null {
  if (!c) return null;
  const find = (name: string): string | undefined =>
    Object.entries(c.addresses).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  const nft = find("nft") ?? find("agentNft");
  const distributor = find("distributor") ?? find("royaltyDistributor");
  if (!nft || !distributor || !isAddress(nft) || !isAddress(distributor)) return null;
  return { chainId: c.chainId, nft, distributor };
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
