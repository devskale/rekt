import { Pool, type PoolConfig } from "pg";
import { logger } from "../logger.js";
import type { OddsRecord, SpotRecord } from "./records.js";

// ── PostgreSQL writer (smart batching, non-fatal, transactional) ────
//
// Dual-writes alongside JSONL. Design goals, in priority order:
//   1. NEVER lose data on transient DB errors  → re-queue with retry cap
//   2. NEVER block the capture loop             → every op guarded, fire-and-forget
//   3. Bounded write latency                   → age-of-oldest flush trigger
//   4. Efficient under burst                   → size threshold + single tx/flush
//
// A failed flush re-queues its records (up to MAX_FLUSH_RETRIES) instead of
// dropping them. JSONL remains the always-on safety net regardless.

const MODULE = "receiver:pg";

// ── Tunables ────────────────────────────────────────────────────────
const MAX_BATCH = 50; // flush when ≥ this many rows queued (any stream)
const MAX_AGE_MS = 4000; // …or when the oldest queued row is this old
const TICK_MS = 1000; // how often the flusher evaluates the triggers
const MAX_FLUSH_RETRIES = 3; // re-queue a failed batch this many times, then drop
const WARN_BUFFER = 1000; // log a backpressure warning above this backlog
const MAX_POOL = 5;

// Inline idempotent schema (mirrors db/schema.sql). IF NOT EXISTS makes
// ensureSchema() safe to run on every startup, with no file dependency.
const SCHEMA_DDL = [
  "CREATE TABLE IF NOT EXISTS markets (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, asset TEXT NOT NULL, window_start BIGINT NOT NULL, window_end BIGINT NOT NULL, first_seen TIMESTAMPTZ NOT NULL DEFAULT now(), outcome TEXT, resolved_at TIMESTAMPTZ)",
  "CREATE INDEX IF NOT EXISTS idx_markets_window ON markets (window_start)",
  "CREATE INDEX IF NOT EXISTS idx_markets_asset ON markets (asset, window_start)",
  "CREATE TABLE IF NOT EXISTS odds_ticks (ts BIGINT NOT NULL, market_id TEXT NOT NULL REFERENCES markets(id), seconds_to_close INTEGER, up_price REAL, down_price REAL, up_mid REAL, down_mid REAL, up_best_bid REAL, up_best_ask REAL, up_spread REAL, up_ask_depth_95 REAL, up_ask_depth_99 REAL, up_bid_depth_05 REAL, up_bid_depth_01 REAL, down_best_bid REAL, down_best_ask REAL, down_spread REAL, down_ask_depth_95 REAL, down_ask_depth_99 REAL, down_bid_depth_05 REAL, down_bid_depth_01 REAL, PRIMARY KEY (market_id, ts))",
  "CREATE INDEX IF NOT EXISTS idx_odds_ts ON odds_ticks (ts)",
  "CREATE TABLE IF NOT EXISTS spot_ticks (ts BIGINT NOT NULL, asset TEXT NOT NULL, price REAL NOT NULL, source TEXT NOT NULL DEFAULT 'binance', PRIMARY KEY (asset, ts))",
  "CREATE INDEX IF NOT EXISTS idx_spot_ts ON spot_ticks (ts)",
].join("; ");

// ── Env helpers ─────────────────────────────────────────────────────
function envStr(key: string, def: string): string {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : def;
}
function envNum(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** DATABASE_URL takes precedence; else per-key env with Pi5 unix-socket defaults. */
function buildPoolConfig(): PoolConfig {
  const url = process.env.DATABASE_URL;
  if (url && url.trim()) return { connectionString: url.trim(), max: MAX_POOL };
  return {
    user: envStr("PGUSER", "pi"),
    database: envStr("PGDATABASE", "rekt"),
    host: envStr("PGHOST", "/var/run/postgresql"),
    port: envNum("PGPORT", 9043),
    max: MAX_POOL,
  };
}

/** Build "($1,..,$c),($c+1,..)" placeholder string for `rows` x `cols`. */
function placeholders(rows: number, cols: number, offset = 1): string {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    out.push("(" + Array.from({ length: cols }, (_, c) => `$${offset + r * cols + c}`).join(",") + ")");
  }
  return out.join(",");
}

