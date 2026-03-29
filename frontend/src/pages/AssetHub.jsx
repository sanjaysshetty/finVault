import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { PageHeader } from "../components/ui/PageHeader.jsx";
import { PageIcons } from "../components/ui/PageIcons.jsx";
import { formatMoney, safeNum } from "../utils/format.js";
import puppySvg from "../assets/puppy.svg";

/* ── helpers ─────────────────────────────────────────────────── */

function pct(v, decimals = 1) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return `${(Number(v) * 100).toFixed(decimals)}%`;
}

function num(v, decimals = 1) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Number(v).toFixed(decimals);
}

function dollar(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* ── sub-components ──────────────────────────────────────────── */

function RecBadge({ rec }) {
  const cfg = {
    BUY:   { bg: "bg-emerald-500/[0.15]", border: "border-emerald-500/[0.3]",  text: "text-emerald-400" },
    WATCH: { bg: "bg-amber-500/[0.15]",   border: "border-amber-500/[0.3]",    text: "text-amber-400" },
    AVOID: { bg: "bg-red-500/[0.15]",     border: "border-red-500/[0.3]",      text: "text-red-400" },
  }[rec] ?? { bg: "bg-slate-500/[0.15]", border: "border-slate-500/[0.3]", text: "text-slate-400" };
  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-lg text-sm font-black border ${cfg.bg} ${cfg.border} ${cfg.text}`}>
      {rec}
    </span>
  );
}

function ConfBadge({ conf }) {
  const cfg = {
    HIGH:   "bg-blue-500/[0.12] border-blue-500/[0.25] text-blue-400",
    MEDIUM: "bg-slate-500/[0.12] border-slate-500/[0.25] text-slate-400",
    LOW:    "bg-orange-500/[0.12] border-orange-500/[0.25] text-orange-400",
  }[conf] ?? "bg-slate-500/[0.12] border-slate-500/[0.25] text-slate-400";
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-semibold border ${cfg}`}>
      {conf} confidence
    </span>
  );
}

function Card({ children, className = "" }) {
  return (
    <div className={`rounded-2xl border border-white/[0.07] bg-[#0F1729] p-5 ${className}`}>
      {children}
    </div>
  );
}

function SectionTitle({ children }) {
  return <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-3">{children}</div>;
}

function Bullet({ items, positive }) {
  if (!items?.length) return null;
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex items-start gap-2 text-sm text-slate-300 leading-relaxed">
          <span className={`mt-0.5 shrink-0 text-xs font-black ${positive ? "text-emerald-400" : "text-red-400"}`}>
            {positive ? "▲" : "▼"}
          </span>
          {it}
        </li>
      ))}
    </ul>
  );
}

function ScoreBar({ score, label }) {
  const color = score >= 75 ? "#4ade80" : score >= 50 ? "#facc15" : "#f87171";
  const defaultLabel = score >= 75 ? "Strong" : score >= 50 ? "Moderate" : "Weak";
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2 rounded-full bg-white/[0.06]">
        <div className="h-2 rounded-full transition-all duration-700" style={{ width: `${score}%`, background: color }} />
      </div>
      <span className="text-xs font-bold shrink-0" style={{ color }}>{label ?? defaultLabel} · {score}/100</span>
    </div>
  );
}

function ProbBadge({ prob }) {
  const cfg = prob === "HIGH"
    ? "text-emerald-400 bg-emerald-500/[0.12] border-emerald-500/[0.25]"
    : "text-amber-400 bg-amber-500/[0.12] border-amber-500/[0.25]";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-black border ml-1 ${cfg}`}>
      {prob}
    </span>
  );
}

/* loading steps */
const STEPS = [
  { key: "market",    label: "Fetching live market data…" },
  { key: "portfolio", label: "Loading your portfolio…" },
  { key: "ai",        label: "Running AI analysis…" },
  { key: "done",      label: "Complete" },
];

function LoadingState({ step }) {
  const idx = STEPS.findIndex(s => s.key === step);
  return (
    <div className="flex flex-col items-center gap-6 py-12">
      <img src={puppySvg} alt="Loading" className="w-28 h-28 opacity-80 animate-bounce" style={{ animationDuration: "1.4s" }} />
      <div className="text-slate-400 text-sm font-semibold">Analyzing your asset…</div>
      <div className="w-full max-w-xs space-y-2.5">
        {STEPS.slice(0, 3).map((s, i) => {
          const done    = i < idx;
          const active  = i === idx;
          return (
            <div key={s.key} className="flex items-center gap-3">
              <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-xs font-black transition-all
                ${done   ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" :
                  active ? "bg-blue-500/20 text-blue-400 border border-blue-500/30 animate-pulse" :
                           "bg-white/[0.04] text-slate-600 border border-white/[0.08]"}`}>
                {done ? "✓" : i + 1}
              </div>
              <span className={`text-xs font-medium ${done ? "text-emerald-400" : active ? "text-blue-400" : "text-slate-600"}`}>
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── main page ───────────────────────────────────────────────── */

