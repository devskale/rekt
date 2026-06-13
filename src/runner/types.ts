import type { Side } from "../engine/types.js";

// ── Config ──────────────────────────────────────────────────────────

export interface RunnerConfig {
  /** Milliseconds between polls. Default: 30_000 */
  pollIntervalMs: number;
  /** Strategy config names to enable. null = all registered. */
  enabledStrategies: string[] | null;
  /** Starting cash per strategy in the paper trader. Default: 1_000 */
  startingBalance: number;
  /** How many ticks a market stays open before forced resolution. Default: 5 */
  maxOpenTicks: number;
  /** Focus on BTC 5-min up/down markets only. Default: false */
  btc5minOnly: boolean;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  pollIntervalMs: 30_000,
  enabledStrategies: null,
  startingBalance: 1_000,
  maxOpenTicks: 5,
  btc5minOnly: false,
};

// ── State ───────────────────────────────────────────────────────────

export interface RunnerState {
  running: boolean;
  lastPollAt: number | null;
  marketsChecked: number;
  tradesPlaced: number;
  errors: number;
  tickCount: number;
  /** P&L snapshots per strategy, one per tick. */
  pnlHistory: PnlSnapshot[];
  /** What market data source is currently active. */
  dataSource: "btc-5min" | "fallback-markets" | "demo" | "none";
  dataSourceDetail: string;
}

export interface PnlSnapshot {
  tick: number;
  ts: number;
  strategies: { name: string; cash: number; realizedPnL: number; unrealizedPnL: number; totalPnL: number }[];
}

export function initialRunnerState(): RunnerState {
  return {
    running: false,
    lastPollAt: null,
    marketsChecked: 0,
    tradesPlaced: 0,
    errors: 0,
    tickCount: 0,
    pnlHistory: [],
    dataSource: "none",
    dataSourceDetail: "",
  };
}

// ── Tick result ─────────────────────────────────────────────────────

export interface TickAction {
  strategy: string;
  marketId: string;
  side: Side;
  price: number;
  quantity: number;
  reasoning: string;
}

export interface TickResult {
  marketsFetched: number;
  decisions: TickAction[];
  resolutions: { marketId: string; winningSide: Side; positionsResolved: number }[];
  errors: string[];
}

// ── Market data client interface (for DI / testing) ─────────────────

import type { Market } from "../market-data/types.js";

export interface MarketClient {
  fetchActiveMarkets(): Promise<MarketFetchResult>;
}

export interface MarketFetchResult {
  markets: Market[];
  source: "btc-5min" | "fallback-markets" | "demo" | "none";
  detail: string;
}
