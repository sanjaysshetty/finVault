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
