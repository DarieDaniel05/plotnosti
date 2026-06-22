import { useState, useEffect, useCallback } from "react";
import { Activity, RefreshCw, AlertTriangle, Zap, Clock, BarChart2, ArrowUpRight, TrendingUp } from "lucide-react";

const HighVolumeBar = () => {
  const [movers, setMovers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdate, setLastUpdate] = useState("");
  const [multiplier, setMultiplier] = useState(3);
  const [totalScanned, setTotalScanned] = useState(0);
  const [scanProgress, setScanProgress] = useState(0);

  const fetchKlines = async (symbol) => {
    try {
      const res = await fetch(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=4`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const klines = await res.json();
      if (klines.length < 4) return null;

      // index [len-4] = H-2, [len-3] = H-1, [len-2] = current closed, [len-1] = unclosed (ignored)
      const h2BaseVol    = parseFloat(klines[klines.length - 4][5]);
      const h1BaseVol    = parseFloat(klines[klines.length - 3][5]);
      const currBaseVol  = parseFloat(klines[klines.length - 2][5]);

      // Quote volumes (USDT) for display
      const h2QuoteVol   = parseFloat(klines[klines.length - 4][7]);
      const h1QuoteVol   = parseFloat(klines[klines.length - 3][7]);
      const currQuoteVol = parseFloat(klines[klines.length - 2][7]);

      const openPrice    = parseFloat(klines[klines.length - 2][1]);
      const closePrice   = parseFloat(klines[klines.length - 2][4]);
      const highPrice    = parseFloat(klines[klines.length - 2][2]);
      const openTime     = klines[klines.length - 2][0];

      const sumPrev = h2BaseVol + h1BaseVol;
      if (sumPrev <= 0) return null;

      return {
        ratio: currBaseVol / sumPrev,
        currQuoteVol,
        h1QuoteVol,
        h2QuoteVol,
        openPrice,
        closePrice,
        highPrice,
        priceChange: ((closePrice - openPrice) / openPrice) * 100,
        openTime,
      };
    } catch {
      return null;
    }
  };

  const runScan = useCallback(async () => {
    setIsLoading(true);
    setError("");
    setScanProgress(0);
    setMovers([]);

    try {
      const exRes = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo");
      if (!exRes.ok) throw new Error("Eroare la lista de simboluri");
      const exData = await exRes.json();

      const symbols = exData.symbols
        .filter(
          (s) =>
            s.status === "TRADING" &&
            s.contractType === "PERPETUAL" &&
            s.symbol.endsWith("USDT")
        )
        .map((s) => s.symbol);

      setTotalScanned(symbols.length);
      setScanProgress(5);

      const BATCH = 30;
      const found = [];

      for (let i = 0; i < symbols.length; i += BATCH) {
        const batch = symbols.slice(i, i + BATCH);
        const results = await Promise.all(
          batch.map(async (sym) => {
            const d = await fetchKlines(sym);
            if (!d || d.ratio < multiplier) return null;
            return { symbol: sym.replace("USDT", ""), fullSymbol: sym, ...d };
          })
        );
        found.push(...results.filter(Boolean));
        setScanProgress(5 + Math.round(((i + batch.length) / symbols.length) * 90));
        if (i + BATCH < symbols.length) await new Promise((r) => setTimeout(r, 80));
      }

      found.sort((a, b) => b.ratio - a.ratio);
      setScanProgress(100);
      setMovers(found);
      setLastUpdate(new Date().toLocaleTimeString("ro-RO"));
    } catch (err) {
      setError("Eroare: " + err.message);
    } finally {
      setIsLoading(false);
    }
  }, [multiplier]);

  useEffect(() => {
    runScan();
  }, [runScan]);

  /* ── Helpers ── */
  const fmtVol = (v) => {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(2) + "K";
    return v.toFixed(0);
  };

  const fmtPrice = (p) => {
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1)    return p.toFixed(4);
    if (p >= 0.001) return p.toFixed(6);
    return p.toFixed(8);
  };

  const fmtHour = (ts) =>
    new Date(ts).toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" });

  const ratioColor = (r) =>
    r >= 10 ? "#ff4d4d" : r >= 7 ? "#ff8c00" : r >= 5 ? "#ffd700" : "#00e676";
  const ratioBg = (r) =>
    r >= 10 ? "rgba(255,77,77,0.10)" : r >= 7 ? "rgba(255,140,0,0.10)" : r >= 5
      ? "rgba(255,215,0,0.10)" : "rgba(0,230,118,0.08)";

  const openTV = (sym) =>
    window.open(`https://www.tradingview.com/chart/?symbol=BINANCE%3A${sym}`, "_blank");

  /* ── Render ── */
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0c10",
        color: "#e2e8f0",
        fontFamily: "'JetBrains Mono','Fira Code',monospace",
        padding: "24px",
      }}
    >
      {/* ambient glow */}
      <div
        style={{
          position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none",
          background:
            "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(0,230,118,0.07) 0%, transparent 60%)",
        }}
      />

      <div style={{ position: "relative", zIndex: 1, maxWidth: 1200, margin: "0 auto" }}>

        {/* ── Header ── */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <Activity size={26} color="#00e676" />
            <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.5px", color: "#fff", margin: 0 }}>
              High Volume Bars
            </h1>
            <span style={{
              fontSize: 11, borderRadius: 4, padding: "2px 8px",
              background: "rgba(0,230,118,0.15)", color: "#00e676",
              border: "1px solid rgba(0,230,118,0.3)",
            }}>FUTURES 1H</span>
          </div>
          <p style={{ color: "#64748b", fontSize: 12, margin: 0 }}>
            Candela orară curentă cu volum ≥ {multiplier}x suma celor 2 ore precedente · Click → TradingView
          </p>
        </div>

        {/* ── Stat cards ── */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10, marginBottom: 20,
        }}>

          {/* Multiplier */}
          <div style={cardStyle}>
            <p style={labelStyle}>MULTIPLICATOR</p>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="number" value={multiplier} min={1} max={50} step={0.5}
                onChange={(e) => setMultiplier(parseFloat(e.target.value) || 3)}
                style={{
                  background: "#1a1e27", border: "1px solid #2d3348", color: "#00e676",
                  borderRadius: 6, padding: "4px 8px", width: 52, fontSize: 20, fontWeight: 700,
                  fontFamily: "inherit", outline: "none",
                }}
              />
              <span style={{ color: "#00e676", fontSize: 20, fontWeight: 700 }}>x</span>
            </div>
          </div>

          {/* Scanned */}
          <div style={cardStyle}>
            <p style={labelStyle}>SCANATE</p>
            <p style={bigNumStyle}>{totalScanned || "—"}</p>
            <p style={subLabelStyle}>simboluri futures</p>
          </div>

          {/* Found */}
          <div style={cardStyle}>
            <p style={labelStyle}>GĂSITE</p>
            <p style={{ ...bigNumStyle, color: "#00e676" }}>{movers.length}</p>
            <p style={subLabelStyle}>≥ {multiplier}x volum</p>
          </div>

          {/* Updated + Refresh */}
          <div style={cardStyle}>
            <p style={labelStyle}>ULTIMA SCANARE</p>
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 8 }}>
              <Clock size={13} color="#64748b" />
              <span style={{ fontSize: 13, color: "#cbd5e1" }}>{lastUpdate || "—"}</span>
            </div>
            <button
              onClick={runScan}
              disabled={isLoading}
              style={{
                background: isLoading ? "#1a1e27" : "rgba(0,230,118,0.1)",
                border: "1px solid rgba(0,230,118,0.3)",
                color: "#00e676", borderRadius: 6, padding: "5px 12px",
                fontSize: 11, cursor: isLoading ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit",
              }}
            >
              <RefreshCw size={11} style={{ animation: isLoading ? "spin 1s linear infinite" : "none" }} />
              RESCANEAZĂ
            </button>
          </div>
        </div>

        {/* ── Loading ── */}
        {isLoading && (
          <div style={{
            background: "#111318", border: "1px solid #1e2330", borderRadius: 12,
            padding: "52px 24px", textAlign: "center",
          }}>
            <Zap size={34} color="#00e676" style={{ margin: "0 auto 14px", display: "block", animation: "pulse 1.2s ease-in-out infinite" }} />
            <p style={{ color: "#94a3b8", fontSize: 13, marginBottom: 18 }}>
              Se analizează volumele orare · {totalScanned > 0 ? `${totalScanned} simboluri` : ""}
            </p>
            <div style={{
              background: "#1a1e27", borderRadius: 999, height: 5,
              width: 260, margin: "0 auto", overflow: "hidden",
            }}>
              <div style={{
                height: "100%", borderRadius: 999,
                background: "linear-gradient(90deg, #00e676, #69f0ae)",
                width: `${scanProgress}%`, transition: "width 0.35s ease",
              }} />
            </div>
            <p style={{ color: "#334155", fontSize: 11, marginTop: 8 }}>{scanProgress}%</p>
          </div>
        )}

        {/* ── Error ── */}
        {error && !isLoading && (
          <div style={{
            background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 12, padding: "20px 24px", display: "flex", alignItems: "center", gap: 12,
          }}>
            <AlertTriangle size={18} color="#ef4444" />
            <p style={{ color: "#ef4444", margin: 0, fontSize: 13 }}>{error}</p>
          </div>
        )}

        {/* ── Results ── */}
        {!isLoading && !error && (
          <div style={{ background: "#111318", border: "1px solid #1e2330", borderRadius: 12, overflow: "hidden" }}>

            {/* table header bar */}
            <div style={{
              padding: "14px 20px", borderBottom: "1px solid #1e2330",
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <BarChart2 size={15} color="#00e676" />
                <span style={{ fontSize: 12, color: "#94a3b8" }}>
                  {movers.length} monede · volum orar curent ≥ {multiplier}x (H-1 + H-2)
                </span>
              </div>
              <span style={{ fontSize: 11, color: "#2d3348" }}>↖ Click pe rând → TradingView</span>
            </div>

            {/* empty state */}
            {movers.length === 0 ? (
              <div style={{ padding: "64px 24px", textAlign: "center" }}>
                <TrendingUp size={38} color="#1e2330" style={{ margin: "0 auto 14px", display: "block" }} />
                <p style={{ color: "#475569", fontSize: 14, marginBottom: 6 }}>
                  Nicio monedă nu îndeplinește condiția de {multiplier}x volum.
                </p>
                <p style={{ color: "#334155", fontSize: 12 }}>Încearcă un multiplicator mai mic.</p>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#0d1017" }}>
                      {["#", "Simbol", "Ratio", "Vol. Curent (USDT)", "Vol. H-1", "Vol. H-2", "Preț", "Variație", "Oră"].map(
                        (h, i) => (
                          <th
                            key={i}
                            style={{
                              padding: "11px 14px",
                              textAlign: i <= 1 ? "left" : "right",
                              fontSize: 10, color: "#475569", fontWeight: 600,
                              letterSpacing: "0.05em",
                            }}
                          >
                            {h}
                          </th>
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {movers.map((coin, idx) => {
                      const rc = ratioColor(coin.ratio);
                      const rb = ratioBg(coin.ratio);
                      const pc = coin.priceChange >= 0 ? "#00e676" : "#ef4444";
                      return (
                        <tr
                          key={coin.fullSymbol}
                          onClick={() => openTV(coin.fullSymbol)}
                          style={{
                            background: idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.012)",
                            borderBottom: "1px solid #1a1e27",
                            cursor: "pointer",
                            transition: "background 0.15s",
                          }}
                          onMouseEnter={(e) =>
                            (e.currentTarget.style.background = "rgba(0,230,118,0.045)")
                          }
                          onMouseLeave={(e) =>
                            (e.currentTarget.style.background =
                              idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.012)")
                          }
                        >
                          {/* rank */}
                          <td style={{ padding: "11px 14px", color: "#2d3348", fontSize: 11 }}>
                            {idx + 1}
                          </td>

                          {/* symbol */}
                          <td style={{ padding: "11px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <div style={{
                                width: 34, height: 34,
                                background: rb, border: `1px solid ${rc}30`, borderRadius: 8,
                                display: "flex", alignItems: "center", justifyContent: "center",
                                fontSize: 9, fontWeight: 700, color: rc, flexShrink: 0,
                              }}>
                                {coin.symbol.slice(0, 4)}
                              </div>
                              <div>
                                <p style={{ margin: 0, fontWeight: 700, color: "#f1f5f9", fontSize: 13 }}>
                                  {coin.symbol}
                                </p>
                                <p style={{ margin: 0, color: "#334155", fontSize: 10 }}>USDT Perp</p>
                              </div>
                            </div>
                          </td>

                          {/* ratio badge */}
                          <td style={{ padding: "11px 14px", textAlign: "right" }}>
                            <div style={{
                              display: "inline-flex", alignItems: "center", gap: 4,
                              background: rb, border: `1px solid ${rc}40`,
                              borderRadius: 6, padding: "4px 9px",
                            }}>
                              <ArrowUpRight size={13} color={rc} />
                              <span style={{ color: rc, fontWeight: 800, fontSize: 14 }}>
                                x{coin.ratio.toFixed(1)}
                              </span>
                            </div>
                          </td>

                          {/* current volume */}
                          <td style={{ padding: "11px 14px", textAlign: "right", color: "#f1f5f9", fontWeight: 700, fontSize: 12 }}>
                            ${fmtVol(coin.currQuoteVol)}
                          </td>

                          {/* h-1 volume */}
                          <td style={{ padding: "11px 14px", textAlign: "right", color: "#64748b", fontSize: 12 }}>
                            ${fmtVol(coin.h1QuoteVol)}
                          </td>

                          {/* h-2 volume */}
                          <td style={{ padding: "11px 14px", textAlign: "right", color: "#475569", fontSize: 12 }}>
                            ${fmtVol(coin.h2QuoteVol)}
                          </td>

                          {/* price */}
                          <td style={{ padding: "11px 14px", textAlign: "right", color: "#e2e8f0", fontWeight: 600, fontSize: 12 }}>
                            ${fmtPrice(coin.closePrice)}
                          </td>

                          {/* price change */}
                          <td style={{ padding: "11px 14px", textAlign: "right" }}>
                            <span style={{ color: pc, fontSize: 12, fontWeight: 600 }}>
                              {coin.priceChange >= 0 ? "+" : ""}{coin.priceChange.toFixed(2)}%
                            </span>
                          </td>

                          {/* candle open time */}
                          <td style={{ padding: "11px 14px", textAlign: "right", color: "#334155", fontSize: 11 }}>
                            {fmtHour(coin.openTime)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <p style={{ color: "#1e2330", fontSize: 10, textAlign: "center", marginTop: 18 }}>
          Date: API public Binance Futures · Condiție: Vol(H) ≥ {multiplier}x (Vol(H-1) + Vol(H-2)) · Candele 1h complet închise
        </p>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
    </div>
  );
};

/* ── Shared card styles ── */
const cardStyle = {
  background: "#111318",
  border: "1px solid #1e2330",
  borderRadius: 10,
  padding: "14px 16px",
};
const labelStyle = {
  color: "#475569", fontSize: 10, fontWeight: 600,
  letterSpacing: "0.06em", marginBottom: 8, marginTop: 0,
};
const bigNumStyle = {
  fontSize: 26, fontWeight: 700, color: "#fff", margin: 0,
};
const subLabelStyle = {
  color: "#334155", fontSize: 10, margin: 0, marginTop: 2,
};

export default HighVolumeBar;