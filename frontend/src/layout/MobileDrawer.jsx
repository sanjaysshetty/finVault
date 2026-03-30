import { NavLink, useLocation } from "react-router-dom";
import { useState, useEffect } from "react";

function canSee(activeAccount, pageKey) {
  if (!activeAccount || activeAccount.role === "owner") return true;
  return (activeAccount.pages?.[pageKey] || "none") !== "none";
}

/* ── Inline SVG icons ──────────────────────────────────────── */
function Icon({ children }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      className="w-[18px] h-[18px] shrink-0" aria-hidden="true">
      {children}
    </svg>
  );
}

const icons = {
  portfolio:   <Icon><rect x="4" y="6" width="16" height="12" rx="2.5" /><path strokeLinecap="round" strokeLinejoin="round" d="M10 11h4" /></Icon>,
  stocks:      <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M6 18V12M11 18V8M16 18v-5" /><path strokeLinecap="round" strokeLinejoin="round" d="M4 18h16" /></Icon>,
  crypto:      <Icon><circle cx="12" cy="12" r="8" /><path strokeLinecap="round" strokeLinejoin="round" d="M12 7v10M9.5 9.5h4a2 2 0 1 1 0 4h-4" /></Icon>,
  bullion:     <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l3-6h8l3 6H5z" /><path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4 6 4-6" /></Icon>,
  futures:     <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M8 7h8l-1.8-1.8M16 17H8l1.8 1.8" /><path strokeLinecap="round" strokeLinejoin="round" d="M16 7a5 5 0 0 1 0 10M8 17a5 5 0 0 1 0-10" /></Icon>,
  options:     <Icon><circle cx="12" cy="12" r="8" /><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3" /></Icon>,
  fixedIncome: <Icon><rect x="4" y="7" width="16" height="10" rx="2" /><path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8M8 14h5" /><circle cx="17" cy="14" r="1.2" /></Icon>,
  others:      <Icon><circle cx="12" cy="12" r="1.5" /><circle cx="7" cy="12" r="1.5" /><circle cx="17" cy="12" r="1.5" /></Icon>,
  nav:         <Icon><circle cx="12" cy="12" r="7" /><path strokeLinecap="round" strokeLinejoin="round" d="M12 12l3.5-2.5" /><circle cx="12" cy="12" r="1" /></Icon>,
  liabilities: <Icon><rect x="4" y="5" width="16" height="14" rx="2.5" /><path strokeLinecap="round" strokeLinejoin="round" d="M16 11h4M16 14h3" /></Icon>,
  insurance:   <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M12 3l7 3v6c0 5-3.2 8-7 9-3.8-1-7-4-7-9V6l7-3z" /><path strokeLinecap="round" strokeLinejoin="round" d="M9.5 12.5l1.7 1.8 3.3-3.7" /></Icon>,
  dashboard:   <Icon><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="5" rx="1.5" /><rect x="13" y="11" width="7" height="9" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /></Icon>,
  receipts:    <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M7 4h10v16l-2-1.3L13 20l-2-1.3L9 20l-2-1.3L5 20V6a2 2 0 0 1 2-2z" /><path strokeLinecap="round" strokeLinejoin="round" d="M9 9h6M9 12h6" /></Icon>,
  wheelScan:   <Icon><circle cx="12" cy="12" r="7" /><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h8M12 8v8" /><path strokeLinecap="round" strokeLinejoin="round" d="M9 9l6 6M15 9l-6 6" /></Icon>,
  assetHub:    <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.75H4.5A.75.75 0 0 0 3.75 4.5v5.25c0 .414.336.75.75.75h5.25a.75.75 0 0 0 .75-.75V4.5a.75.75 0 0 0-.75-.75Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 3.75h-5.25a.75.75 0 0 0-.75.75v5.25c0 .414.336.75.75.75H19.5a.75.75 0 0 0 .75-.75V4.5a.75.75 0 0 0-.75-.75Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 13.5H4.5a.75.75 0 0 0-.75.75V19.5c0 .414.336.75.75.75h5.25a.75.75 0 0 0 .75-.75v-5.25a.75.75 0 0 0-.75-.75Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M17.25 13.5a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5Z" /></Icon>,
  capitalGains: <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18" /><path strokeLinecap="round" strokeLinejoin="round" d="M5 6h14" /><path strokeLinecap="round" strokeLinejoin="round" d="M5 6l-2 5h4l-2-5z" /><path strokeLinecap="round" strokeLinejoin="round" d="M19 6l-2 5h4l-2-5z" /></Icon>,
  accounts:    <Icon><circle cx="12" cy="8.2" r="3.2" /><path strokeLinecap="round" strokeLinejoin="round" d="M5 19c1.6-3 4-4.5 7-4.5s5.4 1.5 7 4.5" /></Icon>,
};

