import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createChart } from 'lightweight-charts';

const TIMEFRAMES = [
  { label: '1m', value: '1m' },
  { label: '5m', value: '5m' },
  { label: '15m', value: '15m' },
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '1d', value: '1d' },
];

const ROW_HEIGHT = 20;
const VISIBLE_BUFFER = 10;

const formatDollarVolume = (valInDollars) => {
  if (!valInDollars || valInDollars <= 0) return '';
  if (valInDollars >= 1000000) return `$${(valInDollars / 1000000).toFixed(1)}M`;
  if (valInDollars >= 1000) return `$${(valInDollars / 1000).toFixed(1)}K`;
  return `$${valInDollars.toFixed(0)}`;
};

export default function DeepLiquidityHeatmapChart() {
  const [symbol, setSymbol] = useState('OGNUSDT');
  const [searchSymbol, setSearchSymbol] = useState('');
  const [symbolsList, setSymbolsList] = useState([]);
  const [timeframe, setTimeframe] = useState('1m');
  const [orderBook, setOrderBook] = useState({ bids: {}, asks: {} });
  const [currentPrice, setCurrentPrice] = useState(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [hoveredPrice, setHoveredPrice] = useState(null);

  // Tab activ pentru mobil: 'chart' sau 'dom'
  const [activeTab, setActiveTab] = useState('chart');

  // Stări pentru comutarea vizibilității și pragul de lichiditate minimă
  const [showLiquidity, setShowLiquidity] = useState(true);
  const [showSweeps, setShowSweeps] = useState(true);
  const [minLiquidityUsd, setMinLiquidityUsd] = useState(10000);
  const [minLiquidityInput, setMinLiquidityInput] = useState('10000');

  const [priceStepPercent, setPriceStepPercent] = useState(0.1);
  const [inputValue, setInputValue] = useState('0.1');
  const [autoCenter, setAutoCenter] = useState(true);
  const [fixedAnchorPrice, setFixedAnchorPrice] = useState(null);

  const [trades, setTrades] = useState([]);

  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  const chartContainerRef = useRef(null);
  const chartCanvasOverlayRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const candlestickSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const currentCandleRef = useRef(null);
  const domContainerRef = useRef(null);

  const localOrderBookRef = useRef({ bids: {}, asks: {} });
  const activeLiquidityRef = useRef({});
  const sweptLiquidityRef = useRef([]); // Stochează nivelurile recent măturate pentru vizualizare
  const markersRef = useRef([]); // Stochează markerele de sweep pe grafic

  // Redimensionare redesenare grafic la schimbarea tab-ului
  useEffect(() => {
    if (activeTab === 'chart' && chartInstanceRef.current && chartContainerRef.current) {
      setTimeout(() => {
        chartInstanceRef.current?.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
        requestAnimationFrame(drawLiquidityMap);
      }, 50);
    }
  }, [activeTab]);

  // Adăugare marker pe grafic
  const addSweepMarker = useCallback((time, price, type, volume) => {
    if (!candlestickSeriesRef.current || !showSweeps) return;

    const isBuySweep = type === 'BUY_SWEEP'; // Prețul a urcat și a măturat ASKS (Lichiditate Buy-side)
    
    const newMarker = {
      time: time,
      position: isBuySweep ? 'aboveBar' : 'belowBar',
      color: isBuySweep ? '#f59e0b' : '#3b82f6',
      shape: isBuySweep ? 'arrowDown' : 'arrowUp',
      text: `SWEEP ${formatDollarVolume(volume)}`,
    };

    // Evităm duplicatele pe aceeași lumânare / același tip
    const exists = markersRef.current.some(
      (m) => m.time === time && m.shape === newMarker.shape
    );

    if (!exists) {
      markersRef.current = [...markersRef.current, newMarker].slice(-50); // Păstrăm ultimele 50
      candlestickSeriesRef.current.setMarkers(markersRef.current);
    }
  }, [showSweeps]);

  // Sincronizare și detectare SWEEP de lichiditate
  const syncAndFilterLiquidity = useCallback((latestPrice, candleHigh, candleLow) => {
    const ob = localOrderBookRef.current;
    const currentActive = {};

    Object.entries(ob.asks).forEach(([pStr, vol]) => {
      const p = parseFloat(pStr);
      const valUSD = p * vol;

      if (valUSD >= minLiquidityUsd) {
        currentActive[p] = valUSD;
      }
    });

    Object.entries(ob.bids).forEach(([pStr, vol]) => {
      const p = parseFloat(pStr);
      const valUSD = p * vol;

      if (valUSD >= minLiquidityUsd) {
        currentActive[p] = valUSD;
      }
    });

    const high = candleHigh || latestPrice;
    const low = candleLow || latestPrice;

    if (high && low) {
      Object.keys(currentActive).forEach((pStr) => {
        const p = parseFloat(pStr);

        // Detectare Liquidity Sweep: Prețul/Lumânarea a depășit un nivel cu lichiditate mare
        if (p >= low && p <= high) {
          const sweptVolume = currentActive[p];
          const isBuySweep = p >= (latestPrice || high);

          // Adăugăm în istoricul vizual al nivelurilor măturate
          sweptLiquidityRef.current.push({
            price: p,
            volume: sweptVolume,
            timestamp: Date.now(),
            type: isBuySweep ? 'BUY_SWEEP' : 'SELL_SWEEP',
          });

          // Păstrăm doar sweep-urile recente (ultimele 15 secunde) pentru animație/evidențiere pe Heatmap
          const now = Date.now();
          sweptLiquidityRef.current = sweptLiquidityRef.current.filter(
            (s) => now - s.timestamp < 15000
          );

          // Adăugăm marker pe lumânare
          if (currentCandleRef.current) {
            addSweepMarker(
              currentCandleRef.current.time,
              p,
              isBuySweep ? 'BUY_SWEEP' : 'SELL_SWEEP',
              sweptVolume
            );
          }

          // Eliminăm nivelul din lichiditatea activă (a fost măturat)
          delete currentActive[p];
        }
      });
    }

    activeLiquidityRef.current = currentActive;
  }, [minLiquidityUsd, addSweepMarker]);

  // Măsurarea containerului DOM
  useEffect(() => {
    if (!domContainerRef.current) return;

    const updateHeight = () => {
      if (domContainerRef.current) {
        setContainerHeight(domContainerRef.current.clientHeight);
      }
    };

    updateHeight();
    window.addEventListener('resize', updateHeight);

    return () => window.removeEventListener('resize', updateHeight);
  }, [activeTab]);

  useEffect(() => {
    if (currentPrice && fixedAnchorPrice === null) {
      setFixedAnchorPrice(currentPrice);
    }
  }, [currentPrice, fixedAnchorPrice]);

  // Resetarea datelor la schimbarea simbolului
  useEffect(() => {
    setFixedAnchorPrice(null);
    setCurrentPrice(null);
    setOrderBook({ bids: {}, asks: {} });
    setAutoCenter(true);
    setTrades([]);
    setHoveredPrice(null);
    setScrollTop(0);

    currentCandleRef.current = null;
    localOrderBookRef.current = { bids: {}, asks: {} };
    activeLiquidityRef.current = {};
    sweptLiquidityRef.current = [];
    markersRef.current = [];

    if (candlestickSeriesRef.current) {
      candlestickSeriesRef.current.setMarkers([]);
    }

    if (domContainerRef.current) {
      domContainerRef.current.scrollTop = 0;
    }

    if (candlestickSeriesRef.current) {
      candlestickSeriesRef.current.setData([]);
    }

    if (volumeSeriesRef.current) {
      volumeSeriesRef.current.setData([]);
    }

    if (chartInstanceRef.current) {
      chartInstanceRef.current.timeScale().fitContent();
    }

    requestAnimationFrame(() => {
      if (chartCanvasOverlayRef.current) {
        const canvas = chartCanvasOverlayRef.current;
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
    });
  }, [symbol]);

  const tickStep = useMemo(() => {
    const base = fixedAnchorPrice || currentPrice || 1;
    if (base <= 0 || priceStepPercent <= 0) return 0.00005;
    return (base * priceStepPercent) / 100;
  }, [fixedAnchorPrice, currentPrice, priceStepPercent]);

  const precision = useMemo(() => {
    if (!tickStep) return 5;
    const str = tickStep.toFixed(8).toString();
    const parts = str.split('.');
    if (parts.length > 1) {
      const decimals = parts[1].replace(/0+$/, '').length;
      return Math.max(2, Math.min(6, decimals));
    }
    return 5;
  }, [tickStep]);

  // Încărcarea simbolurilor Binance
  useEffect(() => {
    fetch('https://api.binance.com/api/v3/exchangeInfo')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (data.symbols) {
          const usdtPairs = data.symbols
            .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT')
            .map((s) => s.symbol);

          setSymbolsList(usdtPairs);
        }
      })
      .catch((err) => console.error('Eroare la încărcarea simbolurilor:', err));
  }, []);

  // Snapshot Order Book
  useEffect(() => {
    let cancelled = false;
    const sym = symbol.toUpperCase();

    fetch(`https://api.binance.com/api/v3/depth?symbol=${sym}&limit=1000`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;

        if (data.code) {
          throw new Error(data.msg || 'Binance API error');
        }

        const bidsObj = {};
        const asksObj = {};

        if (data.bids) {
          data.bids.forEach(([p, q]) => {
            bidsObj[parseFloat(p)] = parseFloat(q);
          });
        }

        if (data.asks) {
          data.asks.forEach(([p, q]) => {
            asksObj[parseFloat(p)] = parseFloat(q);
          });
        }

        localOrderBookRef.current = { bids: bidsObj, asks: asksObj };
        setOrderBook({ bids: bidsObj, asks: asksObj });

        syncAndFilterLiquidity(
          currentPrice,
          currentCandleRef.current?.high,
          currentCandleRef.current?.low
        );

        requestAnimationFrame(drawLiquidityMap);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Eroare la încărcarea Order Book:', err);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [symbol, syncAndFilterLiquidity, currentPrice]);

  // Desenarea hărții de lichiditate și a SWEEPS-urilor pe Canvas
  const drawLiquidityMap = useCallback(() => {
    const canvas = chartCanvasOverlayRef.current;
    const chartContainer = chartContainerRef.current;
    const chart = chartInstanceRef.current;
    const series = candlestickSeriesRef.current;

    if (!canvas || !chartContainer || !chart || !series) return;

    const width = chartContainer.clientWidth;
    const height = chartContainer.clientHeight;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    if (!showLiquidity) return;

    const activeLevels = activeLiquidityRef.current;
    const values = Object.values(activeLevels);

    const maxVal = Math.max(...values, minLiquidityUsd * 2, 1);
    const bandHeight = Math.max(
      4,
      Math.min(14, 1500 / (chart.timeScale().width() || 500))
    );

    // 1. Desenare Lichiditate Activă (Heatmap)
    Object.entries(activeLevels).forEach(([pStr, valUSD]) => {
      const price = parseFloat(pStr);
      const yCoord = series.priceToCoordinate(price);

      if (yCoord === null || yCoord < 0 || yCoord > height) return;

      const intensity = Math.min(
        1,
        Math.max(
          0.1,
          (valUSD - minLiquidityUsd) /
            (maxVal - minLiquidityUsd || 1)
        )
      );

      const r = Math.round(255 + (220 - 255) * intensity);
      const g = Math.round(140 * (1 - intensity));
      const b = Math.round(38 * intensity);
      const alpha = 0.25 + intensity * 0.55;

      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.fillRect(0, yCoord - bandHeight / 2, width, bandHeight);
    });

    // 2. Desenare Animații / Evidențieri Liquidity Sweep (Recent Măturate)
    if (showSweeps && sweptLiquidityRef.current.length > 0) {
      const now = Date.now();
      sweptLiquidityRef.current.forEach((sweep) => {
        const elapsed = now - sweep.timestamp;
        if (elapsed > 15000) return; // Expirează după 15s

        const yCoord = series.priceToCoordinate(sweep.price);
        if (yCoord === null || yCoord < 0 || yCoord > height) return;

        // Animație de fading out
        const fadeRatio = 1 - elapsed / 15000;
        
        // Linie punctată vibrantă pe nivelul măturat
        ctx.save();
        ctx.strokeStyle = sweep.type === 'BUY_SWEEP' 
          ? `rgba(245, 158, 11, ${fadeRatio})` 
          : `rgba(59, 130, 246, ${fadeRatio})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        
        ctx.beginPath();
        ctx.moveTo(0, yCoord);
        ctx.lineTo(width, yCoord);
        ctx.stroke();
        ctx.restore();

        // Etichetă "SWEEP"
        ctx.fillStyle = sweep.type === 'BUY_SWEEP' 
          ? `rgba(245, 158, 11, ${fadeRatio * 0.9})` 
          : `rgba(59, 130, 246, ${fadeRatio * 0.9})`;
        ctx.font = 'bold 10px sans-serif';
        ctx.fillText(
          `⚡ SWEEP: ${formatDollarVolume(sweep.volume)}`, 
          width - 130, 
          yCoord - 3
        );
      });
    }
  }, [showLiquidity, showSweeps, minLiquidityUsd]);

  useEffect(() => {
    syncAndFilterLiquidity(
      currentPrice,
      currentCandleRef.current?.high,
      currentCandleRef.current?.low
    );
    requestAnimationFrame(drawLiquidityMap);
  }, [orderBook, currentPrice, showLiquidity, minLiquidityUsd, syncAndFilterLiquidity, drawLiquidityMap]);

  // Inițializarea graficului
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight,
      layout: {
        background: { color: '#0b0e14' },
        textColor: '#9CA3AF',
      },
      grid: {
        vertLines: { color: '#161b26' },
        horzLines: { color: '#161b26' },
      },
      crosshair: { mode: 1 },
      localization: {
        priceFormatter: (price) => {
          if (typeof price !== 'number') return '';
          if (price < 0.1) return price.toFixed(5);
          if (price < 10) return price.toFixed(4);
          return price.toFixed(2);
        },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        autoScale: true,
        scaleMargins: { top: 0.05, bottom: 0.25 },
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      priceFormat: {
        type: 'price',
        precision: 5,
        minMove: 0.00001,
      },
    });

    const volumeSeries = chart.addHistogramSeries({
      color: '#26a69a',
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume_scale',
    });

    chart.priceScale('volume_scale').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    chartInstanceRef.current = chart;
    candlestickSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      requestAnimationFrame(drawLiquidityMap);
    });

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });

        requestAnimationFrame(drawLiquidityMap);
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartInstanceRef.current = null;
      candlestickSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [drawLiquidityMap]);

  // Încărcarea lumânărilor
  useEffect(() => {
    let cancelled = false;
    const requestedSymbol = symbol.toUpperCase();

    fetch(
      `https://api.binance.com/api/v3/klines?symbol=${requestedSymbol}&interval=${timeframe}&limit=300`
    )
      .then((res) => {
        if (!res.ok) throw new Error(`Binance Klines HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (
          cancelled ||
          !Array.isArray(data) ||
          !candlestickSeriesRef.current ||
          !volumeSeriesRef.current
        ) {
          return;
        }

        const formattedCandles = data.map((d) => ({
          time: d[0] / 1000,
          open: parseFloat(d[1]),
          high: parseFloat(d[2]),
          low: parseFloat(d[3]),
          close: parseFloat(d[4]),
        }));

        const formattedVolume = data.map((d) => ({
          time: d[0] / 1000,
          value: parseFloat(d[5]),
          color:
            parseFloat(d[1]) <= parseFloat(d[4])
              ? 'rgba(34, 197, 94, 0.3)'
              : 'rgba(239, 68, 68, 0.3)',
        }));

        candlestickSeriesRef.current.setData(formattedCandles);
        volumeSeriesRef.current.setData(formattedVolume);

        if (formattedCandles.length > 0) {
          const lastCandle = formattedCandles[formattedCandles.length - 1];

          currentCandleRef.current = { ...lastCandle };
          setCurrentPrice(lastCandle.close);
          setFixedAnchorPrice(lastCandle.close);
        }

        const timeScale = chartInstanceRef.current?.timeScale();

        timeScale?.fitContent();
        timeScale?.scrollToRealTime();

        requestAnimationFrame(drawLiquidityMap);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Eroare la încărcarea graficului:', err);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe, drawLiquidityMap]);

  // Actualizări WebSocket
  useEffect(() => {
    const sym = symbol.toLowerCase();

    const ws = new WebSocket(
      `wss://stream.binance.com:9443/stream?streams=${sym}@kline_${timeframe}/${sym}@depth@100ms/${sym}@ticker/${sym}@trade`
    );

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        const data = message.data || message;

        if (data.e === 'trade') {
          const price = parseFloat(data.p);
          const qty = parseFloat(data.q);
          const dollarVal = price * qty;
          const isBuyerMaker = data.m;

          const newTrade = {
            id: data.t,
            price,
            dollarVal,
            isBuy: !isBuyerMaker,
            time: new Date(data.T).toLocaleTimeString(),
          };

          setTrades((prev) => [newTrade, ...prev.slice(0, 49)]);
        }

        if (data.e === '24hrTicker') {
          const price = parseFloat(data.c);

          setCurrentPrice(price);

          if (candlestickSeriesRef.current && currentCandleRef.current) {
            const updatedCandle = {
              ...currentCandleRef.current,
              close: price,
              high: Math.max(currentCandleRef.current.high, price),
              low: Math.min(currentCandleRef.current.low, price),
            };

            currentCandleRef.current = updatedCandle;
            candlestickSeriesRef.current.update(updatedCandle);

            syncAndFilterLiquidity(
              price,
              updatedCandle.high,
              updatedCandle.low
            );
          }
        }

        if (data.e === 'kline') {
          const k = data.k;

          const candle = {
            time: k.t / 1000,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
          };

          currentCandleRef.current = candle;
          candlestickSeriesRef.current?.update(candle);

          volumeSeriesRef.current?.update({
            time: k.t / 1000,
            value: parseFloat(k.v),
            color:
              parseFloat(k.o) <= parseFloat(k.c)
                ? 'rgba(34, 197, 94, 0.3)'
                : 'rgba(239, 68, 68, 0.3)',
          });

          setCurrentPrice(candle.close);

          syncAndFilterLiquidity(
            candle.close,
            candle.high,
            candle.low
          );
        }

        if (data.e === 'depthUpdate') {
          const ob = localOrderBookRef.current;

          if (data.b) {
            data.b.forEach(([pStr, qStr]) => {
              const p = parseFloat(pStr);
              const q = parseFloat(qStr);

              if (q === 0) {
                delete ob.bids[p];
              } else {
                ob.bids[p] = q;
              }
            });
          }

          if (data.a) {
            data.a.forEach(([pStr, qStr]) => {
              const p = parseFloat(pStr);
              const q = parseFloat(qStr);

              if (q === 0) {
                delete ob.asks[p];
              } else {
                ob.asks[p] = q;
              }
            });
          }

          localOrderBookRef.current = ob;
          setOrderBook({ bids: { ...ob.bids }, asks: { ...ob.asks } });

          syncAndFilterLiquidity(
            currentPrice,
            currentCandleRef.current?.high,
            currentCandleRef.current?.low
          );
        }
      } catch (err) {
        console.error('Eroare la procesarea datelor WebSocket:', err);
      }
    };

    return () => {
      ws.close();
    };
  }, [symbol, timeframe, currentPrice, syncAndFilterLiquidity]);

  const { bestAsk, bestBid } = useMemo(() => {
    const askPrices = Object.keys(orderBook.asks).map(Number);
    const bidPrices = Object.keys(orderBook.bids).map(Number);

    return {
      bestAsk: askPrices.length > 0 ? Math.min(...askPrices) : null,
      bestBid: bidPrices.length > 0 ? Math.max(...bidPrices) : null,
    };
  }, [orderBook]);

  const maxDollarVolume = useMemo(() => {
    let max = 0;

    Object.entries(orderBook.asks).forEach(([p, v]) => {
      const dol = parseFloat(p) * v;
      if (dol > max) max = dol;
    });

    Object.entries(orderBook.bids).forEach(([p, v]) => {
      const dol = parseFloat(p) * v;
      if (dol > max) max = dol;
    });

    return max || 1;
  }, [orderBook]);

  const priceLevels = useMemo(() => {
    if (!fixedAnchorPrice || fixedAnchorPrice <= 0 || tickStep <= 0) {
      return [];
    }

    const basePrice = Math.floor(fixedAnchorPrice / tickStep) * tickStep;
    const levels = [];
    const totalLevels = 2000;

    for (let i = totalLevels; i >= -totalLevels; i--) {
      const price = parseFloat(
        (basePrice + i * tickStep).toFixed(precision)
      );

      if (price <= 0) continue;

      const priceStr = price.toFixed(precision);
      const isRoundLevel =
        priceStr.endsWith('00') ||
        priceStr.endsWith('50') ||
        priceStr.endsWith('0');

      levels.push({
        price: priceStr,
        rawPrice: price,
        isRoundLevel,
        index: totalLevels - i,
      });
    }

    return levels;
  }, [fixedAnchorPrice, tickStep, precision]);

  const currentPriceIndex = useMemo(() => {
    if (!currentPrice || priceLevels.length === 0) return -1;

    return priceLevels.findIndex(
      (l) => Math.abs(l.rawPrice - currentPrice) < tickStep / 2
    );
  }, [currentPrice, priceLevels, tickStep]);

  const centerDom = useCallback(() => {
    requestAnimationFrame(() => {
      if (domContainerRef.current && currentPriceIndex !== -1) {
        const containerH = domContainerRef.current.clientHeight;

        const targetScroll =
          currentPriceIndex * ROW_HEIGHT -
          containerH / 2 +
          ROW_HEIGHT / 2;

        domContainerRef.current.scrollTop = Math.max(0, targetScroll);
      }
    });
  }, [currentPriceIndex]);

  useEffect(() => {
    if (autoCenter && currentPriceIndex !== -1) {
      centerDom();
      const frame = requestAnimationFrame(centerDom);
      return () => cancelAnimationFrame(frame);
    }
  }, [symbol, currentPrice, autoCenter, centerDom, currentPriceIndex, activeTab]);

  const handleScroll = (e) => {
    setScrollTop(e.target.scrollTop);
    if (autoCenter) {
      setAutoCenter(false);
    }
  };

  const totalHeight = priceLevels.length * ROW_HEIGHT;

  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / ROW_HEIGHT) - VISIBLE_BUFFER
  );

  const endIndex = Math.min(
    priceLevels.length - 1,
    Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) +
      VISIBLE_BUFFER
  );

  const visibleRows = useMemo(() => {
    const rows = [];

    for (let i = startIndex; i <= endIndex; i++) {
      const level = priceLevels[i];
      if (!level) continue;

      const price = level.rawPrice;
      let askDollarVolume = 0;
      let bidDollarVolume = 0;

      Object.entries(orderBook.asks).forEach(([pStr, vol]) => {
        const p = parseFloat(pStr);
        if (p >= price && p < price + tickStep) {
          askDollarVolume += p * vol;
        }
      });

      Object.entries(orderBook.bids).forEach(([pStr, vol]) => {
        const p = parseFloat(pStr);
        if (p <= price && p > price - tickStep) {
          bidDollarVolume += p * vol;
        }
      });

      rows.push({
        ...level,
        topOffset: i * ROW_HEIGHT,
        askDollarVolume,
        bidDollarVolume,
        isCurrentLevel: i === currentPriceIndex,
        isBestAsk: bestAsk && Math.abs(price - bestAsk) < tickStep / 2,
        isBestBid: bestBid && Math.abs(price - bestBid) < tickStep / 2,
      });
    }

    return rows;
  }, [
    priceLevels,
    startIndex,
    endIndex,
    orderBook,
    tickStep,
    currentPriceIndex,
    bestAsk,
    bestBid,
  ]);

  const applyPercentValue = () => {
    const val = parseFloat(inputValue);
    if (!isNaN(val) && val > 0) {
      setPriceStepPercent(val);
      setInputValue(val.toString());
      setFixedAnchorPrice(currentPrice);
      setAutoCenter(true);
    }
  };

  const applyMinLiquidity = () => {
    const val = parseFloat(minLiquidityInput);
    if (!isNaN(val) && val >= 0) {
      setMinLiquidityUsd(val);
    } else {
      setMinLiquidityInput(minLiquidityUsd.toString());
    }
  };

  const calculateDistancePercent = (targetPrice) => {
    if (!currentPrice || currentPrice === 0) return '0.00%';
    const diff = ((parseFloat(targetPrice) - currentPrice) / currentPrice) * 100;
    return `${diff > 0 ? '+' : ''}${diff.toFixed(2)}%`;
  };

  return (
    <div className="flex flex-col h-screen w-full bg-[#0b0e14] text-gray-200 font-sans overflow-hidden">
      {/* Topbar / Header */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between p-2 md:px-4 md:py-2 bg-[#121620] border-b border-gray-800 gap-2 select-none">
        <div className="flex items-center justify-between md:justify-start gap-2 md:gap-4 overflow-x-auto">
          {/* Căutare Simbol */}
          <div className="relative">
            <button
              onClick={() => setIsSearchOpen(!isSearchOpen)}
              className="flex items-center gap-1.5 bg-[#1a202c] hover:bg-[#2d3748] px-2.5 py-1 md:px-3 md:py-1.5 rounded text-xs md:text-sm font-semibold text-white border border-gray-700 whitespace-nowrap"
            >
              <span>{symbol}</span>
              <span className="text-[10px] text-gray-400">▼</span>
            </button>

            {isSearchOpen && (
              <div className="absolute left-0 top-full mt-1 w-56 md:w-64 bg-[#181a20] border border-gray-700 rounded shadow-2xl z-50">
                <input
                  type="text"
                  placeholder="Căutare..."
                  value={searchSymbol}
                  onChange={(e) => setSearchSymbol(e.target.value)}
                  className="w-full bg-[#0d0e12] px-3 py-2 text-sm text-white focus:outline-none border-b border-gray-700"
                  autoFocus
                />
                <div className="max-h-60 overflow-y-auto">
                  {symbolsList
                    .filter((s) => s.toLowerCase().includes(searchSymbol.toLowerCase()))
                    .slice(0, 50)
                    .map((sym) => (
                      <div
                        key={sym}
                        onClick={() => {
                          setSymbol(sym);
                          setIsSearchOpen(false);
                          setSearchSymbol('');
                        }}
                        className="px-3 py-2 text-sm hover:bg-[#2b2f3e] cursor-pointer"
                      >
                        {sym}
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>

          {/* Timeframes */}
          <div className="flex gap-0.5 md:gap-1 bg-[#181a20] p-1 rounded border border-gray-800">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.value}
                onClick={() => setTimeframe(tf.value)}
                className={`px-2 py-0.5 md:px-2.5 md:py-1 text-[11px] md:text-xs font-medium rounded ${
                  timeframe === tf.value
                    ? 'bg-[#2b2f3e] text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>

        {/* Setări Lichiditate și Afișare Preț */}
        <div className="flex items-center justify-between md:justify-end gap-2 text-xs">
          <div className="flex items-center gap-1.5 bg-[#181a20] px-2 py-1 rounded border border-gray-800">
            <button
              onClick={() => setShowLiquidity((prev) => !prev)}
              className={`px-2 py-0.5 text-[10px] md:text-xs font-semibold rounded ${
                showLiquidity ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'
              }`}
            >
              {showLiquidity ? 'Heatmap: ON' : 'Heatmap: OFF'}
            </button>

            {/* Buton comutator Liquidity Sweeps */}
            <button
              onClick={() => setShowSweeps((prev) => !prev)}
              className={`px-2 py-0.5 text-[10px] md:text-xs font-semibold rounded ${
                showSweeps ? 'bg-amber-600 text-white' : 'bg-gray-700 text-gray-400'
              }`}
            >
              {showSweeps ? '⚡ Sweeps: ON' : '⚡ Sweeps: OFF'}
            </button>

            <div className="flex items-center gap-1 text-[10px] md:text-xs text-gray-400 pl-1 border-l border-gray-700">
              <span>Min USD:</span>
              <input
                type="text"
                value={minLiquidityInput}
                onChange={(e) => setMinLiquidityInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyMinLiquidity()}
                onBlur={applyMinLiquidity}
                className="w-14 md:w-20 bg-[#0d0e12] border border-gray-700 rounded px-1 py-0.5 text-center text-white text-[11px] font-bold focus:outline-none"
              />
            </div>
          </div>

          {currentPrice && (
            <div className="text-[11px] md:text-sm font-mono whitespace-nowrap">
              <span className="text-green-400 font-bold">${currentPrice}</span>
            </div>
          )}
        </div>
      </div>

      {/* Comutator de Tab-uri Vizibil Doar pe Mobil */}
      <div className="flex md:hidden bg-[#181d2a] border-b border-gray-800">
        <button
          onClick={() => setActiveTab('chart')}
          className={`flex-1 py-2 text-center text-xs font-bold transition-colors ${
            activeTab === 'chart'
              ? 'bg-[#2b2f3e] text-white border-b-2 border-blue-500'
              : 'text-gray-400'
          }`}
        >
          📈 Grafic & Heatmap
        </button>
        <button
          onClick={() => setActiveTab('dom')}
          className={`flex-1 py-2 text-center text-xs font-bold transition-colors ${
            activeTab === 'dom'
              ? 'bg-[#2b2f3e] text-white border-b-2 border-blue-500'
              : 'text-gray-400'
          }`}
        >
          📊 DOM (Order Book)
        </button>
      </div>

      {/* Zona Principală de Conținut */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* TAB 1: Grafic + Heatmap Overlay */}
        <div
          className={`flex-1 relative border-r border-gray-800 h-full ${
            activeTab === 'chart' ? 'block' : 'hidden md:block'
          }`}
        >
          <div className="absolute top-2 left-2 z-20 text-sm md:text-xl font-bold text-gray-400 opacity-40 pointer-events-none select-none">
            {symbol} • {timeframe}
          </div>

          {showLiquidity && (
            <div className="absolute bottom-2 left-2 z-20 flex items-center gap-2 bg-[#121620]/80 backdrop-blur px-2 py-1 rounded border border-gray-800 text-[9px] md:text-[10px] text-gray-300">
              <span className="font-bold text-yellow-400">
                Min. ≥ ${minLiquidityUsd.toLocaleString()}
              </span>
              <div className="w-12 md:w-16 h-2 rounded bg-gradient-to-r from-[rgb(255,140,0)] to-[rgb(220,38,38)]" />
            </div>
          )}

          <div ref={chartContainerRef} className="w-full h-full relative" />
          <canvas
            ref={chartCanvasOverlayRef}
            className="absolute top-0 left-0 pointer-events-none z-10"
          />
        </div>

        {/* TAB 2: DOM / Order Book */}
        <div
          className={`w-full md:w-80 bg-[#11141c] flex flex-col font-mono text-xs select-none relative h-full ${
            activeTab === 'dom' ? 'flex' : 'hidden md:flex'
          }`}
        >
          <div className="px-3 py-2 bg-[#171c28] border-b border-gray-800 flex justify-between items-center text-gray-400 text-[11px]">
            <span>Pas Preț (%):</span>
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyPercentValue()}
                onBlur={applyPercentValue}
                className="w-16 bg-[#0b0e14] border border-gray-700 rounded px-1 py-0.5 text-center text-white font-bold focus:outline-none"
              />
              <span>%</span>
            </div>
          </div>

          <div className="grid grid-cols-2 bg-[#181d2a] border-b border-gray-800 text-[10px] text-gray-400 py-1.5 px-3 font-bold">
            <span className="text-left">VOLUM ($)</span>
            <span className="text-right">PREȚ</span>
          </div>

          {!autoCenter && (
            <button
              onClick={() => {
                setAutoCenter(true);
                centerDom();
              }}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-blue-600 hover:bg-blue-500 text-white text-[10px] px-3 py-1.5 rounded-full shadow-lg z-30 font-bold"
            >
              Centrare
            </button>
          )}

          <div
            ref={domContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto relative scrollbar-none [scrollbar-width:none]"
          >
            <style>{`div::-webkit-scrollbar { display: none; }`}</style>

            <div
              style={{
                height: `${totalHeight}px`,
                position: 'relative',
                width: '100%',
              }}
            >
              {visibleRows.map((row) => {
                const isHovered = hoveredPrice === row.price;

                const isAsk =
                  row.askDollarVolume > 0 ||
                  (currentPrice && row.rawPrice > currentPrice);

                const dollarVal = isAsk ? row.askDollarVolume : row.bidDollarVolume;

                const barWidth = dollarVal
                  ? `${Math.min(100, (dollarVal / maxDollarVolume) * 100)}%`
                  : '0%';

                let rowBgStyle = 'bg-[#141822]';
                let priceTextColor = isAsk ? 'text-red-400' : 'text-green-400';

                if (row.isBestAsk) {
                  rowBgStyle = 'bg-[#5b1924]';
                  priceTextColor = 'text-red-300 font-bold';
                } else if (row.isBestBid) {
                  rowBgStyle = 'bg-[#124d2d]';
                  priceTextColor = 'text-green-300 font-bold';
                }

                if (row.isCurrentLevel) {
                  rowBgStyle = 'bg-yellow-600/40';
                  priceTextColor = 'text-yellow-300 font-bold';
                }

                return (
                  <div
                    key={row.price}
                    onMouseEnter={() => setHoveredPrice(row.price)}
                    onMouseLeave={() => setHoveredPrice(null)}
                    style={{
                      position: 'absolute',
                      top: `${row.topOffset}px`,
                      left: 0,
                      right: 0,
                      height: `${ROW_HEIGHT}px`,
                    }}
                    className={`grid grid-cols-2 items-center px-3 border-b border-gray-900/60 cursor-pointer hover:brightness-125 ${rowBgStyle}`}
                  >
                    <div className="relative h-full flex items-center justify-start overflow-hidden">
                      <div
                        className={`absolute left-0 top-0 bottom-0 pointer-events-none opacity-30 ${
                          isAsk ? 'bg-red-500' : 'bg-green-500'
                        }`}
                        style={{ width: barWidth }}
                      />
                      <span
                        className={`text-[11px] font-semibold z-10 relative ${
                          isAsk ? 'text-red-300' : 'text-green-300'
                        }`}
                      >
                        {formatDollarVolume(dollarVal)}
                      </span>
                    </div>

                    <div className="text-right h-full flex items-center justify-end">
                      <span className={`text-[11px] ${priceTextColor}`}>
                        {isHovered ? (
                          <span className="text-yellow-300 font-bold">
                            {calculateDistancePercent(row.price)}
                          </span>
                        ) : (
                          row.price
                        )}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}