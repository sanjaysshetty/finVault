import { NavLink, useLocation } from "react-router-dom";
import { useState, useEffect } from "react";

/* ── Section (collapsible group) ──────────────────────────── */
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
        <span className="ml-1 text-slate-700 text-xs">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="mt-0.5 space-y-0.5">{children}</div>
      )}
    </div>
  );
}

/* ── Nav item ──────────────────────────────────────────────── */
function Item({ to, label, onClose }) {
  return (
    <NavLink
      to={to}
      title={label}
      onClick={onClose}
      className={({ isActive }) =>
        [
          "flex items-center px-3 py-2 rounded-xl",
          "text-sm font-medium transition-all duration-150",
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

/* ── Drawer ────────────────────────────────────────────────── */
export default function MobileDrawer({ open, onClose }) {
  const location = useLocation();

  const [openAssets, setOpenAssets]           = useState(true);
  const [openNav, setOpenNav]                 = useState(true);
  const [openLiabilities, setOpenLiabilities] = useState(true);
  const [openInsurance, setOpenInsurance]     = useState(true);
  const [openSpending, setOpenSpending]       = useState(true);

  // Auto-close on route change
  useEffect(() => {
    onClose();
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={[
        "fixed inset-0 z-50 md:hidden",
        open ? "pointer-events-auto" : "pointer-events-none",
      ].join(" ")}
    >
      {/* Backdrop */}
      <div
        className={[
          "absolute inset-0 bg-black/60",
          "transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0",
        ].join(" ")}
        onClick={onClose}
      />

      {/* Slide-in panel */}
      <div
        className={[
          "relative flex flex-col",
          "w-64 h-full",
          "bg-[#080D1A] border-r border-white/[0.06]",
          "transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "-translate-x-full",
          "overflow-y-auto",
          "[&::-webkit-scrollbar]:w-1",
          "[&::-webkit-scrollbar-thumb]:rounded-full",
          "[&::-webkit-scrollbar-thumb]:bg-white/[0.06]",
        ].join(" ")}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-white/[0.06] shrink-0">
          <span
            className="text-lg font-black tracking-tight text-slate-50"
            style={{ fontFamily: "Epilogue, sans-serif" }}
          >
            finVault
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className={[
              "w-8 h-8 flex items-center justify-center rounded-lg",
              "text-slate-400 hover:text-slate-200",
              "border border-white/[0.08] hover:border-white/[0.14]",
              "bg-white/[0.03] hover:bg-white/[0.07]",
              "transition-colors cursor-pointer text-lg leading-none",
            ].join(" ")}
          >
            ×
          </button>
        </div>

        {/* Nav sections */}
        <nav className="flex-1 py-4 px-3 space-y-1">
          <Section title="Assets" open={openAssets} onToggle={() => setOpenAssets((v) => !v)}>
            <Item to="/assets/portfolio"   label="Portfolio"    onClose={onClose} />
            <Item to="/assets/stocks"      label="Stocks"       onClose={onClose} />
            <Item to="/assets/crypto"      label="Crypto"       onClose={onClose} />
            <Item to="/assets/bullion"     label="Bullion"      onClose={onClose} />
            <Item to="/assets/fixedincome" label="Fixed Income" onClose={onClose} />
            <Item to="/assets/options"     label="Options"      onClose={onClose} />
            <Item to="/assets/otherassets" label="Others"       onClose={onClose} />
            <Item to="/assets/futures"     label="Futures"      onClose={onClose} />
          </Section>

          <Section title="Net Asset Value" open={openNav} onToggle={() => setOpenNav((v) => !v)}>
            <Item to="/nav/dashboard" label="NAV" onClose={onClose} />
          </Section>

          <Section title="Liabilities" open={openLiabilities} onToggle={() => setOpenLiabilities((v) => !v)}>
            <Item to="/liabilities/dashboard" label="Liabilities" onClose={onClose} />
          </Section>

          <Section title="Insurance" open={openInsurance} onToggle={() => setOpenInsurance((v) => !v)}>
            <Item to="/insurance/dashboard" label="Insurance" onClose={onClose} />
          </Section>

          <Section title="Spending" open={openSpending} onToggle={() => setOpenSpending((v) => !v)}>
            <Item to="/spending/dashboard"       label="Dashboard"       onClose={onClose} />
            <Item to="/spending/receipts-ledger" label="Receipts Ledger" onClose={onClose} />
          </Section>
        </nav>
      </div>
    </div>
  );
}
