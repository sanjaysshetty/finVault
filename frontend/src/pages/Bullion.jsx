import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { MetricCard, RealizedGainCard } from "../components/ui/MetricCard.jsx";
import { PageHeader } from "../components/ui/PageHeader.jsx";
import { PageIcons }  from "../components/ui/PageIcons.jsx";
import { Badge }      from "../components/ui/Badge.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { useCanWrite } from "../hooks/useCanWrite.js";

/* ── Utilities ───────────────────────────────────────────── */
function todayISO() { return new Date().toISOString().slice(0, 10); }
function safeNum(v, fallback = 0) { const x = Number(v); return Number.isFinite(x) ? x : fallback; }
function round2(n) { return Number(safeNum(n, 0).toFixed(2)); }
const COUNTRY_CURRENCY = { USA: "USD", INDIA: "INR" };
const LOCALE_FOR_CURRENCY = { USD: "en-US", INR: "en-IN" };
function _fmtMoney(n, cur = "USD") {
  const locale = LOCALE_FOR_CURRENCY[cur] ?? "en-US";
  return safeNum(n, 0).toLocaleString(locale, { style: "currency", currency: cur });
}
function plClass(v) { return safeNum(v, 0) >= 0 ? "text-green-400" : "text-red-400"; }
function formatPct(n) { const x = safeNum(n, 0); return `${x > 0 ? "+" : ""}${x.toFixed(2)}%`; }

/* ── Domain ─────────────────────────────────────────────── */
const METALS = [{ key: "GOLD", label: "Gold" }, { key: "SILVER", label: "Silver" }];
const DEFAULT_FORM = { type: "BUY", metal: "GOLD", date: todayISO(), quantityOz: "", unitPrice: "", fees: "", notes: "", country: "USA" };

function normalizeTx(item) { return { ...item, id: item.txId || item.assetId || item.id }; }

function computeBullionMetrics(transactions, spot, prevSpot = {}) {
  const state = {};
  for (const m of METALS) state[m.key] = { qty: 0, cost: 0, avg: 0, realized: 0, buys: 0, sells: 0 };

  const txs = [...transactions].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  for (const t of txs) {
    const metal = String(t.metal || "GOLD").toUpperCase();
    const type  = String(t.type  || "BUY").toUpperCase();
    if (!state[metal]) continue;
    const qty = safeNum(t.quantityOz, 0), price = safeNum(t.unitPrice, 0), fees = safeNum(t.fees, 0);
    const s = state[metal];
    if (type === "BUY") {
      s.qty += qty; s.cost += qty * price + fees; s.buys++; s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    } else if (type === "SELL") {
      const sq = Math.min(qty, s.qty);
      s.realized += sq * price - fees - sq * (s.avg || 0);
      s.qty -= sq; s.cost -= sq * (s.avg || 0); s.sells++; s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    }
  }

  let holdingValue = 0, unrealized = 0, realized = 0, dayGLTotal = 0, totalCost = 0, prevDayValue = 0;
  const holdings = METALS.map((m) => {
    const s = state[m.key];
    const spotPx = safeNum(spot[m.key], 0);
    const prevPx  = safeNum(prevSpot[m.key], 0);
    const dayGL   = prevPx > 0 ? round2(s.qty * (spotPx - prevPx)) : null;
    const mv = s.qty * spotPx, unrl = (spotPx - (s.avg || 0)) * s.qty;
    holdingValue += mv; unrealized += unrl; realized += s.realized;
    totalCost += s.qty * (s.avg || 0);
    if (prevPx > 0) prevDayValue += s.qty * prevPx;
    if (dayGL != null) dayGLTotal += dayGL;
    return { metal: m.key, label: m.label, qty: s.qty, avgCost: s.avg, spot: spotPx, marketValue: mv, unrealized: unrl, realized: s.realized, buys: s.buys, sells: s.sells, dayGL };
  });

  const hasDayGL = prevSpot.GOLD > 0 || prevSpot.SILVER > 0;
  return {
    holdings,
    totals: {
      holdingValue: round2(holdingValue), unrealized: round2(unrealized),
      realized: round2(realized), totalPL: round2(unrealized + realized),
      dayGL: hasDayGL ? round2(dayGLTotal) : null,
      totalCost: round2(totalCost), prevDayValue: round2(prevDayValue),
    },
  };
}

