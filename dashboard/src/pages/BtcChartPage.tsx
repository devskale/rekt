import { useState, useEffect, useRef, useCallback } from "react";

interface PricePoint {
  price: number;
  ts: number;
}

type ZoomRange = "1m" | "5m" | "15m" | "1h";

const ZOOM_MS: Record<ZoomRange, number> = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

export default function BtcChartPage() {
  const [current, setCurrent] = useState<number | null>(null);
  const [history, setHistory] = useState<PricePoint[]>([]);
  const [prevPrice, setPrevPrice] = useState<number | null>(null);
  const [zoom, setZoom] = useState<ZoomRange>("5m");
  const [connected, setConnected] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial fetch
  const fetchPrice = useCallback(async () => {
    try {
      const res = await fetch("/api/btc-price");
      if (res.ok) {
        const data = await res.json();
        setCurrent(data.current);
        setHistory(data.history ?? []);
      }
    } catch (err) {
      console.error("BTC price fetch failed:", err);
    }
  }, []);

  // SSE for real-time updates
  const connectSSE = useCallback(() => {
    const es = new EventSource("/api/stream");

    es.addEventListener("connected", () => {
      setConnected(true);
    });

    es.addEventListener("btc-price", (e) => {
      try {
        const data = JSON.parse(e.data);
        setPrevPrice((p) => data.price !== current ? data.price : p);
        setCurrent(data.price);
        setHistory(data.history ?? []);
      } catch {
        // ignore
      }
    });

    es.onerror = () => {
      setConnected(false);
      es.close();
      reconnectRef.current = setTimeout(connectSSE, 3000);
    };

    return es;
  }, [current]);

  useEffect(() => {
    fetchPrice();
    const es = connectSSE();
    return () => {
      es.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [fetchPrice, connectSSE]);

  // Draw chart
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || history.length < 2) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const pad = { top: 50, right: 60, bottom: 36, left: 12 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // Apply zoom
    const nowMs = Date.now();
    const cutoff = nowMs - ZOOM_MS[zoom];
    const filtered = history.filter((p) => p.ts >= cutoff);
    if (filtered.length < 2) return;

    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, w, h);

    // Find min/max
    let minP = Infinity;
    let maxP = -Infinity;
    for (const p of filtered) {
      if (p.price < minP) minP = p.price;
      if (p.price > maxP) maxP = p.price;
    }
    const range = maxP - minP || 1;
    minP -= range * 0.15;
    maxP += range * 0.15;

    const minTs = filtered[0].ts;
    const maxTs = filtered[filtered.length - 1].ts;
    const tsRange = maxTs - minTs || 1;

    const xPos = (ts: number) => pad.left + ((ts - minTs) / tsRange) * plotW;
    const yPos = (p: number) => pad.top + plotH - ((p - minP) / (maxP - minP)) * plotH;

    // Grid + Y labels
    ctx.strokeStyle = "#21262d";
    ctx.lineWidth = 1;
    const gridSteps = 5;
    for (let i = 0; i <= gridSteps; i++) {
      const v = minP + (i / gridSteps) * (maxP - minP);
      const y = yPos(v);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();

      ctx.fillStyle = "#484f58";
      ctx.font = "11px -apple-system, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(`$${v.toFixed(0)}`, w - pad.right + 6, y + 4);
    }

    // X time labels
    const labelCount = Math.min(5, filtered.length);
    const labelStep = Math.max(1, Math.floor(filtered.length / labelCount));
    ctx.fillStyle = "#484f58";
    ctx.font = "10px -apple-system, sans-serif";
    ctx.textAlign = "center";
    for (let i = 0; i < filtered.length; i += labelStep) {
      const d = new Date(filtered[i].ts);
      const label = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      ctx.fillText(label, xPos(filtered[i].ts), h - pad.bottom + 18);
    }

    // Fill under line
    ctx.fillStyle = "rgba(247, 147, 26, 0.12)";
    ctx.beginPath();
    ctx.moveTo(xPos(filtered[0].ts), yPos(filtered[0].price));
    for (let i = 1; i < filtered.length; i++) {
      ctx.lineTo(xPos(filtered[i].ts), yPos(filtered[i].price));
    }
    ctx.lineTo(xPos(filtered[filtered.length - 1].ts), pad.top + plotH);
    ctx.lineTo(xPos(filtered[0].ts), pad.top + plotH);
    ctx.closePath();
    ctx.fill();

    // Line
    ctx.strokeStyle = "#f7931a";
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < filtered.length; i++) {
      const x = xPos(filtered[i].ts);
      const y = yPos(filtered[i].price);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Last point dot
    const last = filtered[filtered.length - 1];
    ctx.fillStyle = "#f7931a";
    ctx.beginPath();
    ctx.arc(xPos(last.ts), yPos(last.price), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }, [history, zoom]);

  const priceChange = current !== null && prevPrice !== null ? current - prevPrice : 0;
  const priceColor = priceChange > 0 ? "#3fb950" : priceChange < 0 ? "#f85149" : "#c9d1d9";
  const arrow = priceChange > 0 ? "▲" : priceChange < 0 ? "▼" : "—";

  return (
    <div className="btc-chart-page">
      <div className="btc-header">
        <div className="btc-price-display">
          <div className="btc-coin-icon">₿</div>
          <div>
            <div className="btc-label">Bitcoin / USD</div>
            <div className="btc-price">
              {current !== null ? `$${current.toLocaleString([], { maximumFractionDigits: 2 })}` : "—"}
            </div>
          </div>
          <div className="btc-change" style={{ color: priceColor }}>
            {arrow} {prevPrice !== null ? `$${Math.abs(priceChange).toFixed(2)}` : ""}
          </div>
        </div>
        <div className="zoom-controls">
          {(["1m", "5m", "15m", "1h"] as ZoomRange[]).map((z) => (
            <button
              key={z}
              className={`btn-zoom ${zoom === z ? "active" : ""}`}
              onClick={() => setZoom(z)}
            >
              {z}
            </button>
          ))}
        </div>
      </div>
      <div className="btc-conn">
        {connected ? "🟢 Live (Binance)" : "🔴 Disconnected"}
      </div>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "calc(100vh - 200px)", minHeight: "300px", borderRadius: "8px" }}
      />
    </div>
  );
}
