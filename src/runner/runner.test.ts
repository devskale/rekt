import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { Runner } from "./runner.js";
import { PaperTrader } from "../engine/paper-trader.js";
import type { MarketClient } from "./types.js";
import type { Market } from "../market-data/types.js";
import type { Strategy, Decision, MarketContext } from "../strategies/types.js";
import { clearStrategies, registerStrategy } from "../strategies/registry.js";

// ── Fixtures ────────────────────────────────────────────────────────

function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "m1",
    question: "BTC Up or Down - 5min",
    slug: "btc-updown-5m-test",
    outcomes: [
      { label: "Up", price: 0.65, tokenId: "tok-up" },
      { label: "Down", price: 0.35, tokenId: "tok-down" },
    ],
    active: true,
    closed: false,
    endDate: new Date(Date.now() + 200_000),
    startDate: new Date(Date.now() - 100_000),
    eventStartTime: new Date(Date.now() - 100_000),
    volume: 50_000,
    volume24hr: 5_000,
    liquidity: 10_000,
    spread: 0.02,
    lastTradePrice: 0.64,
    resolutionSource: "https://data.chain.link/streams/btc-usd",
    acceptingOrders: true,
    ...overrides,
  };
}

/** Build a mock MarketClient that returns the given markets. */
function mockClient(markets: Market[]): MarketClient {
  return {
    fetchActiveMarkets: vi.fn().mockResolvedValue({
      markets,
      source: "demo" as const,
      detail: `${markets.length} mock market${markets.length !== 1 ? "s" : ""}`,
    }),
  };
}

