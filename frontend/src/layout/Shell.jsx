import { Outlet } from "react-router-dom";
import { useEffect, useState } from "react";
import SideNav from "./SideNav";
import TopBar from "./TopBar";
import MobileHeader from "./MobileHeader";
import MobileDrawer from "./MobileDrawer";

export default function Shell() {
  const [navCollapsed, setNavCollapsed] = useState(() => {
    const saved = localStorage.getItem("finvault.navCollapsed");
    return saved === "1";
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem("finvault.navCollapsed", navCollapsed ? "1" : "0");
  }, [navCollapsed]);

  return (
    <div className="h-screen w-full flex flex-col overflow-hidden bg-[#0A0F1E]">
      {/* Desktop top bar */}
      <TopBar
        navCollapsed={navCollapsed}
        onToggleNav={() => setNavCollapsed((v) => !v)}
      />

      {/* Mobile header (visible on small screens only) */}
      <MobileHeader onMenuClick={() => setDrawerOpen(true)} />

      {/* Mobile slide-in drawer */}
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      <div className="flex flex-1 min-h-0">
        <SideNav />
        <main
          className="flex-1 overflow-auto min-w-0 p-5"
          style={{
            background:
              "radial-gradient(ellipse 1200px 800px at 20% 0%, rgba(99,102,241,0.05) 0%, transparent 55%), #0A0F1E",
          }}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
