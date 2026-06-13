type DataSource = "btc-5min" | "fallback-markets" | "demo" | "none";

interface HeaderProps {
  running: boolean;
  connected: boolean;
  dataSource: DataSource;
  dataSourceDetail: string;
  onStart: () => void;
  onStop: () => void;
}

const SOURCE_CONFIG: Record<DataSource, { label: string; icon: string; className: string }> = {
  "btc-5min": { label: "BTC 5-MIN LIVE", icon: "🟢", className: "source-btc" },
  "fallback-markets": { label: "FALLBACK", icon: "🟡", className: "source-fallback" },
  demo: { label: "DEMO MODE", icon: "🔵", className: "source-demo" },
  none: { label: "NO MARKETS", icon: "🔴", className: "source-none" },
};

export default function Header({
  running,
  connected,
  dataSource,
  dataSourceDetail,
  onStart,
  onStop,
}: HeaderProps) {
  const src = SOURCE_CONFIG[dataSource];

  return (
    <header className="header">
      <div className="header-left">
        <h1>📊 Paper Trading Bot</h1>
        <div className="source-group">
          <span className={`source-badge ${src.className}`}>
            <span className="source-icon">{src.icon}</span>
            {src.label}
          </span>
          <span className="source-detail">{dataSourceDetail}</span>
        </div>
      </div>
      <div className="header-right">
        <span className={`status-badge ${connected ? "connected" : "stopped"}`}>
          <span className="status-dot" />
          {connected ? "SSE Live" : "SSE Off"}
        </span>
        <span className={`status-badge ${running ? "running" : "stopped"}`}>
          <span className="status-dot" />
          {running ? "Running" : "Stopped"}
        </span>
        {running ? (
          <button className="btn btn-stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="btn btn-start" onClick={onStart}>
            Start
          </button>
        )}
      </div>
    </header>
  );
}
