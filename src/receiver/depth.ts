import { logger } from "../logger.js";

// ── Compressed CLOB order-book depth ────────────────────────────────
//
// Fetches the Polymarket CLOB order book for a token and reduces it to a
// handful of summary numbers (NOT the full ladder). This keeps records
// small and stable while still capturing the depth profile we care about.

const CLOB_BOOK_URL = "https://clob.polymarket.com/book";

export interface DepthSummary {
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  /** Sum of ask sizes priced <= 0.95. */
  askDepth95: number | null;
  /** Sum of ask sizes priced <= 0.99. */
  askDepth99: number | null;
  /** Sum of bid sizes priced >= 0.05. */
  bidDepth05: number | null;
  /** Sum of bid sizes priced >= 0.01. */
  bidDepth01: number | null;
}

interface BookLevel {
  price: string;
  size: string;
}

interface BookResponse {
  bids?: BookLevel[];
  asks?: BookLevel[];
}

const NULL_DEPTH: DepthSummary = {
  bestBid: null,
  bestAsk: null,
  spread: null,
  askDepth95: null,
  askDepth99: null,
  bidDepth05: null,
  bidDepth01: null,
};

/** Fetch + compress order-book depth for a CLOB token id. Never throws. */
export async function fetchDepth(tokenId: string): Promise<DepthSummary> {
  if (!tokenId) return NULL_DEPTH;
  try {
    const url = `${CLOB_BOOK_URL}?token_id=${encodeURIComponent(tokenId)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        "receiver:depth",
        `book fetch failed for ${tokenId}: ${res.status} ${body.slice(0, 120)}`,
      );
      return NULL_DEPTH;
    }
    const raw = (await res.json()) as BookResponse;
    return computeDepth(raw);
  } catch (err) {
    logger.warn("receiver:depth", `book fetch error for ${tokenId}`, err);
    return NULL_DEPTH;
  }
}

function computeDepth(book: BookResponse): DepthSummary {
  const bids = book.bids ?? [];
  const asks = book.asks ?? [];

  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  let askDepth95 = 0;
  let askDepth99 = 0;
  let bidDepth05 = 0;
  let bidDepth01 = 0;

  for (const lvl of asks) {
    const p = parseFloat(lvl.price);
    const s = parseFloat(lvl.size);
    if (!Number.isFinite(p) || !Number.isFinite(s)) continue;
    if (bestAsk === null || p < bestAsk) bestAsk = p;
    if (p <= 0.95) askDepth95 += s;
    if (p <= 0.99) askDepth99 += s;
  }

  for (const lvl of bids) {
    const p = parseFloat(lvl.price);
    const s = parseFloat(lvl.size);
    if (!Number.isFinite(p) || !Number.isFinite(s)) continue;
    if (bestBid === null || p > bestBid) bestBid = p;
    if (p >= 0.05) bidDepth05 += s;
    if (p >= 0.01) bidDepth01 += s;
  }

  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

  return {
    bestBid,
    bestAsk,
    spread,
    askDepth95,
    askDepth99,
    bidDepth05,
    bidDepth01,
  };
}
