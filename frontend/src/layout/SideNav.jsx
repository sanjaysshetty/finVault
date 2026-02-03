import { NavLink } from "react-router-dom";
import { useMemo, useState } from "react";

function Section({ title, open, onToggle, children }) {
  return (
    <div className="sidenav-section">
      <button className="sidenav-section-title" onClick={onToggle} type="button">
        <span>{title}</span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="sidenav-items">{children}</div>}
    </div>
  );
}

function Item({ to, label }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `sidenav-item ${isActive ? "sidenav-item--active" : ""}`
      }
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
    <aside className="sidenav">
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
