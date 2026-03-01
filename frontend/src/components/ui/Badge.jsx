/**
 * Badge — small colored pill for status/type labels.
 *
 * Props:
 *   children {ReactNode}  text content
 *   variant  {string}     "buy" | "sell" | "summary" | "gain" | "loss" |
 *                         "neutral" | "warning" | "info"
 *   className {string?}   extra classes
 */

const VARIANT_CLASSES = {
  buy:     "bg-green-400/15  text-green-400  border-green-400/30",
  sell:    "bg-red-400/15    text-red-400    border-red-400/30",
  summary: "bg-amber-400/15  text-amber-400  border-amber-400/30",
  gain:    "bg-green-400/15  text-green-400  border-green-400/30",
  loss:    "bg-red-400/15    text-red-400    border-red-400/30",
  neutral: "bg-slate-500/15  text-slate-400  border-slate-500/30",
  warning: "bg-amber-400/15  text-amber-400  border-amber-400/30",
  info:    "bg-cyan-400/15   text-cyan-400   border-cyan-400/30",
};

export function Badge({ children, variant = "neutral", className = "" }) {
  const cls = VARIANT_CLASSES[variant] ?? VARIANT_CLASSES.neutral;
  return (
    <span
      className={[
        "inline-flex items-center px-2 py-0.5",
        "text-xs font-bold rounded-full border",
        cls,
        className,
      ].join(" ")}
    >
      {children}
    </span>
  );
}
