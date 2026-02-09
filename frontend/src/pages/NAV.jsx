import { useEffect, useMemo, useState } from "react";

/* ---------------- Theme ---------------- */

const THEME = {
  pageText: "#CBD5F5",
  title: "#F9FAFB",
  muted: "#94A3B8",
  panelBg: "rgba(15, 23, 42, 0.65)",
  panelBorder: "rgba(148, 163, 184, 0.16)",
  rowBorder: "rgba(148, 163, 184, 0.12)",
  inputBg: "rgba(2, 6, 23, 0.45)",
  inputBorder: "rgba(148, 163, 184, 0.18)",
  primaryBg: "rgba(99, 102, 241, 0.18)",
  primaryBorder: "rgba(99, 102, 241, 0.45)",
  dangerBg: "rgba(239, 68, 68, 0.12)",
  dangerBorder: "rgba(239, 68, 68, 0.35)",

  sectionBg: "rgba(30, 41, 59, 0.62)",
  sectionBorder: "rgba(148, 163, 184, 0.26)",

  badgeBg: "rgba(148, 163, 184, 0.10)",
  badgeBorder: "rgba(148, 163, 184, 0.25)",
};

const ASSET_PANEL_TINT = "rgba(34, 197, 94, 0.08)";
const ASSET_PANEL_BORDER = "rgba(34, 197, 94, 0.18)";
const LIAB_PANEL_TINT = "rgba(239, 68, 68, 0.08)";
const LIAB_PANEL_BORDER = "rgba(239, 68, 68, 0.18)";

/**
 * ✅ Fix edit-mode overlap:
 * - Give Actions more fixed room (Cancel/Save wider than Edit/Del)
 * - Reduce Amount a bit
 * - Keep Remarks input constrained (maxWidth: 100%)
 *
 * Head | Amount | Remarks | Actions
 */
const GRID_COLS = "2.3fr 1.6fr 3.4fr 1.7fr";

// Clamp for most cells
const CELL_CLAMP = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// Amount cell: never ellipsis
const AMOUNT_NO_ELLIPSIS = {
  minWidth: 0,
  overflow: "visible",
  textOverflow: "clip",
  whiteSpace: "nowrap",
};

/* ---------------- helpers ---------------- */

function safeNum(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}
function round2(n) {
  return Number(safeNum(n, 0).toFixed(2));
}
function formatMoney(n, currency = "USD") {
  const x = safeNum(n, 0);
  return x.toLocaleString(undefined, { style: "currency", currency });
}
function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

/* ---------------- API helpers ---------------- */

function getApiBase() {
  const envBase = (import.meta.env.VITE_API_BASE_URL || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const winBase = (window.__FINVAULT_API_BASE_URL || "").trim?.() || "";
  if (winBase) return winBase.replace(/\/+$/, "");
  return "";
}

function getAccessToken() {
  return (
    sessionStorage.getItem("finvault.accessToken") ||
    sessionStorage.getItem("access_token") ||
    ""
  );
}

async function apiFetch(path, { method = "GET", body } = {}) {
  const base = getApiBase();
  if (!base) throw new Error("Missing API base. Set VITE_API_BASE_URL in .env");

  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const token = getAccessToken();

  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const text = await res.text().catch(() => "");
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`API returned non-JSON (${res.status})`);
  }

  if (!res.ok) throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
  return data;
}

/* ---------------- Stock/Bullion/Crypto logic ---------------- */

// ---- Stocks ----
function normalizeStockTx(item) {
  return {
    ...item,
    symbol: String(item.symbol || "").toUpperCase().trim(),
    type: String(item.type || "BUY").toUpperCase(),
    shares: safeNum(item.shares, 0),
    price: safeNum(item.price, 0),
    fees: safeNum(item.fees, 0),
    date: String(item.date || "").slice(0, 10),
  };
}

function computeStocksHoldingValue(transactions, quoteMap) {
  const bySymbol = {};
  const txs = [...transactions]
    .map(normalizeStockTx)
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

  for (const t of txs) {
    if (!t.symbol) continue;
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { shares: 0, cost: 0, avg: 0 };
    const s = bySymbol[t.symbol];

    if (t.type === "BUY") {
      const addCost = t.shares * t.price + t.fees;
      s.shares += t.shares;
      s.cost += addCost;
      s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    } else if (t.type === "SELL") {
      const sellShares = Math.min(t.shares, s.shares);
      const basis = sellShares * (s.avg || 0);
      s.shares -= sellShares;
      s.cost -= basis;
      s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    }
  }

  let holdingValue = 0;
  for (const [symbol, s] of Object.entries(bySymbol)) {
    const spot = safeNum(quoteMap?.[symbol]?.price, 0);
    holdingValue += s.shares * spot;
  }
  return round2(holdingValue);
}

