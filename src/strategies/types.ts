import type { Market } from "../market-data/types.js";

// ── Core types ──────────────────────────────────────────────────────

export type Side = "YES" | "NO";

export interface Decision {
  side: Side;
  /** 0–1 how confident the strategy is */
  confidence: number;
  /** Human-readable explanation of why */
  reasoning: string;
  /** Suggested position size in shares */
  quantity: number;
}

export interface PricePoint {
  price: number;
  timestamp: number;
}

export interface MarketContext {
  market: Market;
  /** Historical prices for the market's YES outcome, newest last */
  recentPrices: PricePoint[];
  /** Fraction of the window remaining (0 = closing now, 1 = just opened) */
  timeRemainingFraction: number;
  /** Seconds until market closes */
  secondsToClose: number;
  /** Set of market IDs this strategy already has an open position on */
  openPositionMarketIds: Set<string>;
}

export interface StrategyConfig {
  name: string;
  enabled: boolean;
  /** Max budget this strategy can deploy (null = unlimited) */
  budget: number | null;
}

// ── Strategy interface ──────────────────────────────────────────────

export interface Strategy {
  readonly name: string;
  readonly description: string;
  readonly config: StrategyConfig;

  /**
   * Evaluate a market and optionally return a trade decision.
   * Return `null` to pass (no trade).
   */
  decide(ctx: MarketContext): Decision | null;
}
