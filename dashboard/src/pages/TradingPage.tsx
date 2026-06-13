import { useState, useEffect, useCallback, useRef } from "react";
import type {
  RunnerState,
  StrategyBalance,
  Trade,
  SSEData,
  PnlSnapshot,
} from "../types";
import Header from "../components/Header";
import StrategyCards from "../components/StrategyCards";
import TradeLog from "../components/TradeLog";
import MarketStatus from "../components/MarketStatus";
import PnlChart from "../components/PnlChart";

interface TradingPageProps {
  onRunningChange: (running: boolean) => void;
  onConnectedChange: (connected: boolean) => void;
}

export default function TradingPage({
  onRunningChange,
  onConnectedChange,
}: TradingPageProps) {
  const [state, setState] = useState<RunnerState | null>(null);
  const [strategies, setStrategies] = useState<StrategyBalance[]>([]);
  const [history, setHistory] = useState<Trade[]>([]);
  const [pnlHistory, setPnlHistory] = useState<PnlSnapshot[]>([]);
  const [marketNames, setMarketNames] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [stateRes, stratRes, histRes, marketsRes] = await Promise.all([
        fetch("/api/state"),
        fetch("/api/strategies"),
        fetch("/api/history"),
        fetch("/api/markets"),
      ]);
      if (stateRes.ok) {
        const s = await stateRes.json();
        setState(s);
        setPnlHistory(s.pnlHistory ?? []);
        onRunningChange(s.running);
      }
      if (stratRes.ok) setStrategies(await stratRes.json());
      if (histRes.ok) setHistory(await histRes.json());
      if (marketsRes.ok) setMarketNames(await marketsRes.json());
    } catch (err) {
      console.error("Initial fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, [onRunningChange]);

  const connectSSE = useCallback(() => {
    const es = new EventSource("/api/stream");

    es.addEventListener("connected", () => {
      setConnected(true);
      onConnectedChange(true);
    });

    es.addEventListener("tick", (e) => {
      try {
        const data: SSEData = JSON.parse(e.data);
        setState(data.state);
        setPnlHistory(data.state.pnlHistory ?? []);
        setStrategies(data.strategies ?? []);
        onRunningChange(data.state.running);
        if (data.result?.decisions?.length) {
          setHistory((prev) => {
            const newTrades = data.result.decisions.map((d, i) => ({
              id: `tick-${data.state.tickCount}-${i}`,
              positionId: "",
              action: "open" as const,
              price: d.price,
              quantity: d.quantity,
              timestamp: Date.now(),
              strategy: d.strategy,
              marketId: d.marketId,
              side: d.side,
            }));
            return [...newTrades, ...prev].slice(0, 200);
          });
        }
        if (data.result?.resolutions?.length) {
          setHistory((prev) => {
            const resolutionTrades = data.result.resolutions.flatMap((r, i) => [
              {
                id: `resolve-${data.state.tickCount}-${i}`,
                positionId: "",
                action: "resolve" as const,
                price: 0,
                quantity: r.positionsResolved,
                timestamp: Date.now(),
                strategy: "",
                marketId: r.marketId,
              },
            ]);
            return [...resolutionTrades, ...prev].slice(0, 200);
          });
        }
      } catch (err) {
        console.error("[SSE] Parse error:", err);
      }
    });

    es.onerror = () => {
      setConnected(false);
      onConnectedChange(false);
      es.close();
      reconnectRef.current = setTimeout(connectSSE, 3000);
    };

    return es;
  }, [onRunningChange, onConnectedChange]);

  useEffect(() => {
    fetchAll();
    const es = connectSSE();
    return () => {
      es.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [fetchAll, connectSSE]);

  const handleStart = async () => {
    await fetch("/api/start", { method: "POST" });
    fetchAll();
  };

  const handleStop = async () => {
    await fetch("/api/stop", { method: "POST" });
    fetchAll();
  };

  if (loading) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div>
      <Header
        running={state?.running ?? false}
        connected={connected}
        dataSource={state?.dataSource ?? "none"}
        dataSourceDetail={state?.dataSourceDetail ?? ""}
        onStart={handleStart}
        onStop={handleStop}
      />
      <MarketStatus state={state} />
      <StrategyCards
        strategies={strategies}
        startedAt={pnlHistory.length > 0 ? pnlHistory[0].ts : null}
      />
      <PnlChart history={pnlHistory} />
      <TradeLog trades={history} marketNames={marketNames} />
    </div>
  );
}