/** Redact any password in a config for log output. */
function describeConfig(c: PoolConfig): string {
  if (c.connectionString) return c.connectionString.replace(/:[^:@/]+@/, ":***@");
  return `${c.user ?? "?"}@${c.host ?? "?"}:${c.port ?? "?"}/${c.database ?? "?"}`;
}

// ── A queued record carries retry state so failed flushes can re-enqueue. ──
interface Queued<T> {
  rec: T;
  arrived: number; // ms — when it entered the buffer (for age trigger)
  retries: number;
}

export class PgWriter {
  private pool: Pool | null = null;
  private initPromise: Promise<void> | null = null;
  private disabled = false;
  private flushing = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly poolConfig: PoolConfig;
  private oddsBuffer: Queued<OddsRecord>[] = [];
  private spotBuffer: Queued<SpotRecord>[] = [];
  private overflowWarned = false;

  // ── Stats (read by index.ts summary line) ──
  connected = false;
  totalWritten = 0; // rows successfully committed
  errors = 0; // flush attempts that failed (may have been retried)
  dropped = 0; // rows lost after exceeding MAX_FLUSH_RETRIES
  get pending(): number {
    return this.oddsBuffer.length + this.spotBuffer.length;
  }

  constructor(poolConfig: PoolConfig = buildPoolConfig()) {
    this.poolConfig = poolConfig;
  }