// ---- Bullion ----
function normalizeBullTx(item) {
  return {
    ...item,
    type: String(item.type || "").toUpperCase(),
    metal: String(item.metal || "").toUpperCase(),
    quantityOz: safeNum(item.quantityOz, 0),
    unitPrice: safeNum(item.unitPrice, 0),
    fees: safeNum(item.fees, 0),
    date: String(item.date || "").slice(0, 10),
  };
}

function computeBullionHoldingValue(transactions, spot /* { GOLD, SILVER } */) {
  const state = {
    GOLD: { qty: 0, cost: 0, avg: 0 },
    SILVER: { qty: 0, cost: 0, avg: 0 },
  };

  const txs = [...transactions]
    .map(normalizeBullTx)
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

  for (const t of txs) {
    const metal = String(t.metal || "GOLD").toUpperCase();
    const type = String(t.type || "BUY").toUpperCase();
    if (!state[metal]) continue;

    const qty = safeNum(t.quantityOz, 0);
    const price = safeNum(t.unitPrice, 0);
    const fees = safeNum(t.fees, 0);
    const s = state[metal];

    if (type === "BUY") {
      const addCost = qty * price + fees;
      s.qty += qty;
      s.cost += addCost;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    } else if (type === "SELL") {
      const sellQty = Math.min(qty, s.qty);
      const basis = sellQty * (s.avg || 0);
      s.qty -= sellQty;
      s.cost -= basis;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    }
  }

  const goldMV = state.GOLD.qty * safeNum(spot?.GOLD, 0);
  const silverMV = state.SILVER.qty * safeNum(spot?.SILVER, 0);
  return round2(goldMV + silverMV);
}

// ---- Crypto ----
function extractCryptoSpots(pricesResponse) {
  const crypto = pricesResponse?.crypto;
  if (!crypto) return {};

  const arr =
    Array.isArray(crypto)
      ? crypto
      : Array.isArray(crypto?.results)
      ? crypto.results
      : Array.isArray(crypto?.data)
      ? crypto.data
      : null;

  const out = {};

  const writeSpot = (sym, spot) => {
    const s = String(sym || "").toUpperCase().trim();
    if (!s) return;
    const val = safeNum(spot, 0);

    const abs = Math.abs(val);
    const fixed = abs > 0 && abs < 0.01 ? 10 : abs > 0 && abs < 1 ? 6 : 2;
    out[s] = Number(val.toFixed(fixed));
  };

  const readOne = (obj) => {
    const sym = obj?.symbol || obj?.instrument_id || obj?.pair || "";
    if (!sym) return;

    const bid = safeNum(obj?.bid, NaN) ?? safeNum(obj?.best_bid, NaN);
    const ask = safeNum(obj?.ask, NaN) ?? safeNum(obj?.best_ask, NaN);

    const bid2 = safeNum(obj?.bid_inclusive_of_sell_spread, NaN);
    const ask2 = safeNum(obj?.ask_inclusive_of_buy_spread, NaN);

    const b = Number.isFinite(bid) ? bid : Number.isFinite(bid2) ? bid2 : NaN;
    const a = Number.isFinite(ask) ? ask : Number.isFinite(ask2) ? ask2 : NaN;

    let spot = 0;
    if (Number.isFinite(b) && Number.isFinite(a)) spot = (b + a) / 2;
    else if (Number.isFinite(a)) spot = a;
    else if (Number.isFinite(b)) spot = b;

    writeSpot(sym, spot);
  };

  if (arr) {
    arr.forEach(readOne);
    return out;
  }

  if (typeof crypto === "object") {
    Object.entries(crypto).forEach(([sym, obj]) => {
      if (!obj) return;
      readOne({ ...obj, symbol: sym });
    });
  }

  return out;
}

function normalizeCryptoTx(item) {
  const raw = String(item.symbol || "").toUpperCase().trim();
  const symbol = raw ? (raw.includes("-") ? raw : `${raw}-USD`) : "";
  return {
    ...item,
    symbol,
    type: String(item.type || "BUY").toUpperCase(),
    quantity: safeNum(item.quantity, 0),
    unitPrice: safeNum(item.unitPrice, 0),
    fees: safeNum(item.fees, 0),
    date: String(item.date || "").slice(0, 10),
  };
}

function computeCryptoHoldingValue(transactions, spotMap) {
  const bySym = {};
  const txs = [...transactions]
    .map(normalizeCryptoTx)
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

  for (const t of txs) {
    const sym = String(t.symbol || "").toUpperCase().trim();
    if (!sym) continue;

    if (!bySym[sym]) bySym[sym] = { qty: 0, cost: 0, avg: 0 };
    const s = bySym[sym];

    if (t.type === "BUY") {
      const addCost = t.quantity * t.unitPrice + t.fees;
      s.qty += t.quantity;
      s.cost += addCost;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    } else if (t.type === "SELL") {
      const sellQty = Math.min(t.quantity, s.qty);
      const basis = sellQty * (s.avg || 0);
      s.qty -= sellQty;
      s.cost -= basis;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    }
  }

  let holdingValue = 0;
  for (const [sym, s] of Object.entries(bySym)) {
    holdingValue += s.qty * safeNum(spotMap?.[sym], 0);
  }
  return round2(holdingValue);
}

