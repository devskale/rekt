import { describe, it, expect, beforeEach } from "vitest";
import { LateScalpStrategy } from "./late-scalp.js";
import { SnipeStrategy } from "./snipe.js";
import { CoinFlipStrategy } from "./coin-flip.js";
import { MomentumStrategy } from "./momentum.js";
import {
  registerStrategy,
  getStrategies,
  getEnabledStrategies,
  getStrategy,
  setStrategyEnabled,
  clearStrategies,
  registerDefaults,
} from "./registry.js";
import type { MarketContext, Decision } from "./types.js";
import type { Market } from "../market-data/types.js";

// ── Fixtures ────────────────────────────────────────────────────────

function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "m1",
    question: "Bitcoin Up or Down - 5min",
    slug: "btc-updown-5m-test",
    outcomes: [
      { label: "Up", price: 0.60, tokenId: "tok-up" },
      { label: "Down", price: 0.40, tokenId: "tok-down" },
    ],
    active: true,
    closed: false,
    endDate: new Date(Date.now() + 300_000),
    startDate: new Date(Date.now() - 120_000),
    eventStartTime: new Date(Date.now() - 120_000),
    volume: 50_000,
    volume24hr: 5_000,
    liquidity: 10_000,
    spread: 0.02,
    lastTradePrice: 0.59,
    resolutionSource: "https://data.chain.link/streams/btc-usd",
    acceptingOrders: true,
    ...overrides,
  };
}

