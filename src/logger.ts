import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ── Config ──────────────────────────────────────────────────────────

const LOG_DIR = join(import.meta.dirname, "..", "logs");
const LOG_FILE = join(LOG_DIR, "trading.log");
const RETENTION_DAYS = 7;

// ── Levels ──────────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error";

const LEVEL_COLORS: Record<LogLevel, string> = {
  info: "\x1b[36m",  // cyan
  warn: "\x1b[33m",  // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

// ── Init ────────────────────────────────────────────────────────────

function ensureLogDir(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // already exists
  }
}

function rotateOldLogs(): void {
  try {
    const files = readdirSync(LOG_DIR);
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.endsWith(".log")) continue;
      const fullPath = join(LOG_DIR, file);
      try {
        const { mtimeMs } = statSync(fullPath);
        if (mtimeMs < cutoff) {
          unlinkSync(fullPath);
        }
      } catch {
        // skip
      }
    }
  } catch {
    // directory doesn't exist yet
  }
}

// ── Core log function ───────────────────────────────────────────────

function log(level: LogLevel, module: string, message: string, err?: unknown): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${module}]`;

  // Console (with colors)
  const color = LEVEL_COLORS[level];
  console.log(`${color}${prefix}${RESET} ${message}`);
  if (err instanceof Error) {
    console.log(`${color}${err.stack ?? err.message}${RESET}`);
  }

  // File (plain text, no colors)
  try {
    let line = `${prefix} ${message}`;
    if (err instanceof Error) {
      line += `\n${err.stack ?? err.message}`;
    }
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // can't write to log file — nothing to do
  }
}

// ── Public API ──────────────────────────────────────────────────────

export const logger = {
  info(module: string, message: string) {
    log("info", module, message);
  },
  warn(module: string, message: string, err?: unknown) {
    log("warn", module, message, err);
  },
  error(module: string, message: string, err?: unknown) {
    log("error", module, message, err);
  },
};

// ── Startup ─────────────────────────────────────────────────────────

ensureLogDir();
rotateOldLogs();
