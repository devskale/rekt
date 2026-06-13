import type {
  Position,
  PositionStatus,
  Side,
  Trade,
  TradeAction,
  StrategyBalance,
  EngineConfig,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────
let _nextId = 1;
function uid(): string {
  return String(_nextId++);
}

function now(): number {
  return Date.now();
}

/**
 * Calculate taker fee using Polymarket formula:
 *   fee = quantity × feeRate × price × (1 - price)
 *
 * Peaks at price=0.50, symmetric, zero at 0 and 1.
 */
function calcFee(
  quantity: number,
  price: number,
  feeRate: number,
): number {
  return quantity * feeRate * price * (1 - price);
}

// ── PaperTrader ─────────────────────────────────────────────────────
export class PaperTrader {
  private config: EngineConfig;
  private positions = new Map<string, Position>();
  private trades: Trade[] = [];
  /** Per-strategy cash ledger. */
  private cash = new Map<string, number>();

  constructor(config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Open a position ─────────────────────────────────────────────
  /**
   * Simulate buying shares of YES or NO at the given price.
   * Cost = (price × quantity) + taker fee.
   */
  openPosition(
    strategy: string,
    marketId: string,
    side: Side,
    price: number,
    quantity: number,
  ): Position {
    const fee = calcFee(quantity, price, this.config.feeConfig.takerFeeRate);
    const cost = price * quantity + fee;
    const balance = this.ensureStrategy(strategy);

    if (cost > balance) {
      throw new Error(
        `Insufficient funds: ${strategy} has $${balance.toFixed(2)}, ` +
          `needs $${cost.toFixed(2)} (incl. $${fee.toFixed(4)} fee)`,
      );
    }

    if (price < 0 || price > 1) {
      throw new Error(`Price must be between 0 and 1, got ${price}`);
    }
    if (quantity <= 0) {
      throw new Error(`Quantity must be positive, got ${quantity}`);
    }

    // Deduct cash (cost + fee)
    this.cash.set(strategy, balance - cost);

    const id = uid();
    const timestamp = now();

    const position: Position = {
      id,
      marketId,
      strategy,
      side,
      entryPrice: price,
      entryFee: fee,
      quantity,
      timestamp,
      status: "open",
    };

    this.positions.set(id, position);
    this.recordTrade(id, "open", price, quantity, strategy, marketId, timestamp);

    return position;
  }

  // ── Close early (sell back at current price) ────────────────────
  /**
   * Close an open position by selling shares back at the given price.
   * Adds price × quantity back to strategy cash.
   */
  closePosition(positionId: string, currentPrice: number): Position {
    const pos = this.getPositionOrThrow(positionId);

    if (pos.status !== "open") {
      throw new Error(`Position ${positionId} is already ${pos.status}`);
    }

    // Sell-side fee (taker)
    const fee = calcFee(pos.quantity, currentPrice, this.config.feeConfig.takerFeeRate);
    const grossProceeds = currentPrice * pos.quantity;
    const proceeds = grossProceeds - fee;

    const balance = this.cash.get(pos.strategy)!;
    this.cash.set(pos.strategy, balance + proceeds);

    const cost = pos.entryPrice * pos.quantity + pos.entryFee;
    const pnl = proceeds - cost;

    pos.status = "resolved";
    pos.result = pnl >= 0 ? "win" : "loss";
    pos.payout = proceeds;

    const timestamp = now();
    this.recordTrade(
      pos.id,
      "close",
      currentPrice,
      pos.quantity,
      pos.strategy,
      pos.marketId,
      timestamp,
    );

    return pos;
  }

  // ── Resolve market (winning outcome) ────────────────────────────
  /**
   * Settle all open positions for a market.
   * winningSide: the outcome that pays $1 per share.
   * The other side pays $0.
   */
  resolveMarket(marketId: string, winningSide: Side): Position[] {
    const openForMarket = [...this.positions.values()].filter(
      (p) => p.marketId === marketId && p.status === "open",
    );

    for (const pos of openForMarket) {
      const won = pos.side === winningSide;
      const payout = won ? pos.quantity : 0; // $1 per winning share, $0 for losing

      const balance = this.cash.get(pos.strategy)!;
      this.cash.set(pos.strategy, balance + payout);

      pos.status = "resolved";
      pos.result = won ? "win" : "loss";
      pos.payout = payout;

      this.recordTrade(
        pos.id,
        "resolve",
        won ? 1 : 0,
        pos.quantity,
        pos.strategy,
        pos.marketId,
      );
    }

    return openForMarket;
  }

  // ── Queries ─────────────────────────────────────────────────────

  getPositions(strategy?: string): Position[] {
    const all = [...this.positions.values()];
    if (strategy) return all.filter((p) => p.strategy === strategy);
    return all;
  }

  getOpenPositions(strategy?: string): Position[] {
    return this.getPositions(strategy).filter((p) => p.status === "open");
  }

  getTradeHistory(strategy?: string): Trade[] {
    if (strategy) return this.trades.filter((t) => t.strategy === strategy);
    return [...this.trades];
  }

  getBalance(strategy: string, currentPrices?: Map<string, number>): StrategyBalance {
    this.ensureStrategy(strategy); // init if needed
    const positions = this.getPositions(strategy);
    const open = positions.filter((p) => p.status === "open");
    const resolved = positions.filter((p) => p.status === "resolved");

    const cash = this.cash.get(strategy) ?? this.config.startingCash;

    // Realised PnL: sum(payout - cost - fees) for resolved positions
    let realizedPnL = 0;
    let totalFeesPaid = 0;
    const winCount = resolved.filter((p) => p.result === "win").length;
    const lossCount = resolved.filter((p) => p.result === "loss").length;

    for (const pos of resolved) {
      const entryCost = pos.entryPrice * pos.quantity;
      const fee = pos.entryFee ?? 0;
      const payout = pos.payout ?? 0;
      realizedPnL += payout - entryCost - fee;
      totalFeesPaid += fee;
    }

    // Unrealised value: estimated value of open positions
    let unrealizedValue = 0;
    let unrealizedPnL = 0;

    for (const pos of open) {
      const entryCost = pos.entryPrice * pos.quantity + (pos.entryFee ?? 0);
      const marketPrice = currentPrices?.get(pos.marketId);
      // Unrealized value should account for what we'd net after selling
      // (sell fee is unknown, so use gross for value, but include entry fee in P&L)
      const currentValue = marketPrice !== undefined
        ? marketPrice * pos.quantity
        : pos.entryPrice * pos.quantity; // fallback to entry price if no market price

      unrealizedValue += currentValue;
      unrealizedPnL += currentValue - entryCost;
    }

    const tradeCount = this.trades.filter((t) => t.strategy === strategy).length;

    return {
      strategyName: strategy,
      cash,
      unrealizedValue,
      realizedPnL,
      unrealizedPnL,
      totalPnL: realizedPnL + unrealizedPnL,
      tradeCount,
      winCount,
      lossCount,
      resolvedCount: resolved.length,
      winRate: resolved.length > 0 ? winCount / resolved.length : 0,
    };
  }

  getSummary(currentPrices?: Map<string, number>): StrategyBalance[] {
    // Collect all strategy names from positions and trades
    const names = new Set<string>();
    for (const pos of this.positions.values()) names.add(pos.strategy);
    for (const t of this.trades) names.add(t.strategy);
    for (const s of this.cash.keys()) names.add(s);

    return [...names].map((name) => this.getBalance(name, currentPrices));
  }

  // ── Internals ───────────────────────────────────────────────────

  private ensureStrategy(strategy: string): number {
    if (!this.cash.has(strategy)) {
      this.cash.set(strategy, this.config.startingCash);
    }
    return this.cash.get(strategy)!;
  }

  private getPositionOrThrow(id: string): Position {
    const pos = this.positions.get(id);
    if (!pos) throw new Error(`Position not found: ${id}`);
    return pos;
  }

  private recordTrade(
    positionId: string,
    action: TradeAction,
    price: number,
    quantity: number,
    strategy: string,
    marketId: string,
    ts?: number,
  ): void {
    this.trades.push({
      id: uid(),
      positionId,
      action,
      price,
      quantity,
      timestamp: ts ?? now(),
      strategy,
      marketId,
    });
  }
}
