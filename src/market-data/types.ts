import { z } from "zod";

/**
 * Zod schemas for Polymarket Gamma API responses.
 *
 * The Gamma API returns outcome/price data as JSON-encoded strings,
 * so we parse those into native arrays with .transform().
 */

// ── Outcome Prices ──────────────────────────────────────────────────
export const OutcomePricesSchema = z
  .string()
  .transform((s, ctx) => {
    try {
      const parsed: unknown[] = JSON.parse(s);
      return parsed.map((v) => Number(v));
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid outcomePrices JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.number()));

export const OutcomeLabelsSchema = z
  .string()
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as string[];
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid outcomes JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.string()));

export const TokenIdsSchema = z
  .string()
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as string[];
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid clobTokenIds JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.string()));

// ── Market (from /markets or /events/:id markets[]) ────────────────
export const GammaMarketSchema = z.object({
  id: z.string(),
  question: z.string(),
  slug: z.string(),
  conditionId: z.string(),
  outcomes: OutcomeLabelsSchema,
  outcomePrices: OutcomePricesSchema,
  clobTokenIds: TokenIdsSchema,
  active: z.boolean(),
  closed: z.boolean(),
  archived: z.boolean(),
  endDate: z.string(),
  startDate: z.string(),
  volumeNum: z.number(),
  volume24hr: z.number().optional().default(0),
  liquidityNum: z.number().optional().default(0),
  description: z.string().optional().default(""),
  image: z.string().optional().default(""),
  resolutionSource: z.string().optional().default(""),
  acceptingOrders: z.boolean().optional().default(false),
  orderPriceMinTickSize: z.number().optional().default(0.01),
  orderMinSize: z.number().optional().default(5),
  spread: z.number().optional().default(0),
  lastTradePrice: z.number().optional().default(0),
  bestBid: z.number().optional().nullable().default(null),
  bestAsk: z.number().optional().nullable().default(null),
  eventStartTime: z.string().optional().nullable().default(null),
  umaResolutionStatus: z.string().optional().default(""),
});

// ── Event (from /events) ───────────────────────────────────────────
export const GammaEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  active: z.boolean(),
  closed: z.boolean(),
  startDate: z.string(),
  endDate: z.string(),
  markets: z.array(GammaMarketSchema).optional().default([]),
});

// ── Inferred types ──────────────────────────────────────────────────
export type GammaMarket = z.infer<typeof GammaMarketSchema>;
export type GammaEvent = z.infer<typeof GammaEventSchema>;

// ── App-level types (clean view for our engine) ─────────────────────
export interface MarketOutcome {
  label: string;
  price: number; // 0-1 implied probability
  tokenId: string;
}

export interface Market {
  id: string;
  question: string;
  slug: string;
  outcomes: MarketOutcome[];
  active: boolean;
  closed: boolean;
  endDate: Date;
  startDate: Date;
  eventStartTime: Date | null;
  volume: number;
  volume24hr: number;
  liquidity: number;
  spread: number;
  lastTradePrice: number;
  resolutionSource: string;
  acceptingOrders: boolean;
}

/**
 * Convert a raw GammaMarket into our clean Market type.
 */
export function toMarket(raw: GammaMarket): Market {
  const outcomes: MarketOutcome[] = raw.outcomes.map((label, i) => ({
    label,
    price: raw.outcomePrices[i] ?? 0,
    tokenId: raw.clobTokenIds[i] ?? "",
  }));

  return {
    id: raw.id,
    question: raw.question,
    slug: raw.slug,
    outcomes,
    active: raw.active,
    closed: raw.closed,
    endDate: new Date(raw.endDate),
    startDate: new Date(raw.startDate),
    eventStartTime: raw.eventStartTime ? new Date(raw.eventStartTime) : null,
    volume: raw.volumeNum,
    volume24hr: raw.volume24hr,
    liquidity: raw.liquidityNum,
    spread: raw.spread,
    lastTradePrice: raw.lastTradePrice,
    resolutionSource: raw.resolutionSource,
    acceptingOrders: raw.acceptingOrders,
  };
}
