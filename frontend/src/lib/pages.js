/**
 * Ordered list of all permission-gated page routes.
 *
 * This is the single source of truth for:
 *  - Route-to-pageKey mapping (used by SideNav guards)
 *  - Permission editor in AccountsPage (label + group)
 *  - firstAccessiblePath for restricted members
 *
 * To add a new page: append an entry here with pageKey, path, label, and group.
 * It will automatically appear in the AccountsPage permission editor with "none" access.
 */
export const PAGE_ROUTES = [
  // ── Portfolio ──────────────────────────────────────────────
  { pageKey: "portfolio",         path: "/assets/portfolio",         label: "Portfolio",     group: "Portfolio" },
  { pageKey: "capitalGains",      path: "/assets/capital-gains",     label: "Capital Gains", group: "Portfolio" },
  { pageKey: "nav",               path: "/nav/dashboard",            label: "NAV",           group: "Portfolio" },

  // ── Assets ─────────────────────────────────────────────────
  { pageKey: "stocks",            path: "/assets/stocks",            label: "Stocks",        group: "Assets" },
  { pageKey: "crypto",            path: "/assets/crypto",            label: "Crypto",        group: "Assets" },
  { pageKey: "bullion",           path: "/assets/bullion",           label: "Bullion",       group: "Assets" },
  { pageKey: "futures",           path: "/assets/futures",           label: "Futures",       group: "Assets" },
  { pageKey: "options",           path: "/assets/options-v2",        label: "Options",       group: "Assets" },
  { pageKey: "fixedIncome",       path: "/assets/fixedincome",       label: "Fixed Income",  group: "Assets" },
  { pageKey: "otherAssets",       path: "/assets/otherassets",       label: "Other Assets",  group: "Assets" },

  // ── Protection ─────────────────────────────────────────────
  { pageKey: "liabilities",       path: "/liabilities/dashboard",    label: "Liabilities",   group: "Protection" },
  { pageKey: "insurance",         path: "/insurance/dashboard",      label: "Insurance",     group: "Protection" },

  // ── Spending ───────────────────────────────────────────────
  { pageKey: "spendingDashboard", path: "/spending/dashboard",       label: "Spending",      group: "Spending" },
  { pageKey: "receiptsLedger",    path: "/spending/receipts-ledger", label: "Receipts",      group: "Spending" },

  // ── Research ───────────────────────────────────────────────
  { pageKey: "wheelScan",         path: "/research/wheel-scan",      label: "Wheel Scan",    group: "Research" },
  { pageKey: "assetHub",          path: "/research/asset-hub",       label: "Asset Hub",     group: "Research" },
  { pageKey: "advisor",           path: "/research/compass",         label: "Compass (AI)",  group: "Research" },

  // ── Trading ────────────────────────────────────────────────
  // paperTrading is intentionally separate from any future liveTrading entry.
  { pageKey: "paperTrading",      path: "/research/paper-trading",   label: "Paper Trading", group: "Trading" },
];

/** Returns the pageKey for a given pathname, or null if not permission-gated. */
export function pageKeyForPath(pathname) {
  const route = PAGE_ROUTES.find(
    (r) => pathname === r.path || pathname.startsWith(r.path + "/")
  );
  return route ? route.pageKey : null;
}

/** Returns true if activeAccount can access pageKey. Owners always pass. */
export function canSeePage(activeAccount, pageKey) {
  if (!activeAccount || activeAccount.role === "owner") return true;
  return (activeAccount.pages?.[pageKey] || "none") !== "none";
}

/**
 * Returns the first path the user can access.
 * Owners → /assets/portfolio.
 * Members → first page with read/write permission, or /assets/portfolio as fallback.
 */
export function firstAccessiblePath(activeAccount) {
  if (!activeAccount || activeAccount.role === "owner") return "/assets/portfolio";
  const found = PAGE_ROUTES.find((r) => canSeePage(activeAccount, r.pageKey));
  return found ? found.path : "/assets/portfolio";
}