  /** Lazy, idempotent init. Resolves immediately after the first call. */
  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      this.pool = new Pool(this.poolConfig);
      await this.pool.query(SCHEMA_DDL);
      this.connected = true;
      this.flushTimer = setInterval(() => this.maybeFlush(), TICK_MS);
      logger.info(MODULE, `connected (${describeConfig(this.poolConfig)})`);
    } catch (err) {
      this.connected = false;
      this.disabled = true;
      logger.warn(MODULE, "init failed; PG disabled for this run (JSONL continues)", err);
    }
  }

  /** Buffer an odds record; the flusher drains on size/age triggers. */
  async ingestOdds(rec: OddsRecord): Promise<void> {
    if (this.disabled) return;
    await this.init();
    if (this.disabled || !this.pool) return;
    this.oddsBuffer.push({ rec, arrived: Date.now(), retries: 0 });
    this.noteBackpressure();
    void this.maybeFlush();
  }

  /** Buffer a spot record; the flusher drains on size/age triggers. */
  async ingestSpot(rec: SpotRecord): Promise<void> {
    if (this.disabled) return;
    await this.init();
    if (this.disabled || !this.pool) return;
    this.spotBuffer.push({ rec, arrived: Date.now(), retries: 0 });
    this.noteBackpressure();
    void this.maybeFlush();
  }

  private noteBackpressure(): void {
    if (this.pending > WARN_BUFFER && !this.overflowWarned) {
      this.overflowWarned = true;
      logger.warn(MODULE, `buffer backlog=${this.pending} (DB slow?); capturing continues, JSONL intact`);
    }
  }

  // ── Flush triggers: size OR age-of-oldest ─────────────────────────
  private maybeFlush(): void {
    if (this.flushing || !this.pool || this.disabled) return;
    const total = this.pending;
    if (total === 0) return;
    if (total >= MAX_BATCH) {
      void this.flush();
      return;
    }
    const oldest = Math.min(
      this.oddsBuffer[0]?.arrived ?? Infinity,
      this.spotBuffer[0]?.arrived ?? Infinity,
    );
    if (Date.now() - oldest >= MAX_AGE_MS) void this.flush();
  }

  // ── Flush: drain under guard → one transaction → re-queue on failure ──
  private async flush(): Promise<void> {
    if (this.flushing || !this.pool) return;
    this.flushing = true;
    const odds = this.oddsBuffer.splice(0);
    const spot = this.spotBuffer.splice(0);
    if (!odds.length && !spot.length) {
      this.flushing = false;
      return;
    }
    try {
      await this.writeAll(odds.map((q) => q.rec), spot.map((q) => q.rec));
      this.totalWritten += odds.length + spot.length;
    } catch (err) {
      this.errors++;
      const reQ = <T>(q: Queued<T>): boolean => q.retries < MAX_FLUSH_RETRIES;
      const requeuedOdds = this.requeue(odds, this.oddsBuffer);
      const requeuedSpot = this.requeue(spot, this.spotBuffer);
      const lost = odds.length + spot.length - requeuedOdds - requeuedSpot;
      this.dropped += lost;
      logger.warn(
        MODULE,
        `flush failed: re-queued ${requeuedOdds} odds + ${requeuedSpot} spot (retry), dropped ${lost} after >${MAX_FLUSH_RETRIES} retries`,
        err,
      );
    } finally {
      this.flushing = false;
    }
  }

  /** Re-enqueue records under their retry cap; return how many were kept. */
  private requeue<T>(drained: Queued<T>[], buf: Queued<T>[]): number {
    let kept = 0;
    for (const q of drained) {
      if (q.retries >= MAX_FLUSH_RETRIES) continue; // permanent drop
      buf.push({ rec: q.rec, arrived: q.arrived, retries: q.retries + 1 });
      kept++;
    }
    return kept;
  }

  /** Single transaction: market UPSERT → odds INSERT → spot INSERT. Atomic. */
  private async writeAll(odds: OddsRecord[], spot: SpotRecord[]): Promise<void> {
    const pool = this.pool!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1) UPSERT distinct markets (FK parent; must precede ticks).
      const byId = new Map<string, OddsRecord>();
      for (const r of odds) if (!byId.has(r.market_id)) byId.set(r.market_id, r);
      if (byId.size) {
        const mkts = [...byId.values()];
        const mRows = mkts
          .map((_, i) => `($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5},now())`)
          .join(",");
        const mParams: (string | number)[] = mkts.flatMap((m) => [
          m.market_id, m.slug, m.asset, m.window_start, m.window_end,
        ]);
        await client.query(
          "INSERT INTO markets (id,slug,asset,window_start,window_end,first_seen) VALUES " +
            mRows + " ON CONFLICT (id) DO NOTHING",
          mParams,
        );
      }

      // 2) INSERT odds ticks (idempotent).
      if (odds.length) {
        const tRows = placeholders(odds.length, 21);
        const tParams: (string | number | null)[] = odds.flatMap((r) => [
          r.ts, r.market_id, r.seconds_to_close, r.up_price, r.down_price, r.up_mid, r.down_mid,
          r.up_best_bid, r.up_best_ask, r.up_spread, r.up_ask_depth_95, r.up_ask_depth_99, r.up_bid_depth_05, r.up_bid_depth_01,
          r.down_best_bid, r.down_best_ask, r.down_spread, r.down_ask_depth_95, r.down_ask_depth_99, r.down_bid_depth_05, r.down_bid_depth_01,
        ]);
        await client.query(
          "INSERT INTO odds_ticks (ts,market_id,seconds_to_close,up_price,down_price,up_mid,down_mid,up_best_bid,up_best_ask,up_spread,up_ask_depth_95,up_ask_depth_99,up_bid_depth_05,up_bid_depth_01,down_best_bid,down_best_ask,down_spread,down_ask_depth_95,down_ask_depth_99,down_bid_depth_05,down_bid_depth_01) VALUES " +
            tRows + " ON CONFLICT (market_id,ts) DO NOTHING",
          tParams,
        );
      }

      // 3) INSERT spot ticks (idempotent).
      if (spot.length) {
        const sRows = placeholders(spot.length, 4);
        const sParams: (string | number)[] = spot.flatMap((r) => [r.ts, r.asset, r.price, r.source]);
        await client.query(
          "INSERT INTO spot_ticks (ts,asset,price,source) VALUES " + sRows + " ON CONFLICT (asset,ts) DO NOTHING",
          sParams,
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // connection may already be broken; the outer catch handles reporting
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pool) return;
    try {
      await this.flush(); // drain any buffered rows before shutdown
    } catch {
      // flush() already logged
    }
    try {
      await this.pool.end();
    } catch (err) {
      logger.warn(MODULE, "pool.end() error", err);
    }
    this.connected = false;
  }
}
