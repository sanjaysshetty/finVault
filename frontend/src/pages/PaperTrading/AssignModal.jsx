import { useState } from "react";
import { api } from "../../api/client.js";

function fmt$(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function calcPnl(order) {
  if (order.fillPrice == null) return null;
  const qty    = order.quantity || 1;
  const isSell = order.strategy.startsWith("SELL");
  return isSell ? order.fillPrice * qty * 100 : -order.fillPrice * qty * 100;
}

// What stock position is created after assignment
function stockResult(order) {
  const shares = (order.quantity || 1) * 100;
  if (order.strategy === "SELL_PUT")  return { direction: "BUY",  label: "You receive",  shares, note: `Long ${shares} shares at strike — eligible to write Covered Calls` };
  if (order.strategy === "BUY_CALL")  return { direction: "BUY",  label: "You receive",  shares, note: `Long ${shares} shares at strike` };
  if (order.strategy === "SELL_CALL") return { direction: "SELL", label: "Shares called away", shares, note: `${shares} shares delivered at strike — close matching stock position manually if needed` };
  if (order.strategy === "BUY_PUT")   return { direction: "SELL", label: "You deliver",  shares, note: `${shares} shares delivered at strike` };
  return null;
}

function assignLabel(strategy) {
  if (strategy === "SELL_PUT")  return "Put Assigned — buy shares at strike";
  if (strategy === "SELL_CALL") return "Call Assigned — deliver shares at strike";
  if (strategy === "BUY_CALL")  return "Call Exercised — buy shares at strike";
  if (strategy === "BUY_PUT")   return "Put Exercised — deliver shares at strike";
  return "Assignment / Exercise";
}

export default function AssignModal({ order, onClose, onAssigned }) {
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState("");

  const estimatedPnl = calcPnl(order);
  const stock        = stockResult(order);

  async function handleConfirm() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/paper-trade/close/${order.tradeId}`, {
        orderType:   "LMT",
        closePrice:  0,
        closeAction: "ASSIGN",
        notes:       `Assigned at strike $${order.strike}`,
      });
      onAssigned();
    } catch (err) {
      setError(err.detail?.error || err.message || "Assignment failed");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-2xl border border-white/[0.1] bg-[#0F1729] shadow-2xl p-5 space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
              Record Assignment — {order.ticker}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">{assignLabel(order.strategy)}</p>
          </div>
          <button type="button" onClick={onClose}
            className="text-slate-500 hover:text-slate-300 p-1 rounded-lg hover:bg-white/[0.05] cursor-pointer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Option position summary */}
        <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3 grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-slate-500 uppercase tracking-wide text-[10px]">Strategy</p>
            <p className="text-slate-200 font-semibold mt-0.5">{order.strategy?.replace(/_/g, " ")}</p>
          </div>
          <div>
            <p className="text-slate-500 uppercase tracking-wide text-[10px]">Contracts</p>
            <p className="text-slate-200 font-semibold mt-0.5">{order.quantity}</p>
          </div>
          <div>
            <p className="text-slate-500 uppercase tracking-wide text-[10px]">Strike</p>
            <p className="text-slate-200 font-semibold mt-0.5">{fmt$(order.strike)}</p>
          </div>
          <div>
            <p className="text-slate-500 uppercase tracking-wide text-[10px]">Fill Premium</p>
            <p className="text-slate-200 font-semibold mt-0.5">{fmt$(order.fillPrice)}</p>
          </div>
        </div>

        {/* Resulting stock position */}
        {stock && (
          <div className={`rounded-xl border px-4 py-3 space-y-1.5 ${
            stock.direction === "BUY"
              ? "bg-emerald-500/[0.06] border-emerald-500/[0.2]"
              : "bg-amber-500/[0.06] border-amber-500/[0.2]"
          }`}>
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Resulting Stock Position</p>
            <p className="text-sm font-bold text-slate-200">
              <span className={stock.direction === "BUY" ? "text-emerald-400" : "text-amber-400"}>
                {stock.label}
              </span>
              {" "}{stock.shares.toLocaleString()} shares of {order.ticker} @ {fmt$(order.strike)}
            </p>
            <p className="text-[11px] text-slate-500">{stock.note}</p>
            <p className="text-[10px] text-slate-600 pt-0.5">
              This stock position will be auto-created in Paper Trades and appear in the Positions tab.
            </p>
          </div>
        )}

        {/* Option P&L */}
        <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3">
          <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">Option P&L (closes at $0)</p>
          <p className={`text-xl font-black ${estimatedPnl != null && estimatedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}
            style={{ fontFamily: "Epilogue, sans-serif" }}>
            {estimatedPnl != null
              ? `${estimatedPnl >= 0 ? "+" : "−"}$${Math.abs(estimatedPnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : "—"}
          </p>
        </div>

        {error && (
          <p className="text-xs text-red-400 rounded-lg bg-red-500/[0.08] border border-red-500/20 px-3 py-2">{error}</p>
        )}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose}
            className="flex-1 rounded-xl border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-slate-400 hover:bg-white/[0.07] hover:text-slate-200 transition-all cursor-pointer">
            Cancel
          </button>
          <button type="button" onClick={handleConfirm} disabled={busy}
            className="flex-1 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-purple-500 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
            {busy ? "Recording…" : "Record Assignment"}
          </button>
        </div>
      </div>
    </div>
  );
}
