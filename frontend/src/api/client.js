/**
 * finVault API client
 * Single place for all authenticated API calls.
 * Used by React Query hooks across all pages.
 */

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

function getAccessToken() {
  // Send the ID token as Bearer — it contains verified claims (email, sub)
  // and its audience matches the Cognito client ID configured on the JWT authorizer.
  return (
    sessionStorage.getItem("finvault.idToken") ||
    sessionStorage.getItem("id_token") ||
    sessionStorage.getItem("finvault.accessToken") ||
    sessionStorage.getItem("access_token") ||
    ""
  );
}

function getActiveAccountId() {
  return sessionStorage.getItem("finvault.activeAccountId") || "";
}


/**
 * apiFetch — authenticated fetch wrapper.
 * Throws an Error (with .status) on non-2xx responses.
 * On 401, clears the session and redirects to Cognito logout immediately.
 *
 * Pass `accountId` in opts to override the active account header for a
 * specific call (used by AccountsPage to manage non-active accounts).
 */
export async function apiFetch(path, { method = "GET", body, accountId: accountIdOverride } = {}) {
  const token = getAccessToken();
  const accountId = accountIdOverride !== undefined ? accountIdOverride : getActiveAccountId();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (accountId) headers["X-Account-Id"] = accountId;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 401) {
    // Session expired — clear tokens and redirect to Cognito logout
    sessionStorage.removeItem("finvault.accessToken");
    sessionStorage.removeItem("finvault.idToken");
    sessionStorage.removeItem("finvault.refreshToken");
    sessionStorage.removeItem("access_token");
    sessionStorage.removeItem("id_token");
    const domain    = import.meta.env.VITE_COGNITO_DOMAIN;
    const clientId  = import.meta.env.VITE_COGNITO_CLIENT_ID;
    const logoutUri = import.meta.env.VITE_COGNITO_LOGOUT_URI ||
      new URL(import.meta.env.BASE_URL || "/", window.location.origin).toString();
    window.location.assign(
      `${domain}/logout?client_id=${encodeURIComponent(clientId)}&logout_uri=${encodeURIComponent(logoutUri)}`
    );
    // Return a never-resolving promise so no downstream code runs
    return new Promise(() => {});
  }

  if (!res.ok) {
    const err = new Error(`API ${method} ${path} → ${res.status}`);
    err.status = res.status;
    try { err.detail = await res.json(); } catch (_) {}
    throw err;
  }

  // 204 No Content → return null
  if (res.status === 204) return null;
  return res.json();
}

// ── Convenience helpers ──────────────────────────────────────
// All helpers accept an optional `opts` object (e.g. `{ accountId }`) as the
// last argument so callers can override the X-Account-Id header for a specific
// call without touching the global active-account state.

export const api = {
  get:    (path, opts)       => apiFetch(path, opts || {}),
  post:   (path, body, opts) => apiFetch(path, { method: "POST",   body, ...(opts || {}) }),
  patch:  (path, body, opts) => apiFetch(path, { method: "PATCH",  body, ...(opts || {}) }),
  put:    (path, body, opts) => apiFetch(path, { method: "PUT",    body, ...(opts || {}) }),
  delete: (path, opts)       => apiFetch(path, { method: "DELETE", ...(opts || {}) }),
};

// ── React Query key factory ──────────────────────────────────
// Centralising keys makes cache invalidation reliable.
export const queryKeys = {
  // Assets
  stocksTx:      () => ["assets", "stocks", "transactions"],
  bullionTx:     () => ["assets", "bullion", "transactions"],
  cryptoTx:      () => ["assets", "crypto", "transactions"],
  fixedIncome:   () => ["assets", "fixedincome"],
  otherAssets:   () => ["assets", "otherassets"],
  optionsTx:     () => ["assets", "options", "transactions"],
  futuresTx:     () => ["assets", "futures", "transactions"],
  insurance:     () => ["assets", "insurance"],
  nav:           () => ["nav"],
  liabilities:   () => ["liabilities"],

  // Prices — symbol-aware so different symbol lists cache separately
  prices: (stockSymbols = [], cryptoSymbols = []) => [
    "prices",
    stockSymbols.slice().sort().join(","),
    cryptoSymbols.slice().sort().join(","),
  ],

  // Accounts
  accounts:  ()          => ["accounts"],
  members:   (accountId) => ["accounts", accountId, "members"],
  invites:   (accountId) => ["accounts", accountId, "invites"],
};
