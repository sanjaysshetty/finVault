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
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function safeNum(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function round2(n) {
  return Number(safeNum(n, 0).toFixed(2));
}

function formatMoney(n) {
  const x = safeNum(n, 0);
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function plColor(v) {
  // Mimic Portfolio.jsx gain/loss coloring
  return safeNum(v, 0) < 0 ? "rgba(248,113,113,0.95)" : "rgba(134,239,172,0.95)";
}


function formatSpot(n) {
  const x = safeNum(n, 0);
  if (!Number.isFinite(x) || x === 0) return "$0.00";
  const abs = Math.abs(x);
  const digits =
    abs > 0 && abs < 0.01 ? 10 : abs > 0 && abs < 1 ? 6 : 2;
  return x.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/* ---------------- API ---------------- */

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

  if (!res.ok) {
    throw new Error(
      data?.error || data?.message || `Request failed (${res.status})`
    );
  }

  return data;
}

/* ---------------- Prices parsing (dynamic; no hardcoded symbols) ---------------- */

/**
 * Your /prices lambda returns `crypto` (Robinhood best_bid_ask or a map).
 * We parse ALL symbols we can find and return a map: { "BTC-USD": 43000.12, ... }.
 */
function extractCryptoSpots(pricesResponse) {
  const crypto = pricesResponse?.crypto;
  if (!crypto) return {};

  // Possible shapes:
  // 1) { results: [ { symbol: "BTC-USD", bid: "...", ask: "..." }, ... ] }
  // 2) [ { symbol: "BTC-USD", bid_inclusive_of_sell_spread: ..., ask_inclusive_of_buy_spread: ... }, ... ]
  // 3) { "BTC-USD": {...}, "ETH-USD": {...} }
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
    // Dynamic precision so tiny coins don't render as 0.00
    const abs = Math.abs(val);
    const fixed =
      abs > 0 && abs < 0.01 ? 10 : abs > 0 && abs < 1 ? 6 : 2;

    out[s] = Number(val.toFixed(fixed));
  };

  const readOne = (obj) => {
    const sym = obj?.symbol || obj?.instrument_id || obj?.pair || "";
    if (!sym) return;

    const bid =
      safeNum(obj?.bid, NaN) ?? safeNum(obj?.best_bid, NaN);
    const ask =
      safeNum(obj?.ask, NaN) ?? safeNum(obj?.best_ask, NaN);

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

/* ---------------- Domain calcs ---------------- */

const DEFAULT_FORM = {
  type: "BUY",
  symbol: "",
  date: todayISO(),
  quantity: "",
  unitPrice: "",
  fees: "",
  notes: "",
};

function normalizeTx(item) {
  const raw = String(item.symbol || "").toUpperCase().trim();
  const symbol = raw ? (raw.includes("-") ? raw : `${raw}-USD`) : "";

  return {
    ...item,
    id: item.txId || item.assetId || item.id,
    symbol,
    type: String(item.type || "BUY").toUpperCase(),
  };
}

function buildCryptoSymbolListFromTx(txList, formSymbol) {
  const wanted = new Set();

  (txList || []).forEach((t) => {
    const raw = String(t.symbol || "").toUpperCase().trim();
    if (!raw) return;
    wanted.add(raw.includes("-") ? raw : `${raw}-USD`);
  });

  const f = String(formSymbol || "").toUpperCase().trim();
  if (f) wanted.add(f.includes("-") ? f : `${f}-USD`);

  const list = Array.from(wanted);
  return (list.length ? list : ["BTC-USD", "ETH-USD"]).slice(0, 25);
}

/**
 * Moving-average cost method per symbol.
 * Realized P/L is computed at each SELL using current avg cost basis.
 */
function computeCryptoMetrics(transactions, spotMap) {
  const bySym = {};

  const txs = [...transactions].sort((a, b) =>
    String(a.date || "").localeCompare(String(b.date || ""))
  );

  for (const t of txs) {
    const sym = String(t.symbol || "").toUpperCase().trim();
    if (!sym) continue;

    const type = String(t.type || "BUY").toUpperCase();
    const qty = safeNum(t.quantity, 0);
    const px = safeNum(t.unitPrice, 0);
    const fees = safeNum(t.fees, 0);

    if (!bySym[sym]) {
      bySym[sym] = { qty: 0, cost: 0, avg: 0, realized: 0, buys: 0, sells: 0 };
    }
    const s = bySym[sym];

    if (type === "BUY") {
      const addCost = qty * px + fees;
      s.qty += qty;
      s.cost += addCost;
      s.buys += 1;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    } else if (type === "SELL") {
      const sellQty = Math.min(qty, s.qty);
      const proceeds = sellQty * px - fees;
      const basis = sellQty * (s.avg || 0);
      const realized = proceeds - basis;

      s.qty -= sellQty;
      s.cost -= basis;
      s.sells += 1;
      s.realized += realized;
      s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    }
  }

  const holdings = Object.entries(bySym)
    .map(([sym, s]) => {
      const spot = safeNum(spotMap?.[sym], 0);
      const mv = s.qty * spot;
      const unrl = (spot - (s.avg || 0)) * s.qty;
      return {
        symbol: sym,
        qty: s.qty,
        avgCost: s.avg,
        spot,
        marketValue: mv,
        unrealized: unrl,
        realized: s.realized,
        buys: s.buys,
        sells: s.sells,
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);

  const totals = holdings.reduce(
    (acc, h) => {
      acc.holdingValue += h.marketValue;
      acc.unrealized += h.unrealized;
      acc.realized += h.realized;
      return acc;
    },
    { holdingValue: 0, unrealized: 0, realized: 0 }
  );

  return {
    holdings,
    totals: {
      holdingValue: round2(totals.holdingValue),
      unrealized: round2(totals.unrealized),
      realized: round2(totals.realized),
      totalPL: round2(totals.unrealized + totals.realized),
    },
  };
}

/* ---------------- Component ---------------- */

export default function Crypto() {
  const [tx, setTx] = useState([]);
  const [spots, setSpots] = useState({});
  const [spotStatus, setSpotStatus] = useState("");

  const [form, setForm] = useState(DEFAULT_FORM);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");

  const availableSymbols = useMemo(() => {
    const set = new Set();

    tx.forEach((t) => {
      const s = String(t.symbol || "").toUpperCase().trim();
      if (s) set.add(s);
    });

    Object.keys(spots || {}).forEach((s) => {
      const sym = String(s || "").toUpperCase().trim();
      if (sym) set.add(sym);
    });

    const fSym = String(form.symbol || "").toUpperCase().trim();
    if (fSym) set.add(fSym);

    return Array.from(set).sort();
  }, [tx, spots, form.symbol]);

  const metrics = useMemo(() => computeCryptoMetrics(tx, spots), [tx, spots]);

  const filteredSortedTx = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = tx;

    if (q) {
      list = list.filter((t) => {
        const hay = `${t.type || ""} ${t.symbol || ""} ${t.notes || ""}`.toLowerCase();
        return hay.includes(q);
      });
    }

    const dir = sortDir === "asc" ? 1 : -1;

    const getVal = (t) => {
      switch (sortKey) {
        case "symbol":
          return t.symbol || "";
        case "type":
          return t.type || "";
        case "quantity":
          return safeNum(t.quantity, 0);
        case "unitPrice":
          return safeNum(t.unitPrice, 0);
        case "date":
        default:
          return t.date || "";
      }
    };

    return [...list].sort((a, b) => {
      const va = getVal(a);
      const vb = getVal(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [tx, search, sortKey, sortDir]);

  useEffect(() => {
    let alive = true;

    async function loadAll() {
      setLoading(true);
      setError("");
      setSpotStatus("");

      try {
        const txRes = await apiFetch("/assets/crypto/transactions");
        if (!alive) return;

        const list = Array.isArray(txRes?.items)
          ? txRes.items
          : Array.isArray(txRes)
          ? txRes
          : [];

        const norm = list.map(normalizeTx);
        setTx(norm);

        // Pick a good default symbol for the form (first from tx, else empty)
        if (!form.symbol) {
          const first = norm.map((t) => t.symbol).filter(Boolean).sort()[0] || "";
          if (first) setForm((f) => ({ ...f, symbol: first }));
        }

        await refreshSpots(norm);
      } catch (e) {
        if (!alive) return;
        setError(e?.message || "Failed to load crypto transactions");
        setTx([]);
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    }

    loadAll();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
  // Skip initial empty state
  if (!tx || tx.length === 0) return;

  refreshSpots(tx);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [tx]);

  async function refreshTxList() {
    const txRes = await apiFetch("/assets/crypto/transactions");
    const list = Array.isArray(txRes?.items)
      ? txRes.items
      : Array.isArray(txRes)
      ? txRes
      : [];
    setTx(list.map(normalizeTx));
  }

async function refreshSpots(txOverride) {
  try {
    setSpotStatus("Refreshing spot prices…");

    // Use txOverride if provided (first-load), else use state `tx`
    const baseTx = Array.isArray(txOverride) ? txOverride : tx;

    const symbols = buildCryptoSymbolListFromTx(baseTx, form.symbol);
    const prices = await apiFetch(
      `/prices?crypto=${encodeURIComponent(symbols.join(","))}`
    );

    const spotMap = extractCryptoSpots(prices);
    setSpots((prev) => ({ ...prev, ...spotMap }));

    // If form symbol is empty, pick one from prices
    if (!String(form.symbol || "").trim()) {
      const keys = Object.keys(spotMap || {}).sort();
      if (keys[0]) setForm((f) => ({ ...f, symbol: keys[0] }));
    }

    setSpotStatus("Spot prices refreshed.");
  } catch (e) {
    setSpotStatus(
      e?.message ? `Spot refresh failed: ${e.message}` : "Spot refresh failed."
    );
  }
}


  function resetForm() {
    setForm((prev) => ({
      ...DEFAULT_FORM,
      // keep current symbol if user already picked one
      symbol: prev.symbol || "",
    }));
    setEditingId(null);
    setError("");
  }

  function closeForm() {
    setShowForm(false);
    resetForm();
  }

  function openCreateForm() {
    setError("");
    setEditingId(null);
    setForm((prev) => ({
      ...DEFAULT_FORM,
      symbol: prev.symbol || availableSymbols[0] || "",
    }));
    setShowForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  function startEdit(t) {
    setError("");
    setEditingId(t.id);
    setForm({
      type: String(t.type || "BUY").toUpperCase(),
      symbol: String(t.symbol || "").toUpperCase(),
      date: t.date || todayISO(),
      quantity: String(t.quantity ?? ""),
      unitPrice: String(t.unitPrice ?? ""),
      fees: String(t.fees ?? ""),
      notes: t.notes || "",
    });
    setShowForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  function buildPayloadFromForm() {
    const symbol = String(form.symbol || "").toUpperCase().trim();
    const quantity = safeNum(form.quantity, NaN);
    const unitPrice = safeNum(form.unitPrice, NaN);
    const fees = safeNum(form.fees, 0);
    const type = String(form.type || "").toUpperCase();

    if (!symbol) throw new Error("Symbol is required (e.g., BTC-USD)");
    if (!form.date) throw new Error("Date is required");
    if (!["BUY", "SELL"].includes(type)) throw new Error("Type must be BUY or SELL");
    if (!Number.isFinite(quantity) || quantity <= 0)
      throw new Error("Quantity must be a positive number");
    if (!Number.isFinite(unitPrice) || unitPrice <= 0)
      throw new Error("Unit Price must be a positive number");
    if (!Number.isFinite(fees) || fees < 0) throw new Error("Fees must be valid");

    return {
      type,
      symbol,
      date: form.date,
      quantity: Number(quantity.toFixed(8)), // crypto precision
      unitPrice: Number(unitPrice.toFixed(2)),
      fees: Number(fees.toFixed(2)),
      notes: form.notes?.trim() || "",
    };
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setSaving(true);

    try {
      const payload = buildPayloadFromForm();

      if (editingId) {
        await apiFetch(
          `/assets/crypto/transactions/${encodeURIComponent(editingId)}`,
          { method: "PATCH", body: payload }
        );
      } else {
        await apiFetch("/assets/crypto/transactions", {
          method: "POST",
          body: payload,
        });
      }

      await refreshTxList();
      await refreshSpots();
      closeForm();
    } catch (err) {
      setError(err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id) {
    setError("");
    const okDel = window.confirm("Delete this crypto transaction?");
    if (!okDel) return;

    try {
      setSaving(true);
      await apiFetch(`/assets/crypto/transactions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      await refreshTxList();
      if (editingId === id) closeForm();
    } catch (err) {
      setError(err?.message || "Delete failed");
    } finally {
      setSaving(false);
    }
  }

  const asOfDate = todayISO();

  return (
    <div style={{ padding: 16, color: THEME.pageText }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 900,
              color: THEME.title,
              letterSpacing: "0.2px",
            }}
          >
            Crypto
          </div>
        </div>
        <div style={{ fontSize: 12, color: THEME.muted, textAlign: "right" }}>
          As of{" "}
          <span style={{ color: THEME.pageText, fontWeight: 700 }}>
            {asOfDate}
          </span>
        </div>
      </div>

      {/* Summary cards */}
      <div
        style={{
          marginTop: 14,
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(180px, 1fr))",
          gap: 12,
        }}
      >
        <SummaryCard
          title="Total Holding Value"
          value={formatMoney(metrics.totals.holdingValue)}
          hint="Based on latest spot prices"
        />
        <SummaryCard
          title="Unrealized Gain/Loss"
          value={formatMoney(metrics.totals.unrealized)}
          hint="Spot vs. avg cost"
         valueColor={plColor(metrics.totals.unrealized)} />
        <SummaryCard
          title="Realized Gain/Loss"
          value={formatMoney(metrics.totals.realized)}
          hint="From sell transactions"
         valueColor={plColor(metrics.totals.realized)} />
        <SummaryCard
          title="Total P/L"
          value={formatMoney(metrics.totals.totalPL)}
          hint="Realized + Unrealized"
        />
      </div>

      {/* Holdings (full width) */}
      <div style={{ ...panel, marginTop: 14 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>
              Holdings Overview
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: THEME.muted }}>
              {spotStatus || "Spot prices from /prices."}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              type="button"
              onClick={refreshSpots}
              style={btnSecondary}
              disabled={saving || loading}
            >
              Refresh Spot
            </button>
            <button
              type="button"
              onClick={openCreateForm}
              style={btnPrimary}
              disabled={saving || loading}
            >
              Add Crypto Transaction
            </button>
          </div>
        </div>

        <div style={{ marginTop: 10, borderTop: `1px solid ${THEME.rowBorder}` }} />

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <Th>Symbol</Th>
                <Th>Quantity</Th>
                <Th>Avg Cost</Th>
                <Th>Spot</Th>
                <Th>Market Value</Th>
                <Th>Unrealized</Th>
                <Th>Realized</Th>
              </tr>
            </thead>
            <tbody>
              {metrics.holdings.length === 0 ? (
                <tr style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                  <Td colSpan={7}>
                    <div style={{ padding: "10px 0", color: THEME.muted }}>
                      No holdings yet. Add a BUY transaction.
                    </div>
                  </Td>
                </tr>
              ) : (
                metrics.holdings.map((h) => (
                  <tr
                    key={h.symbol}
                    style={{ borderTop: `1px solid ${THEME.rowBorder}` }}
                  >
                    <Td>
                      <div style={{ fontWeight: 900, color: THEME.title }}>
                        {h.symbol}
                      </div>
                      <div style={{ marginTop: 3, fontSize: 12, color: THEME.muted }}>
                        Buys: {h.buys} · Sells: {h.sells}
                      </div>
                      {(!h.spot || h.spot === 0) ? (
                        <div style={{ marginTop: 3, fontSize: 12, color: THEME.muted }}>
                          Spot missing for this symbol
                        </div>
                      ) : null}
                    </Td>
                    <Td>
                      {safeNum(h.qty, 0).toLocaleString(undefined, {
                        maximumFractionDigits: 8,
                      })}
                    </Td>
                    <Td>{formatMoney(h.avgCost)}</Td>
                    <Td>{formatSpot(h.spot)}</Td>
                    <Td style={{ fontWeight: 900, color: THEME.title }}>
                      {formatMoney(h.marketValue)}
                    </Td>
                    <Td style={{ fontWeight: 900, color: plColor(h.unrealized) }}>{formatMoney(h.unrealized)}</Td>
                    <Td style={{ fontWeight: 900, color: plColor(h.realized) }}>{formatMoney(h.realized)}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit transaction (hidden by default) */}
      {showForm ? (
        <div style={{ ...panel, marginTop: 14 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "center",
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>
              {editingId ? "Edit Crypto Transaction" : "Add Crypto Transaction"}
            </div>
            <button
              type="button"
              onClick={closeForm}
              style={btnSecondary}
              disabled={saving}
            >
              Close
            </button>
          </div>

          {error ? (
            <div style={{ marginTop: 10, ...callout }}>
              <div style={{ fontWeight: 900, color: THEME.title }}>Error</div>
              <div style={{ marginTop: 4, color: THEME.pageText }}>{error}</div>
            </div>
          ) : null}

          <form
            onSubmit={onSubmit}
            style={{ marginTop: 12, display: "grid", gap: 10 }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <Field label="Type">
                <select
                  value={form.type}
                  onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                  style={input}
                  disabled={saving}
                >
                  <option value="BUY">Buy</option>
                  <option value="SELL">Sell</option>
                </select>
              </Field>

              <Field label="Symbol">
                <input
                  value={form.symbol}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, symbol: e.target.value.toUpperCase() }))
                  }
                  placeholder="e.g., BTC-USD"
                  style={input}
                  disabled={saving}
                  list="finvault-crypto-symbols"
                />
                <datalist id="finvault-crypto-symbols">
                  {availableSymbols.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </Field>

              <Field label="Date">
                <input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                  style={input}
                  disabled={saving}
                />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <Field label="Quantity">
                <input
                  value={form.quantity}
                  onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
                  placeholder="e.g., 0.25"
                  inputMode="decimal"
                  style={input}
                  disabled={saving}
                />
              </Field>

              <Field label="Unit Price (USD)">
                <input
                  value={form.unitPrice}
                  onChange={(e) => setForm((f) => ({ ...f, unitPrice: e.target.value }))}
                  placeholder="e.g., 52000"
                  inputMode="decimal"
                  style={input}
                  disabled={saving}
                />
              </Field>

              <Field label="Fees (USD)">
                <input
                  value={form.fees}
                  onChange={(e) => setForm((f) => ({ ...f, fees: e.target.value }))}
                  placeholder="0"
                  inputMode="decimal"
                  style={input}
                  disabled={saving}
                />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: 10 }}>
              <Field label="Notes (optional)">
                <input
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="e.g., DCA"
                  style={input}
                  disabled={saving}
                />
              </Field>

              <div
                style={{
                  display: "flex",
                  gap: 10,
                  justifyContent: "flex-end",
                  alignItems: "end",
                }}
              >
                <button type="button" onClick={resetForm} style={btnSecondary} disabled={saving}>
                  Reset
                </button>
                <button
                  type="submit"
                  style={{ ...btnPrimary, opacity: saving ? 0.75 : 1 }}
                  disabled={saving}
                >
                  {saving ? "Saving…" : editingId ? "Save Changes" : "Add Transaction"}
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : null}

      {/* Transactions */}
      <div style={{ ...panel, marginTop: 14, paddingBottom: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>
            Transactions
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search type/symbol/notes…"
              style={{ ...input, width: 240 }}
              disabled={loading}
            />
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value)}
              style={{ ...input, width: 190 }}
              disabled={loading}
            >
              <option value="date">Sort: Date</option>
              <option value="symbol">Sort: Symbol</option>
              <option value="type">Sort: Type</option>
              <option value="quantity">Sort: Quantity</option>
              <option value="unitPrice">Sort: Unit Price</option>
            </select>
            <button
              type="button"
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              style={btnSecondary}
              disabled={loading}
            >
              {sortDir === "asc" ? "Asc" : "Desc"}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 10, borderTop: `1px solid ${THEME.rowBorder}` }} />

        {loading ? (
          <div style={{ padding: 14, color: THEME.muted }}>Loading…</div>
        ) : filteredSortedTx.length === 0 ? (
          <div style={{ padding: 14, color: THEME.muted }}>
            No crypto transactions yet. Add a buy/sell above.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <Th>Date</Th>
                  <Th>Type</Th>
                  <Th>Symbol</Th>
                  <Th>Quantity</Th>
                  <Th>Unit Price</Th>
                  <Th>Fees</Th>
                  <Th>Net</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filteredSortedTx.map((t) => {
                  const type = String(t.type || "BUY").toUpperCase();
                  const qty = safeNum(t.quantity, 0);
                  const px = safeNum(t.unitPrice, 0);
                  const fees = safeNum(t.fees, 0);
                  const gross = qty * px;
                  const net = type === "SELL" ? gross - fees : gross + fees;

                  return (
                    <tr key={t.id} style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                      <Td>{t.date || "-"}</Td>
                      <Td>
                        <span style={{ fontWeight: 900, color: THEME.title }}>
                          {type}
                        </span>
                      </Td>
                      <Td>{String(t.symbol || "").toUpperCase()}</Td>
                      <Td>
                        {qty.toLocaleString(undefined, { maximumFractionDigits: 8 })}
                      </Td>
                      <Td>{formatMoney(px)}</Td>
                      <Td>{formatMoney(fees)}</Td>
                      <Td style={{ fontWeight: 900, color: THEME.title }}>
                        {formatMoney(net)}
                      </Td>
                      <Td align="right">
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            justifyContent: "flex-end",
                            paddingRight: 8,
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => startEdit(t)}
                            style={btnSecondarySmall}
                            disabled={saving}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => onDelete(t.id)}
                            style={btnDangerSmall}
                            disabled={saving}
                          >
                            Delete
                          </button>
                        </div>
                        {t.notes ? (
                          <div
                            style={{
                              marginTop: 6,
                              fontSize: 12,
                              color: THEME.muted,
                              paddingRight: 8,
                            }}
                          >
                            {t.notes}
                          </div>
                        ) : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- UI helpers ---------- */

function SummaryCard({ title, value, hint, valueColor }) {
  return (
    <div style={panel}>
      <div style={{ fontSize: 12, color: THEME.muted, fontWeight: 800 }}>
        {title}
      </div>
      <div style={{ marginTop: 6, fontSize: 18, fontWeight: 900, color: valueColor || THEME.title }}>
        {value}
      </div>
      {hint ? (
        <div style={{ marginTop: 6, fontSize: 12, color: THEME.muted }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <div style={{ fontSize: 12, color: THEME.muted, fontWeight: 800 }}>
        {label}
      </div>
      {children}
    </label>
  );
}

function Th({ children, align, style, ...rest }) {
  return (
    <th
      style={{
        padding: "10px 10px",
        fontSize: 12,
        color: THEME.muted,
        fontWeight: 900,
        whiteSpace: "nowrap",
        ...(style || {}),
      }}
      align={align || "left"}
      {...rest}
    >
      {children}
    </th>
  );
}

function Td({ children, align, colSpan, style, ...rest }) {
  return (
    <td
      style={{ padding: "12px 10px", verticalAlign: "top", ...(style || {}) }}
      align={align || "left"}
      colSpan={colSpan}
      {...rest}
    >
      {children}
    </td>
  );
}

/* ---------- styles ---------- */

const panel = {
  background: THEME.panelBg,
  border: `1px solid ${THEME.panelBorder}`,
  borderRadius: 14,
  padding: 14,
  backdropFilter: "blur(6px)",
};

const input = {
  width: "100%",
  padding: "10px 10px",
  borderRadius: 12,
  border: `1px solid ${THEME.inputBorder}`,
  background: THEME.inputBg,
  color: THEME.pageText,
  outline: "none",
};

const btnPrimary = {
  padding: "10px 12px",
  borderRadius: 12,
  border: `1px solid ${THEME.primaryBorder}`,
  background: THEME.primaryBg,
  color: THEME.title,
  fontWeight: 900,
  cursor: "pointer",
};

const btnSecondary = {
  padding: "10px 12px",
  borderRadius: 12,
  border: `1px solid ${THEME.panelBorder}`,
  background: "rgba(148, 163, 184, 0.06)",
  color: THEME.pageText,
  fontWeight: 900,
  cursor: "pointer",
};

const btnSecondarySmall = {
  padding: "7px 10px",
  borderRadius: 12,
  border: `1px solid ${THEME.panelBorder}`,
  background: "rgba(148, 163, 184, 0.06)",
  color: THEME.pageText,
  fontWeight: 900,
  cursor: "pointer",
  fontSize: 12,
};

const btnDangerSmall = {
  padding: "7px 10px",
  borderRadius: 12,
  border: `1px solid ${THEME.dangerBorder}`,
  background: THEME.dangerBg,
  color: THEME.title,
  fontWeight: 900,
  cursor: "pointer",
  fontSize: 12,
};

const callout = {
  padding: 12,
  borderRadius: 12,
  background: "rgba(239, 68, 68, 0.10)",
  border: `1px solid ${THEME.dangerBorder}`,
};
