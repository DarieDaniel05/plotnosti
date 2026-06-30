import { useState, useEffect, useCallback, useRef } from "react";
import { Activity, RefreshCw, AlertTriangle, Zap, Clock, BarChart2, ArrowUpRight, TrendingUp, Bell } from "lucide-react";

// ── Star helpers (scală 0-4, identică cu logica Android) ──────────────────────
const starsColor = (n) => {
  if (n >= 4) return "#FF4D4D";
  if (n === 3) return "#FF8C00";
  if (n === 2) return "#FFD700";
  if (n === 1) return "#8B949E";
  return "transparent";
};

const StarsBadge = ({ count }) => {
  if (!count) return null;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 2,
      background: `${starsColor(count)}22`,
      border: `1px solid ${starsColor(count)}55`,
      borderRadius: 4, padding: "2px 7px",
      fontSize: 11, fontWeight: 700,
      color: starsColor(count),
      letterSpacing: 2,
      fontFamily: "inherit",
    }}>
      {"★".repeat(count)}
    </span>
  );
};

// Ordinea identică cu blocul de stele din VolumeCheckWorker.kt
const STAR_LABELS = [
  "Liniște înainte de furtună (avg 6h < 30% din avg24h)",
  "Mișcare preț ≥ 3% pe candela curentă",
  "Small-cap (vol. zilnic 1–50M USDT)",
  "Accelerare: H-2 < H-1 < H curent",
];

