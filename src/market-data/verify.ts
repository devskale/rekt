/**
 * Live smoke test — calls the real Polymarket Gamma API.
 * Run: npx tsx src/market-data/verify.ts
 */

import { fetchActiveMarkets, fetchBtc5minMarkets, fetchMarkets, fetchMarket } from "./client.js";

async function main() {
  console.log("=== 1. Fetch a single known BTC market ===");
  try {
    // BTC market from our research (closed, but tests the parser)
    const market = await fetchMarket("1822773");
    console.log(`  Question:  ${market.question}`);
    console.log(`  Outcomes:  ${market.outcomes.map((o) => `${o.label}@${o.price}`).join(", ")}`);
    console.log(`  Active:    ${market.active}`);
    console.log(`  Closed:    ${market.closed}`);
    console.log(`  Volume:    $${market.volume.toLocaleString()}`);
    console.log(`  End:       ${market.endDate.toISOString()}`);
    console.log(`  Source:    ${market.resolutionSource}`);
  } catch (err) {
    console.error("  Failed:", err instanceof Error ? err.message : err);
  }

  console.log("\n=== 2. Fetch active tradeable markets ===");
  try {
    const activeMarkets = await fetchActiveMarkets();
    if (activeMarkets.length === 0) {
      console.log("  No active tradeable markets right now.");
    }
    for (const m of activeMarkets.slice(0, 10)) {
      console.log(`  ${m.id}: ${m.question.slice(0, 80)}`);
      console.log(`    prices: ${m.outcomes.map((o) => `${o.label}=${o.price}`).join(" ")}`);
      console.log(`    vol24h=$${m.volume24hr.toLocaleString()}  spread=${m.spread}`);
    }
  } catch (err) {
    console.error("  Failed:", err instanceof Error ? err.message : err);
  }

  console.log("\n=== 3. Fetch BTC 5-min markets ===");
  try {
    const btcMarkets = await fetchBtc5minMarkets();
    console.log(`  Found ${btcMarkets.length} BTC 5-min market(s)`);
    for (const m of btcMarkets.slice(0, 5)) {
      console.log(`    ${m.id}: ${m.question.slice(0, 60)}`);
      console.log(`      prices: ${m.outcomes.map((o) => `${o.label}=${o.price}`).join(" ")} accepting=${m.acceptingOrders}`);
    }
  } catch (err) {
    console.error("  Failed:", err instanceof Error ? err.message : err);
  }

  console.log("\n=== 4. Explore all markets (first 10) ===");
  try {
    const markets = await fetchMarkets({ active: true, closed: false }, 1);
    for (const m of markets.slice(0, 10)) {
      const prices = m.outcomes.map((o) => `${o.label}=${o.price.toFixed(2)}`).join(" ");
      console.log(`  ${m.id}: ${m.question.slice(0, 70)}`);
      console.log(`    ${prices}  vol=$${m.volume24hr?.toLocaleString() ?? 0}`);
    }
  } catch (err) {
    console.error("  Failed:", err instanceof Error ? err.message : err);
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
