import "dotenv/config";
import { logger } from "./logger.js";
import { createServer } from "./server/index.js";
import { PaperTrader } from "./engine/paper-trader.js";
import { FEE_CONFIGS } from "./engine/types.js";
import { clearStrategies, registerDefaults } from "./strategies/registry.js";
import { Runner, DemoMarketClient } from "./runner/runner.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS ?? "10000", 10);
const MAX_OPEN_TICKS = parseInt(process.env.MAX_OPEN_TICKS ?? "5", 10);
const BTC_5MIN_ONLY = process.env.BTC_5MIN_ONLY === "true";
const DEMO_MODE = process.env.DEMO_MODE === "true";

// Fee config
const MARKET_CATEGORY = process.env.MARKET_CATEGORY ?? "crypto";
const TAKER_FEE_RATE = process.env.TAKER_FEE_RATE
  ? parseFloat(process.env.TAKER_FEE_RATE)
  : FEE_CONFIGS[MARKET_CATEGORY]?.takerFeeRate ?? 0.07;

// Late Scalp config
const SCALP_ENTRY_PRICE = process.env.SCALP_ENTRY_PRICE
  ? parseFloat(process.env.SCALP_ENTRY_PRICE)
  : 0.95;
const SCALP_WINDOW_SECONDS = process.env.SCALP_WINDOW_SECONDS
  ? parseInt(process.env.SCALP_WINDOW_SECONDS, 10)
  : 35;

// Re-register strategies with tunable config
clearStrategies();
registerDefaults({
  minPrice: SCALP_ENTRY_PRICE,
  actBeforeSec: SCALP_WINDOW_SECONDS,
});

const trader = new PaperTrader({
  startingCash: 1_000,
  feeConfig: {
    takerFeeRate: TAKER_FEE_RATE,
    makerFeeRate: 0, // Polymarket: makers pay no fees
  },
});

const runner = new Runner(
  { pollIntervalMs: POLL_INTERVAL, maxOpenTicks: MAX_OPEN_TICKS, btc5minOnly: BTC_5MIN_ONLY },
  trader,
  DEMO_MODE ? new DemoMarketClient() : undefined,
);

const app = createServer(trader, runner);

app.listen(PORT, () => {
  logger.info("main", "Trading bot starting...");
  if (DEMO_MODE) {
    logger.info("main", "🎮 Demo mode active — fake markets, no real API calls");
  }
  if (BTC_5MIN_ONLY && !DEMO_MODE) {
    logger.info("main", "₿  BTC 5-min mode — targeting live up/down markets");
  }
  logger.info("main", `Server:    http://localhost:${PORT}`);
  logger.info("main", `Poll:      every ${POLL_INTERVAL / 1000}s`);
  logger.info("main", `Markets:   ${BTC_5MIN_ONLY ? "BTC 5-min only" : DEMO_MODE ? "demo" : "all tradeable"}`);
  logger.info("main", "Endpoints: /api/state /api/strategies /api/positions /api/history /api/stream /api/start /api/stop");
});
