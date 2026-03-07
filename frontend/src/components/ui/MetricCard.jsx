import { useState } from "react";

/**
 * MetricCard — dark card with a large Epilogue number + label.
 *
 * Props:
 *   label      {string}   e.g. "Total Value"
 *   value      {string}   pre-formatted value, e.g. "$42,130.00"
 *   pct        {string?}  optional % shown inline next to value, e.g. "+1.23%"
 *   valueClass {string?}  Tailwind class for value color, e.g. "text-green-400"
 *   accent     {boolean?} adds a colored left border when true
 *   className  {string?}  extra wrapper classes
 */
export function MetricCard({ label, value, pct = null, valueClass = "text-slate-200", accent = false, className = "" }) {
  // Strip leading minus — colour already communicates sign (red = negative)
  const displayValue = String(value ?? "—").replace(/^-/, "");

  return (
    <div
      className={[
        "rounded-2xl p-4 flex flex-col gap-1 min-w-0 overflow-hidden",
        "bg-[#0F1729] border border-[rgba(59,130,246,0.15)]",
        accent ? "border-l-2 border-l-blue-500" : "",
        className,
      ].join(" ")}
    >
      <span className="text-xs font-bold uppercase tracking-widest text-slate-500 truncate">
        {label}
      </span>
      {/* Single flex row — no wrap. Font size on the container scales both
          value and pct together so they always fit on one line. */}
      <div
        className={`flex items-baseline gap-x-1.5 min-w-0 overflow-hidden ${valueClass}`}
        style={{ fontFamily: "Epilogue, sans-serif", fontSize: "clamp(1rem, 3.6vw, 1.44rem)" }}
      >
        <span className="font-black leading-tight">{displayValue}</span>
        {pct != null && (
          <span className="font-medium whitespace-nowrap" style={{ fontSize: "0.65em" }}>
            ({pct})
          </span>
        )}
      </div>
    </div>
  );
}

/* ── helpers local to this file ─────────────────────────── */
function _fmt(n) { return (Math.abs(Number(n) || 0)).toLocaleString(undefined, { style: "currency", currency: "USD" }); }
function _plCls(v) { return (Number(v) || 0) >= 0 ? "text-green-400" : "text-red-400"; }

/**
 * RealizedGainCard — same visual footprint as MetricCard but collapsible.
 * When expanded shows short-term and long-term sub-metrics.
 *
 * Props:
 *   total      {number}  YTD total realized gain/loss
 *   shortTerm  {number}  portion held ≤ 1 yr
 *   longTerm   {number}  portion held > 1 yr
 *   year       {string}  e.g. "2026"
 *   className  {string?} extra wrapper classes
 */
export function RealizedGainCard({ total = 0, shortTerm = 0, longTerm = 0, year = "", className = "" }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={[
        "rounded-2xl p-4 flex flex-col gap-1 min-w-0 overflow-hidden",
        "bg-[#0F1729] border border-[rgba(59,130,246,0.15)]",
        className,
      ].join(" ")}
    >
      {/* Label row with toggle */}
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs font-bold uppercase tracking-widest text-slate-500 truncate">
          YTD Realized P/L
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-shrink-0 text-slate-500 hover:text-slate-300 transition-colors"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          <span className="text-[11px] font-bold select-none">{expanded ? "▴" : "▾"}</span>
        </button>
      </div>

      {/* Total value */}
      <div
        className={`flex items-baseline gap-x-1.5 min-w-0 overflow-hidden ${_plCls(total)}`}
        style={{ fontFamily: "Epilogue, sans-serif", fontSize: "clamp(1rem, 3.6vw, 1.44rem)" }}
      >
        <span className="font-black leading-tight">{_fmt(total)}</span>
      </div>

      <span className="text-[10px] text-slate-600">Closed positions · YTD</span>

      {/* Expanded breakdown */}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-white/[0.06] grid grid-cols-2 gap-x-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-600 mb-0.5">Short-term</p>
            <p
              className={`font-black leading-tight ${_plCls(shortTerm)}`}
              style={{ fontFamily: "Epilogue, sans-serif", fontSize: "clamp(0.85rem, 2.5vw, 1.05rem)" }}
            >
              {_fmt(shortTerm)}
            </p>
            <p className="text-[10px] text-slate-600 mt-0.5">≤ 1 yr hold</p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-600 mb-0.5">Long-term</p>
            <p
              className={`font-black leading-tight ${_plCls(longTerm)}`}
              style={{ fontFamily: "Epilogue, sans-serif", fontSize: "clamp(0.85rem, 2.5vw, 1.05rem)" }}
            >
              {_fmt(longTerm)}
            </p>
            <p className="text-[10px] text-slate-600 mt-0.5">&gt; 1 yr hold</p>
          </div>
        </div>
      )}
    </div>
  );
}
