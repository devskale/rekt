import { PaperTrader } from "../engine/paper-trader.js";
import type { Side } from "../engine/types.js";
import type { Market } from "../market-data/types.js";
import type { Strategy, MarketContext, Decision } from "../strategies/types.js";
import { getEnabledStrategies, getStrategy } from "../strategies/registry.js";
import { logger } from "../logger.js";
import {
  DEFAULT_RUNNER_CONFIG,
  initialRunnerState,
} from "./types.js";
import type {
  RunnerConfig,
  RunnerState,
  MarketClient,
  TickAction,
  TickResult,
} from "./types.js";

// ── Runner ──────────────────────────────────────────────────────────

export class Runner {
  readonly config: RunnerConfig;
  readonly trader: PaperTrader;
  readonly marketClient: MarketClient;

  state: RunnerState;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Known markets (for name lookup). */
  readonly knownMarkets = new Map<string, Market>();
  /** Track which markets we've seen as open, so we can detect resolution. */
  private knownOpenMarkets = new Map<string, Market>();
  /** Tick number when each market first appeared. */
  private marketFirstSeen = new Map<string, number>();

  /** Optional callback fired after every completed tick. */
  onTick?: (result: TickResult) => void;

  constructor(
    config: Partial<RunnerConfig> = {},
    trader?: PaperTrader,
    marketClient?: MarketClient,
  ) {
    this.config = { ...DEFAULT_RUNNER_CONFIG, ...config };
    this.trader = trader ?? new PaperTrader({ startingCash: this.config.startingBalance });
    this.marketClient = marketClient ?? (this.config.btc5minOnly ? new Btc5minMarketClient() : new DefaultMarketClient());
    this.state = initialRunnerState();
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  start(): void {
    if (this.state.running) return;
    this.state.running = true;
    logger.info("runner", "Starting polling loop");

    // Fire first tick immediately
    this.tick().catch((err) => {
      this.handleTickError(err);
    });

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.handleTickError(err);
      });
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (!this.state.running) return;
    this.state.running = false;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    logger.info("runner", "Stopped");
  }

  // ── Single tick ─────────────────────────────────────────────────

  async tick(): Promise<TickResult> {
    const result: TickResult = {
      marketsFetched: 0,
      decisions: [],
      resolutions: [],
      errors: [],
    };

    this.state.tickCount++;

    // 1) Fetch active markets
    let markets: Market[];
    try {
      const fetchResult = await this.marketClient.fetchActiveMarkets();
      markets = fetchResult.markets;
      this.state.marketsChecked += markets.length;
      result.marketsFetched = markets.length;
      this.state.dataSource = fetchResult.source;
      this.state.dataSourceDetail = fetchResult.detail;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Fetch failed: ${msg}`);
      this.state.errors++;
      this.state.lastPollAt = Date.now();
      logger.error("runner", `Fetch failed: ${msg}`, err);
      return result;
    }

    // 2) Resolve any markets that have closed since last tick
    const resolutions = this.resolveClosedMarkets(markets);
    result.resolutions = resolutions;

    // 3) Force-resolve markets that have been open too long
    const forced = this.forceResolveOldMarkets();
    result.resolutions.push(...forced);

    // 4) Filter out expired markets (endDate in the past)
    const now = Date.now();
    const activeMarkets: Market[] = [];
    for (const m of markets) {
      if (m.endDate.getTime() < now) {
        logger.info(
          "runner",
          `Skipping expired market: ${m.question.slice(0, 60)} (ended ${m.endDate.toISOString()})`,
        );
        continue;
      }
      activeMarkets.push(m);
    }

    // 5) Update known-open set & first-seen tracking
    for (const m of activeMarkets) {
      this.knownOpenMarkets.set(m.id, m);
      this.knownMarkets.set(m.id, m);
      if (!this.marketFirstSeen.has(m.id)) {
        this.marketFirstSeen.set(m.id, this.state.tickCount);
      }
    }

    // 6) Run strategies against each active market
    const strategies = this.getStrategies();

    for (const market of activeMarkets) {
      if (!market.active || market.closed || !market.acceptingOrders) continue;

      for (const strategy of strategies) {
        const ctx = this.buildContext(market, strategy.config.name);

        // Skip if strategy already has an open position on this market
        if (ctx.openPositionMarketIds.has(market.id)) continue;

        try {
          const decision = strategy.decide(ctx);
          if (decision === null) continue;

          const price = this.getPriceForSide(market, decision.side);
          if (price <= 0 || price > 1) continue;

          try {
            this.trader.openPosition(
              strategy.config.name,
              market.id,
              decision.side,
              price,
              decision.quantity,
            );

            result.decisions.push({
              strategy: strategy.config.name,
              marketId: market.id,
              side: decision.side,
              price,
              quantity: decision.quantity,
              reasoning: decision.reasoning,
            });

            this.state.tradesPlaced++;
            logger.info(
              "runner",
              `Trade: ${strategy.config.name} ${decision.side} ${decision.quantity}x${price.toFixed(3)} on ${market.question.slice(0, 50)}`,
            );
          } catch (tradeErr) {
            // e.g. insufficient funds — log but keep going
            const msg = tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
            result.errors.push(`${strategy.config.name}: ${msg}`);
            logger.warn("runner", `Trade failed: ${msg}`);
          }
        } catch (stratErr) {
          const msg = stratErr instanceof Error ? stratErr.message : String(stratErr);
          result.errors.push(`Strategy ${strategy.config.name} error: ${msg}`);
          this.state.errors++;
        }
      }
    }

    this.state.lastPollAt = Date.now();

    // Record P&L snapshot for chart
    const summary = this.trader.getSummary();
    this.state.pnlHistory.push({
      tick: this.state.tickCount,
      ts: Date.now(),
      strategies: summary.map((s) => ({
        name: s.strategyName,
        cash: s.cash,
        realizedPnL: s.realizedPnL,
        unrealizedPnL: s.unrealizedPnL,
        totalPnL: s.totalPnL,
      })),
    });
    // Keep last 200 snapshots
    if (this.state.pnlHistory.length > 200) {
      this.state.pnlHistory = this.state.pnlHistory.slice(-200);
    }

    if (result.decisions.length > 0 || result.resolutions.length > 0) {
      logger.info(
        "runner",
        `Tick #${this.state.tickCount}: ${result.marketsFetched} markets, ${result.decisions.length} trades, ${result.resolutions.length} resolutions`,
      );
    }

    this.onTick?.(result);
    return result;
  }

  // ── Resolve closed markets ──────────────────────────────────────

  private resolveClosedMarkets(
    currentMarkets: Market[],
  ): TickResult["resolutions"] {
    const resolutions: TickResult["resolutions"] = [];
    const currentIds = new Set(currentMarkets.map((m) => m.id));

    // Check all previously-known open markets
    for (const [id, market] of this.knownOpenMarkets) {
      // Still in current fetch → but check if it's now closed
      if (currentIds.has(id)) {
        const current = currentMarkets.find((m) => m.id === id)!;
        if (!current.closed) continue; // still open

        // Market came back as closed — resolve using current prices
        const openPositions = this.trader.getOpenPositions();
        const positionsForMarket = openPositions.filter((p) => p.marketId === id);
        if (positionsForMarket.length === 0) continue;

        const winningSide = this.inferWinningSide(current);
        const resolved = this.trader.resolveMarket(id, winningSide);
        this.knownOpenMarkets.delete(id);
        this.marketFirstSeen.delete(id);

        resolutions.push({ marketId: id, winningSide, positionsResolved: resolved.length });
        this.logResolution(current, winningSide, resolved);
        continue;
      }

      // Market disappeared from fetch
      const openPositions = this.trader.getOpenPositions();
      const positionsForMarket = openPositions.filter((p) => p.marketId === id);

      if (positionsForMarket.length === 0) {
        this.knownOpenMarkets.delete(id);
        this.marketFirstSeen.delete(id);
        continue;
      }

      // Resolve using last known prices
      const winningSide = this.inferWinningSide(market);
      const resolved = this.trader.resolveMarket(id, winningSide);
      this.knownOpenMarkets.delete(id);
      this.marketFirstSeen.delete(id);

      resolutions.push({ marketId: id, winningSide, positionsResolved: resolved.length });
      this.logResolution(market, winningSide, resolved);
    }

    return resolutions;
  }

  private logResolution(market: Market, winningSide: Side, resolved: import("../engine/types.js").Position[]): void {
    logger.info(
      "runner",
      `Resolved: ${market.question.slice(0, 50)} → ${winningSide} (${resolved.length} positions)`,
    );
    for (const pos of resolved) {
      const pnl = (pos.payout ?? 0) - pos.entryPrice * pos.quantity;
      const sign = pnl >= 0 ? "+" : "";
      logger.info(
        "runner",
        `Resolved: ${market.question.slice(0, 45)} → ${winningSide} | ${pos.strategy} P&L=${sign}$${pnl.toFixed(2)}`,
      );
    }
  }

  // ── Force-resolve markets open too long ────────────────────────

  /**
   * After `maxOpenTicks` ticks, force-resolve the oldest markets.
   * Winner is picked randomly weighted by outcome prices.
   */
  private forceResolveOldMarkets(): TickResult["resolutions"] {
    const resolutions: TickResult["resolutions"] = [];
    const maxAge = this.config.maxOpenTicks;

    // Find markets old enough to resolve (and that we have positions on)
    const openPositions = this.trader.getOpenPositions();
    const marketsWithPositions = new Set(openPositions.map((p) => p.marketId));

    const toResolve: string[] = [];
    for (const [id, firstSeen] of this.marketFirstSeen) {
      const age = this.state.tickCount - firstSeen;
      if (age >= maxAge && marketsWithPositions.has(id)) {
        toResolve.push(id);
      }
    }

    // Sort oldest first
    toResolve.sort((a, b) => {
      const aAge = this.state.tickCount - (this.marketFirstSeen.get(a) ?? 0);
      const bAge = this.state.tickCount - (this.marketFirstSeen.get(b) ?? 0);
      return bAge - aAge;
    });

    for (const marketId of toResolve) {
      const market = this.knownOpenMarkets.get(marketId);
      if (!market) {
        this.marketFirstSeen.delete(marketId);
        continue;
      }

      const winningSide = this.weightedRandomWinner(market);
      const resolved = this.trader.resolveMarket(marketId, winningSide);

      this.knownOpenMarkets.delete(marketId);
      this.marketFirstSeen.delete(marketId);

      resolutions.push({
        marketId,
        winningSide,
        positionsResolved: resolved.length,
      });

      // Per-position resolution log
      for (const pos of resolved) {
        const pnl = (pos.payout ?? 0) - pos.entryPrice * pos.quantity;
        const sign = pnl >= 0 ? "+" : "";
        logger.info(
          "runner",
          `Resolved: ${market.question.slice(0, 45)} → ${winningSide} | ${pos.strategy} P&L=${sign}$${pnl.toFixed(2)}`,
        );
      }
    }

    return resolutions;
  }

  /**
   * Pick a winning side weighted by outcome prices.
   * Higher price = higher chance of winning (simulates that the market
   * was roughly right about probabilities).
   */
  private weightedRandomWinner(market: Market): Side {
    if (market.outcomes.length < 2) return "YES";

    const yesOutcome =
      market.outcomes.find((o) => o.label === "Yes" || o.label === "Up") ??
      market.outcomes[0];
    const noOutcome =
      market.outcomes.find((o) => o.label === "No" || o.label === "Down") ??
      market.outcomes[1];

    // Weighted coin flip: higher price → more likely to win
    // Add noise so it's not deterministic
    const yesWeight = yesOutcome.price + (Math.random() * 0.2 - 0.1);
    const roll = Math.random();
    const winner = roll < yesWeight ? yesOutcome : noOutcome;

    if (winner === noOutcome) return "NO";
    return "YES";
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private getStrategies(): Strategy[] {
    if (this.config.enabledStrategies) {
      return this.config.enabledStrategies
        .map((name) => getStrategy(name))
        .filter((s): s is Strategy => s != null);
    }
    return getEnabledStrategies();
  }

  private buildContext(market: Market, strategyName: string): MarketContext {
    const now = Date.now();
    const start = market.startDate.getTime();
    const end = market.endDate.getTime();
    const totalWindow = end - start;
    const elapsed = now - start;
    const remaining = Math.max(0, end - now);

    const openPositions = this.trader.getOpenPositions(strategyName);
    const openPositionMarketIds = new Set(openPositions.map((p) => p.marketId));

    return {
      market,
      recentPrices: [], // TODO: wire up price history tracker
      timeRemainingFraction: totalWindow > 0 ? remaining / totalWindow : 0,
      secondsToClose: remaining / 1000,
      openPositionMarketIds,
    };
  }

  /**
   * Map a YES/NO side to the market price.
   * Convention: outcomes[0] = YES side, outcomes[1] = NO side.
   * Also matches common labels like Yes/No, Up/Down.
   */
  private getPriceForSide(market: Market, side: Side): number {
    if (market.outcomes.length < 2) return 0;

    if (side === "YES") {
      const match = market.outcomes.find(
        (o) => o.label === "Yes" || o.label === "Up",
      );
      return match?.price ?? market.outcomes[0].price;
    } else {
      const match = market.outcomes.find(
        (o) => o.label === "No" || o.label === "Down",
      );
      return match?.price ?? market.outcomes[1].price;
    }
  }

  /**
   * Infer the winning side from last known outcome prices.
   * The side with the higher price likely won.
   * outcomes[0] = YES side, outcomes[1] = NO side.
   */
  private inferWinningSide(market: Market): Side {
    if (market.outcomes.length < 2) return "YES";

    let bestIdx = 0;
    let bestPrice = -1;

    for (let i = 0; i < market.outcomes.length; i++) {
      if (market.outcomes[i].price > bestPrice) {
        bestPrice = market.outcomes[i].price;
        bestIdx = i;
      }
    }

    // Check common labels first
    const label = market.outcomes[bestIdx].label;
    if (label === "Up" || label === "Yes") return "YES";
    if (label === "Down" || label === "No") return "NO";

    // Generic: index 0 = YES, index 1 = NO
    return bestIdx === 0 ? "YES" : "NO";
  }

  private handleTickError(err: unknown): void {
    this.state.errors++;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("runner", `Tick error: ${msg}`, err);
  }
}

