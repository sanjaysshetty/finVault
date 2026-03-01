import puppySvg from "../../assets/puppy.svg";

/**
 * EmptyState — puppy mascot + message for loading, empty, and error states.
 *
 * Props:
 *   type    {"loading"|"empty"|"error"}
 *   message {string?}  override default message
 *   onRetry {fn?}      if provided, shows a Retry button (used for error type)
 */

const DEFAULTS = {
  loading: "Loading your data…",
  empty:   "Nothing here yet. Add your first entry!",
  error:   "Something went wrong fetching your data.",
};

export function EmptyState({ type = "empty", message, onRetry }) {
  const text = message ?? DEFAULTS[type];

  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
      <img
        src={puppySvg}
        alt="finVault puppy"
        className={[
          "w-24 h-24 select-none",
          type === "loading" ? "animate-bounce" : "",
        ].join(" ")}
        draggable={false}
      />
      <p className="text-slate-400 text-sm max-w-xs leading-relaxed">{text}</p>
      {type === "error" && onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 px-4 py-2 text-sm font-bold rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30 hover:bg-blue-500/25 transition-colors"
        >
          Try again
        </button>
      )}
    </div>
  );
}
