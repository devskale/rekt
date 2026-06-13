# Agentic Trading Bot — Build Spec

> Living document. Starts loose, details filled in as we build.

---

## Goal

**A paper-trading dashboard that runs multiple strategies against live Polymarket data and shows which ones actually make money.**

No real money. No wallet. No blockchain. Just real market data → simulated trades → visual results.

When we can see a strategy consistently beating random on paper, we'll know what to take live.

---

## Sub-steps

### 1. Project scaffold
- Init Node.js + TypeScript project
- Add deps (express, etc.)
- Folder structure

### 2. Market data
- Figure out Polymarket Gamma API
- Fetch live BTC 5-min up/down markets
- Parse: market ID, side (YES/NO), current price, window open/close times

### 3. Paper trading engine
- Simulate buys against real order book prices
- Track open positions per strategy
- Resolve positions when market closes (pay $1 if right, $0 if wrong)
- Track: P&L, win rate, trade history

### 4. Strategies
- Define a strategy interface
- Implement 3–4 strategies (late scalp, snipe, coin flip baseline, one more)

### 5. Runner loop
- Poll markets on a timer
- Run all strategies against current data
- Feed decisions to paper trader
- Emit state changes

### 6. Server + API
- Express server
- SSE endpoint for real-time dashboard updates
- REST endpoints for current state (balances, positions, history)

### 7. Dashboard
- React + Vite app
- Total pot per strategy
- P&L chart over time
- Trade log (scrolling)
- Live market status (current window, countdown)

### 8. Iterate
- Tune strategies based on paper results
- Add more markets / strategies
- Prep for live trading (wallet, real execution)
