import { useNavigate } from "react-router-dom";
import { useMemo } from "react";
import PricesBar from "./PricesBar";
import { logout } from "../auth/logout";
import { getLoggedInUser } from "../auth/user";

export default function TopBar() {
  const navigate = useNavigate();
  const user = useMemo(() => getLoggedInUser(), []);
  const logoSrc = `${import.meta.env.BASE_URL}favicon.svg`;

  const goHome = () => navigate("/spending/receipts-ledger");

  return (
    <header
      className={[
        "hidden md:grid shrink-0",
        "h-16 px-4 gap-4",
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
          className="cursor-pointer text-xl font-black tracking-tight text-slate-50 whitespace-nowrap hover:text-white transition-colors"
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

      {/* RIGHT: welcome + logout */}
      <div className="flex items-center gap-3 shrink-0 whitespace-nowrap">
        <span className="text-sm text-slate-500">
          Welcome{" "}
          <strong className="text-slate-300 font-semibold">
            {user?.firstName?.trim()
              ? user.firstName
              : user?.email || user?.username || "User"}
          </strong>
        </span>

        <button
          onClick={logout}
          className={[
            "text-xs font-bold text-slate-400 px-3 py-1.5 rounded-lg",
            "border border-white/[0.08] bg-white/[0.03]",
            "hover:bg-white/[0.07] hover:text-slate-200 hover:border-white/[0.14]",
            "transition-all cursor-pointer",
          ].join(" ")}
        >
          Logout
        </button>
      </div>
    </header>
  );
}
