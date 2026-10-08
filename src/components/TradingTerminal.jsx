import React, { useEffect, useMemo, useRef, useState } from "react";

/*
 * TradingTerminal.jsx
 *
 * Standalone Binance Futures terminal:
 * - Left: TradingView Lightweight Charts candlestick chart
 * - Right: live Binance Futures order book + time & sales
 * - Liquidity heatmap is rendered over the chart area from recent depth snapshots
 *
 * Install:
 *   npm install lightweight-charts
 *
 * Usage:
 *   <TradingTerminal symbol="BTCUSDT" onClose={() => setSelected(null)} />
 *
 * Notes:
 * - Binance Futures public WebSocket streams are used directly from the browser.
 * - No API key is required.
 * - Order-book data is public market data.
 */

import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
} from "lightweight-charts";

const WS_BASE = "wss://fstream.binance.com/stream?streams=";
const REST_BASE = "https://fapi.binance.com";

const MAX_TRADES = 120;
const MAX_HEATMAP_LEVELS = 45;
const DEPTH_INTERVAL_MS = 250;

const fmt = (n, digits = 2) => {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

const compact = (n) => {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
};

const priceDigits = (price) => {
  if (price >= 1000) return 2;
  if (price >= 100) return 3;
  if (price >= 1) return 4;
  if (price >= 0.01) return 5;
  return 8;
};

const shortTime = (ts) =>
  new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .replace("/", "")
    .replace("USDT", "USDT")
    .toUpperCase();
}

function HeatmapCanvas({ levels, midPrice, minPrice, maxPrice }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !midPrice || !minPrice || !maxPrice) return;

    const parent = canvas.parentElement;
    const width = parent?.clientWidth || 700;
    const height = parent?.clientHeight || 500;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const range = maxPrice - minPrice || 1;

    const yForPrice = (price) =>
      ((maxPrice - price) / range) * height;

    const maxQty = Math.max(
      1,
      ...levels.map((x) => Number(x.qty) || 0)
    );

    for (const level of levels) {
      const price = Number(level.price);
      const qty = Number(level.qty);
      if (!price || !qty) continue;
      if (price < minPrice || price > maxPrice) continue;

      const y = yForPrice(price);
      const intensity = Math.min(1, qty / maxQty);

      // Buy liquidity = green, sell liquidity = red.
      const alpha = 0.025 + intensity * 0.22;
      const isAsk = level.side === "ask";

      const gradient = ctx.createLinearGradient(
        0,
        y - 3,
        width,
        y + 3
      );

      if (isAsk) {
        gradient.addColorStop(0, `rgba(255,70,70,0)`);
        gradient.addColorStop(
          0.35,
          `rgba(255,70,70,${alpha})`
        );
        gradient.addColorStop(
          1,
          `rgba(255,70,70,${alpha * 0.15})`
        );
      } else {
        gradient.addColorStop(0, `rgba(0,230,118,0)`);
        gradient.addColorStop(
          0.35,
          `rgba(0,230,118,${alpha})`
        );
        gradient.addColorStop(
          1,
          `rgba(0,230,118,${alpha * 0.15})`
        );
      }

      ctx.fillStyle = gradient;
      ctx.fillRect(0, Math.max(0, y - 3), width, 6);
    }
  }, [levels, midPrice, minPrice, maxPrice]);

  return (
    <canvas
      ref={ref}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 2,
        mixBlendMode: "screen",
      }}
    />
  );
}

