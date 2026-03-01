import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { Badge }      from "../components/ui/Badge.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";

/* ── Utilities ───────────────────────────────────────────── */
function todayISO() { return new Date().toISOString().slice(0, 10); }
function safeNum(v, fallback = 0) { const x = Number(v); return Number.isFinite(x) ? x : fallback; }
function round2(n) { return Number(safeNum(n, 0).toFixed(2)); }
function formatMoney(n) { return safeNum(n, 0).toLocaleString(undefined, { style: "currency", currency: "USD" }); }
function formatPct(n) { const x = safeNum(n, 0); return `${x > 0 ? "+" : ""}${x.toFixed(2)}%`; }
function plClass(v) { return safeNum(v, 0) >= 0 ? "text-green-400" : "text-red-400"; }

function spotMove(spot, prevClose) {
  const s = safeNum(spot, 0), p = safeNum(prevClose, 0);
  if (!p) return { pct: 0, hasPrev: false, change: 0 };
  const change = s - p;
  return { pct: (change / p) * 100, hasPrev: true, change };
}

/* ── Domain ─────────────────────────────────────────────── */
const DEFAULT_FORM = { type: "BUY", symbol: "AAPL", date: todayISO(), shares: "", price: "", fees: "", notes: "" };

function normalizeTx(item) {
  return { ...item, id: item.txId || item.assetId || item.id, symbol: String(item.symbol || "").toUpperCase(), type: String(item.type || "BUY").toUpperCase() };
}

function computeStockMetrics(transactions, quoteMap) {
  const bySymbol = {};
  const txs = [...transactions].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

  for (const t of txs) {
    const symbol = String(t.symbol || "").toUpperCase(); if (!symbol) continue;
    const type = String(t.type || "BUY").toUpperCase();
    const shares = safeNum(t.shares, 0), price = safeNum(t.price, 0), fees = safeNum(t.fees, 0);
    if (!bySymbol[symbol]) bySymbol[symbol] = { shares: 0, cost: 0, avg: 0, realized: 0, buys: 0, sells: 0 };
    const s = bySymbol[symbol];
    if (type === "BUY") {
      s.shares += shares; s.cost += shares * price + fees; s.buys++; s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    } else if (type === "SELL") {
      const ss = Math.min(shares, s.shares);
      s.realized += ss * price - fees - ss * (s.avg || 0);
      s.shares -= ss; s.cost -= ss * (s.avg || 0); s.sells++; s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    }
  }

  const holdings = Object.entries(bySymbol).map(([symbol, s]) => {
    const q = quoteMap[symbol];
    const spot = safeNum(q?.price, 0), prevClose = safeNum(q?.prevClose, 0);
    const mv = s.shares * spot;
    return { symbol, shares: s.shares, avgCost: s.avg, spot, prevClose, marketValue: mv, unrealized: (spot - (s.avg || 0)) * s.shares, realized: s.realized, buys: s.buys, sells: s.sells, quoteTs: q?.timestamp };
  }).sort((a, b) => b.marketValue - a.marketValue);

  const totals = holdings.reduce((acc, h) => {
    acc.holdingValue += h.marketValue; acc.unrealized += h.unrealized; acc.realized += h.realized;
    acc.totalCost += h.shares * (h.avgCost || 0);
    const mv = spotMove(h.spot, h.prevClose);
    if (mv.hasPrev) { acc.dayGL += h.shares * mv.change; acc.hasDayGL = true; acc.prevDayValue += h.shares * h.prevClose; }
    return acc;
  }, { holdingValue: 0, unrealized: 0, realized: 0, dayGL: 0, hasDayGL: false, totalCost: 0, prevDayValue: 0 });

  return {
    holdings,
    totals: {
      holdingValue: round2(totals.holdingValue), unrealized: round2(totals.unrealized),
      realized: round2(totals.realized), dayGL: totals.hasDayGL ? round2(totals.dayGL) : null,
      totalCost: round2(totals.totalCost), prevDayValue: round2(totals.prevDayValue),
    },
  };
}

