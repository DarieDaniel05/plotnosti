import React, { useEffect, useState, useMemo, useCallback, useRef } from "react";
import axios from "axios";
import alertSound from "./mixkit-software-interface-start-2574.wav";

function SpotPage() {
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [data, setData] = useState([]);
  const [orderBookData, setOrderBookData] = useState({}); // Store order book data by symbol
  const [filteredDataAsks, setFilteredDataAsks] = useState([]);
  const [filteredDataBids, setFilteredDataBids] = useState([]);
  const [soundPlayed, setSoundPlayed] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [volume, setVolume] = useState(0.01);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [timeUpdateTrigger, setTimeUpdateTrigger] = useState(0); // Force re-render for time updates
  
  const wsConnections = useRef(new Map()); // Store WebSocket connections
  const activeSymbols = useRef(new Set()); // Track active symbols
  const orderTimestamps = useRef(new Map()); // Track when each large order first appeared

  

  function MoneziVanzare(symbol, pret, sumaTotala, timestamp = null) {
    this.symbol = symbol;
    this.pret = pret;
    this.sumaTotala = sumaTotala;
    this.timestamp = timestamp || Date.now();
  }

  const getCurrentPrice = useCallback(
    (symbol) => {
      const coinData = data.find((coin) => coin.symbol === symbol);
      return coinData ? parseFloat(coinData.lastPrice) : null;
    },
    [data]
  );

  const fetchMonezi = async () => {
    try {
      const response = await axios.get(
        "https://fapi.binance.com/fapi/v1/ticker/24hr"
      );
      setData(response.data);
      return response.data;
    } catch (error) {
      console.log(error);
      return [];
    }
  };

  // Initial order book fetch for a symbol
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

  // Create WebSocket connection for a symbol
  const createWebSocketConnection = useCallback((symbol) => {
    if (wsConnections.current.has(symbol)) {
      return; // Connection already exists
    }

    const wsUrl = `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@depth`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`WebSocket connected for ${symbol}`);
      setConnectionStatus(prev => prev === 'disconnected' ? 'connecting' : prev);
    };

    ws.onmessage = (event) => {
      try {
        const depthData = JSON.parse(event.data);
        
        setOrderBookData(prev => {
          const currentData = prev[symbol];
          if (!currentData) return prev;

          // Update the order book with new data
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
        console.error(`Error parsing WebSocket message for ${symbol}:`, error);
      }
    };

    ws.onerror = (error) => {
      console.error(`WebSocket error for ${symbol}:`, error);
      setConnectionStatus('error');
    };

    ws.onclose = () => {
      console.log(`WebSocket closed for ${symbol}`);
      wsConnections.current.delete(symbol);
      
      // Attempt to reconnect after 5 seconds
      setTimeout(() => {
        if (activeSymbols.current.has(symbol)) {
          createWebSocketConnection(symbol);
        }
      }, 5000);
    };

    wsConnections.current.set(symbol, ws);
  }, []);

  // Close WebSocket connection for a symbol
  const closeWebSocketConnection = useCallback((symbol) => {
    const ws = wsConnections.current.get(symbol);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    wsConnections.current.delete(symbol);
    activeSymbols.current.delete(symbol);
  }, []);

  // Process order book data to find large orders
  const processOrderBookData = useCallback((symbol, orderBook) => {
    if (!orderBook || !orderBook.bids || !orderBook.asks) return { asks: [], bids: [] };

    const processOrders = (orders, type) => {
      return orders
        .map(([price, qty]) => {
          const priceNum = parseFloat(price);
          const qtyNum = parseFloat(qty);
          const sum = priceNum * qtyNum;
          
          if (sum >= 400000) {
            // Create unique key for this order
            const orderKey = `${symbol}-${type}-${priceNum}-${Math.floor(sum)}`;
            
            // Check if this order already exists, if not, record timestamp
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
  }, []);

  // Update filtered data when order book changes
  useEffect(() => {
    if (data.length === 0) {
      setFilteredDataAsks([]);
      setFilteredDataBids([]);
      setIsLoadingData(false);
      return;
    }

    const processFilteredData = async () => {
      // Filter symbols based on criteria
      const filtered = data.filter(
        (moneda) =>
          ![
            "BTCUSDT","ETHUSDT","SOLUSDT","DOGEUSDT","BTCUSDC",
            "XRPUSDT","ETHUSDC","SOLUSDC","DOGEUSDC","XRPUSDC",
            "AVAXUSDT","BTCUSDT_250328","BNBUSDT","CRVUSDT",
            "EOSUSDT","LINKUSDT","LTCUSDT","SUIUSDT","ADAUSDT",
            "ADAUSDC","TRUMPUSDT","WIFUSDT"
          ].includes(moneda.symbol) && moneda.quoteVolume >= 50000000
      );

      // Update active symbols
      const newActiveSymbols = new Set(filtered.map(m => m.symbol));
      
      // Close connections for symbols no longer needed
      activeSymbols.current.forEach(symbol => {
        if (!newActiveSymbols.has(symbol)) {
          closeWebSocketConnection(symbol);
        }
      });

      // Create connections for new symbols
      for (const moneda of filtered) {
        const symbol = moneda.symbol;
        activeSymbols.current.add(symbol);
        
        if (!wsConnections.current.has(symbol)) {
          // Fetch initial order book data
          await fetchInitialOrderBook(symbol);
          // Create WebSocket connection
          createWebSocketConnection(symbol);
        }
      }

      setIsLoadingData(false);
    };

    processFilteredData();
  }, [data, createWebSocketConnection, closeWebSocketConnection]);

  // Process order book data when it changes
  useEffect(() => {
    const allAsks = [];
    const allBids = [];
    const currentOrderKeys = new Set();

    Object.entries(orderBookData).forEach(([symbol, orderBook]) => {
      const processed = processOrderBookData(symbol, orderBook);
      allAsks.push(...processed.asks);
      allBids.push(...processed.bids);
      
      // Track current order keys for cleanup
      [...processed.asks, ...processed.bids].forEach(order => {
        const orderKey = `${symbol}-${order.pret > getCurrentPrice(symbol) ? 'ask' : 'bid'}-${order.pret}-${Math.floor(order.sumaTotala)}`;
        currentOrderKeys.add(orderKey);
      });
    });

    // Cleanup old timestamps for orders that no longer exist
    const keysToDelete = [];
    orderTimestamps.current.forEach((timestamp, key) => {
      if (!currentOrderKeys.has(key)) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach(key => orderTimestamps.current.delete(key));

    // Sort by total sum
    const sortedAsks = allAsks.sort((a, b) => b.sumaTotala - a.sumaTotala);
    const sortedBids = allBids.sort((a, b) => b.sumaTotala - a.sumaTotala);

    setFilteredDataAsks(sortedAsks);
    setFilteredDataBids(sortedBids);
  }, [orderBookData, processOrderBookData, getCurrentPrice]);

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
    return percentage <= 3 && percentage >= -3;
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

  // Refresh ticker data periodically
  useEffect(() => {
    const intervalId = setInterval(() => {
      fetchMonezi();
    }, 30000);

    return () => clearInterval(intervalId);
  }, []);

  // Update time display every 10 seconds
  useEffect(() => {
    const timeUpdateInterval = setInterval(() => {
      setTimeUpdateTrigger(prev => prev + 1);
    }, 10000);

    return () => clearInterval(timeUpdateInterval);
  }, []);

  // Cleanup WebSocket connections on unmount
  useEffect(() => {
    return () => {
      wsConnections.current.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      });
      wsConnections.current.clear();
      activeSymbols.current.clear();
      orderTimestamps.current.clear();
    };
  }, []);

  // Helper function to format time duration
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

  const filteredAsks = useMemo(() => {
    return filteredDataAsks.filter((coin) => {
      const currentPrice = getCurrentPrice(coin.symbol);
      const withinPercentage = filterByPercentage(coin.pret, currentPrice);
      
      // Check if order is older than 3 minutes (180,000 ms)
      const now = Date.now();
      const isOlderThan3Min = (now - coin.timestamp) > 180000;
      
      return withinPercentage && isOlderThan3Min;
    });
  }, [filteredDataAsks, getCurrentPrice, timeUpdateTrigger]);

  const filteredBids = useMemo(() => {
    return filteredDataBids.filter((coin) => {
      const currentPrice = getCurrentPrice(coin.symbol);
      const withinPercentage = filterByPercentage(coin.pret, currentPrice);
      
      // Check if order is older than 3 minutes (180,000 ms)
      const now = Date.now();
      const isOlderThan3Min = (now - coin.timestamp) > 180000;
      
      return withinPercentage && isOlderThan3Min;
    });
  }, [filteredDataBids, getCurrentPrice, timeUpdateTrigger]);

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

      {/* Controls */}
      <div className="flex flex-col md:flex-row items-center justify-center gap-6 mb-8">
        <button
          onClick={() => setSoundEnabled(!soundEnabled)}
          className={`px-6 py-2 rounded-lg font-semibold shadow-md transition ${
            soundEnabled
              ? "bg-green-600 hover:bg-green-700"
              : "bg-red-600 hover:bg-red-700"
          }`}
        >
          {soundEnabled ? "🔊 Dezactivează Sunetul" : "🔇 Activează Sunetul"}
        </button>

        <div className="flex items-center gap-3">
          <label className="font-medium">Volum:</label>
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

      {/* Short table */}
      <h2 className="text-2xl font-semibold mb-4">📉 In Short</h2>
      <div className="overflow-x-auto rounded-lg shadow-lg mb-8">
        {isLoadingData ? (
          <div className="text-center py-12 text-gray-400">
            <div className="animate-spin border-4 border-t-4 border-gray-500 rounded-full w-12 h-12 mx-auto mb-4"></div>
            <p>Loading data...</p>
          </div>
        ) : filteredAsks.length === 0 ? (
          <div className="text-center py-12 text-gray-400">Nici o plotnoste</div>
        ) : (
          <table className="w-full border-collapse bg-gray-800">
            <thead className="bg-gray-700 text-gray-300">
              <tr>
                <th className="p-3 text-left">Moneda</th>
                <th className="p-3 text-left">Prețul</th>
                <th className="p-3 text-left">Suma totală</th>
                <th className="p-3 text-left">Distanță până preț</th>
                <th className="p-3 text-left">Timp existență</th>
              </tr>
            </thead>
            <tbody>
              {filteredAsks.map((coin, index) => {
                const currentPrice = getCurrentPrice(coin.symbol);
                const percentage = calculateDistancePercentage(coin.pret, currentPrice).toFixed(2);
                const style = checkAndPlaySound(percentage, coin.sumaTotala);
                return (
                  <tr key={`${coin.symbol}-${coin.pret}-${index}`} className="border-b border-gray-700 hover:bg-gray-700/50 transition">
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

      {/* Long table */}
      <h2 className="text-2xl font-semibold mb-4">📈 In Long</h2>
      <div className="overflow-x-auto rounded-lg shadow-lg">
        {isLoadingData ? (
          <div className="text-center py-12 text-gray-400">
            <div className="animate-spin border-4 border-t-4 border-gray-500 rounded-full w-12 h-12 mx-auto mb-4"></div>
            <p>Loading data...</p>
          </div>
        ) : filteredBids.length === 0 ? (
          <div className="text-center py-12 text-gray-400">Nici o plotnoste</div>
        ) : (
          <table className="w-full border-collapse bg-gray-800">
            <thead className="bg-gray-700 text-gray-300">
              <tr>
                <th className="p-3 text-left">Moneda</th>
                <th className="p-3 text-left">Prețul</th>
                <th className="p-3 text-left">Suma totală</th>
                <th className="p-3 text-left">Distanță până preț</th>
                <th className="p-3 text-left">Timp existență</th>
              </tr>
            </thead>
            <tbody>
              {filteredBids.map((coin, index) => {
                const currentPrice = getCurrentPrice(coin.symbol);
                const percentage = calculateDistancePercentage(coin.pret, currentPrice).toFixed(2);
                const style = checkAndPlaySound(percentage, coin.sumaTotala);
                return (
                  <tr key={`${coin.symbol}-${coin.pret}-${index}`} className="border-b border-gray-700 hover:bg-gray-700/50 transition">
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