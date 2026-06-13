export {
  fetchMarket,
  fetchActiveMarkets,
  fetchBtc5minMarkets,
  fetchBtcMarkets,
  fetchMarkets,
} from "./client.js";
export type { Market, MarketOutcome, GammaMarket, GammaEvent } from "./types.js";
export { toMarket, GammaMarketSchema, GammaEventSchema } from "./types.js";
