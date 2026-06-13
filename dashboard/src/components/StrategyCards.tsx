import type { StrategyBalance } from "../types";

interface StrategyCardsProps {
  strategies: StrategyBalance[];
  startedAt: number | null;
}

function fmt$(n: number): string {
  const sign = n >= 0 ? "" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}

export default function StrategyCards({ strategies, startedAt }: StrategyCardsProps) {
  if (strategies.length === 0) {
    return (
      <section>
        <div className="section-title">Strategies</div>
        <div className="trade-empty">No strategies active yet. Start the runner!</div>
      </section>
    );
  }

  const runningFor = startedAt ? fmtDuration(Date.now() - startedAt) : null;

  return (
    <section>
      <div className="strat-header">
        <div className="section-title" style={{ marginBottom: 0 }}>Strategies</div>
        {runningFor && <span className="running-for">⏱ {runningFor}</span>}
      </div>
      <div className="strategy-cards">
        {strategies.map((s) => {
          const trend = s.totalPnL > 0 ? "▲" : s.totalPnL < 0 ? "▼" : "—";
          const trendClass = s.totalPnL > 0 ? "trend-up" : s.totalPnL < 0 ? "trend-down" : "";
          return (
            <div className="strat-card" key={s.strategyName}>
              <div className="strat-card-header">
                <h3>{s.strategyName}</h3>
                <span className={`trend ${trendClass}`}>{trend}</span>
              </div>
              <div className="strat-row">
                <span className="lbl">Cash</span>
                <span className="val">{fmt$(s.cash)}</span>
              </div>
              <div className="strat-row">
                <span className="lbl">Total P&L</span>
                <span className={`val ${s.totalPnL >= 0 ? "positive" : "negative"}`}>
                  {fmt$(s.totalPnL)}
                </span>
              </div>
              <div className="strat-row">
                <span className="lbl">Realized</span>
                <span className={`val ${s.realizedPnL >= 0 ? "positive" : "negative"}`}>
                  {fmt$(s.realizedPnL)}
                </span>
              </div>
              <div className="strat-row">
                <span className="lbl">Unrealized</span>
                <span className={`val ${s.unrealizedPnL >= 0 ? "positive" : "negative"}`}>
                  {fmt$(s.unrealizedPnL)}
                </span>
              </div>
              <div className="strat-row">
                <span className="lbl">Win Rate</span>
                <span className="val">
                  {s.resolvedCount > 0 ? `${(s.winRate * 100).toFixed(1)}%` : "—"}
                </span>
              </div>
              <div className="strat-row">
                <span className="lbl">W / L</span>
                <span className="val">
                  {s.winCount} / {s.lossCount}
                </span>
              </div>
              <div className="strat-row">
                <span className="lbl">Trades</span>
                <span className="val">{s.tradeCount}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