/* FIFO lot tracker — YTD realized gains split into short / long term */
function computeBullionYTDRealized(transactions) {
  const year = new Date().getFullYear();
  const yearStart = `${year}-01-01`;
  const txs = [...transactions].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const lots = {}; // metal -> [{date, qty, costPerUnit}]
  let shortTerm = 0, longTerm = 0;

  for (const t of txs) {
    const metal = String(t.metal || "GOLD").toUpperCase();
    const type  = String(t.type  || "BUY").toUpperCase();
    const qty   = safeNum(t.quantityOz, 0), price = safeNum(t.unitPrice, 0), fees = safeNum(t.fees, 0);
    if (qty <= 0) continue;
    if (!lots[metal]) lots[metal] = [];

    if (type === "BUY") {
      lots[metal].push({ date: t.date || "", qty, costPerUnit: (qty * price + fees) / qty });
    } else if (type === "SELL") {
      const netPerUnit = (qty * price - fees) / qty;
      let rem = qty;
      const isCY = t.date && t.date >= yearStart;
      while (rem > 0 && lots[metal].length > 0) {
        const lot = lots[metal][0];
        const used = Math.min(rem, lot.qty);
        if (isCY) {
          const gain = used * (netPerUnit - lot.costPerUnit);
          const days = lot.date ? (new Date(t.date) - new Date(lot.date)) / 86400000 : 0;
          if (days > 365) longTerm += gain; else shortTerm += gain;
        }
        lot.qty -= used; rem -= used;
        if (lot.qty <= 0) lots[metal].shift();
      }
    }
  }
  return { shortTerm: round2(shortTerm), longTerm: round2(longTerm), total: round2(shortTerm + longTerm) };
}

