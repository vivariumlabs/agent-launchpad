// SPEC-M4G §3 floor refresher (balance loop cadence, balanceRefreshSec DEFAULT 300): reads the floor
// vault's USDG balance (B) and the platform token's totalSupply (S) every pass, and the token's
// name / symbol / decimals once (immutable), into the kv table. GET /api/floor derives
// floorPriceX18 = B·1e36/S from these. Never throws: a failed pass is a LOUD warn and the previous
// values stay (updatedAt tells the reader how fresh they are).

import type { Address } from "viem";
import type { IndexerChain } from "./chain.js";
import type { Clock } from "./clock.js";
import type { FloorCfg } from "./config.js";
import type { IndexerDb } from "./db.js";
import { errMsg, type Logger } from "./log.js";

export const FLOOR_KV = {
  vaultUsdg: "floor.vaultUsdg",
  totalSupply: "floor.totalSupply",
  tokenName: "floor.token.name",
  tokenSymbol: "floor.token.symbol",
  tokenDecimals: "floor.token.decimals",
  updatedAt: "floor.updatedAt",
} as const;

export class FloorRefresher {
  constructor(
    private readonly db: IndexerDb,
    private readonly chain: IndexerChain,
    private readonly usdg: Address,
    private readonly floor: FloorCfg,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  /** One pass. Returns true on success. Never throws. */
  async refresh(): Promise<boolean> {
    try {
      if (this.db.kvGet(FLOOR_KV.tokenDecimals) === undefined) {
        const [info, decimals] = await Promise.all([this.chain.tokenInfo(this.floor.token), this.chain.erc20Decimals(this.floor.token)]);
        this.db.tx(() => {
          this.db.kvSet(FLOOR_KV.tokenName, info.name);
          this.db.kvSet(FLOOR_KV.tokenSymbol, info.symbol);
          this.db.kvSet(FLOOR_KV.tokenDecimals, String(decimals));
        });
      }
      const [b, sup] = await Promise.all([this.chain.erc20Balance(this.usdg, this.floor.vault), this.chain.erc20TotalSupply(this.floor.token)]);
      this.db.tx(() => {
        this.db.kvSet(FLOOR_KV.vaultUsdg, b.toString(10));
        this.db.kvSet(FLOOR_KV.totalSupply, sup.toString(10));
        this.db.kvSet(FLOOR_KV.updatedAt, this.clock.now().toString());
      });
      return true;
    } catch (e) {
      this.log.warn(`FLOOR REFRESH FAILED (vault ${this.floor.vault}): ${errMsg(e)}`);
      return false;
    }
  }
}
