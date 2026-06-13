import { logger } from "../logger.js";
import { config } from "./config.js";
import { SpotFeed } from "./spot.js";
import { OddsPoller } from "./odds.js";
import { appendRecord } from "./writer.js";

// ── rektDBfiller — DEMO data receiver ───────────────────────────────
//
// Captures live Polymarket BTC 5-min up/down odds + Binance BTC spot and
// caches them to disk as JSONL (no database). Modular + robust: every
// external call is guarded, the WS auto-reconnects, and the loop never
// crashes. Run with: pnpm receiver

const MODULE = "receiver";

const spot = new SpotFeed();
const pollers: OddsPoller[] = [];

let ticksWritten = 0;
let running = true;

function main(): void {
  printBanner();

  // Spot feed → spot JSONL
  spot.onRecord = (rec) => appendRecord("spot", rec);
  spot.start();

  // Odds pollers (one per configured asset) → odds JSONL
  for (const asset of config.assets) {
    const poller = new OddsPoller(asset);
    poller.onRecord = (rec) => {
      appendRecord("odds", rec);
      ticksWritten++;
    };
    pollers.push(poller);
    poller.start();
  }

  // Periodic stats summary
  const statsTimer = setInterval(logStats, config.statsIntervalMs);

  // Graceful shutdown
  const shutdown = (sig: string): void => {
    if (!running) return;
    running = false;
    logger.info(MODULE, `Received ${sig}, flushing + shutting down...`);
    clearInterval(statsTimer);
    spot.stop();
    for (const p of pollers) p.stop();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function logStats(): void {
  const slug =
    pollers
      .map((p) => p.getCurrentSlug())
      .filter((s): s is string => s !== null)
      .join(",") || "—";
  const ws = spot.connected ? "yes" : "no";
  logger.info(
    MODULE,
    `stats: ticksWritten=${ticksWritten} wsConnected=${ws} currentMarketSlug=${slug}`,
  );
}

function printBanner(): void {
  console.log("");
  console.log("  rektDBfiller — DEMO data receiver");
  console.log("  BTC 5-min odds + spot -> JSONL cache (no DB)");
  console.log("");
  logger.info(
    MODULE,
    `config: assets=[${config.assets.join(",")}] pollMs=${config.pollMs} ` +
      `turboMs=${config.turboMs} turboLastSeconds=${config.turboLastSeconds} ` +
      `statsIntervalMs=${config.statsIntervalMs} dataDir=${config.dataDir}`,
  );
}

main();
