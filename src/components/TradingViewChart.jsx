import React from "react";
import { X } from "lucide-react";

const TradingViewChart = ({ symbol, onClose }) => {
  if (!symbol) return null;

  const tradingViewUrl = `https://www.tradingview.com/widgetembed/?frameElementId=tradingview_chart&symbol=BINANCE:${symbol}.P&interval=5&theme=dark&style=1`;


  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
      <div className="relative bg-gray-900 rounded-lg shadow-lg w-[90%] h-[80%]">
        <button
          onClick={onClose}
          className="absolute top-2 right-[-50px] text-gray-400 hover:text-white"
        >
          <X className="h-6 w-6" />
        </button>
        <iframe
          key={symbol}
          src={tradingViewUrl}
          className="w-full h-full border-0 rounded-lg"
          frameBorder="0"
          allowFullScreen
        />
      </div>
    </div>
  );
};


export default TradingViewChart;
