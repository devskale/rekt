import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createServer } from "./index.js";
import { PaperTrader } from "../engine/paper-trader.js";
import { Runner } from "../runner/runner.js";
import type { MarketClient } from "../runner/types.js";
import type { Market } from "../market-data/types.js";
import { clearStrategies, registerStrategy } from "../strategies/registry.js";
import type { Strategy, MarketContext, Decision } from "../strategies/types.js";

// ── Helpers ─────────────────────────────────────────────────────────

function stubMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "m1",
    question: "BTC Up or Down - Test",
    slug: "btc-test",
    outcomes: [
      { label: "Up", price: 0.60, tokenId: "t1" },
      { label: "Down", price: 0.40, tokenId: "t2" },
    ],
    active: true,
    closed: false,
    endDate: new Date(Date.now() + 300_000),
    startDate: new Date(Date.now() - 100_000),
    eventStartTime: new Date(Date.now() - 100_000),
    volume: 10_000,
    volume24hr: 1_000,
    liquidity: 5_000,
    spread: 0.02,
    lastTradePrice: 0.59,
    resolutionSource: "",
    acceptingOrders: true,
    ...overrides,
  };
}

function stubClient(markets: Market[] = []): MarketClient {
  return {
    fetchActiveMarkets: async () => ({
      markets,
      source: "demo" as const,
      detail: `${markets.length} stub market${markets.length !== 1 ? "s" : ""}`,
    }),
  };
}

function stubStrategy(name: string, fn: (ctx: MarketContext) => Decision | null): Strategy {
  return {
    name,
    description: `Test ${name}`,
    config: { name, enabled: true, budget: null },
    decide: fn,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Server API", () => {
  let trader: PaperTrader;
  let runner: Runner;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    clearStrategies();
    trader = new PaperTrader({ startingCash: 1_000 });
    runner = new Runner({}, trader, stubClient());
    app = createServer(trader, runner);
  });

  // ── GET /api/state ──────────────────────────────────────────────

  it("GET /api/state returns runner state", async () => {
    const res = await request(app).get("/api/state");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      running: false,
      lastPollAt: null,
      marketsChecked: 0,
      tradesPlaced: 0,
      errors: 0,
      tickCount: 0,
    });
  });

  // ── GET /api/strategies ─────────────────────────────────────────

  it("GET /api/strategies returns empty when no trades", async () => {
    const res = await request(app).get("/api/strategies");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("GET /api/strategies returns balances after trades", async () => {
    trader.openPosition("alpha", "m1", "YES", 0.60, 10);
    const res = await request(app).get("/api/strategies");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].strategyName).toBe("alpha");
    expect(res.body[0].cash).toBeCloseTo(1000 - 6 - 10 * 0.07 * 0.60 * 0.40, 1);
  });

  // ── GET /api/positions ──────────────────────────────────────────

  it("GET /api/positions returns open positions", async () => {
    const pos = trader.openPosition("alpha", "m1", "YES", 0.60, 10);
    const res = await request(app).get("/api/positions");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(pos.id);
    expect(res.body[0].status).toBe("open");
  });

  it("GET /api/positions?strategy= filters by strategy", async () => {
    trader.openPosition("alpha", "m1", "YES", 0.60, 10);
    trader.openPosition("beta", "m1", "NO", 0.40, 10);

    const resAlpha = await request(app).get("/api/positions?strategy=alpha");
    expect(resAlpha.body).toHaveLength(1);
    expect(resAlpha.body[0].strategy).toBe("alpha");

    const resAll = await request(app).get("/api/positions");
    expect(resAll.body).toHaveLength(2);
  });

  // ── GET /api/history ────────────────────────────────────────────

  it("GET /api/history returns trade log", async () => {
    trader.openPosition("alpha", "m1", "YES", 0.60, 10);
    const res = await request(app).get("/api/history");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].action).toBe("open");
    expect(res.body[0].price).toBeCloseTo(0.60, 2);
  });

  it("GET /api/history?strategy= filters", async () => {
    trader.openPosition("alpha", "m1", "YES", 0.60, 10);
    trader.openPosition("beta", "m2", "NO", 0.40, 10);

    const res = await request(app).get("/api/history?strategy=beta");
    expect(res.body).toHaveLength(1);
    expect(res.body[0].strategy).toBe("beta");
  });

  // ── POST /api/start ─────────────────────────────────────────────

  it("POST /api/start starts the runner", async () => {
    const res = await request(app).post("/api/start");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.state.running).toBe(true);

    // Verify runner is running
    const stateRes = await request(app).get("/api/state");
    expect(stateRes.body.running).toBe(true);

    // Clean up
    runner.stop();
  });

  // ── POST /api/stop ──────────────────────────────────────────────

  it("POST /api/stop stops the runner", async () => {
    runner.start();

    const res = await request(app).post("/api/stop");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.state.running).toBe(false);
  });

  // ── SSE /api/stream ─────────────────────────────────────────────

  it("GET /api/stream establishes SSE connection", async () => {
    // Spin up a real HTTP server for this one test
    const { createServer: httpCreate } = await import("http");
    const srv = httpCreate(app);
    await new Promise<void>((r) => srv.listen(0, () => r()));
    const addr = srv.address() as { port: number };

    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/stream`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      // Read the first chunk to confirm data flows
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain("connected");
      reader.cancel();
    } finally {
      srv.close();
    }
  });

  // ── Integration: full cycle ─────────────────────────────────────

  it("end-to-end: start → tick → get data", async () => {
    // Register a strategy that will trade
    const buyer = stubStrategy("buyer", () => ({
      side: "YES",
      confidence: 0.7,
      reasoning: "test buy",
      quantity: 5,
    }));
    registerStrategy(buyer);

    // Replace runner's client with one that returns a market
    const market = stubMarket();
    (runner as any).marketClient = stubClient([market]);

    // Manually tick (don't use start/interval)
    await runner.tick();

    // Check positions were created
    const posRes = await request(app).get("/api/positions");
    expect(posRes.body).toHaveLength(1);
    expect(posRes.body[0].strategy).toBe("buyer");
    expect(posRes.body[0].side).toBe("YES");

    // Check strategies balance
    const stratRes = await request(app).get("/api/strategies");
    expect(stratRes.body).toHaveLength(1);
    expect(stratRes.body[0].cash).toBeCloseTo(1000 - 3 - 5 * 0.07 * 0.60 * 0.40, 1);

    // Check history
    const histRes = await request(app).get("/api/history");
    expect(histRes.body).toHaveLength(1);

    // Check state was updated
    const stateRes = await request(app).get("/api/state");
    expect(stateRes.body.marketsChecked).toBe(1);
    expect(stateRes.body.tradesPlaced).toBe(1);
  });
});
