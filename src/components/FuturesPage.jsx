import React, { useEffect, useState, useMemo, useCallback } from "react";
import axios from "axios";
import alertSound from "./mixkit-software-interface-start-2574.wav"; // Importă fișierul audio
function SpotPage() {
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [data, setData] = useState([]);
  const [filteredDataAsks, setFilteredDataAsks] = useState([]);
  const [filteredDataBids, setFilteredDataBids] = useState([]);
  const [soundPlayed, setSoundPlayed] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [volume, setVolume] = useState(0.01);

  function MoneziVanzare(symbol, pret, sumaTotala) {
    this.symbol = symbol;
    this.pret = pret;
    this.sumaTotala = sumaTotala;
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
    } catch (error) {
      console.log(error);
    }
  };

  useEffect(() => {
    fetchMonezi();
  }, []);

  const fetchData = useCallback(async (symbol, type) => {
    try {
      const response = await axios.get(
        "https://fapi.binance.com/fapi/v1/depth",
        { params: { symbol } }
      );

      const relevantData = response.data[type]
        .map(([price, qty]) => {
          const sum = price * qty;
          if (sum >= 400000) {
            return new MoneziVanzare(symbol, price, sum);
          }
          return null;
        })
        .filter(Boolean);

      return relevantData;
    } catch (error) {
      console.error("Error fetching depth data", error);
      return [];
    }
  }, []);

  useEffect(() => {
  const processFilteredData = async () => {
    setIsLoadingData(true); // start loading
    if (data.length === 0) {
      setFilteredDataAsks([]);
      setFilteredDataBids([]);
      setIsLoadingData(false);
      return;
    }

    const filtered = data.filter(
      (moneda) =>
        ![
          "BTCUSDT","ETHUSDT","SOLUSDT","DOGEUSDT","BTCUSDC",
          "XRPUSDT","ETHUSDC","SOLUSDC","DOGEUSDC","XRPUSDC",
          "AVAXUSDT","BTCUSDT_250328","BNBUSDT","CRVUSDT",
          "EOSUSDT","LINKUSDT","LTCUSDT","SUIUSDT","ADAUSDT","ADAUSDC","TRUMPUSDT","WIFUSDT"
        ].includes(moneda.symbol) && moneda.quoteVolume >= 50000000
    );

    const resultsAsks = await Promise.all(
      filtered.map((moneda) => fetchData(moneda.symbol, "asks"))
    );
    const resultsBids = await Promise.all(
      filtered.map((moneda) => fetchData(moneda.symbol, "bids"))
    );

    const flattenedAsks = resultsAsks.flat();
    const flattenedBids = resultsBids.flat();

    const sortedAsks = flattenedAsks.sort(
      (a, b) => b.sumaTotala - a.sumaTotala
    );
    const sortedBids = flattenedBids.sort(
      (a, b) => b.sumaTotala - a.sumaTotala
    );

    setFilteredDataAsks(sortedAsks);
    setFilteredDataBids(sortedBids);
    setIsLoadingData(false); // finish loading
  };

  processFilteredData();
}, [data, fetchData]);

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

  useEffect(() => {
    const intervalId = setInterval(() => {
      fetchMonezi();
    }, 30000);

    return () => clearInterval(intervalId);
  }, [fetchMonezi]);

  const filteredAsks = useMemo(() => {
    return filteredDataAsks.filter((coin) => {
      const currentPrice = getCurrentPrice(coin.symbol);
      return filterByPercentage(coin.pret, currentPrice);
    });
  }, [filteredDataAsks, getCurrentPrice]);

  const filteredBids = useMemo(() => {
    return filteredDataBids.filter((coin) => {
      const currentPrice = getCurrentPrice(coin.symbol);
      return filterByPercentage(coin.pret, currentPrice);
    });
  }, [filteredDataBids, getCurrentPrice]);

  return (
    <div className="min-h-screen bg-gray-900 text-gray-200 p-6">
      <h1 className="text-3xl font-bold mb-6 text-center">📊 Spot Monitor</h1>

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
        </tr>
      </thead>
      <tbody>
        {filteredAsks.map((coin, index) => {
          const currentPrice = getCurrentPrice(coin.symbol);
          const percentage = calculateDistancePercentage(coin.pret, currentPrice).toFixed(2);
          const style = checkAndPlaySound(percentage, coin.sumaTotala);
          return (
            <tr key={index} className="border-b border-gray-700 hover:bg-gray-700/50 transition">
              <td className="p-3">{coin.symbol}</td>
              <td className="p-3">{coin.pret}</td>
              <td className="p-3">{Math.floor(coin.sumaTotala) + "$"}</td>
              <td className="p-3 font-bold" style={style}>{percentage}%</td>
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
        </tr>
      </thead>
      <tbody>
        {filteredBids.map((coin, index) => {
          const currentPrice = getCurrentPrice(coin.symbol);
          const percentage = calculateDistancePercentage(coin.pret, currentPrice).toFixed(2);
          const style = checkAndPlaySound(percentage, coin.sumaTotala);
          return (
            <tr key={index} className="border-b border-gray-700 hover:bg-gray-700/50 transition">
              <td className="p-3">{coin.symbol}</td>
              <td className="p-3">{coin.pret}</td>
              <td className="p-3">{Math.floor(coin.sumaTotala) + "$"}</td>
              <td className="p-3 font-bold" style={style}>{percentage}%</td>
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