function makeContext(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    market: makeMarket(),
    recentPrices: [],
    timeRemainingFraction: 0.10, // 10% remaining = late in window
    secondsToClose: 30,
    openPositionMarketIds: new Set(),
    ...overrides,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function isValidDecision(d: Decision | null): d is Decision {
  if (d === null) return true;
  return (
    (d.side === "YES" || d.side === "NO") &&
    d.confidence >= 0 &&
    d.confidence <= 1 &&
    d.quantity > 0 &&
    typeof d.reasoning === "string" &&
    d.reasoning.length > 0
  );
}

// ════════════════════════════════════════════════════════════════════

describe("Late Scalp Strategy", () => {
  const strat = new LateScalpStrategy();

  it("returns null when too early (> 35s remaining)", () => {
    const ctx = makeContext({ secondsToClose: 40 });
    expect(strat.decide(ctx)).toBeNull();
  });

  it("returns null at the boundary (36s remaining)", () => {
    const ctx = makeContext({ secondsToClose: 36 });
    expect(strat.decide(ctx)).toBeNull();
  });

  it("acts in the sweet spot (20s remaining, favourite >= 0.95)", () => {
    const market = makeMarket({
      outcomes: [
        { label: "Up", price: 0.96, tokenId: "tok-up" },
        { label: "Down", price: 0.04, tokenId: "tok-down" },
      ],
    });
    const ctx = makeContext({ market, secondsToClose: 20 });
    const decision = strat.decide(ctx);
    expect(decision).not.toBeNull();
    expect(decision!.side).toBe("YES");
    expect(decision!.quantity).toBeGreaterThanOrEqual(10);
    expect(decision!.quantity).toBeLessThanOrEqual(20);
    expect(isValidDecision(decision)).toBe(true);
  });

  it("returns null when no side is above 0.95", () => {
    const market = makeMarket({
      outcomes: [
        { label: "Up", price: 0.90, tokenId: "tok-up" },
        { label: "Down", price: 0.10, tokenId: "tok-down" },
      ],
    });
    const ctx = makeContext({ market, secondsToClose: 20 });
    expect(strat.decide(ctx)).toBeNull();
  });

  it("returns null in the skip zone (< 8s remaining)", () => {
    const market = makeMarket({
      outcomes: [
        { label: "Up", price: 0.97, tokenId: "tok-up" },
        { label: "Down", price: 0.03, tokenId: "tok-down" },
      ],
    });
    const ctx = makeContext({ market, secondsToClose: 5 });
    expect(strat.decide(ctx)).toBeNull();
  });

  it("scales quantity with price confidence", () => {
    const cheapMarket = makeMarket({
      outcomes: [
        { label: "Up", price: 0.96, tokenId: "tok-up" },
        { label: "Down", price: 0.04, tokenId: "tok-down" },
      ],
    });
    const expensiveMarket = makeMarket({
      outcomes: [
        { label: "Up", price: 0.99, tokenId: "tok-up" },
        { label: "Down", price: 0.01, tokenId: "tok-down" },
      ],
    });

    const cheap = strat.decide(makeContext({ market: cheapMarket, secondsToClose: 20 }))!;
    const expensive = strat.decide(makeContext({ market: expensiveMarket, secondsToClose: 20 }))!;

    expect(expensive.quantity).toBeGreaterThanOrEqual(cheap.quantity);
  });
});

// ════════════════════════════════════════════════════════════════════

describe("Snipe Strategy", () => {
  const strat = new SnipeStrategy();

  it("buys the cheap underdog", () => {
    const market = makeMarket({
      outcomes: [
        { label: "Up", price: 0.75, tokenId: "tok-up" },
        { label: "Down", price: 0.25, tokenId: "tok-down" },
      ],
    });
    const ctx = makeContext({ market });
    const decision = strat.decide(ctx);
    expect(decision).not.toBeNull();
    expect(decision!.side).toBe("NO"); // Down at 0.25
    expect(decision!.quantity).toBeGreaterThanOrEqual(5);
    expect(decision!.quantity).toBeLessThanOrEqual(15);
    expect(isValidDecision(decision)).toBe(true);
  });

  it("returns null when nothing is cheap enough (> 0.30)", () => {
    const market = makeMarket({
      outcomes: [
        { label: "Up", price: 0.60, tokenId: "tok-up" },
        { label: "Down", price: 0.40, tokenId: "tok-down" },
      ],
    });
    const ctx = makeContext({ market });
    expect(strat.decide(ctx)).toBeNull();
  });

  it("returns null when price is zero or negative", () => {
    const market = makeMarket({
      outcomes: [
        { label: "Up", price: 0.99, tokenId: "tok-up" },
        { label: "Down", price: 0, tokenId: "tok-down" },
      ],
    });
    const ctx = makeContext({ market });
    expect(strat.decide(ctx)).toBeNull();
  });

  it("buys more shares when underdog is cheaper", () => {
    const slightlyCheap = makeMarket({
      outcomes: [
        { label: "Up", price: 0.72, tokenId: "tok-up" },
        { label: "Down", price: 0.28, tokenId: "tok-down" },
      ],
    });
    const veryCheap = makeMarket({
      outcomes: [
        { label: "Up", price: 0.95, tokenId: "tok-up" },
        { label: "Down", price: 0.05, tokenId: "tok-down" },
      ],
    });

    const slight = strat.decide(makeContext({ market: slightlyCheap }))!;
    const very = strat.decide(makeContext({ market: veryCheap }))!;

    expect(very.quantity).toBeGreaterThanOrEqual(slight.quantity);
  });
});

// ════════════════════════════════════════════════════════════════════

describe("Coin Flip Strategy", () => {
  it("always returns a decision (never null)", () => {
    const strat = new CoinFlipStrategy();
    const ctx = makeContext();
    for (let i = 0; i < 20; i++) {
      const d = strat.decide(ctx);
      expect(d).not.toBeNull();
      expect(d!.quantity).toBe(10);
      expect(isValidDecision(d)).toBe(true);
    }
  });

  it("returns ~50/50 YES/NO over 1000 runs", () => {
    let yesCount = 0;
    const strat = new CoinFlipStrategy();
    const ctx = makeContext();

    for (let i = 0; i < 1_000; i++) {
      const d = strat.decide(ctx);
      if (d!.side === "YES") yesCount++;
    }

    // Should be roughly 500 ± 100 (very generous bounds)
    expect(yesCount).toBeGreaterThan(400);
    expect(yesCount).toBeLessThan(600);
  });

  it("uses injectable RNG for deterministic tests", () => {
    let val = 0;
    const strat = new CoinFlipStrategy(() => { val += 0.25; return val % 1; });
    const ctx = makeContext();

    const results = Array.from({ length: 8 }, () => strat.decide(ctx)!.side);
    // rng returns 0.25, 0.50, 0.75, 0.00, 0.25, ...
    // < 0.5 → YES, >= 0.5 → NO
    expect(results).toEqual(["YES", "NO", "NO", "YES", "YES", "NO", "NO", "YES"]);
  });
});

// ════════════════════════════════════════════════════════════════════

describe("Momentum Strategy", () => {
  const strat = new MomentumStrategy();

  it("falls back to favourite when no history", () => {
    const ctx = makeContext({ recentPrices: [] });
    const d = strat.decide(ctx);
    expect(d).not.toBeNull();
    expect(d!.side).toBe("YES"); // Up is favourite at 0.60
    expect(d!.reasoning).toContain("fallback");
    expect(isValidDecision(d)).toBe(true);
  });

  it("falls back to favourite with insufficient history (< 3 points)", () => {
    const ctx = makeContext({
      recentPrices: [
        { price: 0.55, timestamp: 1 },
        { price: 0.58, timestamp: 2 },
      ],
    });
    const d = strat.decide(ctx);
    expect(d).not.toBeNull();
    expect(d!.reasoning).toContain("fallback");
  });

  it("buys YES when trend is up", () => {
    const ctx = makeContext({
      recentPrices: [
        { price: 0.45, timestamp: 1 },
        { price: 0.50, timestamp: 2 },
        { price: 0.55, timestamp: 3 },
        { price: 0.60, timestamp: 4 },
        { price: 0.65, timestamp: 5 },
        { price: 0.70, timestamp: 6 },
      ],
    });
    const d = strat.decide(ctx);
    expect(d).not.toBeNull();
    expect(d!.side).toBe("YES"); // trending up → buy Up
    expect(d!.reasoning).toContain("up");
  });

  it("buys NO when trend is down", () => {
    const ctx = makeContext({
      recentPrices: [
        { price: 0.70, timestamp: 1 },
        { price: 0.65, timestamp: 2 },
        { price: 0.60, timestamp: 3 },
        { price: 0.55, timestamp: 4 },
        { price: 0.50, timestamp: 5 },
        { price: 0.45, timestamp: 6 },
      ],
    });
    const d = strat.decide(ctx);
    expect(d).not.toBeNull();
    expect(d!.side).toBe("NO"); // trending down → buy Down
    expect(d!.reasoning).toContain("down");
  });

  it("returns null when no favourite and no history", () => {
    const market = makeMarket({
      outcomes: [
        { label: "Up", price: 0.50, tokenId: "tok-up" },
        { label: "Down", price: 0.50, tokenId: "tok-down" },
      ],
    });
    const ctx = makeContext({ market, recentPrices: [] });
    expect(strat.decide(ctx)).toBeNull();
  });

  it("quantity is within 15–25 range", () => {
    const ctx = makeContext({
      recentPrices: [
        { price: 0.55, timestamp: 1 },
        { price: 0.58, timestamp: 2 },
        { price: 0.63, timestamp: 3 },
        { price: 0.67, timestamp: 4 },
      ],
    });
    const d = strat.decide(ctx)!;
    expect(d.quantity).toBeGreaterThanOrEqual(15);
    expect(d.quantity).toBeLessThanOrEqual(25);
  });
});

// ════════════════════════════════════════════════════════════════════

describe("Strategy Registry", () => {
  beforeEach(() => {
    clearStrategies();
  });

  it("starts empty after clear", () => {
    expect(getStrategies()).toHaveLength(0);
  });

  it("registerDefaults registers all 4 strategies", () => {
    registerDefaults();
    const all = getStrategies();
    expect(all).toHaveLength(4);
    const names = all.map((s) => s.config.name);
    expect(names).toContain("late-scalp");
    expect(names).toContain("snipe");
    expect(names).toContain("coin-flip");
    expect(names).toContain("momentum");
  });

  it("getEnabledStrategies returns only enabled", () => {
    registerDefaults();
    expect(getEnabledStrategies()).toHaveLength(4);

    setStrategyEnabled("snipe", false);
    const enabled = getEnabledStrategies();
    expect(enabled).toHaveLength(3);
    expect(enabled.map((s) => s.config.name)).not.toContain("snipe");
  });

  it("getStrategy finds by name", () => {
    registerDefaults();
    const s = getStrategy("coin-flip");
    expect(s).toBeDefined();
    expect(s!.name).toBe("Coin Flip");
  });

  it("getStrategy returns undefined for unknown", () => {
    registerDefaults();
    expect(getStrategy("nonexistent")).toBeUndefined();
  });

  it("registerStrategy adds custom strategy", () => {
    registerDefaults();
    const custom: import("./types.js").Strategy = {
      name: "Custom",
      description: "Test",
      config: { name: "custom", enabled: true, budget: 500 },
      decide: () => null,
    };
    registerStrategy(custom);
    expect(getStrategies()).toHaveLength(5);
    expect(getStrategy("custom")).toBeDefined();
  });
});
