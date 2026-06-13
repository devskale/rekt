// ── JSONL record schemas (the data contract) ───────────────────────
//
// Central definition of every record written to disk. The receiver exists
// to validate these shapes before we commit to a real schema, so keeping
// them in one reviewable place is the point.

/** One line in data/odds/{YYYY-MM-DD}.jsonl — per market, per tick. */
export interface OddsRecord {
  ts: number;
  market_id: string;
  slug: string;
  asset: string;
  window_start: number;
  window_end: number;
  seconds_to_close: number;
  up_price: number;
  down_price: number;
  // Up token (clobTokenIds[0]) order book.
  up_best_bid: number | null;
  up_best_ask: number | null;
  up_spread: number | null;
  up_ask_depth_95: number | null;
  up_ask_depth_99: number | null;
  up_bid_depth_05: number | null;
  up_bid_depth_01: number | null;
  // Down token (clobTokenIds[1]) order book.
  down_best_bid: number | null;
  down_best_ask: number | null;
  down_spread: number | null;
  down_ask_depth_95: number | null;
  down_ask_depth_99: number | null;
  down_bid_depth_05: number | null;
  down_bid_depth_01: number | null;
}

/** One line in data/spot/{YYYY-MM-DD}.jsonl — throttled BTC spot ticks. */
export interface SpotRecord {
  ts: number;
  asset: "btc";
  price: number;
  source: "binance";
}
