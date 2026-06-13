import { logger } from "../logger.js";
import type { SpotRecord } from "./records.js";

// ── BTC spot price feed (Binance) ───────────────────────────────────
//
// The momentum signal. Connects to Binance's btcusdt@ticker stream and
// emits throttled spot records. Robust: auto-reconnects with exponential
// backoff and never crashes the host process.

export type { SpotRecord };

const WS_URL = "wss://stream.binance.com:9443/ws/btcusdt@ticker";
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const THROTTLE_MS = 1000;

interface TickerMsg {
  /** Event time (ms epoch). */
  E?: number;
  /** Last traded price (string). */
  c?: string;
}

export class SpotFeed {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = MIN_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWrite = 0;

  /** Current live connection status. */
  connected = false;

  /** Fired for each (throttled) spot record. */
  onRecord?: (rec: SpotRecord) => void;
  /** Fired when connection status changes. */
  onConnectionChange?: (connected: boolean) => void;

  start(): void {
    this.stopped = false;
    logger.info("receiver:spot", "Starting Binance BTC ticker feed...");
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.setConnected(false);
    logger.info("receiver:spot", "Stopped");
  }

  private connect(): void {
    if (this.stopped) return;
    try {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;

      ws.onopen = () => {
        this.backoffMs = MIN_BACKOFF_MS;
        this.setConnected(true);
        logger.info("receiver:spot", "Connected to Binance");
      };

      ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev);

      ws.onerror = () => {
        // close handler will trigger reconnect; just log here.
        logger.warn("receiver:spot", "WebSocket error");
      };

      ws.onclose = () => {
        this.setConnected(false);
        logger.warn("receiver:spot", "WebSocket closed");
        this.scheduleReconnect();
      };
    } catch (err) {
      logger.error("receiver:spot", "Failed to open WebSocket", err);
      this.scheduleReconnect();
    }
  }

  private handleMessage(ev: MessageEvent): void {
    try {
      const msg = JSON.parse(ev.data as string) as TickerMsg;
      const price = msg.c !== undefined ? parseFloat(msg.c) : NaN;
      if (!Number.isFinite(price) || price <= 0) return;

      const now = Date.now();
      if (now - this.lastWrite < THROTTLE_MS) return;
      this.lastWrite = now;

      const rec: SpotRecord = {
        ts: typeof msg.E === "number" ? msg.E : now,
        asset: "btc",
        price,
        source: "binance",
      };
      this.onRecord?.(rec);
    } catch {
      // ignore malformed messages
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    logger.info("receiver:spot", `Reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private setConnected(v: boolean): void {
    if (this.connected === v) return;
    this.connected = v;
    this.onConnectionChange?.(v);
  }
}