const ASSET_TYPES = [
  { key: "stock",   label: "Stock / Options", enabled: true },
  { key: "futures", label: "Futures",         enabled: false },
  { key: "crypto",  label: "Crypto",          enabled: false },
  { key: "bullion", label: "Bullion",          enabled: false },
  { key: "bonds",   label: "Bonds / FI",       enabled: false },
];

function ConfirmModal({ ticker, assetType, isForceRefresh, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
      />
      {/* Dialog */}
      <div className="relative w-full max-w-sm rounded-2xl border border-white/[0.1] bg-[#0F1729] p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${isForceRefresh ? "bg-orange-500/[0.15] border-orange-500/[0.25]" : "bg-blue-500/[0.15] border-blue-500/[0.25]"}`}>
            {isForceRefresh ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className="w-5 h-5 text-orange-400">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 9a8 8 0 0 1 14.9-2.9M20 15a8 8 0 0 1-14.9 2.9" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className="w-5 h-5 text-blue-400">
                <circle cx="11" cy="11" r="7" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 16.5l4 4" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 11h6M11 8v6" />
              </svg>
            )}
          </div>
          <div>
            <div className="text-sm font-bold text-slate-100">{isForceRefresh ? "Generate Fresh Report?" : "Run AI Analysis?"}</div>
            <div className="text-xs text-slate-500">{isForceRefresh ? "Bypasses cache · fetches live data + re-runs Claude" : "This will call Claude + fetch live market data"}</div>
          </div>
        </div>

        <div className="mb-5 rounded-xl bg-white/[0.04] border border-white/[0.07] px-4 py-3 flex items-center justify-between">
          <div>
            <div className="text-lg font-black text-slate-100 font-mono">{ticker}</div>
            <div className="text-xs text-slate-500 mt-0.5 capitalize">{assetType} analysis</div>
          </div>
          <div className="text-xs text-slate-500 bg-white/[0.05] px-2.5 py-1 rounded-lg border border-white/[0.07]">
            ~30–60s
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-slate-400 hover:bg-white/[0.07] hover:text-slate-200 transition-all cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 transition-all cursor-pointer"
          >
            Analyze →
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AssetHub() {
  const [ticker,    setTicker]    = useState("");
  const [assetType, setAssetType] = useState("stock");
  const [loadStep,  setLoadStep]  = useState(null);   // null | "market" | "portfolio" | "ai" | "done"
  const [result,    setResult]    = useState(null);
  const [error,     setError]     = useState("");
  const [confirm,      setConfirm]      = useState(false);
  const [pendingForce, setPendingForce] = useState(false);  // true when modal is for force-refresh
  const [cacheInfo,    setCacheInfo]    = useState(null);   // { cached: bool, cachedAt: string } | null
  const inputRef = useRef(null);

  const { data: reportsData, refetch: refetchReports } = useQuery({
    queryKey: ["assetHubReports"],
    queryFn:  () => api.get("/assets/hub/reports"),
    staleTime: 60_000,
  });

  async function pollResult(jobId) {
    const MAX_POLLS = 90; // 90 × 2s = 3 min max
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const data = await api.get(`/assets/hub/result/${jobId}`);
      if (data.status === "done")   return data.result;
      if (data.status === "error")  throw new Error(data.error || "Analysis failed");
      // "pending" → keep polling
    }
    throw new Error("Analysis timed out. Please try again.");
  }

  async function handleAnalyze(forceRefresh = false) {
    const t = ticker.trim().toUpperCase();
    if (!t) { inputRef.current?.focus(); return; }

    setResult(null);
    setError("");
    setCacheInfo(null);
    setLoadStep("market");

    try {
      // Step 1: submit — returns {jobId, cached, cachedAt}
      const submission = await api.post("/assets/hub/analyze", { ticker: t, assetType, forceRefresh });
      const { jobId, cached, cachedAt } = submission;

      if (cached) {
        // Cached — first poll will return done immediately, no need for long loading steps
        setLoadStep("ai");
      } else {
        setLoadStep("portfolio");
      }
      const t1 = !cached ? setTimeout(() => setLoadStep("ai"), 3000) : null;

      try {
        const data = await pollResult(jobId);
        if (t1) clearTimeout(t1);
        setLoadStep("done");
        setResult(data);
        setCacheInfo({ cached, cachedAt: cachedAt || null });
        refetchReports();
      } catch (e) {
        if (t1) clearTimeout(t1);
        throw e;
      }
    } catch (e) {
      setLoadStep(null);
      setError(e?.detail?.error || e?.message || "Analysis failed. Check the ticker and try again.");
    }
  }

  async function handleLoadCached(cachedTicker) {
    setTicker(cachedTicker);
    setResult(null);
    setError("");
    setCacheInfo(null);
    setLoadStep("ai");
    try {
      const submission = await api.post("/assets/hub/analyze", { ticker: cachedTicker, assetType, forceRefresh: false });
      const { jobId, cached, cachedAt } = submission;
      const data = await pollResult(jobId);
      setLoadStep("done");
      setResult(data);
      setCacheInfo({ cached, cachedAt: cachedAt || null });
      refetchReports();
    } catch (e) {
      setLoadStep(null);
      setError(e?.detail?.error || e?.message || "Failed to load report.");
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter") handleRequestAnalyze();
  }

  function handleRequestAnalyze(force = false) {
    const t = ticker.trim().toUpperCase();
    if (!t) { inputRef.current?.focus(); return; }
    setPendingForce(force);
    setConfirm(true);
  }

  const a = result?.analysis || {};
  const loading = loadStep && loadStep !== "done";

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Asset Hub"
        subtitle="AI-powered end-to-end analysis personalized to your portfolio"
        icon={PageIcons.assetHub}
      />

      {/* ── Search card ── */}
      <Card>
        {/* Asset type tabs */}
        <div className="flex flex-wrap gap-2 mb-4">
          {ASSET_TYPES.map(at => (
            <button
              key={at.key}
              type="button"
              disabled={!at.enabled}
              onClick={() => at.enabled && setAssetType(at.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all
                ${!at.enabled
                  ? "text-slate-600 bg-white/[0.03] cursor-not-allowed"
                  : assetType === at.key
                    ? "bg-blue-600 text-white"
                    : "bg-white/[0.05] text-slate-400 hover:bg-white/[0.08] cursor-pointer"}`}
            >
              {at.label}
              {!at.enabled && <span className="ml-1.5 text-[11px] opacity-60">soon</span>}
            </button>
          ))}
        </div>

        {/* Ticker input */}
        <div className="flex gap-3 items-center">
          <input
            ref={inputRef}
            value={ticker}
            onChange={e => setTicker(e.target.value.toUpperCase())}
            onKeyDown={handleKeyDown}
            placeholder="Enter ticker — e.g. NVDA, AAPL, MSFT"
            className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500/50 font-mono tracking-wide"
          />
          <button
            type="button"
            onClick={() => handleRequestAnalyze()}
            disabled={loading}
            className={`px-5 py-3 rounded-xl text-sm font-semibold transition-all shrink-0
              ${loading
                ? "bg-blue-600/40 text-blue-400 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-500 text-white cursor-pointer"}`}
          >
            {loading ? "Analyzing…" : "Analyze →"}
          </button>
        </div>

        <p className="mt-3 text-xs text-slate-500">
          Analyzes fundamentals, options chain, macro fit, and your portfolio to give a personalized recommendation.
        </p>
      </Card>

      {/* ── Recent cached reports ── */}
      {!loading && !result && reportsData?.reports?.length > 0 && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Cached Reports</div>
            <span className="text-xs text-slate-600">Click to load · refreshes automatically after 7 days</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {reportsData.reports.map(r => {
              const ageLabel = r.age_days === 0 ? "Today" : `${r.age_days}d ago`;
              return (
                <button
                  key={r.ticker}
                  type="button"
                  onClick={() => handleLoadCached(r.ticker)}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] hover:border-blue-500/30 transition-all cursor-pointer group"
                >
                  <span className="text-sm font-black text-slate-100 font-mono group-hover:text-blue-400 transition-colors">
                    {r.ticker}
                  </span>
                  <span className="text-xs text-slate-500">{ageLabel}</span>
                </button>
              );
            })}
          </div>
        </Card>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="rounded-xl bg-red-500/[0.1] border border-red-500/[0.25] px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* ── Loading state ── */}
      {loading && (
        <Card>
          <LoadingState step={loadStep} />
        </Card>
      )}

      {/* ── Results ── */}
      {result && !loading && (
        <div className="flex flex-col gap-4">

          {/* Hero */}
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <RecBadge rec={a.recommendation} />
                  <ConfBadge conf={a.confidence} />
                </div>
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className="text-2xl font-black text-slate-100 font-mono">{result.ticker}</span>
                  <span className="text-slate-400 text-sm truncate">{result.name}</span>
                </div>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  <span className="text-lg font-black text-slate-100 font-mono">{dollar(result.price)}</span>
                  <span className={`text-sm font-semibold ${safeNum(result.day_change_pct, 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {safeNum(result.day_change_pct, 0) >= 0 ? "▲" : "▼"} {Math.abs(safeNum(result.day_change_pct, 0)).toFixed(2)}%
                  </span>
                  {result.sector && <span className="text-xs text-slate-500 bg-white/[0.05] px-2 py-0.5 rounded-md">{result.sector}</span>}
                  {result.market_cap_b > 0 && <span className="text-xs text-slate-500">${result.market_cap_b.toFixed(1)}B</span>}
                </div>
              </div>
              <div className="text-xs text-slate-600 shrink-0 mt-1">
                {new Date(result.analyzed_at).toLocaleString()}
              </div>
            </div>

            {a.summary && (
              <p className="mt-4 text-sm text-slate-300 leading-relaxed border-t border-white/[0.06] pt-4">
                {a.summary}
              </p>
            )}
          </Card>

          {/* ── Cache banner ── */}
          {cacheInfo?.cached && (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-amber-500/[0.08] border border-amber-500/[0.2] px-4 py-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className="w-4 h-4 shrink-0 text-amber-400">
                  <circle cx="12" cy="12" r="9" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 3" />
                </svg>
                <span className="text-xs text-amber-300 font-medium">
                  {cacheInfo.cachedAt
                    ? (() => {
                        const days = Math.floor((Date.now() - new Date(cacheInfo.cachedAt).getTime()) / 86400000);
                        return days === 0 ? "Cached report from today" : `Cached report from ${days} day${days !== 1 ? "s" : ""} ago`;
                      })()
                    : "Serving cached report"
                  }
                  <span className="text-amber-500/70 ml-1">· Reports refresh automatically after 7 days</span>
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleRequestAnalyze(true)}
                className="shrink-0 text-xs font-semibold text-amber-300 bg-amber-500/[0.12] border border-amber-500/[0.25] hover:bg-amber-500/[0.2] px-3 py-1.5 rounded-lg transition-all cursor-pointer whitespace-nowrap"
              >
                ↺ Fresh Report
              </button>
            </div>
          )}

          {/* ── Price & Performance — full width ── */}
          <div>

            {/* Price & Performance — 52W/ATH + targets + scenarios */}
            <Card>
              <SectionTitle>Price &amp; Performance</SectionTitle>

              {/* 52W / ATH / P/E stats */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
                {[
                  {
                    label: "52W High",
                    value: dollar(result.week52_high),
                    sub: result.week52_high > 0 && result.price > 0
                      ? `${(((result.week52_high - result.price) / result.week52_high) * 100).toFixed(1)}% · ${dollar(result.week52_high - result.price)} below`
                      : null,
                    subColor: "text-red-400",
                  },
                  {
                    label: "52W Low",
                    value: dollar(result.week52_low),
                    sub: result.week52_low > 0 && result.price > 0
                      ? `${(((result.price - result.week52_low) / result.week52_low) * 100).toFixed(1)}% above`
                      : null,
                    subColor: "text-emerald-400",
                  },
                  {
                    label: "All-Time High",
                    value: result.all_time_high > 0 ? dollar(result.all_time_high) : "—",
                    sub: result.all_time_high > 0 && result.price > 0
                      ? `${(((result.all_time_high - result.price) / result.all_time_high) * 100).toFixed(1)}% · ${dollar(result.all_time_high - result.price)} below`
                      : null,
                    subColor: "text-orange-400",
                  },
                  {
                    label: "Market Cap",
                    value: result.market_cap_b > 0 ? `$${result.market_cap_b.toFixed(1)}B` : "—",
                    sub: result.sector || null,
                    subColor: "text-slate-500",
                  },
                ].map(({ label, value, sub, subColor }) => (
                  <div key={label} className="bg-white/[0.03] rounded-xl px-3 py-2.5">
                    <div className="text-xs text-slate-500 font-semibold uppercase tracking-wide mb-1">{label}</div>
                    <div className="text-sm font-black text-slate-100 font-mono">{value}</div>
                    {sub && <div className={`text-xs font-medium mt-0.5 leading-tight ${subColor}`}>{sub}</div>}
                  </div>
                ))}

                {/* P/E card */}
                <div className="bg-white/[0.03] rounded-xl px-3 py-2.5">
                  <div className="text-xs text-slate-500 font-semibold uppercase tracking-wide mb-1">P/E Ratio</div>
                  <div className="text-sm font-black text-slate-100 font-mono">
                    {result.pe_trailing != null ? Number(result.pe_trailing).toFixed(1) : "—"}
                  </div>
                  <div className="flex flex-col gap-0.5 mt-1">
                    {result.pe_forward != null && (
                      <div className="text-xs text-slate-500">
                        Fwd <span className="text-slate-300 font-semibold font-mono">{Number(result.pe_forward).toFixed(1)}</span>
                      </div>
                    )}
                    {a.industry_pe != null && (
                      <div className={`text-xs font-medium ${
                        result.pe_trailing != null
                          ? result.pe_trailing > a.industry_pe ? "text-red-400" : "text-emerald-400"
                          : "text-slate-500"
                      }`}>
                        Industry {Number(a.industry_pe).toFixed(1)}x
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Price targets + Return scenarios side by side */}
              <div className="border-t border-white/[0.06] pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Price Targets</div>
                    <span className="text-[11px] text-slate-600 italic">AI-modeled · analyst mean: {result.analyst_target_mean > 0 ? dollar(result.analyst_target_mean) : "N/A"}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      ["3M", a.price_targets?.["3_month"], a.price_targets?.["3_month_probability"]],
                      ["1Y", a.price_targets?.["1_year"],  a.price_targets?.["1_year_probability"]],
                      ["3Y", a.price_targets?.["3_year"],  a.price_targets?.["3_year_probability"]],
                    ].map(([label, val, prob]) => (
                      <div key={label} className="bg-white/[0.03] rounded-lg p-2 text-center">
                        <div className="flex items-center justify-center gap-0.5 mb-1">
                          <span className="text-xs text-slate-500 font-semibold uppercase">{label}</span>
                          {prob && <ProbBadge prob={prob} />}
                        </div>
                        <div className="text-xs font-black text-slate-100 font-mono">{dollar(val)}</div>
                        {val && result.price > 0 && (
                          <div className={`text-xs font-semibold mt-0.5 ${val > result.price ? "text-emerald-400" : "text-red-400"}`}>
                            {val > result.price ? "+" : ""}{(((val - result.price) / result.price) * 100).toFixed(1)}%
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Annual Return Scenarios</div>
                  <div className="space-y-1.5">
                    {[
                      ["Base", a.return_potential?.base_case_annual_pct, "text-blue-400",    "bg-blue-500/10"],
                      ["Bull", a.return_potential?.bull_case_annual_pct, "text-emerald-400", "bg-emerald-500/10"],
                      ["Bear", a.return_potential?.bear_case_annual_pct, "text-red-400",     "bg-red-500/10"],
                    ].map(([label, val, textCls, bgCls]) => (
                      <div key={label} className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 ${bgCls}`}>
                        <span className="text-[11px] text-slate-400 font-medium">{label}</span>
                        <span className={`text-xs font-black font-mono ${textCls}`}>
                          {val != null ? `${val >= 0 ? "+" : ""}${Number(val).toFixed(1)}% / yr` : "—"}
                        </span>
                      </div>
                    ))}
                    <p className="text-[11px] text-slate-600 pt-0.5">Target: 20–30% annual · Horizon: 3m–3yr</p>
                  </div>
                </div>
              </div>
            </Card>

          </div>

          {/* ── Fundamentals — full width, strengths/concerns side by side ── */}
          <Card>
            <div className="flex items-center gap-4 mb-3">
              <SectionTitle>Fundamentals</SectionTitle>
              <div className="flex-1"><ScoreBar score={a.fundamental_score ?? 0} /></div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div>
                <div className="text-xs font-bold text-emerald-500 uppercase tracking-wider mb-1.5">Strengths</div>
                <Bullet items={a.fundamental_highlights} positive={true} />
              </div>
              <div>
                <div className="text-xs font-bold text-red-500 uppercase tracking-wider mb-1.5">Concerns</div>
                <Bullet items={a.fundamental_concerns} positive={false} />
              </div>
            </div>
          </Card>

          {/* ── Portfolio Fit & Diversification — full width ── */}
          <div>

            {/* Combined Portfolio Fit & Diversification */}
            {(a.portfolio_fit || a.portfolio_diversification) && (
              <Card>
                <div className="flex items-center gap-4 mb-4">
                  <SectionTitle>Portfolio Fit &amp; Diversification</SectionTitle>
                  {a.portfolio_diversification?.score != null && (
                    <div className="flex-1">
                      {/* Before → After direction */}
                      {a.portfolio_diversification.score_before != null && (() => {
                        const before = a.portfolio_diversification.score_before;
                        const after  = a.portfolio_diversification.score;
                        const delta  = after - before;
                        const deltaColor = delta > 0 ? "text-emerald-400" : delta < 0 ? "text-red-400" : "text-slate-500";
                        return (
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <span className="text-xs text-slate-500">Now: <span className="font-bold text-slate-400">{before}/100</span></span>
                            <span className="text-xs text-slate-600">→</span>
                            <span className="text-xs text-slate-500">After: <span className="font-bold text-slate-400">{after}/100</span></span>
                            <span className={`text-xs font-black ${deltaColor}`}>
                              ({delta > 0 ? "+" : ""}{delta})
                            </span>
                          </div>
                        );
                      })()}
                      <ScoreBar
                        score={a.portfolio_diversification.score}
                        label={a.portfolio_diversification.score >= 70 ? "Well Diversified" : a.portfolio_diversification.score >= 45 ? "Moderate" : "Concentrated"}
                      />
                    </div>
                  )}
                </div>

                {/* Row 1: Allocation + Concentration + Entry Strategy */}
                {a.portfolio_fit && (
                  <div className="grid grid-cols-1 sm:grid-cols-5 gap-4 mb-4">
                    <div className="bg-white/[0.03] rounded-xl px-4 py-3 flex flex-col justify-center">
                      <div className="text-xs text-slate-500 font-semibold uppercase mb-1 text-center">Allocation</div>
                      <div className="text-2xl font-black text-blue-400 font-mono text-center">
                        {a.portfolio_fit.suggested_allocation_pct != null ? `${a.portfolio_fit.suggested_allocation_pct}%` : "—"}
                      </div>
                      {result.allocation_dollars > 0 && (
                        <div className="text-sm font-black text-slate-200 font-mono text-center mt-0.5">
                          ~{formatMoney(result.allocation_dollars)}
                        </div>
                      )}
                      <div className="text-[11px] text-slate-600 text-center mt-0.5">of portfolio</div>
                      {result.allocation_dollars > 0 && (
                        <div className="mt-3 pt-2.5 border-t border-white/[0.06] space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-slate-500">Buy stock</span>
                            <span className="text-slate-200 font-mono font-bold">{formatMoney(result.allocation_dollars)}</span>
                          </div>
                          {a.portfolio_fit.options_capital_required > 0 && (
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-slate-500">Via options</span>
                              <span className="text-cyan-400 font-mono font-bold">~{formatMoney(a.portfolio_fit.options_capital_required)}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="sm:col-span-2">
                      <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Concentration</div>
                      <p className="text-sm text-slate-300 leading-relaxed">{a.portfolio_fit.concentration_note}</p>
                    </div>
                    <div className="sm:col-span-2">
                      <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Entry Strategy</div>
                      <p className="text-sm text-slate-300 leading-relaxed">{a.portfolio_fit.entry_strategy}</p>
                    </div>
                  </div>
                )}

                {/* Row 2: Diversification details */}
                {a.portfolio_diversification && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-white/[0.06]">
                    <div>
                      <div className="text-xs font-bold text-red-500 uppercase tracking-wider mb-1.5">Overexposed</div>
                      {a.portfolio_diversification.overexposed?.length > 0
                        ? <Bullet items={a.portfolio_diversification.overexposed} positive={false} />
                        : <p className="text-xs text-slate-500">None identified</p>
                      }
                    </div>
                    <div>
                      <div className="text-xs font-bold text-blue-400 uppercase tracking-wider mb-1">Correlation</div>
                      <p className="text-sm text-slate-300 leading-relaxed">{a.portfolio_diversification.correlation_note}</p>
                    </div>
                    <div>
                      <div className="text-xs font-bold text-emerald-500 uppercase tracking-wider mb-1">Diversification Take</div>
                      <p className="text-sm text-slate-300 leading-relaxed">{a.portfolio_diversification.recommendation}</p>
                    </div>
                  </div>
                )}
              </Card>
            )}

          </div>

          {/* ── Macro, Sector & Geopolitical — full width, 3 columns ── */}
          <Card>
            <SectionTitle>Macro, Sector &amp; Geopolitical</SectionTitle>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              <div>
                <div className="text-xs font-bold text-emerald-500 uppercase tracking-wider mb-1.5">Tailwinds</div>
                <Bullet items={a.macro_tailwinds} positive={true} />
              </div>
              <div>
                <div className="text-xs font-bold text-red-500 uppercase tracking-wider mb-1.5">Headwinds</div>
                <Bullet items={a.macro_headwinds} positive={false} />
              </div>
              <div>
                <div className="text-xs font-bold text-orange-500 uppercase tracking-wider mb-1.5">Geopolitical</div>
                <Bullet items={a.geopolitical_risks} positive={false} />
              </div>
            </div>
            {a.technical_note && (
              <div className="mt-4 pt-4 border-t border-white/[0.06]">
                <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Technical</div>
                <p className="text-sm text-slate-400 leading-relaxed">{a.technical_note}</p>
              </div>
            )}
          </Card>

          {/* Options Strategies */}
          {a.options_strategies?.length > 0 && (
            <Card>
              {/* Header + ownership slider */}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <SectionTitle>Ownership &amp; Options Strategies</SectionTitle>
                  {a.options_ownership_slider != null && (() => {
                    const sl = a.options_ownership_slider;
                    const label = sl <= 25 ? "Ownership First" : sl <= 50 ? "Own + Overlay" : sl <= 75 ? "Options Leaning" : "Pure Options Play";
                    const color = sl <= 40 ? "#4ade80" : sl <= 65 ? "#facc15" : "#f87171";
                    return (
                      <span className="text-xs font-black px-2 py-0.5 rounded-lg border shrink-0"
                        style={{ color, borderColor: `${color}40`, background: `${color}12` }}>
                        {label}
                      </span>
                    );
                  })()}
                </div>
                {a.options_ownership_slider != null && (() => {
                  const sl = a.options_ownership_slider;
                  const color = sl <= 40 ? "#4ade80" : sl <= 65 ? "#facc15" : "#f87171";
                  return (
                    <div>
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="text-emerald-500 font-semibold">Ownership</span>
                        <span className="text-red-400 font-semibold">Options Play</span>
                      </div>
                      <div className="relative h-2 rounded-full bg-gradient-to-r from-emerald-500/30 via-amber-500/30 to-red-500/30">
                        <div
                          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white/80 shadow-md"
                          style={{ left: `calc(${sl}% - 6px)`, background: color }}
                        />
                      </div>
                      {a.options_ownership_rationale && (
                        <p className="text-sm text-slate-400 mt-2 leading-relaxed italic">
                          {a.options_ownership_rationale}
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>

              <div className="space-y-3">
                {a.options_strategies.map((s, i) => {
                  const purposeCfg = {
                    OWNERSHIP:    { label: "Ownership",    cls: "text-emerald-400 bg-emerald-500/[0.1] border-emerald-500/[0.2]" },
                    INCOME:       { label: "Income",       cls: "text-blue-400 bg-blue-500/[0.1] border-blue-500/[0.2]" },
                    OPTIONS_PLAY: { label: "Options Play", cls: "text-orange-400 bg-orange-500/[0.1] border-orange-500/[0.2]" },
                  }[s.purpose] ?? { label: s.purpose, cls: "text-slate-400 bg-white/[0.05] border-white/[0.1]" };

                  return (
                    <div key={i} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          {s.purpose && (
                            <span className={`text-xs font-black px-2 py-0.5 rounded border ${purposeCfg.cls}`}>
                              {purposeCfg.label}
                            </span>
                          )}
                          <span className="text-sm font-black text-slate-100">{s.strategy}</span>
                          {s.suggested_strike > 0 && (
                            <span className="text-xs font-mono text-cyan-400 bg-cyan-500/[0.1] border border-cyan-500/[0.2] px-2 py-0.5 rounded">
                              Strike {dollar(s.suggested_strike)}
                            </span>
                          )}
                          {s.suggested_expiry && (
                            <span className="text-xs text-slate-500 bg-white/[0.04] px-2 py-0.5 rounded">
                              {s.suggested_expiry}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {s.estimated_premium != null && (
                            <span className="text-xs font-mono text-emerald-400">{dollar(s.estimated_premium)} premium</span>
                          )}
                          {s.ann_yield_pct != null && (
                            <span className="text-xs font-black text-emerald-400 bg-emerald-500/[0.1] border border-emerald-500/[0.2] px-2 py-0.5 rounded">
                              {Number(s.ann_yield_pct).toFixed(1)}% ann.
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="text-sm text-slate-400 leading-relaxed mb-2">{s.rationale}</p>
                      {s.goal_alignment && (
                        <div className="flex items-start gap-2 bg-blue-500/[0.07] border border-blue-500/[0.15] rounded-lg px-3 py-2">
                          <span className="text-blue-400 text-xs font-black shrink-0 mt-0.5">→</span>
                          <p className="text-sm text-blue-300 leading-relaxed">{s.goal_alignment}</p>
                        </div>
                      )}
                      {s.max_risk && (
                        <div className="mt-2 text-xs text-slate-500">
                          <span className="font-semibold text-red-400/80">Max risk:</span> {s.max_risk}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Risks + Catalysts */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <SectionTitle>Key Risks</SectionTitle>
              {a.key_risks?.length > 0 && (
                <ul className="space-y-2">
                  {a.key_risks.map((r, i) => {
                    // Support both new object format {risk, score} and old string format
                    const text  = typeof r === "string" ? r : r.risk;
                    const score = typeof r === "object" ? r.score : null;
                    const scoreColor = score == null ? "" : score >= 8 ? "text-red-400 bg-red-500/[0.1] border-red-500/[0.2]"
                      : score >= 5 ? "text-amber-400 bg-amber-500/[0.1] border-amber-500/[0.2]"
                      : "text-slate-400 bg-white/[0.05] border-white/[0.1]";
                    return (
                      <li key={i} className="flex items-start gap-2 text-sm text-slate-300 leading-relaxed">
                        <span className="mt-0.5 shrink-0 text-xs font-black text-red-400">▼</span>
                        <span className="flex-1">{text}</span>
                        {score != null && (
                          <span className={`shrink-0 text-xs font-black px-1.5 py-0.5 rounded border ${scoreColor}`}>
                            {score}/10
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            <Card>
              <SectionTitle>Upcoming Catalysts</SectionTitle>
              <Bullet items={a.catalysts} positive={true} />
            </Card>
          </div>

          {/* Sector Comparison */}
          {a.sector_comparison?.competing_holdings?.length > 0 && (
            <Card className="border-amber-500/[0.12]">
              <div className="flex items-center gap-3 mb-3">
                <SectionTitle>Same-Sector Holdings</SectionTitle>
                {(() => {
                  const verdictCfg = {
                    ADD:           { label: "Add Alongside",   cls: "text-emerald-400 bg-emerald-500/[0.1] border-emerald-500/[0.2]" },
                    SWITCH:        { label: "Consider Switch", cls: "text-orange-400 bg-orange-500/[0.1] border-orange-500/[0.2]" },
                    HOLD_EXISTING: { label: "Hold Existing",   cls: "text-red-400 bg-red-500/[0.1] border-red-500/[0.2]" },
                    COMPLEMENT:    { label: "Complements",     cls: "text-blue-400 bg-blue-500/[0.1] border-blue-500/[0.2]" },
                  }[a.sector_comparison.verdict] ?? { label: a.sector_comparison.verdict, cls: "text-slate-400 bg-white/[0.05] border-white/[0.1]" };
                  return (
                    <span className={`text-xs font-black px-2 py-0.5 rounded-lg border ${verdictCfg.cls}`}>
                      {verdictCfg.label}
                    </span>
                  );
                })()}
              </div>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {a.sector_comparison.competing_holdings.map(t => (
                  <span key={t} className="text-xs font-mono font-bold text-slate-200 bg-white/[0.06] border border-white/[0.1] px-2 py-0.5 rounded">
                    {t}
                  </span>
                ))}
                <span className="text-xs text-slate-500 self-center ml-1">already in portfolio</span>
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">{a.sector_comparison.assessment}</p>
            </Card>
          )}

          {/* Action Plan */}
          {a.action_plan && (
            <Card className="border-blue-500/[0.15] bg-blue-950/20">
              <SectionTitle>Action Plan</SectionTitle>
              <p className="text-sm text-slate-200 leading-relaxed">{a.action_plan}</p>
            </Card>
          )}

          {/* Analyze another */}
          <div className="flex justify-center pb-4">
            <button
              type="button"
              onClick={() => { setResult(null); setTicker(""); inputRef.current?.focus(); }}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
            >
              ← Analyze another asset
            </button>
          </div>
        </div>
      )}

      {/* Confirm modal */}
      {confirm && (
        <ConfirmModal
          ticker={ticker.trim().toUpperCase()}
          assetType={assetType}
          isForceRefresh={pendingForce}
          onConfirm={() => { setConfirm(false); handleAnalyze(pendingForce); }}
          onCancel={() => setConfirm(false)}
        />
      )}

      {/* Empty state */}
      {!loading && !result && !error && (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <img src={puppySvg} alt="Empty" className="w-24 h-24 opacity-40" />
          <div className="text-slate-500 text-sm">Enter a ticker above to get started</div>
          <div className="text-xs text-slate-600 max-w-xs">
            Stocks &amp; options supported today. Futures, crypto, bullion and bonds coming soon.
          </div>
        </div>
      )}
    </div>
  );
}
