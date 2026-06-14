/**
 * rekt — backtest engine
 *
 * Replays stored odds_ticks + spot_ticks through a Strategy + PaperTrader and
 * scores expectancy against the swept market outcomes. Reuses the existing
 * Strategy interface and PaperTrader UNCHANGED — the only new thing is a
 * DB-replaying source that feeds real book-mid (not frozen Gamma) into the
 * strategies.
 *
 * Run:  pnpm backtest -- --strategy late-scalp --from 2026-06-14 --hours 6
 *       pnpm backtest -- --strategy momentum --asset btc
 *       pnpm backtest -- --all                 # every enabled strategy
 *
 * Fee model defaults to 0 (raw edge first), switchable via --fee (e.g. 0.07).
 */
import "dotenv/config";
import { Pool } from "pg";
import { PaperTrader } from "../engine/paper-trader.js";
import type { Position, Side, StrategyBalance } from "../engine/types.js";
import { FEE_CONFIGS } from "../engine/types.js";
import type { Strategy, Decision, PricePoint } from "../strategies/types.js";
import {
  LateScalpStrategy,
  SnipeStrategy,
  CoinFlipStrategy,
  MomentumStrategy,
} from "../strategies/index.js";
import { clearStrategies, registerDefaults } from "../strategies/registry.js";

// ── config ──────────────────────────────────────────────────────────
const pool = new Pool({
  user: process.env.PGUSER ?? "pi",
  database: process.env.PGDATABASE ?? "rekt",
  host: process.env.PGHOST ?? "/var/run/postgresql",
  port: parseInt(process.env.PGPORT ?? "9043", 10),
  max: 3,
});

interface Args {
  strategy: string | "all";
  asset: string;
  startingCash: number;
  feeRate: number;
  fromMs: number;   // inclusive
  toMs: number;     // inclusive
  positionSize: number; // $ per trade
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string, def: string) => {
    const i = a.indexOf("--" + k);
    return i >= 0 ? a[i + 1] : def;
  };
  const now = Date.now();
  // --from: date (YYYY-MM-DD) or hours-ago (e.g. "6h"); default: 6h ago
  const fromRaw = get("from", "6h");
  let fromMs: number;
  if (/^\d+h$/.test(fromRaw)) fromMs = now - parseInt(fromRaw) * 3600_000;
  else if (/^\d+d$/.test(fromRaw)) fromMs = now - parseInt(fromRaw) * 86400_000;
  else fromMs = Date.parse(fromRaw);
  if (!Number.isFinite(fromMs)) { console.error("bad --from"); process.exit(2); }

  const toRaw = get("to", "now");
  const toMs = toRaw === "now" ? now : (Date.parse(toRaw) || now);

  return {
    strategy: get("strategy", "late-scalp") as string | "all",
    asset: get("asset", "btc"),
    startingCash: Number(get("capital", "1000")),
    feeRate: Number(get("fee", "0")),
    fromMs, toMs,
    positionSize: Number(get("size", "50")),
  };
}

// ── data loading ────────────────────────────────────────────────────
interface ResolvedMarket {
  id: string; slug: string; asset: string;
  windowStart: number; windowEnd: number; outcome: "up" | "down" | "unknown" | null;
}

interface Tick {
  ts: number; secondsToClose: number;
  upMid: number | null; downMid: number | null;
  upAsk: number | null; downAsk: number | null;
}

async function loadMarkets(args: Args): Promise<ResolvedMarket[]> {
  const r = await pool.query(
    `SELECT id, slug, asset, window_start, window_end, outcome
     FROM markets
     WHERE asset = $1
       AND window_end BETWEEN $2/1000 AND $3/1000
       AND outcome IN ('up','down')          -- only score windows we can settle
     ORDER BY window_start ASC`,
    [args.asset, args.fromMs, args.toMs],
  );
  return r.rows;
}

async function loadTicks(market: ResolvedMarket): Promise<Tick[]> {
  const r = await pool.query(
    `SELECT ts, seconds_to_close, up_mid, down_mid, up_best_ask, down_best_ask
     FROM odds_ticks
     WHERE market_id = $1 AND ts < $2 * 1000  -- only while window was live
     ORDER BY ts ASC`,
    [market.id, market.windowEnd],
  );
  return r.rows;
}

// ── strategy registry ───────────────────────────────────────────────
function buildStrategies(which: string): Strategy[] {
  clearStrategies();
  registerDefaults();
  if (which === "all") {
    const { getEnabledStrategies } = require("../strategies/registry.js");
    return getEnabledStrategies();
  }
  const { getStrategy } = require("../strategies/registry.js");
  const s = getStrategy(which);
  if (!s) { console.error("unknown strategy:", which); process.exit(2); }
  return [s];
}

// ── the replay ──────────────────────────────────────────────────────

/**
 * Run ONE strategy across the resolved windows. For each tick in each window,
 * build a MarketContext (mid as outcome price; recentPrices = the UP-mid
 * history seen so far in this window) and let the strategy decide.
 * One position per (strategy × market). Settle at window_end vs outcome.
 */
