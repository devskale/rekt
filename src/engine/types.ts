/**
 * Paper trading engine types.
 *
 * Convention:
 *   - `side` is always "YES" or "NO" — the outcome the position backs.
 *   - Prices are in the 0–1 range (implied probability).
 *   - Payoff: winning share → $1.00, losing share → $0.00.
 */

export type Side = "YES" | "NO";
export type PositionStatus = "open" | "resolved";

export interface Position {
  id: string;
  marketId: string;
  strategy: string;
  side: Side;
  entryPrice: number;
  /** Fee paid when opening the position. */
  entryFee: number;
  quantity: number;
  timestamp: number;
  status: PositionStatus;
  /** Populated once resolved */
  result?: "win" | "loss";
  /** Dollar payout once resolved ($1 × qty if win, $0 if loss) */
  payout?: number;
}

export type TradeAction = "open" | "close" | "resolve";

export interface Trade {
  id: string;
  positionId: string;
  action: TradeAction;
  price: number;
  quantity: number;
  timestamp: number;
  strategy: string;
  marketId: string;
}

export interface StrategyBalance {
  strategyName: string;
  cash: number;
  /** Unrealised value of open positions (valued at entry cost) */
  unrealizedValue: number;
  realizedPnL: number;
  unrealizedPnL: number;
  totalPnL: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  resolvedCount: number;
  winRate: number;
}

export interface FeeConfig {
  /** Taker fee rate (Polymarket default: 0.07 for crypto). */
  takerFeeRate: number;
  /** Maker fee rate (always 0 on Polymarket). */
  makerFeeRate: number;
}

/** Fee configs by market category (from Polymarket docs). */
export const FEE_CONFIGS: Record<string, FeeConfig> = {
  crypto:   { takerFeeRate: 0.07, makerFeeRate: 0 },
  sports:   { takerFeeRate: 0.03, makerFeeRate: 0 },
  finance:  { takerFeeRate: 0.04, makerFeeRate: 0 },
  politics: { takerFeeRate: 0.04, makerFeeRate: 0 },
  other:    { takerFeeRate: 0.05, makerFeeRate: 0 },
};

export const DEFAULT_FEE_CONFIG: FeeConfig = FEE_CONFIGS.crypto;

export interface EngineConfig {
  /** Starting cash per strategy. Defaults to $1,000. */
  startingCash: number;
  /** Fee configuration. Defaults to crypto rates. */
  feeConfig: FeeConfig;
}

export const DEFAULT_CONFIG: EngineConfig = {
  startingCash: 1_000,
  feeConfig: DEFAULT_FEE_CONFIG,
};
