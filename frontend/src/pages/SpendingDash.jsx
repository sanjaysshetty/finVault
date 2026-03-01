import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";

function formatMoney(n) {
  const x = Number(n || 0);
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

/* ---------------- Horizontal bar chart ---------------- */

function HorizontalBarChart({ data, expanded, onToggle, detailsByCategory, loadingCat }) {
  const max = useMemo(() => data.reduce((m, x) => Math.max(m, Number(x.amount || 0)), 0) || 1, [data]);
  const rowCols = "120px minmax(240px, 1fr) 220px 120px";

  return (
    <div className="grid gap-3">
      {data.map((d) => {
        const amt = Number(d.amount || 0);
        const pct = clamp((amt / max) * 100, 0, 100);
        const isOpen = !!expanded[d.category];
        const det = detailsByCategory[d.category];

        return (
          <div key={d.category} className="grid gap-2.5">
            <div className="grid items-center gap-3" style={{ gridTemplateColumns: "240px 1fr 130px" }}>
              {/* Category label + toggle */}
              <div className="flex items-center gap-2.5 min-w-0" title={d.category}>
                <button
                  type="button"
                  onClick={() => onToggle(d.category)}
                  className="w-7 h-7 flex-shrink-0 rounded-lg border border-white/[0.08] bg-white/[0.04] text-slate-100 font-black cursor-pointer hover:bg-white/[0.08] text-xs inline-flex items-center justify-center"
                  aria-label={isOpen ? `Collapse ${d.category}` : `Expand ${d.category}`}
                >
                  {isOpen ? "–" : "+"}
                </button>
                <span className="font-bold text-slate-300 truncate text-sm">{d.category}</span>
              </div>

              {/* Track */}
              <div
                className="h-3.5 rounded-full border border-white/[0.15] bg-white/[0.06] overflow-hidden"
                title={`${d.category}: ${formatMoney(amt)}`}
                style={{ boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.15)" }}
              >
                <div
                  className="h-full"
                  style={{
                    width: `${pct}%`,
                    background: "rgba(34,211,238,0.65)",
                    borderRight: "1px solid rgba(34,211,238,0.95)",
                    boxShadow: "0 0 14px rgba(34,211,238,0.25)",
                  }}
                />
              </div>

              <div className="text-right font-black text-slate-100 text-sm">{formatMoney(amt)}</div>
            </div>

            {/* Drilldown */}
            {isOpen && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
                {loadingCat === d.category ? (
                  <EmptyState type="loading" message="Loading line items…" />
                ) : !det ? (
                  <p className="text-xs text-slate-500">No details loaded.</p>
                ) : det.error ? (
                  <p className="text-xs text-slate-500">Error: {det.error}</p>
                ) : det.items?.length ? (
                  <div className="grid gap-2">
                    <div className="flex justify-between gap-3 items-center">
                      <span className="font-black text-slate-100 text-sm">{d.category} line items</span>
                      <span className="text-xs text-slate-500">{det.count} items · {formatMoney(det.total)}</span>
                    </div>
                    <div className="border-t border-white/[0.06]" />
                    <div className="grid gap-1" style={{ gridTemplateColumns: rowCols }}>
                      {["Date", "Description", "Category", "Amount"].map((h, i) => (
                        <span key={h} className={`text-xs font-bold uppercase tracking-widest text-slate-500 pb-1 ${i === 3 ? "text-right" : ""}`}>{h}</span>
                      ))}
                    </div>
                    <div className="border-t border-white/[0.06]" />
                    {det.items.slice(0, 80).map((it) => {
                      const catText = it.category || it.categoryName || it.categoryLabel || "—";
                      return (
                        <div
                          key={`${it.pk}||${it.sk}`}
                          className="grid items-center gap-2.5 py-2.5 border-b border-white/[0.06]"
                          style={{ gridTemplateColumns: rowCols }}
                        >
                          <span className="text-xs text-slate-500 whitespace-nowrap">{it.date || ""}</span>
                          <div className="min-w-0">
                            <div className="text-slate-300 font-bold truncate text-sm" title={it.productDescription || ""}>{it.productDescription || "(no description)"}</div>
                            {it.productCode && <div className="text-xs text-slate-500 mt-0.5 truncate" title={`Code: ${it.productCode}`}>Code: {it.productCode}</div>}
                          </div>
                          <span className="text-slate-300 font-bold truncate whitespace-nowrap text-sm" title={catText}>{catText}</span>
                          <span className="text-right font-black text-slate-100 whitespace-nowrap text-sm">{formatMoney(Number(it.amount || 0))}</span>
                        </div>
                      );
                    })}
                    {det.items.length > 80 && (
                      <p className="text-xs text-slate-500 pt-2">Showing top 80 items. Narrow your date range to see fewer.</p>
                    )}
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

/* ---------------- Page ---------------- */

export default function SpendingDash() {
  const presets = useMemo(() => [
    { key: "7D", label: "Last 7 days", days: 7 },
    { key: "30D", label: "Last 30 days", days: 30 },
    { key: "90D", label: "Last 90 days", days: 90 },
    { key: "YTD", label: "Year to date", days: null },
    { key: "CUSTOM", label: "Custom", days: null },
  ], []);

  const [preset, setPreset] = useState("30D");
  const [start, setStart] = useState(addDays(todayISO(), -29));
  const [end, setEnd] = useState(todayISO());
  const [category, setCategory] = useState("All");
  const [expanded, setExpanded] = useState({});
  const [detailsByCategory, setDetailsByCategory] = useState({});
  const [loadingCat, setLoadingCat] = useState("");

  const queryClient = useQueryClient();

  /* ---------- Preset → date range ---------- */

  useEffect(() => {
    const t = todayISO();
    if (preset === "7D") { setStart(addDays(t, -6)); setEnd(t); }
    else if (preset === "30D") { setStart(addDays(t, -29)); setEnd(t); }
    else if (preset === "90D") { setStart(addDays(t, -89)); setEnd(t); }
    else if (preset === "YTD") { setStart(`${new Date().getFullYear()}-01-01`); setEnd(t); }
  }, [preset]);

  /* ---------- Dashboard query ---------- */

  const { data: dashData, isLoading: loading, error: dashError } = useQuery({
    queryKey: ["spending", "dashboard", start, end, category],
    queryFn: () => {
      const qs = new URLSearchParams({ start, end, category: category || "All" }).toString();
      return api.get(`/spending/dashboard?${qs}`);
    },
  });

  /* ---------- Derived data ---------- */

  const totalSpend = useMemo(() => Number(dashData?.totalSpend || 0), [dashData]);
  const chart = useMemo(() => Array.isArray(dashData?.chart) ? dashData.chart : [], [dashData]);
  const categories = useMemo(
    () => Array.isArray(dashData?.categories) ? dashData.categories : ["All"],
    [dashData]
  );

  // Sync category if API normalizes it
  useEffect(() => {
    if (dashData?.category && dashData.category !== category) {
      setCategory(dashData.category);
    }
  }, [dashData]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- Reset drilldown when filters change ---------- */

  useEffect(() => { setExpanded({}); setDetailsByCategory({}); }, [start, end, category]);

  /* ---------- Category drilldown ---------- */

  async function loadCategoryDetails(cat) {
    setLoadingCat(cat);
    try {
      const qs = new URLSearchParams({ start, end, category: cat }).toString();
      const res = await api.get(`/spending/dashboard/details?${qs}`);
      setDetailsByCategory((prev) => ({ ...prev, [cat]: { ...res, error: "" } }));
    } catch (e) {
      setDetailsByCategory((prev) => ({
        ...prev,
        [cat]: { error: e?.message || "Failed to load details", items: [], count: 0, total: 0 },
      }));
    } finally {
      setLoadingCat("");
    }
  }

  function toggleCategory(cat) {
    setExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }));
    if (!expanded[cat] && !detailsByCategory[cat]) loadCategoryDetails(cat);
  }

  const asOf = todayISO();

  return (
    <div className="p-4 text-slate-300">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-black text-slate-100 tracking-tight">Spending Dashboard</h1>
          <p className="mt-1.5 text-sm text-slate-500">
            Insights from your receipts ledger (Subtotal/Total excluded; Tax tracked separately).
          </p>
        </div>
        <span className="text-xs text-slate-500 text-right whitespace-nowrap">
          As of <span className="text-slate-300 font-bold">{asOf}</span>
        </span>
      </div>

      {/* Summary + filters */}
      <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-4 mb-4">
        <div className="flex justify-between gap-3 flex-wrap items-center">
          <MetricCard
            label="Total Spend"
            value={loading ? "Loading…" : formatMoney(totalSpend)}
            sub={`${start} → ${end}${category && category !== "All" ? ` · ${category}` : ""}`}
            className="min-w-[200px] bg-transparent border-0 p-0"
          />

          <div className="flex gap-2.5 flex-wrap items-end">
            <FLabel label="Date Range">
              <select value={preset} onChange={(e) => setPreset(e.target.value)} className={`${inputCls} !w-40`}>
                {presets.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </FLabel>
            <FLabel label="Start">
              <input type="date" value={start} onChange={(e) => { setPreset("CUSTOM"); setStart(e.target.value); }} className={`${inputCls} !w-40`} />
            </FLabel>
            <FLabel label="End">
              <input type="date" value={end} onChange={(e) => { setPreset("CUSTOM"); setEnd(e.target.value); }} className={`${inputCls} !w-40`} />
            </FLabel>
            <FLabel label="Category">
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${inputCls} !w-52`}>
                {(categories?.length ? categories : ["All"]).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </FLabel>
            <button
              type="button"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["spending", "dashboard"] })}
              className={btnPrimCls}
              disabled={loading}
            >
              Refresh
            </button>
          </div>
        </div>

        {dashError && (
          <div className="rounded-xl border border-red-500/[0.3] bg-red-500/[0.08] px-3 py-2 mt-3">
            <span className="text-xs font-black text-slate-100">Error</span>
            <p className="text-xs text-slate-300 mt-1">{dashError.message || "Failed to load dashboard"}</p>
          </div>
        )}
      </div>

      {/* Category insights */}
      <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-4">
        <div className="mb-1">
          <span className="text-sm font-black text-slate-100">Category Insights</span>
          <p className="text-xs text-slate-500 mt-1">Top 10 categories by spend (remaining grouped as "Others").</p>
        </div>
        <div className="border-t border-white/[0.06] my-3" />

        {loading ? (
          <EmptyState type="loading" message="Loading chart…" />
        ) : chart.length === 0 ? (
          <EmptyState type="empty" message="No spend data for the selected period." />
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
  );
}

/* ---------- helpers ---------- */

function FLabel({ label, children }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-bold uppercase tracking-widest text-slate-500">{label}</span>
      {children}
    </label>
  );
}

const inputCls = "w-full bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2.5 text-slate-200 text-sm outline-none focus:border-blue-500/[0.4] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const btnPrimCls = "text-xs font-bold text-slate-100 px-3 py-1.5 rounded-lg border border-blue-500/[0.3] bg-blue-500/[0.15] hover:bg-blue-500/[0.25] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
