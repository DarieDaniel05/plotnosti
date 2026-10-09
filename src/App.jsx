import React, { useState } from "react";
import FuturesPage from "./components/FuturesPage";
import { Route, Routes } from "react-router-dom";
import Coins from "./components/Coins";
import Navbar from "./components/Navbar";
import TradingViewChart from "./components/TradingViewChart";
import DailyHighMovePage from "./components/DailyHighMovePage";
import HighVolumeBar from "./components/HighVolumeBar";

function App() {
  const [selectedSymbol, setSelectedSymbol] = useState(null);

  return (
    <>
      <Navbar />
      <Routes>
        <Route
          path="/"
          element={<HighVolumeBar />}
        />
        <Route path="/plotnosti" element={<FuturesPage />} />
        <Route path="/dailyHighMove" element={<DailyHighMovePage symbol="BTCUSDT" onClose={() => setSelectedSymbol(null)} />} />
        <Route path="/coins" element={<Coins onSelectSymbol={setSelectedSymbol} />} />
      </Routes>

      <TradingViewChart
        symbol={selectedSymbol}
        onClose={() => setSelectedSymbol(null)}
      />
    </>
  );
}

export default App;
