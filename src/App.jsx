import React, { useState } from "react";
import FuturesPage from "./components/FuturesPage";
import { Route, Routes } from "react-router-dom";
import Coins from "./components/Coins";
import Navbar from "./components/Navbar";
import TradingViewChart from "./components/TradingViewChart";

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
      </Routes>

      <TradingViewChart
        symbol={selectedSymbol}
        onClose={() => setSelectedSymbol(null)}
      />
    </>
  );
}

export default App;
