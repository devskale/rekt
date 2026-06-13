import { describe, it, expect, beforeEach } from "vitest";
import { PaperTrader } from "./paper-trader.js";
import type { Position, StrategyBalance } from "./types.js";

// Helper: fee = qty × 0.07 × price × (1 - price)
function fee(qty: number, price: number): number {
  return qty * 0.07 * price * (1 - price);
}

describe("PaperTrader", () => {
  let trader: PaperTrader;

  beforeEach(() => {
    trader = new PaperTrader({ startingCash: 1_000 });
  });

  // ── Open position ──────────────────────────────────────────────

  describe("openPosition", () => {
    it("opens a position and deducts cash + fee", () => {
      const pos = trader.openPosition("strat-a", "market-1", "YES", 0.60, 100);

      expect(pos.id).toBeTruthy();
      expect(pos.marketId).toBe("market-1");
      expect(pos.strategy).toBe("strat-a");
      expect(pos.side).toBe("YES");
      expect(pos.entryPrice).toBe(0.60);
      expect(pos.quantity).toBe(100);
      expect(pos.status).toBe("open");

      // Fee = 100 × 0.07 × 0.60 × 0.40 = 1.68
      expect(pos.entryFee).toBeCloseTo(1.68, 4);

      // Cost = 60 + 1.68 = 61.68 → cash = 1000 - 61.68 = 938.32
      const bal = trader.getBalance("strat-a");
      expect(bal.cash).toBeCloseTo(938.32, 2);
    });

    it("rejects if insufficient funds (including fee)", () => {
      // $1000 budget, 3000 shares at $0.50 costs $1500 + fee
      expect(() =>
        trader.openPosition("strat-a", "m1", "YES", 0.50, 3000),
      ).toThrow(/Insufficient funds/);
    });

    it("rejects invalid price", () => {
      expect(() =>
        trader.openPosition("strat-a", "m1", "YES", -0.1, 10),
      ).toThrow(/between 0 and 1/);
      expect(() =>
        trader.openPosition("strat-a", "m1", "YES", 1.5, 10),
      ).toThrow(/between 0 and 1/);
    });

    it("rejects zero quantity", () => {
      expect(() =>
        trader.openPosition("strat-a", "m1", "YES", 0.50, 0),
      ).toThrow(/positive/);
    });

    it("tracks multiple positions per strategy", () => {
      trader.openPosition("strat-a", "m1", "YES", 0.50, 100);
      trader.openPosition("strat-a", "m2", "NO", 0.30, 50);

      const positions = trader.getPositions("strat-a");
      expect(positions).toHaveLength(2);

      // 100×0.50 + fee(100,0.50)=1.75 + 50×0.30 + fee(50,0.30)=0.735
      // = 50 + 1.75 + 15 + 0.735 = 67.485 → cash = 932.515
      const bal = trader.getBalance("strat-a");
      expect(bal.cash).toBeCloseTo(1000 - 50 - fee(100, 0.50) - 15 - fee(50, 0.30), 2);
    });

    it("isolates strategies", () => {
      trader.openPosition("strat-a", "m1", "YES", 0.60, 100);
      trader.openPosition("strat-b", "m1", "NO", 0.40, 100);

      const balA = trader.getBalance("strat-a");
      const balB = trader.getBalance("strat-b");

      expect(balA.cash).toBeCloseTo(1000 - 60 - fee(100, 0.60), 2);
      expect(balB.cash).toBeCloseTo(1000 - 40 - fee(100, 0.40), 2);
    });

    it("peaks fee at price=0.50", () => {
      // fee at 0.50 should be larger than at 0.30 or 0.70
      const pos50 = trader.openPosition("s1", "m1", "YES", 0.50, 100);
      const pos30 = trader.openPosition("s2", "m2", "YES", 0.30, 100);
      const pos70 = trader.openPosition("s3", "m3", "YES", 0.70, 100);

      expect(pos50.entryFee).toBeGreaterThan(pos30.entryFee);
      expect(pos50.entryFee).toBeGreaterThan(pos70.entryFee);
      // fee at 0.30 and 0.70 are symmetric
      expect(pos30.entryFee).toBeCloseTo(pos70.entryFee, 6);
    });

    it("low fee near price extremes", () => {
      const pos95 = trader.openPosition("s1", "m1", "YES", 0.95, 100);
      // fee = 100 × 0.07 × 0.95 × 0.05 = 0.3325
      expect(pos95.entryFee).toBeCloseTo(0.3325, 4);
    });
  });

  // ── Resolve market ─────────────────────────────────────────────

  describe("resolveMarket", () => {
    it("pays $1/share for winning side, $0 for losing side (with fee impact)", () => {
      const posYes = trader.openPosition("strat-a", "m1", "YES", 0.60, 100);
      const posNo = trader.openPosition("strat-b", "m1", "NO", 0.40, 100);

      const resolved = trader.resolveMarket("m1", "YES");

      // YES wins: pays $1 × 100 = $100
      const yesPos = trader.getPositions("strat-a").find((p) => p.id === posYes.id)!;
      expect(yesPos.status).toBe("resolved");
      expect(yesPos.result).toBe("win");
      expect(yesPos.payout).toBe(100);

      // P&L = payout - entryCost - fee = 100 - 60 - 1.68 = 38.32
      const balA = trader.getBalance("strat-a");
      expect(balA.realizedPnL).toBeCloseTo(100 - 60 - fee(100, 0.60), 2);

      // NO loses: pays $0
      const noPos = trader.getPositions("strat-b").find((p) => p.id === posNo.id)!;
      expect(noPos.status).toBe("resolved");
      expect(noPos.result).toBe("loss");
      expect(noPos.payout).toBe(0);

      // P&L = 0 - 40 - fee = -40 - fee
      const balB = trader.getBalance("strat-b");
      expect(balB.realizedPnL).toBeCloseTo(-40 - fee(100, 0.40), 2);
    });

    it("resolves multiple positions on same market across strategies", () => {
      trader.openPosition("strat-a", "m1", "YES", 0.50, 200);
      trader.openPosition("strat-b", "m1", "YES", 0.50, 100);
      trader.openPosition("strat-a", "m1", "NO", 0.50, 50);

      const resolved = trader.resolveMarket("m1", "YES");
      expect(resolved).toHaveLength(3);

      const balA = trader.getBalance("strat-a");
      const fee200 = fee(200, 0.50);
      const fee50 = fee(50, 0.50);
      // strat-a: cash = 1000 - 100 - fee200 - 25 - fee50
      // YES wins: +200 payout, NO loses: +0
      // realizedPnL = (200 - 100 - fee200) + (0 - 25 - fee50)
      expect(balA.realizedPnL).toBeCloseTo(75 - fee200 - fee50, 2);
    });

    it("does nothing if no open positions for market", () => {
      const resolved = trader.resolveMarket("nonexistent", "YES");
      expect(resolved).toHaveLength(0);
    });
  });

  // ── Close position early ───────────────────────────────────────

  describe("closePosition", () => {
    it("closes at current price minus sell fee", () => {
      const pos = trader.openPosition("strat-a", "m1", "YES", 0.40, 100);
      // Cash: 1000 - 40 - fee(100,0.40) = 1000 - 40 - 1.68 = 958.32

      const closed = trader.closePosition(pos.id, 0.60);
      // Sell proceeds = 60 - fee(100, 0.60) = 60 - 1.68 = 58.32
      // Cash: 958.32 + 58.32 = 1016.64

      expect(closed.status).toBe("resolved");
      expect(closed.payout).toBeCloseTo(60 - fee(100, 0.60), 2);

      const bal = trader.getBalance("strat-a");
      expect(bal.cash).toBeCloseTo(958.32 + 58.32, 2);
      expect(bal.realizedPnL).toBeCloseTo(closed.payout! - 40 - fee(100, 0.40), 2);
      expect(bal.winCount).toBe(1);
    });

    it("records a loss when closing below entry", () => {
      const pos = trader.openPosition("strat-a", "m1", "YES", 0.80, 100);
      // Cash: 1000 - 80 - fee(100,0.80) = 1000 - 80 - 1.12 = 918.88

      trader.closePosition(pos.id, 0.30);
      // Sell proceeds = 30 - fee(100, 0.30) = 30 - 1.47 = 28.53
      // Cash: 918.88 + 28.53 = 947.41

      const bal = trader.getBalance("strat-a");
      expect(bal.cash).toBeCloseTo(947.41, 2);
      expect(bal.realizedPnL).toBeCloseTo(-80 - fee(100, 0.80) + 30 - fee(100, 0.30), 2);
      expect(bal.lossCount).toBe(1);
    });

    it("rejects closing already resolved position", () => {
      const pos = trader.openPosition("strat-a", "m1", "YES", 0.50, 10);
      trader.resolveMarket("m1", "YES");

      expect(() => trader.closePosition(pos.id, 0.50)).toThrow(/already resolved/);
    });
  });

  // ── Balance and win rate ────────────────────────────────────────

  describe("getBalance", () => {
    it("calculates win rate correctly", () => {
      // 3 trades, 2 wins, 1 loss → 66.67%
      trader.openPosition("strat-a", "m1", "YES", 0.50, 10);
      trader.openPosition("strat-a", "m2", "YES", 0.50, 10);
      trader.openPosition("strat-a", "m3", "YES", 0.50, 10);

      trader.resolveMarket("m1", "YES"); // win
      trader.resolveMarket("m2", "NO");  // loss
      trader.resolveMarket("m3", "YES"); // win

      const bal = trader.getBalance("strat-a");
      expect(bal.resolvedCount).toBe(3);
      expect(bal.winCount).toBe(2);
      expect(bal.lossCount).toBe(1);
      expect(bal.winRate).toBeCloseTo(2 / 3, 4);
    });

    it("tracks unrealized PnL with current prices (including entry fee)", () => {
      trader.openPosition("strat-a", "m1", "YES", 0.40, 100);
      // Cash: 1000 - 40 - fee(100,0.40) = 958.32

      const currentPrices = new Map<string, number>();
      currentPrices.set("m1", 0.60);

      const bal = trader.getBalance("strat-a", currentPrices);
      expect(bal.unrealizedValue).toBeCloseTo(60, 2); // 0.60 × 100
      // unrealized P&L = marketValue - (entryCost + fee)
      expect(bal.unrealizedPnL).toBeCloseTo(60 - 40 - fee(100, 0.40), 2);
      expect(bal.totalPnL).toBeCloseTo(60 - 40 - fee(100, 0.40), 2);
    });

    it("falls back to entry price when no current price given (fee still counted)", () => {
      trader.openPosition("strat-a", "m1", "YES", 0.50, 100);

      const bal = trader.getBalance("strat-a");
      expect(bal.unrealizedValue).toBeCloseTo(50, 2); // entry price × qty
      // P&L = 50 - (50 + fee) = -fee
      expect(bal.unrealizedPnL).toBeCloseTo(-fee(100, 0.50), 2);
    });

    it("returns default balance for unknown strategy", () => {
      const bal = trader.getBalance("new-strat");
      expect(bal.cash).toBeCloseTo(1_000, 2);
      expect(bal.winRate).toBe(0);
    });
  });

  // ── Trade history ───────────────────────────────────────────────

  describe("getTradeHistory", () => {
    it("records open and resolve trades", () => {
      trader.openPosition("strat-a", "m1", "YES", 0.50, 100);
      trader.resolveMarket("m1", "YES");

      const history = trader.getTradeHistory("strat-a");
      expect(history).toHaveLength(2);
      expect(history[0].action).toBe("open");
      expect(history[0].price).toBe(0.50);
      expect(history[1].action).toBe("resolve");
      expect(history[1].price).toBe(1); // winning
    });

    it("filters by strategy", () => {
      trader.openPosition("strat-a", "m1", "YES", 0.50, 10);
      trader.openPosition("strat-b", "m2", "NO", 0.40, 10);

      expect(trader.getTradeHistory("strat-a")).toHaveLength(1);
      expect(trader.getTradeHistory("strat-b")).toHaveLength(1);
      expect(trader.getTradeHistory()).toHaveLength(2);
    });
  });

  // ── Full scenario ──────────────────────────────────────────────

  describe("full trading scenario", () => {
    it("simulates a realistic trading session with fees", () => {
      // Strategy A: Buy YES on 3 markets
      const p1 = trader.openPosition("alpha", "btc-1", "YES", 0.55, 200);
      const p2 = trader.openPosition("alpha", "btc-2", "YES", 0.45, 100);
      const p3 = trader.openPosition("alpha", "btc-3", "NO",  0.60, 150);

      // Cost = (110 + fee(200,0.55)) + (45 + fee(100,0.45)) + (90 + fee(150,0.60))
      const cost1 = 110 + fee(200, 0.55);
      const cost2 = 45 + fee(100, 0.45);
      const cost3 = 90 + fee(150, 0.60);
      const totalCost = cost1 + cost2 + cost3;

      let bal = trader.getBalance("alpha");
      expect(bal.cash).toBeCloseTo(1000 - totalCost, 2);

      // Market 1 resolves YES → WIN
      trader.resolveMarket("btc-1", "YES");
      // Payout: $1 × 200 = $200, PnL = 200 - 110 - fee1

      // Market 2 resolves NO → LOSS
      trader.resolveMarket("btc-2", "NO");
      // Payout: $0, loss = 0 - 45 - fee2

      // Market 3 resolves NO → WIN (we bought NO at 0.60)
      trader.resolveMarket("btc-3", "NO");
      // Payout: $1 × 150 = $150, PnL = 150 - 90 - fee3

      bal = trader.getBalance("alpha");
      const expectedPnL = (200 - cost1) + (0 - cost2) + (150 - cost3);
      expect(bal.cash).toBeCloseTo(1000 - totalCost + 200 + 0 + 150, 2);
      expect(bal.realizedPnL).toBeCloseTo(expectedPnL, 2);
      expect(bal.winCount).toBe(2);
      expect(bal.lossCount).toBe(1);
      expect(bal.winRate).toBeCloseTo(2 / 3, 4);
      expect(bal.resolvedCount).toBe(3);
      expect(bal.unrealizedValue).toBe(0);
      expect(bal.totalPnL).toBeCloseTo(expectedPnL, 2);
    });
  });
});
