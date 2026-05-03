import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { logout } from "../auth/logout";
import { getLoggedInUser } from "../auth/user";

export default function MobileHeader({ onMenuClick, theme, onToggleTheme, isManual, onResetToAuto }) {
  const navigate = useNavigate();
  const user = useMemo(() => getLoggedInUser(), []);
  const displayName = user?.firstName?.trim()
    ? user.firstName
    : user?.email || user?.username || "User";

  return (
    <header
      className={[
        "flex md:hidden items-center justify-between fv-mobile-header",
        "h-14 px-4 shrink-0",
        "bg-[#080D1A] border-b border-white/[0.06]",
      ].join(" ")}
    >
      {/* Logo + wordmark */}
      <div
        className="flex items-center gap-2.5 select-none cursor-pointer shrink-0"
        onClick={() => navigate("/assets/portfolio")}
      >
        <svg width="28" height="28" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <defs>
            <linearGradient id="fvmeridian-mh" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#0e6c4a" />
              <stop offset="100%" stopColor="#1a9e65" />
            </linearGradient>
          </defs>
          <rect x="1" y="1" width="38" height="38" rx="11" fill="url(#fvmeridian-mh)" />
          <path d="M9 24l11-13 11 13" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M9 31l11-8 11 8" stroke="#3DD68C" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.85" />
        </svg>
        {import.meta.env.VITE_APP_ENV === "dev" ? (
          <span className="text-xl font-black tracking-tight text-amber-400" style={{ fontFamily: "Manrope, sans-serif" }}>
            finVault
          </span>
        ) : (
          <span className="text-xl font-black tracking-tight" style={{ fontFamily: "Manrope, sans-serif", color: "var(--fv-text)", letterSpacing: "-0.4px" }}>
            fin<span style={{ color: "var(--fv-accent-solid, #1a9e65)" }}>Vault</span>
          </span>
        )}
      </div>

      {/* Right: welcome + logout + hamburger */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Welcome text */}
        <span className="text-xs text-slate-500 whitespace-nowrap">
          Welcome{" "}
          <strong className="text-slate-300 font-semibold max-w-[72px] inline-block truncate align-bottom">
            {displayName}
          </strong>
        </span>

        {/* Theme toggle */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className={[
              "flex items-center justify-center text-slate-400 w-9 h-9 rounded-lg",
              "border border-white/[0.08] bg-white/[0.03]",
              "hover:bg-white/[0.07] hover:text-slate-200",
              "transition-all cursor-pointer",
            ].join(" ")}
          >
            {theme === "dark" ? (
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          {isManual && (
            <button
              type="button"
              onClick={onResetToAuto}
              title="Return to automatic time-based theme"
              className="text-[10px] font-bold text-slate-500 hover:text-slate-300 cursor-pointer transition-colors px-1"
            >
              auto
            </button>
          )}
        </div>

        {/* Logout */}
        <button
          type="button"
          onClick={logout}
          aria-label="Logout"
          title="Logout"
          className={[
            "flex items-center justify-center text-slate-400 w-9 h-9 rounded-lg",
            "border border-white/[0.08] bg-white/[0.03]",
            "hover:bg-white/[0.07] hover:text-slate-200 hover:border-white/[0.14]",
            "transition-all cursor-pointer",
          ].join(" ")}
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3v9" />
            <path d="M7.05 5.05a9 9 0 1 0 9.9 0" />
          </svg>
        </button>

        {/* Hamburger */}
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Open navigation menu"
          className={[
            "flex flex-col justify-center items-center gap-[5px]",
            "w-10 h-10 rounded-lg shrink-0",
            "border border-white/[0.08] bg-white/[0.03]",
            "hover:bg-white/[0.07] hover:border-white/[0.14]",
            "transition-colors cursor-pointer",
          ].join(" ")}
        >
          <span className="block w-5 h-[2px] rounded-full bg-slate-300" />
          <span className="block w-5 h-[2px] rounded-full bg-slate-300" />
          <span className="block w-5 h-[2px] rounded-full bg-slate-300" />
        </button>
      </div>
    </header>
  );
}
