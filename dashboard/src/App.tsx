import { useState } from "react";
import TradingPage from "./pages/TradingPage";
import BtcChartPage from "./pages/BtcChartPage";
import "./App.css";

type Tab = "trading" | "btc";

function App() {
  const [tab, setTab] = useState<Tab>("trading");
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);

  return (
    <div className="app">
      <nav className="tabs">
        <button
          className={`tab ${tab === "trading" ? "active" : ""}`}
          onClick={() => setTab("trading")}
        >
          📊 Trading
        </button>
        <button
          className={`tab ${tab === "btc" ? "active" : ""}`}
          onClick={() => setTab("btc")}
        >
          ₿ BTC Chart
        </button>
        <div className="tab-status">
          {running && <span className="tab-badge running">●</span>}
          {connected && <span className="tab-badge connected">●</span>}
        </div>
      </nav>

      {tab === "trading" && (
        <TradingPage
          onRunningChange={setRunning}
          onConnectedChange={setConnected}
        />
      )}
      {tab === "btc" && <BtcChartPage />}
    </div>
  );
}

export default App;
