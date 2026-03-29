import { useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "../../api/client.js";

/* ── Formatting helpers ──────────────────────────────────────── */
function fmt$(n) { return n == null ? "—" : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtPct(n) { return n == null ? "—" : `${Number(n).toFixed(1)}%`; }
function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso + "T12:00:00Z").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
  catch { return iso; }
}

/* ── Badge ──────────────────────────────────────────────────── */
function RecBadge({ rec }) {
  const map = {
    PROCEED: "bg-emerald-500/[0.15] text-emerald-400 border-emerald-500/[0.25]",
    WATCH:   "bg-amber-500/[0.15]   text-amber-400   border-amber-500/[0.25]",
    SKIP:    "bg-slate-500/[0.12]   text-slate-400   border-slate-500/[0.2]",
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-bold border ${map[rec] || map.SKIP}`}>
      {rec}
    </span>
  );
}

/* ── Macro Banner ────────────────────────────────────────────── */
function MacroBanner({ macro }) {
  if (!macro) return null;
  return (
    <div className="rounded-2xl border border-blue-500/[0.15] bg-blue-500/[0.05] px-5 py-4">
      <p className="text-xs font-bold uppercase tracking-wide text-blue-400 mb-3">Macro Context</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Fed Policy",     value: macro.fed_policy },
          { label: "Tariff Regime",  value: macro.tariff_regime },
          { label: "Inflation",      value: macro.inflation },
          { label: "Leading Sectors", value: (macro.leading_sectors || []).join(", ") },
        ].map(({ label, value }) => (
          <div key={label}>
            <p className="text-xs text-slate-500 mb-1">{label}</p>
            <p className="text-sm text-slate-200">{value || "—"}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Sortable summary table ──────────────────────────────────── */
const SORT_COLS = [
  { key: "ticker",     label: "Ticker",   cls: "text-left" },
  { key: "sector",     label: "Sector",   cls: "text-left" },
  { key: "adj_score",  label: "Score",    cls: "text-right" },
  { key: "rev_growth", label: "RevGrowth",cls: "text-right" },
  { key: "gross_margin", label: "GrMgn",  cls: "text-right" },
  { key: "de_ratio",   label: "D/E",      cls: "text-right" },
  { key: "roe",        label: "ROE",      cls: "text-right" },
  { key: "recommendation", label: "Rec",  cls: "text-center" },
];

function SummaryTable({ stocks }) {
  const [sort, setSort]   = useState({ col: "adj_score", asc: false });
  const [page, setPage]   = useState(0);
  const [filter, setFilter] = useState("");
  const PAGE_SIZE = 25;

  const sorted = useMemo(() => {
    const q = filter.toLowerCase();
    const base = q
      ? stocks.filter(s =>
          s.ticker.toLowerCase().includes(q) ||
          (s.sector || "").toLowerCase().includes(q) ||
          (s.recommendation || "").toLowerCase().includes(q)
        )
      : [...stocks];
    base.sort((a, b) => {
      const va = a[sort.col] ?? -Infinity;
      const vb = b[sort.col] ?? -Infinity;
      if (typeof va === "string") return sort.asc ? va.localeCompare(vb) : vb.localeCompare(va);
      return sort.asc ? va - vb : vb - va;
    });
    return base;
  }, [stocks, sort, filter]);

  const pages     = Math.ceil(sorted.length / PAGE_SIZE);
  const pageSlice = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function toggleSort(col) {
    setSort(prev => ({ col, asc: prev.col === col ? !prev.asc : false }));
    setPage(0);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Search */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="Filter by ticker, sector, or recommendation…"
          value={filter}
          onChange={e => { setFilter(e.target.value); setPage(0); }}
          className="w-72 bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50"
        />
        <span className="text-xs text-slate-500">{sorted.length} stocks</span>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-white/[0.02]">
              {SORT_COLS.map(col => (
                <th
                  key={col.key}
                  onClick={() => toggleSort(col.key)}
                  className={`px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-500 cursor-pointer hover:text-slate-300 transition-colors select-none ${col.cls}`}
                >
                  {col.label}
                  {sort.col === col.key && (
                    <span className="ml-1">{sort.asc ? "▲" : "▼"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageSlice.map((s, i) => (
              <tr
                key={s.ticker}
                className={`border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors ${i === pageSlice.length - 1 ? "border-b-0" : ""}`}
              >
                <td className="px-4 py-2.5 font-bold text-slate-200">{s.ticker}</td>
                <td className="px-4 py-2.5 text-slate-400 text-xs">{s.sector || "—"}</td>
                <td className="px-4 py-2.5 text-right">
                  <span className={`font-semibold ${s.adj_score >= 75 ? "text-emerald-400" : s.adj_score >= 55 ? "text-amber-400" : "text-slate-400"}`}>
                    {s.adj_score ?? "—"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right text-slate-300">{fmtPct(s.rev_growth)}</td>
                <td className="px-4 py-2.5 text-right text-slate-300">{fmtPct(s.gross_margin)}</td>
                <td className="px-4 py-2.5 text-right text-slate-300">{s.de_ratio ?? "—"}</td>
                <td className="px-4 py-2.5 text-right text-slate-300">{fmtPct(s.roe)}</td>
                <td className="px-4 py-2.5 text-center"><RecBadge rec={s.recommendation} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer hover:bg-white/[0.04] transition-colors"
          >
            ‹ Prev
          </button>
          <span className="text-xs text-slate-500">Page {page + 1} of {pages}</span>
          <button
            type="button"
            onClick={() => setPage(p => Math.min(pages - 1, p + 1))}
            disabled={page >= pages - 1}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer hover:bg-white/[0.04] transition-colors"
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}

/* ── PROCEED card ────────────────────────────────────────────── */
function ProceedCard({ s }) {
  const opt = s.option;
  return (
    <div className="rounded-2xl border border-emerald-500/[0.2] bg-emerald-500/[0.04] p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <span className="text-lg font-black text-slate-100">{s.ticker}</span>
          <span className="ml-2 text-sm text-slate-400">{s.name}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-2xl font-black text-emerald-400">{s.adj_score}</span>
          <RecBadge rec="PROCEED" />
        </div>
      </div>

      <p className="text-sm text-slate-300 mb-4 leading-relaxed">{s.thesis}</p>

      {/* Fundamentals mini row */}
      <div className="grid grid-cols-4 gap-3 mb-4 text-center">
        {[
          { label: "Rev Growth", value: fmtPct(s.rev_growth) },
          { label: "Gr Margin",  value: fmtPct(s.gross_margin) },
          { label: "ROE",        value: fmtPct(s.roe) },
          { label: "D/E",        value: s.de_ratio ?? "—" },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl bg-white/[0.03] border border-white/[0.05] px-3 py-2">
            <p className="text-xs text-slate-500 mb-0.5">{label}</p>
            <p className="text-sm font-bold text-slate-200">{value}</p>
          </div>
        ))}
      </div>

      {/* Options setup */}
      {opt && (
        <div className="rounded-xl border border-emerald-500/[0.15] bg-emerald-500/[0.07] px-4 py-3">
          <p className="text-xs font-bold uppercase tracking-wide text-emerald-400 mb-2">CSP Setup</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div><p className="text-xs text-slate-500">Strike / Expiry</p><p className="font-bold text-slate-200">{fmt$(opt.strike)} · {opt.expiry}</p></div>
            <div><p className="text-xs text-slate-500">Mid Premium</p><p className="font-bold text-emerald-400">{fmt$(opt.mid)}</p></div>
            <div><p className="text-xs text-slate-500">Ann. Yield</p><p className="font-bold text-emerald-400">{fmtPct(opt.ann_yield)}</p></div>
            <div><p className="text-xs text-slate-500">Break-Even</p><p className="font-bold text-slate-200">{fmt$(opt.breakeven)}</p></div>
            <div><p className="text-xs text-slate-500">IV</p><p className="text-slate-300">{fmtPct(opt.iv)}</p></div>
            <div><p className="text-xs text-slate-500">Delta</p><p className="text-slate-300">{opt.delta}</p></div>
            <div><p className="text-xs text-slate-500">DTE</p><p className="text-slate-300">{opt.dte} days</p></div>
            <div><p className="text-xs text-slate-500">Open Interest</p><p className="text-slate-300">{(opt.open_interest || 0).toLocaleString()}</p></div>
          </div>
        </div>
      )}

      {/* Macro note */}
      {s.macro_summary && (
        <p className="mt-3 text-xs text-slate-500">{s.macro_summary}</p>
      )}

      {/* Risk flags */}
      {s.risk_flags?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {s.risk_flags.map((f, i) => (
            <span key={i} className="text-xs px-2 py-0.5 rounded-md bg-amber-500/[0.1] border border-amber-500/[0.2] text-amber-400">{f}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── WATCH compact card ──────────────────────────────────────── */
function WatchCard({ s }) {
  const opt = s.option;
  return (
    <div className="rounded-2xl border border-amber-500/[0.15] bg-amber-500/[0.03] p-4">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <span className="font-black text-slate-200">{s.ticker}</span>
          <span className="ml-1.5 text-xs text-slate-500">{s.sector}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-lg font-black text-amber-400">{s.adj_score}</span>
          <RecBadge rec="WATCH" />
        </div>
      </div>
      <p className="text-xs text-slate-400 mb-3 leading-relaxed">{s.thesis}</p>
      {opt && (
        <div className="flex flex-wrap gap-3 text-xs">
          <span className="text-slate-500">Strike <span className="text-slate-300 font-semibold">{fmt$(opt.strike)}</span></span>
          <span className="text-slate-500">Mid <span className="text-amber-400 font-semibold">{fmt$(opt.mid)}</span></span>
          <span className="text-slate-500">Yield <span className="text-amber-400 font-semibold">{fmtPct(opt.ann_yield)}</span></span>
          <span className="text-slate-500">Expiry <span className="text-slate-300">{opt.expiry}</span></span>
          <span className="text-slate-500">IV <span className="text-slate-300">{fmtPct(opt.iv)}</span></span>
        </div>
      )}
      {s.risk_flags?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {s.risk_flags.map((f, i) => (
            <span key={i} className="text-xs px-1.5 py-0.5 rounded bg-amber-500/[0.08] text-amber-500/80">{f}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main page ───────────────────────────────────────────────── */
export default function WheelScanResult() {
  const { scanId } = useParams();
  const navigate   = useNavigate();

  const endpoint = scanId === "latest" ? "/wheel/scan/latest" : `/wheel/scan/${scanId}`;
  const qKey     = scanId === "latest" ? queryKeys.wheelLatest() : queryKeys.wheelScan(scanId);

  const { data, isLoading, isError } = useQuery({
    queryKey: qKey,
    queryFn:  () => api.get(endpoint),
    staleTime: 10 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 text-sm">
        Loading scan…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-red-400 text-sm">Scan not found or failed to load.</p>
        <button
          type="button"
          onClick={() => navigate("/research/wheel-scan")}
          className="text-sm text-blue-400 hover:text-blue-300 underline cursor-pointer"
        >
          ← Back to scans
        </button>
      </div>
    );
  }

  const stocks  = data.stocks || [];
  const proceed = stocks.filter(s => s.recommendation === "PROCEED");
  const watch   = stocks.filter(s => s.recommendation === "WATCH");
  const skip    = stocks.filter(s => s.recommendation === "SKIP");

  return (
    <div className="flex flex-col gap-8 p-6 max-w-6xl mx-auto">
      {/* Back + header */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate("/research/wheel-scan")}
          className="text-slate-400 hover:text-slate-200 text-sm cursor-pointer transition-colors"
        >
          ← Scans
        </button>
        <span className="text-slate-700">·</span>
        <h1 className="text-xl font-black text-slate-100">
          Wheel Scan — {fmtDate(data.scan_date)}
        </h1>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
        {[
          { label: "Stocks Scanned",  value: data.universe_size,  color: "text-slate-200" },
          { label: "Proceed",         value: data.proceed_count,  color: "text-emerald-400" },
          { label: "Watch",           value: data.watch_count,    color: "text-amber-400" },
          { label: "Skip",            value: data.skip_count,     color: "text-slate-400" },
          { label: "Duration",        value: data.duration_s ? `${Math.round(data.duration_s / 60)}m ${data.duration_s % 60}s` : "—", color: "text-slate-300" },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-3 py-3 text-center">
            <p className="text-xs text-slate-500 mb-1 truncate">{label}</p>
            <p className={`text-xl font-black ${color}`}>{value ?? "—"}</p>
          </div>
        ))}
      </div>

      {/* Macro banner */}
      <MacroBanner macro={data.macro_context} />

      {/* Full summary table */}
      <section>
        <h2 className="text-base font-black text-slate-200 uppercase tracking-wide mb-4">All Stocks</h2>
        <SummaryTable stocks={stocks} />
      </section>

      {/* PROCEED cards */}
      {proceed.length > 0 && (
        <section>
          <h2 className="text-base font-black text-emerald-400 uppercase tracking-wide mb-4">
            Proceed ({proceed.length})
          </h2>
          <div className="grid gap-4">
            {proceed.map(s => <ProceedCard key={s.ticker} s={s} />)}
          </div>
        </section>
      )}

      {/* WATCH cards */}
      {watch.length > 0 && (
        <section>
          <h2 className="text-base font-black text-amber-400 uppercase tracking-wide mb-4">
            Watch ({watch.length})
          </h2>
          <div className="grid md:grid-cols-2 gap-4">
            {watch.map(s => <WatchCard key={s.ticker} s={s} />)}
          </div>
        </section>
      )}

      {/* SKIP table */}
      {skip.length > 0 && (
        <section>
          <h2 className="text-base font-black text-slate-500 uppercase tracking-wide mb-4">
            Skip ({skip.length})
          </h2>
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden overflow-x-auto">
            <div className="min-w-[520px]">
              <div className="grid px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]"
                style={{ gridTemplateColumns: "90px 1fr 70px 70px 100px" }}>
                {["Ticker", "Sector", "Score", "Rev%", "Reason"].map(h => (
                  <span key={h} className="text-xs font-bold uppercase tracking-wide text-slate-600 text-center first:text-left">{h}</span>
                ))}
              </div>
              {skip.map((s, i) => (
                <div key={s.ticker}
                  className={`grid items-center px-4 py-2.5 ${i < skip.length - 1 ? "border-b border-white/[0.04]" : ""}`}
                  style={{ gridTemplateColumns: "90px 1fr 70px 70px 100px" }}>
                  <span className="text-sm font-bold text-slate-400">{s.ticker}</span>
                  <span className="text-xs text-slate-600">{s.sector}</span>
                  <span className="text-sm text-slate-500 text-center">{s.adj_score}</span>
                  <span className="text-xs text-slate-500 text-center">{fmtPct(s.rev_growth)}</span>
                  <span className="text-xs text-slate-600 truncate" title={s.macro_summary}>{s.macro_summary?.slice(0, 50) || "—"}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
