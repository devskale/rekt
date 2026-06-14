-- rektDBfiller v2 migration — book-derived mid as canonical price
-- NON-DESTRUCTIVE: adds columns, preserves all existing rows.
-- Apply with: psql -p 9043 -d rekt -f db/migration-v2.sql

-- Book mid = (best_bid + best_ask) / 2  → the REAL traded price.
-- Gamma's outcomePrices (up_price/down_price) is near-frozen (~0.499)
-- across a window's life; the book moves 20-33 points. Mid is truth.
ALTER TABLE odds_ticks ADD COLUMN IF NOT EXISTS up_mid   REAL;
ALTER TABLE odds_ticks ADD COLUMN IF NOT EXISTS down_mid REAL;

-- Backfill mid for the 10.5h of existing rows from their captured book.
UPDATE odds_ticks
   SET up_mid   = (up_best_bid   + up_best_ask)   / 2.0
     , down_mid = (down_best_bid + down_best_ask) / 2.0
 WHERE up_mid IS NULL AND up_best_bid IS NOT NULL AND up_best_ask IS NOT NULL;

-- Helpful for range queries on the canonical price.
CREATE INDEX IF NOT EXISTS idx_odds_mid ON odds_ticks (ts, up_mid);
