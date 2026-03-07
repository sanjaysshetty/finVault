import { useState, useRef, useEffect } from "react";

/**
 * AccountSwitcher — compact dropdown in the TopBar that lets the user switch
 * between accounts they are a member of.
 *
 * Renders nothing when the user has only one account (no point switching).
 */
export default function AccountSwitcher({ accounts, activeAccount, onSwitch }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close when clicking outside the dropdown.
  useEffect(() => {
    function onMouseDown(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  if (!accounts || accounts.length <= 1) return null;

  const displayName = activeAccount?.accountName || "My Account";

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={[
          "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm",
          "border border-white/[0.08] bg-white/[0.03]",
          "hover:bg-white/[0.07] hover:border-white/[0.14]",
          "text-slate-300 hover:text-white transition-all cursor-pointer",
          "max-w-[160px]",
        ].join(" ")}
      >
        <span className="truncate">{displayName}</span>
        <span className="text-slate-500 shrink-0 text-xs">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div
          className={[
            "absolute right-0 top-full mt-1 z-50",
            "w-56 py-1 rounded-xl",
            "bg-[#0F1729] border border-white/[0.08]",
            "shadow-[0_8px_32px_rgba(0,0,0,0.6)]",
          ].join(" ")}
        >
          {accounts.map((acct) => {
            const isActive = acct.accountId === activeAccount?.accountId;
            return (
              <button
                key={acct.accountId}
                type="button"
                onClick={() => {
                  onSwitch(acct.accountId);
                  setOpen(false);
                }}
                className={[
                  "w-full flex items-center justify-between px-4 py-2.5 text-sm",
                  "transition-colors cursor-pointer text-left",
                  isActive
                    ? "text-blue-300 bg-blue-500/[0.08]"
                    : "text-slate-400 hover:text-slate-100 hover:bg-white/[0.04]",
                ].join(" ")}
              >
                <span className="truncate">{acct.accountName}</span>
                <span
                  className={[
                    "shrink-0 ml-2 text-xs px-1.5 py-0.5 rounded font-medium",
                    acct.role === "owner"
                      ? "bg-blue-500/[0.15] text-blue-400"
                      : "bg-slate-700/[0.5] text-slate-500",
                  ].join(" ")}
                >
                  {acct.role}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
