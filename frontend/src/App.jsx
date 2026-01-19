import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import Prices from "./pages/Prices";
import Spending from "./pages/Spending";

const navLinkStyle = ({ isActive }) => ({
  textDecoration: "none",
  fontWeight: 700,
  fontSize: 13,
  padding: "10px 12px",
  borderRadius: 12,
  border: "1px solid #1F2937",
  background: isActive ? "#0F172A" : "transparent",
  color: isActive ? "#FACC15" : "#9CA3AF",
});

function HeaderTitle() {
  const { pathname } = useLocation();
  // With basename="/app", React Router pathname will be "/" or "/spending"
  return pathname.startsWith("/spending") ? "Personal Spending" : "Markets Dashboard";
}

export default function App() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        width: "100vw",
        background: "#020617",
        color: "#F9FAFB",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Inter, sans-serif",
      }}
    >
      <div style={{ borderBottom: "1px solid #0B1220" }}>
        <div
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
        <div style={{ fontWeight: 800, letterSpacing: "0.02em" }}>
          <HeaderTitle />
        </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <NavLink to="/" end style={navLinkStyle}>
              Prices
            </NavLink>
            <NavLink to="/spending" style={navLinkStyle}>
              Spending
            </NavLink>
          </div>
        </div>
      </div>

      <Routes>
        <Route path="/" element={<Prices />} />
        <Route path="/spending" element={<Spending />} />
      </Routes>
    </div>
  );
}
