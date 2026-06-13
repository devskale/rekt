import type { RunnerState } from "../types";

interface MarketStatusProps {
  state: RunnerState | null;
}

export default function MarketStatus({ state }: MarketStatusProps) {
  const lastPoll = state?.lastPollAt
    ? new Date(state.lastPollAt).toLocaleTimeString()
    : "—";

  return (
    <section>
      <div className="section-title">Runner Status</div>
      <div className="market-status">
        <div className="stat-box">
          <div className="label">Markets Checked</div>
          <div className="value">{state?.marketsChecked ?? 0}</div>
        </div>
        <div className="stat-box">
          <div className="label">Trades Placed</div>
          <div className="value">{state?.tradesPlaced ?? 0}</div>
        </div>
        <div className="stat-box">
          <div className="label">Tick #</div>
          <div className="value">{state?.tickCount ?? 0}</div>
        </div>
        <div className="stat-box">
          <div className="label">Last Poll</div>
          <div className="value" style={{ fontSize: "0.95rem" }}>{lastPoll}</div>
        </div>
      </div>
    </section>
  );
}