/** Build a mock strategy. */
function mockStrategy(
  name: string,
  decideFn: (ctx: MarketContext) => Decision | null,
): Strategy {
  return {
    name,
    description: `Mock ${name}`,
    config: { name, enabled: true, budget: null },
    decide: decideFn,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Runner", () => {
  beforeEach(() => {
    clearStrategies();
  });

  // ── Tick basics ─────────────────────────────────────────────────

  it("fetches markets and runs strategies on tick", async () => {
    const market = makeMarket();
    const client = mockClient([market]);
    const trader = new PaperTrader({ startingCash: 1_000 });

    const alwaysBuy: Strategy = mockStrategy("test-buy", () => ({
      side: "YES",
      confidence: 0.7,
      reasoning: "test",
      quantity: 10,
    }));
    registerStrategy(alwaysBuy);

    const runner = new Runner({}, trader, client);
    const result = await runner.tick();

    expect(result.marketsFetched).toBe(1);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].strategy).toBe("test-buy");
    expect(result.decisions[0].side).toBe("YES");
    expect(result.decisions[0].price).toBeCloseTo(0.65, 2);
    expect(result.decisions[0].quantity).toBe(10);
  });

  it("does not trade when strategy returns null", async () => {
    const market = makeMarket();
    const client = mockClient([market]);
    const trader = new PaperTrader({ startingCash: 1_000 });

    const neverTrade: Strategy = mockStrategy("test-pass", () => null);
    registerStrategy(neverTrade);

    const runner = new Runner({}, trader, client);
    const result = await runner.tick();

    expect(result.decisions).toHaveLength(0);
    expect(result.marketsFetched).toBe(1);
  });

  it("calls strategy with correct MarketContext", async () => {
    const market = makeMarket();
    const client = mockClient([market]);
    const trader = new PaperTrader({ startingCash: 1_000 });

    let capturedCtx: MarketContext | null = null;
    const spy: Strategy = mockStrategy("spy", (ctx) => {
      capturedCtx = ctx;
      return null;
    });
    registerStrategy(spy);

    const runner = new Runner({}, trader, client);
    await runner.tick();

    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx!.market.id).toBe("m1");
    expect(capturedCtx!.secondsToClose).toBeGreaterThan(0);
    expect(capturedCtx!.timeRemainingFraction).toBeGreaterThan(0);
    expect(capturedCtx!.timeRemainingFraction).toBeLessThanOrEqual(1);
  });

  it("runs multiple strategies against each market", async () => {
    const market = makeMarket();
    const client = mockClient([market]);
    const trader = new PaperTrader({ startingCash: 2_000 });

    const yesStrat: Strategy = mockStrategy("yes-strat", () => ({
      side: "YES",
      confidence: 0.6,
      reasoning: "go YES",
      quantity: 5,
    }));
    const noStrat: Strategy = mockStrategy("no-strat", () => ({
      side: "NO",
      confidence: 0.6,
      reasoning: "go NO",
      quantity: 5,
    }));

    registerStrategy(yesStrat);
    registerStrategy(noStrat);

    const runner = new Runner({}, trader, client);
    const result = await runner.tick();

    expect(result.decisions).toHaveLength(2);

    const sides = result.decisions.map((d) => d.side).sort();
    expect(sides).toEqual(["NO", "YES"]);
  });

  it("opens positions on the paper trader", async () => {
    const market = makeMarket();
    const client = mockClient([market]);
    const trader = new PaperTrader({ startingCash: 1_000 });

    const buyer: Strategy = mockStrategy("buyer", () => ({
      side: "YES",
      confidence: 0.7,
      reasoning: "buy YES",
      quantity: 20,
    }));
    registerStrategy(buyer);

    const runner = new Runner({}, trader, client);
    await runner.tick();

    const positions = trader.getPositions("buyer");
    expect(positions).toHaveLength(1);
    expect(positions[0].side).toBe("YES");
    expect(positions[0].entryPrice).toBeCloseTo(0.65, 2);
    expect(positions[0].quantity).toBe(20);

    const bal = trader.getBalance("buyer");
    expect(bal.cash).toBeCloseTo(1_000 - 0.65 * 20 - 20 * 0.07 * 0.65 * 0.35, 2);
  });

  it("skips closed or inactive markets", async () => {
    const closedMarket = makeMarket({ closed: true, active: true });
    const inactiveMarket = makeMarket({ id: "m2", active: false, closed: false });
    const client = mockClient([closedMarket, inactiveMarket]);
    const trader = new PaperTrader({ startingCash: 1_000 });

    const buyer: Strategy = mockStrategy("buyer", () => ({
      side: "YES", confidence: 0.6, reasoning: "buy", quantity: 10,
    }));
    registerStrategy(buyer);

    const runner = new Runner({}, trader, client);
    const result = await runner.tick();

    expect(result.decisions).toHaveLength(0);
  });

  // ── Error handling ──────────────────────────────────────────────

  it("handles fetch errors gracefully", async () => {
    const client: MarketClient = {
      fetchActiveMarkets: vi.fn().mockRejectedValue(new Error("Network error")),
    };
    const trader = new PaperTrader({ startingCash: 1_000 });
    const buyer: Strategy = mockStrategy("buyer", () => ({
      side: "YES", confidence: 0.6, reasoning: "buy", quantity: 10,
    }));
    registerStrategy(buyer);

    const runner = new Runner({}, trader, client);
    const result = await runner.tick();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Network error");
    expect(result.marketsFetched).toBe(0);
    expect(result.decisions).toHaveLength(0);
    expect(runner.state.errors).toBe(1);
  });

  it("handles strategy errors gracefully", async () => {
    const market = makeMarket();
    const client = mockClient([market]);
    const trader = new PaperTrader({ startingCash: 1_000 });

    const brokenStrat: Strategy = mockStrategy("broken", () => {
      throw new Error("Strategy blew up");
    });
    const goodStrat: Strategy = mockStrategy("good", () => ({
      side: "YES", confidence: 0.6, reasoning: "fine", quantity: 5,
    }));

    registerStrategy(brokenStrat);
    registerStrategy(goodStrat);

    const runner = new Runner({}, trader, client);
    const result = await runner.tick();

    // Broken strategy logged error, good strategy still ran
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].strategy).toBe("good");
  });

  it("handles insufficient funds without crashing", async () => {
    const market = makeMarket();
    const client = mockClient([market]);
    const trader = new PaperTrader({ startingCash: 1 }); // only $1

    const buyer: Strategy = mockStrategy("broke", () => ({
      side: "YES", confidence: 0.6, reasoning: "buy", quantity: 100,
    }));
    registerStrategy(buyer);

    const runner = new Runner({}, trader, client);
    const result = await runner.tick();

    // Trade rejected but tick completed
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.decisions).toHaveLength(0);
  });

  // ── Market resolution ───────────────────────────────────────────

  it("resolves positions when a market disappears", async () => {
    const market = makeMarket();
    const trader = new PaperTrader({ startingCash: 1_000 });

    const buyer: Strategy = mockStrategy("holder", () => ({
      side: "YES", confidence: 0.6, reasoning: "buy", quantity: 10,
    }));
    registerStrategy(buyer);

    // Tick 1: market exists, we open a position
    const client1 = mockClient([market]);
    const runner = new Runner({}, trader, client1);
    await runner.tick();

    expect(trader.getOpenPositions()).toHaveLength(1);

    // Tick 2: market gone — positions should be resolved
    const client2 = mockClient([]);
    (runner as any).marketClient = client2;
    const result = await runner.tick();

    expect(result.resolutions).toHaveLength(1);
    expect(result.resolutions[0].marketId).toBe("m1");
    expect(result.resolutions[0].positionsResolved).toBe(1);
    expect(trader.getOpenPositions()).toHaveLength(0);
  });

  it("resolves positions when market comes back as closed", async () => {
    const market = makeMarket();
    const trader = new PaperTrader({ startingCash: 1_000 });

    const buyer: Strategy = mockStrategy("holder", () => ({
      side: "YES", confidence: 0.6, reasoning: "buy", quantity: 10,
    }));
    registerStrategy(buyer);

    const client1 = mockClient([market]);
    const runner = new Runner({}, trader, client1);
    await runner.tick();

    // Tick 2: same market but now closed
    const closedMarket = makeMarket({ closed: true });
    const client2 = mockClient([closedMarket]);
    (runner as any).marketClient = client2;
    const result = await runner.tick();

    expect(result.resolutions).toHaveLength(1);
    expect(trader.getOpenPositions()).toHaveLength(0);
  });

  // ── Start / Stop lifecycle ──────────────────────────────────────

  it("start begins polling and stop stops it", async () => {
    vi.useFakeTimers();

    const client = mockClient([]);
    const trader = new PaperTrader({ startingCash: 1_000 });
    const runner = new Runner({ pollIntervalMs: 1_000 }, trader, client);

    expect(runner.state.running).toBe(false);

    runner.start();
    expect(runner.state.running).toBe(true);

    // First tick fires immediately
    await vi.runOnlyPendingTimersAsync();
    expect(runner.state.tickCount).toBeGreaterThanOrEqual(1);

    // Advance past one interval — second tick
    await vi.advanceTimersByTimeAsync(1_100);
    expect(runner.state.tickCount).toBeGreaterThanOrEqual(2);

    const ticksBeforeStop = runner.state.tickCount;
    runner.stop();
    expect(runner.state.running).toBe(false);

    // Advance more — no more ticks
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runner.state.tickCount).toBe(ticksBeforeStop);

    vi.useRealTimers();
  });

  it("double start is a no-op", () => {
    const client = mockClient([]);
    const trader = new PaperTrader({ startingCash: 1_000 });
    const runner = new Runner({ pollIntervalMs: 60_000 }, trader, client);

    runner.start();
    runner.start(); // no-op

    expect(runner.state.running).toBe(true);
    runner.stop();
  });

  it("stop when not running is a no-op", () => {
    const client = mockClient([]);
    const trader = new PaperTrader({ startingCash: 1_000 });
    const runner = new Runner({}, trader, client);

    runner.stop(); // no-op, no crash
    expect(runner.state.running).toBe(false);
  });

  // ── Config filtering ────────────────────────────────────────────

  it("respects enabledStrategies config", async () => {
    const market = makeMarket();
    const client = mockClient([market]);
    const trader = new PaperTrader({ startingCash: 1_000 });

    const a: Strategy = mockStrategy("strat-a", () => ({
      side: "YES", confidence: 0.6, reasoning: "a", quantity: 5,
    }));
    const b: Strategy = mockStrategy("strat-b", () => ({
      side: "NO", confidence: 0.6, reasoning: "b", quantity: 5,
    }));

    registerStrategy(a);
    registerStrategy(b);

    // Only enable strat-a
    const runner = new Runner(
      { enabledStrategies: ["strat-a"] },
      trader,
      client,
    );
    const result = await runner.tick();

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].strategy).toBe("strat-a");
  });

  // ── State tracking ──────────────────────────────────────────────

  it("tracks state correctly across ticks", async () => {
    const market1 = makeMarket();
    const market2 = makeMarket({ id: "m2" });
    const trader = new PaperTrader({ startingCash: 1_000 });

    const buyer: Strategy = mockStrategy("buyer", () => ({
      side: "YES", confidence: 0.6, reasoning: "buy", quantity: 5,
    }));
    registerStrategy(buyer);

    // Tick 1: 2 markets
    const runner = new Runner({}, trader, mockClient([market1, market2]));
    await runner.tick();

    expect(runner.state.tickCount).toBe(1);
    expect(runner.state.marketsChecked).toBe(2);
    expect(runner.state.tradesPlaced).toBe(2);
    expect(runner.state.lastPollAt).not.toBeNull();

    // Tick 2: market1 still open — strategy already has position, deduped
    (runner as any).marketClient = mockClient([market1]);
    await runner.tick();

    expect(runner.state.tickCount).toBe(2);
    expect(runner.state.marketsChecked).toBe(3);
    expect(runner.state.tradesPlaced).toBe(2); // no re-buy on market1
  });
});
