import { useNavigate } from "react-router-dom";
import { useMemo } from "react";
import PricesBar from "./PricesBar";
import { logout } from "../auth/logout";
import { getLoggedInUser } from "../auth/user";

export default function TopBar() {
  const navigate = useNavigate();
  const logoSrc = `${import.meta.env.BASE_URL}favicon.png`;

  const user = useMemo(() => getLoggedInUser(), []);

  const goHome = () => navigate("/spending/receipts-ledger");

  return (
    <header className="topbar">
      {/* LEFT */}
      <div
        className="topbar-left"
        style={{ display: "flex", alignItems: "center", gap: 14 }}
      >
        <img
          src={logoSrc}
          alt="FinVault"
          className="finvault-logo"
          onClick={goHome}
          style={{ cursor: "pointer" }}
        />

        {/* Brand text */}
        <span
          onClick={goHome}
          style={{
            cursor: "pointer",
            fontSize: 18,
            fontWeight: 900,
            letterSpacing: "0.5px",
            color: "#E5E7EB",
            textShadow: "0 0 6px rgba(148,163,184,0.35)",
            userSelect: "none",
          }}
        >
          FinVault
        </span>
      </div>

      {/* CENTER */}
      <div className="topbar-center">
        <PricesBar />
      </div>

      {/* RIGHT */}
      <div
        className="topbar-right"
        style={{ display: "flex", alignItems: "center", gap: 14 }}
      >
        <span style={{ color: "#CBD5F5" }}>
          Welcome{" "}
          <strong style={{ color: "#F9FAFB" }}>
            {user?.email || user?.username || user?.name || "User"}
          </strong>
        </span>

        <button className="link-btn" onClick={logout}>
          Logout
        </button>
      </div>
    </header>
  );
}
