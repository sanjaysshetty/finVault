import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { logout } from "../auth/logout";
import { getLoggedInUser } from "../auth/user";

export default function MobileHeader({ onMenuClick, theme, onToggleTheme, isManual, onResetToAuto }) {
  const navigate = useNavigate();
  const logoSrc = `${import.meta.env.BASE_URL}favicon.svg`;
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
        "shadow-[0_1px_0_rgba(255,255,255,0.04),0_4px_16px_rgba(0,0,0,0.4)]",
      ].join(" ")}
    >
      {/* Logo + wordmark */}
      <div
        className="flex items-center gap-2.5 select-none cursor-pointer shrink-0"
        onClick={() => navigate("/assets/portfolio")}
      >
        <img
          src={logoSrc}
          alt="finVault"
          draggable={false}
          className="w-7 h-7 object-contain shrink-0"
        />
        <span
          className={[
            "text-xl font-black tracking-tight",
            import.meta.env.VITE_APP_ENV === "dev" ? "text-amber-400" : "text-slate-50",
          ].join(" ")}
          style={{ fontFamily: "Epilogue, sans-serif" }}
        >
          finVault
        </span>
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
