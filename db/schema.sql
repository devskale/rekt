-- rektDBfiller — PostgreSQL schema
-- Plain tables (no partitioning). At BTC-only compressed depth this is a
-- small dataset (~2.3M odds rows/year); partitioning earns its keep later.
-- See AGENTS.md "partitioning" discussion.

-- ── markets — one row per 5-min window (dimension) ─────────────────
CREATE TABLE IF NOT EXISTS markets (
  id            TEXT PRIMARY KEY,           -- gamma market id (stable across resolution)
  slug          TEXT UNIQUE NOT NULL,       -- btc-updown-5m-{window_start}
  asset         TEXT NOT NULL,              -- 'btc' | 'eth' | ...
  window_start  BIGINT NOT NULL,            -- unix seconds
  window_end    BIGINT NOT NULL,            -- window_start + 300
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- outcome is NULL until resolved; backfillable later via market id.
  outcome       TEXT,                       -- 'up' | 'down'
  resolved_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_markets_window ON markets (window_start);
CREATE INDEX IF NOT EXISTS idx_markets_asset  ON markets (asset, window_start);

-- ── odds_ticks — per market, per poll (fact) ───────────────────────
CREATE TABLE IF NOT EXISTS odds_ticks (
  ts                 BIGINT NOT NULL,       -- unix ms (capture time)
  market_id          TEXT NOT NULL REFERENCES markets(id),
  seconds_to_close   INTEGER,               -- window_end - now (sec); always > 0 (we skip expired)
  up_price           REAL,                  -- Gamma outcomePrices (metadata; near-frozen ~0.499 — NOT the real price)
  down_price         REAL,
  -- Book-derived CANONICAL price (v2). mid = (best_bid+best_ask)/2. This is the traded price.
  up_mid             REAL,
  down_mid           REAL,
  -- Up token (clobTokenIds[0]) order book
  up_best_bid        REAL,
  up_best_ask        REAL,
  up_spread          REAL,
  up_ask_depth_95    REAL,
  up_ask_depth_99    REAL,
  up_bid_depth_05    REAL,
  up_bid_depth_01    REAL,
  -- Down token (clobTokenIds[1]) order book
  down_best_bid      REAL,
  down_best_ask      REAL,
  down_spread        REAL,
  down_ask_depth_95  REAL,
  down_ask_depth_99  REAL,
  down_bid_depth_05  REAL,
  down_bid_depth_01  REAL,
  PRIMARY KEY (market_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_odds_ts ON odds_ticks (ts);

-- ── spot_ticks — BTC spot price (momentum signal) ──────────────────
CREATE TABLE IF NOT EXISTS spot_ticks (
  ts     BIGINT NOT NULL,                   -- unix ms
  asset  TEXT NOT NULL,                     -- 'btc'
  price  REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'binance',
  PRIMARY KEY (asset, ts)
);
CREATE INDEX IF NOT EXISTS idx_spot_ts ON spot_ticks (ts);

-- ── optional retention safety valve (run nightly via cron) ─────────
-- DELETE FROM odds_ticks WHERE ts < (extract(epoch from now() - interval '90 days') * 1000)::bigint;
-- DELETE FROM spot_ticks  WHERE ts < (extract(epoch from now() - interval '90 days') * 1000)::bigint;
