import { NavLink } from "react-router-dom";
import { useState } from "react";

/* ── Section (collapsible group) ─────────────────────────── */
function Section({ title, open, onToggle, children }) {
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={onToggle}
        className={[
          "w-full flex items-center justify-between",
          "px-2 py-1.5 rounded-lg",
          "text-sm font-bold uppercase tracking-wide",
          "text-slate-600 hover:text-slate-400",
          "transition-colors cursor-pointer",
        ].join(" ")}
      >
        <span className="truncate">{title}</span>
        <span className="ml-1 text-slate-700 text-xs">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="mt-0.5 space-y-0.5 ml-2">{children}</div>
      )}
    </div>
  );
}

/* ── Nav item ─────────────────────────────────────────────── */
function Item({ to, label }) {
  return (
    <NavLink
      to={to}
      title={label}
      className={({ isActive }) =>
        [
          "flex items-center px-3 py-2 rounded-xl",
          "text-[1.05rem] font-medium transition-all duration-150",
          "whitespace-nowrap overflow-hidden text-ellipsis",
          isActive
            ? "bg-blue-500/[0.12] text-blue-300 font-bold border border-blue-500/[0.2]"
            : "text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] border border-transparent",
        ].join(" ")
      }
    >
      {label}
    </NavLink>
  );
}

/* ── Sidebar ──────────────────────────────────────────────── */
export default function SideNav() {
  const [openAssets, setOpenAssets]           = useState(true);
  const [openNav, setOpenNav]                 = useState(true);
  const [openLiabilities, setOpenLiabilities] = useState(true);
  const [openInsurance, setOpenInsurance]     = useState(true);
  const [openSpending, setOpenSpending]       = useState(true);

  return (
    <aside
      className={[
        "hidden md:flex flex-col shrink-0",
        "w-56 overflow-y-auto overflow-x-hidden",
        "py-5 px-3",
        "bg-[#080D1A] border-r border-white/[0.06]",
        "[&::-webkit-scrollbar]:w-1",
        "[&::-webkit-scrollbar-thumb]:rounded-full",
        "[&::-webkit-scrollbar-thumb]:bg-white/[0.06]",
      ].join(" ")}
    >
      <Section
        title="Assets"
        open={openAssets}
        onToggle={() => setOpenAssets((v) => !v)}
      >
        <Item to="/assets/portfolio"   label="Portfolio"    />
        <Item to="/assets/stocks"      label="Stocks"       />
        <Item to="/assets/crypto"      label="Crypto"       />
        <Item to="/assets/bullion"     label="Bullion"      />
        <Item to="/assets/futures"     label="Futures"      />
        <Item to="/assets/options"     label="Options"      />
        <Item to="/assets/fixedincome" label="Fixed Income" />
        <Item to="/assets/otherassets" label="Others"       />
      </Section>

      <Section
        title="Net Asset Value"
        open={openNav}
        onToggle={() => setOpenNav((v) => !v)}
      >
        <Item to="/nav/dashboard" label="NAV" />
      </Section>

      <Section
        title="Liabilities"
        open={openLiabilities}
        onToggle={() => setOpenLiabilities((v) => !v)}
      >
        <Item to="/liabilities/dashboard" label="Liabilities" />
      </Section>

      <Section
        title="Insurance"
        open={openInsurance}
        onToggle={() => setOpenInsurance((v) => !v)}
      >
        <Item to="/insurance/dashboard" label="Insurance" />
      </Section>

      <Section
        title="Spending"
        open={openSpending}
        onToggle={() => setOpenSpending((v) => !v)}
      >
        <Item to="/spending/dashboard"       label="Dashboard"        />
        <Item to="/spending/receipts-ledger" label="Receipts Ledger"  />
      </Section>
    </aside>
  );
}