/* ---------------- Default NAV layout ---------------- */

const DEFAULT_USA_ASSETS = [
  { kind: "section", id: "sec_mkt", label: "Market Traded Assets" },
  { kind: "row", id: "usa_schwab", label: "Charles Schwab Trading Acct", amount: 0, remarks: "Charles Schwab", source: "manual" },
  { kind: "row", id: "usa_stocks", label: "Stocks", amount: 0, remarks: "Robinhood - Sanjay (Excludes Crypto)", source: "synced_stocks" },
  { kind: "row", id: "usa_bullion", label: "Bullion", amount: 0, remarks: "Bullion holdings", source: "synced_bullion" },

  { kind: "section", id: "sec_edu", label: "Education" },
  { kind: "row", id: "usa_529", label: "NY 529 Accnt", amount: 0, remarks: "529", source: "manual" },

  { kind: "section", id: "sec_crypto", label: "Crypto" },
  { kind: "row", id: "usa_crypto", label: "Crypto", amount: 0, remarks: "Robinhood - Sanjay", source: "synced_crypto" },

  { kind: "section", id: "sec_fi", label: "Fixed Income" },

  { kind: "section", id: "sec_ret", label: "Retirement" },
  { kind: "row", id: "usa_401k", label: "401K", amount: 0, remarks: "PwC Managed", source: "manual" },
  { kind: "row", id: "usa_wealth", label: "Wealth Builder", amount: 0, remarks: "PwC Managed", source: "manual" },

  { kind: "section", id: "sec_prop", label: "Property" },
  { kind: "row", id: "usa_vienna", label: "Vienna", amount: 0, remarks: "Current value", source: "manual" },
  { kind: "row", id: "usa_mercedes_asset", label: "Mercedes", amount: 0, remarks: "", source: "manual" },
  { kind: "row", id: "usa_triumph_asset", label: "Triumph", amount: 0, remarks: "", source: "manual" },
];

const DEFAULT_USA_LIABS = [
  { kind: "section", id: "sec_loans", label: "Loans" },
  { kind: "row", id: "usa_cfcu", label: "CFCU Loan", amount: 0, remarks: "Vienna - Home Loan with CFCU" },
  { kind: "row", id: "usa_mercedes_loan", label: "Mercedes Loan", amount: 0, remarks: "Auto loan" },
  { kind: "row", id: "usa_triumph_loan", label: "Triumph", amount: 0, remarks: "Closed" },
  { kind: "row", id: "usa_tesla_lease", label: "Tesla Lease", amount: 0, remarks: "Lease ending 12/26" },
  { kind: "row", id: "usa_citi", label: "Citi", amount: 0, remarks: "Credit card balance" },
  { kind: "row", id: "usa_discover", label: "Discover", amount: 0, remarks: "Credit card balance" },
  { kind: "row", id: "usa_apple", label: "Apple", amount: 0, remarks: "Card balance" },
  { kind: "row", id: "usa_amex", label: "Amex", amount: 0, remarks: "Amex Cards" },
  { kind: "row", id: "usa_amzn", label: "Amazon Visa", amount: 0, remarks: "Credit Card" },
  { kind: "row", id: "usa_boa", label: "BoA", amount: 0, remarks: "Credit Card" },
];

const DEFAULT_INDIA_ASSETS = [{ kind: "section", id: "sec_in_mkt", label: "Market Traded Assets" }];
const DEFAULT_INDIA_LIABS = [{ kind: "section", id: "sec_in_loans", label: "Loans" }];

/* ---------------- UI atoms ---------------- */

function Pill({ children }) {
  return (
    <span
      style={{
        fontSize: 11,
        color: THEME.muted,
        border: `1px solid ${THEME.badgeBorder}`,
        background: THEME.badgeBg,
        padding: "2px 8px",
        borderRadius: 999,
        marginLeft: 8,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Button({ children, onClick, kind = "primary", disabled = false, title = "" }) {
  const isDanger = kind === "danger";
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        cursor: disabled ? "not-allowed" : "pointer",
        padding: "7px 10px",
        borderRadius: 10,
        border: `1px solid ${isDanger ? THEME.dangerBorder : THEME.primaryBorder}`,
        background: isDanger ? THEME.dangerBg : THEME.primaryBg,
        color: THEME.title,
        fontWeight: 800,
        fontSize: 12,
        opacity: disabled ? 0.55 : 1,
        whiteSpace: "nowrap",
        lineHeight: 1.1,
      }}
    >
      {children}
    </button>
  );
}

function GhostButton({ children, onClick, disabled = false, title = "" }) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        cursor: disabled ? "not-allowed" : "pointer",
        padding: "7px 10px",
        borderRadius: 10,
        border: `1px solid ${THEME.panelBorder}`,
        background: "transparent",
        color: THEME.title,
        fontWeight: 800,
        fontSize: 12,
        opacity: disabled ? 0.55 : 1,
        whiteSpace: "nowrap",
        lineHeight: 1.1,
      }}
    >
      {children}
    </button>
  );
}

