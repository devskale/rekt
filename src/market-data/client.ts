import { z } from "zod";
import { GammaMarketSchema, GammaEventSchema, toMarket } from "./types.js";
import type { Market, GammaMarket, GammaEvent } from "./types.js";
import { logger } from "../logger.js";

// ── Config ──────────────────────────────────────────────────────────
const BASE_URL =
  process.env.POLYMARKET_API_URL ?? "https://gamma-api.polymarket.com";

/** Minimum 24h volume for a market to be considered tradeable. */
const MIN_VOLUME_24H = 100;

// ── Generic fetcher with error handling ─────────────────────────────
async function apiFetch<T>(
  path: string,
  params: Record<string, string | number | boolean> = {},
  schema: z.ZodType<T>,
): Promise<T> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const label = `GET ${url.pathname}${url.search}`;
  logger.info("market-data", label);

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `API error ${res.status} on ${label}: ${body.slice(0, 200)}`,
    );
  }

  const raw: unknown = await res.json();
  return schema.parse(raw);
}

// ── Keyset response schema ──────────────────────────────────────────

const KeysetMarketsResponseSchema = z.object({
  markets: z.array(GammaMarketSchema),
  next_cursor: z.string().optional(),
});

// ── Fetch a single market by ID ─────────────────────────────────────
export async function fetchMarket(id: string): Promise<Market> {
  const raw = await apiFetch<GammaMarket>(
    `/markets/${encodeURIComponent(id)}`,
    {},
    GammaMarketSchema,
  );
  return toMarket(raw);
}

// ── Fetch BTC 5-min up/down markets ─────────────────────────────────

/**
 * Find BTC 5-minute "Up or Down" markets.
 *
 * These markets have slug `btc-updown-5m-{unix_ts}` where the timestamp
 * is aligned to 300-second (5-min) intervals. We compute the current,
 * previous, and next window timestamps and fetch each by slug directly.
 *
 * No search needed — the slug pattern is fully predictable.
 */
export async function fetchBtc5minMarkets(): Promise<Market[]> {
  const WINDOW = 300; // 5 minutes in seconds
  const nowSec = Math.floor(Date.now() / 1000);
  const currentWindow = Math.floor(nowSec / WINDOW) * WINDOW;

  // Check prev, current, and next windows
  const timestamps = [
    currentWindow - WINDOW, // previous window (may still be open)
    currentWindow,          // current window
    currentWindow + WINDOW, // next window (may already be created)
  ];

  const markets: Market[] = [];
  const seen = new Set<string>();

  // Non-keyset /markets?slug=X returns an array
  const SlugMarketsResponseSchema = z.array(GammaMarketSchema);

  for (const ts of timestamps) {
    const slug = `btc-updown-5m-${ts}`;
    try {
      const raw = await apiFetch<z.infer<typeof SlugMarketsResponseSchema>>(
        `/markets`,
        { keyset: "false", limit: 1, slug },
        SlugMarketsResponseSchema,
      );

      for (const m of raw) {
        if (m.active && !m.closed && !seen.has(m.id)) {
          seen.add(m.id);
          markets.push(toMarket(m));
        }
      }
    } catch {
      // Market doesn't exist yet, expired, or geo-restricted — skip silently
    }
  }

  logger.info(
    "market-data",
    `Found ${markets.length} active BTC 5-min market(s)`,
  );
  for (const m of markets) {
    logger.info(
      "market-data",
      `BTC 5-min market found: ${m.question} prices=${m.outcomes.map((o) => `${o.label}=${o.price}`).join(" ")}`,
    );
  }
  return markets;
}

// ── Fetch active tradeable markets (general) ────────────────────────

/**
 * Fetch active, non-closed binary markets from Polymarket.
 *
 * Filters:
 *   - active=true, closed=false
 *   - Exactly 2 outcomes (binary)
 *   - outcomePrices are valid (not all zero)
 *   - volume24hr above a minimum threshold (liquid enough)
 *
 * Markets closer to 50/50 are prioritised (higher price volatility
 * = more interesting for strategy signals).
 */
export async function fetchActiveMarkets(limit = 20): Promise<Market[]> {
  const data = await apiFetch(
    `/markets/keyset`,
    { limit, active: "true", closed: "false" },
    KeysetMarketsResponseSchema,
  );

  const candidates: { market: Market; interest: number }[] = [];

  for (const raw of data.markets) {
    const market = toMarket(raw);

    // Must be binary (2 outcomes)
    if (market.outcomes.length !== 2) continue;

    // Must have valid prices
    const prices = market.outcomes.map((o) => o.price);
    if (prices.some((p) => p <= 0 || p > 1)) continue;

    // Must have some volume
    if (market.volume24hr < MIN_VOLUME_24H) continue;

    // Interest score: closer to 0.50 = more interesting (higher volatility)
    const yesPrice = prices[0];
    const interest = 1 - Math.abs(yesPrice - 0.5) * 2; // 1.0 at 0.50, 0.0 at 0/1

    candidates.push({ market, interest });
  }

  // Sort by interest (most competitive markets first)
  candidates.sort((a, b) => b.interest - a.interest);

  const markets = candidates.map((c) => c.market);

  logger.info(
    "market-data",
    `Found ${markets.length} active tradeable market(s) from ${data.markets.length} fetched`,
  );
  return markets;
}

// ── Fetch BTC markets (legacy alias) ────────────────────────────────

/**
 * Legacy alias — same as fetchBtc5minMarkets().
 */
export const fetchBtcMarkets = fetchBtc5minMarkets;

// ── Fetch markets with keyset pagination (utility) ──────────────────

export async function fetchMarkets(
  params: Record<string, string | number | boolean> = {},
  maxPages = 5,
): Promise<Market[]> {
  const allMarkets: Market[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const p: Record<string, string | number | boolean> = {
      limit: 100,
      ...params,
    };
    if (cursor) p.cursor = cursor;

    const data = await apiFetch(
      `/markets/keyset`,
      p,
      KeysetMarketsResponseSchema,
    );

    for (const raw of data.markets) {
      allMarkets.push(toMarket(raw));
    }

    cursor = data.next_cursor;
    if (!cursor) break;
  }

  return allMarkets;
}
