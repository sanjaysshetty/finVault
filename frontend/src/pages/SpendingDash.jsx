import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { PageHeader } from "../components/ui/PageHeader.jsx";
import { PageIcons }  from "../components/ui/PageIcons.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";

function formatMoney(n) {
  return Number(n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
function formatMoneyK(n) {
  const x = Number(n || 0);
  if (Math.abs(x) >= 10000) return `$${(x / 1000).toFixed(0)}k`;
  if (Math.abs(x) >= 1000) return `$${(x / 1000).toFixed(1)}k`;
  return `$${x.toFixed(0)}`;
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function sixMonthsAgoISO() {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

function getMonthRanges(start, end) {
  const result = [];
  const e = new Date(`${end}T00:00:00Z`);
  let cur = new Date(`${start}T00:00:00Z`);
  cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), 1));
  while (cur <= e) {
    const mStart = cur.toISOString().slice(0, 10);
    const lastDay = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
    const mEnd = lastDay > e ? end : lastDay.toISOString().slice(0, 10);
    const monthName = cur.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    const yearShort = String(cur.getUTCFullYear()).slice(-2);
    const label = `${monthName} '${yearShort}`;
    result.push({ start: mStart, end: mEnd, label });
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }
  return result;
}

/* ── Monthly Area Chart ──────────────────────────────────────── */

function MonthlyAreaChart({ data, loading }) {
  if (loading) return <div className="flex items-center justify-center h-48"><EmptyState type="loading" message="Loading trend…" /></div>;
  if (!data || data.length === 0) return <EmptyState type="empty" message="No monthly data." />;

  const W = 560, H = 340;
  const PAD = { top: 24, right: 20, bottom: 16, left: 68 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;
  const maxAmt = Math.max(...data.map(d => d.amount), 1);

  const pts = data.map((d, i) => ({
    x: PAD.left + (data.length === 1 ? cW / 2 : (i / (data.length - 1)) * cW),
    y: PAD.top + cH - (d.amount / maxAmt) * cH,
    ...d,
  }));

  const linePath = pts.reduce((acc, pt, i) => {
    if (i === 0) return `M ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
    const prev = pts[i - 1];
    const cpx = ((prev.x + pt.x) / 2).toFixed(1);
    return `${acc} C ${cpx} ${prev.y.toFixed(1)} ${cpx} ${pt.y.toFixed(1)} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
  }, "");

  const areaPath = `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${(PAD.top + cH).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(PAD.top + cH).toFixed(1)} Z`;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => ({
    y: PAD.top + cH - f * cH,
    label: f === 0 ? "$0" : formatMoneyK(f * maxAmt),
  }));

  return (
    <div>
      {/* SVG chart — no month labels inside */}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} preserveAspectRatio="none" aria-label="Monthly spending chart">
        <defs>
          <linearGradient id="area-grad-sd" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f97316" stopOpacity="0.40" />
            <stop offset="100%" stopColor="#f97316" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Grid lines + Y-axis tick labels */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD.left} y1={t.y} x2={W - PAD.right} y2={t.y}
              stroke="rgba(128,128,128,0.2)" strokeWidth="1" strokeDasharray={i === 0 ? "none" : "4 3"} />
            <text x={PAD.left - 8} y={t.y + 4} textAnchor="end" fontSize="9.5"
              style={{ fill: "var(--fv-dim)" }}>{t.label}</text>
          </g>
        ))}

        {/* X axis baseline */}
        <line x1={PAD.left} y1={PAD.top + cH} x2={W - PAD.right} y2={PAD.top + cH} stroke="rgba(128,128,128,0.25)" strokeWidth="1" />

        {/* Area fill */}
        <path d={areaPath} fill="url(#area-grad-sd)" />

        {/* Line */}
        <path d={linePath} fill="none" stroke="#f97316" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

        {/* Data point dots only */}
        {pts.map((pt) => (
          <circle key={pt.label} cx={pt.x} cy={pt.y} r="4" fill="#f97316" stroke="rgba(0,0,0,0.4)" strokeWidth="1.5" />
        ))}
      </svg>

      {/* Month labels — absolutely positioned to match SVG dot x coordinates */}
      <div className="relative h-5 mt-1">
        {data.map((d, i) => {
          const xPct = ((PAD.left + (data.length === 1 ? cW / 2 : (i / (data.length - 1)) * cW)) / W * 100).toFixed(2);
          const translateX = i === 0 ? "0%" : i === data.length - 1 ? "-100%" : "-50%";
          return (
            <span key={d.month}
              className="absolute text-xs font-bold text-slate-400 whitespace-nowrap"
              style={{ left: `${xPct}%`, transform: `translateX(${translateX})` }}>
              {d.month}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ── Category Bar Chart ──────────────────────────────────────── */

function HorizontalBarChart({ data, expanded, onToggle, detailsByCategory, loadingCat }) {
  const max = useMemo(() => data.reduce((m, x) => Math.max(m, Number(x.amount || 0)), 0) || 1, [data]);
  const totalAmt = useMemo(() => data.reduce((s, x) => s + Number(x.amount || 0), 0), [data]);
  const rowCols = "90px minmax(140px,1fr) 150px 90px";

  const barColor = (i) => {
    if (i === 0) return "#ef4444";
    if (i === 1) return "#f97316";
    return "#22c55e";
  };

  return (
    <div className="grid gap-2.5 overflow-y-auto" style={{ maxHeight: "420px" }}>
      {data.map((d, idx) => {
        const amt = Number(d.amount || 0);
        const pct = clamp((amt / max) * 100, 0, 100);
        const pctOfTotal = totalAmt > 0 ? ((amt / totalAmt) * 100).toFixed(1) : "0.0";
        const isOpen = !!expanded[d.category];
        const det = detailsByCategory[d.category];

        return (
          <div key={d.category} className="grid gap-1.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onToggle(d.category)}
                className="w-5 h-5 flex-shrink-0 rounded border border-white/[0.08] bg-white/[0.04] text-slate-300 font-black cursor-pointer hover:bg-white/[0.08] text-[10px] inline-flex items-center justify-center"
              >
                {isOpen ? "–" : "+"}
              </button>
              <span className="text-xs font-bold text-slate-300 truncate w-20 shrink-0" title={d.category}>{d.category}</span>
              <div className="flex-1 h-2.5 rounded-full bg-white/[0.06] overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: barColor(idx), opacity: 0.8 }} />
              </div>
              <span className="text-xs font-black text-slate-100 whitespace-nowrap w-20 text-right shrink-0">{formatMoney(amt)}</span>
              <span className="text-[10px] text-slate-500 w-9 text-right shrink-0">{pctOfTotal}%</span>
            </div>

            {isOpen && (
              <div className="ml-7 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
                {loadingCat === d.category ? (
                  <EmptyState type="loading" message="Loading…" />
                ) : !det ? (
                  <p className="text-xs text-slate-500">No details loaded.</p>
                ) : det.error ? (
                  <p className="text-xs text-red-400">{det.error}</p>
                ) : det.items?.length ? (
                  <div className="grid gap-1.5">
                    <div className="flex justify-between items-center">
                      <span className="font-black text-slate-100 text-xs">{d.category}</span>
                      <span className="text-xs text-slate-500">{det.count} items · {formatMoney(det.total)}</span>
                    </div>
                    <div className="border-t border-white/[0.06]" />
                    <div className="grid gap-1" style={{ gridTemplateColumns: rowCols }}>
                      {["Date", "Description", "Category", "Amount"].map((h, i) => (
                        <span key={h} className={`text-[10px] font-bold uppercase tracking-widest text-slate-500 ${i === 3 ? "text-right" : ""}`}>{h}</span>
                      ))}
                    </div>
                    <div className="border-t border-white/[0.06]" />
                    {det.items.slice(0, 50).map((it) => (
                      <div key={`${it.pk}||${it.sk}`} className="grid items-center gap-2 py-1.5 border-b border-white/[0.04]" style={{ gridTemplateColumns: rowCols }}>
                        <span className="text-[10px] text-slate-500">{it.date || ""}</span>
                        <span className="text-[10px] text-slate-300 font-bold truncate" title={it.productDescription || ""}>{it.productDescription || "(no desc)"}</span>
                        <span className="text-[10px] text-slate-400 truncate">{it.category || it.categoryName || "—"}</span>
                        <span className="text-[10px] font-black text-slate-100 text-right">{formatMoney(Number(it.amount || 0))}</span>
                      </div>
                    ))}
                    {det.items.length > 50 && <p className="text-[10px] text-slate-500 pt-1">Showing top 50.</p>}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">No line items in this category.</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────────── */

export default function SpendingDash() {
  const presets = useMemo(() => [
    { key: "30D",   label: "Last 30 days" },
    { key: "90D",   label: "Last 90 days" },
    { key: "6M",    label: "Last 6 months" },
    { key: "YTD",   label: "Year to date" },
    { key: "CUSTOM", label: "Custom" },
  ], []);

  const [preset,   setPreset]   = useState("6M");
  const [start,    setStart]    = useState(sixMonthsAgoISO());
  const [end,      setEnd]      = useState(todayISO());
  const [category, setCategory] = useState("All");
  const [expanded, setExpanded] = useState({});
  const [detailsByCategory, setDetailsByCategory] = useState({});
  const [loadingCat, setLoadingCat] = useState("");

  const queryClient = useQueryClient();

  /* Preset → dates */
  useEffect(() => {
    const t = todayISO();
    if      (preset === "30D") { setStart(addDays(t, -29)); setEnd(t); }
    else if (preset === "90D") { setStart(addDays(t, -89)); setEnd(t); }
    else if (preset === "6M")  { setStart(sixMonthsAgoISO()); setEnd(t); }
    else if (preset === "YTD") { setStart(`${new Date().getFullYear()}-01-01`); setEnd(t); }
  }, [preset]);

  /* Dashboard query */
  const { data: dashData, isLoading: loading, error: dashError } = useQuery({
    queryKey: ["spending", "dashboard", start, end, category],
    queryFn: () => api.get(`/spending/dashboard?${new URLSearchParams({ start, end, category: category || "All" })}`),
  });

  /* Monthly trend: parallel calls, one per calendar month */
  const monthRanges = useMemo(() => getMonthRanges(start, end), [start, end]);
  const { data: monthlyTrend, isLoading: monthlyLoading } = useQuery({
    queryKey: ["spending", "monthly-trend", start, end],
    queryFn: () =>
      Promise.all(
        monthRanges.map(m =>
          api.get(`/spending/dashboard?${new URLSearchParams({ start: m.start, end: m.end, category: "All" })}`)
            .catch(() => ({ totalSpend: 0 }))
        )
      ).then(results =>
        monthRanges.map((m, i) => ({ month: m.label, amount: Number(results[i]?.totalSpend || 0) }))
      ),
    staleTime: 5 * 60 * 1000,
  });

  const totalSpend = useMemo(() => Number(dashData?.totalSpend || 0), [dashData]);
  const chart      = useMemo(() => Array.isArray(dashData?.chart) ? dashData.chart : [], [dashData]);
  const categories = useMemo(() => Array.isArray(dashData?.categories) ? dashData.categories : ["All"], [dashData]);

  useEffect(() => { setExpanded({}); setDetailsByCategory({}); }, [start, end, category]);

  async function loadCategoryDetails(cat) {
    setLoadingCat(cat);
    try {
      const res = await api.get(`/spending/dashboard/details?${new URLSearchParams({ start, end, category: cat })}`);
      setDetailsByCategory(prev => ({ ...prev, [cat]: { ...res, error: "" } }));
    } catch (e) {
      setDetailsByCategory(prev => ({ ...prev, [cat]: { error: e?.message || "Failed", items: [], count: 0, total: 0 } }));
    } finally {
      setLoadingCat("");
    }
  }

  function toggleCategory(cat) {
    setExpanded(prev => ({ ...prev, [cat]: !prev[cat] }));
    if (!expanded[cat] && !detailsByCategory[cat]) loadCategoryDetails(cat);
  }

  return (
    <div className="p-4 text-slate-300">
      <div className="mb-4">
        <PageHeader title="Spending Dashboard" icon={PageIcons.spendingDash} />
      </div>

      {/* Filters */}
      <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] px-4 py-3 mb-4">
        <div className="flex gap-2.5 flex-wrap items-start">
          <FLabel label="Date Range">
            <select value={preset} onChange={e => setPreset(e.target.value)} className={`${inputCls} !w-40`}>
              {presets.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </FLabel>
          <FLabel label="Start">
            <input type="date" value={start} onChange={e => { setPreset("CUSTOM"); setStart(e.target.value); }} className={`${inputCls} !w-40`} />
          </FLabel>
          <FLabel label="End">
            <input type="date" value={end} onChange={e => { setPreset("CUSTOM"); setEnd(e.target.value); }} className={`${inputCls} !w-40`} />
          </FLabel>
          <FLabel label="Category">
            <select value={category} onChange={e => setCategory(e.target.value)} className={`${inputCls} !w-48`}>
              {(categories?.length ? categories : ["All"]).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </FLabel>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs opacity-0 select-none">_</span>
            <button
              type="button"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["spending"] })}
              className={`${btnPrimCls} !py-2.5`}
              disabled={loading || monthlyLoading}
            >
              Refresh
            </button>
          </div>
        </div>
        {dashError && (
          <div className="rounded-xl border border-red-500/[0.3] bg-red-500/[0.08] px-3 py-2 mt-3">
            <span className="text-xs font-black text-slate-100">Error</span>
            <p className="text-xs text-slate-300 mt-1">{dashError.message}</p>
          </div>
        )}
      </div>

      {/* Two-column body */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">

        {/* Left: Monthly Spending Curve */}
        <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-4">
          <span className="text-sm font-black text-slate-100">Monthly Spending</span>
          <p className="text-xs text-slate-500 mt-0.5">
            Total: <span className="text-slate-300 font-bold">{loading ? "…" : formatMoney(totalSpend)}</span>
            <span className="ml-2">{start} → {end}</span>
          </p>
          <div className="border-t border-white/[0.06] my-3" />
          <MonthlyAreaChart data={monthlyTrend} loading={monthlyLoading} />
        </div>

        {/* Right: Category Insights */}
        <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-4">
          <span className="text-sm font-black text-slate-100">By Category</span>
          <p className="text-xs text-slate-500 mt-0.5">Top categories · click to expand</p>
          <div className="border-t border-white/[0.06] my-3" />
          {loading ? (
            <EmptyState type="loading" message="Loading…" />
          ) : chart.length === 0 ? (
            <EmptyState type="empty" message="No data for the selected period." />
          ) : (
            <HorizontalBarChart
              data={chart}
              expanded={expanded}
              onToggle={toggleCategory}
              detailsByCategory={detailsByCategory}
              loadingCat={loadingCat}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────── */

function FLabel({ label, children }) {
  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      <span className="text-xs font-bold uppercase tracking-widest text-slate-500 whitespace-nowrap">{label}</span>
      {children}
    </label>
  );
}

const inputCls  = "w-full bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2.5 text-slate-200 text-sm outline-none focus:border-blue-500/[0.4] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const btnPrimCls = "text-xs font-bold px-3 py-1.5 rounded-lg transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap fv-btn-solid";
