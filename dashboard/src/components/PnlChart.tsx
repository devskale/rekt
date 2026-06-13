import { useRef, useEffect, useState } from "react";
import type { PnlSnapshot } from "../types";

const COLORS: Record<string, string> = {
  momentum: "#3fb950",
  "late-scalp": "#58a6ff",
  "coin-flip": "#f0883e",
  snipe: "#f85149",
};
const DEFAULT_ORDER = ["momentum", "late-scalp", "coin-flip", "snipe"];

type ZoomRange = "1h" | "6h" | "24h" | "all";

const ZOOM_MS: Record<ZoomRange, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  all: Infinity,
};

interface PnlChartProps {
  history: PnlSnapshot[];
}

function formatTimeLabel(ts: number, range: ZoomRange, nowMs: number): string {
  const d = new Date(ts);
  if (range === "1h") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (range === "6h") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (range === "24h") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  // "all" — show date + hour if > 24h of data
  const span = nowMs - ts;
  if (span > 24 * 60 * 60 * 1000) {
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString([], { hour: "2-digit" });
  }
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function PnlChart({ history }: PnlChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState<ZoomRange>("all");

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
    const pad = { top: 20, right: 16, bottom: 36, left: 52 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // Apply zoom filter
    const nowMs = Date.now();
    const cutoff = zoom === "all" ? 0 : nowMs - ZOOM_MS[zoom];
    const filtered = history.filter((s) => s.ts >= cutoff);
    if (filtered.length < 2) return;

    // Clear
    ctx.fillStyle = "#161b22";
    ctx.fillRect(0, 0, w, h);

    // Strategy names (stable order)
    const allNames = new Set<string>();
    for (const snap of filtered) {
      for (const s of snap.strategies) allNames.add(s.name);
    }
    const names = [...allNames].sort(
      (a, b) => DEFAULT_ORDER.indexOf(a) - DEFAULT_ORDER.indexOf(b),
    );

    // Build series
    const series: Map<string, number[]> = new Map();
    const timestamps: number[] = [];
    for (const name of names) series.set(name, []);

    for (const snap of filtered) {
      timestamps.push(snap.ts);
      const byName = new Map(snap.strategies.map((s) => [s.name, s]));
      for (const name of names) {
        series.get(name)!.push(byName.get(name)?.totalPnL ?? 0);
      }
    }

    // Min/max P&L
    let minPnl = 0;
    let maxPnl = 0;
    for (const vals of series.values()) {
      for (const v of vals) {
        if (v < minPnl) minPnl = v;
        if (v > maxPnl) maxPnl = v;
      }
    }
    const range = maxPnl - minPnl || 1;
    minPnl -= range * 0.1;
    maxPnl += range * 0.1;

    const n = filtered.length;
    const minTs = timestamps[0];
    const maxTs = timestamps[n - 1];
    const tsRange = maxTs - minTs || 1;

    function xPos(i: number) {
      const t = timestamps[i];
      return pad.left + ((t - minTs) / tsRange) * plotW;
    }
    function yPos(v: number) {
      return pad.top + plotH - ((v - minPnl) / (maxPnl - minPnl)) * plotH;
    }

    // Grid + Y labels
    ctx.strokeStyle = "#21262d";
    ctx.lineWidth = 1;
    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const v = minPnl + (i / gridSteps) * (maxPnl - minPnl);
      const y = yPos(v);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();

      ctx.fillStyle = "#484f58";
      ctx.font = "10px -apple-system, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(`$${v.toFixed(0)}`, pad.left - 6, y + 3);
    }

    // Zero line
    if (minPnl < 0 && maxPnl > 0) {
      ctx.strokeStyle = "#30363d";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(pad.left, yPos(0));
      ctx.lineTo(w - pad.right, yPos(0));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // X time labels (show ~6 labels)
    const labelCount = Math.min(6, n);
    const labelStep = Math.max(1, Math.floor(n / labelCount));
    ctx.fillStyle = "#484f58";
    ctx.font = "10px -apple-system, sans-serif";
    ctx.textAlign = "center";
    for (let i = 0; i < n; i += labelStep) {
      const x = xPos(i);
      const label = formatTimeLabel(timestamps[i], zoom, nowMs);
      ctx.fillText(label, x, h - pad.bottom + 18);
    }
    // Always show last label
    const lastX = xPos(n - 1);
    ctx.fillText(formatTimeLabel(timestamps[n - 1], zoom, nowMs), lastX, h - pad.bottom + 18);

    // Draw lines
    for (const [name, vals] of series) {
      const color = COLORS[name] ?? "#8b949e";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.beginPath();

      for (let i = 0; i < vals.length; i++) {
        const x = xPos(i);
        const y = yPos(vals[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // End dot + value label
      const lastVal = vals[vals.length - 1];
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(lastX, yPos(lastVal), 3, 0, Math.PI * 2);
      ctx.fill();

      const sign = lastVal >= 0 ? "+" : "";
      ctx.font = "bold 10px -apple-system, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(`${sign}$${lastVal.toFixed(2)}`, lastX + 6, yPos(lastVal) + 3);
    }

    // Legend
    ctx.font = "10px -apple-system, sans-serif";
    let legendX = pad.left;
    const legendY = pad.top - 4;
    for (const name of names) {
      const color = COLORS[name] ?? "#8b949e";
      ctx.fillStyle = color;
      ctx.fillRect(legendX, legendY - 8, 8, 8);
      ctx.fillStyle = "#8b949e";
      ctx.textAlign = "left";
      ctx.fillText(name, legendX + 12, legendY);
      legendX += ctx.measureText(name).width + 26;
    }
  }, [history, zoom]);

  if (history.length < 2) {
    return (
      <section>
        <div className="section-title">P&L Over Time</div>
        <div className="chart-empty">
          Waiting for data… ({history.length}/2 ticks)
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="chart-header">
        <div className="section-title" style={{ marginBottom: 0 }}>P&L Over Time</div>
        <div className="zoom-controls">
          {(["1h", "6h", "24h", "all"] as ZoomRange[]).map((z) => (
            <button
              key={z}
              className={`btn-zoom ${zoom === z ? "active" : ""}`}
              onClick={() => setZoom(z)}
            >
              {z === "all" ? "All" : z}
            </button>
          ))}
        </div>
      </div>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "240px", borderRadius: "8px" }}
      />
    </section>
  );
}
