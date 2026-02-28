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
  warnBg: "rgba(234, 179, 8, 0.10)",
  warnBorder: "rgba(234, 179, 8, 0.35)",
};

/* ---------------- Formatting helpers ---------------- */

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
function fmt(n) {
  const x = safeNum(n, 0);
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
}
function fmtNum(n, decimals = 2) {
  return safeNum(n, 0).toLocaleString(undefined, { maximumFractionDigits: decimals });
}
function plColor(v) {
  return safeNum(v, 0) < 0 ? "rgba(248,113,113,0.95)" : "rgba(134,239,172,0.95)";
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
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  const text = await res.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`API returned non-JSON (${res.status})`); }
  if (!res.ok) throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
  return data;
}

/* ---------------- Common futures contracts ---------------- */

const COMMON_CONTRACTS = [
  { ticker: "ES",  name: "E-mini S&P 500",        pointValue: 50 },
  { ticker: "NQ",  name: "E-mini Nasdaq 100",      pointValue: 20 },
  { ticker: "RTY", name: "E-mini Russell 2000",    pointValue: 50 },
  { ticker: "YM",  name: "E-mini Dow Jones",       pointValue: 5 },
  { ticker: "MES", name: "Micro E-mini S&P 500",   pointValue: 5 },
  { ticker: "MNQ", name: "Micro E-mini Nasdaq",    pointValue: 2 },
  { ticker: "CL",  name: "Crude Oil",              pointValue: 1000 },
  { ticker: "GC",  name: "Gold",                   pointValue: 100 },
  { ticker: "SI",  name: "Silver",                 pointValue: 5000 },
  { ticker: "ZB",  name: "30-Year T-Bond",         pointValue: 1000 },
  { ticker: "ZN",  name: "10-Year T-Note",         pointValue: 1000 },
  { ticker: "6E",  name: "Euro FX",                pointValue: 125000 },
];

function lookupPointValue(ticker) {
  const c = COMMON_CONTRACTS.find((x) => x.ticker === ticker.toUpperCase());
  return c ? c.pointValue : "";
}

/* ---------------- FIFO engine ---------------- */

/**
 * Runs FIFO matching across all transactions for all tickers.
 *
 * Queue entries: { price, qty, feePerQty, pointValue, txId }
 *
 * BUY → tries to close open SHORTs first (FIFO), excess opens a LONG
 * SELL → tries to close open LONGs first (FIFO), excess opens a SHORT
 *
 * Realized P/L for a matched lot:
 *   LONG closed by SELL: (sellPrice - longPrice) × qty × pointValue − fees
 *   SHORT closed by BUY: (shortPrice − buyPrice) × qty × pointValue − fees
 */
