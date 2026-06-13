// ── rektDBfiller receiver config ────────────────────────────────────
//
// Env-driven config. All keys overridable via process.env. Defaults are
// tuned for capturing BTC 5-min up/down markets with spot confirmation.

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

/** Parse a comma list or JSON array from env. */
function envList(key: string, def: string[]): string[] {
  const v = process.env[key];
  if (!v || !v.trim()) return def;
  const trimmed = v.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
      }
    } catch {
      // fall through to comma parsing
    }
  }
  return trimmed
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export interface ReceiverConfig {
  /** Assets to capture. Only "btc" implemented; adding "eth" is one branch. */
  assets: string[];
  /** Base poll interval (ms) between odds ticks. */
  pollMs: number;
  /** Aggressive poll interval (ms) used near window close. */
  turboMs: number;
  /** Switch to turbo poll when within this many seconds of window end. */
  turboLastSeconds: number;
  /** Root directory for JSONL cache (gitignored). */
  dataDir: string;
  /** How often to log a stats summary line (ms). */
  statsIntervalMs: number;
}

export const config: ReceiverConfig = {
  assets: envList("RECEIVER_ASSETS", ["btc"]),
  pollMs: envNum("RECEIVER_POLL_MS", 5000),
  turboMs: envNum("RECEIVER_TURBO_MS", 2000),
  turboLastSeconds: envNum("RECEIVER_TURBO_LAST_SECONDS", 90),
  dataDir: envStr("RECEIVER_DATA_DIR", "./data"),
  statsIntervalMs: envNum("RECEIVER_STATS_INTERVAL_MS", 30000),
};