export default function TradingTerminal({
  symbol = "BTCUSDT",
  onClose,
}) {
  const fullSymbol = normalizeSymbol(symbol);
  const lower = fullSymbol.toLowerCase();

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const candleRef = useRef(null);
  const volumeRef = useRef(null);
  const wsRef = useRef(null);
  const depthTimerRef = useRef(null);

  const [interval, setIntervalValue] = useState("5m");
  const [connected, setConnected] = useState(false);
  const [ticker, setTicker] = useState(null);
  const [bids, setBids] = useState([]);
  const [asks, setAsks] = useState([]);
  const [trades, setTrades] = useState([]);
  const [candles, setCandles] = useState([]);
  const [heatmap, setHeatmap] = useState([]);
  const [error, setError] = useState("");

  const [depthStats, setDepthStats] = useState({
    bidVolume: 0,
    askVolume: 0,
    delta: 0,
  });

  const pDigits = useMemo(
    () => priceDigits(Number(ticker?.price || 0)),
    [ticker?.price]
  );

  // ------------------------------------------------------------
  // Chart
  // ------------------------------------------------------------
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { color: "#080b10" },
        textColor: "#64748b",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.035)" },
        horzLines: { color: "rgba(255,255,255,0.035)" },
      },
      crosshair: {
        mode: 0,
      },
      rightPriceScale: {
        borderColor: "#202633",
      },
      timeScale: {
        borderColor: "#202633",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: true,
      handleScale: true,
    });

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: "#00e676",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#00e676",
      wickDownColor: "#ef4444",
      priceLineVisible: true,
    });

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      scaleMargins: {
        top: 0.82,
        bottom: 0,
      },
    });

    chartRef.current = chart;
    candleRef.current = candle;
    volumeRef.current = volume;

    const resize = () => {
      if (!chartContainerRef.current) return;
      chart.applyOptions({
        width: chartContainerRef.current.clientWidth,
        height: chartContainerRef.current.clientHeight,
      });
    };

    resize();
    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!candleRef.current || !volumeRef.current) return;

    const candleData = candles.map((k) => ({
      time: Math.floor(k[0] / 1000),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
    }));

    const volumeData = candles.map((k) => ({
      time: Math.floor(k[0] / 1000),
      value: Number(k[5]),
      color:
        Number(k[4]) >= Number(k[1])
          ? "rgba(0,230,118,0.28)"
          : "rgba(239,68,68,0.28)",
    }));

    candleRef.current.setData(candleData);
    volumeRef.current.setData(volumeData);

    if (candleData.length && chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  }, [candles]);

  // ------------------------------------------------------------
  // Initial candles
  // ------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function loadCandles() {
      try {
        setError("");

        const res = await fetch(
          `${REST_BASE}/fapi/v1/klines?symbol=${fullSymbol}&interval=${interval}&limit=500`
        );

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        if (!cancelled) {
          setCandles(data);
        }
      } catch (e) {
        if (!cancelled) {
          setError(`Nu pot încărca graficul: ${e.message}`);
        }
      }
    }

    loadCandles();

    return () => {
      cancelled = true;
    };
  }, [fullSymbol, interval]);

  // ------------------------------------------------------------
  // Binance WebSocket
  // ------------------------------------------------------------
  useEffect(() => {
    if (!fullSymbol) return;

    setConnected(false);
    setError("");
    setBids([]);
    setAsks([]);
    setTrades([]);
    setTicker(null);
    setHeatmap([]);

    if (wsRef.current) {
      wsRef.current.close();
    }

    const streams = [
      `${lower}@depth20@100ms`,
      `${lower}@aggTrade`,
      `${lower}@ticker`,
      `${lower}@kline_${interval}`,
    ].join("/");

    const ws = new WebSocket(`${WS_BASE}${streams}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onerror = () => {
      setConnected(false);
      setError("WebSocket Binance indisponibil.");
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onmessage = (event) => {
      try {
        const packet = JSON.parse(event.data);
        const stream = packet.stream || "";
        const data = packet.data || packet;

        // Depth
        if (stream.includes("@depth20")) {
          const nextBids = (data.bids || [])
            .map(([price, qty]) => ({
              price: Number(price),
              qty: Number(qty),
              side: "bid",
            }))
            .filter((x) => x.qty > 0);

          const nextAsks = (data.asks || [])
            .map(([price, qty]) => ({
              price: Number(price),
              qty: Number(qty),
              side: "ask",
            }))
            .filter((x) => x.qty > 0);

          setBids(nextBids);
          setAsks(nextAsks);

          const bidVolume = nextBids
            .slice(0, 20)
            .reduce((s, x) => s + x.price * x.qty, 0);

          const askVolume = nextAsks
            .slice(0, 20)
            .reduce((s, x) => s + x.price * x.qty, 0);

          setDepthStats({
            bidVolume,
            askVolume,
            delta: bidVolume - askVolume,
          });
        }

        // Aggregate trades
        if (stream.includes("@aggTrade")) {
          const price = Number(data.p);
          const qty = Number(data.q);

          // m=true means buyer is market maker -> aggressive sell.
          const side = data.m ? "SELL" : "BUY";

          const trade = {
            id: `${data.a}-${data.T}`,
            time: data.T,
            price,
            qty,
            notional: price * qty,
            side,
          };

          setTrades((prev) => [trade, ...prev].slice(0, MAX_TRADES));
        }

        // Ticker
        if (stream.includes("@ticker")) {
          setTicker({
            price: Number(data.c),
            change: Number(data.P),
            high: Number(data.h),
            low: Number(data.l),
            volume: Number(data.q),
          });
        }

        // Live candle update
        if (stream.includes("@kline_")) {
          const k = data.k;

          setCandles((prev) => {
            const next = [...prev];

            const item = [
              Number(k.t),
              String(k.o),
              String(k.h),
              String(k.l),
              String(k.c),
              String(k.v),
              Number(k.T),
              String(k.q),
            ];

            if (!next.length) return [item];

            const lastIndex = next.length - 1;

            if (Number(next[lastIndex][0]) === Number(k.t)) {
              next[lastIndex] = item;
            } else {
              next.push(item);
              if (next.length > 500) next.shift();
            }

            return next;
          });
        }
      } catch {
        // Ignore malformed packets.
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [fullSymbol, lower, interval]);

  // ------------------------------------------------------------
  // Liquidity heatmap
  // ------------------------------------------------------------
  useEffect(() => {
    const updateHeatmap = () => {
      if (!bids.length && !asks.length) return;

      const all = [
        ...bids.slice(0, MAX_HEATMAP_LEVELS),
        ...asks.slice(0, MAX_HEATMAP_LEVELS),
      ];

      const next = all
        .sort((a, b) => a.price - b.price)
        .map((x) => ({
          ...x,
          ts: Date.now(),
        }));

      setHeatmap((prev) => {
        const merged = [...prev, ...next];

        // Keep the most recent snapshots only.
        return merged.slice(-600);
      });
    };

    updateHeatmap();

    depthTimerRef.current = setInterval(
      updateHeatmap,
      DEPTH_INTERVAL_MS
    );

    return () => {
      clearInterval(depthTimerRef.current);
    };
  }, [bids, asks]);

  // ------------------------------------------------------------
  // Heatmap visible range
  // ------------------------------------------------------------
  const heatRange = useMemo(() => {
    const mid = Number(ticker?.price || 0);

    if (!mid) {
      return {
        min: 0,
        max: 1,
      };
    }

    const prices = [
      ...bids.slice(0, 20).map((x) => x.price),
      ...asks.slice(0, 20).map((x) => x.price),
    ];

    if (!prices.length) {
      return {
        min: mid * 0.98,
        max: mid * 1.02,
      };
    }

    const min = Math.min(...prices);
    const max = Math.max(...prices);

    return {
      min,
      max,
    };
  }, [bids, asks, ticker]);

  // ------------------------------------------------------------
  // Order book
  // ------------------------------------------------------------
  const displayAsks = useMemo(
    () => [...asks].sort((a, b) => b.price - a.price).slice(0, 18),
    [asks]
  );

  const displayBids = useMemo(
    () => [...bids].sort((a, b) => b.price - a.price).slice(0, 18),
    [bids]
  );

  const maxBookQty = useMemo(() => {
    return Math.max(
      1,
      ...displayAsks.map((x) => x.qty),
      ...displayBids.map((x) => x.qty)
    );
  }, [displayAsks, displayBids]);

  const bestAsk = asks.length
    ? Math.min(...asks.map((x) => x.price))
    : null;

  const bestBid = bids.length
    ? Math.max(...bids.map((x) => x.price))
    : null;

  const spread =
    bestAsk && bestBid
      ? bestAsk - bestBid
      : null;

  // ------------------------------------------------------------
  // Render
  // ------------------------------------------------------------
  return (
    <div className="terminal-root">
      <style>{`
        .terminal-root {
          min-height: 100vh;
          width: 100%;
          background: #07090d;
          color: #dbe4ee;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          overflow: hidden;
        }

        .terminal-header {
          height: 58px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 16px;
          background: #0c1016;
          border-bottom: 1px solid #202633;
        }

        .terminal-symbol {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .symbol-name {
          font-size: 17px;
          font-weight: 800;
          color: #fff;
        }

        .futures-pill {
          font-size: 9px;
          padding: 3px 7px;
          border: 1px solid rgba(0,230,118,.25);
          color: #00e676;
          border-radius: 4px;
          background: rgba(0,230,118,.06);
        }

        .live {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 10px;
          color: #00e676;
        }

        .live-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #00e676;
          box-shadow: 0 0 10px rgba(0,230,118,.8);
        }

        .terminal-stats {
          display: flex;
          align-items: center;
          gap: 18px;
          font-family: "JetBrains Mono", monospace;
        }

        .stat-label {
          color: #475569;
          font-size: 9px;
          display: block;
          margin-bottom: 2px;
        }

        .stat-value {
          font-size: 12px;
          color: #e2e8f0;
          font-weight: 700;
        }

        .positive {
          color: #00e676 !important;
        }

        .negative {
          color: #ef4444 !important;
        }

        .close-terminal {
          border: 1px solid #2a3140;
          background: #121720;
          color: #94a3b8;
          width: 30px;
          height: 30px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 18px;
        }

        .close-terminal:hover {
          color: #fff;
          border-color: #475569;
        }

        .terminal-body {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 390px;
          height: calc(100vh - 58px);
        }

        .chart-side {
          min-width: 0;
          display: flex;
          flex-direction: column;
          background: #080b10;
          border-right: 1px solid #202633;
        }

        .chart-toolbar {
          height: 42px;
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 0 10px;
          border-bottom: 1px solid #202633;
          background: #0b0f15;
        }

        .tf-button {
          border: 0;
          background: transparent;
          color: #64748b;
          font-size: 11px;
          padding: 6px 9px;
          border-radius: 4px;
          cursor: pointer;
        }

        .tf-button:hover,
        .tf-button.active {
          background: #18202c;
          color: #fff;
        }

        .chart-wrapper {
          position: relative;
          flex: 1;
          min-height: 0;
        }

        .chart-container {
          position: absolute;
          inset: 0;
          z-index: 1;
        }

        .heatmap-label {
          position: absolute;
          z-index: 4;
          left: 12px;
          top: 12px;
          font-size: 9px;
          color: #64748b;
          background: rgba(8,11,16,.75);
          border: 1px solid #202633;
          border-radius: 4px;
          padding: 5px 7px;
          pointer-events: none;
        }

        .terminal-side {
          min-width: 0;
          display: grid;
          grid-template-rows: minmax(0, 1fr) minmax(0, .9fr);
          background: #0a0e14;
        }

        .panel {
          min-height: 0;
          overflow: hidden;
          border-bottom: 1px solid #202633;
        }

        .panel:last-child {
          border-bottom: 0;
        }

        .panel-header {
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 12px;
          border-bottom: 1px solid #202633;
          background: #0d1219;
        }

        .panel-title {
          font-size: 10px;
          color: #94a3b8;
          font-weight: 800;
          letter-spacing: .08em;
        }

        .panel-sub {
          font-size: 9px;
          color: #475569;
        }

        .book {
          height: calc(100% - 40px);
          display: flex;
          flex-direction: column;
        }

        .book-head {
          display: grid;
          grid-template-columns: 1fr 90px 80px;
          padding: 7px 10px;
          color: #334155;
          font-size: 9px;
          border-bottom: 1px solid rgba(255,255,255,.025);
        }

        .book-row {
          position: relative;
          display: grid;
          grid-template-columns: 1fr 90px 80px;
          padding: 3px 10px;
          font-family: "JetBrains Mono", monospace;
          font-size: 10px;
          line-height: 15px;
        }

        .book-row::before {
          content: "";
          position: absolute;
          right: 0;
          top: 1px;
          bottom: 1px;
          width: var(--depth-width);
          background: var(--depth-color);
          opacity: .13;
          pointer-events: none;
        }

        .book-asks {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: flex-end;
          overflow: hidden;
        }

        .book-bids {
          flex: 1;
          overflow: hidden;
        }

        .ask-price {
          color: #ff6262;
        }

        .bid-price {
          color: #00e676;
        }

        .book-number {
          color: #cbd5e1;
          text-align: right;
        }

        .book-usdt {
          color: #64748b;
          text-align: right;
        }

        .mid-price {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 7px 10px;
          background: #10151d;
          border-top: 1px solid #202633;
          border-bottom: 1px solid #202633;
        }

        .mid-price strong {
          color: #fff;
          font-family: "JetBrains Mono", monospace;
          font-size: 12px;
        }

        .spread {
          font-size: 9px;
          color: #475569;
        }

        .delta-bar {
          height: 18px;
          display: flex;
          margin: 7px 10px;
          border: 1px solid #202633;
          border-radius: 3px;
          overflow: hidden;
          font-size: 8px;
          font-family: "JetBrains Mono", monospace;
        }

        .delta-buy {
          background: rgba(0,230,118,.15);
          color: #00e676;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .delta-sell {
          background: rgba(239,68,68,.15);
          color: #ef4444;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .tape {
          height: calc(100% - 40px);
          overflow: auto;
        }

        .trade-row {
          display: grid;
          grid-template-columns: 75px 65px 1fr 55px;
          gap: 5px;
          padding: 4px 10px;
          border-bottom: 1px solid rgba(255,255,255,.025);
          font-family: "JetBrains Mono", monospace;
          font-size: 9px;
        }

        .trade-time {
          color: #475569;
        }

        .trade-price {
          text-align: right;
          color: #cbd5e1;
        }

        .trade-value {
          text-align: right;
          color: #64748b;
        }

        .trade-side {
          text-align: right;
          font-weight: 800;
        }

        .buy {
          color: #00e676;
        }

        .sell {
          color: #ef4444;
        }

        .empty {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: #334155;
          font-size: 11px;
        }

        @media (max-width: 900px) {
          .terminal-body {
            grid-template-columns: 1fr;
            height: auto;
            min-height: calc(100vh - 58px);
          }

          .chart-side {
            height: 58vh;
            min-height: 420px;
            border-right: 0;
            border-bottom: 1px solid #202633;
          }

          .terminal-side {
            height: 680px;
          }

          .terminal-stats {
            display: none;
          }
        }
      `}</style>

      <header className="terminal-header">
        <div className="terminal-symbol">
          {onClose && (
            <button
              className="close-terminal"
              onClick={onClose}
              title="Înapoi"
            >
              ‹
            </button>
          )}

          <span className="symbol-name">
            {fullSymbol.replace("USDT", "")}/USDT
          </span>

          <span className="futures-pill">
            PERPETUAL
          </span>

          <span className="live">
            <span
              className="live-dot"
              style={{
                background: connected ? "#00e676" : "#ef4444",
                boxShadow: connected
                  ? "0 0 10px rgba(0,230,118,.8)"
                  : "0 0 10px rgba(239,68,68,.8)",
              }}
            />
            {connected ? "LIVE" : "OFFLINE"}
          </span>
        </div>

        <div className="terminal-stats">
          <div>
            <span className="stat-label">PRICE</span>
            <span className="stat-value">
              {ticker ? fmt(ticker.price, pDigits) : "—"}
            </span>
          </div>

          <div>
            <span className="stat-label">24H</span>
            <span
              className={`stat-value ${
                Number(ticker?.change) >= 0
                  ? "positive"
                  : "negative"
              }`}
            >
              {ticker
                ? `${ticker.change >= 0 ? "+" : ""}${ticker.change.toFixed(2)}%`
                : "—"}
            </span>
          </div>

          <div>
            <span className="stat-label">24H VOL</span>
            <span className="stat-value">
              {ticker ? compact(ticker.volume) : "—"}
            </span>
          </div>
        </div>
      </header>

      <div className="terminal-body">
        <section className="chart-side">
          <div className="chart-toolbar">
            {["1m", "3m", "5m", "15m", "30m", "1h"].map(
              (tf) => (
                <button
                  key={tf}
                  className={`tf-button ${
                    interval === tf ? "active" : ""
                  }`}
                  onClick={() => setIntervalValue(tf)}
                >
                  {tf}
                </button>
              )
            )}

            <span
              style={{
                marginLeft: "auto",
                color: "#334155",
                fontSize: 9,
              }}
            >
              BINANCE FUTURES
            </span>
          </div>

          <div className="chart-wrapper">
            <div className="heatmap-label">
              LIQUIDITY HEATMAP · LIVE ORDER BOOK
            </div>

            <HeatmapCanvas
              levels={heatmap}
              midPrice={Number(ticker?.price || 0)}
              minPrice={heatRange.min}
              maxPrice={heatRange.max}
            />

            <div
              ref={chartContainerRef}
              className="chart-container"
            />
          </div>
        </section>

        <aside className="terminal-side">
          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">
                ORDER BOOK
              </span>
              <span className="panel-sub">
                DEPTH 20 · 100ms
              </span>
            </div>

            <div className="book">
              <div className="book-head">
                <span>PRICE</span>
                <span style={{ textAlign: "right" }}>
                  QTY
                </span>
                <span style={{ textAlign: "right" }}>
                  USDT
                </span>
              </div>

              <div className="book-asks">
                {displayAsks.map((x) => (
                  <div
                    className="book-row"
                    key={`ask-${x.price}`}
                    style={{
                      "--depth-width": `${
                        Math.min(
                          100,
                          (x.qty / maxBookQty) * 100
                        )
                      }%`,
                      "--depth-color": "#ef4444",
                    }}
                  >
                    <span className="ask-price">
                      {fmt(x.price, pDigits)}
                    </span>
                    <span className="book-number">
                      {compact(x.qty)}
                    </span>
                    <span className="book-usdt">
                      {compact(x.qty * x.price)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mid-price">
                <strong>
                  {ticker
                    ? fmt(ticker.price, pDigits)
                    : "—"}
                </strong>
                <span className="spread">
                  SPREAD{" "}
                  {spread !== null
                    ? fmt(spread, pDigits)
                    : "—"}
                </span>
              </div>

              <div className="book-bids">
                {displayBids.map((x) => (
                  <div
                    className="book-row"
                    key={`bid-${x.price}`}
                    style={{
                      "--depth-width": `${
                        Math.min(
                          100,
                          (x.qty / maxBookQty) * 100
                        )
                      }%`,
                      "--depth-color": "#00e676",
                    }}
                  >
                    <span className="bid-price">
                      {fmt(x.price, pDigits)}
                    </span>
                    <span className="book-number">
                      {compact(x.qty)}
                    </span>
                    <span className="book-usdt">
                      {compact(x.qty * x.price)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="delta-bar">
                <div
                  className="delta-buy"
                  style={{
                    width: `${
                      depthStats.bidVolume +
                        depthStats.askVolume >
                      0
                        ? (depthStats.bidVolume /
                            (depthStats.bidVolume +
                              depthStats.askVolume)) *
                          100
                        : 50
                    }%`,
                  }}
                >
                  BID {compact(depthStats.bidVolume)}
                </div>

                <div
                  className="delta-sell"
                  style={{
                    width: `${
                      depthStats.bidVolume +
                        depthStats.askVolume >
                      0
                        ? (depthStats.askVolume /
                            (depthStats.bidVolume +
                              depthStats.askVolume)) *
                          100
                        : 50
                    }%`,
                  }}
                >
                  ASK {compact(depthStats.askVolume)}
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <span className="panel-title">
                TIME & SALES
              </span>
              <span className="panel-sub">
                AGG TRADES · LIVE
              </span>
            </div>

            <div className="tape">
              {trades.length === 0 ? (
                <div className="empty">
                  Aștept tranzacții...
                </div>
              ) : (
                trades.map((trade) => (
                  <div
                    className="trade-row"
                    key={trade.id}
                  >
                    <span className="trade-time">
                      {shortTime(trade.time)}
                    </span>

                    <span className="trade-price">
                      {fmt(
                        trade.price,
                        pDigits
                      )}
                    </span>

                    <span className="trade-value">
                      ${compact(trade.notional)}
                    </span>

                    <span
                      className={`trade-side ${
                        trade.side === "BUY"
                          ? "buy"
                          : "sell"
                      }`}
                    >
                      {trade.side}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </aside>
      </div>

      {error && (
        <div
          style={{
            position: "fixed",
            left: 12,
            bottom: 12,
            zIndex: 20,
            background: "#251014",
            border: "1px solid #5b2028",
            color: "#ff7b86",
            borderRadius: 6,
            padding: "8px 12px",
            fontSize: 10,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
