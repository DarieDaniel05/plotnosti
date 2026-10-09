import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { createChart } from 'lightweight-charts';

const TIMEFRAMES = [
  { label: '1m', value: '1m' },
  { label: '5m', value: '5m' },
  { label: '15m', value: '15m' },
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '1d', value: '1d' },
];

const TIMEFRAME_SECONDS = {
  '1m': 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
};

const ROW_HEIGHT = 20;
const VISIBLE_BUFFER = 10;
const TRADE_FEED_DISPLAY_COUNT = 8;
const DOM_COLUMN_MIN_WIDTHS = [48, 48, 80, 96];
const CLUSTER_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_LARGE_TRADE_THRESHOLD_USD = 1000;
const getClusterWindowStart = (timestamp) =>
  Math.floor(timestamp / CLUSTER_WINDOW_MS) * CLUSTER_WINDOW_MS;

const getTradeLevelPosition = (price, isBuy, basePrice, tickStep, basePosition) => {
  if (basePrice === undefined || tickStep <= 0 || basePosition < 0) return -1;

  const offset = (price - basePrice) / tickStep;
  const nearestLevel = Math.round(offset);
  const alignedOffset = Math.abs(offset - nearestLevel) < 1e-8
    ? nearestLevel
    : offset;
  const levelOffset = isBuy
    ? Math.floor(alignedOffset)
    : Math.ceil(alignedOffset);

  return basePosition - levelOffset;
};

// Binance USDⓈ-M Futures.
// WebSocket-ul este împărțit pe rute: /public (order book) și /market (kline, ticker, trade).
// URL-urile vechi (wss://fstream.binance.com/stream) au fost scoase din funcțiune pe 2026-04-23.
const FUTURES_REST = 'https://fapi.binance.com/fapi/v1';
const FUTURES_WS_PUBLIC = 'wss://fstream.binance.com/public/stream';
const FUTURES_WS_MARKET = 'wss://fstream.binance.com/market/stream';

const formatDollarVolume = (valInDollars) => {
  if (!valInDollars || valInDollars <= 0) return '';
  if (valInDollars >= 1000000) return `$${(valInDollars / 1000000).toFixed(1)}M`;
  if (valInDollars >= 1000) return `$${(valInDollars / 1000).toFixed(1)}K`;
  return `$${valInDollars.toFixed(0)}`;
};

