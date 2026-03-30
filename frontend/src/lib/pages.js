/**
 * Ordered list of all permission-gated page routes.
 * Order determines which page a restricted member lands on by default.
 */
export const PAGE_ROUTES = [
  { pageKey: "portfolio",         path: "/assets/portfolio" },
  { pageKey: "stocks",            path: "/assets/stocks" },
  { pageKey: "crypto",            path: "/assets/crypto" },
  { pageKey: "bullion",           path: "/assets/bullion" },
  { pageKey: "futures",           path: "/assets/futures" },
  { pageKey: "options",           path: "/assets/options" },
  { pageKey: "fixedIncome",       path: "/assets/fixedincome" },
  { pageKey: "otherAssets",       path: "/assets/otherassets" },
  { pageKey: "capitalGains",      path: "/assets/capital-gains" },
  { pageKey: "nav",               path: "/nav/dashboard" },
  { pageKey: "liabilities",       path: "/liabilities/dashboard" },
  { pageKey: "insurance",         path: "/insurance/dashboard" },
  { pageKey: "spendingDashboard", path: "/spending/dashboard" },
  { pageKey: "receiptsLedger",    path: "/spending/receipts-ledger" },
  { pageKey: "wheelScan",         path: "/research/wheel-scan" },
  { pageKey: "assetHub",          path: "/research/asset-hub" },
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
