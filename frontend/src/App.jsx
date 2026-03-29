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

import AccountsPage from "./pages/AccountsPage";
import WheelScanPageReports from "./pages/WheelScan/WheelScanPageReports";
import WheelScanResult from "./pages/WheelScan/WheelScanResult";
import AssetHub from "./pages/AssetHub";
import AuthCallback from "./auth/AuthCallback";
import RequireAuth from "./auth/RequireAuth";
import { useAccounts } from "./hooks/useAccounts.js";
import { firstAccessiblePath } from "./lib/pages.js";

import "./App.css";

/** Redirects to the first page the active account can access. */
function DefaultRedirect() {
  const { activeAccount, isLoading } = useAccounts();
  if (isLoading) return null;
  return <Navigate to={firstAccessiblePath(activeAccount)} replace />;
}

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
          {/* Default — redirect to first page the account can access */}
          <Route path="/" element={<DefaultRedirect />} />

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

          {/* Research */}
          <Route path="/research/wheel-scan" element={<WheelScanPageReports />} />
          <Route path="/research/wheel-scan/:scanId" element={<WheelScanResult />} />
          <Route path="/research/asset-hub" element={<AssetHub />} />

          {/* Accounts */}
          <Route path="/accounts" element={<AccountsPage />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/assets/portfolio" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