function TextInput({ value, onChange, placeholder = "", readOnly = false }) {
  return (
    <input
      value={value ?? ""}
      readOnly={readOnly}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        maxWidth: "100%",
        boxSizing: "border-box",
        background: readOnly ? "rgba(2,6,23,0.20)" : THEME.inputBg,
        color: THEME.pageText,
        border: `1px solid ${THEME.inputBorder}`,
        borderRadius: 10,
        padding: "8px 10px",
        outline: "none",
        fontSize: 13,
        opacity: readOnly ? 0.9 : 1,
      }}
    />
  );
}

function MoneyInput({ value, onChange, readOnly = false }) {
  const v = value === null || value === undefined ? "" : String(value);
  return (
    <input
      value={v}
      readOnly={readOnly}
      onChange={(e) => {
        if (readOnly) return;
        const raw = e.target.value;
        if (raw === "") return onChange("");
        const cleaned = raw.replace(/[^0-9.]/g, "");
        onChange(cleaned);
      }}
      inputMode="decimal"
      style={{
        width: "100%",
        maxWidth: "100%",
        boxSizing: "border-box",
        textAlign: "right",
        background: readOnly ? "rgba(2,6,23,0.20)" : THEME.inputBg,
        color: THEME.pageText,
        border: `1px solid ${THEME.inputBorder}`,
        borderRadius: 10,
        padding: "8px 10px",
        outline: "none",
        fontSize: 13,
        opacity: readOnly ? 0.9 : 1,
      }}
    />
  );
}

function SummaryCard({ title, value, hint }) {
  return (
    <div
      style={{
        border: `1px solid ${THEME.panelBorder}`,
        background: THEME.panelBg,
        borderRadius: 14,
        padding: 12,
        boxShadow: "0 10px 24px rgba(0,0,0,0.25)",
      }}
    >
      <div style={{ fontSize: 12, color: THEME.muted, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 18, color: THEME.title, fontWeight: 800 }}>{value}</div>
      {hint ? <div style={{ fontSize: 11, color: THEME.muted, marginTop: 6 }}>{hint}</div> : null}
    </div>
  );
}

/* ---------------- Main NAV ---------------- */

