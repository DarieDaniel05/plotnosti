import React, { useState, useEffect, useCallback } from 'react';
import { TrendingUp, RefreshCw, AlertTriangle, Zap, Clock, BarChart2, ArrowUpRight } from 'lucide-react';

const DailyHighMovePage = () => {
  const [movers, setMovers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdate, setLastUpdate] = useState('');
  const [threshold, setThreshold] = useState(20);
  const [totalScanned, setTotalScanned] = useState(0);
  const [scanProgress, setScanProgress] = useState(0);

  // Fetch pentru lumânarea daily de ieri (open → close)
  const fetchPreviousDailyChange = async (symbol) => {
    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=2`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.length < 2) return null;
      const yesterday = data[0]; // index 0 = cea mai veche dintre ultimele 2 (ieri)
      const open = parseFloat(yesterday[1]);
      const close = parseFloat(yesterday[4]);
      if (open === 0) return null;
      return ((close - open) / open) * 100;
    } catch (err) {
      console.warn(`Eroare pentru ${symbol}:`, err);
      return null;
    }
  };

  const fetchTopMovers = useCallback(async () => {
    setIsLoading(true);
    setError('');
    setScanProgress(0);
    try {
      // 1. Lista simboluri futures
      const exchangeRes = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
      const exchangeData = await exchangeRes.json();
      const symbols = exchangeData.symbols
        .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT'))
        .map(s => s.symbol);
      setTotalScanned(symbols.length);
      setScanProgress(10);

      // 2. Date ticker 24h (pentru preț curent, volum, high, low etc.)
      const tickerRes = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
      const tickerData = await tickerRes.json();
      const tickerMap = new Map();
      tickerData.forEach(t => tickerMap.set(t.symbol, t));
      setScanProgress(30);

      // 3. Pentru fiecare simbol, obține creșterea daily de ieri (batch cu limită de 50 simultan)
      const batchSize = 50;
      const allResults = [];
      for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const batchPromises = batch.map(async (sym) => {
          const dailyChange = await fetchPreviousDailyChange(sym);
          const ticker = tickerMap.get(sym);
          if (!ticker || dailyChange === null) return null;
          return {
            symbol: sym.replace('USDT', ''),
            fullSymbol: sym,
            dailyChangePercent: dailyChange, // <- creștere fixă a lumânării daily de ieri
            openPrice: parseFloat(ticker.openPrice),
            closePrice: parseFloat(ticker.lastPrice),
            highPrice: parseFloat(ticker.highPrice),
            lowPrice: parseFloat(ticker.lowPrice),
            volume: parseFloat(ticker.quoteVolume),
            trades: parseInt(ticker.count),
          };
        });
        const batchResults = await Promise.all(batchPromises);
        allResults.push(...batchResults.filter(r => r !== null));
        setScanProgress(30 + Math.floor((i + batch.length) / symbols.length * 60));
      }

      // 4. Filtrare după threshold (pe dailyChangePercent) și sortare descendentă
      const filtered = allResults
        .filter(coin => coin.dailyChangePercent >= threshold)
        .sort((a, b) => b.dailyChangePercent - a.dailyChangePercent);

      setScanProgress(100);
      setMovers(filtered);
      setLastUpdate(new Date().toLocaleTimeString('ro-RO'));
    } catch (err) {
      setError('Eroare la preluarea datelor: ' + err.message);
    } finally {
      setIsLoading(false);
    }
  }, [threshold]);

  useEffect(() => { fetchTopMovers(); }, [fetchTopMovers]);

  const formatVolume = (vol) => {
    if (vol >= 1e9) return (vol / 1e9).toFixed(2) + 'B';
    if (vol >= 1e6) return (vol / 1e6).toFixed(2) + 'M';
    if (vol >= 1e3) return (vol / 1e3).toFixed(2) + 'K';
    return vol.toFixed(2);
  };
  const formatPrice = (price) => {
    if (price >= 1000) return price.toFixed(2);
    if (price >= 1) return price.toFixed(4);
    if (price >= 0.001) return price.toFixed(6);
    return price.toFixed(8);
  };
  const getColor = (c) => c >= 100 ? '#ff4d4d' : c >= 50 ? '#ff8c00' : c >= 30 ? '#ffd700' : '#00e676';
  const getBg = (c) => c >= 100 ? 'rgba(255,77,77,0.08)' : c >= 50 ? 'rgba(255,140,0,0.08)' : c >= 30 ? 'rgba(255,215,0,0.08)' : 'rgba(0,230,118,0.06)';

  const openTradingView = (fullSymbol) => {
    const url = `https://www.tradingview.com/chart/?symbol=BINANCE%3A${fullSymbol}`;
    window.open(url, '_blank');
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0c10',
      color: '#e2e8f0',
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      padding: '24px',
    }}>
      <div style={{
        position: 'fixed', inset: 0, zIndex: 0,
        background: 'radial-gradient(ellipse 80% 50% at 50% -20%, rgba(0,230,118,0.07) 0%, transparent 60%)',
        pointerEvents: 'none',
      }} />

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1200, margin: '0 auto' }}>
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <Zap size={28} color="#00e676" />
            <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.5px', color: '#fff', margin: 0 }}>
              Daily High Movers
            </h1>
            <span style={{
              fontSize: 11,
              background: 'rgba(0,230,118,0.15)',
              color: '#00e676',
              border: '1px solid rgba(0,230,118,0.3)',
              borderRadius: 4, padding: '2px 8px',
            }}>FUTURES</span>
          </div>
          <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>
            Monede futures Binance cu creșterea lumânării DAILY de ieri ≥ {threshold}% · Click pe rând → TradingView
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
          <div style={{ background: '#111318', border: '1px solid #1e2330', borderRadius: 10, padding: '14px 16px' }}>
            <p style={{ color: '#64748b', fontSize: 11, marginBottom: 8 }}>THRESHOLD</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number" value={threshold} min={1} max={1000}
                onChange={e => setThreshold(parseFloat(e.target.value) || 20)}
                style={{
                  background: '#1a1e27', border: '1px solid #2d3348', color: '#00e676',
                  borderRadius: 6, padding: '4px 8px', width: 64, fontSize: 18, fontWeight: 700,
                  fontFamily: 'inherit', outline: 'none',
                }}
              />
              <span style={{ color: '#00e676', fontSize: 18, fontWeight: 700 }}>%</span>
            </div>
          </div>
          <div style={{ background: '#111318', border: '1px solid #1e2330', borderRadius: 10, padding: '14px 16px' }}>
            <p style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>SCANATE</p>
            <p style={{ fontSize: 24, fontWeight: 700, color: '#fff', margin: 0 }}>{totalScanned}</p>
            <p style={{ color: '#64748b', fontSize: 11, margin: 0 }}>simboluri</p>
          </div>
          <div style={{ background: '#111318', border: '1px solid #1e2330', borderRadius: 10, padding: '14px 16px' }}>
            <p style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>GĂSITE</p>
            <p style={{ fontSize: 24, fontWeight: 700, color: '#00e676', margin: 0 }}>{movers.length}</p>
            <p style={{ color: '#64748b', fontSize: 11, margin: 0 }}>≥ {threshold}% creștere (daily ieri)</p>
          </div>
          <div style={{ background: '#111318', border: '1px solid #1e2330', borderRadius: 10, padding: '14px 16px' }}>
            <p style={{ color: '#64748b', fontSize: 11, marginBottom: 4 }}>ACTUALIZAT</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Clock size={14} color="#64748b" />
              <p style={{ fontSize: 13, color: '#cbd5e1', margin: 0 }}>{lastUpdate || '—'}</p>
            </div>
            <button
              onClick={fetchTopMovers} disabled={isLoading}
              style={{
                marginTop: 8,
                background: isLoading ? '#1a1e27' : 'rgba(0,230,118,0.1)',
                border: '1px solid rgba(0,230,118,0.3)',
                color: '#00e676', borderRadius: 6, padding: '4px 12px',
                fontSize: 11, cursor: isLoading ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 6,
                fontFamily: 'inherit',
              }}
            >
              <RefreshCw size={12} style={{ animation: isLoading ? 'spin 1s linear infinite' : 'none' }} />
              REFRESH
            </button>
          </div>
        </div>

        {isLoading && (
          <div style={{ background: '#111318', border: '1px solid #1e2330', borderRadius: 12, padding: '48px 24px', textAlign: 'center' }}>
            <RefreshCw size={36} color="#00e676" style={{ animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
            <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 16 }}>Se preiau lumânările daily pentru fiecare simbol...</p>
            <div style={{ background: '#1a1e27', borderRadius: 999, height: 6, width: 240, margin: '0 auto', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                background: 'linear-gradient(90deg, #00e676, #69f0ae)',
                borderRadius: 999, width: `${scanProgress}%`, transition: 'width 0.4s ease',
              }} />
            </div>
            <p style={{ color: '#475569', fontSize: 12, marginTop: 8 }}>{scanProgress}%</p>
          </div>
        )}

        {error && !isLoading && (
          <div style={{
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: 12, padding: 24, display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <AlertTriangle size={20} color="#ef4444" />
            <p style={{ color: '#ef4444', margin: 0, fontSize: 14 }}>{error}</p>
          </div>
        )}

        {!isLoading && !error && (
          <div style={{ background: '#111318', border: '1px solid #1e2330', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{
              padding: '16px 20px', borderBottom: '1px solid #1e2330',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <BarChart2 size={16} color="#00e676" />
                <span style={{ fontSize: 13, color: '#94a3b8' }}>
                  {movers.length} monede cu creșterea daily (ziua precedentă) ≥ {threshold}%
                </span>
              </div>
              <span style={{ fontSize: 11, color: '#334155' }}>↖ Click pe rând → TradingView</span>
            </div>

            {movers.length === 0 ? (
              <div style={{ padding: '64px 24px', textAlign: 'center' }}>
                <TrendingUp size={40} color="#1e2330" style={{ margin: '0 auto 16px' }} />
                <p style={{ color: '#475569', fontSize: 14 }}>Nicio monedă nu a avut o creștere a lumânării daily de ieri ≥ {threshold}%.</p>
                <p style={{ color: '#334155', fontSize: 12 }}>Încearcă un threshold mai mic.</p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#0d1017' }}>
                      {['#', 'Simbol', 'Creștere zi precedentă', 'Preț curent', 'Preț deschidere', 'High 24h', 'Volum USDT', 'Tranzacții'].map((h, i) => (
                        <th key={i} style={{
                          padding: '12px 16px',
                          textAlign: i <= 1 ? 'left' : 'right',
                          fontSize: 11,
                          color: '#475569',
                          fontWeight: 600,
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {movers.map((coin, idx) => {
                      const color = getColor(coin.dailyChangePercent);
                      const bg = getBg(coin.dailyChangePercent);
                      return (
                        <tr
                          key={coin.fullSymbol}
                          onClick={() => openTradingView(coin.fullSymbol)}
                          style={{
                            background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)',
                            borderBottom: '1px solid #1a1e27',
                            cursor: 'pointer',
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,230,118,0.05)'}
                          onMouseLeave={e => e.currentTarget.style.background = idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)'}
                        >
                          <td style={{ padding: '12px 16px', color: '#334155', fontSize: 12 }}>{idx + 1}</td>
                          <td style={{ padding: '12px 16px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <div style={{
                                width: 36, height: 36, background: bg,
                                border: `1px solid ${color}33`, borderRadius: 8,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 10, fontWeight: 700, color,
                              }}>
                                {coin.symbol.slice(0, 4)}
                              </div>
                              <div>
                                <p style={{ margin: 0, fontWeight: 700, color: '#f1f5f9', fontSize: 14 }}>{coin.symbol}</p>
                                <p style={{ margin: 0, color: '#475569', fontSize: 11 }}>USDT Perp</p>
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                            <div style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              background: bg, border: `1px solid ${color}44`,
                              borderRadius: 6, padding: '4px 10px',
                            }}>
                              <ArrowUpRight size={14} color={color} />
                              <span style={{ color, fontWeight: 800, fontSize: 15 }}>
                                {coin.dailyChangePercent > 0 ? '+' : ''}{coin.dailyChangePercent.toFixed(2)}%
                              </span>
                            </div>
                          </td>
                          <td style={{ padding: '12px 16px', textAlign: 'right', color: '#f1f5f9', fontWeight: 600 }}>${formatPrice(coin.closePrice)}</td>
                          <td style={{ padding: '12px 16px', textAlign: 'right', color: '#64748b', fontSize: 13 }}>${formatPrice(coin.openPrice)}</td>
                          <td style={{ padding: '12px 16px', textAlign: 'right', color: '#94a3b8', fontSize: 13 }}>${formatPrice(coin.highPrice)}</td>
                          <td style={{ padding: '12px 16px', textAlign: 'right', color: '#94a3b8', fontSize: 13 }}>${formatVolume(coin.volume)}</td>
                          <td style={{ padding: '12px 16px', textAlign: 'right', color: '#64748b', fontSize: 12 }}>{coin.trades.toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <p style={{ color: '#334155', fontSize: 11, textAlign: 'center', marginTop: 20 }}>
          Date preluate din API-ul public Binance · Creșterea afișată = (close - open) / open al lumânării daily de ieri (valoare fixă, nu se modifică în timp real).
        </p>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

export default DailyHighMovePage;