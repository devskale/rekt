import { logger } from "../logger.js";
import { config } from "./config.js";
import { SpotFeed } from "./spot.js";
import { OddsPoller } from "./odds.js";
import { appendRecord } from "./writer.js";
import { PgWriter } from "./pg.js";

// ── rektDBfiller — DEMO data receiver ───────────────────────────────
//
// Captures live Polymarket BTC 5-min up/down odds + Binance BTC spot.
// Dual-writes every record to JSONL (always-on backup) and, when
// PG_ENABLED, to PostgreSQL. PG failure is non-fatal: JSONL keeps
// capturing. Run with: pnpm receiver

const MODULE = "receiver";

const spot = new SpotFeed();
const pollers: OddsPoller[] = [];
let pg: PgWriter | null = null;

let ticksWritten = 0;
let running = true;

function main(): void {
  printBanner();

  // PostgreSQL writer (optional). Lazy init in the background; ingest
  // awaits it. If it can't connect, it self-disables and we continue.
  if (config.pgEnabled) {
    pg = new PgWriter();
    void pg.init();
  }

  // Spot feed → JSONL (+ PG)
  spot.onRecord = (rec) => {
    appendRecord("spot", rec);
    if (pg) void pg.ingestSpot(rec);
  };
  spot.start();

  // Odds pollers (one per configured asset) → JSONL (+ PG)
  for (const asset of config.assets) {
    const poller = new OddsPoller(asset);
    poller.onRecord = (rec) => {
      appendRecord("odds", rec);
      ticksWritten++;
      if (pg) void pg.ingestOdds(rec);
    };
    pollers.push(poller);
    poller.start();
  }

  // Periodic stats summary
  const statsTimer = setInterval(logStats, config.statsIntervalMs);

  // Graceful shutdown: stop feeds, flush + close PG, then exit. The
  // watchdog arms at shutdown start so a hanging pg.close() still exits.
  // (Previously created at startup — that fired process.exit() at ~T+5s
  // and killed the receiver. Do NOT re-introduce that.)
  const armForceExit = () => setTimeout(() => process.exit(0), 5000).unref();
  const shutdown = async (sig: string): Promise<void> => {
    if (!running) return;
    running = false;
    armForceExit();
    logger.info(MODULE, `Received ${sig}, flushing + shutting down...`);
    clearInterval(statsTimer);
    spot.stop();
    for (const p of pollers) p.stop();
    if (pg) await pg.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function logStats(): void {
  const slug =
    pollers
      .map((p) => p.getCurrentSlug())
      .filter((s): s is string => s !== null)
      .join(",") || "—";
  const ws = spot.connected ? "yes" : "no";
  const pgStat = pg
    ? `pgWritten=${pg.totalWritten} pgErrors=${pg.errors} pgConnected=${pg.connected ? "yes" : "no"}`
    : "pg=off";
  logger.info(
    MODULE,
    `stats: ticksWritten=${ticksWritten} wsConnected=${ws} currentMarketSlug=${slug} ${pgStat}`,
  );
}

function printBanner(): void {
  console.log("");
  console.log("  rektDBfiller — DEMO data receiver");
  console.log(`  BTC 5-min odds + spot -> JSONL${config.pgEnabled ? " + PostgreSQL" : " (JSONL only)"}`);
  console.log("");
  logger.info(
    MODULE,
    `config: assets=[${config.assets.join(",")}] pollMs=${config.pollMs} ` +
      `turboMs=${config.turboMs} turboLastSeconds=${config.turboLastSeconds} ` +
      `statsIntervalMs=${config.statsIntervalMs} dataDir=${config.dataDir} ` +
      `pgEnabled=${config.pgEnabled}`,
  );
}

main();