/* ── Section header (main menu row) ───────────────────────── */
function Section({ title, icon, open, onToggle, children }) {
  return (
    <div className="mb-0.5">
      <button
        type="button"
        onClick={onToggle}
        className={[
          "w-full flex items-center justify-between",
          "px-4 py-3 rounded-xl",
          "text-[15px] font-semibold text-slate-200 hover:text-white",
          "hover:bg-white/[0.05] transition-all duration-150 cursor-pointer group",
        ].join(" ")}
      >
        <span className="flex items-center gap-3">
          <span className="text-slate-400 group-hover:text-slate-300 transition-colors shrink-0">{icon}</span>
          <span>{title}</span>
        </span>
        <svg
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
          className={`w-4 h-4 text-slate-600 transition-transform duration-200 shrink-0 ${open ? "rotate-180" : ""}`}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <div className={`overflow-hidden transition-all duration-200 ${open ? "max-h-96 opacity-100" : "max-h-0 opacity-0"}`}>
        {/* Indent guide + sub-items */}
        <div className="ml-[26px] pl-4 border-l border-white/[0.07] mb-1 mt-0 space-y-0">
          {children}
        </div>
      </div>
    </div>
  );
}

/* ── Sub-menu item ─────────────────────────────────────────── */
function Item({ to, label, icon, onClose }) {
  return (
    <NavLink
      to={to}
      title={label}
      onClick={onClose}
      className={({ isActive }) =>
        [
          "flex items-center gap-2.5 px-3 py-1.5 rounded-lg",
          "text-sm font-medium transition-all duration-150",
          isActive
            ? "bg-blue-500/[0.12] text-blue-300 font-semibold"
            : "text-slate-500 hover:text-slate-200 hover:bg-white/[0.05]",
        ].join(" ")
      }
    >
      {({ isActive }) => (
        <>
          <span className={`shrink-0 transition-colors ${isActive ? "text-blue-400" : "text-slate-600"}`}>
            {icon}
          </span>
          <span className="truncate">{label}</span>
        </>
      )}
    </NavLink>
  );
}

