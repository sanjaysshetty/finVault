import { NavLink } from "react-router-dom";
import { useState } from "react";

/**
 * Returns true if the active account can see `pageKey`.
 * Owners always pass. Members need pages[pageKey] !== "none".
 * While accounts are still loading (activeAccount is null), show everything.
 */
function canSee(activeAccount, pageKey) {
  if (!activeAccount || activeAccount.role === "owner") return true;
  return (activeAccount.pages?.[pageKey] || "none") !== "none";
}

function Icon({ children }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      className="w-4 h-4 shrink-0"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const icons = {
  sectionAssets: (
    <Icon>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h16" />
    </Icon>
  ),
  sectionNav: (
    <Icon>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 12h16" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16" />
    </Icon>
  ),
  sectionLiabilities: (
    <Icon>
      <rect x="4" y="5" width="16" height="14" rx="2.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 11h4M16 14h3" />
    </Icon>
  ),
  sectionInsurance: (
    <Icon>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l7 3v6c0 5-3.2 8-7 9-3.8-1-7-4-7-9V6l7-3z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.5 12.5l1.7 1.8 3.3-3.7" />
    </Icon>
  ),
  sectionSpending: (
    <Icon>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 9.5h14v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-8z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9V7a4 4 0 0 1 8 0v2" />
    </Icon>
  ),
  portfolio: (
    <Icon>
      <rect x="4" y="6" width="16" height="12" rx="2.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 11h4" />
    </Icon>
  ),
  stocks: (
    <Icon>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18V12M11 18V8M16 18v-5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 18h16" />
    </Icon>
  ),
  crypto: (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v10M9.5 9.5h4a2 2 0 1 1 0 4h-4" />
    </Icon>
  ),
  bullion: (
    <Icon>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l3-6h8l3 6H5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4 6 4-6" />
    </Icon>
  ),
  futures: (
    <Icon>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h8l-1.8-1.8M16 17H8l1.8 1.8" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a5 5 0 0 1 0 10M8 17a5 5 0 0 1 0-10" />
    </Icon>
  ),
  options: (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3" />
    </Icon>
  ),
  fixedIncome: (
    <Icon>
      <rect x="4" y="7" width="16" height="10" rx="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8M8 14h5" />
      <circle cx="17" cy="14" r="1.2" />
    </Icon>
  ),
  others: (
    <Icon>
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="7" cy="12" r="1.5" />
      <circle cx="17" cy="12" r="1.5" />
    </Icon>
  ),
  nav: (
    <Icon>
      <circle cx="12" cy="12" r="7" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 12l3.5-2.5" />
      <circle cx="12" cy="12" r="1" />
    </Icon>
  ),
  liabilities: (
    <Icon>
      <rect x="4" y="5" width="16" height="14" rx="2.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 11h4M16 14h3" />
    </Icon>
  ),
  insurance: (
    <Icon>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l7 3v6c0 5-3.2 8-7 9-3.8-1-7-4-7-9V6l7-3z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.5 12.5l1.7 1.8 3.3-3.7" />
    </Icon>
  ),
  dashboard: (
    <Icon>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="5" rx="1.5" />
      <rect x="13" y="11" width="7" height="9" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
    </Icon>
  ),
  receipts: (
    <Icon>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 4h10v16l-2-1.3L13 20l-2-1.3L9 20l-2-1.3L5 20V6a2 2 0 0 1 2-2z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9h6M9 12h6" />
    </Icon>
  ),
  accounts: (
    <Icon>
      <circle cx="12" cy="8.2" r="3.2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 19c1.6-3 4-4.5 7-4.5s5.4 1.5 7 4.5" />
    </Icon>
  ),
};

/* ── Section (collapsible group) ─────────────────────────── */
function Section({ title, open, onToggle, icon, children }) {
  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={onToggle}
        className={[
          "w-full flex items-center justify-between",
          "px-2 py-1.5 rounded-lg",
          "text-sm font-bold uppercase tracking-wide",
          "text-slate-100 hover:text-white",
          "transition-colors cursor-pointer",
        ].join(" ")}
      >
        <span className="truncate flex items-center gap-2">
          {icon}
          <span>{title}</span>
        </span>
        <span className="ml-1 text-slate-100 text-xs">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && <div className="mt-0.5 space-y-0 ml-2">{children}</div>}
    </div>
  );
}

