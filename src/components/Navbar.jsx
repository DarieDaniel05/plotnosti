import { Link } from "react-router-dom";
import React from "react";

const Navbar = () => {
  return (
    <nav className="bg-gray-800 text-gray-200 shadow-lg">
      <div className="max-w-7xl mx-auto px-6">
        <div className="flex items-center justify-around h-16">
          <Link
            to="/plotnosti"
            className="text-xl font-semibold hover:text-green-400 transition-colors"
          >
            High orders
          </Link>
          <Link
            to="/"
            className="text-xl font-semibold hover:text-green-400 transition-colors"
          >
            Coins
          </Link>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
