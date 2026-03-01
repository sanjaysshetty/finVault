import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { Badge } from "../components/ui/Badge.jsx";

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
  return safeNum(v, 0) < 0 ? "#F87171" : "#4ADE80";
}

/* ── Common futures contracts ────────────────────────────────── */

const COMMON_CONTRACTS = [
  { ticker: "ES",  name: "E-mini S&P 500",      pointValue: 50 },
  { ticker: "NQ",  name: "E-mini Nasdaq 100",    pointValue: 20 },
  { ticker: "RTY", name: "E-mini Russell 2000",  pointValue: 50 },
  { ticker: "YM",  name: "E-mini Dow Jones",     pointValue: 5 },
  { ticker: "MES", name: "Micro E-mini S&P 500", pointValue: 5 },
  { ticker: "MNQ", name: "Micro E-mini Nasdaq",  pointValue: 2 },
  { ticker: "CL",  name: "Crude Oil",            pointValue: 1000 },
  { ticker: "GC",  name: "Gold",                 pointValue: 100 },
  { ticker: "SI",  name: "Silver",               pointValue: 5000 },
  { ticker: "ZB",  name: "30-Year T-Bond",       pointValue: 1000 },
  { ticker: "ZN",  name: "10-Year T-Note",       pointValue: 1000 },
  { ticker: "6E",  name: "Euro FX",              pointValue: 125000 },
];

function lookupPointValue(ticker) {
  const c = COMMON_CONTRACTS.find((x) => x.ticker === ticker.toUpperCase());
  return c ? c.pointValue : "";
}

/* ── FIFO engine ─────────────────────────────────────────────── */

