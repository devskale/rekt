import { describe, it, expect } from "vitest";
import { GammaMarketSchema, OutcomePricesSchema, toMarket } from "./types.js";

describe("OutcomePricesSchema", () => {
  it("parses JSON-encoded price array", () => {
    expect(OutcomePricesSchema.parse('["0.51", "0.49"]')).toEqual([0.51, 0.49]);
  });

  it("handles integer prices", () => {
    expect(OutcomePricesSchema.parse('["0", "1"]')).toEqual([0, 1]);
  });

  it("rejects invalid JSON", () => {
    expect(() => OutcomePricesSchema.parse("not json")).toThrow();
  });
});

describe("GammaMarketSchema", () => {
  const rawMarket = {
    id: "123",
    question: "Bitcoin Up or Down - Test",
    slug: "btc-updown-5m-test",
    conditionId: "0xabc",
    outcomes: '["Up", "Down"]',
    outcomePrices: '["0.55", "0.45"]',
    clobTokenIds: '["tok1", "tok2"]',
    active: true,
    closed: false,
    archived: false,
    endDate: "2026-01-01T12:00:00Z",
    startDate: "2026-01-01T11:50:00Z",
    volumeNum: 50000,
    volume24hr: 1000,
    liquidityNum: 2000,
    spread: 0.02,
    lastTradePrice: 0.54,
    resolutionSource: "https://data.chain.link/streams/btc-usd",
    acceptingOrders: true,
    orderPriceMinTickSize: 0.001,
    orderMinSize: 5,
  };

  it("parses a full market object", () => {
    const parsed = GammaMarketSchema.parse(rawMarket);
    expect(parsed.id).toBe("123");
    expect(parsed.outcomes).toEqual(["Up", "Down"]);
    expect(parsed.outcomePrices).toEqual([0.55, 0.45]);
    expect(parsed.clobTokenIds).toEqual(["tok1", "tok2"]);
  });

  it("toMarket converts to app-level type", () => {
    const parsed = GammaMarketSchema.parse(rawMarket);
    const market = toMarket(parsed);
    expect(market.id).toBe("123");
    expect(market.outcomes).toHaveLength(2);
    expect(market.outcomes[0]).toEqual({
      label: "Up",
      price: 0.55,
      tokenId: "tok1",
    });
    expect(market.endDate).toBeInstanceOf(Date);
  });
});
