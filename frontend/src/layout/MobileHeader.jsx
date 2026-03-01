import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { logout } from "../auth/logout";
import { getLoggedInUser } from "../auth/user";

export default function MobileHeader({ onMenuClick }) {
  const navigate = useNavigate();
  const logoSrc = `${import.meta.env.BASE_URL}favicon.svg`;
  const user = useMemo(() => getLoggedInUser(), []);
  const displayName = user?.firstName?.trim()
    ? user.firstName
    : user?.email || user?.username || "User";

  return (
    <header
      className={[
        "flex md:hidden items-center justify-between",
        "h-14 px-4 shrink-0",
        "bg-[#080D1A] border-b border-white/[0.06]",
        "shadow-[0_1px_0_rgba(255,255,255,0.04),0_4px_16px_rgba(0,0,0,0.4)]",
      ].join(" ")}
    >
      {/* Logo + wordmark */}
      <div
        className="flex items-center gap-2.5 select-none cursor-pointer shrink-0"
        onClick={() => navigate("/spending/receipts-ledger")}
      >
        <img
          src={logoSrc}
          alt="finVault"
          draggable={false}
          className="w-7 h-7 object-contain shrink-0"
        />
        <span
          className="text-xl font-black tracking-tight text-slate-50"
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

        {/* Logout */}
        <button
          onClick={logout}
          className={[
            "text-xs font-bold text-slate-400 px-2.5 py-1 rounded-lg",
            "border border-white/[0.08] bg-white/[0.03]",
            "hover:bg-white/[0.07] hover:text-slate-200 hover:border-white/[0.14]",
            "transition-all cursor-pointer whitespace-nowrap",
          ].join(" ")}
        >
          Logout
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
