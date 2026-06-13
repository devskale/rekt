# rekt — Polymarket BTC/ETH 5-min data receiver + paper trading

A read-only system for capturing live Polymarket up/down market data, then
backtesting strategies against it. **No real money, no wallet, no trading.**
Real market data → simulated trades → see what would have worked.

> Status: **data receiver works (disk cache)** · backtest engine TBD · live execution out of scope.

---

## Two parts

```
┌─────────────────────────────────────────────────────────────┐
│  1. rektDBfiller  (src/receiver/)  ← data capture           │
│     Polymarket odds + compressed depth + BTC spot → JSONL   │
│     Read-only. No auth. Runs on a Pi5.                      │
└─────────────────────────────────────────────────────────────┘
                          │ accumulates
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  2. Paper-trading core  (src/{engine,strategies,runner,…})  │
│     Strategy interface + PaperTrader (Polymarket fee model) │
│     Already runs live paper trades. Backtest = reusing this │
│     against stored data.                                    │
└─────────────────────────────────────────────────────────────┘
```

The receiver exists to bank a dataset we can tune strategies against. The
paper-trading core already has the engine; the backtest will reuse it with a
DB-replaying market client.

---

## Quick start

```bash
pnpm install

# --- Data receiver (rektDBfiller) ---
pnpm receiver            # captures → ./data/{odds,spot}/YYYY-MM-DD.jsonl
                         # env: ASSETS, POLL_MS, TURBO_MS, DATA_DIR (see .env.example)

# --- Paper-trading harness (the original bot) ---
pnpm dev                 # backend on :3000 (reads live markets, simulates trades)
cd dashboard && pnpm dev # dashboard on :5173

# --- Checks ---
pnpm test                # vitest
pnpm build               # tsc --noEmit
```

`.env` is gitignored. Copy `.env.example` → `.env` to configure poll interval,
market category (fee rate), and scalp params.

---

## What the receiver captures

Two JSONL streams, one line per record, daily-rotating files:

**`data/odds/YYYY-MM-DD.jsonl`** — per market, per tick:
```json
{ "ts", "market_id", "slug", "asset", "window_start", "window_end",
  "seconds_to_close", "up_price", "down_price",
  "up_best_bid", "up_best_ask", "up_spread", "up_ask_depth_95", "up_ask_depth_99",
  "up_bid_depth_05", "up_bid_depth_01",
  "down_best_bid", "down_best_ask", "down_spread", "down_ask_depth_95",
  "down_ask_depth_99", "down_bid_depth_05", "down_bid_depth_01" }
```

**`data/spot/YYYY-MM-DD.jsonl`** — BTC spot (throttled ~1/sec):
```json
{ "ts", "asset": "btc", "price", "source": "binance" }
```

### Why "compressed" depth (not full L2)

A full order book is ~20 levels. For scalp tuning we only need depth at the
prices that matter: `ask_depth_95`/`99` (the favourite / scalp zone) and
`bid_depth_01`/`05` (the settlement-snipe zone). Six numbers per token instead
of 40 — ~4× smaller, and it answers the real question: *can I actually fill N
shares at this price?* See `src/receiver/depth.ts`.

### Why BTC **spot** is a co-equal stream

The market resolves on **whether the underlying price went up or down** — that
signal lives in BTC spot, not in the odds. The odds are just the entry price.
The momentum edge ("3–4 green minutes → bet with it") is a rule on the *spot*
series. So we capture both.

---

## Architecture

| Module | Purpose |
|---|---|
| `src/receiver/` | **rektDBfiller** — odds poller + depth fetcher + spot WS + JSONL writer |
| `src/market-data/` | Polymarket Gamma client (Zod-validated). `fetchBtc5minMarkets()` computes window timestamps from slug `btc-updown-5m-{unix}` |
| `src/engine/` | `PaperTrader` — open/close/resolve positions, per-strategy cash ledger, Polymarket fee math |
| `src/strategies/` | `Strategy` interface + 4 implementations (late-scalp, snipe, coin-flip, momentum) |
| `src/runner/` | Poll → evaluate → settle loop against live markets |
| `src/server/` + `dashboard/` | Express + SSE backend, React/Vite Bloomberg-style dashboard |

See [`SPECS.md`](./SPECS.md) (build spec) and [`RESEARCH_NOTES.md`](./RESEARCH_NOTES.md)
(strategy analysis: directional vs market-making, the $80K/mo oracle-frontrun,
the 96% 4-minute momentum edge) for the why behind all of this.

---

## Key things this repo already got right (and wrong, then fixed)

- **`active && !closed` is NOT "tradeable".** Polymarket keeps a market `active:true`
  through settlement. The post-close book fills with worthless stale 1¢ orders.
  **Real cutoff: `now < window_end`.** Enforced in `src/receiver/odds.ts`.
- **Capture depth for BOTH tokens.** The scalp buys the *favourite*, which flips
  Up/Down ~half the time. Up-only depth blinds us to half the setups.
- **Fee model matches Polymarket exactly:** `fee = qty × rate × price × (1 − price)`
  (peaks at 0.50, zero at 0/1). See `src/engine/paper-trader.ts`.
- **Latency doesn't matter for the scalp** — but fill realism (depth) does.

---

## Strategy reality check

This repo's research notes are blunt: the **directional** strategies (scalp,
momentum) are educational; the real money in 5-min markets is **market-making
and arbitrage** (both-sides quoting, settlement snipe, oracle frontrun). Those
need full order-book depth + the Chainlink oracle feed, and backtesting them
honestly is harder (they're latency races, not just probability bets).

The immediate goal: bank data, then tune the **late-window scalp** params
(entry cap, timing window, size) and reproduce the documented **4-minute
momentum edge** to see if it survived the last few months.

---

## Safety

- **Read-only by design.** The receiver needs no Polymarket credentials — all
  public read endpoints return 200 without auth.
- **No secrets in the repo.** `creds/`, `.env`, `data/`, and `tempis/` are
  gitignored. Trading credentials (when/if added) live outside the repo.
- **Paper trading only.** No wallet, no on-chain calls, no real money.

## License

Private project. See repo settings.
