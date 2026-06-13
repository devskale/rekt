import { logger } from "../logger.js";
import { fetchBtc5minMarkets } from "../market-data/index.js";
import type { Market } from "../market-data/index.js";
import { config } from "./config.js";
import { fetchDepth } from "./depth.js";
import type { DepthSummary } from "./depth.js";
import type { OddsRecord } from "./records.js";

// ── Odds polling loop (one per asset) ───────────────────────────────
// Each tick pulls active BTC 5-min up/down markets, reads prices + token
// ids, fetches compressed depth, and emits one record per market. Cadence
// steps to "turbo" (2s) near window close, otherwise 5s.

export type { OddsRecord };

const WINDOW_SECONDS = 300;

export class OddsPoller {
  readonly asset: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private currentSlug: string | null = null;

  /** Total records emitted. */
  ticks = 0;
  /** Fired for each odds record. */
  onRecord?: (rec: OddsRecord) => void;

  constructor(asset: string) {
    this.asset = asset;
  }

  start(): void {
    this.stopped = false;
    logger.info("receiver:odds", `Starting poller for asset="${this.asset}"`);
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("receiver:odds", `Stopped poller for asset="${this.asset}"`);
  }

  getCurrentSlug(): string | null {
    return this.currentSlug;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    let minSecondsToClose: number | null = null;
    try {
      const markets = await this.fetchMarkets();
      const nowSec = Math.floor(Date.now() / 1000);
      for (const market of markets) {
        try {
          const rec = await this.buildRecord(market, nowSec);
          if (!rec) continue;
          this.onRecord?.(rec);
          this.ticks++;
          this.currentSlug = rec.slug;
          if (minSecondsToClose === null || rec.seconds_to_close < minSecondsToClose) {
            minSecondsToClose = rec.seconds_to_close;
          }
        } catch (err) {
          logger.warn("receiver:odds", `Record failed for ${market.slug}`, err);
        }
      }
    } catch (err) {
      logger.warn("receiver:odds", "Tick failed (will retry next cycle)", err);
    }
    this.scheduleNext(minSecondsToClose);
  }

  private async buildRecord(
    market: Market,
    nowSec: number,
  ): Promise<OddsRecord | null> {
    const up = market.outcomes[0];
    const down = market.outcomes[1];
    if (!up || !down) return null;

    const { windowStart, windowEnd } = parseWindow(market.slug, market.endDate);
    const secondsToClose = windowEnd - nowSec;

    // Drop expired / in-settlement markets. Polymarket keeps a market
    // active:true during settlement even after its window ends, which
    // would leak degenerate post-close books and skew the cadence.
    if (secondsToClose <= 0) return null;

    // Fetch BOTH token books (Up + Down) — the scalp buys the FAVOURITE,
    // which flips Up/Down ~half the time, so we need depth on both sides.
    const [upDepth, downDepth] = await Promise.all([
      up.tokenId ? fetchDepth(up.tokenId) : Promise.resolve<DepthSummary | null>(null),
      down.tokenId ? fetchDepth(down.tokenId) : Promise.resolve<DepthSummary | null>(null),
    ]);

    return {
      ts: Date.now(),
      market_id: market.id,
      slug: market.slug,
      asset: this.asset,
      window_start: windowStart,
      window_end: windowEnd,
      seconds_to_close: secondsToClose,
      up_price: up.price,
      down_price: down.price,
      up_best_bid: upDepth?.bestBid ?? null,
      up_best_ask: upDepth?.bestAsk ?? null,
      up_spread: upDepth?.spread ?? null,
      up_ask_depth_95: upDepth?.askDepth95 ?? null,
      up_ask_depth_99: upDepth?.askDepth99 ?? null,
      up_bid_depth_05: upDepth?.bidDepth05 ?? null,
      up_bid_depth_01: upDepth?.bidDepth01 ?? null,
      down_best_bid: downDepth?.bestBid ?? null,
      down_best_ask: downDepth?.bestAsk ?? null,
      down_spread: downDepth?.spread ?? null,
      down_ask_depth_95: downDepth?.askDepth95 ?? null,
      down_ask_depth_99: downDepth?.askDepth99 ?? null,
      down_bid_depth_05: downDepth?.bidDepth05 ?? null,
      down_bid_depth_01: downDepth?.bidDepth01 ?? null,
    };
  }

  /** Asset dispatch. Adding "eth" later = add a fetcher + one branch. */
  private async fetchMarkets(): Promise<Market[]> {
    if (this.asset === "btc") return fetchBtc5minMarkets();
    logger.warn(
      "receiver:odds",
      `Asset "${this.asset}" has no fetcher yet (only "btc" supported). Skipping.`,
    );
    return [];
  }

  private scheduleNext(minSecondsToClose: number | null): void {
    if (this.stopped) return;
    const turbo =
      minSecondsToClose !== null && minSecondsToClose <= config.turboLastSeconds;
    const delay = turbo ? config.turboMs : config.pollMs;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
  }
}

/** Derive 5-min window bounds from the slug (fallback: endDate). */
function parseWindow(
  slug: string,
  endDate: Date,
): { windowStart: number; windowEnd: number } {
  const m = slug.match(/5m-(\d+)$/);
  if (m) {
    const start = Number(m[1]);
    return { windowStart: start, windowEnd: start + WINDOW_SECONDS };
  }
  const end = Math.floor(endDate.getTime() / 1000);
  return { windowStart: end - WINDOW_SECONDS, windowEnd: end };
}
