import type { Strategy, MarketContext, Decision, PricePoint } from "./types.js";

/**
 * Momentum — follows the recent price trend.
 *
 * If we have price history, we look at the trend direction over recent
 * data points and buy the side that's been moving up. No history →
 * falls back to buying the higher-priced side.
 */
export class MomentumStrategy implements Strategy {
  readonly name = "Momentum";
  readonly description =
    "Follows price momentum. Buys the side trending up recently. " +
    "Falls back to the favourite when no history is available.";
  readonly config = { name: "momentum", enabled: true, budget: null as number | null };

  private readonly minDataPoints = 3;
  private readonly minQty = 15;
  private readonly maxQty = 25;

  decide(ctx: MarketContext): Decision | null {
    const { market, recentPrices } = ctx;

    let trendingUp: boolean;

    if (recentPrices.length >= this.minDataPoints) {
      // Compute simple trend: compare average of last half vs first half
      const mid = Math.floor(recentPrices.length / 2);
      const firstHalf = recentPrices.slice(0, mid);
      const secondHalf = recentPrices.slice(mid);

      const avgFirst = avg(firstHalf);
      const avgSecond = avg(secondHalf);

      trendingUp = avgSecond > avgFirst;
    } else {
      // No history — buy the favourite
      const sorted = [...market.outcomes].sort((a, b) => b.price - a.price);
      const favourite = sorted[0];

      if (favourite.price <= 0.50) {
        return null; // no clear leader, sit out
      }

      return {
        side: mapLabel(favourite.label),
        confidence: favourite.price,
        reasoning:
          `Momentum (fallback): ${favourite.label} at ${favourite.price.toFixed(3)} ` +
          `(no history, buying favourite)`,
        quantity: this.scaleQuantity(favourite.price),
      };
    }

    // We have a trend. Pick the outcome aligned with the trend direction.
    // For YES/Up: trending up → buy YES. trending down → buy NO.
    // Generic: outcomes[0] is YES side, outcomes[1] is NO side.
    const yesOutcome = market.outcomes.find(
      (o) => o.label === "Yes" || o.label === "Up",
    ) ?? market.outcomes[0];
    const noOutcome = market.outcomes.find(
      (o) => o.label === "No" || o.label === "Down",
    ) ?? market.outcomes[1];

    if (!yesOutcome || !noOutcome) {
      return null; // can't determine sides
    }

    const pick = trendingUp ? yesOutcome : noOutcome;
    const trendStrength = Math.abs(
      avg(ctx.recentPrices.slice(-Math.floor(ctx.recentPrices.length / 2))) -
        avg(ctx.recentPrices.slice(0, Math.floor(ctx.recentPrices.length / 2))),
    );

    return {
      side: mapLabel(pick.label),
      confidence: Math.min(trendStrength + 0.50, 0.95), // floor at 0.50, cap at 0.95
      reasoning:
        `Momentum: ${pick.label} at ${pick.price.toFixed(3)} ` +
        `(trending ${trendingUp ? "up" : "down"}, ` +
        `${recentPrices.length} data points)`,
      quantity: this.scaleQuantity(pick.price),
    };
  }

  private scaleQuantity(price: number): number {
    // Higher price → more confidence → more shares
    const t = Math.max(0, price - 0.30) / 0.70; // normalise 0.30–1.00 → 0–1
    return Math.round(this.minQty + t * (this.maxQty - this.minQty));
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function avg(points: PricePoint[]): number {
  if (points.length === 0) return 0;
  return points.reduce((sum, p) => sum + p.price, 0) / points.length;
}

function mapLabel(label: string): "YES" | "NO" {
  if (label === "No" || label === "Down") return "NO";
  return "YES"; // Yes, Up, or any other label → YES
}
