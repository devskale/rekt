import { useState } from "react";
import type { Trade } from "../types";

interface TradeLogProps {
  trades: Trade[];
  marketNames?: Record<string, string>;
}

const INITIAL_SHOW = 50;
const LOAD_MORE = 50;

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function timeLabel(ts: number): string {
  if (Date.now() - ts < 60 * 60 * 1000) return relativeTime(ts);
  return absoluteTime(ts);
}

function dateKey(ts: number): string {
  return new Date(ts).toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function TradeLog({ trades, marketNames = {} }: TradeLogProps) {
  const [showCount, setShowCount] = useState(INITIAL_SHOW);

  const totalCount = trades.length;
  const visible = trades.slice(0, showCount);
  const hasMore = showCount < totalCount;

  if (totalCount === 0) {
    return (
      <section>
        <div className="section-title" style={{ marginTop: 8 }}>Trade Log</div>
        <div className="trade-log">
          <h2>Recent Trades (0)</h2>
          <div className="trade-empty">No trades yet.</div>
        </div>
      </section>
    );
  }

  // Group visible trades by date
  const groups: { date: string; trades: Trade[] }[] = [];
  let currentDate = "";

  for (const t of visible) {
    const d = dateKey(t.timestamp);
    if (d !== currentDate) {
      currentDate = d;
      groups.push({ date: d, trades: [] });
    }
    groups[groups.length - 1].trades.push(t);
  }

  const isMultiDay = groups.length > 1;

  return (
    <section>
      <div className="section-title" style={{ marginTop: 8 }}>Trade Log</div>
      <div className="trade-log">
        <div className="trade-log-header">
          <h2>Recent Trades ({totalCount})</h2>
          {showCount < totalCount && (
            <span className="showing-count">
              showing {visible.length} of {totalCount}
            </span>
          )}
        </div>
        {groups.map((group) => (
          <div key={group.date}>
            {isMultiDay && (
              <div className="trade-date-header">{group.date}</div>
            )}
            <table className="trade-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Strategy</th>
                  <th>Market</th>
                  <th>Action</th>
                  <th>Side</th>
                  <th>Price</th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                {group.trades.map((t) => (
                  <tr key={t.id}>
                    <td className="time-cell" title={absoluteTime(t.timestamp)}>
                      {timeLabel(t.timestamp)}
                    </td>
                    <td className="strategy-cell">{t.strategy || "—"}</td>
                    <td className="market-cell" title={marketNames[t.marketId] ?? t.marketId}>
                      {marketNames[t.marketId] ?? t.marketId}
                    </td>
                    <td>
                      <span className={`action-${t.action}`}>
                        {t.action}
                      </span>
                    </td>
                    <td className={t.side === "YES" ? "side-yes" : t.side === "NO" ? "side-no" : ""}>
                      {t.side || "—"}
                    </td>
                    <td>${t.price.toFixed(3)}</td>
                    <td>{t.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {hasMore && (
          <div className="load-more">
            <button
              className="btn-load-more"
              onClick={() => setShowCount((c) => Math.min(c + LOAD_MORE, totalCount))}
            >
              Load more ({totalCount - showCount} remaining)
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