const formatCompactNumber = (value) => {
  if (!Number.isFinite(value)) return '--';
  if (Math.abs(value) >= 1000000000) return `${(value / 1000000000).toFixed(2)}B`;
  if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)}K`;
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

const formatCompactCurrency = (value) =>
  Number.isFinite(value) ? `$${formatCompactNumber(value)}` : '--';

const getStoredNumber = (key, fallback, isValid) => {
  const storedValue = localStorage.getItem(key);
  if (storedValue === null) return fallback;

  const value = Number(storedValue);
  return Number.isFinite(value) && isValid(value) ? value : fallback;
};

// Conexiune WebSocket cu reconectare automată (pauză 1s → 15s).
// Returnează o funcție care închide definitiv conexiunea.
const createReconnectingSocket = (url, { onOpen, onMessage }) => {
  let socket = null;
  let timer = null;
  let attempt = 0;
  let disposed = false;

  const connect = () => {
    if (disposed) return;

    const ws = new WebSocket(url);
    socket = ws;

    ws.onopen = () => {
      if (disposed || socket !== ws) return;
      attempt = 0;
      onOpen?.();
    };

    ws.onmessage = (event) => {
      if (disposed || socket !== ws) return;
      onMessage(event);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onclose = () => {
      if (disposed || socket !== ws) return;
      const delay = Math.min(15000, 1000 * 2 ** attempt);
      attempt += 1;
      timer = setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    disposed = true;
    clearTimeout(timer);
    socket?.close();
  };
};

export default function DeepLiquidityHeatmapChart() {
  const [symbol, setSymbol] = useState(() => localStorage.getItem('hv_symbol') || 'OGNUSDT');

  // Persistenta simbol — salveaza in localStorage la fiecare schimbare
  useEffect(() => {
    localStorage.setItem('hv_symbol', symbol);
  }, [symbol]);

  const [searchSymbol, setSearchSymbol] = useState('');
  const [symbolsList, setSymbolsList] = useState([]);
  const [timeframe, setTimeframe] = useState('1m');
  const [orderBook, setOrderBook] = useState({ bids: {}, asks: {} });
  const [currentPrice, setCurrentPrice] = useState(null);
  const [coinStats, setCoinStats] = useState({
    priceChangePercent: null,
    highPrice: null,
    lowPrice: null,
    baseVolume: null,
    quoteVolume: null,
    openInterest: null,
  });
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 220 });
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [hoveredPrice, setHoveredPrice] = useState(null);

  // Tab activ pentru mobil: 'chart' sau 'dom'
  const [activeTab, setActiveTab] = useState('chart');

  // Stări pentru comutarea vizibilității și pragul de lichiditate minimă
  const [showLiquidity, setShowLiquidity] = useState(true);
  const [showSweeps, setShowSweeps] = useState(true);
  const [minLiquidityUsd, setMinLiquidityUsd] = useState(() =>
    getStoredNumber('hv_min_liquidity_usd', 10000, (value) => value >= 0)
  );
  const [minLiquidityInput, setMinLiquidityInput] = useState(() => minLiquidityUsd.toString());

  const [priceStepPercent, setPriceStepPercent] = useState(() =>
    getStoredNumber('hv_price_step_percent', 0.1, (value) => value > 0)
  );
  const [inputValue, setInputValue] = useState(() => priceStepPercent.toString());
  const [largeTradeThresholdUsd, setLargeTradeThresholdUsd] = useState(() =>
    getStoredNumber(
      'hv_big_trade_threshold_usd',
      DEFAULT_LARGE_TRADE_THRESHOLD_USD,
      (value) => value >= 0
    )
  );
  const [largeTradeThresholdInput, setLargeTradeThresholdInput] = useState(() =>
    largeTradeThresholdUsd.toString()
  );
  const [fixedAnchorPrice, setFixedAnchorPrice] = useState(null);

  const [trades, setTrades] = useState([]);
  const [clusterData, setClusterData] = useState(() => ({
    windowStart: getClusterWindowStart(Date.now()),
    levels: new Map(),
  }));
  const clusterWindowEnd = new Date(clusterData.windowStart + CLUSTER_WINDOW_MS)
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);
  const [domPanelWidth, setDomPanelWidth] = useState(520);
  const [domColumnWidths, setDomColumnWidths] = useState([0, 1, 0.3, 0.4]);
  const [tradeFeedWidth, setTradeFeedWidth] = useState(1);

  const domResizeRef = useRef(null);
  const domColumnHeaderRef = useRef(null);
  const tradeFeedColumnRef = useRef(null);
  const tradeFeedSvgRef = useRef(null);
  const tradeFeedLineRef = useRef(null);
  const tradeFeedPositionsRef = useRef(new Map());
  const tradeFeedAnimationFrameRef = useRef(null);
  const tradeFeedPointOrderRef = useRef([]);

  useEffect(() => () => {
    if (tradeFeedAnimationFrameRef.current !== null) {
      cancelAnimationFrame(tradeFeedAnimationFrameRef.current);
      tradeFeedAnimationFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('hv_min_liquidity_usd', minLiquidityUsd.toString());
  }, [minLiquidityUsd]);

  useEffect(() => {
    localStorage.setItem('hv_price_step_percent', priceStepPercent.toString());
  }, [priceStepPercent]);

  useEffect(() => {
    localStorage.setItem('hv_big_trade_threshold_usd', largeTradeThresholdUsd.toString());
  }, [largeTradeThresholdUsd]);

  useEffect(() => {
    let timerId;
    const scheduleNextReset = () => {
      const delay = CLUSTER_WINDOW_MS - (Date.now() % CLUSTER_WINDOW_MS);
      timerId = setTimeout(resetClusterAtNextWindow, delay);
    };
    const resetClusterAtNextWindow = () => {
      const now = Date.now();
      const currentWindowStart = getClusterWindowStart(now);

      setClusterData((current) => (
        current.windowStart === currentWindowStart
          ? current
          : { windowStart: currentWindowStart, levels: new Map() }
      ));

      scheduleNextReset();
    };

    scheduleNextReset();

    return () => clearTimeout(timerId);
  }, []);

  const chartContainerRef = useRef(null);
  const chartCanvasOverlayRef = useRef(null);
  const chartInstanceRef = useRef(null);
  const candlestickSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const rulerRef = useRef(null);
  const rulerPhaseRef = useRef('idle');
  const priceLoadedForSymbolRef = useRef(null);
  const initialCenterKeyRef = useRef(null);
  const currentCandleRef = useRef(null);
  const domContainerRef = useRef(null);
  const searchInputRef = useRef(null);
  const pendingTradesRef = useRef([]);
  const pendingClusterUpdatesRef = useRef(new Map());

  const localOrderBookRef = useRef({ bids: {}, asks: {} });
  const activeLiquidityRef = useRef({});
  const sweptLiquidityRef = useRef([]); // Stochează nivelurile recent măturate pentru vizualizare

  useEffect(() => {
    const feedColumn = tradeFeedColumnRef.current;
    if (!feedColumn) return undefined;

    const resizeObserver = new ResizeObserver(([entry]) => {
      setTradeFeedWidth(Math.max(1, entry.contentRect.width));
    });
    resizeObserver.observe(feedColumn);

    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let requestInFlight = false;

    const loadOpenInterest = async () => {
      if (requestInFlight) return;
      requestInFlight = true;

      try {
        const response = await fetch(
          `${FUTURES_REST}/openInterest?symbol=${symbol.toUpperCase()}`
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        if (data.code) throw new Error(data.msg || 'Binance API error');
        if (!disposed) {
          const openInterest = Number(data.openInterest);
          setCoinStats((current) => ({
            ...current,
            openInterest: Number.isFinite(openInterest) ? openInterest : null,
          }));
        }
      } catch (err) {
        if (!disposed) {
          console.error('Eroare la încărcarea Open Interest:', err);
        }
      } finally {
        requestInFlight = false;
      }
    };

    loadOpenInterest();
    const intervalId = setInterval(loadOpenInterest, 30 * 1000);

    return () => {
      disposed = true;
      clearInterval(intervalId);
    };
  }, [symbol]);

  const beginPanelResize = (event) => {
    event.preventDefault();
    domResizeRef.current = {
      type: 'panel',
      startX: event.clientX,
      startWidth: domPanelWidth,
    };
  };

  const beginColumnResize = (columnIndex, event) => {
    event.preventDefault();
    event.stopPropagation();

    const gridWidth = domColumnHeaderRef.current?.getBoundingClientRect().width;
    if (!gridWidth || columnIndex >= domColumnWidths.length - 1) return;

    domResizeRef.current = {
      type: 'column',
      columnIndex,
      startX: event.clientX,
      startWidths: [...domColumnWidths],
      gridWidth,
    };
  };

  useEffect(() => {
    const handlePointerMove = (event) => {
      const resize = domResizeRef.current;
      if (!resize) return;

      const deltaX = event.clientX - resize.startX;
      if (resize.type === 'panel') {
        const maxWidth = Math.max(360, window.innerWidth - 250);
        setDomPanelWidth(Math.min(maxWidth, Math.max(360, resize.startWidth - deltaX)));
        return;
      }

      const { columnIndex, startWidths, gridWidth } = resize;
      const totalWeight = startWidths.reduce((total, width) => total + width, 0);
      const pairWeight = startWidths[columnIndex] + startWidths[columnIndex + 1];
      const minLeftWeight = Math.min(
        pairWeight / 2,
        (DOM_COLUMN_MIN_WIDTHS[columnIndex] / gridWidth) * totalWeight
      );
      const minRightWeight = Math.min(
        pairWeight / 2,
        (DOM_COLUMN_MIN_WIDTHS[columnIndex + 1] / gridWidth) * totalWeight
      );
      const nextLeftWidth = Math.min(
        pairWeight - minRightWeight,
        Math.max(
          minLeftWeight,
          startWidths[columnIndex] + (deltaX / gridWidth) * totalWeight
        )
      );
      const nextWidths = [...startWidths];
      nextWidths[columnIndex] = nextLeftWidth;
      nextWidths[columnIndex + 1] = pairWeight - nextLeftWidth;
      setDomColumnWidths(nextWidths);
    };

    const handlePointerUp = () => {
      domResizeRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, []);

  const domGridTemplateColumns = domColumnWidths
    .map((width, index) => `minmax(${DOM_COLUMN_MIN_WIDTHS[index]}px, ${width}fr)`)
    .join(' ');

  // Ref-uri citite de WebSocket / fetch, ca să nu re-creăm conexiunile la fiecare tick de preț
  const currentPriceRef = useRef(null);
  const syncRef = useRef(null);
  const drawRef = useRef(null);

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

  // Sincronizare și detectare SWEEP de lichiditate
  const syncAndFilterLiquidity = useCallback((latestPrice, candleHigh, candleLow) => {
    const ob = localOrderBookRef.current;
    const currentActive = {};

    const activeAskLevels = {};
    Object.entries(ob.asks).forEach(([pStr, vol]) => {
      const p = parseFloat(pStr);
      const valUSD = p * vol;
      if (valUSD >= minLiquidityUsd) {
        currentActive[p] = valUSD;
        activeAskLevels[p] = valUSD;
      }
    });

    const activeBidLevels = {};
    Object.entries(ob.bids).forEach(([pStr, vol]) => {
      const p = parseFloat(pStr);
      const valUSD = p * vol;
      if (valUSD >= minLiquidityUsd) {
        currentActive[p] = valUSD;
        activeBidLevels[p] = valUSD;
      }
    });

    // Sweep DOAR cand pretul curent atinge efectiv nivelul de lichiditate
    if (latestPrice) {
      const now = Date.now();

      // BUY SWEEP: pretul a urcat si a atins/depasit un nivel de ask
      Object.keys(activeAskLevels).forEach((pStr) => {
        const p = parseFloat(pStr);
        if (latestPrice >= p) {
          sweptLiquidityRef.current.push({ price: p, timestamp: now, type: 'BUY_SWEEP' });
          delete currentActive[p];
        }
      });

      // SELL SWEEP: pretul a coborat si a atins/depasit un nivel de bid
      Object.keys(activeBidLevels).forEach((pStr) => {
        const p = parseFloat(pStr);
        if (latestPrice <= p) {
          sweptLiquidityRef.current.push({ price: p, timestamp: now, type: 'SELL_SWEEP' });
          delete currentActive[p];
        }
      });

      sweptLiquidityRef.current = sweptLiquidityRef.current.filter((s) => now - s.timestamp < 15000);
    }

    activeLiquidityRef.current = currentActive;
  }, [minLiquidityUsd]);

  // Versiunea curentă a funcției, disponibilă pentru WebSocket fără dependențe în efecte
  syncRef.current = syncAndFilterLiquidity;

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
    priceLoadedForSymbolRef.current = null;
    initialCenterKeyRef.current = null;
    setFixedAnchorPrice(null);
    setCurrentPrice(null);
    setCoinStats({
      priceChangePercent: null,
      highPrice: null,
      lowPrice: null,
      baseVolume: null,
      quoteVolume: null,
      openInterest: null,
    });
    setOrderBook({ bids: {}, asks: {} });
    setTrades([]);
    pendingTradesRef.current = [];
    pendingClusterUpdatesRef.current.clear();
    setClusterData({
      windowStart: getClusterWindowStart(Date.now()),
      levels: new Map(),
    });
    setHoveredPrice(null);
    setScrollTop(0);
    rulerRef.current = null;
    rulerPhaseRef.current = 'idle';

    currentPriceRef.current = null;
    currentCandleRef.current = null;
    localOrderBookRef.current = { bids: {}, asks: {} };
    activeLiquidityRef.current = {};
    sweptLiquidityRef.current = [];

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

  // Încărcarea simbolurilor Binance Futures (doar perpetual USDT)
  useEffect(() => {
    fetch(`${FUTURES_REST}/exchangeInfo`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (data.symbols) {
          const usdtPairs = data.symbols
            .filter(
              (s) =>
                s.status === 'TRADING' &&
                s.quoteAsset === 'USDT' &&
                s.contractType === 'PERPETUAL'
            )
            .map((s) => s.symbol);

          setSymbolsList(usdtPairs);
        }
      })
      .catch((err) => console.error('Eroare la încărcarea simbolurilor:', err));
  }, []);

  // Order Book Futures: snapshot REST + stream diferențial pe /public.
  // Evenimentele primite cât timp se încarcă snapshot-ul sunt păstrate și aplicate după el,
  // iar cele mai vechi decât snapshot-ul sunt ignorate (procedura oficială Binance).
  useEffect(() => {
    const sym = symbol.toUpperCase();
    const streamSym = symbol.toLowerCase();

    let disposed = false;
    let ready = false; // true după ce snapshot-ul a fost aplicat
    let bookDirty = false;
    let lastUpdateId = 0;
    let buffer = [];
    let syncToken = 0; // invalidează cererile de snapshot mai vechi
    let failures = 0;
    let retryTimer = null;

    const applyDiff = (data) => {
      const ob = localOrderBookRef.current;

      (data.b || []).forEach(([pStr, qStr]) => {
        const p = parseFloat(pStr);
        const q = parseFloat(qStr);

        if (q === 0) {
          delete ob.bids[p];
        } else {
          ob.bids[p] = q;
        }
      });

      (data.a || []).forEach(([pStr, qStr]) => {
        const p = parseFloat(pStr);
        const q = parseFloat(qStr);

        if (q === 0) {
          delete ob.asks[p];
        } else {
          ob.asks[p] = q;
        }
      });

      bookDirty = true;
    };

    const publishBook = () => {
      if (!bookDirty) return;
      bookDirty = false;
      const ob = localOrderBookRef.current;
      setOrderBook({ bids: { ...ob.bids }, asks: { ...ob.asks } });

      syncRef.current?.(
        currentPriceRef.current,
        currentCandleRef.current?.high,
        currentCandleRef.current?.low
      );
    };

    const bookPublishInterval = setInterval(() => {
      if (ready) publishBook();
    }, 250);

    const resync = () => {
      if (disposed) return;

      clearTimeout(retryTimer);
      ready = false;
      buffer = [];
      const token = ++syncToken;

      fetch(`${FUTURES_REST}/depth?symbol=${sym}&limit=1000`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => {
          if (disposed || token !== syncToken) return;

          if (data.code) {
            throw new Error(data.msg || 'Binance API error');
          }

          const bidsObj = {};
          const asksObj = {};

          (data.bids || []).forEach(([p, q]) => {
            bidsObj[parseFloat(p)] = parseFloat(q);
          });

          (data.asks || []).forEach(([p, q]) => {
            asksObj[parseFloat(p)] = parseFloat(q);
          });

          localOrderBookRef.current = { bids: bidsObj, asks: asksObj };
          lastUpdateId = data.lastUpdateId || 0;

          buffer.forEach((evt) => {
            if (evt.u >= lastUpdateId) applyDiff(evt);
          });

          buffer = [];
          ready = true;
          failures = 0;

          bookDirty = true;
          publishBook();
          requestAnimationFrame(() => drawRef.current?.());
        })
        .catch((err) => {
          if (disposed || token !== syncToken) return;

          console.error('Eroare la încărcarea Order Book:', err);

          // Reîncercare cu pauză tot mai mare (3s → 60s), ca să nu depășim limitele Binance
          failures += 1;
          retryTimer = setTimeout(resync, Math.min(60000, 3000 * 2 ** (failures - 1)));
        });
    };

    const stopSocket = createReconnectingSocket(
      `${FUTURES_WS_PUBLIC}?streams=${streamSym}@depth@100ms`,
      {
        onOpen: resync,
        onMessage: (event) => {
          try {
            const message = JSON.parse(event.data);
            const data = message.data || message;

            if (data.e !== 'depthUpdate') return;

            if (!ready) {
              buffer.push(data);
              if (buffer.length > 5000) buffer.shift();
              return;
            }

            if (data.u < lastUpdateId) return;

            applyDiff(data);
          } catch (err) {
            console.error('Eroare la procesarea datelor Order Book:', err);
          }
        },
      }
    );

    // Resincronizare periodică (reîmprospătează și nivelele din afara ferestrei de 1000 de nivele)
    const periodicResync = setInterval(resync, 5 * 60 * 1000);

    return () => {
      disposed = true;
      clearInterval(periodicResync);
      clearInterval(bookPublishInterval);
      clearTimeout(retryTimer);
      stopSocket();
    };
  }, [symbol]);

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

    if (showLiquidity) {
      const activeLevels = activeLiquidityRef.current;
      const values = Object.values(activeLevels);

      const maxVal = Math.max(...values, minLiquidityUsd * 2, 1);
      const bandHeight = Math.max(
        4,
        Math.min(14, 1500 / (chart.timeScale().width() || 500))
      );

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
        const alpha = 0.1 + intensity * 0.25;

        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        ctx.fillRect(0, yCoord - bandHeight / 2, width, bandHeight);
      });

      if (showSweeps && sweptLiquidityRef.current.length > 0) {
        const now = Date.now();
        sweptLiquidityRef.current.forEach((sweep) => {
          const elapsed = now - sweep.timestamp;
          if (elapsed > 15000) return;

          const yCoord = series.priceToCoordinate(sweep.price);
          if (yCoord === null || yCoord < 0 || yCoord > height) return;

          const fadeRatio = 1 - elapsed / 15000;

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
        });
      }
    }

    const ruler = rulerRef.current;
    if (!ruler) return;

    const startX = chart.timeScale().logicalToCoordinate(ruler.start.logical);
    const endX = chart.timeScale().logicalToCoordinate(ruler.end.logical);
    const startY = series.priceToCoordinate(ruler.start.price);
    const endY = series.priceToCoordinate(ruler.end.price);
    if (startX === null || endX === null || startY === null || endY === null) return;

    const delta = ruler.end.price - ruler.start.price;
    const percent = ruler.start.price
      ? (delta / ruler.start.price) * 100
      : 0;
    const barCount = Math.max(1, Math.round(Math.abs(ruler.end.logical - ruler.start.logical)) + 1);
    const durationSeconds = Math.round(
      Math.abs(ruler.end.logical - ruler.start.logical) * TIMEFRAME_SECONDS[timeframe]
    );
    const durationLabel = durationSeconds >= 86400
      ? `${(durationSeconds / 86400).toFixed(1)}d`
      : durationSeconds >= 3600
        ? `${(durationSeconds / 3600).toFixed(1)}h`
        : durationSeconds >= 60
          ? `${Math.round(durationSeconds / 60)}m`
          : `${durationSeconds}s`;
    const priceLabel = `${delta > 0 ? '+' : ''}${delta.toFixed(precision)} (${percent > 0 ? '+' : ''}${percent.toFixed(2)}%)`;
    const rangeLabel = `${barCount} ${barCount === 1 ? 'bar' : 'bars'} · ${durationLabel}`;
    const left = Math.min(startX, endX);
    const right = Math.max(startX, endX);
    const top = Math.min(startY, endY);
    const bottom = Math.max(startY, endY);
    const color = delta >= 0 ? '#26a69a' : '#ef5350';
    const labelWidth = 174;
    const labelHeight = 42;
    const labelX = Math.min(width - labelWidth - 4, Math.max(4, left));
    const labelY = top - labelHeight - 6 >= 4
      ? top - labelHeight - 6
      : Math.min(height - labelHeight - 4, bottom + 6);

    ctx.save();
    ctx.fillStyle = delta >= 0 ? 'rgba(38, 166, 154, 0.16)' : 'rgba(239, 83, 80, 0.16)';
    ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.setLineDash([]);
    [ [startX, startY], [endX, endY] ].forEach(([x, y]) => {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = color;
    ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
    ctx.font = 'bold 12px monospace';
    ctx.fillStyle = '#fff';
    ctx.fillText(priceLabel, labelX + 8, labelY + 16);
    ctx.font = '11px monospace';
    ctx.fillText(rangeLabel, labelX + 8, labelY + 33);
    ctx.restore();
  }, [showLiquidity, showSweeps, minLiquidityUsd, precision, timeframe]);

  // Versiunea curentă a funcției de desenare, disponibilă pentru callback-urile asincrone
  drawRef.current = drawLiquidityMap;

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
      crosshair: { mode: 0 },
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

    const getRulerPoint = (event) => {
      const bounds = chartContainerRef.current.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const logical = chart.timeScale().coordinateToLogical(x);
      const price = candleSeries.coordinateToPrice(y);

      if (logical === null || price === null) return null;
      return { logical, price };
    };

    const handleRulerPointerDown = (event) => {
      if (event.button !== 0) return;

      const phase = rulerPhaseRef.current;
      if (phase === 'idle' && !event.shiftKey) return;

      const point = getRulerPoint(event);
      if (!point) return;

      event.preventDefault();
      event.stopPropagation();

      if (phase === 'idle') {
        rulerRef.current = { start: point, end: point };
        rulerPhaseRef.current = 'placing-end';
      } else if (phase === 'placing-end') {
        rulerRef.current = { ...rulerRef.current, end: point };
        rulerPhaseRef.current = 'placed';
      } else {
        rulerRef.current = null;
        rulerPhaseRef.current = 'idle';
      }

      requestAnimationFrame(drawRef.current);
    };

    const handleRulerPointerMove = (event) => {
      if (rulerPhaseRef.current !== 'placing-end') return;

      const point = getRulerPoint(event);
      if (!point) return;

      rulerRef.current = { ...rulerRef.current, end: point };
      requestAnimationFrame(drawRef.current);
    };

    const handleRulerKeyDown = (event) => {
      if (event.key !== 'Escape' || !rulerRef.current) return;

      rulerRef.current = null;
      rulerPhaseRef.current = 'idle';
      requestAnimationFrame(drawRef.current);
    };

    const chartContainer = chartContainerRef.current;
    chartContainer.addEventListener('pointerdown', handleRulerPointerDown, true);
    chartContainer.addEventListener('pointermove', handleRulerPointerMove, true);
    window.addEventListener('keydown', handleRulerKeyDown);

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });

        requestAnimationFrame(drawLiquidityMap);
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      chartContainer.removeEventListener('pointerdown', handleRulerPointerDown, true);
      chartContainer.removeEventListener('pointermove', handleRulerPointerMove, true);
      window.removeEventListener('keydown', handleRulerKeyDown);
      rulerRef.current = null;
      rulerPhaseRef.current = 'idle';
      chart.remove();
      chartInstanceRef.current = null;
      candlestickSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [drawLiquidityMap]);

  // Încărcarea lumânărilor (Futures)
  useEffect(() => {
    let cancelled = false;
    const requestedSymbol = symbol.toUpperCase();

    fetch(
      `${FUTURES_REST}/klines?symbol=${requestedSymbol}&interval=${timeframe}&limit=300`
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

          priceLoadedForSymbolRef.current = requestedSymbol;
          currentCandleRef.current = { ...lastCandle };
          currentPriceRef.current = lastCandle.close;
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

  // Actualizări WebSocket Futures pe /market: kline, ticker, aggTrade.
  // Prețul curent și funcția de sync sunt citite din ref-uri, deci conexiunea
  // se reface DOAR la schimbarea simbolului sau a timeframe-ului.
  useEffect(() => {
    const sym = symbol.toLowerCase();

    const flushPendingClusters = () => {
      const pendingClusterUpdates = pendingClusterUpdatesRef.current;
      pendingClusterUpdatesRef.current = new Map();

      if (pendingClusterUpdates.size > 0) {
        const windowStart = getClusterWindowStart(Date.now());
        setClusterData((current) => {
          const levels = current.windowStart === windowStart
            ? new Map(current.levels)
            : new Map();

          pendingClusterUpdates.forEach((update, price) => {
            const level = { ...(levels.get(price) || { buyVolume: 0, sellVolume: 0 }) };
            level.buyVolume += update.buyVolume;
            level.sellVolume += update.sellVolume;
            levels.set(price, level);
          });

          return { windowStart, levels };
        });
      }
    };

    let tradeFlushFrame = null;
    const scheduleTradeFlush = () => {
      if (tradeFlushFrame !== null) return;

      tradeFlushFrame = requestAnimationFrame(() => {
        tradeFlushFrame = null;
        const pendingTrades = pendingTradesRef.current.splice(0);
        if (pendingTrades.length === 0) return;

        setTrades((current) => [
          ...pendingTrades.reverse(),
          ...current,
        ].slice(0, 50));
      });
    };

    const clusterFlushInterval = setInterval(flushPendingClusters, 100);
    const stopSocket = createReconnectingSocket(
      `${FUTURES_WS_MARKET}?streams=${sym}@kline_${timeframe}/${sym}@ticker/${sym}@aggTrade`,
      {
        onMessage: (event) => {
          try {
            const message = JSON.parse(event.data);
            const data = message.data || message;

            if (data.e === 'aggTrade') {
              const price = parseFloat(data.p);
              const qty = parseFloat(data.q);
              const dollarVal = price * qty;
              const isBuyerMaker = data.m;

              const newTrade = {
                id: data.a, // la aggTrade id-ul este "a", nu "t"
                price,
                dollarVal,
                isBuy: !isBuyerMaker,
                timestamp: data.T,
                time: new Date(data.T).toLocaleTimeString(),
              };

              pendingTradesRef.current.push(newTrade);
              if (pendingTradesRef.current.length > 50) {
                pendingTradesRef.current.shift();
              }
              scheduleTradeFlush();
              const pendingLevel = pendingClusterUpdatesRef.current.get(price)
                || { buyVolume: 0, sellVolume: 0 };
              if (newTrade.isBuy) {
                pendingLevel.buyVolume += dollarVal;
              } else {
                pendingLevel.sellVolume += dollarVal;
              }
              pendingClusterUpdatesRef.current.set(price, pendingLevel);
            }

            if (data.e === '24hrTicker') {
              const price = parseFloat(data.c);

              priceLoadedForSymbolRef.current = symbol.toUpperCase();
              currentPriceRef.current = price;
              setCurrentPrice(price);
              setCoinStats((current) => ({
                ...current,
                priceChangePercent: parseFloat(data.P),
                highPrice: parseFloat(data.h),
                lowPrice: parseFloat(data.l),
                baseVolume: parseFloat(data.v),
                quoteVolume: parseFloat(data.q),
              }));

              if (candlestickSeriesRef.current && currentCandleRef.current) {
                const updatedCandle = {
                  ...currentCandleRef.current,
                  close: price,
                  high: Math.max(currentCandleRef.current.high, price),
                  low: Math.min(currentCandleRef.current.low, price),
                };

                currentCandleRef.current = updatedCandle;
                candlestickSeriesRef.current.update(updatedCandle);

                syncRef.current?.(price, updatedCandle.high, updatedCandle.low);
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
              priceLoadedForSymbolRef.current = symbol.toUpperCase();
              candlestickSeriesRef.current?.update(candle);

              volumeSeriesRef.current?.update({
                time: k.t / 1000,
                value: parseFloat(k.v),
                color:
                  parseFloat(k.o) <= parseFloat(k.c)
                    ? 'rgba(34, 197, 94, 0.3)'
                    : 'rgba(239, 68, 68, 0.3)',
              });

              currentPriceRef.current = candle.close;
              setCurrentPrice(candle.close);

              syncRef.current?.(candle.close, candle.high, candle.low);
            }
          } catch (err) {
            console.error('Eroare la procesarea datelor WebSocket:', err);
          }
        },
      }
    );

    return () => {
      clearInterval(clusterFlushInterval);
      if (tradeFlushFrame !== null) {
        cancelAnimationFrame(tradeFlushFrame);
      }
      pendingTradesRef.current = [];
      pendingClusterUpdatesRef.current.clear();
      stopSocket();
    };
  }, [symbol, timeframe]);

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

  const hoveredCumulativeVolume = useMemo(() => {
    if (hoveredPrice === null) return null;

    const price = parseFloat(hoveredPrice);
    const askAtLevel = Object.entries(orderBook.asks).some(([priceString, volume]) => {
      const levelPrice = parseFloat(priceString);
      return levelPrice >= price && levelPrice < price + tickStep && volume > 0;
    });
    const isAsk = askAtLevel || (currentPrice !== null && price > currentPrice);
    const levels = isAsk ? orderBook.asks : orderBook.bids;

    return Object.entries(levels).reduce((total, [priceString, volume]) => {
      const levelPrice = parseFloat(priceString);
      const isThroughLevel = isAsk
        ? levelPrice < price + tickStep
        : levelPrice > price - tickStep;
      return isThroughLevel ? total + levelPrice * volume : total;
    }, 0);
  }, [hoveredPrice, orderBook, currentPrice, tickStep]);

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

  const tradesByLevel = useMemo(() => {
    const levels = new Map();
    const basePosition = priceLevels.findIndex((level) => level.index === 2000);
    const basePrice = priceLevels[basePosition]?.rawPrice;
    if (basePrice === undefined || tickStep <= 0) return levels;

    if (clusterData.windowStart === getClusterWindowStart(Date.now())) {
      clusterData.levels.forEach((volume, price) => {
        ['buyVolume', 'sellVolume'].forEach((side) => {
          const isBuy = side === 'buyVolume';
          const position = getTradeLevelPosition(
            price,
            isBuy,
            basePrice,
            tickStep,
            basePosition
          );
          if (position < 0 || position >= priceLevels.length) return;

          const key = priceLevels[position].index;
          let level = levels.get(key);
          if (!level) {
            level = { buyVolume: 0, sellVolume: 0 };
            levels.set(key, level);
          }

          level[side] += volume[side];
        });
      });
    }

    return levels;
  }, [clusterData, priceLevels, tickStep]);

  const bookVolumeByLevel = useMemo(() => {
    const levels = new Map();
    const basePosition = priceLevels.findIndex((level) => level.index === 2000);
    const basePrice = priceLevels[basePosition]?.rawPrice;
    if (basePrice === undefined || tickStep <= 0) return levels;

    const addBookSide = (bookSide, isAsk) => {
      Object.entries(bookSide).forEach(([priceString, quantity]) => {
        const price = Number(priceString);
        const position = getTradeLevelPosition(
          price,
          isAsk,
          basePrice,
          tickStep,
          basePosition
        );
        const level = priceLevels[position];
        if (!level) return;

        const volume = levels.get(level.index) || { ask: 0, bid: 0 };
        volume[isAsk ? 'ask' : 'bid'] += price * quantity;
        levels.set(level.index, volume);
      });
    };

    addBookSide(orderBook.asks, true);
    addBookSide(orderBook.bids, false);
    return levels;
  }, [orderBook, priceLevels, tickStep]);

  const tradeFeedPoints = useMemo(() => {
    const basePosition = priceLevels.findIndex((level) => level.index === 2000);
    const basePrice = priceLevels[basePosition]?.rawPrice;
    if (basePrice === undefined || tickStep <= 0) return [];

    return trades
      .slice(0, TRADE_FEED_DISPLAY_COUNT)
      .reverse()
      .map((trade) => ({
        ...trade,
        position: getTradeLevelPosition(
          trade.price,
          trade.isBuy,
          basePrice,
          tickStep,
          basePosition
        ),
      }))
      .filter((trade) => trade.position >= 0 && trade.position < priceLevels.length);
  }, [trades, priceLevels, tickStep]);

  const getTradeFeedX = (index) => (
    tradeFeedPoints.length === 1
      ? tradeFeedWidth / 2
      : 10 + (index / (tradeFeedPoints.length - 1)) * Math.max(0, tradeFeedWidth - 20)
  );

  const largeOrderBands = useMemo(() => {
    if (currentPriceIndex < 0) return [];

    return tradeFeedPoints
      .filter((trade) => trade.dollarVal >= largeTradeThresholdUsd)
      .map((trade) => {
        return {
          id: trade.id,
          isBuy: trade.isBuy,
          start: Math.min(currentPriceIndex, trade.position),
          end: Math.max(currentPriceIndex, trade.position),
        };
      })
      .slice(-10);
  }, [tradeFeedPoints, currentPriceIndex, largeTradeThresholdUsd]);

  const centerDom = useCallback(() => {
    requestAnimationFrame(() => {
      if (domContainerRef.current && currentPriceIndex !== -1) {
        const containerH = domContainerRef.current.clientHeight;

        const targetScroll = Math.max(0,
          currentPriceIndex * ROW_HEIGHT -
          containerH / 2 +
          ROW_HEIGHT / 2
        );

        domContainerRef.current.scrollTop = targetScroll;
        setScrollTop(targetScroll);
      }
    });
  }, [currentPriceIndex]);

  const centerDomRef = useRef(centerDom);
  centerDomRef.current = centerDom;

  useEffect(() => {
    if (
      currentPriceIndex === -1 ||
      priceLoadedForSymbolRef.current !== symbol.toUpperCase()
    ) return;

    const centerKey = `${symbol}:${activeTab}`;
    if (initialCenterKeyRef.current !== centerKey) {
      initialCenterKeyRef.current = centerKey;
      centerDomRef.current();
    }
  }, [symbol, activeTab, currentPriceIndex]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      centerDomRef.current();
    }, 60 * 1000);

    return () => clearInterval(intervalId);
  }, [symbol, activeTab]);

  // Space = centrare DOM
  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        centerDom();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [centerDom]);

  const handleScroll = (e) => {
    setScrollTop(e.target.scrollTop);
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

  const visibleTradeStart = Math.max(0, startIndex);
  const visibleTradeEnd = Math.min(priceLevels.length - 1, endIndex);
  const visibleTradeHeight = Math.max(
    0,
    (visibleTradeEnd - visibleTradeStart + 1) * ROW_HEIGHT
  );
  const visibleTradePoints = tradeFeedPoints
    .map((trade, index) => ({ ...trade, feedIndex: index }))
    .filter((trade) => (
      trade.position >= visibleTradeStart && trade.position <= visibleTradeEnd
    ));
  const visibleLargeOrderBands = largeOrderBands
    .filter((band) => band.end >= visibleTradeStart && band.start <= visibleTradeEnd)
    .map((band) => ({
      ...band,
      start: Math.max(band.start, visibleTradeStart),
      end: Math.min(band.end, visibleTradeEnd),
    }));

  useLayoutEffect(() => {
    const svg = tradeFeedSvgRef.current;
    if (!svg) return;
    if (tradeFeedAnimationFrameRef.current !== null) {
      cancelAnimationFrame(tradeFeedAnimationFrameRef.current);
      tradeFeedAnimationFrameRef.current = null;
    }

    const now = performance.now();
    const activeIds = new Set();
    const positions = tradeFeedPositionsRef.current;

    svg.querySelectorAll('[data-trade-id]').forEach((node) => {
      const id = node.getAttribute('data-trade-id');
      const targetX = Number(node.getAttribute('data-target-x'));
      const targetY = Number(node.getAttribute('data-target-y'));
      if (id === null || !Number.isFinite(targetX) || !Number.isFinite(targetY)) return;
      activeIds.add(id);

      let position = positions.get(id);
      if (!position) {
        position = {
          node,
          fromX: targetX,
          toX: targetX,
          y: targetY,
          startTime: now,
          duration: 0,
        };
        positions.set(id, position);
      } else {
        const progress = position.duration === 0
          ? 1
          : Math.min(1, (now - position.startTime) / position.duration);
        const easedProgress = 1 - (1 - progress) ** 3;
        const currentX = position.fromX + (position.toX - position.fromX) * easedProgress;

        position.node = node;
        position.y = targetY;
        if (Math.abs(position.toX - targetX) > 0.1) {
          position.fromX = currentX;
          position.toX = targetX;
          position.startTime = now;
          position.duration = 120;
        } else if (progress === 1) {
          position.fromX = targetX;
          position.toX = targetX;
          position.duration = 0;
        }
      }
    });

    positions.forEach((_, id) => {
      if (!activeIds.has(id)) positions.delete(id);
    });
    tradeFeedPointOrderRef.current = Array.from(activeIds);

    const updatePositions = (frameTime) => {
      let isAnimating = false;
      positions.forEach((position) => {
        const progress = position.duration === 0
          ? 1
          : Math.min(1, (frameTime - position.startTime) / position.duration);
        const easedProgress = 1 - (1 - progress) ** 3;
        const x = position.fromX + (position.toX - position.fromX) * easedProgress;
        position.node.setAttribute('transform', `translate(${x} ${position.y})`);
        if (progress < 1) isAnimating = true;
      });

      const line = tradeFeedLineRef.current;
      if (line) {
        const points = tradeFeedPointOrderRef.current
          .map((id) => {
            const position = positions.get(id);
            if (!position) return null;
            const progress = position.duration === 0
              ? 1
              : Math.min(1, (frameTime - position.startTime) / position.duration);
            const easedProgress = 1 - (1 - progress) ** 3;
            const x = position.fromX + (position.toX - position.fromX) * easedProgress;
            return `${x},${position.y}`;
          })
          .filter(Boolean)
          .join(' ');
        line.setAttribute('points', points);
      }

      if (isAnimating) {
        tradeFeedAnimationFrameRef.current = requestAnimationFrame(updatePositions);
      } else {
        tradeFeedAnimationFrameRef.current = null;
      }
    };

    updatePositions(now);
  }, [visibleTradePoints, visibleTradeStart, tradeFeedWidth]);

  const visibleRows = useMemo(() => {
    const rows = [];

    for (let i = startIndex; i <= endIndex; i++) {
      const level = priceLevels[i];
      if (!level) continue;

      const levelVolume = bookVolumeByLevel.get(level.index);

      rows.push({
        ...level,
        topOffset: i * ROW_HEIGHT,
        askDollarVolume: levelVolume?.ask ?? 0,
        bidDollarVolume: levelVolume?.bid ?? 0,
        isCurrentLevel: i === currentPriceIndex,
        isBestAsk: bestAsk && Math.abs(level.rawPrice - bestAsk) < tickStep / 2,
        isBestBid: bestBid && Math.abs(level.rawPrice - bestBid) < tickStep / 2,
      });
    }

    return rows;
  }, [
    priceLevels,
    startIndex,
    endIndex,
    bookVolumeByLevel,
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
    <div className={`flex flex-col w-full bg-[#0b0e14] text-gray-200 font-sans ${
      activeTab === 'dom'
        ? 'h-auto min-h-screen overflow-visible md:h-screen md:overflow-hidden'
        : 'h-screen overflow-hidden'
    }`}>
      {/* Topbar / Header */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between p-2 md:px-4 md:py-2 bg-[#121620] border-b border-gray-800 gap-2 select-none">
        <div className="flex items-center justify-between md:justify-start gap-2 md:gap-4 overflow-x-auto">
{/* Căutare Simbol cu sugestii */}
<div className="relative" style={{ zIndex: 9999 }}>
  <input
    ref={searchInputRef}
    type="text"
    value={isSearchOpen ? searchSymbol : symbol}
    placeholder="Caută simbol..."
    onFocus={() => {
      setIsSearchOpen(true);
      setSearchSymbol('');
      setSelectedIdx(-1);
      if (searchInputRef.current) {
        const r = searchInputRef.current.getBoundingClientRect();
        setDropdownPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 220) });
      }
    }}
    onChange={(e) => {
      const val = e.target.value.toUpperCase();
      setSearchSymbol(val);
      setIsSearchOpen(true);
      setSelectedIdx(-1);
      if (searchInputRef.current) {
        const r = searchInputRef.current.getBoundingClientRect();
        setDropdownPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 220) });
      }
    }}
    onKeyDown={(e) => {
      const q = searchSymbol.trim().toUpperCase();
      const filtered = symbolsList
        .filter((s) => s.includes(q))
        .sort((a, b) => {
          const aS = a.startsWith(q), bS = b.startsWith(q);
          if (aS && !bS) return -1;
          if (!aS && bS) return 1;
          return a.localeCompare(b);
        })
        .slice(0, 50);
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx((i) => Math.max(i - 1, -1)); }
      else if (e.key === 'Escape') { setIsSearchOpen(false); setSearchSymbol(''); setSelectedIdx(-1); e.target.blur(); }
      else if (e.key === 'Enter') {
        const pick = selectedIdx >= 0 ? filtered[selectedIdx] : filtered[0];
        if (pick) { setSymbol(pick); setIsSearchOpen(false); setSearchSymbol(''); setSelectedIdx(-1); e.target.blur(); }
      }
    }}
    onBlur={() => { setTimeout(() => { setIsSearchOpen(false); setSelectedIdx(-1); }, 180); }}
    className="w-36 md:w-40 bg-[#1a202c] hover:bg-[#2d3748] px-3 py-1.5 rounded text-xs md:text-sm font-semibold text-white border border-gray-700 focus:border-blue-500 focus:outline-none"
  />
  {isSearchOpen && (() => {
    const q = searchSymbol.trim().toUpperCase();
    const filtered = symbolsList
      .filter((s) => s.includes(q))
      .sort((a, b) => {
        const aS = a.startsWith(q), bS = b.startsWith(q);
        if (aS && !bS) return -1; if (!aS && bS) return 1;
        return a.localeCompare(b);
      })
      .slice(0, 50);
    return (
      <div style={{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width, zIndex: 99999 }}>
        <div style={{ background: '#181a20', border: '1px solid #374151', borderRadius: 8, boxShadow: '0 20px 40px rgba(0,0,0,0.7)', overflow: 'hidden', maxHeight: 260, overflowY: 'auto' }}>
          {symbolsList.length === 0 && <div style={{ padding: '10px 12px', fontSize: 12, color: '#9ca3af' }}>Se încarcă simbolurile...</div>}
          {symbolsList.length > 0 && filtered.length === 0 && <div style={{ padding: '10px 12px', fontSize: 12, color: '#6b7280' }}>Niciun simbol găsit pentru „{q}"</div>}
          {filtered.map((sym, idx) => {
            const isActive = sym === symbol, isHL = idx === selectedIdx;
            const q2 = searchSymbol.trim().toUpperCase(), ms = sym.indexOf(q2);
            return (
              <button type="button" key={sym}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setSelectedIdx(idx)}
                onClick={() => { setSymbol(sym); setIsSearchOpen(false); setSearchSymbol(''); setSelectedIdx(-1); }}
                style={{ width: '100%', textAlign: 'left', padding: '7px 12px', fontSize: 13, fontFamily: 'monospace', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, background: isHL ? '#2b2f3e' : isActive ? 'rgba(59,130,246,0.15)' : 'transparent', color: isActive ? '#60a5fa' : '#e5e7eb', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                {q2 && ms >= 0
                  ? <span>{sym.slice(0,ms)}<span style={{ color:'#facc15', fontWeight:700 }}>{sym.slice(ms,ms+q2.length)}</span>{sym.slice(ms+q2.length)}</span>
                  : <span>{sym}</span>}
                {isActive && <span style={{ marginLeft:'auto', fontSize:10, color:'#60a5fa' }}>✓</span>}
              </button>
            );
          })}
        </div>
      </div>
    );
  })()}
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

      <div className="flex shrink-0 gap-x-5 gap-y-1 overflow-x-auto border-b border-gray-800 bg-[#0f131c] px-3 py-2 text-[10px] md:gap-x-7 md:px-4 md:text-xs">
        <div className="shrink-0">
          <div className="text-gray-500">24H CHANGE</div>
          <div className={`font-semibold ${
            coinStats.priceChangePercent > 0
              ? 'text-green-400'
              : coinStats.priceChangePercent < 0
                ? 'text-red-400'
                : 'text-gray-300'
          }`}>
            {Number.isFinite(coinStats.priceChangePercent)
              ? `${coinStats.priceChangePercent > 0 ? '+' : ''}${coinStats.priceChangePercent.toFixed(2)}%`
              : '--'}
          </div>
        </div>
        <div className="shrink-0">
          <div className="text-gray-500">24H VOLUME</div>
          <div className="font-semibold text-gray-200">
            {formatCompactCurrency(coinStats.quoteVolume)}
          </div>
        </div>
        <div className="shrink-0">
          <div className="text-gray-500">BASE VOLUME</div>
          <div className="font-semibold text-gray-200">
            {Number.isFinite(coinStats.baseVolume)
              ? `${formatCompactNumber(coinStats.baseVolume)} ${symbol.replace(/USDT$/, '')}`
              : '--'}
          </div>
        </div>
        <div className="shrink-0">
          <div className="text-gray-500">OPEN INTEREST</div>
          <div className="font-semibold text-gray-200">
            {Number.isFinite(coinStats.openInterest)
              ? `${formatCompactNumber(coinStats.openInterest)} ${symbol.replace(/USDT$/, '')}`
              : '--'}
          </div>
        </div>
        <div className="shrink-0">
          <div className="text-gray-500">OI VALUE</div>
          <div className="font-semibold text-gray-200">
            {Number.isFinite(coinStats.openInterest) && Number.isFinite(currentPrice)
              ? formatCompactCurrency(coinStats.openInterest * currentPrice)
              : '--'}
          </div>
        </div>
        <div className="shrink-0">
          <div className="text-gray-500">24H HIGH / LOW</div>
          <div className="font-semibold text-gray-200">
            {Number.isFinite(coinStats.highPrice) && Number.isFinite(coinStats.lowPrice)
              ? `${coinStats.highPrice} / ${coinStats.lowPrice}`
              : '--'}
          </div>
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
      <div className={`flex overflow-hidden relative ${
        activeTab === 'dom'
          ? 'h-[90vh] flex-none md:h-auto md:flex-1'
          : 'flex-1'
      }`}>
        {/* TAB 1: Grafic + Heatmap Overlay */}
        <div
          className={`min-w-0 flex-1 relative border-r border-gray-800 h-full ${
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

          <div ref={chartContainerRef} className="relative h-full w-full min-w-0" />
          <canvas
            ref={chartCanvasOverlayRef}
            className="absolute top-0 left-0 pointer-events-none z-10"
          />
        </div>

        {/* TAB 2: DOM / Order Book */}
        <div
          style={{ '--dom-panel-width': `${domPanelWidth}px` }}
          className={`w-full md:w-[var(--dom-panel-width)] md:min-w-[var(--dom-panel-width)] md:flex-none md:shrink-0 bg-[#11141c] flex flex-col font-mono text-[10px] md:text-xs select-none relative h-full ${
            activeTab === 'dom' ? 'flex' : 'hidden md:flex'
          }`}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize DOM panel"
            tabIndex={0}
            onPointerDown={beginPanelResize}
            className="absolute -left-1.5 top-0 z-50 hidden h-full w-3 cursor-col-resize touch-none items-center justify-center md:flex"
          >
            <span className="h-12 w-1 rounded-full bg-gray-500/60 transition-colors hover:bg-blue-400" />
          </div>
          <div className="px-3 py-2 bg-[#171c28] border-b border-gray-800 flex flex-wrap justify-between items-center gap-2 text-gray-400 text-[10px] md:text-[11px]">
            <div className="flex items-center gap-1">
              <span>Pas Preț (%):</span>
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
            <div className="flex items-center gap-1 text-[9px]">
              <label htmlFor="big-trade-threshold" className="whitespace-nowrap">
                BIG $:
              </label>
              <input
                id="big-trade-threshold"
                type="text"
                inputMode="decimal"
                value={largeTradeThresholdInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setLargeTradeThresholdInput(value);
                  if (value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0) {
                    setLargeTradeThresholdUsd(Number(value));
                  }
                }}
                onBlur={() => setLargeTradeThresholdInput(largeTradeThresholdUsd.toString())}
                className="w-16 min-w-0 rounded border border-gray-700 bg-[#0b0e14] px-1 py-0.5 text-right text-white focus:border-blue-500 focus:outline-none"
                aria-label="Big trade threshold in US dollars"
              />
            </div>
          </div>

          <div
            ref={domColumnHeaderRef}
            style={{ gridTemplateColumns: domGridTemplateColumns }}
            className="grid bg-[#181d2a] border-b border-gray-800 text-[9px] md:text-[10px] text-gray-400 py-1.5 px-2 font-bold"
          >
            {['CLUSTER', 'TRADE FEED', 'VOL ($)', 'PRICE LEVEL'].map((title, index) => (
              <span
                key={title}
                className={`relative flex min-w-0 items-center whitespace-nowrap ${
                  index === 0 ? 'justify-start' : index === 1 ? 'justify-center' : 'justify-end'
                }`}
              >
                {index === 0 ? (
                  <span className="flex min-w-0 items-center gap-1">
                    <span>{title}</span>
                    <span className="text-[8px] font-medium text-blue-300">{clusterWindowEnd}</span>
                  </span>
                ) : index === 1 ? (
                  <span>{title}</span>
                ) : title}
                {index < 3 && (
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${title} column`}
                    tabIndex={0}
                    onPointerDown={(event) => beginColumnResize(index, event)}
                    className="absolute -right-1 top-[-6px] bottom-[-6px] z-40 w-2 cursor-col-resize touch-none hover:bg-blue-400/60"
                  />
                )}
              </span>
            ))}
          </div>

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
                      gridTemplateColumns: domGridTemplateColumns,
                    }}
                    className={`grid items-center gap-1 px-2 border-b border-gray-900/60 cursor-pointer hover:brightness-125 ${rowBgStyle}`}
                  >
                    <div className="relative h-4 min-w-0 flex items-center overflow-hidden rounded bg-gray-950/90">
                      {(() => {
                        const cluster = tradesByLevel.get(row.index);
                        if (!cluster) return null;
                        const total = cluster.buyVolume + cluster.sellVolume;
                        if (total <= 0) return null;
                        const buyWidth = (cluster.buyVolume / total) * 100;

                        return (
                          <>
                            <div className="absolute inset-y-0 left-0 bg-green-500/80" style={{ width: `${buyWidth}%` }} />
                            <div className="absolute inset-y-0 right-0 bg-red-500/80" style={{ width: `${100 - buyWidth}%` }} />
                            <span
                              className="relative z-10 w-full truncate text-center text-[9px] font-extrabold leading-none text-white [text-shadow:0_1px_2px_#000]"
                              title={`Buy ${formatDollarVolume(cluster.buyVolume)} / Sell ${formatDollarVolume(cluster.sellVolume)}`}
                            >
                              {formatDollarVolume(total)}
                            </span>
                          </>
                        );
                      })()}
                    </div>

                    <div className="relative h-full min-w-0" aria-label="Trade price path" />

                    <div className="relative h-full flex items-center justify-start overflow-hidden">
                      <div
                        className={`absolute left-0 top-0 bottom-0 pointer-events-none opacity-15 ${
                          isAsk ? 'bg-red-500' : 'bg-green-500'
                        }`}
                        style={{ width: barWidth }}
                      />
                      <span
                        className={`text-[10px] md:text-[11px] font-semibold z-10 relative ${
                          isAsk ? 'text-red-300' : 'text-green-300'
                        }`}
                        title={isHovered
                          ? `Cumulative ${isAsk ? 'ask' : 'bid'} volume through ${row.price}: ${formatCompactCurrency(hoveredCumulativeVolume)}`
                          : `Volume at level: ${formatDollarVolume(dollarVal) || '$0'}`}
                      >
                        {isHovered
                          ? formatCompactCurrency(hoveredCumulativeVolume)
                          : formatDollarVolume(dollarVal)}
                      </span>
                    </div>

                    <div className="text-right h-full min-w-0 flex items-center justify-end overflow-hidden">
                      <span className={`text-[10px] md:text-[11px] ${priceTextColor}`}>
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
              <div
                className="pointer-events-none absolute left-0 right-0 top-0 z-30 grid"
                style={{
                  top: `${visibleTradeStart * ROW_HEIGHT}px`,
                  height: `${visibleTradeHeight}px`,
                  gridTemplateColumns: domGridTemplateColumns,
                }}
                aria-label="Recent trades by price and time"
              >
                <div
                  ref={tradeFeedColumnRef}
                  style={{ gridColumn: 2, height: `${visibleTradeHeight}px` }}
                >
                  <svg
                    ref={tradeFeedSvgRef}
                    className="h-full w-full"
                    viewBox={`0 0 ${tradeFeedWidth} ${visibleTradeHeight}`}
                    preserveAspectRatio="none"
                    role="img"
                    aria-label="Recent trade markers"
                  >
                      {visibleTradePoints.length > 1 && (
                        <polyline
                          ref={tradeFeedLineRef}
                          points={visibleTradePoints
                            .map((trade) => {
                              const x = getTradeFeedX(trade.feedIndex);
                              const y = (trade.position - visibleTradeStart) * ROW_HEIGHT + ROW_HEIGHT / 2;
                              return `${x},${y}`;
                            })
                            .join(' ')}
                          fill="none"
                          stroke="#cbd5e1"
                          strokeOpacity="0.75"
                          strokeWidth="1.5"
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                      {visibleTradePoints.map((trade) => {
                      const x = getTradeFeedX(trade.feedIndex);
                      const y = (trade.position - visibleTradeStart) * ROW_HEIGHT + ROW_HEIGHT / 2;
                      const isLargeTrade = trade.dollarVal >= largeTradeThresholdUsd;
                      const radius = Math.min(
                        11,
                        Math.max(5, 3.5 + Math.log10(Math.max(1, trade.dollarVal)) * 1.5)
                      );
                      const tradeColor = trade.isBuy ? '#22c55e' : '#ef4444';
                      const volumeLabel = formatDollarVolume(trade.dollarVal);
                      const labelWidth = volumeLabel.length * 6 + 10;

                      return (
                        <g
                          key={trade.id}
                          transform={`translate(${x} ${y})`}
                          data-trade-id={trade.id}
                          data-target-x={x}
                          data-target-y={y}
                        >
                          <title>
                            {`${trade.isBuy ? 'Buy' : 'Sell'} ${formatDollarVolume(trade.dollarVal)} @ ${trade.price} (${trade.time})`}
                          </title>
                          {isLargeTrade ? (
                            <>
                              <rect
                                x={-labelWidth / 2 - 1}
                                y="-10"
                                width={labelWidth + 2}
                                height="20"
                                rx="3"
                                fill="#11141c"
                              />
                              <rect
                                x={-labelWidth / 2}
                                y="-9"
                                width={labelWidth}
                                height="18"
                                rx="2"
                                fill={tradeColor}
                                stroke="#fff"
                                strokeWidth="1.5"
                                vectorEffect="non-scaling-stroke"
                              />
                              <text
                                x="0"
                                y="3.5"
                                fill="#fff"
                                textAnchor="middle"
                                fontSize="10"
                                fontWeight="800"
                                fontFamily="ui-monospace, SFMono-Regular, monospace"
                                vectorEffect="non-scaling-stroke"
                              >
                                {volumeLabel}
                              </text>
                            </>
                          ) : (
                            <>
                              <circle cx="0" cy="0" r={radius + 1.5} fill="#11141c" />
                              <circle
                                cx="0"
                                cy="0"
                                r={radius}
                                fill={tradeColor}
                                stroke="#fff"
                                strokeWidth="1.25"
                                vectorEffect="non-scaling-stroke"
                              />
                            </>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>
              {visibleLargeOrderBands.map((band) => (
                <div
                  key={`large-order-${band.id}`}
                  style={{ gridTemplateColumns: domGridTemplateColumns, top: `${band.start * ROW_HEIGHT}px`, height: `${(band.end - band.start + 1) * ROW_HEIGHT}px` }}
                  className="pointer-events-none absolute left-0 right-0 z-20 grid gap-1 px-2"
                  title={`Large ${band.isBuy ? 'buy' : 'sell'} trade from current price to trade price`}
                >
                  <div
                    className={`col-start-2 h-full rounded-sm border-2 ${
                      band.isBuy
                        ? 'border-green-400/80 bg-green-500/10'
                        : 'border-red-400/80 bg-red-500/10'
                    }`}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}