import { logger } from "../logger.js";

export interface BtcPricePoint {
  price: number;
  ts: number;
}

const MAX_HISTORY = 500;

export class BtcPriceFeed {
  private history: BtcPricePoint[] = [];
  private current: number | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /** Callback fired on every price update. */
  onUpdate?: (price: number, history: BtcPricePoint[]) => void;

  start(): void {
    this.stopped = false;
    this.connect();
    logger.info("btc-price", "Connecting to Binance WebSocket...");
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info("btc-price", "Stopped");
  }

  getPrice(): number | null {
    return this.current;
  }

  getHistory(): BtcPricePoint[] {
    return this.history;
  }

  private connect(): void {
    if (this.stopped) return;

    try {
      this.ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@trade");

      this.ws.onopen = () => {
        logger.info("btc-price", "Connected to Binance");
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          const price = parseFloat(msg.p);
          if (isNaN(price) || price <= 0) return;

          this.current = price;
          const point: BtcPricePoint = { price, ts: Date.now() };
          this.history.push(point);
          if (this.history.length > MAX_HISTORY) {
            this.history = this.history.slice(-MAX_HISTORY);
          }
          this.onUpdate?.(price, this.history);
        } catch {
          // ignore parse errors
        }
      };

      this.ws.onerror = (err) => {
        logger.error("btc-price", "WebSocket error", err);
      };

      this.ws.onclose = () => {
        if (!this.stopped) {
          logger.info("btc-price", "WebSocket closed, reconnecting in 5s...");
          this.reconnectTimer = setTimeout(() => this.connect(), 5000);
        }
      };
    } catch (err) {
      logger.error("btc-price", "Failed to connect", err);
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    }
  }
}
