import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import SideNav from "./SideNav";
import TopBar from "./TopBar";

export default function Shell() {
  const [navCollapsed, setNavCollapsed] = useState(() => {
    const saved = localStorage.getItem("finvault.navCollapsed");
    return saved === "1";
  });

  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    localStorage.setItem("finvault.navCollapsed", navCollapsed ? "1" : "0");
  }, [navCollapsed]);

  // Mobile redirect safety (keeps your existing behavior)
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const mobileTarget = "/spending/receipts-ledger";

    const enforce = () => {
      if (mq.matches && location.pathname.startsWith("/assets/")) {
        navigate(mobileTarget, { replace: true });
      }
    };

    enforce();
    mq.addEventListener("change", enforce);
    return () => mq.removeEventListener("change", enforce);
  }, [location.pathname, navigate]);

  return (
    <div className={`app-shell ${navCollapsed ? "nav-collapsed" : ""}`}>
      <TopBar
        navCollapsed={navCollapsed}
        onToggleNav={() => setNavCollapsed((v) => !v)}
      />

      <div className="app-body">
        <SideNav navCollapsed={navCollapsed} />
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