const StarsTooltip = ({ flags }) => {
  const [pos, setPos] = useState(null);
  const iconRef = useRef(null);
  if (!flags) return null;

  const handleMouseEnter = () => {
    if (!iconRef.current) return;
    const r = iconRef.current.getBoundingClientRect();
    const tooltipHeight = 148;
    const tooltipWidth = 250;
    const top = r.top > tooltipHeight + 16 ? r.top - tooltipHeight - 8 : r.bottom + 8;
    const left = Math.max(8, Math.min(r.right - tooltipWidth, window.innerWidth - tooltipWidth - 8));
    setPos({ top, left });
  };

  return (
    <>
      <span
        ref={iconRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setPos(null)}
        style={{ cursor: "help", color: "#475569", fontSize: 11, userSelect: "none" }}
      >ⓘ</span>
      {pos && (
        <div style={{
          position: "fixed", top: pos.top, left: pos.left,
          background: "#1a1e27", border: "1px solid #2d3348",
          borderRadius: 8, padding: "10px 14px", zIndex: 9999,
          minWidth: 240, pointerEvents: "none",
          boxShadow: "0 8px 32px rgba(0,0,0,0.7)",
        }}>
          <p style={{ margin: "0 0 8px", fontSize: 10, color: "#475569", fontWeight: 600, letterSpacing: "0.05em" }}>
            CONDIȚII STELE
          </p>
          {STAR_LABELS.map((label, i) => (
            <div key={i} style={{
              fontSize: 11, marginBottom: i < STAR_LABELS.length - 1 ? 6 : 0,
              color: flags[i] ? "#00e676" : "#334155",
              display: "flex", alignItems: "flex-start", gap: 8,
            }}>
              <span style={{ fontSize: 12, flexShrink: 0, marginTop: 1 }}>{flags[i] ? "✓" : "○"}</span>
              <span>★ {label}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
};

// ── Main component ────────────────────────────────────────────────────────────
const HighVolumeBar = () => {
  const [movers, setMovers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdate, setLastUpdate] = useState("");
  const [totalScanned, setTotalScanned] = useState(0);
  const [scanProgress, setScanProgress] = useState(0);

  // limit=28:
  //   [0..23]  → 24 candele pentru media 24h
  //   [20..25] → ultimele 6 ore (baseline avg6h)
  //   [24]     → H-2     [25] → H-1     [26] → H curent (închis)     [27] → deschis (ignorat)
  const fetchKlines = async (symbol) => {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=28`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const klines = await res.json();
      if (klines.length < 28) return null;

      // Volum bază asset (index 5) — folosit pentru toate comparațiile/filtrele
      const hourMinus2Volume = parseFloat(klines[24][5]);
      const hourMinus1Volume = parseFloat(klines[25][5]);
      const currentVolume    = parseFloat(klines[26][5]);

      // Quote volume USDT (index 7) — doar pentru afișare $
      const currQuoteVol = parseFloat(klines[26][7]);

      const openPrice  = parseFloat(klines[26][1]);
      const closePrice = parseFloat(klines[26][4]);
      const openTime   = klines[26][0];

      // baseline ponderat pt. pragul x3 — identic cu Android: H-1 + H-2/2
      const totalHoursVolume = hourMinus1Volume + hourMinus2Volume / 2.0;

      // media ultimelor 6h (H-6..H-1) — baseline principal
      let sum6h = 0;
      for (let i = 20; i <= 25; i++) sum6h += parseFloat(klines[i][5]);
      const avg6h = sum6h / 6;

      // media 24h
      let sum24h = 0;
      for (let i = 0; i < 24; i++) sum24h += parseFloat(klines[i][5]);
      const avg24h = sum24h / 24;

      // volum zilnic USDT (suma 24h quote)
      let dailyUsdt = 0;
      for (let i = 0; i < 24; i++) dailyUsdt += parseFloat(klines[i][7]);

      // ── Filtre obligatorii (identice cu VolumeCheckWorker.kt) ──────────────
      if (currentVolume < avg24h * 5 || currentVolume < avg6h * 10) return null;
      if (dailyUsdt >= 6_666_666) return null;
      if (currentVolume < totalHoursVolume * 3) return null;
      if (openPrice > closePrice) return null; // doar candele verzi

      // ── Calcul stele ────────────────────────────────────────────────────
      const pricePct = openPrice > 0 ? Math.abs((closePrice - openPrice) / openPrice) : 0;

      const flag1 = avg24h > 0 && avg6h < avg24h * 0.3;
      const flag2 = pricePct >= 0.03;
      const flag3 = dailyUsdt >= 1 && dailyUsdt <= 50_000_000;
      const flag4 = hourMinus2Volume > 0 && hourMinus2Volume < hourMinus1Volume && hourMinus1Volume < currentVolume;
      const flags = [flag1, flag2, flag3, flag4];
      const stars = flags.filter(Boolean).length;

      const ratio = currentVolume / avg6h;
      const notifyWorthy = currentVolume >= totalHoursVolume * 10 && stars >= 3;

      return {
        ratio, stars, flags, notifyWorthy,
        currQuoteVol,
        openPrice, closePrice,
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
        .filter(s => s.status === "TRADING" && s.contractType === "PERPETUAL" && s.symbol.endsWith("USDT"))
        .map(s => s.symbol);

      setTotalScanned(symbols.length);
      setScanProgress(5);

      const BATCH = 30;
      const found = [];

      for (let i = 0; i < symbols.length; i += BATCH) {
        const batch = symbols.slice(i, i + BATCH);
        const results = await Promise.all(
          batch.map(async (sym) => {
            const d = await fetchKlines(sym);
            if (!d) return null;
            return { symbol: sym.replace("USDT", ""), fullSymbol: sym, ...d };
          })
        );
        found.push(...results.filter(Boolean));
        setScanProgress(5 + Math.round(((i + batch.length) / symbols.length) * 90));
        if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 80));
      }

      // Sortare: notifyWorthy (ar trimite push pe telefon) → stele → ratio
      found.sort((a, b) => {
        if (a.notifyWorthy !== b.notifyWorthy) return a.notifyWorthy ? -1 : 1;
        if (b.stars !== a.stars) return b.stars - a.stars;
        return b.ratio - a.ratio;
      });

      setScanProgress(100);
      setMovers(found);
      setLastUpdate(new Date().toLocaleTimeString("ro-RO"));
    } catch (err) {
      setError("Eroare: " + err.message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { runScan(); }, [runScan]);

  // ── Helpers ──────────────────────────────────────────────────────────────
  const fmtVol = (v) => {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(2) + "K";
    return v.toFixed(0);
  };
  const fmtPrice = (p) => {
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1) return p.toFixed(4);
    if (p >= 0.001) return p.toFixed(6);
    return p.toFixed(8);
  };
  const fmtHour = (ts) => new Date(ts).toLocaleTimeString("ro-RO", { hour: "2-digit", minute: "2-digit" });
  const ratioColor = (r) => r >= 25 ? "#ff4d4d" : r >= 15 ? "#ff8c00" : r >= 10 ? "#ffd700" : "#00e676";
  const ratioBg = (r) => r >= 25 ? "rgba(255,77,77,0.10)" : r >= 15 ? "rgba(255,140,0,0.10)"
    : r >= 10 ? "rgba(255,215,0,0.10)" : "rgba(0,230,118,0.08)";
  const openTV = (sym) => window.open(`https://www.tradingview.com/chart/?symbol=BINANCE%3A${sym}`, "_blank");

  const notifyCount = movers.filter(m => m.notifyWorthy).length;
  const starDist = [4, 3, 2, 1, 0].map(n => ({
    n, count: movers.filter(m => m.stars === n).length
  })).filter(s => s.count > 0);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: "100vh", background: "#0a0c10", color: "#e2e8f0",
      fontFamily: "'JetBrains Mono','Fira Code',monospace", padding: "24px",
    }}>
      <div style={{
        position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none",
        background: "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(0,230,118,0.07) 0%, transparent 60%)",
      }} />

      <div style={{ position: "relative", zIndex: 1, maxWidth: 1260, margin: "0 auto" }}>

        {/* ── Header ── */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <Activity size={26} color="#00e676" />
            <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.5px", color: "#fff", margin: 0 }}>
              High Volume Bars
            </h1>
            <span style={{
              fontSize: 10, borderRadius: 4, padding: "2px 8px",
              background: "rgba(0,230,118,0.15)", color: "#00e676",
              border: "1px solid rgba(0,230,118,0.3)",
            }}>FUTURES 1H</span>
          </div>
          <p style={{ color: "#64748b", fontSize: 12, margin: 0 }}>
            Vol(H) ≥ 3x baseline ponderat · ≥5x avg24h și ≥10x avg6h · doar candele verzi · vol. zilnic &lt; 10M USDT
          </p>
        </div>

        {/* ── Stat cards ── */}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
          gap: 10, marginBottom: 14,
        }}>
          <div style={cardStyle}>
            <p style={labelStyle}>SCANATE</p>
            <p style={bigNumStyle}>{totalScanned || "—"}</p>
            <p style={subLabelStyle}>simboluri futures</p>
          </div>

          <div style={cardStyle}>
            <p style={labelStyle}>ÎN LISTĂ</p>
            <p style={{ ...bigNumStyle, color: "#00e676" }}>{movers.length}</p>
            <p style={subLabelStyle}>trec toate filtrele</p>
          </div>

          <div style={cardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 8 }}>
              <Bell size={11} color="#64748b" />
              <p style={{ ...labelStyle, marginBottom: 0 }}>NOTIFICĂ</p>
            </div>
            <p style={{ ...bigNumStyle, color: notifyCount > 0 ? "#FF4D4D" : "#fff" }}>{notifyCount}</p>
            <p style={subLabelStyle}>x10 + ≥3★ (= push Android)</p>
          </div>

          <div style={cardStyle}>
            <p style={labelStyle}>DISTRIBUȚIE ★</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {starDist.length === 0 ? (
                <span style={{ color: "#334155", fontSize: 12 }}>—</span>
              ) : starDist.map(({ n, count }) => (
                <div key={n} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: starsColor(n), fontSize: 11, minWidth: 50, letterSpacing: n > 0 ? 2 : 0 }}>
                    {n > 0 ? "★".repeat(n) : "fără ★"}
                  </span>
                  <span style={{ color: "#64748b", fontSize: 11, background: "#1a1e27", borderRadius: 4, padding: "1px 6px" }}>
                    {count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div style={cardStyle}>
            <p style={labelStyle}>ULTIMA SCANARE</p>
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 10 }}>
              <Clock size={13} color="#64748b" />
              <span style={{ fontSize: 12, color: "#cbd5e1" }}>{lastUpdate || "—"}</span>
            </div>
            <button
              onClick={runScan} disabled={isLoading}
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

        {/* ── Legendă ── */}
        <div style={{
          background: "#111318", border: "1px solid #1e2330", borderRadius: 8,
          padding: "10px 16px", marginBottom: 14,
          display: "flex", flexWrap: "wrap", gap: "8px 20px", alignItems: "center",
        }}>
          <span style={{ color: "#475569", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em" }}>LEGENDĂ</span>
          {STAR_LABELS.map((label, i) => (
            <span key={i} style={{ fontSize: 11, color: "#64748b", display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ color: "#ffd700", fontSize: 12 }}>★</span>{label}
            </span>
          ))}
          <span style={{ fontSize: 11, color: "#64748b", display: "flex", alignItems: "center", gap: 5 }}>
            <Bell size={11} color="#FF4D4D" /> = ar trimite notificare reală pe Android
          </span>
        </div>

        {/* ── Loading ── */}
        {isLoading && (
          <div style={{ background: "#111318", border: "1px solid #1e2330", borderRadius: 12, padding: "52px 24px", textAlign: "center" }}>
            <Zap size={34} color="#00e676" style={{ margin: "0 auto 14px", display: "block", animation: "pulse 1.2s ease-in-out infinite" }} />
            <p style={{ color: "#94a3b8", fontSize: 13, marginBottom: 18 }}>
              Se aplică filtrele și se calculează stelele · {totalScanned > 0 ? `${totalScanned} simboluri` : ""}
            </p>
            <div style={{ background: "#1a1e27", borderRadius: 999, height: 5, width: 260, margin: "0 auto", overflow: "hidden" }}>
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
            <div style={{
              padding: "14px 20px", borderBottom: "1px solid #1e2330",
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <BarChart2 size={15} color="#00e676" />
                <span style={{ fontSize: 12, color: "#94a3b8" }}>
                  {movers.length} monede · sortat 🔔→★→ratio
                </span>
              </div>
              <span style={{ fontSize: 10, color: "#2d3348" }}>hover ⓘ → condiții · click → TradingView</span>
            </div>

            {movers.length === 0 ? (
              <div style={{ padding: "64px 24px", textAlign: "center" }}>
                <TrendingUp size={38} color="#1e2330" style={{ margin: "0 auto 14px", display: "block" }} />
                <p style={{ color: "#475569", fontSize: 14, marginBottom: 6 }}>
                  Nicio monedă nu îndeplinește toate filtrele în acest moment.
                </p>
                <p style={{ color: "#334155", fontSize: 12 }}>Volum, candelă verde și small-cap trebuie să coincidă.</p>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#0d1017" }}>
                      {["#", "Simbol", "★", "Ratio", "Vol. Curent", "Preț", "Variație", "Oră"].map((h, i) => (
                        <th key={i} style={{
                          padding: "11px 14px",
                          textAlign: i <= 2 ? "left" : "right",
                          fontSize: 10, color: "#475569", fontWeight: 600,
                          letterSpacing: "0.05em", whiteSpace: "nowrap",
                        }}>{h}</th>
                      ))}
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
                            background: coin.notifyWorthy ? "rgba(255,77,77,0.04)"
                              : idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.012)",
                            borderBottom: "1px solid #1a1e27",
                            borderLeft: coin.notifyWorthy ? "2px solid #FF4D4D" : "2px solid transparent",
                            cursor: "pointer", transition: "background 0.15s",
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgba(0,230,118,0.045)"}
                          onMouseLeave={e => e.currentTarget.style.background = coin.notifyWorthy ? "rgba(255,77,77,0.04)" : (idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.012)")}
                        >
                          {/* rank */}
                          <td style={{ padding: "11px 14px", color: "#2d3348", fontSize: 11 }}>{idx + 1}</td>

                          {/* symbol */}
                          <td style={{ padding: "11px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <div style={{
                                width: 34, height: 34, background: rb,
                                border: `1px solid ${rc}30`, borderRadius: 8,
                                display: "flex", alignItems: "center", justifyContent: "center",
                                fontSize: 9, fontWeight: 700, color: rc, flexShrink: 0,
                              }}>
                                {coin.symbol.slice(0, 4)}
                              </div>
                              <div>
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <p style={{ margin: 0, fontWeight: 700, color: "#f1f5f9", fontSize: 13 }}>{coin.symbol}</p>
                                  {coin.notifyWorthy && <Bell size={11} color="#FF4D4D" />}
                                </div>
                                <p style={{ margin: 0, color: "#334155", fontSize: 10 }}>USDT Perp</p>
                              </div>
                            </div>
                          </td>

                          {/* stars + tooltip */}
                          <td style={{ padding: "11px 14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <StarsBadge count={coin.stars} />
                              <StarsTooltip flags={coin.flags} />
                            </div>
                          </td>

                          {/* ratio */}
                          <td style={{ padding: "11px 14px", textAlign: "right" }}>
                            <div style={{
                              display: "inline-flex", alignItems: "center", gap: 4,
                              background: rb, border: `1px solid ${rc}40`,
                              borderRadius: 6, padding: "4px 9px",
                            }}>
                              <ArrowUpRight size={13} color={rc} />
                              <span style={{ color: rc, fontWeight: 800, fontSize: 14 }}>x{coin.ratio.toFixed(1)}</span>
                            </div>
                          </td>

                          {/* vol curent */}
                          <td style={{ padding: "11px 14px", textAlign: "right", color: "#f1f5f9", fontWeight: 700, fontSize: 12 }}>
                            ${fmtVol(coin.currQuoteVol)}
                          </td>

                          {/* pret */}
                          <td style={{ padding: "11px 14px", textAlign: "right", color: "#e2e8f0", fontWeight: 600, fontSize: 12 }}>
                            ${fmtPrice(coin.closePrice)}
                          </td>

                          {/* variatie */}
                          <td style={{ padding: "11px 14px", textAlign: "right" }}>
                            <span style={{ color: pc, fontSize: 12, fontWeight: 600 }}>
                              {coin.priceChange >= 0 ? "+" : ""}{coin.priceChange.toFixed(2)}%
                            </span>
                          </td>

                          {/* ora */}
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

        <p style={{ color: "#1e2330", fontSize: 10, textAlign: "center", marginTop: 16 }}>
          Date: API public Binance Futures · Filtre identice cu aplicația Android · 🔔 = ar declanșa notificare push (x10 + ≥3★)
        </p>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
    </div>
  );
};

const cardStyle = { background: "#111318", border: "1px solid #1e2330", borderRadius: 10, padding: "14px 16px" };
const labelStyle = { color: "#475569", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", marginBottom: 8, marginTop: 0 };
const bigNumStyle = { fontSize: 26, fontWeight: 700, color: "#fff", margin: 0 };
const subLabelStyle = { color: "#334155", fontSize: 10, margin: 0, marginTop: 2 };

export default HighVolumeBar;