/**
 * finVault API client
 * Single place for all authenticated API calls.
 * Used by React Query hooks across all pages.
 */

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

function getAccessToken() {
  return (
    sessionStorage.getItem("finvault.accessToken") ||
    sessionStorage.getItem("access_token") ||
    ""
  );
}

/**
 * apiFetch — authenticated fetch wrapper.
 * Throws an Error (with .status) on non-2xx responses.
 */
export async function apiFetch(path, { method = "GET", body } = {}) {
  const token = getAccessToken();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  });

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

export const api = {
  get:    (path)         => apiFetch(path),
  post:   (path, body)   => apiFetch(path, { method: "POST",   body }),
  patch:  (path, body)   => apiFetch(path, { method: "PATCH",  body }),
  put:    (path, body)   => apiFetch(path, { method: "PUT",    body }),
  delete: (path)         => apiFetch(path, { method: "DELETE" }),
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
};
