import { NavLink, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { getLoggedInUser } from "../auth/user";

function canSee(activeAccount, pageKey) {
  if (!activeAccount || activeAccount.role === "owner") return true;
  return (activeAccount.pages?.[pageKey] || "none") !== "none";
}

/* ── Icon — same as SideNav (15×15, strokeWidth 1.8) ──────── */
function Icon({ d }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0 }} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/* ── Badge ─────────────────────────────────────────────────── */
function Badge({ label }) {
  return (
    <span style={{
      marginLeft: "auto",
      fontSize: 9,
      fontWeight: 700,
      padding: "2px 6px",
      borderRadius: 99,
      background: "rgba(61,214,140,0.15)",
      color: "#3DD68C",
      border: "1px solid rgba(61,214,140,0.25)",
      letterSpacing: "0.04em",
      flexShrink: 0,
    }}>
      {label}
    </span>
  );
}

/* ── Section label ─────────────────────────────────────────── */
function SectionLabel({ label }) {
  return (
    <div style={{ padding: "12px 16px 4px", fontSize: 10, fontWeight: 700, color: "var(--fv-dim)", textTransform: "uppercase", letterSpacing: "0.12em" }}>
      {label}
    </div>
  );
}

/* ── Icon paths — same as SideNav ─────────────────────────── */
const d = {
  portfolio:    "M4 5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5zm9 0a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V5zm0 8a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-6zm-9 2a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4z",
  capitalGains: "M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4",
  nav:          "M12 3v1m0 16v1M4.22 4.22l.7.7m12.16 12.16.7.7M1 12h1m18 0h1M4.22 19.78l.7-.7M18.36 5.64l.7-.7M12 7a5 5 0 1 1 0 10A5 5 0 0 1 12 7z",
  stocks:       "M3 17l4-8 4 4 4-6 4 3",
  crypto:       "M9.5 2A2.5 2.5 0 0 1 12 4.5V5a1 1 0 0 0 1 1h1a2 2 0 0 1 0 4h-1a1 1 0 0 0-1 1v.5a2.5 2.5 0 0 1-5 0V11a1 1 0 0 0-1-1H5a2 2 0 0 1 0-4h1a1 1 0 0 0 1-1v-.5A2.5 2.5 0 0 1 9.5 2z",
  bullion:      "M5 8h14l-1 9H6L5 8zM3 5h18M9 5V3h6v2",
  futures:      "M8 7h8M8 12h8M8 17h5m3-5 2 2 2-2",
  options:      "M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  fixedIncome:  "M4 7h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7zm4 0V5a2 2 0 0 1 4 0v2",
  others:       "M5 12h.01M12 12h.01M19 12h.01M6 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm7 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm7 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0z",
  liabilities:  "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2",
  insurance:    "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0 1 12 2.944a11.955 11.955 0 0 1-8.618 3.04A12.02 12.02 0 0 0 3 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z",
  spending:     "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 0 0 3-3V8a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3z",
  receipts:     "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01",
  wheelScan:    "M21 21l-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0z",
  assetHub:     "M19 11H5m14 0a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2m14 0V9a2 2 0 0 0-2-2M5 11V9a2 2 0 0 1 2-2m0 0V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2M7 7h10",
  compass:      "M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm3.5 6.5-2 6-6 2 2-6 6-2z",
  paperTrading: "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9l2 2 4-4",
  accounts:     "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
};

/* ── User avatar circle ─────────────────────────────────────── */
function userInitials(user) {
  if (!user) return "?";
  const f = user.firstName?.[0] || "";
  const l = user.lastName?.[0] || "";
  if (f && l) return (f + l).toUpperCase();
  if (f) return f.toUpperCase();
  return (user.email?.[0] || "?").toUpperCase();
}

function UserAvatar() {
  const user = getLoggedInUser();
  return (
    <span style={{
      width: 22, height: 22, borderRadius: "50%",
      background: "linear-gradient(135deg, #0e6c4a, #1a9e65)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 9, fontWeight: 800, color: "#fff",
      flexShrink: 0, letterSpacing: "0.04em",
    }}>
      {userInitials(user)}
    </span>
  );
}

