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


// ✅ Mobile behavior: always show Spending ledger
useEffect(() => {
  const mq = window.matchMedia("(max-width: 768px)");
  const MOBILE_TARGET = "spending/receipts-ledger";

  const enforceMobileRoute = () => {
    if (mq.matches && !location.pathname.endsWith("/spending/receipts-ledger")) {
      navigate(MOBILE_TARGET, { replace: true });
    }
  };

  enforceMobileRoute();
  mq.addEventListener("change", enforceMobileRoute);

  return () => {
    mq.removeEventListener("change", enforceMobileRoute);
  };
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