// ── Default market client (uses real API) ───────────────────────────

import { fetchActiveMarkets, fetchBtc5minMarkets } from "../market-data/client.js";
import type { MarketFetchResult } from "./types.js";

class DefaultMarketClient implements MarketClient {
  async fetchActiveMarkets(): Promise<MarketFetchResult> {
    // Prefer BTC 5-min markets when available
    const btcMarkets = await fetchBtc5minMarkets();
    if (btcMarkets.length > 0) {
      return {
        markets: btcMarkets,
        source: "btc-5min",
        detail: `${btcMarkets.length} BTC 5-min market${btcMarkets.length !== 1 ? "s" : ""} live`,
      };
    }

    logger.info("runner", "No BTC 5-min markets active, falling back to all active markets");
    const fallback = await fetchActiveMarkets();
    if (fallback.length > 0) {
      return {
        markets: fallback,
        source: "fallback-markets",
        detail: `${fallback.length} generic market${fallback.length !== 1 ? "s" : ""} (no BTC 5-min)`,
      };
    }
    return { markets: [], source: "none", detail: "No markets available" };
  }
}

class Btc5minMarketClient implements MarketClient {
  async fetchActiveMarkets(): Promise<MarketFetchResult> {
    const markets = await fetchBtc5minMarkets();
    if (markets.length > 0) {
      return {
        markets,
        source: "btc-5min",
        detail: `${markets.length} BTC 5-min market${markets.length !== 1 ? "s" : ""} live`,
      };
    }
    return { markets: [], source: "none", detail: "No BTC 5-min markets active" };
  }
}