function computeFuturesMetrics(transactions) {
  const txSorted = [...transactions].sort((a, b) => {
    const d = String(a.tradeDate || "").localeCompare(String(b.tradeDate || ""));
    return d !== 0 ? d : String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });

  // { [ticker]: { longQueue, shortQueue, realized } }
  const state = {};
  // Per-transaction realized P/L for closing trades: { txId → number }
  const plByTx = {};

  for (const tx of txSorted) {
    const ticker = String(tx.ticker || "").toUpperCase();
    if (!ticker) continue;
    if (!state[ticker]) state[ticker] = { longQueue: [], shortQueue: [], realized: 0 };

    const s = state[ticker];
    const type = String(tx.type || "").toUpperCase();
    const pv = safeNum(tx.pointValue, 50);
    const qty = safeNum(tx.qty, 0);
    const price = safeNum(tx.price, 0);
    const fees = safeNum(tx.fees, 0);
    const feePerQty = qty > 0 ? fees / qty : 0;
    const txId = tx.txId || tx.assetId;

    if (type === "BUY") {
      // Close SHORTs (FIFO)
      let remaining = qty;
      let txPl = 0;
      let closedAny = false;
      while (remaining > 0 && s.shortQueue.length > 0) {
        const oldest = s.shortQueue[0];
        const closeQty = Math.min(remaining, oldest.qty);
        const pl =
          (oldest.price - price) * closeQty * pv -
          closeQty * feePerQty -
          closeQty * oldest.feePerQty;
        s.realized += pl;
        txPl += pl;
        closedAny = true;
        oldest.qty -= closeQty;
        remaining -= closeQty;
        if (oldest.qty <= 0) s.shortQueue.shift();
      }
      if (closedAny) plByTx[txId] = round2(txPl);
      if (remaining > 0) {
        s.longQueue.push({ price, qty: remaining, feePerQty, pointValue: pv, txId });
      }
    } else if (type === "SELL") {
      // Close LONGs (FIFO)
      let remaining = qty;
      let txPl = 0;
      let closedAny = false;
      while (remaining > 0 && s.longQueue.length > 0) {
        const oldest = s.longQueue[0];
        const closeQty = Math.min(remaining, oldest.qty);
        const pl =
          (price - oldest.price) * closeQty * pv -
          closeQty * feePerQty -
          closeQty * oldest.feePerQty;
        s.realized += pl;
        txPl += pl;
        closedAny = true;
        oldest.qty -= closeQty;
        remaining -= closeQty;
        if (oldest.qty <= 0) s.longQueue.shift();
      }
      if (closedAny) plByTx[txId] = round2(txPl);
      if (remaining > 0) {
        s.shortQueue.push({ price, qty: remaining, feePerQty, pointValue: pv, txId });
      }
    } else if (type === "SUMMARY") {
      const grossPL = safeNum(tx.grossPL, 0);
      s.realized += grossPL;
      plByTx[txId] = round2(grossPL);
    }
  }

  const openPositions = [];
  let totalRealized = 0;

  for (const [ticker, s] of Object.entries(state)) {
    totalRealized += s.realized;

    if (s.longQueue.length > 0) {
      const totalQty = s.longQueue.reduce((acc, p) => acc + p.qty, 0);
      const totalCost = s.longQueue.reduce((acc, p) => acc + p.price * p.qty, 0);
      openPositions.push({
        ticker,
        direction: "LONG",
        qty: totalQty,
        avgPrice: totalQty > 0 ? totalCost / totalQty : 0,
        lots: s.longQueue.length,
        pointValue: s.longQueue[0].pointValue,
      });
    }
    if (s.shortQueue.length > 0) {
      const totalQty = s.shortQueue.reduce((acc, p) => acc + p.qty, 0);
      const totalCost = s.shortQueue.reduce((acc, p) => acc + p.price * p.qty, 0);
      openPositions.push({
        ticker,
        direction: "SHORT",
        qty: totalQty,
        avgPrice: totalQty > 0 ? totalCost / totalQty : 0,
        lots: s.shortQueue.length,
        pointValue: s.shortQueue[0].pointValue,
      });
    }
  }

  return {
    openPositions,
    realizedPL: round2(totalRealized),
    openCount: openPositions.length,
    totalOpenContracts: round2(openPositions.reduce((acc, p) => acc + p.qty, 0)),
    plByTx,
  };
}

/* ---------------- Blank form state ---------------- */

const BLANK_FORM = {
  type: "BUY",
  ticker: "",
  contractMonth: "",
  tradeDate: todayISO(),
  qty: "",
  price: "",
  pointValue: "",
  fees: "",
  notes: "",
};

function normalizeTx(item) {
  return { ...item, id: item.txId || item.assetId || item.id };
}

/* ================================================================
   COMPONENT
================================================================ */

