import type { Strategy, MarketContext, Decision } from "./types.js";

export interface LateScalpConfig {
  /** Minimum favourite price to enter. Default: 0.95 */
  minPrice: number;
  /** Start trading when secondsToClose <= this. Default: 35 */
  actBeforeSec: number;
}

const DEFAULT_CONFIG: LateScalpConfig = {
  minPrice: 0.95,
  actBeforeSec: 35,
};

/**
 * Late Scalp — buys the heavy favourite in the final seconds of a 5-min window.
 *
 * Targets markets where the favourite is priced ≥ minPrice (default 0.95).
 * Acts in the last `actBeforeSec` seconds (default 35), but always skips
 * the final 8s to avoid stale quotes.
 *
 * At $0.95 the fee is minimal (~$0.033/10 shares), so the $0.05 profit
 * becomes ~$0.017 net — but with very high win rate.
 */
export class LateScalpStrategy implements Strategy {
  readonly name = "Late Scalp";
  readonly description: string;
  readonly config = { name: "late-scalp", enabled: true, budget: null as number | null };

  private readonly minPrice: number;
  private readonly actBeforeSec: number;
  private readonly skipBelowSec = 8; // hardcoded safety — never trade in last 8s
  private readonly minQty = 10;
  private readonly maxQty = 20;

  constructor(config: Partial<LateScalpConfig> = {}) {
    const full = { ...DEFAULT_CONFIG, ...config };
    this.minPrice = full.minPrice;
    this.actBeforeSec = full.actBeforeSec;
    this.description =
      `Buys the heavy favourite (≥${this.minPrice}) in the last ${this.actBeforeSec}s ` +
      `of the market window. Skips final 8s to avoid stale quotes.`;
  }

  decide(ctx: MarketContext): Decision | null {
    if (ctx.secondsToClose > this.actBeforeSec) {
      return null; // too early — wait
    }
    if (ctx.secondsToClose < this.skipBelowSec) {
      return null; // too late — quotes may be stale
    }

    // Find the outcome with the highest price
    const sorted = [...ctx.market.outcomes].sort((a, b) => b.price - a.price);
    const favourite = sorted[0];

    if (favourite.price < this.minPrice) {
      return null; // not a clear enough favourite
    }

    // Scale quantity by confidence (higher price → more shares)
    const confidence = favourite.price;
    const quantity = Math.round(
      this.minQty + (confidence - this.minPrice) * (this.maxQty - this.minQty) / (1 - this.minPrice),
    );

    return {
      side: favourite.label === "No" || favourite.label === "Down"
        ? "NO"
        : "YES",
      confidence,
      reasoning:
        `Late scalp: ${favourite.label} at ${favourite.price.toFixed(3)} ` +
        `with ${ctx.secondsToClose.toFixed(0)}s remaining`,
      quantity: Math.max(this.minQty, Math.min(this.maxQty, quantity)),
    };
  }
}