/* ── Nav item ──────────────────────────────────────────────── */
function NavItem({ to, label, iconD, badge, onClose }) {
  return (
    <NavLink
      to={to}
      title={label}
      onClick={onClose}
      className="sidebar-item"
      style={({ isActive }) => ({
        width: "calc(100% - 16px)",
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "6px 14px",
        borderRadius: 10,
        border: "none",
        cursor: "pointer",
        background: isActive ? "var(--fv-nav-active-bg)" : "transparent",
        color: isActive ? "var(--fv-nav-active-text)" : "var(--fv-muted)",
        fontSize: 13,
        fontWeight: isActive ? 700 : 600,
        margin: "1px 8px",
        fontFamily: "'Manrope', sans-serif",
        textDecoration: "none",
      })}
    >
      {({ isActive }) => (
        <>
          <span style={{ color: isActive ? "var(--fv-nav-active-text)" : "var(--fv-dim)", flexShrink: 0, display: "flex" }}>
            <Icon d={iconD} />
          </span>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {label}
          </span>
          {badge && <Badge label={badge} />}
        </>
      )}
    </NavLink>
  );
}

/* ── Drawer ────────────────────────────────────────────────── */
export default function MobileDrawer({ open, onClose, activeAccount }) {
  const location = useLocation();

  useEffect(() => {
    onClose();
  }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const has = (key) => canSee(activeAccount, key);
  const showSpending   = has("spendingDashboard") || has("receiptsLedger");
  const showPortfolio  = has("portfolio") || has("capitalGains") || has("nav");
  const showAssets     = has("stocks") || has("crypto") || has("bullion") || has("futures") || has("options") || has("fixedIncome") || has("otherAssets");
  const showProtection = has("liabilities") || has("insurance");
  const showResearch   = has("wheelScan") || has("assetHub") || has("advisor") || has("paperTrading");
  const isOwner        = !activeAccount || activeAccount.role === "owner";

  return (
    <div className={["fixed inset-0 z-50 md:hidden", open ? "pointer-events-auto" : "pointer-events-none"].join(" ")}>
      {/* Backdrop */}
      <div
        className={["absolute inset-0 bg-black/70 backdrop-blur-[2px] transition-opacity duration-300", open ? "opacity-100" : "opacity-0"].join(" ")}
        onClick={onClose}
      />

      {/* Slide-in panel */}
      <div
        className={["relative flex flex-col fv-mobile-drawer w-72 h-full border-r border-white/[0.06]",
          "transition-transform duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] overflow-y-auto [&::-webkit-scrollbar]:w-0",
          open ? "translate-x-0" : "-translate-x-full",
        ].join(" ")}
        style={{ background: "var(--fv-sidebar)" }}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between px-4 py-4 shrink-0">
          <div className="flex items-center gap-2.5 select-none">
            <svg width="28" height="28" viewBox="0 0 40 40" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="fvmeridian-md" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#0e6c4a" />
                  <stop offset="100%" stopColor="#1a9e65" />
                </linearGradient>
              </defs>
              <rect x="1" y="1" width="38" height="38" rx="11" fill="url(#fvmeridian-md)" />
              <path d="M9 24l11-13 11 13" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <path d="M9 31l11-8 11 8" stroke="#3DD68C" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.85" />
            </svg>
            <span style={{ fontSize: 17, fontWeight: 900, color: "var(--fv-text)", letterSpacing: "-0.4px", fontFamily: "Manrope, sans-serif", whiteSpace: "nowrap" }}>
              fin<span style={{ color: "var(--fv-accent-solid, #1a9e65)" }}>Vault</span>
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close menu"
            className="w-8 h-8 flex items-center justify-center rounded-full text-slate-500 hover:text-slate-200 hover:bg-white/[0.07] transition-colors cursor-pointer text-lg leading-none">
            ×
          </button>
        </div>

        <div className="mx-4 h-px" style={{ background: "var(--fv-border)" }} />

        {/* Nav */}
        <nav className="flex-1 pb-4">
          {showPortfolio && (
            <>
              <SectionLabel label="Portfolio" />
              {has("portfolio")    && <NavItem to="/assets/portfolio"    label="Dashboard"       iconD={d.portfolio}    onClose={onClose} />}
              {has("capitalGains") && <NavItem to="/assets/capital-gains" label="Capital Gains"  iconD={d.capitalGains} onClose={onClose} />}
              {has("nav")          && <NavItem to="/nav/dashboard"        label="Net Asset Value" iconD={d.nav}          onClose={onClose} />}
            </>
          )}
          {showAssets && (
            <>
              <SectionLabel label="Assets" />
              {has("stocks")      && <NavItem to="/assets/stocks"      label="Stocks"       iconD={d.stocks}      onClose={onClose} />}
              {has("crypto")      && <NavItem to="/assets/crypto"      label="Crypto"       iconD={d.crypto}      onClose={onClose} />}
              {has("bullion")     && <NavItem to="/assets/bullion"     label="Bullion"      iconD={d.bullion}     onClose={onClose} />}
              {has("futures")     && <NavItem to="/assets/futures"     label="Futures"      iconD={d.futures}     onClose={onClose} />}
              {has("options")     && <NavItem to="/assets/options-v2"  label="Options Pro"  iconD={d.options}     onClose={onClose} badge="PRO" />}
              {has("fixedIncome") && <NavItem to="/assets/fixedincome" label="Fixed Income" iconD={d.fixedIncome} onClose={onClose} />}
              {has("otherAssets") && <NavItem to="/assets/otherassets" label="Other Assets" iconD={d.others}      onClose={onClose} />}
            </>
          )}
          {showProtection && (
            <>
              <SectionLabel label="Protection" />
              {has("liabilities") && <NavItem to="/liabilities/dashboard" label="Liabilities" iconD={d.liabilities} onClose={onClose} />}
              {has("insurance")   && <NavItem to="/insurance/dashboard"   label="Insurance"   iconD={d.insurance}   onClose={onClose} />}
            </>
          )}
          {showSpending && (
            <>
              <SectionLabel label="Spending" />
              {has("spendingDashboard") && <NavItem to="/spending/dashboard"       label="Spending"        iconD={d.spending}  onClose={onClose} />}
              {has("receiptsLedger")    && <NavItem to="/spending/receipts-ledger" label="Receipts Ledger" iconD={d.receipts}   onClose={onClose} />}
            </>
          )}
          {showResearch && (
            <>
              <SectionLabel label="Research" />
              {has("wheelScan")    && <NavItem to="/research/wheel-scan"    label="Wheel Scan"    iconD={d.wheelScan}    onClose={onClose} />}
              {has("assetHub")     && <NavItem to="/research/asset-hub"     label="Asset Hub"     iconD={d.assetHub}     onClose={onClose} />}
              {has("advisor")      && <NavItem to="/research/compass"       label="Compass AI"    iconD={d.compass}      onClose={onClose} badge="AI" />}
              {has("paperTrading") && <NavItem to="/research/paper-trading" label="Paper Trading" iconD={d.paperTrading} onClose={onClose} />}
            </>
          )}
        </nav>

        {/* Accounts — owners only */}
        {isOwner && (
          <div style={{ borderTop: "1px solid var(--fv-border)", paddingTop: 10, margin: "0 0 10px" }}>
            <NavLink
              to="/accounts"
              onClick={onClose}
              className="sidebar-item"
              style={({ isActive }) => ({
                width: "calc(100% - 16px)",
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "6px 14px",
                borderRadius: 10,
                border: "none",
                cursor: "pointer",
                background: isActive ? "var(--fv-nav-active-bg)" : "transparent",
                color: isActive ? "var(--fv-nav-active-text)" : "var(--fv-muted)",
                fontSize: 13,
                fontWeight: isActive ? 700 : 600,
                margin: "1px 8px",
                fontFamily: "'Manrope', sans-serif",
                textDecoration: "none",
              })}
            >
              {({ isActive }) => (
                <>
                  <UserAvatar />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    Accounts
                  </span>
                </>
              )}
            </NavLink>
          </div>
        )}
      </div>
    </div>
  );
}