function computeFuturesMetrics(transactions) {
  const txSorted = [...transactions].sort((a, b) => {
    const d = String(a.tradeDate || "").localeCompare(String(b.tradeDate || ""));
    return d !== 0 ? d : String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });

  const state = {};
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
      let remaining = qty, txPl = 0, closedAny = false;
      while (remaining > 0 && s.shortQueue.length > 0) {
        const oldest = s.shortQueue[0];
        const closeQty = Math.min(remaining, oldest.qty);
        const pl = (oldest.price - price) * closeQty * pv - closeQty * feePerQty - closeQty * oldest.feePerQty;
        s.realized += pl; txPl += pl; closedAny = true;
        oldest.qty -= closeQty; remaining -= closeQty;
        if (oldest.qty <= 0) s.shortQueue.shift();
      }
      if (closedAny) plByTx[txId] = round2(txPl);
      if (remaining > 0) s.longQueue.push({ price, qty: remaining, feePerQty, pointValue: pv, txId });
    } else if (type === "SELL") {
      let remaining = qty, txPl = 0, closedAny = false;
      while (remaining > 0 && s.longQueue.length > 0) {
        const oldest = s.longQueue[0];
        const closeQty = Math.min(remaining, oldest.qty);
        const pl = (price - oldest.price) * closeQty * pv - closeQty * feePerQty - closeQty * oldest.feePerQty;
        s.realized += pl; txPl += pl; closedAny = true;
        oldest.qty -= closeQty; remaining -= closeQty;
        if (oldest.qty <= 0) s.longQueue.shift();
      }
      if (closedAny) plByTx[txId] = round2(txPl);
      if (remaining > 0) s.shortQueue.push({ price, qty: remaining, feePerQty, pointValue: pv, txId });
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
      openPositions.push({ ticker, direction: "LONG", qty: totalQty, avgPrice: totalQty > 0 ? totalCost / totalQty : 0, lots: s.longQueue.length, pointValue: s.longQueue[0].pointValue });
    }
    if (s.shortQueue.length > 0) {
      const totalQty = s.shortQueue.reduce((acc, p) => acc + p.qty, 0);
      const totalCost = s.shortQueue.reduce((acc, p) => acc + p.price * p.qty, 0);
      openPositions.push({ ticker, direction: "SHORT", qty: totalQty, avgPrice: totalQty > 0 ? totalCost / totalQty : 0, lots: s.shortQueue.length, pointValue: s.shortQueue[0].pointValue });
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

/* ── Blank form ──────────────────────────────────────────────── */

const BLANK_FORM = {
  type: "BUY", ticker: "", contractMonth: "",
  tradeDate: todayISO(), qty: "", price: "", pointValue: "", fees: "", notes: "",
};

function normalizeTx(item) {
  return { ...item, id: item.txId || item.assetId || item.id };
}

/* ================================================================
   COMPONENT
================================================================ */

export default function Futures() {
  const [error, setError] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState("add");
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(BLANK_FORM);

  const [search, setSearch] = useState("");
  const [tickerFilter, setTickerFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortKey, setSortKey] = useState("tradeDate");
  const [sortDir, setSortDir] = useState("desc");

  const queryClient = useQueryClient();

  /* ---------- Data query ---------- */

  const { data: rawData, isLoading: loading } = useQuery({
    queryKey: queryKeys.futuresTx(),
    queryFn: () => api.get("/assets/futures/transactions"),
  });

  const tx = useMemo(() => {
    const list = Array.isArray(rawData?.items) ? rawData.items : Array.isArray(rawData) ? rawData : [];
    return list.map(normalizeTx);
  }, [rawData]);

  /* ---------- Mutations ---------- */

  const saveMut = useMutation({
    mutationFn: ({ id, payload }) =>
      id
        ? api.patch(`/assets/futures/transactions/${encodeURIComponent(id)}`, payload)
        : api.post("/assets/futures/transactions", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.futuresTx() });
      closeForm();
    },
    onError: (e) => setError(e?.message || "Save failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => api.delete(`/assets/futures/transactions/${encodeURIComponent(id)}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.futuresTx() });
      if (editingId === id) closeForm();
    },
    onError: (e) => setError(e?.message || "Delete failed"),
  });

  const saving = saveMut.isPending || deleteMut.isPending;

  /* ---------- Derived / computed ---------- */

  const metrics = useMemo(() => computeFuturesMetrics(tx), [tx]);
  const { plByTx } = metrics;

  const filteredTx = useMemo(() => {
    let list = tx;
    if (tickerFilter) list = list.filter((t) => String(t.ticker || "").toUpperCase().includes(tickerFilter.toUpperCase()));
    if (dateFrom) list = list.filter((t) => String(t.tradeDate || "") >= dateFrom);
    if (dateTo) list = list.filter((t) => String(t.tradeDate || "") <= dateTo);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((t) =>
      `${t.type} ${t.ticker} ${t.contractMonth || ""} ${t.notes || ""}`.toLowerCase().includes(q)
    );
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

  const allTickers = useMemo(
    () => [...new Set(tx.map((t) => t.ticker).filter(Boolean))].sort(),
    [tx]
  );

  /* ---------- Form helpers ---------- */

  function openAddForm() {
    setError(""); setEditingId(null); setFormMode("add"); setForm(BLANK_FORM); setShowForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  function openEditForm(t) {
    setError(""); setEditingId(t.id); setFormMode("edit");
    setForm({
      type: String(t.type || "BUY").toUpperCase(), ticker: t.ticker || "",
      contractMonth: t.contractMonth || "", tradeDate: t.tradeDate || todayISO(),
      qty: String(t.qty ?? ""), price: String(t.price ?? ""),
      pointValue: String(t.pointValue ?? ""), fees: String(t.fees ?? ""), notes: t.notes || "",
    });
    setShowForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  function openCloseForm(pos) {
    setError(""); setEditingId(null); setFormMode("close");
    setForm({
      type: pos.direction === "LONG" ? "SELL" : "BUY", ticker: pos.ticker,
      contractMonth: "", tradeDate: todayISO(), qty: String(round2(pos.qty)),
      price: "", pointValue: String(pos.pointValue), fees: "",
      notes: `Close ${pos.direction} ${pos.ticker}`,
    });
    setShowForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  function closeForm() {
    setShowForm(false); setEditingId(null); setError(""); setForm(BLANK_FORM);
  }

  function buildPayload() {
    const type = String(form.type || "").toUpperCase();
    if (!["BUY", "SELL"].includes(type)) throw new Error("Type must be BUY or SELL");
    const ticker = String(form.ticker || "").toUpperCase().trim();
    if (!ticker) throw new Error("Ticker is required");
    if (!form.tradeDate) throw new Error("Trade date is required");
    const qty = safeNum(form.qty, NaN);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("Qty must be a positive number");
    const price = safeNum(form.price, NaN);
    if (!Number.isFinite(price) || price <= 0) throw new Error("Price must be > 0");
    const pointValue = safeNum(form.pointValue, NaN);
    if (!Number.isFinite(pointValue) || pointValue <= 0) throw new Error("Point value must be > 0");
    const fees = safeNum(form.fees, 0);
    if (fees < 0) throw new Error("Fees must be >= 0");
    return {
      type, ticker, contractMonth: String(form.contractMonth || "").trim(),
      tradeDate: form.tradeDate, qty: round2(qty), price: round2(price),
      pointValue: round2(pointValue), fees: round2(fees), notes: String(form.notes || "").trim(),
    };
  }

  function onSubmit(e) {
    e.preventDefault();
    setError("");
    let payload;
    try {
      payload = buildPayload();
    } catch (err) {
      setError(err?.message || "Validation failed");
      return;
    }
    saveMut.mutate({ id: editingId, payload });
  }

  function onDelete(id) {
    if (!window.confirm("Delete this futures transaction?")) return;
    setError("");
    deleteMut.mutate(id);
  }

  const formTitle =
    formMode === "close"
      ? `Close Position — ${form.ticker} (${form.type})`
      : editingId ? "Edit Transaction" : "Add Transaction";

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-baseline justify-between gap-3">
        <h1
          className="text-2xl font-black text-slate-100 tracking-tight"
          style={{ fontFamily: "Epilogue, sans-serif" }}
        >
          Futures
        </h1>
        <span className="text-xs text-slate-500">
          As of <strong className="text-slate-300 font-semibold">{todayISO()}</strong>
          &nbsp;·&nbsp;FIFO position tracking
        </span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <MetricCard
          label="Realized P/L"
          value={fmt(metrics.realizedPL)}
          sub="FIFO-matched closed positions"
          valueClass={metrics.realizedPL < 0 ? "text-red-400" : "text-green-400"}
        />
        <MetricCard
          label="Open Positions"
          value={String(metrics.openCount)}
          sub="Unique ticker/direction pairs"
        />
        <MetricCard
          label="Open Contracts"
          value={fmtNum(metrics.totalOpenContracts, 4)}
          sub="Total unmatched contracts"
        />
      </div>

      {/* Open positions panel */}
      <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div>
            <h2 className="text-sm font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
              Open Positions
            </h2>
          </div>
          <BtnPrimary type="button" onClick={openAddForm} disabled={saving || loading}>
            + Add Transaction
          </BtnPrimary>
        </div>

        <div className="border-t border-white/[0.06]" />

        {loading ? (
          <EmptyState type="loading" message="Loading positions…" />
        ) : metrics.openPositions.length === 0 ? (
          <div className="py-4 text-sm text-slate-500">
            No open positions. All contracts have been matched via FIFO.
          </div>
        ) : (
          <div className="overflow-x-auto mt-2">
            <table className="w-full border-collapse">
              <thead>
                <tr>
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
                  <tr key={`${pos.ticker}-${pos.direction}`} className="border-t border-white/[0.06]">
                    <Td><span className="font-black text-slate-100">{pos.ticker}</span></Td>
                    <Td>
                      <span className="font-black" style={{ color: pos.direction === "LONG" ? "#4ADE80" : "#F87171" }}>
                        {pos.direction}
                      </span>
                    </Td>
                    <Td className="numeric">{fmtNum(pos.qty, 4)}</Td>
                    <Td className="numeric">{fmtNum(pos.avgPrice, 4)}</Td>
                    <Td className="numeric">${fmtNum(pos.pointValue, 2)}</Td>
                    <Td>{pos.lots}</Td>
                    <Td align="right">
                      <Btn type="button" onClick={() => openCloseForm(pos)} disabled={saving}>
                        Close Position
                      </Btn>
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
        <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
              {formTitle}
            </h2>
            <Btn type="button" onClick={closeForm} disabled={saving}>Cancel</Btn>
          </div>

          {formMode === "close" && (
            <div className="mt-3 rounded-xl border border-amber-500/[0.3] bg-amber-500/[0.08] px-3 py-2 text-xs text-slate-400">
              Closing via FIFO: this transaction will offset the oldest open lot(s) first.
              Enter the closing price and adjust qty for a partial close.
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-xl border border-red-500/[0.3] bg-red-500/[0.08] px-3 py-2.5">
              <div className="text-xs font-bold text-slate-100">Error</div>
              <div className="mt-1 text-xs text-slate-300">{error}</div>
            </div>
          )}

          <datalist id="futures-tickers">
            {COMMON_CONTRACTS.map((c) => (
              <option key={c.ticker} value={c.ticker}>{c.ticker} — {c.name}</option>
            ))}
          </datalist>

          <form onSubmit={onSubmit} className="mt-4 grid gap-3">
            {/* Row 1 */}
            <div className="grid grid-cols-4 gap-3">
              <FLabel label="Type">
                <select
                  value={form.type}
                  onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                  className={inputCls}
                  disabled={saving || formMode === "close"}
                >
                  <option value="BUY">Buy (Long / Close Short)</option>
                  <option value="SELL">Sell (Short / Close Long)</option>
                </select>
              </FLabel>
              <FLabel label="Ticker">
                <input
                  list="futures-tickers"
                  value={form.ticker}
                  onChange={(e) => {
                    const t = e.target.value.toUpperCase();
                    const pv = lookupPointValue(t);
                    setForm((f) => ({ ...f, ticker: t, pointValue: pv !== "" ? String(pv) : f.pointValue }));
                  }}
                  placeholder="ES"
                  className={inputCls}
                  disabled={saving || formMode === "close"}
                />
              </FLabel>
              <FLabel label="Contract Month (optional)">
                <input
                  value={form.contractMonth}
                  onChange={(e) => setForm((f) => ({ ...f, contractMonth: e.target.value }))}
                  placeholder="e.g., Jun25"
                  className={inputCls}
                  disabled={saving}
                />
              </FLabel>
              <FLabel label="Trade Date">
                <input
                  type="date"
                  value={form.tradeDate}
                  onChange={(e) => setForm((f) => ({ ...f, tradeDate: e.target.value }))}
                  className={inputCls}
                  disabled={saving}
                />
              </FLabel>
            </div>

            {/* Row 2 */}
            <div className="grid grid-cols-4 gap-3">
              <FLabel label="Qty (contracts)">
                <input
                  value={form.qty}
                  onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))}
                  placeholder="e.g., 2"
                  inputMode="decimal"
                  className={inputCls}
                  disabled={saving}
                />
              </FLabel>
              <FLabel label={formMode === "close" ? "Close Price" : "Fill Price"}>
                <input
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                  placeholder="e.g., 5120.25"
                  inputMode="decimal"
                  className={inputCls}
                  disabled={saving}
                  autoFocus={formMode === "close"}
                />
              </FLabel>
              <FLabel label="Point Value ($/pt)">
                <input
                  value={form.pointValue}
                  onChange={(e) => setForm((f) => ({ ...f, pointValue: e.target.value }))}
                  placeholder="e.g., 50"
                  inputMode="decimal"
                  className={inputCls}
                  disabled={saving || formMode === "close"}
                />
              </FLabel>
              <FLabel label="Fees (USD)">
                <input
                  value={form.fees}
                  onChange={(e) => setForm((f) => ({ ...f, fees: e.target.value }))}
                  placeholder="0"
                  inputMode="decimal"
                  className={inputCls}
                  disabled={saving}
                />
              </FLabel>
            </div>

            {/* Row 3 */}
            <div className="grid gap-3" style={{ gridTemplateColumns: "3fr 1fr" }}>
              <FLabel label="Notes (optional)">
                <input
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="e.g., hedge vs equity exposure"
                  className={inputCls}
                  disabled={saving}
                />
              </FLabel>
              <div className="flex gap-2 items-end justify-end">
                <Btn
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, qty: "", price: "", fees: "", notes: "" }))}
                  disabled={saving}
                >
                  Reset
                </Btn>
                <BtnPrimary type="submit" disabled={saving} style={{ opacity: saving ? 0.75 : 1 }}>
                  {saving ? "Saving…" : formMode === "close" ? "Record Close" : editingId ? "Save Changes" : "Add Transaction"}
                </BtnPrimary>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Transaction history */}
      <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729]">
        <div className="flex items-center justify-between gap-3 flex-wrap px-4 pt-4 pb-3">
          <h2 className="text-sm font-black text-slate-100">Transactions</h2>
          <div className="flex gap-2 flex-wrap items-center">
            <select
              value={tickerFilter}
              onChange={(e) => setTickerFilter(e.target.value)}
              className={`${inputCls} !w-32`}
              disabled={loading}
            >
              <option value="">All tickers</option>
              {allTickers.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className={`${inputCls} !w-40`}
              disabled={loading}
              title="From date"
            />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className={`${inputCls} !w-40`}
              disabled={loading}
              title="To date"
            />
            {(dateFrom || dateTo) && (
              <Btn type="button" onClick={() => { setDateFrom(""); setDateTo(""); }} disabled={loading}>
                Clear
              </Btn>
            )}
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className={`${inputCls} !w-44`}
              disabled={loading}
            />
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value)}
              className={`${inputCls} !w-40`}
              disabled={loading}
            >
              <option value="tradeDate">Sort: Date</option>
              <option value="ticker">Sort: Ticker</option>
              <option value="type">Sort: Type</option>
              <option value="qty">Sort: Qty</option>
              <option value="price">Sort: Price</option>
            </select>
            <Btn
              type="button"
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              disabled={loading}
            >
              {sortDir === "asc" ? "Asc ↑" : "Desc ↓"}
            </Btn>
          </div>
        </div>

        <div className="border-t border-white/[0.06]" />

        {loading ? (
          <EmptyState type="loading" message="Loading transactions…" />
        ) : filteredTx.length === 0 ? (
          <EmptyState type="empty" message="No transactions yet. Add a buy or sell above." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
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
                  const notional = qty * price * pv;
                  const type = String(t.type || "").toUpperCase();
                  return (
                    <tr key={t.id} className="border-t border-white/[0.06] hover:bg-white/[0.015] transition-colors">
                      <Td>{t.tradeDate || "—"}</Td>
                      <Td>
                        <Badge variant={type === "BUY" ? "buy" : type === "SELL" ? "sell" : "summary"}>{type}</Badge>
                      </Td>
                      <Td><span className="font-black text-slate-100">{t.ticker}</span></Td>
                      <Td className="text-slate-500">{t.contractMonth || "—"}</Td>
                      <Td className="numeric">{fmtNum(qty, 4)}</Td>
                      <Td className="numeric">{type === "SUMMARY" ? "—" : fmtNum(price, 4)}</Td>
                      <Td className="numeric">{type === "SUMMARY" ? "—" : `$${fmtNum(pv, 2)}`}</Td>
                      <Td className="numeric">{type === "SUMMARY" ? "—" : fmt(fees)}</Td>
                      <Td className="font-bold text-slate-100 numeric">{type === "SUMMARY" ? "—" : fmt(notional)}</Td>
                      <Td>
                        {plByTx[t.txId] !== undefined ? (
                          <span className="font-black text-xs" style={{ color: plColor(plByTx[t.txId]) }}>
                            {fmt(plByTx[t.txId])}
                          </span>
                        ) : "—"}
                      </Td>
                      <Td align="right">
                        <div className="flex gap-1.5 justify-end">
                          <Btn onClick={() => openEditForm(t)} disabled={saving}>Edit</Btn>
                          <BtnDanger onClick={() => onDelete(t.id)} disabled={saving}>Delete</BtnDanger>
                        </div>
                        {t.notes && (
                          <div className="mt-1 text-xs text-slate-500 text-right">{t.notes}</div>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="h-3" />
      </div>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────── */

function FLabel({ label, children }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-bold text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function Th({ children, align, className }) {
  return (
    <th
      className={`text-xs font-bold uppercase tracking-widest text-slate-500 px-3 py-2.5 whitespace-nowrap border-b border-white/[0.06] ${align === "right" ? "text-right" : "text-left"} ${className || ""}`}
    >
      {children}
    </th>
  );
}

function Td({ children, align, colSpan, className }) {
  return (
    <td
      className={`text-sm text-slate-300 px-3 py-3 align-top ${align === "right" ? "text-right" : ""} ${className || ""}`}
      colSpan={colSpan}
    >
      {children}
    </td>
  );
}

function Btn({ children, ...p }) {
  return <button type="button" className={btnSmCls} {...p}>{children}</button>;
}

function BtnPrimary({ children, ...p }) {
  return <button className={btnPrimCls} {...p}>{children}</button>;
}

function BtnDanger({ children, ...p }) {
  return <button type="button" className={btnDanCls} {...p}>{children}</button>;
}

const inputCls = "w-full bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2.5 text-slate-200 text-sm outline-none focus:border-blue-500/[0.4] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const btnPrimCls = "text-xs font-bold text-slate-100 px-3 py-1.5 rounded-lg border border-blue-500/[0.3] bg-blue-500/[0.15] hover:bg-blue-500/[0.25] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
const btnSmCls = "text-xs font-bold text-slate-400 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08] hover:text-slate-200 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
const btnDanCls = "text-xs font-bold text-red-400 px-3 py-1.5 rounded-lg border border-red-500/[0.3] bg-red-500/[0.08] hover:bg-red-500/[0.15] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