export default function Futures() {
  const [tx, setTx] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Form state (used for both Add/Edit and Close)
  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState("add"); // "add" | "edit" | "close"
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(BLANK_FORM);

  // Transaction history filters
  const [search, setSearch] = useState("");
  const [tickerFilter, setTickerFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortKey, setSortKey] = useState("tradeDate");
  const [sortDir, setSortDir] = useState("desc");

  /* ---- Load ---- */
  useEffect(() => {
    let alive = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const res = await apiFetch("/assets/futures/transactions");
        if (!alive) return;
        const list = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
        setTx(list.map(normalizeTx));
      } catch (e) {
        if (alive) setError(e?.message || "Failed to load");
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => { alive = false; };
  }, []);

  async function refreshList() {
    const res = await apiFetch("/assets/futures/transactions");
    const list = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
    setTx(list.map(normalizeTx));
  }

  /* ---- Metrics ---- */
  const metrics = useMemo(() => computeFuturesMetrics(tx), [tx]);
  const { plByTx } = metrics;

  /* ---- Filtered / sorted transaction list ---- */
  const filteredTx = useMemo(() => {
    let list = tx;

    if (tickerFilter) {
      list = list.filter((t) =>
        String(t.ticker || "").toUpperCase().includes(tickerFilter.toUpperCase())
      );
    }

    if (dateFrom) list = list.filter((t) => String(t.tradeDate || "") >= dateFrom);
    if (dateTo)   list = list.filter((t) => String(t.tradeDate || "") <= dateTo);

    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((t) => {
        const hay = `${t.type} ${t.ticker} ${t.contractMonth || ""} ${t.notes || ""}`.toLowerCase();
        return hay.includes(q);
      });
    }

    const dir = sortDir === "asc" ? 1 : -1;
    const getVal = (t) => {
      switch (sortKey) {
        case "ticker": return t.ticker || "";
        case "type": return t.type || "";
        case "qty": return safeNum(t.qty, 0);
        case "price": return safeNum(t.price, 0);
        case "tradeDate":
        default: return t.tradeDate || "";
      }
    };

    return [...list].sort((a, b) => {
      const va = getVal(a), vb = getVal(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [tx, search, tickerFilter, sortKey, sortDir, dateFrom, dateTo]);

  /* ---- Unique tickers for filter dropdown ---- */
  const allTickers = useMemo(() => [...new Set(tx.map((t) => t.ticker).filter(Boolean))].sort(), [tx]);

  /* ---- Form helpers ---- */
  function openAddForm() {
    setError("");
    setEditingId(null);
    setFormMode("add");
    setForm(BLANK_FORM);
    setShowForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  function openEditForm(t) {
    setError("");
    setEditingId(t.id);
    setFormMode("edit");
    setForm({
      type: String(t.type || "BUY").toUpperCase(),
      ticker: t.ticker || "",
      contractMonth: t.contractMonth || "",
      tradeDate: t.tradeDate || todayISO(),
      qty: String(t.qty ?? ""),
      price: String(t.price ?? ""),
      pointValue: String(t.pointValue ?? ""),
      fees: String(t.fees ?? ""),
      notes: t.notes || "",
    });
    setShowForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  function openCloseForm(pos) {
    // Pre-fill with opposite direction to close the position
    setError("");
    setEditingId(null);
    setFormMode("close");
    setForm({
      type: pos.direction === "LONG" ? "SELL" : "BUY",
      ticker: pos.ticker,
      contractMonth: "",
      tradeDate: todayISO(),
      qty: String(round2(pos.qty)),
      price: "",
      pointValue: String(pos.pointValue),
      fees: "",
      notes: `Close ${pos.direction} ${pos.ticker}`,
    });
    setShowForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setError("");
    setForm(BLANK_FORM);
  }

  function buildPayload() {
    const type = String(form.type || "").toUpperCase();
    if (!["BUY", "SELL"].includes(type)) throw new Error("Type must be BUY or SELL");

    const ticker = String(form.ticker || "").toUpperCase().trim();
    if (!ticker) throw new Error("Ticker is required");

    const tradeDate = form.tradeDate;
    if (!tradeDate) throw new Error("Trade date is required");

    const qty = safeNum(form.qty, NaN);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("Qty must be a positive number");

    const price = safeNum(form.price, NaN);
    if (!Number.isFinite(price) || price <= 0) throw new Error("Price must be > 0");

    const pointValue = safeNum(form.pointValue, NaN);
    if (!Number.isFinite(pointValue) || pointValue <= 0)
      throw new Error("Point value must be > 0");

    const fees = safeNum(form.fees, 0);
    if (fees < 0) throw new Error("Fees must be >= 0");

    return {
      type,
      ticker,
      contractMonth: String(form.contractMonth || "").trim(),
      tradeDate,
      qty: round2(qty),
      price: round2(price),
      pointValue: round2(pointValue),
      fees: round2(fees),
      notes: String(form.notes || "").trim(),
    };
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const payload = buildPayload();
      if (editingId) {
        await apiFetch(`/assets/futures/transactions/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          body: payload,
        });
      } else {
        await apiFetch("/assets/futures/transactions", { method: "POST", body: payload });
      }
      await refreshList();
      closeForm();
    } catch (err) {
      setError(err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id) {
    if (!window.confirm("Delete this futures transaction?")) return;
    setError("");
    setSaving(true);
    try {
      await apiFetch(`/assets/futures/transactions/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refreshList();
      if (editingId === id) closeForm();
    } catch (err) {
      setError(err?.message || "Delete failed");
    } finally {
      setSaving(false);
    }
  }

  /* ---- Ticker select auto-fills pointValue ---- */
  /* ----------------------------------------------------------------
     RENDER
  ---------------------------------------------------------------- */

  const formTitle =
    formMode === "close"
      ? `Close Position — ${form.ticker} (${form.type})`
      : editingId
      ? "Edit Transaction"
      : "Add Transaction";

  return (
    <div style={{ padding: 16, color: THEME.pageText }}>

      {/* Page header */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 22, fontWeight: 900, color: THEME.title }}>Futures</div>
        <div style={{ fontSize: 12, color: THEME.muted }}>
          As of <span style={{ color: THEME.pageText, fontWeight: 700 }}>{todayISO()}</span>
          &nbsp;·&nbsp;FIFO position tracking
        </div>
      </div>

      {/* Summary cards */}
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(3, minmax(180px, 1fr))", gap: 12 }}>
        <SummaryCard
          title="Realized P/L"
          value={fmt(metrics.realizedPL)}
          hint="FIFO-matched closed positions"
          valueColor={plColor(metrics.realizedPL)}
        />
        <SummaryCard
          title="Open Positions"
          value={String(metrics.openCount)}
          hint="Unique ticker/direction pairs"
        />
        <SummaryCard
          title="Open Contracts"
          value={fmtNum(metrics.totalOpenContracts, 4)}
          hint="Total unmatched contracts"
        />
      </div>

      {/* Open positions panel */}
      <div style={{ ...panel, marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>Open Positions</div>
            <div style={{ marginTop: 4, fontSize: 12, color: THEME.muted }}>
              Unmatched contracts after FIFO netting. Click Close to record the offsetting trade.
            </div>
          </div>
          <button type="button" onClick={openAddForm} style={btnPrimary} disabled={saving || loading}>
            + Add Transaction
          </button>
        </div>

        <div style={{ marginTop: 10, borderTop: `1px solid ${THEME.rowBorder}` }} />

        {loading ? (
          <div style={{ padding: 14, color: THEME.muted }}>Loading…</div>
        ) : metrics.openPositions.length === 0 ? (
          <div style={{ padding: 14, color: THEME.muted }}>
            No open positions. All contracts have been matched via FIFO.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <Th>Ticker</Th>
                  <Th>Direction</Th>
                  <Th>Open Qty</Th>
                  <Th>Avg Entry Price</Th>
                  <Th>Point Value</Th>
                  <Th>Open Lots</Th>
                  <Th align="right">Action</Th>
                </tr>
              </thead>
              <tbody>
                {metrics.openPositions.map((pos) => (
                  <tr key={`${pos.ticker}-${pos.direction}`} style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                    <Td>
                      <span style={{ fontWeight: 900, color: THEME.title }}>{pos.ticker}</span>
                    </Td>
                    <Td>
                      <span style={{
                        fontWeight: 900,
                        color: pos.direction === "LONG" ? "rgba(134,239,172,0.95)" : "rgba(248,113,113,0.95)",
                      }}>
                        {pos.direction}
                      </span>
                    </Td>
                    <Td>{fmtNum(pos.qty, 4)}</Td>
                    <Td>{fmtNum(pos.avgPrice, 4)}</Td>
                    <Td>${fmtNum(pos.pointValue, 2)}</Td>
                    <Td>{pos.lots}</Td>
                    <Td align="right">
                      <button
                        type="button"
                        onClick={() => openCloseForm(pos)}
                        style={{ ...btnSecondarySmall, color: THEME.title }}
                        disabled={saving}
                      >
                        Close Position
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add / Edit / Close form */}
      {showForm && (
        <div style={{ ...panel, marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>{formTitle}</div>
            <button type="button" onClick={closeForm} style={btnSecondary} disabled={saving}>
              Cancel
            </button>
          </div>

          {formMode === "close" && (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: THEME.warnBg, border: `1px solid ${THEME.warnBorder}`, fontSize: 12, color: THEME.muted }}>
              Closing via FIFO: this transaction will offset the oldest open lot(s) first.
              Enter the closing price and adjust qty for a partial close.
            </div>
          )}

          {error && (
            <div style={{ marginTop: 10, ...callout }}>
              <div style={{ fontWeight: 900, color: THEME.title }}>Error</div>
              <div style={{ marginTop: 4 }}>{error}</div>
            </div>
          )}

          <datalist id="futures-tickers">
            {COMMON_CONTRACTS.map((c) => (
              <option key={c.ticker} value={c.ticker}>{c.ticker} — {c.name}</option>
            ))}
          </datalist>

          <form onSubmit={onSubmit} style={{ marginTop: 12, display: "grid", gap: 10 }}>
            {/* Row 1 */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
              <Field label="Type">
                <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} style={input} disabled={saving || formMode === "close"}>
                  <option value="BUY">Buy (Long / Close Short)</option>
                  <option value="SELL">Sell (Short / Close Long)</option>
                </select>
              </Field>

              <Field label="Ticker">
                <input
                  list="futures-tickers"
                  value={form.ticker}
                  onChange={(e) => {
                    const t = e.target.value.toUpperCase();
                    const pv = lookupPointValue(t);
                    setForm((f) => ({ ...f, ticker: t, pointValue: pv !== "" ? String(pv) : f.pointValue }));
                  }}
                  placeholder="ES"
                  style={input}
                  disabled={saving || formMode === "close"}
                />
              </Field>

              <Field label="Contract Month (optional)">
                <input value={form.contractMonth} onChange={(e) => setForm((f) => ({ ...f, contractMonth: e.target.value }))} placeholder="e.g., Jun25" style={input} disabled={saving} />
              </Field>

              <Field label="Trade Date">
                <input type="date" value={form.tradeDate} onChange={(e) => setForm((f) => ({ ...f, tradeDate: e.target.value }))} style={input} disabled={saving} />
              </Field>
            </div>

            {/* Row 2 */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
              <Field label="Qty (contracts)">
                <input value={form.qty} onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))} placeholder="e.g., 2" inputMode="decimal" style={input} disabled={saving} />
              </Field>

              <Field label={formMode === "close" ? "Close Price" : "Fill Price"}>
                <input value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} placeholder="e.g., 5120.25" inputMode="decimal" style={input} disabled={saving} autoFocus={formMode === "close"} />
              </Field>

              <Field label="Point Value ($/pt)">
                <input value={form.pointValue} onChange={(e) => setForm((f) => ({ ...f, pointValue: e.target.value }))} placeholder="e.g., 50" inputMode="decimal" style={input} disabled={saving || formMode === "close"} />
              </Field>

              <Field label="Fees (USD)">
                <input value={form.fees} onChange={(e) => setForm((f) => ({ ...f, fees: e.target.value }))} placeholder="0" inputMode="decimal" style={input} disabled={saving} />
              </Field>
            </div>

            {/* Row 3 */}
            <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: 10 }}>
              <Field label="Notes (optional)">
                <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="e.g., hedge vs equity exposure" style={input} disabled={saving} />
              </Field>

              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", alignItems: "end" }}>
                <button type="button" onClick={() => setForm(f => ({ ...f, qty: "", price: "", fees: "", notes: "" }))} style={btnSecondary} disabled={saving}>
                  Reset
                </button>
                <button type="submit" style={{ ...btnPrimary, opacity: saving ? 0.75 : 1 }} disabled={saving}>
                  {saving ? "Saving…" : formMode === "close" ? "Record Close" : editingId ? "Save Changes" : "Add Transaction"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Transaction history */}
      <div style={{ ...panel, marginTop: 14, paddingBottom: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 15, fontWeight: 900, color: THEME.title }}>Transaction History</div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={tickerFilter}
              onChange={(e) => setTickerFilter(e.target.value)}
              style={{ ...input, width: 120 }}
              disabled={loading}
            >
              <option value="">All tickers</option>
              {allTickers.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>

            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              style={{ ...input, width: 150 }}
              disabled={loading}
              title="From date"
            />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              style={{ ...input, width: 150 }}
              disabled={loading}
              title="To date"
            />
            {(dateFrom || dateTo) && (
              <button type="button" onClick={() => { setDateFrom(""); setDateTo(""); }} style={btnSecondary} disabled={loading}>
                Clear
              </button>
            )}

            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              style={{ ...input, width: 180 }}
              disabled={loading}
            />

            <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} style={{ ...input, width: 160 }} disabled={loading}>
              <option value="tradeDate">Sort: Date</option>
              <option value="ticker">Sort: Ticker</option>
              <option value="type">Sort: Type</option>
              <option value="qty">Sort: Qty</option>
              <option value="price">Sort: Price</option>
            </select>

            <button type="button" onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))} style={btnSecondary} disabled={loading}>
              {sortDir === "asc" ? "Asc" : "Desc"}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 10, borderTop: `1px solid ${THEME.rowBorder}` }} />

        {loading ? (
          <div style={{ padding: 14, color: THEME.muted }}>Loading…</div>
        ) : filteredTx.length === 0 ? (
          <div style={{ padding: 14, color: THEME.muted }}>No transactions yet. Add a buy or sell above.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <Th>Date</Th>
                  <Th>Type</Th>
                  <Th>Ticker</Th>
                  <Th>Month</Th>
                  <Th>Qty</Th>
                  <Th>Price</Th>
                  <Th>Pt Val</Th>
                  <Th>Fees</Th>
                  <Th>Notional</Th>
                  <Th>P/L</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filteredTx.map((t) => {
                  const qty = safeNum(t.qty, 0);
                  const price = safeNum(t.price, 0);
                  const pv = safeNum(t.pointValue, 50);
                  const fees = safeNum(t.fees, 0);
                  // Notional = contracts × price × point value
                  const notional = qty * price * pv;
                  const type = String(t.type || "").toUpperCase();

                  return (
                    <tr key={t.id} style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                      <Td>{t.tradeDate || "—"}</Td>
                      <Td>
                        <span style={{
                          fontWeight: 900,
                          color: type === "BUY"
                            ? "rgba(134,239,172,0.95)"
                            : type === "SELL"
                            ? "rgba(248,113,113,0.95)"
                            : "rgba(251,191,36,0.95)",
                        }}>
                          {type}
                        </span>
                      </Td>
                      <Td style={{ fontWeight: 900, color: THEME.title }}>{t.ticker}</Td>
                      <Td style={{ color: THEME.muted }}>{t.contractMonth || "—"}</Td>
                      <Td>{fmtNum(qty, 4)}</Td>
                      <Td>{type === "SUMMARY" ? "—" : fmtNum(price, 4)}</Td>
                      <Td>{type === "SUMMARY" ? "—" : `$${fmtNum(pv, 2)}`}</Td>
                      <Td>{type === "SUMMARY" ? "—" : fmt(fees)}</Td>
                      <Td style={{ fontWeight: 900, color: THEME.title }}>{type === "SUMMARY" ? "—" : fmt(notional)}</Td>
                      <Td>
                        {plByTx[t.txId] !== undefined ? (
                          <span style={{ fontWeight: 900, color: plColor(plByTx[t.txId]) }}>
                            {fmt(plByTx[t.txId])}
                          </span>
                        ) : "—"}
                      </Td>
                      <Td align="right">
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingRight: 8 }}>
                          <button type="button" onClick={() => openEditForm(t)} style={btnSecondarySmall} disabled={saving}>Edit</button>
                          <button type="button" onClick={() => onDelete(t.id)} style={btnDangerSmall} disabled={saving}>Delete</button>
                        </div>
                        {t.notes ? (
                          <div style={{ marginTop: 4, fontSize: 12, color: THEME.muted, paddingRight: 8 }}>{t.notes}</div>
                        ) : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ height: 14 }} />
      </div>
    </div>
  );
}

/* ---- UI sub-components ---- */

function SummaryCard({ title, value, hint, valueColor }) {
  return (
    <div style={panel}>
      <div style={{ fontSize: 12, color: THEME.muted, fontWeight: 800 }}>{title}</div>
      <div style={{ marginTop: 6, fontSize: 18, fontWeight: 900, color: valueColor || THEME.title }}>{value}</div>
      {hint && <div style={{ marginTop: 6, fontSize: 12, color: THEME.muted }}>{hint}</div>}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <div style={{ fontSize: 12, color: THEME.muted, fontWeight: 800 }}>{label}</div>
      {children}
    </label>
  );
}

function Th({ children, align, style: s, ...rest }) {
  return (
    <th style={{ padding: "10px 10px", fontSize: 12, color: THEME.muted, fontWeight: 900, whiteSpace: "nowrap", ...(s || {}) }} align={align || "left"} {...rest}>
      {children}
    </th>
  );
}

function Td({ children, align, colSpan, style: s, ...rest }) {
  return (
    <td style={{ padding: "12px 10px", verticalAlign: "top", ...(s || {}) }} align={align || "left"} colSpan={colSpan} {...rest}>
      {children}
    </td>
  );
}

/* ---- Styles ---- */

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
  boxSizing: "border-box",
};

const btnPrimary = {
  padding: "10px 12px",
  borderRadius: 12,
  border: `1px solid ${THEME.primaryBorder}`,
  background: THEME.primaryBg,
  color: THEME.title,
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const btnSecondary = {
  padding: "10px 12px",
  borderRadius: 12,
  border: `1px solid ${THEME.panelBorder}`,
  background: "rgba(148, 163, 184, 0.06)",
  color: THEME.pageText,
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
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
