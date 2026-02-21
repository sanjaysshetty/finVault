import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Shell from "./layout/Shell";

import Prices from "./pages/Prices";
import Spending from "./pages/Spending";
import Portfolio from "./pages/Portfolio";
import Stocks from "./pages/Stocks";
import Bullion from "./pages/Bullion";
import Options from "./pages/Options";
import OtherAssets from "./pages/OtherAssets";
import FixedIncome from "./pages/FixedIncome";
import SpendingDash from "./pages/SpendingDash";
import Futures from "./pages/Futures";
import Crypto from "./pages/Crypto";
import NAV from "./pages/NAV";
import Liabilities from "./pages/Liabilities";
import Insurance from "./pages/Insurance";

import AuthCallback from "./auth/AuthCallback";
import RequireAuth from "./auth/RequireAuth";

import "./App.css";

function computeBasename() {
  const p = window.location.pathname || "/";
  return p.startsWith("/app") ? "/app" : "/";
}

export default function App() {
  return (
    <BrowserRouter basename={computeBasename()}>
      <Routes>
        {/* ✅ callback must be outside auth guard */}
        <Route path="/auth/callback" element={<AuthCallback />} />
        {/* ✅ everything else requires login */}
        <Route
          element={
            <RequireAuth>
              <Shell />
            </RequireAuth>
          }
        >
          {/* Default */}
          <Route path="/" element={<Navigate to="/assets/portfolio" replace />} />

          {/* Prices */}
          <Route path="/prices" element={<Prices />} />

          {/* Assets */}
          <Route path="/assets/portfolio" element={<Portfolio />} />
          <Route path="/assets/stocks" element={<Stocks />} />
          <Route path="/assets/bullion" element={<Bullion />} />
          <Route path="/assets/options" element={<Options />} />
          <Route path="/assets/futures" element={<Futures />} />
          <Route path="/assets/fixedincome" element={<FixedIncome />} />
          <Route path="/assets/otherassets" element={<OtherAssets />} />
          <Route path="/assets/crypto" element={<Crypto />} />

          {/* Net Asset Value */}
          <Route path="/nav/dashboard" element={<NAV />} />

          {/* Liabilities */}
          <Route path="/liabilities/dashboard" element={<Liabilities />} />
          
          {/* Insurance */}
          <Route path="/insurance/dashboard" element={<Insurance />} />
          
          {/* Spending */}
          <Route path="/spending/dashboard" element={<SpendingDash />} />
          <Route path="/spending/receipts-ledger" element={<Spending />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/assets/portfolio" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