/* ── Nav item ─────────────────────────────────────────────── */
function Item({ to, label, icon }) {
  return (
    <NavLink
      to={to}
      title={label}
      className={({ isActive }) =>
        [
          "gap-1.5",
          "flex items-center px-3 py-[2px] rounded-xl",
          "text-[1.05rem] font-medium transition-all duration-150",
          "whitespace-nowrap overflow-hidden text-ellipsis",
          isActive
            ? "bg-blue-500/[0.12] text-blue-300 font-bold border border-blue-500/[0.2]"
            : "text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] border border-transparent",
        ].join(" ")
      }
    >
      <span className="mr-1.5 text-slate-300">{icon}</span>
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

/* ── Sidebar ──────────────────────────────────────────────── */
export default function SideNav({ activeAccount }) {
  const [openAssets, setOpenAssets]           = useState(true);
  const [openNav, setOpenNav]                 = useState(true);
  const [openLiabilities, setOpenLiabilities] = useState(true);
  const [openInsurance, setOpenInsurance]     = useState(true);
  const [openSpending, setOpenSpending]       = useState(true);

  const hasAsset = (key) => canSee(activeAccount, key);
  const showSpending =
    canSee(activeAccount, "spendingDashboard") ||
    canSee(activeAccount, "receiptsLedger");

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
      {/* Assets section — only rendered if at least one asset page is visible */}
      {(hasAsset("portfolio") || hasAsset("stocks") || hasAsset("crypto") ||
        hasAsset("bullion")   || hasAsset("futures") || hasAsset("options") ||
        hasAsset("fixedIncome") || hasAsset("otherAssets")) && (
        <Section
          title="Assets"
          open={openAssets}
          icon={icons.sectionAssets}
          onToggle={() => setOpenAssets((v) => !v)}
        >
          {hasAsset("portfolio")   && <Item to="/assets/portfolio"   label="Portfolio"    icon={icons.portfolio} />}
          {hasAsset("stocks")      && <Item to="/assets/stocks"      label="Stocks"       icon={icons.stocks} />}
          {hasAsset("crypto")      && <Item to="/assets/crypto"      label="Crypto"       icon={icons.crypto} />}
          {hasAsset("bullion")     && <Item to="/assets/bullion"     label="Bullion"      icon={icons.bullion} />}
          {hasAsset("futures")     && <Item to="/assets/futures"     label="Futures"      icon={icons.futures} />}
          {hasAsset("options")     && <Item to="/assets/options"     label="Options"      icon={icons.options} />}
          {hasAsset("fixedIncome") && <Item to="/assets/fixedincome" label="Fixed Income" icon={icons.fixedIncome} />}
          {hasAsset("otherAssets") && <Item to="/assets/otherassets" label="Others"       icon={icons.others} />}
        </Section>
      )}

      {canSee(activeAccount, "nav") && (
        <Section
          title="Net Asset Value"
          open={openNav}
          icon={icons.sectionNav}
          onToggle={() => setOpenNav((v) => !v)}
        >
          <Item to="/nav/dashboard" label="NAV" icon={icons.nav} />
        </Section>
      )}

      {canSee(activeAccount, "liabilities") && (
        <Section
          title="Liabilities"
          open={openLiabilities}
          icon={icons.sectionLiabilities}
          onToggle={() => setOpenLiabilities((v) => !v)}
        >
          <Item to="/liabilities/dashboard" label="Liabilities" icon={icons.liabilities} />
        </Section>
      )}

      {canSee(activeAccount, "insurance") && (
        <Section
          title="Insurance"
          open={openInsurance}
          icon={icons.sectionInsurance}
          onToggle={() => setOpenInsurance((v) => !v)}
        >
          <Item to="/insurance/dashboard" label="Insurance" icon={icons.insurance} />
        </Section>
      )}

      {showSpending && (
        <Section
          title="Spending"
          open={openSpending}
          icon={icons.sectionSpending}
          onToggle={() => setOpenSpending((v) => !v)}
        >
          {canSee(activeAccount, "spendingDashboard") && (
            <Item to="/spending/dashboard"       label="Dashboard"       icon={icons.dashboard} />
          )}
          {canSee(activeAccount, "receiptsLedger") && (
            <Item to="/spending/receipts-ledger" label="Receipts Ledger" icon={icons.receipts} />
          )}
        </Section>
      )}

      {/* Accounts link — owners only */}
      {(!activeAccount || activeAccount.role === "owner") && (
        <div className="mt-6 pt-4 border-t border-white/[0.06]">
          <Item to="/accounts" label="Accounts" icon={icons.accounts} />
        </div>
      )}
    </aside>
  );
}
