import React, { useState, useEffect, useRef } from 'react';
import { TrendingUp, TrendingDown, RefreshCw, Activity, Filter, AlertTriangle, Wifi, WifiOff, X, BarChart3 } from 'lucide-react';
import './coins.css';
const Coins = ({ onSelectSymbol }) => {
  const [coins, setCoins] = useState([]);
  const [filteredCoins, setFilteredCoins] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [natrThreshold, setNatrThreshold] = useState(0);
  const [sortBy, setSortBy] = useState('natr');
  const [sortOrder, setSortOrder] = useState('desc');
  const [lastUpdate, setLastUpdate] = useState('');
  const [totalSymbols, setTotalSymbols] = useState(0);
  const [connectedStreams, setConnectedStreams] = useState(0);
  const [error, setError] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef(null);
  const klineData = useRef(new Map()); // Store kline data for each symbol
  const priceData = useRef(new Map()); // Store current price data
  const reconnectTimeoutRef = useRef(null);
  
  // Calculate True Range
  const calculateTR = (high, low, prevClose) => {
    if (!prevClose && prevClose !== 0) return high - low;
    
    const tr1 = high - low;
    const tr2 = Math.abs(high - prevClose);
    const tr3 = Math.abs(low - prevClose);
    
    return Math.max(tr1, tr2, tr3);
  };
  
  // Calculate NATR (Normalized Average True Range)
  const calculateNATR = (klines, period = 14) => {
    if (!klines || klines.length < period + 1) return 0;
    
    let trSum = 0;
    for (let i = klines.length - period; i < klines.length; i++) {
      if (i <= 0) continue;
      
      const current = klines[i];
      const prev = klines[i - 1];
      
      if (current && prev) {
        const tr = calculateTR(current.high, current.low, prev.close);
        trSum += tr;
      }
    }
    
    const atr = trSum / (period - 1);
    const currentClose = klines[klines.length - 1]?.close || 0;
    
    return currentClose > 0 ? (atr / currentClose) * 100 : 0;
  };
  
  // Get all futures trading symbols
  const getAllFuturesSymbols = async () => {
    try {
      const response = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
      const data = await response.json();
      
      // Filter for active USDT perpetual futures, limit to top volume ones
      const activeSymbols = data.symbols
      .filter(symbol =>
        symbol.status === 'TRADING' &&
        symbol.contractType === 'PERPETUAL' &&
        symbol.symbol.endsWith('USDT')
      )
      .map(symbol => symbol.symbol);
      
      // Get 24h ticker data to sort by volume and take top 100
      const tickerResponse = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
      const tickerData = await tickerResponse.json();
      
      const symbolsWithVolume = activeSymbols
      .map(symbol => {
        const ticker = tickerData.find(t => t.symbol === symbol);
        return {
          symbol,
          volume: ticker ? parseFloat(ticker.quoteVolume) : 0
        };
      })
      .sort((a, b) => b.volume - a.volume)
      .filter(e => e.volume > 70_000_000) // Filter high volume symbols
      .map(item => item.symbol);
      
      console.log(`Selected top ${symbolsWithVolume.length} symbols by volume`);
      setTotalSymbols(symbolsWithVolume.length);
      return symbolsWithVolume;
    } catch (error) {
      console.error('Error fetching futures symbols:', error);
      setError('Failed to fetch futures symbols');
      return [];
    }
  };
  
  // Get initial kline data for NATR calculation (1-minute intervals)
  const getInitialKlineData = async (symbols) => {
    const klinePromises = symbols.map(async (symbol) => {
      try {
        // Fetch 1-minute klines with more data points for better NATR calculation
        const response = await fetch(
          `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=100`
        );
        
        if (!response.ok) return null;
        
        const data = await response.json();
        const klines = data.map(kline => ({
          timestamp: kline[0],
          open: parseFloat(kline[1]),
          high: parseFloat(kline[2]),
          low: parseFloat(kline[3]),
          close: parseFloat(kline[4]),
          volume: parseFloat(kline[5])
        }));
        
        klineData.current.set(symbol, klines);
        return { symbol, klines };
      } catch (error) {
        console.error(`Error fetching kline data for ${symbol}:`, error);
        return null;
      }
    });
    
    await Promise.all(klinePromises);
  };
  
  // Get 24h ticker data
  const get24hTickers = async (symbols) => {
    try {
      const response = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
      const data = await response.json();
      
      return data.filter(ticker => symbols.includes(ticker.symbol));
    } catch (error) {
      console.error('Error fetching 24h tickers:', error);
      return [];
    }
  };
  
  // Connect to WebSocket for live updates (1-minute klines)
  const connectWebSocket = (symbols) => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    
    try {
      // Create combined stream for 1-minute klines and tickers
      const klineStreams = symbols.map(symbol => `${symbol.toLowerCase()}@kline_1m`);
      const tickerStreams = symbols.map(symbol => `${symbol.toLowerCase()}@ticker`);
      const allStreams = [...klineStreams, ...tickerStreams];
      
      // Binance allows max 1024 streams per connection, we're well under that
      const streamUrl = `wss://fstream.binance.com/stream?streams=${allStreams.join('/')}`;
      
      const ws = new WebSocket(streamUrl);
      
      ws.onopen = () => {
        console.log('Connected to Binance WebSocket (1-minute real-time)');
        setIsConnected(true);
        setConnectedStreams(allStreams.length);
      };
      
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          const { stream, data } = message;
          
          if (stream.includes('@kline_1m')) {
            // Handle 1-minute kline updates
            const symbol = data.s;
            const kline = data.k;
            
            const newKline = {
              timestamp: kline.t,
              open: parseFloat(kline.o),
              high: parseFloat(kline.h),
              low: parseFloat(kline.l),
              close: parseFloat(kline.c),
              volume: parseFloat(kline.v)
            };
            
            // Update kline data
            const existingKlines = klineData.current.get(symbol) || [];
            let updatedKlines;
            
            if (kline.x) { // Kline is closed (1-minute completed)
              updatedKlines = [...existingKlines, newKline].slice(-100); // Keep last 100 for better NATR
            } else {
              // Update the last kline if it's the same timestamp, otherwise add new one
              if (existingKlines.length > 0 && existingKlines[existingKlines.length - 1].timestamp === newKline.timestamp) {
                updatedKlines = [...existingKlines.slice(0, -1), newKline];
              } else {
                updatedKlines = [...existingKlines, newKline];
              }
            }
            
            klineData.current.set(symbol, updatedKlines);
            
          } else if (stream.includes('@ticker')) {
            // Handle 24h ticker updates
            const symbol = data.s;
            priceData.current.set(symbol, {
              price: parseFloat(data.c),
              priceChange: parseFloat(data.P),
              volume: parseFloat(data.q),
              trades: parseInt(data.n)
            });
          }
          
          // Update coins data more frequently for 1-minute real-time updates
          if (!updateCoinsTimeout.current) {
            updateCoinsTimeout.current = setTimeout(updateCoinsData, 1000); // Update every second
          }
          
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };
      
      ws.onclose = (event) => {
        console.log('WebSocket connection closed:', event.code);
        setIsConnected(false);
        setConnectedStreams(0);
        
        // Attempt to reconnect after 5 seconds
        if (!event.wasClean) {
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log('Attempting to reconnect...');
            connectWebSocket(symbols);
          }, 5000);
        }
      };
      
      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setIsConnected(false);
        setConnectedStreams(0);
      };
      
      wsRef.current = ws;
    } catch (error) {
      console.error('Failed to connect to WebSocket:', error);
      setError('Failed to connect to live data stream');
    }
  };
  
  const updateCoinsTimeout = useRef(null);
  
  const TradingViewChart = React.memo(({ symbol }) => {
    if (!symbol) return (
      <div className="mt-6 text-gray-400 text-center">
        Selectează un simbol din listă pentru a vedea graficul 📊
      </div>
    );
    
    // Use 1-minute chart to match the real-time data
    const tradingViewUrl = `https://www.tradingview.com/widgetembed/?frameElementId=tradingview_chart&symbol=BINANCE%3A${symbol}&interval=1&theme=dark&style=1`;
    
    return (
      <div className="mt-6 bg-gray-900 rounded-xl shadow-lg p-4">
        <h2 className="text-lg font-semibold text-gray-200 mb-3">
          Chart pentru {symbol} (1-minute real-time)
        </h2>
        <iframe
          key={symbol}
          src={tradingViewUrl}
          className="w-full h-[500px] border-0 rounded-lg"
          allowTransparency={true}
          allowFullScreen
        />
      </div>
    );
  });
  
  // Update coins data from live streams
  const updateCoinsData = () => {
    updateCoinsTimeout.current = null;
    
    const updatedCoins = [];
    
    for (const [symbol, klines] of klineData.current.entries()) {
      const tickerInfo = priceData.current.get(symbol);
      
      if (klines && klines.length > 0) {
        const natr = calculateNATR(klines);
        
        updatedCoins.push({
          symbol,
          natr,
          price: tickerInfo?.price || klines[klines.length - 1]?.close || 0,
          priceChangePercent: tickerInfo?.priceChange || 0,
          volume: tickerInfo?.volume || 0,
          trades: tickerInfo?.trades || 0,
          lastUpdate: new Date().toLocaleTimeString()
        });
      }
    }
    
    setCoins(updatedCoins);
    setLastUpdate(new Date().toLocaleTimeString());
  };
  
  // Load all data and start live updates
  const loadData = async () => {
    setIsLoading(true);
    setError('');
    
    try {
      console.log('Fetching futures symbols...');
      const symbols = await getAllFuturesSymbols();
      
      if (symbols.length === 0) {
        setError('No futures symbols found');
        setIsLoading(false);
        return;
      }
      
      console.log('Getting initial 1-minute kline data...');
      await getInitialKlineData(symbols);
      
      console.log('Getting 24h ticker data...');
      const tickers = await get24hTickers(symbols);
      
      // Initialize price data
      tickers.forEach(ticker => {
        priceData.current.set(ticker.symbol, {
          price: parseFloat(ticker.lastPrice),
          priceChange: parseFloat(ticker.priceChangePercent),
          volume: parseFloat(ticker.quoteVolume),
          trades: parseInt(ticker.count)
        });
      });
      
      // Calculate initial NATR values
      updateCoinsData();
      
      console.log('Connecting to 1-minute live WebSocket...');
      connectWebSocket(symbols);
      
    } catch (error) {
      console.error('Error loading data:', error);
      setError('Failed to load data: ' + error.message);
    } finally {
      setIsLoading(false);
    }
  };
  
  // Filter and sort coins
  useEffect(() => {
    let filtered = coins.filter(coin => coin.natr >= natrThreshold);
    
    filtered.sort((a, b) => {
      const aVal = a[sortBy] || 0;
      const bVal = b[sortBy] || 0;
      
      if (sortOrder === 'desc') {
        return bVal - aVal;
      } else {
        return aVal - bVal;
      }
    });
    
    setFilteredCoins(filtered);
  }, [coins, natrThreshold, sortBy, sortOrder]);
  
  // Initial load
  useEffect(() => {
    loadData();
    
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (updateCoinsTimeout.current) {
        clearTimeout(updateCoinsTimeout.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);
  
  const formatNumber = (num, decimals = 2) => {
    if (num >= 1e9) {
      return (num / 1e9).toFixed(decimals) + 'B';
    } else if (num >= 1e6) {
      return (num / 1e6).toFixed(decimals) + 'M';
    } else if (num >= 1e3) {
      return (num / 1e3).toFixed(decimals) + 'K';
    }
    return num.toFixed(decimals);
  };
  
  const formatPrice = (price) => {
    if (price >= 1) {
      return price.toFixed(4);
    } else if (price >= 0.001) {
      return price.toFixed(6);
    } else {
      return price.toFixed(8);
    }
  };
  
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="animate-spin h-12 w-12 mx-auto mb-4 text-blue-400" />
          <p className="text-xl mb-2">Loading</p>
        </div>
      </div>
    );
  }
  
  if (error) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center">
          <AlertTriangle className="h-12 w-12 mx-auto mb-4 text-red-400" />
          <p className="text-xl mb-4 text-red-400">Error</p>
          <p className="text-gray-400 mb-4">{error}</p>
          <button
            onClick={loadData}
            className="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded-lg"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      {/* Header */}
      <div className="bg-gray-800 rounded-lg p-6 mb-6 border border-gray-700">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-4">
            <h1 className="text-3xl font-bold text-blue-400">Futures Scanner</h1>
            <span className="text-sm text-gray-400 bg-gray-700 px-2 py-1 rounded">
              1-minute NATR
            </span>
          </div>
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              {isConnected ? (
                <Wifi className="h-5 w-5 text-green-400" />
              ) : (
                <WifiOff className="h-5 w-5 text-red-400" />
              )}
              <span className="text-sm">
                {isConnected ? `${connectedStreams} streams (1m)` : 'Disconnected'}
              </span>
            </div>
            <button
              onClick={loadData}
              disabled={isLoading}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 px-4 py-2 rounded-lg flex items-center space-x-2"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              <span>Restart</span>
            </button>
          </div>
        </div>
        
        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
          <div className="bg-gray-700 p-4 rounded-lg">
            <p className="text-gray-400 text-sm mb-1">Symbols Monitored</p>
            <p className="text-2xl font-bold">{totalSymbols}</p>
          </div>
          
          <div className="bg-gray-700 p-4 rounded-lg">
            <p className="text-gray-400 text-sm mb-1">High NATR Coins</p>
            <p className="text-2xl font-bold text-green-400">{filteredCoins.length}</p>
          </div>
          
          <div className="bg-gray-700 p-4 rounded-lg">
            <p className="text-gray-400 text-sm mb-1">NATR Threshold</p>
            <div className="flex items-center space-x-2">
              <input
                value={natrThreshold}
                onChange={(e) => setNatrThreshold(parseFloat(e.target.value) || 0)}
                min="0"
                className="bg-gray-600 text-white px-2 py-1 rounded w-20 text-sm"
              />
              <span className="text-sm">%</span>
            </div>
          </div>
          
          <div className="bg-gray-700 p-4 rounded-lg">
            <p className="text-gray-400 text-sm mb-1">Last Update</p>
            <div className="flex items-center space-x-2">
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`}></div>
              <p className="text-sm font-mono">{lastUpdate}</p>
            </div>
          </div>
        </div>
        
        {/* Controls */}
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2">
            <Filter className="h-4 w-4" />
            <span className="text-sm">Sort by:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="bg-gray-700 text-white px-3 py-1 rounded text-sm"
            >
              <option value="natr">NATR</option>
              <option value="priceChangePercent">24h Change</option>
              <option value="volume">Volume</option>
              <option value="price">Price</option>
            </select>
            <button
              onClick={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')}
              className="bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded text-sm"
            >
              {sortOrder === 'desc' ? '↓' : '↑'}
            </button>
          </div>
        </div>
      </div>
      
      {/* Results Table */}
      <div className="bg-gray-800 rounded-lg border border-gray-700">
        <div className="p-4 border-b border-gray-700">
          <h2 className="text-xl font-semibold flex items-center space-x-2">
            <Activity className="h-5 w-5" />
            <span>Coin (NATR {natrThreshold}%)</span>
          </h2>
        </div>
        
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-700">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Symbol</th>
              <th className="px-4 py-3 text-right text-sm font-medium text-gray-300">NATR %</th>
              <th className="px-4 py-3 text-right text-sm font-medium text-gray-300">24h Change</th>
              <th className="px-4 py-3 text-right text-sm font-medium text-gray-300">Volume</th>
              <th className="px-4 py-3 text-right text-sm font-medium text-gray-300">Trades</th>
              <th className="px-4 py-3 text-center text-sm font-medium text-gray-300">Status</th>
            </tr>
            </thead>
            <tbody>
            {filteredCoins.map((coin, index) => {
              const isPositive = coin.priceChangePercent >= 0;
              return (
                <tr key={coin.symbol} className="border-b border-gray-700 hover:bg-gray-750 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => onSelectSymbol(coin.symbol)}
                        className="font-mono font-bold text-yellow-400 hover:text-yellow-300 cursor-pointer flex items-center space-x-1 group bg-transparent border-0 p-0"
                      >
                        <span>{coin.symbol}</span>
                        <BarChart3 className="h-4 w-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                      <span className="font-mono font-bold text-purple-400">
                        {coin.natr.toFixed(2)}%
                      </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end space-x-1">
                      {isPositive ? (
                        <TrendingUp className="h-4 w-4 text-green-400" />
                      ) : (
                        <TrendingDown className="h-4 w-4 text-red-400" />
                      )}
                      <span className={`font-mono ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
                          {coin.priceChangePercent.toFixed(2)}%
                        </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-400">
                    {formatNumber(coin.volume)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-400">
                    {formatNumber(coin.trades, 0)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center space-x-1">
                      <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                      <span className="text-xs text-green-400">LIVE</span>
                    </div>
                  </td>
                </tr>
              );
            })}
            </tbody>
          </table>
          
          {filteredCoins.length === 0 && !isLoading && (
            <div className="text-center py-12 text-gray-400">
              <Activity className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg">No coins found with NATR ≥ {natrThreshold}%</p>
              <p className="text-sm">
                {isConnected ? 'Coins' : 'Waiting for connection...'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Coins;