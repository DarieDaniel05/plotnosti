import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import axios from "axios";
import alertSound from "./mixkit-software-interface-start-2574.wav";

function SpotPage() {
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [data, setData] = useState([]);
  const [orderBookData, setOrderBookData] = useState({});
  const [currentPrices, setCurrentPrices] = useState({});
  const [filteredDataAsks, setFilteredDataAsks] = useState([]);
  const [filteredDataBids, setFilteredDataBids] = useState([]);
  const [soundPlayed, setSoundPlayed] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [volume, setVolume] = useState(0.01);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [timeUpdateTrigger, setTimeUpdateTrigger] = useState(0);
  
  const wsConnections = useRef(new Map());
  const tickerWsConnections = useRef(new Map());
  const activeSymbols = useRef(new Set());
  const orderTimestamps = useRef(new Map()); // Cheie: symbol-price-qty, Valoare: timestamp

  function MoneziVanzare(symbol, pret, sumaTotala, timestamp = null) {
    this.symbol = symbol;
    this.pret = pret;
    this.sumaTotala = sumaTotala;
    this.timestamp = timestamp || Date.now();
  }

  const getCurrentPrice = useCallback(
    (symbol) => {
      if (currentPrices[symbol]) {
        return parseFloat(currentPrices[symbol]);
      }
      const coinData = data.find((coin) => coin.symbol === symbol);
      return coinData ? parseFloat(coinData.lastPrice) : null;
    },
    [currentPrices, data]
  );

  const fetchMonezi = async () => {
    try {
      const response = await axios.get(
        "https://fapi.binance.com/fapi/v1/ticker/24hr"
      );
      setData(response.data);
      
      const prices = {};
      response.data.forEach(coin => {
        prices[coin.symbol] = coin.lastPrice;
      });
      setCurrentPrices(prev => ({ ...prev, ...prices }));
      
      return response.data;
    } catch (error) {
      console.log(error);
      return [];
    }
  };

  const fetchInitialOrderBook = async (symbol) => {
    try {
      const response = await axios.get(
        "https://fapi.binance.com/fapi/v1/depth",
        { params: { symbol, limit: 500 } }
      );
      
      setOrderBookData(prev => ({
        ...prev,
        [symbol]: {
          bids: response.data.bids,
          asks: response.data.asks,
          lastUpdateId: response.data.lastUpdateId
        }
      }));
      
      return response.data;
    } catch (error) {
      console.error(`Error fetching initial order book for ${symbol}:`, error);
      return null;
    }
  };

  const createTickerWebSocketConnection = useCallback((symbol) => {
    if (tickerWsConnections.current.has(symbol)) {
      return;
    }

    const wsUrl = `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@ticker`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`Ticker WebSocket connected for ${symbol}`);
    };

    ws.onmessage = (event) => {
      try {
        const tickerData = JSON.parse(event.data);
        
        setCurrentPrices(prev => ({
          ...prev,
          [symbol]: tickerData.c
        }));
        
      } catch (error) {
        console.error(`Error parsing ticker WebSocket message for ${symbol}:`, error);
      }
    };

    ws.onerror = (error) => {
      console.error(`Ticker WebSocket error for ${symbol}:`, error);
    };

    ws.onclose = () => {
      console.log(`Ticker WebSocket closed for ${symbol}`);
      tickerWsConnections.current.delete(symbol);
      
      setTimeout(() => {
        if (activeSymbols.current.has(symbol)) {
          createTickerWebSocketConnection(symbol);
        }
      }, 5000);
    };

    tickerWsConnections.current.set(symbol, ws);
  }, []);

  const createWebSocketConnection = useCallback((symbol) => {
    if (wsConnections.current.has(symbol)) {
      return;
    }

    const wsUrl = `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@depth`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`Order book WebSocket connected for ${symbol}`);
      setConnectionStatus(prev => prev === 'disconnected' ? 'connecting' : prev);
    };

    ws.onmessage = (event) => {
      try {
        const depthData = JSON.parse(event.data);
        
        setOrderBookData(prev => {
          const currentData = prev[symbol];
          if (!currentData) return prev;

          // FIXED: Only update if there's actual change in the order book
          const hasChanges = (depthData.b && depthData.b.length > 0) || (depthData.a && depthData.a.length > 0);
          if (!hasChanges) return prev;

          return {
            ...prev,
            [symbol]: {
              bids: depthData.b || currentData.bids,
              asks: depthData.a || currentData.asks,
              lastUpdateId: depthData.u || currentData.lastUpdateId
            }
          };
        });

        setConnectionStatus('connected');
      } catch (error) {
        console.error(`Error parsing order book WebSocket message for ${symbol}:`, error);
      }
    };

    ws.onerror = (error) => {
      console.error(`Order book WebSocket error for ${symbol}:`, error);
      setConnectionStatus('error');
    };

    ws.onclose = () => {
      console.log(`Order book WebSocket closed for ${symbol}`);
      wsConnections.current.delete(symbol);
      
      setTimeout(() => {
        if (activeSymbols.current.has(symbol)) {
          createWebSocketConnection(symbol);
        }
      }, 5000);
    };

    wsConnections.current.set(symbol, ws);
  }, []);

  const closeWebSocketConnection = useCallback((symbol) => {
    const orderBookWs = wsConnections.current.get(symbol);
    if (orderBookWs && orderBookWs.readyState === WebSocket.OPEN) {
      orderBookWs.close();
    }
    wsConnections.current.delete(symbol);
    
    const tickerWs = tickerWsConnections.current.get(symbol);
    if (tickerWs && tickerWs.readyState === WebSocket.OPEN) {
      tickerWs.close();
    }
    tickerWsConnections.current.delete(symbol);
    
    activeSymbols.current.delete(symbol);
  }, []);

  // FIXED: Memoized order processing to prevent recreating function on every render
  const processOrderBookData = useMemo(() => {
    return (symbol, orderBook) => {
      if (!orderBook || !orderBook.bids || !orderBook.asks) return { asks: [], bids: [] };

      const processOrders = (orders, type) => {
        return orders
          .map(([price, qty]) => {
            const priceNum = parseFloat(price);
            const qtyNum = parseFloat(qty);
            const sum = priceNum * qtyNum;
            
            if (sum >= 250000) {
              // FIXED: More stable and precise order key
              const orderKey = `${symbol}-${type}-${priceNum.toFixed(8)}-${qtyNum.toFixed(8)}`;
              
              // Only set timestamp if this is a truly new order
              if (!orderTimestamps.current.has(orderKey)) {
                orderTimestamps.current.set(orderKey, Date.now());
              }
              
              const timestamp = orderTimestamps.current.get(orderKey);
              return new MoneziVanzare(symbol, priceNum, sum, timestamp);
            }
            return null;
          })
          .filter(Boolean);
      };

      return {
        asks: processOrders(orderBook.asks, 'ask'),
        bids: processOrders(orderBook.bids, 'bid')
      };
    };
  }, []); // Empty dependency array since the function logic doesn't change

  useEffect(() => {
    if (data.length === 0) {
      setFilteredDataAsks([]);
      setFilteredDataBids([]);
      setIsLoadingData(false);
      return;
    }

    const processFilteredData = async () => {
      const filtered = data.filter(
        (moneda) =>
          ![
            "BTCUSDT","ETHUSDT","SOLUSDT","DOGEUSDT","BTCUSDC",
            "XRPUSDT","ETHUSDC","SOLUSDC","DOGEUSDC","XRPUSDC",
            "AVAXUSDT","BTCUSDT_250328","BNBUSDT","CRVUSDT",
            "EOSUSDT","LINKUSDT","LTCUSDT","SUIUSDT","ADAUSDT",
            "ADAUSDC","TRUMPUSDT","WIFUSDT", "ENAUSDC", "ENAUSDT","BCHUSDT","SUIUSDC","FILUSDT","FILUSDC","LINKUSDC","FARTCOINUSDT","FARTCOINUSDC",
          ].includes(moneda.symbol) && moneda.quoteVolume >= 50000000
      );

      const newActiveSymbols = new Set(filtered.map(m => m.symbol));
      
      activeSymbols.current.forEach(symbol => {
        if (!newActiveSymbols.has(symbol)) {
          closeWebSocketConnection(symbol);
        }
      });

      for (const moneda of filtered) {
        const symbol = moneda.symbol;
        activeSymbols.current.add(symbol);
        
        if (!wsConnections.current.has(symbol)) {
          await fetchInitialOrderBook(symbol);
          createWebSocketConnection(symbol);
          createTickerWebSocketConnection(symbol);
        }
      }

      setIsLoadingData(false);
    };

    processFilteredData();
  }, [data, createWebSocketConnection, createTickerWebSocketConnection, closeWebSocketConnection]);

  // FIXED: Debounced order processing to prevent constant updates
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      const allAsks = [];
      const allBids = [];

      Object.entries(orderBookData).forEach(([symbol, orderBook]) => {
        const processed = processOrderBookData(symbol, orderBook);
        allAsks.push(...processed.asks);
        allBids.push(...processed.bids);
      });

      // FIXED: Only cleanup timestamps for symbols that are no longer active
      const keysToDelete = [];
      orderTimestamps.current.forEach((timestamp, key) => {
        const symbolFromKey = key.split('-')[0];
        if (!activeSymbols.current.has(symbolFromKey)) {
          keysToDelete.push(key);
        }
      });
      keysToDelete.forEach(key => orderTimestamps.current.delete(key));

      const sortedAsks = allAsks.sort((a, b) => b.sumaTotala - a.sumaTotala);
      const sortedBids = allBids.sort((a, b) => b.sumaTotala - a.sumaTotala);

      setFilteredDataAsks(sortedAsks);
      setFilteredDataBids(sortedBids);
    }, 100); // Debounce updates by 100ms

    return () => clearTimeout(timeoutId);
  }, [orderBookData]); // FIXED: Removed processOrderBookData dependency

  useEffect(() => {
    fetchMonezi();
  }, []);

  const calculateDistancePercentage = (price, currentPrice) => {
    if (currentPrice) {
      return ((price - currentPrice) / currentPrice) * 100;
    }
    return 0;
  };

  const filterByPercentage = (price, currentPrice) => {
    const percentage = calculateDistancePercentage(price, currentPrice);
    return percentage <= 5 && percentage >= -5;
  };

  const playSound = useCallback(() => {
    if (soundEnabled) {
      const audio = new Audio(alertSound);
      audio.volume = volume;
      audio.play();
    }
  }, [soundEnabled, volume]);

  const checkAndPlaySound = (percentage, sumaTotala) => {
    if (
      !soundPlayed &&
      sumaTotala > 700000 &&
      ((percentage > 0 && percentage <= 0.5) ||
        (percentage >= -0.5 && percentage < 0))
    ) {
      playSound();
      setSoundPlayed(true);
      setTimeout(() => setSoundPlayed(false), 30000);
    }
    if (percentage > 0 && percentage <= 1) {
      return { color: "#40eb34" };
    } else if (percentage >= -1 && percentage < 0) {
      return { color: "red" };
    }
    return {};
  };

  useEffect(() => {
    const intervalId = setInterval(() => {
      fetchMonezi();
    }, 60000);

    return () => clearInterval(intervalId);
  }, []);

  // FIXED: Less frequent time updates to reduce re-renders
  useEffect(() => {
    const timeUpdateInterval = setInterval(() => {
      setTimeUpdateTrigger(prev => prev + 1);
    }, 30000); // Changed from 10 seconds to 30 seconds

    return () => clearInterval(timeUpdateInterval);
  }, []);

  useEffect(() => {
    return () => {
      wsConnections.current.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      });
      wsConnections.current.clear();
      
      tickerWsConnections.current.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      });
      tickerWsConnections.current.clear();
      
      activeSymbols.current.clear();
      orderTimestamps.current.clear();
    };
  }, []);

  const formatDuration = useCallback((timestamp) => {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }, []);

  // FIXED: Stable filtering with debouncing to prevent constant recalculation
  const filteredAsks = useMemo(() => {
    return filteredDataAsks.filter((coin) => {
      const currentPrice = getCurrentPrice(coin.symbol);
      return currentPrice && filterByPercentage(coin.pret, currentPrice);
    });
  }, [filteredDataAsks, timeUpdateTrigger]); // Use timeUpdateTrigger instead of direct price dependency

  const filteredBids = useMemo(() => {
    return filteredDataBids.filter((coin) => {
      const currentPrice = getCurrentPrice(coin.symbol);
      return currentPrice && filterByPercentage(coin.pret, currentPrice);
    });
  }, [filteredDataBids, timeUpdateTrigger]); // Use timeUpdateTrigger instead of direct price dependency

  const getConnectionStatusColor = () => {
    switch (connectionStatus) {
      case 'connected': return 'text-green-400';
      case 'connecting': return 'text-yellow-400';
      case 'error': return 'text-red-400';
      default: return 'text-gray-400';
    }
  };

  const getConnectionStatusText = () => {
    switch (connectionStatus) {
      case 'connected': return '🟢 Live';
      case 'connecting': return '🟡 Connecting';
      case 'error': return '🔴 Error';
      default: return '⚫ Disconnected';
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-200 p-6">
      <div className="flex items-center justify-center gap-4 mb-6">
        <h1 className="text-3xl font-bold">📊 Future Monitor</h1>
        <span className={`text-sm font-medium ${getConnectionStatusColor()}`}>
          {getConnectionStatusText()}
        </span>
      </div>

      <div className="flex flex-col md:flex-row items-center justify-center gap-6 mb-8">
        <button
          onClick={() => setSoundEnabled(!soundEnabled)}
          className={`px-6 py-2 rounded-lg font-semibold shadow-md transition ${
            soundEnabled
              ? "bg-green-600 hover:bg-green-700"
              : "bg-red-600 hover:bg-red-700"
          }`}
        >
          {soundEnabled ? "🔊 Turn off sound" : "🔇 Turn on sound"}
        </button>

        <div className="flex items-center gap-3">
          <label className="font-medium">Volume:</label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className="w-40 accent-green-500"
          />
        </div>
      </div>

      <h2 className="text-2xl font-semibold mb-4">📉 To long</h2>
      <div className="overflow-x-auto rounded-lg shadow-lg mb-8">
        {isLoadingData ? (
          <div className="text-center py-12 text-gray-400">
            <div className="animate-spin border-4 border-t-4 border-gray-500 rounded-full w-12 h-12 mx-auto mb-4"></div>
            <p>Loading data...</p>
          </div>
        ) : filteredAsks.length === 0 ? (
          <div className="text-center py-12 text-gray-400">No high order yet</div>
        ) : (
          <table className="w-full border-collapse bg-gray-800">
            <thead className="bg-gray-700 text-gray-300">
              <tr>
                <th className="p-3 text-left">Coin</th>
                <th className="p-3 text-left">Price</th>
                <th className="p-3 text-left">Total</th>
                <th className="p-3 text-left">To price</th>
                <th className="p-3 text-left">Time spoted</th>
              </tr>
            </thead>
            <tbody>
              {filteredAsks.map((coin, index) => {
                const currentPrice = getCurrentPrice(coin.symbol);
                const percentage = calculateDistancePercentage(coin.pret, currentPrice).toFixed(2);
                const style = checkAndPlaySound(percentage, coin.sumaTotala);
                return (
                  <tr key={`${coin.symbol}-${coin.pret}-${coin.sumaTotala}-${index}`} className="border-b border-gray-700 hover:bg-gray-700/50 transition">
                    <td className="p-3">{coin.symbol}</td>
                    <td className="p-3">{coin.pret}</td>
                    <td className="p-3">{Math.floor(coin.sumaTotala) + "$"}</td>
                    <td className="p-3 font-bold" style={style}>{percentage}%</td>
                    <td className="p-3 text-sm text-gray-400">{formatDuration(coin.timestamp)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <h2 className="text-2xl font-semibold mb-4">📈 To short</h2>
      <div className="overflow-x-auto rounded-lg shadow-lg">
        {isLoadingData ? (
          <div className="text-center py-12 text-gray-400">
            <div className="animate-spin border-4 border-t-4 border-gray-500 rounded-full w-12 h-12 mx-auto mb-4"></div>
            <p>Loading data...</p>
          </div>
        ) : filteredBids.length === 0 ? (
          <div className="text-center py-12 text-gray-400">No high order yet</div>
        ) : (
          <table className="w-full border-collapse bg-gray-800">
            <thead className="bg-gray-700 text-gray-300">
              <tr>
                <th className="p-3 text-left">Coin</th>
                <th className="p-3 text-left">Price</th>
                <th className="p-3 text-left">Total</th>
                <th className="p-3 text-left">To price</th>
                <th className="p-3 text-left">Time spoted</th>
              </tr>
            </thead>
            <tbody>
              {filteredBids.map((coin, index) => {
                const currentPrice = getCurrentPrice(coin.symbol);
                const percentage = calculateDistancePercentage(coin.pret, currentPrice).toFixed(2);
                const style = checkAndPlaySound(percentage, coin.sumaTotala);
                return (
                  <tr key={`${coin.symbol}-${coin.pret}-${coin.sumaTotala}-${index}`} className="border-b border-gray-700 hover:bg-gray-700/50 transition">
                    <td className="p-3">{coin.symbol}</td>
                    <td className="p-3">{coin.pret}</td>
                    <td className="p-3">{Math.floor(coin.sumaTotala) + "$"}</td>
                    <td className="p-3 font-bold" style={style}>{percentage}%</td>
                    <td className="p-3 text-sm text-gray-400">{formatDuration(coin.timestamp)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default SpotPage;