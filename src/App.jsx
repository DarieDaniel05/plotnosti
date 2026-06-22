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
          element={<Coins onSelectSymbol={setSelectedSymbol} />}
        />
        <Route path="/plotnosti" element={<FuturesPage />} />
        <Route path="/dailyHighMove" element={<DailyHighMovePage />} />
        <Route path="/highVolumeBar" element={<HighVolumeBar />} />
      </Routes>

      <TradingViewChart
        symbol={selectedSymbol}
        onClose={() => setSelectedSymbol(null)}
      />
    </>
  );
}

export default App;