/* ── Component ───────────────────────────────────────────── */
export default function Bullion() {
  const canWrite = useCanWrite("bullion");
  const [country, setCountry] = useState("USA");
  const currency = COUNTRY_CURRENCY[country] ?? "USD";
  const formatMoney = (n) => _fmtMoney(n, currency);
  const [form, setForm]           = useState(DEFAULT_FORM);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm]   = useState(false);
  const [error, setError]         = useState("");
  const [search, setSearch]       = useState("");
  const [sortKey, setSortKey]     = useState("date");
  const [sortDir, setSortDir]     = useState("desc");

  // Sync page-level country filter → new transaction default country
  useEffect(() => { setForm((f) => ({ ...f, country })); }, [country]);

  const queryClient = useQueryClient();

  const { data: txData, isLoading: txLoading, error: txError } = useQuery({
    queryKey: queryKeys.bullionTx(),
    queryFn: () => api.get("/assets/bullion/transactions"),
  });

  const tx = useMemo(() => {
    const list = Array.isArray(txData?.items) ? txData.items : Array.isArray(txData) ? txData : [];
    return list.map(normalizeTx);
  }, [txData]);

  const { data: pricesData, isFetching: pricesFetching, isError: pricesIsError, refetch: refetchPrices } = useQuery({
    queryKey: queryKeys.prices([], []),
    queryFn: () => api.get("/prices"),
  });

  const spot = useMemo(() => ({
    GOLD: round2(safeNum(pricesData?.gold?.price, 0)),
    SILVER: round2(safeNum(pricesData?.silver?.price, 0)),
  }), [pricesData]);

  const prevSpot = useMemo(() => ({
    GOLD: safeNum(pricesData?.gold?.prev_close_price, 0),
    SILVER: safeNum(pricesData?.silver?.prev_close_price, 0),
  }), [pricesData]);

  const spotStatus = pricesFetching
    ? "Refreshing spot prices…"
    : pricesIsError
      ? "Spot load failed."
      : pricesData
        ? "Spot prices loaded."
        : "";

  const saveMut = useMutation({
    mutationFn: ({ id, payload }) =>
      id ? api.patch(`/assets/bullion/transactions/${encodeURIComponent(id)}`, payload) : api.post("/assets/bullion/transactions", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bullionTx() });
      closeForm();
    },
    onError: (e) => setError(e?.message || "Save failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => api.delete(`/assets/bullion/transactions/${encodeURIComponent(id)}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bullionTx() });
      if (editingId === id) closeForm();
    },
    onError: (e) => setError(e?.message || "Delete failed"),
  });

  const saving = saveMut.isPending || deleteMut.isPending;
  const loading = txLoading;

  const txByCountry = useMemo(
    () => tx.filter((t) => String(t.country || "USA").toUpperCase() === country),
    [tx, country]
  );

  const metrics = useMemo(() => computeBullionMetrics(txByCountry, spot, prevSpot), [txByCountry, spot, prevSpot]);
  const ytd = useMemo(() => computeBullionYTDRealized(txByCountry), [txByCountry]);
  const currentYear = String(new Date().getFullYear());

  const filteredSortedTx = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = q ? txByCountry.filter((t) => `${t.type || ""} ${t.metal || ""} ${t.notes || ""}`.toLowerCase().includes(q)) : txByCountry;
    const dir = sortDir === "asc" ? 1 : -1;
    const getVal = (t) => ({ metal: t.metal || "", type: t.type || "", quantityOz: safeNum(t.quantityOz, 0), unitPrice: safeNum(t.unitPrice, 0), date: t.date || "" }[sortKey] ?? t.date ?? "");
    return [...list].sort((a, b) => {
      const va = getVal(a), vb = getVal(b);
      return (typeof va === "number" && typeof vb === "number") ? (va - vb) * dir : String(va).localeCompare(String(vb)) * dir;
    });
  }, [txByCountry, search, sortKey, sortDir]);

  function resetForm()  { setForm({ ...DEFAULT_FORM, country }); setEditingId(null); setError(""); }
  function closeForm()  { setShowForm(false); resetForm(); }
  function openCreate() { setError(""); setEditingId(null); setForm({ ...DEFAULT_FORM, country }); setShowForm(true); setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0); }

  function startEdit(t) {
    setError(""); setEditingId(t.id);
    setForm({ type: String(t.type || "BUY").toUpperCase(), metal: String(t.metal || "GOLD").toUpperCase(), date: t.date || todayISO(), quantityOz: String(t.quantityOz ?? ""), unitPrice: String(t.unitPrice ?? ""), fees: String(t.fees ?? ""), notes: t.notes || "", country: String(t.country || "USA").toUpperCase() });
    setShowForm(true); setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
  }

  function buildPayload() {
    const qty = safeNum(form.quantityOz, NaN), px = safeNum(form.unitPrice, NaN), fees = safeNum(form.fees, 0);
    if (!form.date) throw new Error("Date is required");
    if (!["BUY", "SELL"].includes(String(form.type).toUpperCase())) throw new Error("Type must be BUY or SELL");
    if (!METALS.some((m) => m.key === String(form.metal).toUpperCase())) throw new Error("Metal must be valid");
    if (!Number.isFinite(qty)  || qty  <= 0) throw new Error("Quantity must be a positive number");
    if (!Number.isFinite(px)   || px   <= 0) throw new Error("Unit price must be positive");
    if (!Number.isFinite(fees) || fees < 0)  throw new Error("Fees must be valid");
    return { type: String(form.type).toUpperCase(), metal: String(form.metal).toUpperCase(), date: form.date, quantityOz: round2(qty), unitPrice: round2(px), fees: round2(fees), notes: form.notes?.trim() || "", country: String(form.country || "USA").toUpperCase() };
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
    if (!window.confirm("Delete this bullion transaction?")) return;
    deleteMut.mutate(id);
  }

  function refreshSpot() {
    refetchPrices();
  }

  /* ── Render ─────────────────────────────────────────────── */
  return (
    <div className="space-y-5">
      <PageHeader title="Bullion" icon={PageIcons.bullion}>
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2 text-slate-200 text-sm outline-none focus:border-blue-500/[0.4] transition-colors"
        >
          <option value="USA">USA</option>
          <option value="INDIA">India</option>
        </select>
      </PageHeader>

      {(txError || error) && (
        <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/25 text-sm text-red-300">
          {txError?.message || error}
        </div>
      )}

      {loading && <EmptyState type="loading" message="Loading your bullion holdings…" />}

      {!loading && (
        <>
          {(() => {
            const unrealizedPct = metrics.totals.totalCost > 0 ? formatPct((metrics.totals.unrealized / metrics.totals.totalCost) * 100) : null;
            const dayGLPct = metrics.totals.prevDayValue > 0 && metrics.totals.dayGL != null ? formatPct((metrics.totals.dayGL / metrics.totals.prevDayValue) * 100) : null;
            return (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <MetricCard label="Total Holding Value"    value={formatMoney(metrics.totals.holdingValue)} sub="Based on spot prices" accent />
                <MetricCard label="Unrealized Gain / Loss" value={formatMoney(metrics.totals.unrealized)}   pct={unrealizedPct} sub="Spot vs avg cost"     valueClass={plClass(metrics.totals.unrealized)} />
                <MetricCard label="Day's Gain / Loss"      value={metrics.totals.dayGL != null ? formatMoney(metrics.totals.dayGL) : "—"} pct={dayGLPct} sub="vs. yesterday's close" valueClass={metrics.totals.dayGL != null ? plClass(metrics.totals.dayGL) : "text-slate-500"} />
                <RealizedGainCard total={ytd.total} shortTerm={ytd.shortTerm} longTerm={ytd.longTerm} year={currentYear} currency={currency} />
              </div>
            );
          })()}

          {/* Add/Edit form */}
          {canWrite && showForm && (
            <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-5">
              <div className="flex items-center justify-between gap-3 mb-4">
                <p className="text-sm font-bold text-slate-200">{editingId ? "Edit Bullion Transaction" : "Add Bullion Transaction"}</p>
                <Btn onClick={closeForm} disabled={saving}>Close</Btn>
              </div>
              {error && <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/25 text-sm text-red-300">{error}</div>}
              <form onSubmit={onSubmit} className="space-y-3">
                <div className="grid grid-cols-4 gap-3">
                  <FLabel label="Type">
                    <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} className={inputCls} disabled={saving}>
                      <option value="BUY">Buy</option>
                      <option value="SELL">Sell</option>
                    </select>
                  </FLabel>
                  <FLabel label="Metal">
                    <select value={form.metal} onChange={(e) => setForm((f) => ({ ...f, metal: e.target.value }))} className={inputCls} disabled={saving}>
                      {METALS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                    </select>
                  </FLabel>
                  <FLabel label="Date">
                    <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className={inputCls} disabled={saving} />
                  </FLabel>
                  <FLabel label="Country">
                    <select value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))} className={inputCls} disabled={saving}>
                      <option value="USA">USA</option>
                      <option value="INDIA">India</option>
                    </select>
                  </FLabel>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <FLabel label="Quantity (oz)">
                    <input value={form.quantityOz} onChange={(e) => setForm((f) => ({ ...f, quantityOz: e.target.value }))} placeholder="e.g., 2.00" inputMode="decimal" className={inputCls} disabled={saving} />
                  </FLabel>
                  <FLabel label="Unit Price (USD / oz)">
                    <input value={form.unitPrice} onChange={(e) => setForm((f) => ({ ...f, unitPrice: e.target.value }))} placeholder="e.g., 2050" inputMode="decimal" className={inputCls} disabled={saving} />
                  </FLabel>
                  <FLabel label="Fees (USD)">
                    <input value={form.fees} onChange={(e) => setForm((f) => ({ ...f, fees: e.target.value }))} placeholder="0" inputMode="decimal" className={inputCls} disabled={saving} />
                  </FLabel>
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
                  <FLabel label="Notes (optional)">
                    <input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="e.g., dealer premium, Costco coin" className={inputCls} disabled={saving} />
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
                <p className="mt-0.5 text-xs text-slate-500">{spotStatus || "Spot prices via GoldAPI"}</p>
              </div>
              <div className="flex gap-2">
                <Btn onClick={refreshSpot} disabled={saving || pricesFetching}>Refresh</Btn>
                {canWrite && <BtnPrimary onClick={openCreate} disabled={saving}>+ Add Transaction</BtnPrimary>}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    {["Metal", "Qty (oz)", "Avg Cost", "Spot", "Day G/L", "Market Value", "Unrealized"].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-widest text-slate-400">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {metrics.holdings.filter((h) => safeNum(h.qty, 0) > 0).map((h) => (
                    <tr key={h.metal} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-3">
                        <p className="font-bold text-slate-100 text-sm">{h.label}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-300 numeric">{round2(h.qty).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td className="px-4 py-3 text-sm text-slate-300 numeric">{formatMoney(h.avgCost)}</td>
                      <td className="px-4 py-3 text-sm text-slate-300 numeric">{formatMoney(h.spot)}</td>
                      <td className={`px-4 py-3 text-sm font-bold numeric ${h.dayGL != null ? plClass(h.dayGL) : "text-slate-600"}`}>{h.dayGL != null ? formatMoney(h.dayGL) : "—"}</td>
                      <td className="px-4 py-3 text-sm font-bold text-slate-200 numeric">{formatMoney(h.marketValue)}</td>
                      <td className={`px-4 py-3 text-sm font-bold numeric ${plClass(h.unrealized)}`}>{formatMoney(h.unrealized)}</td>
                    </tr>
                  ))}
                  {metrics.holdings.every((h) => safeNum(h.qty, 0) <= 0) && (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-sm text-slate-500 text-center">
                        No active bullion holdings.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Transactions */}
          <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] overflow-hidden">
            <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm font-bold text-slate-200">Transactions</p>
              <div className="flex gap-2 items-center flex-nowrap">
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search type / metal / notes…" className={`${inputCls} w-52`} />
                <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} className={`${inputCls} w-36`}>
                  <option value="date">Date</option>
                  <option value="metal">Metal</option>
                  <option value="type">Type</option>
                  <option value="quantityOz">Quantity</option>
                  <option value="unitPrice">Unit Price</option>
                </select>
                <Btn onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}>{sortDir === "asc" ? "Asc ↑" : "Desc ↓"}</Btn>
              </div>
            </div>
            {filteredSortedTx.length === 0 ? (
              <EmptyState type="empty" message="No bullion transactions yet. Add a buy or sell above." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[600px]">
                  <thead>
                    <tr className="border-b border-white/[0.06]">
                      {["Date", "Type", "Metal", "Qty (oz)", "Unit Price", "Fees", "Net", ""].map((h, i) => (
                        <th key={i} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-widest text-slate-400">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {filteredSortedTx.map((t) => {
                      const type = String(t.type || "BUY").toUpperCase();
                      const qty = safeNum(t.quantityOz, 0), px = safeNum(t.unitPrice, 0), fees = safeNum(t.fees, 0);
                      const net = type === "SELL" ? qty * px - fees : qty * px + fees;
                      return (
                        <tr key={t.id} className="hover:bg-white/[0.02] transition-colors">
                          <td className="px-4 py-3 text-sm text-slate-400">{t.date || "—"}</td>
                          <td className="px-4 py-3"><Badge variant={type === "BUY" ? "buy" : type === "SELL" ? "sell" : "summary"}>{type}</Badge></td>
                          <td className="px-4 py-3 text-sm font-semibold text-slate-200">{String(t.metal || "").toUpperCase()}</td>
                          <td className="px-4 py-3 text-sm text-slate-300 numeric">{round2(qty).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td className="px-4 py-3 text-sm text-slate-300 numeric">{formatMoney(px)}</td>
                          <td className="px-4 py-3 text-sm text-slate-400 numeric">{formatMoney(fees)}</td>
                          <td className="px-4 py-3 text-sm font-bold text-slate-200 numeric">{formatMoney(net)}</td>
                          <td className="px-4 py-3">
                            <div className="flex gap-2 justify-end">
                              {canWrite && <button type="button" onClick={() => startEdit(t)} disabled={saving} className={btnSmCls}>Edit</button>}
                              {canWrite && <button type="button" onClick={() => onDelete(t.id)} disabled={saving} className={btnDangerSmCls}>Delete</button>}
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