// ── Demo market client (fake data, no API calls) ─────────────────────

let demoCounter = 0;

function uid(): string {
  return `demo-${++demoCounter}`;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeDemoMarket(): Market {
  const id = uid();
  const price = Math.round(rand(0.25, 0.75) * 1000) / 1000;
  const targets = ["$69k", "$70k", "$71k", "$105k", "$108k"];
  const target = targets[Math.floor(Math.random() * targets.length)];
  const hours = ["2pm", "3pm", "4pm", "5pm", "6pm"];
  const hour = hours[Math.floor(Math.random() * hours.length)];
  const now = Date.now();

  return {
    id,
    question: `BTC above ${target} at ${hour}?`,
    slug: `demo-btc-${id}`,
    outcomes: [
      { label: "Yes", price, tokenId: `${id}-yes` },
      { label: "No", price: Math.round((1 - price) * 1000) / 1000, tokenId: `${id}-no` },
    ],
    active: true,
    closed: false,
    startDate: new Date(now - rand(60_000, 180_000)),
    endDate: new Date(now + rand(30_000, 120_000)),
    eventStartTime: new Date(now - rand(60_000, 180_000)),
    volume: Math.round(rand(10_000, 200_000)),
    volume24hr: Math.round(rand(1_000, 50_000)),
    liquidity: Math.round(rand(5_000, 50_000)),
    spread: Math.round(rand(0.01, 0.04) * 100) / 100,
    lastTradePrice: price,
    resolutionSource: "demo",
    acceptingOrders: true,
  };
}

export class DemoMarketClient implements MarketClient {
  /** Markets we're currently serving. */
  private markets: Market[] = [];
  /** Tick counter for rotation decisions. */
  private tickNum = 0;

  constructor() {
    // Start with 3 markets
    this.markets = [makeDemoMarket(), makeDemoMarket(), makeDemoMarket()];
  }

  async fetchActiveMarkets(): Promise<MarketFetchResult> {
    this.tickNum++;

    // Every 3 ticks, rotate: resolve one market, spawn a new one
    if (this.tickNum % 3 === 0 && this.markets.length > 0) {
      const idx = Math.floor(Math.random() * this.markets.length);
      const resolved = this.markets.splice(idx, 1)[0];
      logger.info("demo", `Resolved: ${resolved.question} (was Yes=${resolved.outcomes[0].price})`);
      this.markets.push(makeDemoMarket());
    }

    // Jitter prices slightly each tick to keep it alive
    for (const m of this.markets) {
      const delta = rand(-0.03, 0.03);
      const yesPrice = Math.max(0.05, Math.min(0.95, m.outcomes[0].price + delta));
      m.outcomes[0].price = Math.round(yesPrice * 1000) / 1000;
      m.outcomes[1].price = Math.round((1 - yesPrice) * 1000) / 1000;
      m.lastTradePrice = m.outcomes[0].price;
    }

    return {
      markets: [...this.markets],
      source: "demo",
      detail: `${this.markets.length} demo market${this.markets.length !== 1 ? "s" : ""}`,
    };
  }
}
