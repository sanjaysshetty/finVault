import { Outlet, Navigate, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import SideNav from "./SideNav";
import TopBar from "./TopBar";
import MobileHeader from "./MobileHeader";
import MobileDrawer from "./MobileDrawer";
import { useAccounts } from "../hooks/useAccounts.js";
import NoPermissionsPage from "../components/ui/NoPermissionsPage.jsx";
import { pageKeyForPath, canSeePage, firstAccessiblePath } from "../lib/pages.js";

export default function Shell() {
  const [navCollapsed, setNavCollapsed] = useState(() => {
    const saved = localStorage.getItem("finvault.navCollapsed");
    return saved === "1";
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  const { accounts, activeAccount, switchAccount } = useAccounts();
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
    <div className="h-screen w-full flex flex-col overflow-hidden bg-[#0A0F1E]">
      {/* Desktop top bar */}
      <TopBar
        navCollapsed={navCollapsed}
        onToggleNav={() => setNavCollapsed((v) => !v)}
        accounts={accounts}
        activeAccount={activeAccount}
        onSwitchAccount={switchAccount}
      />

      {/* Mobile header (visible on small screens only) */}
      <MobileHeader onMenuClick={() => setDrawerOpen(true)} />

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
          style={{
            background:
              "radial-gradient(ellipse 1200px 800px at 20% 0%, rgba(99,102,241,0.05) 0%, transparent 55%), #0A0F1E",
          }}
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
