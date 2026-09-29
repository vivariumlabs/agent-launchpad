import { formatEth, formatUsdg } from "./format";
import type { ActivityItem } from "./types";

function str(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === "string" ? v : null;
}

function num(data: Record<string, unknown>, key: string): number | null {
  const v = data[key];
  return typeof v === "number" ? v : null;
}

function bool(data: Record<string, unknown>, key: string): boolean | null {
  const v = data[key];
  return typeof v === "boolean" ? v : null;
}

/** "curve_graduated" -> "Curve graduated" — last-resort label for a kind this UI doesn't know yet. */
function prettifyRawKind(kind: string): string {
  const words = kind.replace(/[_-]+/g, " ").trim();
  if (words === "") return kind;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Humanize a decoded activity event's kind-specific payload for the feed row.
 * `kind` is a free-form string from the watcher (indexer/src/watcher.ts), NOT
 * a narrow union — every known kind is handled below; anything else falls
 * back to a lightly-prettified version of the raw kind label.
 */
/**
 * Raw Uniswap v4 pool swap: amount0/amount1 are signed deltas: pick the
 * USDG-side leg via agentIsCurrency0 and return its magnitude (direction
 * isn't reliably inferable from the raw deltas alone). Null when absent.
 */
function swapUsdgMagnitude(data: Record<string, unknown>): string | null {
  const agentIsCurrency0 = bool(data, "agentIsCurrency0");
  const usdgSide = agentIsCurrency0 === true ? str(data, "amount1") : str(data, "amount0");
  if (!usdgSide) return null;
  return usdgSide.startsWith("-") ? usdgSide.slice(1) : usdgSide;
}

export function humanizeActivity(event: ActivityItem): string {
  const { kind, data } = event;
  switch (kind) {
    case "swap": {
      const magnitude = swapUsdgMagnitude(data);
      return magnitude !== null ? `Pool swap: ${formatUsdg(magnitude)} USDG` : "Pool swap";
    }
    case "actionSwap": {
      // This agent's own wallet (tx sender = its action or treasury EOA)
      // traded on a pool — possibly another agent's (data.poolAgentId).
      const poolAgentId = num(data, "poolAgentId");
      const wallet = str(data, "wallet");
      const where = poolAgentId !== null ? `Traded on agent #${poolAgentId}'s pool` : "Traded on a pool";
      const via = wallet ? ` (${wallet} wallet)` : "";
      const magnitude = swapUsdgMagnitude(data);
      return magnitude !== null ? `${where}${via}: ${formatUsdg(magnitude)} USDG` : `${where}${via}`;
    }
    case "curve_buy":
    case "curve_sell": {
      const usdg = str(data, "usdg");
      const tokens = str(data, "tokens");
      const fee = str(data, "fee");
      const verb = kind === "curve_buy" ? "Bought" : "Sold";
      const amount = usdg ? `${formatUsdg(usdg)} USDG` : "";
      const tokenAmount = tokens ? `${formatEth(tokens)} tokens` : "";
      const feeText = fee ? ` (fee ${formatUsdg(fee)} USDG)` : "";
      const arrow =
        kind === "curve_buy" ? `${amount} → ${tokenAmount}` : `${tokenAmount} → ${amount}`;
      return `${verb} on curve: ${arrow}${feeText}`;
    }
    case "curve_graduated": {
      const usdgSwept = str(data, "usdgSwept");
      const tokensSwept = str(data, "tokensSwept");
      return usdgSwept && tokensSwept
        ? `Curve graduated: swept ${formatUsdg(usdgSwept)} USDG / ${formatEth(tokensSwept)} tokens into the pool`
        : "Curve graduated";
    }
    case "requested":
      return "Agent requested";
    case "live":
      return "Deployed live";
    case "cancelled":
      return "Request cancelled";
    case "graduated": {
      const poolUsdg = str(data, "poolUsdg");
      const poolTokens = str(data, "poolTokens");
      return poolUsdg && poolTokens
        ? `Graduated to pool: ${formatUsdg(poolUsdg)} USDG / ${formatEth(poolTokens)} tokens seeded`
        : "Graduated to pool";
    }
    case "genesis_opened":
      return "Genesis window opened";
    case "registered": {
      const generation = num(data, "generation");
      return generation !== null
        ? `Registered on-chain — generation ${generation}`
        : "Registered on-chain";
    }
    case "heartbeat":
      return "Heartbeat";
    case "pool_registered":
      return "Pool registered";
    case "fee_collected": {
      const amount = str(data, "amount");
      return amount ? `Fee collected: ${formatUsdg(amount)} USDG` : "Fee collected";
    }
    case "distributed": {
      // SPEC-M4G: the indexer presents this leg as `platformLeg` (ABI field `floorLeg`; pre-M4G rows `buybackLeg`).
      // The agent's stack is not known here, so the leg gets the stack-neutral name "platform".
      const platform = str(data, "floorLeg") ?? str(data, "platformLeg") ?? str(data, "buybackLeg");
      const treasury = str(data, "treasuryLeg");
      const royalty = str(data, "royaltyLeg");
      const parts: string[] = [];
      if (platform) parts.push(`platform ${formatUsdg(platform)}`);
      if (treasury) parts.push(`treasury ${formatUsdg(treasury)}`);
      if (royalty) parts.push(`royalty ${formatUsdg(royalty)}`);
      return parts.length > 0
        ? `Fees distributed: ${parts.join(" · ")} USDG`
        : "Fees distributed";
    }
    case "royalty_credited": {
      const amount = str(data, "amount");
      return amount ? `Royalty credited: ${formatUsdg(amount)} USDG` : "Royalty credited";
    }
    case "royalty_claimed": {
      const amount = str(data, "amount");
      return amount ? `Royalty claimed: ${formatUsdg(amount)} USDG` : "Royalty claimed";
    }
    case "emancipated":
      return "Emancipated";
    case "buyback_poked": {
      const usdgIn = str(data, "usdgIn");
      return usdgIn ? `Buyback executed: ${formatUsdg(usdgIn)} USDG in` : "Buyback executed";
    }
    case "nft_transfer":
      return "NFT transferred";
    default:
      return prettifyRawKind(kind);
  }
}
