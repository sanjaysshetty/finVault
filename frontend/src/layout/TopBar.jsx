import { useNavigate } from "react-router-dom";
import { useMemo } from "react";
import PricesBar from "./PricesBar";
import { logout } from "../auth/logout";
import { getLoggedInUser } from "../auth/user";
import AccountSwitcher from "../components/AccountSwitcher";

export default function TopBar({ accounts, activeAccount, onSwitchAccount, theme, onToggleTheme, isManual, onResetToAuto }) {
  const navigate = useNavigate();
  const user = useMemo(() => getLoggedInUser(), []);
  const logoSrc = `${import.meta.env.BASE_URL}favicon.svg`;

  const goHome = () => navigate("/spending/receipts-ledger");

  return (
    <header
      className={[
        "hidden md:grid shrink-0 fv-topbar",
        "h-[54px] px-4 gap-4",
        "grid-cols-[auto_1fr_auto] items-center",
        "bg-[#080D1A] border-b border-white/[0.06]",
        "shadow-[0_1px_0_rgba(255,255,255,0.04),0_8px_32px_rgba(0,0,0,0.5)]",
      ].join(" ")}
    >
      {/* LEFT: logo + wordmark */}
      <div className="flex items-center gap-2.5 select-none shrink-0">
        <img
          src={logoSrc}
          alt="finVault"
          draggable={false}
          className="w-7 h-7 object-contain shrink-0"
        />
        <span
          onClick={goHome}
          className={[
            "cursor-pointer text-xl font-black tracking-tight whitespace-nowrap transition-colors",
            import.meta.env.VITE_APP_ENV === "dev"
              ? "text-amber-400 hover:text-amber-300"
              : "text-slate-50 hover:text-white",
          ].join(" ")}
          style={{ fontFamily: "Epilogue, sans-serif" }}
        >
          finVault
        </span>
      </div>

      {/* CENTER: scrollable prices strip */}
      <div
        className="min-w-0 flex items-center justify-center overflow-x-auto overflow-y-hidden"
        style={{ scrollbarWidth: "none" }}
      >
        <style>{`.topbar-prices::-webkit-scrollbar { display: none; }`}</style>
        <div className="topbar-prices flex items-center gap-2.5 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
          <PricesBar />
        </div>
      </div>

      {/* RIGHT: account switcher + welcome + logout */}
      <div className="flex items-center gap-3 shrink-0 whitespace-nowrap">
        <AccountSwitcher
          accounts={accounts}
          activeAccount={activeAccount}
          onSwitch={onSwitchAccount}
        />

        <span className="text-sm text-slate-500">
          Welcome{" "}
          <strong className="text-slate-300 font-semibold">
            {user?.firstName?.trim()
              ? user.firstName
              : user?.email || user?.username || "User"}
          </strong>
        </span>

        {/* Theme toggle */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
            className={[
              "flex items-center justify-center text-slate-400 w-9 h-9 rounded-lg",
              "border border-white/[0.08] bg-white/[0.03]",
              "hover:bg-white/[0.07] hover:text-slate-200 hover:border-white/[0.14]",
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
      </div>
    </header>
  );
}