async function runStrategy(
  strategy: Strategy,
  markets: ResolvedMarket[],
  args: Args,
): Promise<StrategyBalance> {
  const trader = new PaperTrader({
    startingCash: args.startingCash,
    feeConfig: { takerFeeRate: args.feeRate, makerFeeRate: 0 },
  });

  let trades = 0;
  const openPositionMarketIds = new Set<string>();

  for (const m of markets) {
    const ticks = await loadTicks(m);
    if (ticks.length === 0) continue;
    openPositionMarketIds.clear();

    // Build recentPrices progressively (UP-side mid) so Momentum sees a real trend
    const recentPrices: PricePoint[] = [];

    for (const t of ticks) {
      // Use mid as the canonical price; fall back to ask then null
      const upPrice = t.upMid ?? t.upAsk;
      const downPrice = t.downMid ?? t.downAsk;
      if (upPrice == null || downPrice == null) continue;

      recentPrices.push({ price: upPrice, timestamp: t.ts });

      if (openPositionMarketIds.has(m.id)) continue; // already in this window

      const market = {
        id: m.id, question: m.slug, slug: m.slug,
        outcomes: [
          { label: "Up", price: upPrice, tokenId: "" },
          { label: "Down", price: downPrice, tokenId: "" },
        ],
        active: true, closed: false,
        startDate: new Date(m.windowStart * 1000),
        endDate: new Date(m.windowEnd * 1000),
        eventStartTime: new Date(m.windowStart * 1000),
        volume: 0, volume24hr: 0, liquidity: 0, spread: 0,
        lastTradePrice: upPrice, resolutionSource: "",
        acceptingOrders: true,
      };

      const ctx = {
        market,
        recentPrices: recentPrices.slice(-30),
        timeRemainingFraction: Math.max(0, t.secondsToClose / 300),
        secondsToClose: t.secondsToClose,
        openPositionMarketIds,
      };

      let decision: Decision | null = null;
      try { decision = strategy.decide(ctx); } catch { /* never crash the run */ }
      if (!decision) continue;

      // Entry price = the side's mid (realistic-ish; depth simulator later)
      const entry = decision.side === "YES" ? upPrice : downPrice;
      if (entry <= 0 || entry >= 1) continue;
      const qty = Math.max(1, Math.round(args.positionSize / entry));

      try {
        trader.openPosition(strategy.config.name, m.id, decision.side, entry, qty);
        openPositionMarketIds.add(m.id);
        trades++;
      } catch {
        // insufficient funds — keep going (other strategies may still trade)
      }
    }

    // Settle this window vs ground-truth outcome (1 trade max per window)
    const winningSide: Side = m.outcome === "up" ? "YES" : "NO";
    trader.resolveMarket(m.id, winningSide);
  }

  const bal = trader.getBalance(strategy.config.name);
  console.log(`\n── ${strategy.config.name} ──────────────────────────────`);
  console.log(`  windows scored: ${markets.length}   trades opened: ${trades}`);
  printBalance(bal);
  return bal;
}

function printBalance(b: StrategyBalance): void {
  const pnl = b.totalPnL;
  const roi = (pnl / b.cash + pnl) * 100; // rough ROI vs starting cash proxy
  console.log(`  resolved:    ${b.resolvedCount} trades`);
  console.log(`  wins/losses: ${b.winCount}/${b.lossCount}  (win rate ${(b.winRate * 100).toFixed(1)}%)`);
  console.log(`  realized P&L: $${b.realizedPnL.toFixed(2)}`);
  console.log(`  total P&L:    $${pnl.toFixed(2)}  (~${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%)`);
}

// ── main ────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs();
  console.log("rekt backtest");
  console.log(`  asset: ${args.asset}   capital: $${args.startingCash}   fee: ${args.feeRate}   size: $${args.positionSize}/trade`);
  console.log(`  window: ${new Date(args.fromMs).toISOString()} → ${new Date(args.toMs).toISOString()}`);
  console.log(`  fee model: ${args.feeRate === 0 ? "OFF (raw edge)" : FEE_CONFIGS.crypto.takerFeeRate === args.feeRate ? "crypto taker (0.07)" : "custom"}`);

  const markets = await loadMarkets(args);
  console.log(`  resolved windows available: ${markets.length}`);
  if (markets.length === 0) {
    console.log("  (no scored windows in range — run `pnpm sweep` first, or widen --from)");
    await pool.end();
    return;
  }

  const strategies = buildStrategies(args.strategy);
  const results: { name: string; bal: StrategyBalance }[] = [];
  for (const s of strategies) {
    const bal = await runStrategy(s, markets, args);
    results.push({ name: s.config.name, bal });
  }

  // Comparison table (when --all)
  if (results.length > 1) {
    console.log("\n=== comparison ===");
    for (const r of results) {
      const b = r.bal;
      console.log(`  ${(r.name + ":").padEnd(16)} P&L $${b.realizedPnL.toFixed(2).padStart(8)}  win ${(b.winRate * 100).toFixed(0).padStart(3)}%  (${b.winCount}W/${b.lossCount}L)`);
    }
  }

  await pool.end();
}

main().catch((e) => { console.error("backtest fatal:", e); process.exit(1); });
