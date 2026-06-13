import type { Strategy, MarketContext, Decision } from "./types.js";

/**
 * Snipe — buys the cheap underdog when it's priced below a threshold.
 *
 * Logic: if an outcome is trading below 0.30, buying it costs very little.
 * Even a 30% win rate at those odds is profitable over many trades.
 * High risk, high reward — long-term EV play.
 */
export class SnipeStrategy implements Strategy {
  readonly name = "Snipe";
  readonly description =
    "Buys cheap underdogs priced below 0.30. " +
    "High-risk / high-reward EV play over many trades.";
  readonly config = { name: "snipe", enabled: true, budget: null as number | null };

  private readonly maxEntryPrice = 0.30;
  private readonly minQty = 5;
  private readonly maxQty = 15;

  decide(ctx: MarketContext): Decision | null {
    // Find the cheapest outcome
    const sorted = [...ctx.market.outcomes].sort((a, b) => a.price - b.price);
    const underdog = sorted[0];

    if (underdog.price > this.maxEntryPrice || underdog.price <= 0) {
      return null; // nothing cheap enough, or broken price
    }

    // Cheaper = higher potential payoff, more shares
    const confidence = 1 - underdog.price; // inverse — low price = risky but high upside
    const quantity = Math.round(
      this.minQty + (this.maxEntryPrice - underdog.price) *
        (this.maxQty - this.minQty) / this.maxEntryPrice,
    );

    return {
      side: underdog.label === "No" || underdog.label === "Down"
        ? "NO"
        : "YES",
      confidence,
      reasoning:
        `Snipe: ${underdog.label} at ${underdog.price.toFixed(3)} ` +
        `(underdog, cheap entry)`,
      quantity: Math.max(this.minQty, Math.min(this.maxQty, quantity)),
    };
  }
}
