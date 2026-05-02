import { Outlet, Navigate, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import SideNav from "./SideNav";
import TopBar from "./TopBar";
import MobileHeader from "./MobileHeader";
import MobileDrawer from "./MobileDrawer";
import { useAccounts } from "../hooks/useAccounts.js";
import { useTheme } from "../hooks/useTheme.js";
import NoPermissionsPage from "../components/ui/NoPermissionsPage.jsx";
import { pageKeyForPath, canSeePage, firstAccessiblePath } from "../lib/pages.js";

export default function Shell() {
  const [navCollapsed, setNavCollapsed] = useState(() => {
    const saved = localStorage.getItem("finvault.navCollapsed");
    return saved === "1";
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  const { accounts, activeAccount, switchAccount } = useAccounts();
  const { theme, toggle: toggleTheme, resetToAuto, isManual } = useTheme();
  const location = useLocation();

  // Hooks must all be called before any early returns (Rules of Hooks).
  useEffect(() => {
    localStorage.setItem("finvault.navCollapsed", navCollapsed ? "1" : "0");
  }, [navCollapsed]);

  // True only when a non-owner member has zero page permissions granted.
  const noPermissions =
    activeAccount &&
    activeAccount.role !== "owner" &&
    Object.values(activeAccount.pages || {}).every((v) => v === "none");

  // Redirect members away from pages they can't access (e.g. direct URL navigation).
  const currentPageKey = pageKeyForPath(location.pathname);
  if (activeAccount && currentPageKey && !canSeePage(activeAccount, currentPageKey)) {
    return <Navigate to={firstAccessiblePath(activeAccount)} replace />;
  }

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-[#0A0F1A]">
      {/* Desktop top bar */}
      <TopBar
        navCollapsed={navCollapsed}
        onToggleNav={() => setNavCollapsed((v) => !v)}
        accounts={accounts}
        activeAccount={activeAccount}
        onSwitchAccount={switchAccount}
        theme={theme}
        onToggleTheme={toggleTheme}
        isManual={isManual}
        onResetToAuto={resetToAuto}
      />

      {/* Mobile header (visible on small screens only) */}
      <MobileHeader onMenuClick={() => setDrawerOpen(true)} theme={theme} onToggleTheme={toggleTheme} isManual={isManual} onResetToAuto={resetToAuto} />

      {/* Mobile slide-in drawer */}
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        activeAccount={activeAccount}
      />

      <div className="flex flex-1 min-h-0">
        <SideNav activeAccount={activeAccount} />
        <main
          className="flex-1 overflow-auto min-w-0 p-3 sm:p-5"
          style={{ background: "var(--fv-gradient)" }}
        >
          {noPermissions
            ? <NoPermissionsPage accountName={activeAccount?.accountName} />
            : <Outlet />
          }
        </main>
      </div>
    </div>
  );
}