/* ── Component ───────────────────────────────────────────── */
export default function Stocks() {
  const [form, setForm]           = useState(DEFAULT_FORM);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm]   = useState(false);
  const [error, setError]         = useState("");
  const [search, setSearch]       = useState("");
  const [sortKey, setSortKey]     = useState("date");
  const [sortDir, setSortDir]     = useState("desc");

  const queryClient = useQueryClient();

  const { data: txData, isLoading: txLoading, error: txError } = useQuery({
    queryKey: queryKeys.stocksTx(),
    queryFn: () => api.get("/assets/stocks/transactions"),
  });

  const tx = useMemo(() => {
    const list = Array.isArray(txData?.items) ? txData.items : Array.isArray(txData) ? txData : [];
    return list.map(normalizeTx);
  }, [txData]);

  const txSymbols = useMemo(() => {
    const set = new Set(tx.map((t) => String(t.symbol || "").toUpperCase()).filter(Boolean));
    return Array.from(set).sort();
  }, [tx]);

  // symbols includes form symbol for display/datalist but NOT for query key (avoids refetch on every keystroke)
  const symbols = useMemo(() => {
    const set = new Set(txSymbols);
    const fSym = String(form.symbol || "").toUpperCase().trim();
    if (fSym) set.add(fSym);
    return Array.from(set).sort();
  }, [txSymbols, form.symbol]);

  const { data: pricesData, isFetching: pricesFetching, refetch: refetchPrices } = useQuery({
    queryKey: queryKeys.prices(txSymbols, []),
    queryFn: () => api.get(`/prices?stocks=${encodeURIComponent(txSymbols.join(","))}`),
    enabled: txSymbols.length > 0,
  });

  const quotes = useMemo(() => pricesData?.stocks || {}, [pricesData]);

  const quoteStatus = pricesFetching
    ? "Refreshing quotes…"
    : pricesData
      ? "Quotes refreshed."
      : txSymbols.length === 0
        ? "Add a transaction to start tracking holdings."
        : "";

  const saveMut = useMutation({
    mutationFn: ({ id, payload }) =>
      id ? api.patch(`/assets/stocks/transactions/${encodeURIComponent(id)}`, payload) : api.post("/assets/stocks/transactions", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stocksTx() });
      closeForm();
    },
    onError: (e) => setError(e?.message || "Save failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => api.delete(`/assets/stocks/transactions/${encodeURIComponent(id)}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.stocksTx() });
      if (editingId === id) closeForm();
    },
    onError: (e) => setError(e?.message || "Delete failed"),
  });

  const saving = saveMut.isPending || deleteMut.isPending;
  const loading = txLoading;

  const metrics = useMemo(() => computeStockMetrics(tx, quotes), [tx, quotes]);

  const filteredSortedTx = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = q ? tx.filter((t) => `${t.type || ""} ${t.symbol || ""} ${t.notes || ""}`.toLowerCase().includes(q)) : tx;
    const dir = sortDir === "asc" ? 1 : -1;
    const getVal = (t) => ({ symbol: t.symbol || "", type: t.type || "", shares: safeNum(t.shares, 0), price: safeNum(t.price, 0), date: t.date || "" }[sortKey] ?? t.date ?? "");
    return [...list].sort((a, b) => {
      const va = getVal(a), vb = getVal(b);
      return (typeof va === "number" && typeof vb === "number") ? (va - vb) * dir : String(va).localeCompare(String(vb)) * dir;
    });
  }, [tx, search, sortKey, sortDir]);

  function resetForm()  { setForm(DEFAULT_FORM); setEditingId(null); setError(""); }
  function closeForm()  { setShowForm(false); resetForm(); }
  function openCreate() { setError(""); setEditingId(null); setForm(DEFAULT_FORM); setShowForm(true); setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0); }

  function startEdit(t) {
    setError(""); setEditingId(t.id);
    setForm({ type: String(t.type || "BUY").toUpperCase(), symbol: String(t.symbol || "AAPL").toUpperCase(), date: t.date || todayISO(), shares: String(t.shares ?? ""), price: String(t.price ?? ""), fees: String(t.fees ?? ""), notes: t.notes || "" });
    setShowForm(true); setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  function buildPayload() {
    const symbol = String(form.symbol || "").toUpperCase().trim();
    const shares = safeNum(form.shares, NaN), price = safeNum(form.price, NaN), fees = safeNum(form.fees, 0);
    const type = String(form.type).toUpperCase();
    if (!symbol) throw new Error("Symbol is required");
    if (!form.date) throw new Error("Date is required");
    if (!["BUY", "SELL"].includes(type)) throw new Error("Type must be BUY or SELL");
    if (!Number.isFinite(shares) || shares <= 0) throw new Error("Shares must be a positive number");
    if (!Number.isFinite(price)  || price  <= 0) throw new Error("Price must be a positive number");
    if (!Number.isFinite(fees)   || fees   < 0)  throw new Error("Fees must be valid");
    return { type, symbol, date: form.date, shares: Number(shares.toFixed(4)), price: Number(price.toFixed(4)), fees: Number(fees.toFixed(2)), notes: form.notes?.trim() || "" };
  }

  function onSubmit(e) {
    e.preventDefault(); setError("");
    let payload;
    try { payload = buildPayload(); }
    catch (err) { setError(err?.message || "Save failed"); return; }
    saveMut.mutate({ id: editingId, payload });
  }

  function onDelete(id) {
    setError("");
    if (!window.confirm("Delete this stock transaction?")) return;
    deleteMut.mutate(id);
  }

  function refreshQuotes() {
    if (!txSymbols.length) return;
    refetchPrices();
  }

  /* ── Render ─────────────────────────────────────────────── */
  return (
    <div className="space-y-5">

      {/* Page header */}
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-slate-100 tracking-tight" style={{ fontFamily: "Epilogue, sans-serif" }}>Stocks</h1>
          <p className="mt-0.5 text-xs text-slate-500">As of <span className="text-slate-400 font-semibold">{todayISO()}</span></p>
        </div>
      </div>

      {(txError || error) && (
        <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/25 text-sm text-red-300">
          {txError?.message || error}
        </div>
      )}

      {/* Loading */}
      {loading && <EmptyState type="loading" message="Loading your stocks…" />}

      {!loading && (
        <>
          {/* Summary cards */}
          {(() => {
            const unrealizedPct = metrics.totals.totalCost > 0 ? formatPct((metrics.totals.unrealized / metrics.totals.totalCost) * 100) : null;
            const dayGLPct = metrics.totals.prevDayValue > 0 && metrics.totals.dayGL != null ? formatPct((metrics.totals.dayGL / metrics.totals.prevDayValue) * 100) : null;
            return (
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                <MetricCard label="Total Holding Value"    value={formatMoney(metrics.totals.holdingValue)} sub="Based on latest quotes" accent />
                <MetricCard label="Unrealized Gain / Loss" value={formatMoney(metrics.totals.unrealized)}   pct={unrealizedPct} sub="Spot vs avg cost"       valueClass={plClass(metrics.totals.unrealized)} />
                <MetricCard label="Day's Gain / Loss"      value={metrics.totals.dayGL != null ? formatMoney(metrics.totals.dayGL) : "—"} pct={dayGLPct} sub="vs. yesterday's close" valueClass={metrics.totals.dayGL != null ? plClass(metrics.totals.dayGL) : "text-slate-500"} />
              </div>
            );
          })()}

          {/* Add/Edit form */}
          {showForm && (
            <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-5">
              <div className="flex items-center justify-between gap-3 mb-4">
                <p className="text-sm font-bold text-slate-200">{editingId ? "Edit Stock Transaction" : "Add Stock Transaction"}</p>
                <Btn onClick={closeForm} disabled={saving}>Close</Btn>
              </div>

              {error && (
                <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/25 text-sm text-red-300">{error}</div>
              )}

              <form onSubmit={onSubmit} className="space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <FLabel label="Type">
                    <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} className={inputCls} disabled={saving}>
                      <option value="BUY">Buy</option>
                      <option value="SELL">Sell</option>
                    </select>
                  </FLabel>
                  <FLabel label="Symbol">
                    <input value={form.symbol} onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value.toUpperCase() }))} placeholder="e.g., AAPL" className={inputCls} disabled={saving} list="finvault-stock-symbols" />
                    <datalist id="finvault-stock-symbols">
                      {symbols.map((s) => <option key={s} value={s} />)}
                    </datalist>
                  </FLabel>
                  <FLabel label="Date">
                    <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className={inputCls} disabled={saving} />
                  </FLabel>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <FLabel label="Shares">
                    <input value={form.shares} onChange={(e) => setForm((f) => ({ ...f, shares: e.target.value }))} placeholder="e.g., 10" inputMode="decimal" className={inputCls} disabled={saving} />
                  </FLabel>
                  <FLabel label="Price (USD / share)">
                    <input value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} placeholder="e.g., 193.22" inputMode="decimal" className={inputCls} disabled={saving} />
                  </FLabel>
                  <FLabel label="Fees (USD)">
                    <input value={form.fees} onChange={(e) => setForm((f) => ({ ...f, fees: e.target.value }))} placeholder="0" inputMode="decimal" className={inputCls} disabled={saving} />
                  </FLabel>
                </div>

                <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
                  <FLabel label="Notes (optional)">
                    <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="e.g., earnings buy, long-term" className={inputCls} disabled={saving} />
                  </FLabel>
                  <div className="flex gap-2 pb-0.5">
                    <Btn onClick={resetForm} disabled={saving}>Reset</Btn>
                    <BtnPrimary type="submit" disabled={saving}>{saving ? "Saving…" : editingId ? "Save Changes" : "Add Transaction"}</BtnPrimary>
                  </div>
                </div>
              </form>
            </div>
          )}

          {/* Holdings */}
          <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] overflow-hidden">
            <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between gap-3 flex-wrap">
              <div>
                <p className="text-sm font-bold text-slate-200">Holdings Overview</p>
                <p className="mt-0.5 text-xs text-slate-500">{quoteStatus || "Live quotes via Finnhub"}</p>
              </div>
              <div className="flex gap-2">
                <Btn onClick={refreshQuotes} disabled={saving || pricesFetching}>Refresh</Btn>
                <BtnPrimary onClick={openCreate} disabled={saving}>+ Add Transaction</BtnPrimary>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px]">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    {["Symbol", "Shares", "Avg Cost", "Spot", "Day G/L", "Market Value", "Unrealized"].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-widest text-slate-400">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {metrics.holdings.length === 0 ? (
                    <tr><td colSpan={7}><EmptyState type="empty" message="No holdings yet. Add a BUY transaction." /></td></tr>
                  ) : metrics.holdings.map((h) => {
                    const mv = spotMove(h.spot, h.prevClose);
                    const dayGL = mv.hasPrev ? safeNum(h.shares, 0) * mv.change : null;
                    return (
                      <tr key={h.symbol} className="hover:bg-white/[0.02] transition-colors">
                        <td className="px-4 py-3">
                          <p className="font-bold text-slate-100 text-sm">{h.symbol}</p>
                          <p className="text-[11px] text-slate-600 mt-0.5">Buys: {h.buys} · Sells: {h.sells}</p>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-300 numeric">{round2(h.shares).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                        <td className="px-4 py-3 text-sm text-slate-300 numeric">{formatMoney(h.avgCost)}</td>
                        <td className="px-4 py-3">
                          <p className={`text-sm font-bold numeric ${plClass(mv.change)}`}>{formatMoney(h.spot)}</p>
                          {mv.hasPrev && <p className={`text-[11px] font-semibold mt-0.5 numeric ${plClass(mv.change)}`}>{formatPct(mv.pct)}</p>}
                        </td>
                        <td className={`px-4 py-3 text-sm font-bold numeric ${mv.hasPrev ? plClass(dayGL) : "text-slate-600"}`}>
                          {mv.hasPrev ? formatMoney(dayGL) : "—"}
                        </td>
                        <td className="px-4 py-3 text-sm font-bold text-slate-200 numeric">{formatMoney(h.marketValue)}</td>
                        <td className={`px-4 py-3 text-sm font-bold numeric ${plClass(h.unrealized)}`}>{formatMoney(h.unrealized)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Transactions */}
          <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] overflow-hidden">
            <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm font-bold text-slate-200">Transactions</p>
              <div className="flex gap-2 items-center flex-nowrap">
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search type / symbol / notes…" className={`${inputCls} w-52`} />
                <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} className={`${inputCls} w-36`}>
                  <option value="date">Date</option>
                  <option value="symbol">Symbol</option>
                  <option value="type">Type</option>
                  <option value="shares">Shares</option>
                  <option value="price">Price</option>
                </select>
                <Btn onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}>{sortDir === "asc" ? "Asc ↑" : "Desc ↓"}</Btn>
              </div>
            </div>

            {filteredSortedTx.length === 0 ? (
              <EmptyState type="empty" message="No stock transactions yet. Add a buy or sell above." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr className="border-b border-white/[0.06]">
                      {["Date", "Type", "Symbol", "Shares", "Price", "Fees", "Net", ""].map((h, i) => (
                        <th key={i} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-widest text-slate-400">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {filteredSortedTx.map((t) => {
                      const type = String(t.type || "BUY").toUpperCase();
                      const shares = safeNum(t.shares, 0), px = safeNum(t.price, 0), fees = safeNum(t.fees, 0);
                      const net = type === "SELL" ? shares * px - fees : shares * px + fees;
                      return (
                        <tr key={t.id} className="hover:bg-white/[0.02] transition-colors">
                          <td className="px-4 py-3 text-sm text-slate-400">{t.date || "—"}</td>
                          <td className="px-4 py-3"><Badge variant={type === "BUY" ? "buy" : type === "SELL" ? "sell" : "summary"}>{type}</Badge></td>
                          <td className="px-4 py-3 text-sm font-semibold text-slate-200">{String(t.symbol || "").toUpperCase()}</td>
                          <td className="px-4 py-3 text-sm text-slate-300 numeric">{shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                          <td className="px-4 py-3 text-sm text-slate-300 numeric">{formatMoney(px)}</td>
                          <td className="px-4 py-3 text-sm text-slate-400 numeric">{formatMoney(fees)}</td>
                          <td className="px-4 py-3 text-sm font-bold text-slate-200 numeric">{formatMoney(net)}</td>
                          <td className="px-4 py-3">
                            <div className="flex gap-2 justify-end">
                              <button type="button" onClick={() => startEdit(t)} disabled={saving} className={btnSmCls}>Edit</button>
                              <button type="button" onClick={() => onDelete(t.id)} disabled={saving} className={btnDangerSmCls}>Delete</button>
                            </div>
                            {t.notes && <p className="text-[11px] text-slate-600 mt-1 text-right pr-1">{t.notes}</p>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Shared UI atoms ─────────────────────────────────────── */
function FLabel({ label, children }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function Btn({ children, onClick, disabled, type = "button" }) {
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className="px-3 py-2 text-sm font-bold rounded-xl border border-white/[0.08] bg-white/[0.03] text-slate-400 hover:bg-white/[0.07] hover:text-slate-200 transition-all disabled:opacity-50 cursor-pointer whitespace-nowrap">
      {children}
    </button>
  );
}

function BtnPrimary({ children, onClick, disabled, type = "button" }) {
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className="text-xs font-bold text-slate-100 px-3 py-1.5 rounded-lg border border-blue-500/[0.3] bg-blue-500/[0.15] hover:bg-blue-500/[0.25] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap">
      {children}
    </button>
  );
}

const inputCls = "w-full px-3 py-2 rounded-xl bg-[#080D1A] border border-white/[0.1] text-slate-200 text-sm placeholder:text-slate-700 focus:outline-none focus:border-blue-500/40 disabled:opacity-50";
const btnSmCls = "px-3 py-1.5 text-xs font-bold rounded-lg border border-white/[0.08] bg-white/[0.03] text-slate-400 hover:bg-white/[0.07] hover:text-slate-200 transition-all disabled:opacity-50 cursor-pointer";
const btnDangerSmCls = "px-3 py-1.5 text-xs font-bold rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all disabled:opacity-50 cursor-pointer";
