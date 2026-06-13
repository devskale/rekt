import express from "express";
import type { Request, Response } from "express";
import type { PaperTrader } from "../engine/paper-trader.js";
import type { Runner } from "../runner/runner.js";
import { BtcPriceFeed } from "./btc-price.js";

// ── SSE subscriber management ───────────────────────────────────────
const subscribers = new Set<Response>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subscribers) {
    res.write(payload);
  }
}

function addSSE(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: connected\ndata: {"status":"ok"}\n\n`);
  subscribers.add(res);
  res.on("close", () => subscribers.delete(res));
}

// ── Create server ───────────────────────────────────────────────────

export function createServer(trader: PaperTrader, runner: Runner, btcFeed?: BtcPriceFeed) {
  const app = express();
  app.use(express.json());

  const btc = btcFeed ?? new BtcPriceFeed();

  // Wire runner tick → SSE broadcast
  runner.onTick = (result) => {
    // Cap SSE payload: only last 50 decisions
    const cappedResult = {
      ...result,
      decisions: result.decisions.slice(-50),
    };
    broadcast("tick", {
      state: runner.state,
      strategies: trader.getSummary(),
      result: cappedResult,
    });
  };

  // Wire BTC price → SSE broadcast
  btc.onUpdate = (price, history) => {
    broadcast("btc-price", { price, ts: Date.now(), history });
  };

  // ── REST endpoints ──────────────────────────────────────────────

  /** Runner state (includes P&L history for chart) */
  app.get("/api/state", (_req, res) => {
    res.json(runner.state);
  });

  /** Strategy balances & win rates */
  app.get("/api/strategies", (_req, res) => {
    res.json(trader.getSummary());
  });

  /** Open positions */
  app.get("/api/positions", (req, res) => {
    const strategy = req.query.strategy as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const positions = trader.getOpenPositions(strategy).slice(-limit);
    res.json(positions);
  });

  /** Trade history */
  app.get("/api/history", (req, res) => {
    const strategy = req.query.strategy as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const all = trader.getTradeHistory(strategy);
    // Most recent first, capped at limit
    res.json(all.slice(-limit).reverse());
  });

  /** P&L chart data */
  app.get("/api/pnl", (_req, res) => {
    res.json(runner.state.pnlHistory);
  });

  /** Market name lookup */
  app.get("/api/markets", (_req, res) => {
    const map: Record<string, string> = {};
    for (const [id, m] of runner.knownMarkets) {
      map[id] = m.question;
    }
    res.json(map);
  });

  /** BTC price */
  app.get("/api/btc-price", (_req, res) => {
    res.json({
      current: btc.getPrice(),
      history: btc.getHistory(),
    });
  });

  /** Start the runner */
  app.post("/api/start", (_req, res) => {
    runner.start();
    btc.start();
    res.json({ ok: true, state: runner.state });
  });

  /** Stop the runner */
  app.post("/api/stop", (_req, res) => {
    runner.stop();
    btc.stop();
    res.json({ ok: true, state: runner.state });
  });

  // ── SSE endpoint ────────────────────────────────────────────────

  app.get("/api/stream", (req, res) => {
    addSSE(res);
  });

  return app;
}
