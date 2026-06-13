import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";
import { config } from "./config.js";

// ── JSONL cache writer ──────────────────────────────────────────────
//
// Appends one record per line to daily JSONL files under the data dir.
// Path pattern: {DATA_DIR}/{stream}/{YYYY-MM-DD}.jsonl
// Auto-rotates by date (UTC) because the filename embeds the day.

export type StreamName = "odds" | "spot";

/** Append a single record as one JSONL line. Never throws. */
export function appendRecord<T extends object>(
  stream: StreamName,
  record: T,
): void {
  try {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const dir = join(config.dataDir, stream);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${date}.jsonl`);
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch (err) {
    logger.error("receiver:writer", `Failed to append ${stream} record`, err);
  }
}
