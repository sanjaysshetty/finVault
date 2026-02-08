import { NavLink } from "react-router-dom";
import { useMemo, useState } from "react";

function Section({ title, open, onToggle, children }) {
  return (
    <div className="sidenav-section">
      <button
        className="sidenav-section-title"
        onClick={onToggle}
        type="button"
        title={title}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "8px 8px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          color: "rgba(248,250,252,0.95)",
          fontSize: 16,
          fontWeight: 800,
          letterSpacing: "0.2px",

          // prevent wrapping
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        <span className="chev" style={{ color: "rgba(226,232,240,0.75)" }}>
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="sidenav-items" style={{ paddingLeft: 8, marginTop: 6 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function Item({ to, label }) {
  return (
    <NavLink
      to={to}
      title={label}
      className={({ isActive }) =>
        `sidenav-item ${isActive ? "sidenav-item--active" : ""}`
      }
      style={({ isActive }) => ({
        display: "block",
        padding: "9px 10px",
        margin: "4px 0",
        borderRadius: 12,
        textDecoration: "none",
        fontSize: 14,
        fontWeight: isActive ? 800 : 600,

        // prevent wrapping
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",

        color: isActive ? "#FFFFFF" : "rgba(226,232,240,0.88)",
        background: isActive ? "rgba(99,102,241,0.18)" : "transparent",
        outline: isActive ? "1px solid rgba(99,102,241,0.30)" : "1px solid transparent",
      })}
    >
      {label}
    </NavLink>
  );
}

export default function SideNav() {
  // default open like your wireframe
  const [openAssets, setOpenAssets] = useState(true);
  const [openNav, setOpenNav] = useState(true);
  const [openSpending, setOpenSpending] = useState(true);

  // (Optional) you can auto-open based on current route later
  useMemo(() => {}, []);

  return (
<aside
  className="sidenav"
  style={{
    // ✅ reduced another ~10%
    width: 260,
    minWidth: 260,
    maxWidth: 260,

    padding: "18px 10px",
    overflow: "auto",

    background: "linear-gradient(180deg, #0E1B34 0%, #0B1220 100%)",
    borderRight: "1px solid rgba(148,163,184,0.12)",
  }}
>

      <Section
        title="Assets"
        open={openAssets}
        onToggle={() => setOpenAssets((v) => !v)}
      >
        <Item to="/assets/portfolio" label="Portfolio" />
        <Item to="/assets/stocks" label="Stocks" />
        <Item to="/assets/crypto" label="Crypto" />
        <Item to="/assets/bullion" label="Bullion" />
        <Item to="/assets/fixedincome" label="Fixed Income" />

        {/* ✅ New placeholder route */}
        <Item to="/assets/futures" label="Futures" />
        <Item to="/assets/options" label="Options" />
      </Section>

      <Section
        title="Net Asset Value"
        open={openNav}
        onToggle={() => setOpenNav((v) => !v)}
      >
        <Item to="/nav/dashboard" label="NAV" />
      </Section>

      <Section
        title="Spending"
        open={openSpending}
        onToggle={() => setOpenSpending((v) => !v)}
      >
        <Item to="/spending/dashboard" label="Dashboard" />
        <Item to="/spending/receipts-ledger" label="Receipts Ledger" />
      </Section>
    </aside>
  );
}
