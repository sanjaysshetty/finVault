import { useNavigate } from "react-router-dom";
import { useMemo } from "react";
import PricesBar from "./PricesBar";
import { logout } from "../auth/logout";
import { getLoggedInUser } from "../auth/user";

export default function TopBar() {
  const navigate = useNavigate();
  const user = useMemo(() => getLoggedInUser(), []);
  const logoSrc = `${import.meta.env.BASE_URL}favicon.svg`;

  const goHome = () => navigate("/spending/receipts-ledger");

  // Keep logo perfectly square (prevents “vertical elongation”)
  const LOGO_SIZE = 28;

  return (
    <header
      className="topbar"
      style={{
        height: 72,
        padding: "10px 14px",
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 14,

        // Bold Blue chrome (match SideNav)
        background: "linear-gradient(180deg, #0E1B34 0%, #0B1220 100%)",
        borderBottom: "1px solid rgba(148,163,184,0.12)",
        boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
      }}
    >
      {/* LEFT */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          minWidth: 0,
        }}
      >
        {/* Square logo wrapper + contain fit to prevent stretching */}
        <div
          style={{
            width: LOGO_SIZE,
            height: LOGO_SIZE,
            flex: "0 0 auto",
            display: "grid",
            placeItems: "center",
          }}
        >
          <img
            src={logoSrc}
            alt="FinVault"
            draggable={false}
            style={{
              width: LOGO_SIZE,
              height: LOGO_SIZE,
              objectFit: "contain",
              display: "block", // removes baseline/inline-image quirks
            }}
          />
        </div>

        <span
          onClick={goHome}
          style={{
            cursor: "pointer",
            fontFamily: `"Satoshi", "Inter", system-ui, -apple-system, sans-serif`,
            fontSize: 20,
            fontWeight: 800,
            letterSpacing: "-0.01em",
            color: "rgba(248,250,252,0.95)",
            userSelect: "none",
            whiteSpace: "nowrap",
          }}
        >
          finVault
        </span>
      </div>

      {/* CENTER: PricesBar (scrollable, never breaks layout) */}
      <div
        className="topbar-center"
        style={{
          minWidth: 0,
          overflowX: "auto",
          overflowY: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none", // Firefox
        }}
      >
        <style>{`
          .topbar-center::-webkit-scrollbar { display: none; }
        `}</style>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <PricesBar />
        </div>
      </div>

      {/* RIGHT */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 14,
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            fontSize: 14,
            color: "rgba(148,163,184,0.95)",
            fontFamily: `"Inter", system-ui, sans-serif`,
          }}
        >
          Welcome{" "}
          <strong style={{ color: "rgba(248,250,252,0.95)", fontWeight: 700 }}>
            {user?.email || user?.username || "User"}
          </strong>
        </span>

        <button
          onClick={logout}
          className="link-btn"
          style={{
            color: "rgba(248,250,252,0.95)",
            fontWeight: 800,
            background: "transparent",
            border: "1px solid rgba(99,102,241,0.25)",
            padding: "6px 12px",
            borderRadius: 12,
            cursor: "pointer",
          }}
        >
          Logout
        </button>
      </div>
    </header>
  );
}
