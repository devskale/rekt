/**
 * rekt — outcome sweeper
 *
 * Tags resolved windows with their outcome (UP/DOWN) by deriving it from the
 * BTC spot ticks we already capture. A window resolves UP iff the BTC price at
 * window_end >= window_start (matches the Chainlink oracle definition).
 *
 * Idempotent + one-shot. Run: pnpm sweep
 *
 * Why spot-derivation (not Gamma's resolved outcomePrices): it's free (no new
 * API calls), we already capture spot continuously, and it's the true economic
 * outcome. If no spot tick exists within ±TOL of either boundary, mark the
 * outcome 'unknown' rather than silently faking a resolution.
 */
import "dotenv/config";
import { Pool } from "pg";

const PORT = parseInt(process.env.PGPORT ?? "9043", 10);
const pool = new Pool({
  user: process.env.PGUSER ?? "pi",
  database: process.env.PGDATABASE ?? "rekt",
  host: process.env.PGHOST ?? "/var/run/postgresql",
  port: PORT,
  max: 3,
});

/** Tolerance: how far from a window boundary we'll accept a spot tick (ms). */
const TOL_MS = 2_000;

async function nearestSpot(sec: number): Promise<number | null> {
  // ts is in ms; spot_ticks.ts is ms. Find closest within ±TOL.
  const targetMs = sec * 1000;
  const r = await pool.query(
    `SELECT price,
            abs(ts - $1) AS dist
     FROM spot_ticks
     WHERE asset = 'btc' AND ts BETWEEN $1 - $2 AND $1 + $2
     ORDER BY dist ASC
     LIMIT 1`,
    [targetMs, TOL_MS],
  );
  const row = r.rows[0];
  return row ? Number(row.price) : null;
}

async function main() {
  const client = await pool.connect();
  try {
    // Resolve (or backfill) every market whose window has ended but has no outcome.
    // Skip the *current* live window (window_end > now) — it isn't decided yet.
    const pending = await client.query(
      `SELECT id, slug, asset, window_start, window_end
       FROM markets
       WHERE outcome IS NULL
         AND window_end <= floor(extract(epoch from now()))::bigint
       ORDER BY window_start ASC`,
    );
    console.log(`sweeper: ${pending.rowCount} resolved windows to tag`);

    let up = 0, down = 0, unknown = 0;
    for (const m of pending.rows) {
      const startPrice = await nearestSpot(m.window_start);
      const endPrice = await nearestSpot(m.window_end);

      let outcome: "up" | "down" | "unknown";
      if (startPrice == null || endPrice == null) {
        outcome = "unknown";
      } else {
        outcome = endPrice >= startPrice ? "up" : "down";
      }

      await client.query(
        `UPDATE markets SET outcome = $1, resolved_at = now()
         WHERE id = $2`,
        [outcome, m.id],
      );
      if (outcome === "up") up++;
      else if (outcome === "down") down++;
      else unknown++;
    }

    console.log(`sweeper: tagged ${up} UP, ${down} DOWN, ${unknown} unknown (of ${pending.rowCount})`);

    // Quick distribution report
    const dist = await client.query(
      `SELECT outcome, count(*) AS n FROM markets GROUP BY outcome ORDER BY outcome`,
    );
    console.log("sweeper: outcome distribution:");
    for (const r of dist.rows) console.log(`  ${r.outcome ?? "(null)"}: ${r.n}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("sweeper: fatal:", e);
  process.exit(1);
});
