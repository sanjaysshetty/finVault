import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Shell from "./layout/Shell";

import Prices from "./pages/Prices";
import Spending from "./pages/Spending";

import Portfolio from "./pages/Portfolio";
import Stocks from "./pages/Stocks";
import Bullion from "./pages/Bullion";
import Options from "./pages/Options";
import FixedIncome from "./pages/FixedIncome";
import SpendingDash from "./pages/SpendingDash";

import "./App.css";

export default function App() {
  return (
    // ✅ Critical: makes /app/ behave like "/"
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        <Route element={<Shell />}>
          {/* ✅ Default page should be Portfolio */}
          <Route path="/" element={<Navigate to="/assets/portfolio" replace />} />

          {/* Prices page (optional, since prices show in top bar now) */}
          <Route path="/prices" element={<Prices />} />

          {/* Assets */}
          <Route path="/assets/portfolio" element={<Portfolio />} />
          <Route path="/assets/stocks" element={<Stocks />} />
          <Route path="/assets/bullion" element={<Bullion />} />
          <Route path="/assets/options" element={<Options />} />

          {/* ✅ MUST match SideNav link: /assets/fixedincome */}
          <Route path="/assets/fixedincome" element={<FixedIncome />} />

          {/* Spending */}
          <Route path="/spending/dashboard" element={<SpendingDash />} />
          <Route path="/spending/receipts-ledger" element={<Spending />} />
        </Route>

        {/* ✅ For any unknown route, go to Portfolio (not Prices) */}
        <Route path="*" element={<Navigate to="/assets/portfolio" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