export default function NAV() {
  const [filter, setFilter] = useState("ALL");

  const [usaAssets, setUsaAssets] = useState(DEFAULT_USA_ASSETS);
  const [usaLiabs, setUsaLiabs] = useState(DEFAULT_USA_LIABS);
  const [indiaAssets, setIndiaAssets] = useState(DEFAULT_INDIA_ASSETS);
  const [indiaLiabs, setIndiaLiabs] = useState(DEFAULT_INDIA_LIABS);

  const [fixedIncomeItems, setFixedIncomeItems] = useState([]);

  const [stocksHolding, setStocksHolding] = useState(0);
  const [bullionHolding, setBullionHolding] = useState(0);
  const [cryptoHolding, setCryptoHolding] = useState(0);

  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [lastSavedAt, setLastSavedAt] = useState("");

  useEffect(() => {
    (async () => {
      await loadFromDbOrLocal();
      await refreshSynced();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadFromDbOrLocal() {
    try {
      const db = await apiFetch("/nav");
      if (db?.usaAssets && db?.usaLiabs && db?.indiaAssets && db?.indiaLiabs) {
        setUsaAssets(db.usaAssets);
        setUsaLiabs(db.usaLiabs);
        setIndiaAssets(db.indiaAssets);
        setIndiaLiabs(db.indiaLiabs);
        return;
      }
    } catch {
      // ignore
    }

    try {
      const local = JSON.parse(localStorage.getItem("finvault.nav.local") || "null");
      if (local?.usaAssets) setUsaAssets(local.usaAssets);
      if (local?.usaLiabs) setUsaLiabs(local.usaLiabs);
      if (local?.indiaAssets) setIndiaAssets(local.indiaAssets);
      if (local?.indiaLiabs) setIndiaLiabs(local.indiaLiabs);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    localStorage.setItem(
      "finvault.nav.local",
      JSON.stringify({ usaAssets, usaLiabs, indiaAssets, indiaLiabs })
    );
  }, [usaAssets, usaLiabs, indiaAssets, indiaLiabs]);

  async function saveToDb() {
    setLoading(true);
    setStatus("Saving…");
    try {
      await apiFetch("/nav", {
        method: "PUT",
        body: { usaAssets, usaLiabs, indiaAssets, indiaLiabs },
      });
      const ts = new Date().toISOString();
      setLastSavedAt(ts);
      setStatus("Saved.");
    } catch (e) {
      setStatus(`Save failed: ${e?.message || "error"}`);
    } finally {
      setLoading(false);
      setTimeout(() => setStatus(""), 1400);
    }
  }

  async function resetDb() {
    // eslint-disable-next-line no-restricted-globals
    if (!confirm("Delete saved NAV layout from database and revert to defaults?")) return;
    setLoading(true);
    setStatus("Resetting…");
    try {
      await apiFetch("/nav", { method: "DELETE" });
      setUsaAssets(DEFAULT_USA_ASSETS);
      setUsaLiabs(DEFAULT_USA_LIABS);
      setIndiaAssets(DEFAULT_INDIA_ASSETS);
      setIndiaLiabs(DEFAULT_INDIA_LIABS);
      setLastSavedAt("");
      setStatus("Reset complete.");
    } catch (e) {
      setStatus(`Reset failed: ${e?.message || "error"}`);
    } finally {
      setLoading(false);
      setTimeout(() => setStatus(""), 1400);
    }
  }

  async function refreshSynced() {
    setLoading(true);
    setStatus("Refreshing…");
    try {
      const fixedRes = await apiFetch("/assets/fixedincome").catch(() => []);
      const fiItems = Array.isArray(fixedRes?.items) ? fixedRes.items : Array.isArray(fixedRes) ? fixedRes : [];
      setFixedIncomeItems(fiItems);

      const stockTxRes = await apiFetch("/assets/stocks/transactions").catch(() => []);
      const stockTx = Array.isArray(stockTxRes?.items) ? stockTxRes.items : Array.isArray(stockTxRes) ? stockTxRes : [];
      const stockSymbols = Array.from(
        new Set(stockTx.map((t) => String(t.symbol || "").toUpperCase().trim()).filter(Boolean))
      ).sort();

      let stockQuoteMap = {};
      if (stockSymbols.length) {
        const qs = `?stocks=${encodeURIComponent(stockSymbols.join(","))}`;
        const priceRes = await apiFetch(`/prices${qs}`).catch(() => null);
        stockQuoteMap = priceRes?.stocks || {};
      }
      setStocksHolding(computeStocksHoldingValue(stockTx, stockQuoteMap));

      const bullTxRes = await apiFetch("/assets/bullion/transactions").catch(() => []);
      const bullTx = Array.isArray(bullTxRes?.items) ? bullTxRes.items : Array.isArray(bullTxRes) ? bullTxRes : [];
      const pricesRes = await apiFetch("/prices").catch(() => null);

      const goldPrice = safeNum(pricesRes?.gold?.price, 0);
      const silverPrice = safeNum(pricesRes?.silver?.price, 0);
      const spot = { GOLD: round2(goldPrice), SILVER: round2(silverPrice) };
      setBullionHolding(computeBullionHoldingValue(bullTx, spot));

      const cryptoTxRes = await apiFetch("/assets/crypto/transactions").catch(() => []);
      const cryptoTx = Array.isArray(cryptoTxRes?.items) ? cryptoTxRes.items : Array.isArray(cryptoTxRes) ? cryptoTxRes : [];

      const wanted = new Set();
      cryptoTx.forEach((t) => {
        const raw = String(t.symbol || "").toUpperCase().trim();
        if (!raw) return;
        wanted.add(raw.includes("-") ? raw : `${raw}-USD`);
      });

      const cryptoList = Array.from(wanted);
      const limited = (cryptoList.length ? cryptoList : ["BTC-USD", "ETH-USD"]).slice(0, 25);

      const cQs = `?crypto=${encodeURIComponent(limited.join(","))}`;
      const cRes = await apiFetch(`/prices${cQs}`).catch(() => null);

      const spotMap = extractCryptoSpots(cRes || {});
      setCryptoHolding(computeCryptoHoldingValue(cryptoTx, spotMap));

      setStatus("Updated.");
    } catch (e) {
      setStatus(`Refresh failed: ${e?.message || "error"}`);
    } finally {
      setLoading(false);
      setTimeout(() => setStatus(""), 1400);
    }
  }

  useEffect(() => {
    setUsaAssets((prev) =>
      prev.map((r) => {
        if (r.kind !== "row") return r;
        if (r.source === "synced_stocks") return { ...r, amount: stocksHolding };
        if (r.source === "synced_bullion") return { ...r, amount: bullionHolding };
        if (r.source === "synced_crypto") return { ...r, amount: cryptoHolding };
        return r;
      })
    );
  }, [stocksHolding, bullionHolding, cryptoHolding]);

  const fixedIncomeTotal = useMemo(
    () => round2((fixedIncomeItems || []).reduce((a, it) => a + safeNum(it.currentValue, 0), 0)),
    [fixedIncomeItems]
  );

  function sumRows(rows) {
    let sum = 0;
    for (const r of rows) if (r.kind === "row") sum += safeNum(r.amount, 0);
    return round2(sum);
  }
  function sumLiabs(rows) {
    let sum = 0;
    for (const r of rows) if (r.kind === "row") sum += safeNum(r.amount, 0);
    return round2(sum);
  }

  const usaTotals = useMemo(() => {
    const assets = round2(sumRows(usaAssets) + fixedIncomeTotal);
    const liabs = sumLiabs(usaLiabs);
    return { assets, liabs, net: round2(assets - liabs) };
  }, [usaAssets, usaLiabs, fixedIncomeTotal]);

  const indiaTotals = useMemo(() => {
    const assets = sumRows(indiaAssets);
    const liabs = sumLiabs(indiaLiabs);
    return { assets, liabs, net: round2(assets - liabs) };
  }, [indiaAssets, indiaLiabs]);

  const showUSA = filter === "ALL" || filter === "USA";
  const showINDIA = filter === "ALL" || filter === "INDIA";

  return (
    <div style={{ padding: 16, color: THEME.pageText }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 20, fontWeight: 900, color: THEME.title }}>Net Asset Value</div>
        <Pill>Net worth</Pill>

        <div style={{ flex: 1 }} />

        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            background: THEME.inputBg,
            color: THEME.pageText,
            border: `1px solid ${THEME.inputBorder}`,
            borderRadius: 10,
            padding: "8px 10px",
            outline: "none",
            fontSize: 13,
          }}
        >
          <option value="ALL">All</option>
          <option value="USA">USA</option>
          <option value="INDIA">India</option>
        </select>

        <GhostButton onClick={refreshSynced} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </GhostButton>
        <GhostButton onClick={loadFromDbOrLocal} disabled={loading}>
          Load
        </GhostButton>
        <Button onClick={saveToDb} disabled={loading}>
          Save
        </Button>
        <Button kind="danger" onClick={resetDb} disabled={loading}>
          Reset
        </Button>

        {status ? <div style={{ color: THEME.muted, fontSize: 12 }}>{status}</div> : null}
      </div>

      {lastSavedAt ? (
        <div style={{ color: THEME.muted, fontSize: 12, marginBottom: 10 }}>
          Last saved: {lastSavedAt}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(240px, 1fr))", gap: 12, marginBottom: 14 }}>
        <SummaryCard
          title="Total USA Networth"
          value={showUSA ? formatMoney(usaTotals.net, "USD") : "—"}
          hint={showUSA ? `Assets ${formatMoney(usaTotals.assets)} • Liabilities ${formatMoney(usaTotals.liabs)}` : "Filter to USA or All"}
        />
        <SummaryCard
          title="Total India Networth"
          value={showINDIA ? formatMoney(indiaTotals.net, "USD") : "—"}
          hint={showINDIA ? `Assets ${formatMoney(indiaTotals.assets)} • Liabilities ${formatMoney(indiaTotals.liabs)}` : "Filter to India or All"}
        />
      </div>

      {showUSA ? (
        <RegionBlock
          title="USA"
          currency="USD"
          assetsRows={usaAssets}
          setAssetsRows={setUsaAssets}
          liabRows={usaLiabs}
          setLiabRows={setUsaLiabs}
          fixedIncomeItems={fixedIncomeItems}
          fixedIncomeTotal={fixedIncomeTotal}
        />
      ) : null}

      {showINDIA ? (
        <div style={{ marginTop: 14 }}>
          <RegionBlock
            title="India"
            currency="USD"
            assetsRows={indiaAssets}
            setAssetsRows={setIndiaAssets}
            liabRows={indiaLiabs}
            setLiabRows={setIndiaLiabs}
            fixedIncomeItems={[]}
            fixedIncomeTotal={0}
          />
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- RegionBlock ---------------- */

function RegionBlock({
  title,
  currency,
  assetsRows,
  setAssetsRows,
  liabRows,
  setLiabRows,
  fixedIncomeItems,
  fixedIncomeTotal,
}) {
  return (
    <div
      style={{
        border: `1px solid ${THEME.panelBorder}`,
        background: THEME.panelBg,
        borderRadius: 16,
        padding: 14,
      }}
    >


      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <TablePanel
          title="Assets"
          currency={currency}
          tintBg={ASSET_PANEL_TINT}
          tintBorder={ASSET_PANEL_BORDER}
          rows={assetsRows}
          setRows={setAssetsRows}
          showFixedIncome={true}
          fixedIncomeItems={fixedIncomeItems}
          fixedIncomeTotal={fixedIncomeTotal}
        />
        <TablePanel
          title="Liabilities"
          currency={currency}
          tintBg={LIAB_PANEL_TINT}
          tintBorder={LIAB_PANEL_BORDER}
          rows={liabRows}
          setRows={setLiabRows}
          showFixedIncome={false}
          fixedIncomeItems={[]}
          fixedIncomeTotal={0}
        />
      </div>
    </div>
  );
}

/* ---------------- TablePanel ---------------- */

function TablePanel({
  title,
  currency,
  tintBg,
  tintBorder,
  rows,
  setRows,
  showFixedIncome,
  fixedIncomeItems,
  fixedIncomeTotal,
}) {
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({ label: "", amount: "", remarks: "" });

  function addSection() {
    setRows((prev) => [...prev, { kind: "section", id: uid("sec"), label: "New Section" }]);
  }

  function addRowBottom() {
    setRows((prev) => [
      ...prev,
      { kind: "row", id: uid("row"), label: "New Item", amount: "", remarks: "", source: "manual" },
    ]);
  }

  function addRowAfterSection(sectionId) {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.id === sectionId);
      const newRow = { kind: "row", id: uid("row"), label: "New Item", amount: "", remarks: "", source: "manual" };
      if (idx === -1) return [...prev, newRow];
      const copy = [...prev];
      copy.splice(idx + 1, 0, newRow);
      return copy;
    });
  }

  function deleteRow(id) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setDraft({ label: "", amount: "", remarks: "" });
    }
  }

  function deleteSectionCascade(sectionId) {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.id === sectionId && r.kind === "section");
      if (idx === -1) return prev;

      let end = idx + 1;
      while (end < prev.length && prev[end].kind !== "section") end += 1;

      const copy = [...prev];
      copy.splice(idx, end - idx);
      return copy;
    });
  }

  function startEdit(row) {
    const isSynced = String(row.source || "").startsWith("synced_");
    setEditingId(row.id);
    setDraft({
      label: row.label ?? "",
      amount: isSynced ? row.amount ?? 0 : String(row.amount ?? ""),
      remarks: row.remarks ?? "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft({ label: "", amount: "", remarks: "" });
  }

  function saveEdit(row) {
    const isSynced = String(row.source || "").startsWith("synced_");

    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== row.id) return r;
        if (isSynced) return { ...r, remarks: draft.remarks };
        return { ...r, label: draft.label, amount: draft.amount, remarks: draft.remarks };
      })
    );
    cancelEdit();
  }

  return (
    <div
      style={{
        border: `1px solid ${tintBorder}`,
        background: `linear-gradient(180deg, ${tintBg}, rgba(2,6,23,0.18))`,
        borderRadius: 16,
        padding: 14,
        boxShadow: "0 10px 24px rgba(0,0,0,0.22)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>{title}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <GhostButton onClick={addSection}>Add Section</GhostButton>
          <GhostButton onClick={addRowBottom}>Add Row</GhostButton>
        </div>
      </div>

      {/* Headers (bold + underline on Head/Amount/Remarks; Actions not underlined) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: GRID_COLS,
          gap: 8,
          padding: "8px 10px",
          borderBottom: `1px solid ${THEME.rowBorder}`,
          color: THEME.title,
          fontSize: 12,
          fontWeight: 900,
          minWidth: 0,
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            ...CELL_CLAMP,
            textAlign: "center",
            textDecoration: "underline",
            textUnderlineOffset: 4,
          }}
        >
          Head
        </div>
        <div
          style={{
            ...AMOUNT_NO_ELLIPSIS,
            textAlign: "center",
            textDecoration: "underline",
            textUnderlineOffset: 4,
          }}
        >
          Amount
        </div>
        <div
          style={{
            ...CELL_CLAMP,
            textAlign: "center",
            textDecoration: "underline",
            textUnderlineOffset: 4,
          }}
        >
          Remarks
        </div>
        <div style={{ ...CELL_CLAMP, textAlign: "center" }}>Actions</div>
      </div>

      <div style={{ marginTop: 8 }}>
        {rows.map((r) => {
          if (r.kind === "section") {
            const isFixedIncome =
              showFixedIncome && String(r.label || "").trim().toLowerCase() === "fixed income";

            return (
              <div key={r.id} style={{ marginTop: 10 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "10px 10px",
                    borderRadius: 12,
                    border: `1px solid ${THEME.sectionBorder}`,
                    background: THEME.sectionBg,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, ...CELL_CLAMP }}>
                    <div style={{ fontSize: 14, fontWeight: 950, letterSpacing: "0.2px", color: THEME.title }}>
                      {r.label}
                    </div>
                    {isFixedIncome ? <Pill>synced</Pill> : null}
                  </div>

                  <div style={{ display: "flex", gap: 8 }}>
                    <GhostButton onClick={() => addRowAfterSection(r.id)}>Add row</GhostButton>
                    <Button kind="danger" onClick={() => deleteSectionCascade(r.id)}>
                      Delete section
                    </Button>
                  </div>
                </div>

                {isFixedIncome ? (
                  <div
                    style={{
                      marginTop: 10,
                      border: `1px solid ${THEME.rowBorder}`,
                      borderRadius: 12,
                      background: "rgba(2,6,23,0.20)",
                      padding: 10,
                    }}
                  >
                    {(fixedIncomeItems || []).length === 0 ? (
                      <div style={{ color: THEME.muted, fontSize: 12 }}>No fixed income records.</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {(fixedIncomeItems || []).map((it) => {
                          const name =
                            it.name || it.accountName || it.institution || it.assetId || "Fixed Income";
                          const cv = safeNum(it.currentValue, 0);
                          const notes = it.notes || it.note || it.interestType || "";

                          return (
                            <div
                              key={it.assetId || it.id || name}
                              style={{
                                display: "grid",
                                gridTemplateColumns: "1.3fr 0.9fr 1.1fr",
                                gap: 10,
                                alignItems: "center",
                                padding: "10px 10px",
                                border: `1px solid ${THEME.rowBorder}`,
                                borderRadius: 12,
                                background: "rgba(15,23,42,0.35)",
                              }}
                            >
                              <div style={{ color: THEME.pageText, fontSize: 13, ...CELL_CLAMP }}>
                                {String(name)}
                              </div>
                              <div
                                style={{
                                  textAlign: "right",
                                  color: THEME.pageText,
                                  fontSize: 13,
                                  fontWeight: 800,
                                  ...AMOUNT_NO_ELLIPSIS,
                                }}
                              >
                                {formatMoney(cv, currency)}
                              </div>
                              <div style={{ color: THEME.muted, fontSize: 12, ...CELL_CLAMP }}>
                                {String(notes || "")}
                              </div>
                            </div>
                          );
                        })}

                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                          <div style={{ color: THEME.title, fontWeight: 900 }}>
                            Total: {formatMoney(fixedIncomeTotal, currency)}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            );
          }

          const isSynced = String(r.source || "").startsWith("synced_");
          const isEditing = editingId === r.id;

          return (
            <div
              key={r.id}
              style={{
                display: "grid",
                gridTemplateColumns: GRID_COLS,
                gap: 8,
                padding: "10px 10px",
                alignItems: "center",
                borderBottom: `1px solid ${THEME.rowBorder}`,
                minWidth: 0,
                width: "100%",
                boxSizing: "border-box",
              }}
            >
              {/* Head */}
              <div style={{ ...CELL_CLAMP }}>
                {isEditing ? (
                  <TextInput
                    value={draft.label}
                    onChange={(v) => setDraft((d) => ({ ...d, label: v }))}
                    readOnly={isSynced}
                  />
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, ...CELL_CLAMP }}>
                    <div style={{ color: THEME.pageText, fontSize: 13, fontWeight: 600, ...CELL_CLAMP }}>
                      {r.label}
                    </div>
                    {isSynced ? <Pill>synced</Pill> : null}
                  </div>
                )}
              </div>

              {/* Amount (full visible) */}
              <div style={{ ...AMOUNT_NO_ELLIPSIS }}>
                {isEditing ? (
                  <MoneyInput
                    value={draft.amount}
                    onChange={(v) => setDraft((d) => ({ ...d, amount: v }))}
                    readOnly={isSynced}
                  />
                ) : (
                  <div
                    style={{
                      textAlign: "right",
                      color: THEME.pageText,
                      fontSize: 13,
                      fontWeight: 800,
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: `1px solid ${THEME.rowBorder}`,
                      background: "rgba(2,6,23,0.18)",
                      ...AMOUNT_NO_ELLIPSIS,
                    }}
                  >
                    {formatMoney(safeNum(r.amount, 0), currency)}
                  </div>
                )}
              </div>

              {/* Remarks (constrained so it can't overlap Actions) */}
              <div style={{ minWidth: 0, maxWidth: "100%", boxSizing: "border-box" }}>
                {isEditing ? (
                  <TextInput
                    value={draft.remarks}
                    onChange={(v) => setDraft((d) => ({ ...d, remarks: v }))}
                    placeholder="Comments / remarks"
                  />
                ) : (
                  <div style={{ color: THEME.muted, fontSize: 12, ...CELL_CLAMP }}>
                    {r.remarks || ""}
                  </div>
                )}
              </div>

              {/* Actions (right aligned, fixed horizontal, no wrap) */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                  flexWrap: "nowrap",
                  alignItems: "center",
                  minWidth: 0,
                }}
              >
                {!isEditing ? (
                  <>
                    <GhostButton title="Edit" onClick={() => startEdit(r)}>
                      Edit
                    </GhostButton>
                    <Button title="Delete" kind="danger" onClick={() => deleteRow(r.id)}>
                      Del
                    </Button>
                  </>
                ) : (
                  <>
                    <GhostButton title="Cancel" onClick={cancelEdit}>
                      Cancel
                    </GhostButton>
                    <Button title="Save" onClick={() => saveEdit(r)}>
                      Save
                    </Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
