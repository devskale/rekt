import type { Strategy, MarketContext, Decision, Side } from "./types.js";

/**
 * Coin Flip — pure random baseline / control strategy.
 *
 * Picks YES or NO with 50/50 probability, buys at whatever the current
 * price is. If other strategies can't beat coin flip, they're useless.
 */
export class CoinFlipStrategy implements Strategy {
  readonly name = "Coin Flip";
  readonly description =
    "Random 50/50 baseline. Picks YES or NO by coin flip. " +
    "Control strategy — if you can't beat this, you're not adding value.";
  readonly config = { name: "coin-flip", enabled: true, budget: null as number | null };

  private readonly fixedQuantity = 10;

  /** Injectable RNG for testability. Default = Math.random. */
  private rng: () => number;

  constructor(rng: () => number = Math.random) {
    this.rng = rng;
  }

  decide(ctx: MarketContext): Decision {
    const { market } = ctx;
    const side: Side = this.rng() < 0.5 ? "YES" : "NO";

    // Map YES→outcomes[0], NO→outcomes[1] (generic binary mapping)
    const yesIdx = market.outcomes.findIndex(
      (o) => o.label === "Yes" || o.label === "Up",
    );
    const noIdx = market.outcomes.findIndex(
      (o) => o.label === "No" || o.label === "Down",
    );

    let price: number;
    if (side === "YES") {
      price = yesIdx >= 0 ? market.outcomes[yesIdx].price : (market.outcomes[0]?.price ?? 0.5);
    } else {
      price = noIdx >= 0 ? market.outcomes[noIdx].price : (market.outcomes[1]?.price ?? 0.5);
    }

    return {
      side,
      confidence: 0.50,
      reasoning: `Coin flip: ${side} at ${price.toFixed(3)} (random)`,
      quantity: this.fixedQuantity,
    };
  }
}
