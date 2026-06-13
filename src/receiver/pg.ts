import { Pool, type PoolConfig } from "pg";
import { logger } from "../logger.js";
import type { OddsRecord, SpotRecord } from "./records.js";

// ── PostgreSQL writer (batched, non-fatal) ──────────────────────────
// Dual-writes alongside JSONL. Every op is guarded: a PG failure logs and
// the capture loop continues — JSONL remains the always-on safety net.

const MODULE = "receiver:pg";
const BATCH_SIZE = 50;
const FLUSH_MS = 5000;
const MAX_POOL = 5;

// Inline idempotent schema (mirrors db/schema.sql). IF NOT EXISTS makes
// ensureSchema() safe to run on every startup, with no file dependency.
const SCHEMA_DDL = [
  "CREATE TABLE IF NOT EXISTS markets (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, asset TEXT NOT NULL, window_start BIGINT NOT NULL, window_end BIGINT NOT NULL, first_seen TIMESTAMPTZ NOT NULL DEFAULT now(), outcome TEXT, resolved_at TIMESTAMPTZ)",
  "CREATE INDEX IF NOT EXISTS idx_markets_window ON markets (window_start)",
  "CREATE INDEX IF NOT EXISTS idx_markets_asset ON markets (asset, window_start)",
  "CREATE TABLE IF NOT EXISTS odds_ticks (ts BIGINT NOT NULL, market_id TEXT NOT NULL REFERENCES markets(id), seconds_to_close INTEGER, up_price REAL, down_price REAL, up_best_bid REAL, up_best_ask REAL, up_spread REAL, up_ask_depth_95 REAL, up_ask_depth_99 REAL, up_bid_depth_05 REAL, up_bid_depth_01 REAL, down_best_bid REAL, down_best_ask REAL, down_spread REAL, down_ask_depth_95 REAL, down_ask_depth_99 REAL, down_bid_depth_05 REAL, down_bid_depth_01 REAL, PRIMARY KEY (market_id, ts))",
  "CREATE INDEX IF NOT EXISTS idx_odds_ts ON odds_ticks (ts)",
  "CREATE TABLE IF NOT EXISTS spot_ticks (ts BIGINT NOT NULL, asset TEXT NOT NULL, price REAL NOT NULL, source TEXT NOT NULL DEFAULT 'binance', PRIMARY KEY (asset, ts))",
  "CREATE INDEX IF NOT EXISTS idx_spot_ts ON spot_ticks (ts)",
].join("; ");

function envStr(key: string, def: string): string {
  const v = process.env[key];
  return v && v.trim() ? (v.trim() as string) : def;
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
    out.push(
      "(" + Array.from({ length: cols }, (_, c) => `$${offset + r * cols + c}`).join(",") + ")",
    );
  }
  return out.join(",");
}

/** Redact any password in a config for log output. */
function describeConfig(c: PoolConfig): string {
  if (c.connectionString) return c.connectionString.replace(/:[^:@/]+@/, ":***@");
  return `${c.user ?? "?"}@${c.host ?? "?"}:${c.port ?? "?"}/${c.database ?? "?"}`;
}
export class PgWriter {
  private pool: Pool | null = null;
  private initPromise: Promise<void> | null = null;
  private disabled = false;
  private flushing = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly poolConfig: PoolConfig;
  private oddsBuffer: OddsRecord[] = [];
  private spotBuffer: SpotRecord[] = [];

  connected = false;
  totalWritten = 0;
  errors = 0;

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
      this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
      logger.info(MODULE, `connected (${describeConfig(this.poolConfig)})`);
    } catch (err) {
      this.connected = false;
      this.disabled = true;
      logger.warn(MODULE, "init failed; PG disabled for this run (JSONL continues)", err);
    }
  }

  /** Buffer an odds record; flush when the batch threshold is reached. */
  async ingestOdds(rec: OddsRecord): Promise<void> {
    if (this.disabled) return;
    await this.init();
    if (this.disabled || !this.pool) return;
    this.oddsBuffer.push(rec);
    if (this.oddsBuffer.length >= BATCH_SIZE) void this.flush();
  }

  /** Buffer a spot record; flush when the batch threshold is reached. */
  async ingestSpot(rec: SpotRecord): Promise<void> {
    if (this.disabled) return;
    await this.init();
    if (this.disabled || !this.pool) return;
    this.spotBuffer.push(rec);
    if (this.spotBuffer.length >= BATCH_SIZE) void this.flush();
  }

  // ── Flush (guarded; drains both buffers in one shot) ─────────────

  private async flush(): Promise<void> {
    if (this.flushing || !this.pool) return; // no double-flush / pre-init
    this.flushing = true;
    const odds = this.oddsBuffer.splice(0); // drain under guard
    const spot = this.spotBuffer.splice(0);
    try {
      if (odds.length) await this.flushOdds(odds);
      if (spot.length) await this.flushSpot(spot);
      this.totalWritten += odds.length + spot.length;
    } catch (err) {
      this.errors++;
      logger.warn(
        MODULE,
        `flush failed: ${odds.length} odds + ${spot.length} spot dropped from PG (JSONL intact)`,
        err,
      );
    } finally {
      this.flushing = false;
    }
  }

  private async flushOdds(odds: OddsRecord[]): Promise<void> {
    const pool = this.pool!;
    // 1) UPSERT distinct markets — must run before ticks (FK). Idempotent.
    const byId = new Map<string, OddsRecord>();
    for (const r of odds) if (!byId.has(r.market_id)) byId.set(r.market_id, r);
    const markets = [...byId.values()];
    const mRows = markets
      .map((_, i) => `($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5},now())`)
      .join(",");
    const mParams: (string | number)[] = markets.flatMap((m) => [
      m.market_id, m.slug, m.asset, m.window_start, m.window_end,
    ]);
    await pool.query(
      `INSERT INTO markets (id,slug,asset,window_start,window_end,first_seen) VALUES ${mRows} ON CONFLICT (id) DO NOTHING`,
      mParams,
    );
    // 2) INSERT ticks (idempotent).
    const tRows = placeholders(odds.length, 19);
    const tParams: (string | number | null)[] = odds.flatMap((r) => [
      r.ts, r.market_id, r.seconds_to_close, r.up_price, r.down_price,
      r.up_best_bid, r.up_best_ask, r.up_spread, r.up_ask_depth_95, r.up_ask_depth_99, r.up_bid_depth_05, r.up_bid_depth_01,
      r.down_best_bid, r.down_best_ask, r.down_spread, r.down_ask_depth_95, r.down_ask_depth_99, r.down_bid_depth_05, r.down_bid_depth_01,
    ]);
    await pool.query(
      `INSERT INTO odds_ticks (ts,market_id,seconds_to_close,up_price,down_price,up_best_bid,up_best_ask,up_spread,up_ask_depth_95,up_ask_depth_99,up_bid_depth_05,up_bid_depth_01,down_best_bid,down_best_ask,down_spread,down_ask_depth_95,down_ask_depth_99,down_bid_depth_05,down_bid_depth_01) VALUES ${tRows} ON CONFLICT (market_id,ts) DO NOTHING`,
      tParams,
    );
  }

  private async flushSpot(spot: SpotRecord[]): Promise<void> {
    const rows = placeholders(spot.length, 4);
    const params: (string | number)[] = spot.flatMap((r) => [r.ts, r.asset, r.price, r.source]);
    await this.pool!.query(
      `INSERT INTO spot_ticks (ts,asset,price,source) VALUES ${rows} ON CONFLICT (asset,ts) DO NOTHING`,
      params,
    );
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pool) return;
    try {
      await this.flush(); // flush any buffered rows
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
