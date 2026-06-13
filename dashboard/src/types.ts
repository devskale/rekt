export interface PnlSnapshot {
  tick: number;
  ts: number;
  strategies: {
    name: string;
    cash: number;
    realizedPnL: number;
    unrealizedPnL: number;
    totalPnL: number;
  }[];
}

export interface RunnerState {
  running: boolean;
  lastPollAt: number | null;
  marketsChecked: number;
  tradesPlaced: number;
  errors: number;
  tickCount: number;
  pnlHistory: PnlSnapshot[];
  dataSource: "btc-5min" | "fallback-markets" | "demo" | "none";
  dataSourceDetail: string;
}

export interface StrategyBalance {
  strategyName: string;
  cash: number;
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

export interface Position {
  id: string;
  marketId: string;
  strategy: string;
  side: "YES" | "NO";
  entryPrice: number;
  quantity: number;
  timestamp: number;
  status: "open" | "resolved";
  result?: "win" | "loss";
  payout?: number;
}

export interface Trade {
  id: string;
  positionId: string;
  action: "open" | "close" | "resolve";
  price: number;
  quantity: number;
  timestamp: number;
  strategy: string;
  marketId: string;
  side?: string;
}

export interface TickResult {
  marketsFetched: number;
  decisions: TickAction[];
  resolutions: { marketId: string; winningSide: string; positionsResolved: number }[];
  errors: string[];
}

export interface TickAction {
  strategy: string;
  marketId: string;
  side: string;
  price: number;
  quantity: number;
  reasoning: string;
}

export interface SSEData {
  state: RunnerState;
  strategies: StrategyBalance[];
  result: TickResult;
}