/* ── Drawer ────────────────────────────────────────────────── */
export default function MobileDrawer({ open, onClose, activeAccount }) {
  const location = useLocation();

  const [openAssets, setOpenAssets]           = useState(true);
  const [openNav, setOpenNav]                 = useState(true);
  const [openLiabilities, setOpenLiabilities] = useState(true);
  const [openInsurance, setOpenInsurance]     = useState(true);
  const [openSpending, setOpenSpending]       = useState(true);
  const [openResearch, setOpenResearch]       = useState(true);

  useEffect(() => {
    onClose();
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const has = (key) => canSee(activeAccount, key);
  const showSpending = has("spendingDashboard") || has("receiptsLedger");

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
          "absolute inset-0 bg-black/70 backdrop-blur-[2px]",
          "transition-opacity duration-300",
          open ? "opacity-100" : "opacity-0",
        ].join(" ")}
        onClick={onClose}
      />

      {/* Slide-in panel */}
      <div
        className={[
          "relative flex flex-col",
          "w-72 h-full",
          "bg-[#080D1A] border-r border-white/[0.07]",
          "transition-transform duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]",
          open ? "translate-x-0" : "-translate-x-full",
          "overflow-y-auto",
          "[&::-webkit-scrollbar]:w-1",
          "[&::-webkit-scrollbar-thumb]:rounded-full",
          "[&::-webkit-scrollbar-thumb]:bg-white/[0.06]",
        ].join(" ")}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between px-4 py-5 shrink-0">
          <span
            className="text-xl font-black tracking-tight text-slate-50"
            style={{ fontFamily: "Epilogue, sans-serif" }}
          >
            finVault
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="w-8 h-8 flex items-center justify-center rounded-full text-slate-500 hover:text-slate-200 hover:bg-white/[0.07] transition-colors cursor-pointer text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Divider */}
        <div className="mx-4 h-px bg-white/[0.06]" />

        {/* Nav sections */}
        <nav className="flex-1 py-3 space-y-0">
          {(has("portfolio") || has("stocks") || has("crypto") ||
            has("bullion")   || has("futures") || has("options") ||
            has("fixedIncome") || has("otherAssets") || has("capitalGains")) && (
            <Section
              title="Assets"
              icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h16" /></svg>}
              open={openAssets}
              onToggle={() => setOpenAssets((v) => !v)}
            >
              {has("portfolio")   && <Item to="/assets/portfolio"   label="Portfolio"    icon={icons.portfolio}   onClose={onClose} />}
              {has("stocks")      && <Item to="/assets/stocks"      label="Stocks"       icon={icons.stocks}      onClose={onClose} />}
              {has("crypto")      && <Item to="/assets/crypto"      label="Crypto"       icon={icons.crypto}      onClose={onClose} />}
              {has("bullion")     && <Item to="/assets/bullion"     label="Bullion"      icon={icons.bullion}     onClose={onClose} />}
              {has("fixedIncome") && <Item to="/assets/fixedincome" label="Fixed Income" icon={icons.fixedIncome} onClose={onClose} />}
              {has("options")     && <Item to="/assets/options"     label="Options"      icon={icons.options}     onClose={onClose} />}
              {has("otherAssets") && <Item to="/assets/otherassets" label="Others"       icon={icons.others}      onClose={onClose} />}
              {has("futures")      && <Item to="/assets/futures"       label="Futures"       icon={icons.futures}      onClose={onClose} />}
              {has("capitalGains") && <Item to="/assets/capital-gains" label="Capital Gains" icon={icons.capitalGains}  onClose={onClose} />}
            </Section>
          )}

          {has("nav") && (
            <Section
              title="Net Asset Value"
              icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M4 12h16" /><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16" /></svg>}
              open={openNav}
              onToggle={() => setOpenNav((v) => !v)}
            >
              <Item to="/nav/dashboard" label="NAV" icon={icons.nav} onClose={onClose} />
            </Section>
          )}

          {has("liabilities") && (
            <Section
              title="Liabilities"
              icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5"><rect x="4" y="5" width="16" height="14" rx="2.5" /><path strokeLinecap="round" strokeLinejoin="round" d="M16 11h4M16 14h3" /></svg>}
              open={openLiabilities}
              onToggle={() => setOpenLiabilities((v) => !v)}
            >
              <Item to="/liabilities/dashboard" label="Liabilities" icon={icons.liabilities} onClose={onClose} />
            </Section>
          )}

          {has("insurance") && (
            <Section
              title="Insurance"
              icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3l7 3v6c0 5-3.2 8-7 9-3.8-1-7-4-7-9V6l7-3z" /></svg>}
              open={openInsurance}
              onToggle={() => setOpenInsurance((v) => !v)}
            >
              <Item to="/insurance/dashboard" label="Insurance" icon={icons.insurance} onClose={onClose} />
            </Section>
          )}

          {showSpending && (
            <Section
              title="Spending"
              icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 9.5h14v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-8z" /><path strokeLinecap="round" strokeLinejoin="round" d="M8 9V7a4 4 0 0 1 8 0v2" /></svg>}
              open={openSpending}
              onToggle={() => setOpenSpending((v) => !v)}
            >
              {has("spendingDashboard") && (
                <Item to="/spending/dashboard"       label="Dashboard"       icon={icons.dashboard} onClose={onClose} />
              )}
              {has("receiptsLedger") && (
                <Item to="/spending/receipts-ledger" label="Receipts Ledger" icon={icons.receipts}  onClose={onClose} />
              )}
            </Section>
          )}

          {has("wheelScan") && (
            <Section
              title="Research"
              icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5"><circle cx="11" cy="11" r="7" /><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 16.5l3.5 3.5" /></svg>}
              open={openResearch}
              onToggle={() => setOpenResearch((v) => !v)}
            >
              <Item to="/research/wheel-scan" label="Wheel Scan" icon={icons.wheelScan} onClose={onClose} />
              <Item to="/research/asset-hub"  label="Asset Hub"  icon={icons.assetHub}  onClose={onClose} />
            </Section>
          )}
        </nav>

        {/* Accounts link — owners only */}
        {(!activeAccount || activeAccount.role === "owner") && (
          <div className="px-3 py-3 border-t border-white/[0.06] shrink-0">
            <NavLink
              to="/accounts"
              onClick={onClose}
              className={({ isActive }) =>
                [
                  "flex items-center gap-3 px-4 py-3 rounded-xl",
                  "text-[15px] font-semibold transition-all duration-150",
                  isActive
                    ? "bg-blue-500/[0.12] text-blue-300"
                    : "text-slate-200 hover:text-white hover:bg-white/[0.05]",
                ].join(" ")
              }
            >
              {({ isActive }) => (
                <>
                  <span className={`shrink-0 transition-colors ${isActive ? "text-blue-400" : "text-slate-400"}`}>
                    {icons.accounts}
                  </span>
                  <span>Accounts</span>
                </>
              )}
            </NavLink>
          </div>
        )}
      </div>
    </div>
  );
}
