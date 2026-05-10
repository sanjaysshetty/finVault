import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api/client.js";

const OPTION_STRATEGIES = new Set(["SELL_PUT", "BUY_PUT", "SELL_CALL", "BUY_CALL"]);

function fmt$(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function calcEstimatedPnl(order, closePrice) {
  if (!closePrice || isNaN(closePrice) || closePrice <= 0) return null;
  const qty    = order.quantity || 1;
  const mult   = OPTION_STRATEGIES.has(order.strategy) ? 100 : 1;
  const isSell = (order.strategy || "").startsWith("SELL");
  const fill   = order.fillPrice || 0;
  return Math.round(((isSell ? fill - closePrice : closePrice - fill) * qty * mult) * 100) / 100;
}

export default function ClosePositionModal({ order, onClose, onClosed }) {
  const [orderType,  setOrderType]  = useState("MKT");
  const [closePrice, setClosePrice] = useState("");

  const mutation = useMutation({
    mutationFn: () => api.post(`/paper-trade/close/${order.tradeId}`, {
      orderType,
      ...(orderType === "LMT" ? { closePrice: Number(closePrice) } : {}),
    }),
    onSuccess: onClosed,
  });

  const rawClose    = Number(closePrice);
  const pnlEstimate = orderType === "LMT" ? calcEstimatedPnl(order, rawClose) : null;
  const canSubmit   = !mutation.isPending && (orderType === "MKT" || (rawClose > 0 && !isNaN(rawClose)));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0F1729] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
              Close Position — {order.ticker}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {order.strategy?.replace(/_/g, " ")} · Filled at {fmt$(order.fillPrice)} · Qty {order.quantity}
            </p>
          </div>
          <button type="button" onClick={onClose}
            className="text-slate-600 hover:text-slate-300 text-xl leading-none cursor-pointer">
            ✕
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Close method toggle */}
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wide text-slate-600 block mb-2">
              Close Method
            </label>
            <div className="flex gap-2">
              {[
                ["MKT", "Market", "Current BS price (live)"],
                ["LMT", "Custom", "Enter a specific price"],
              ].map(([type, label, sub]) => (
                <button key={type} type="button" onClick={() => setOrderType(type)}
                  className={[
                    "flex-1 py-2.5 rounded-xl text-xs font-bold border transition-all cursor-pointer text-left px-3",
                    orderType === type
                      ? "bg-blue-600/30 border-blue-500/50 text-blue-300"
                      : "bg-white/[0.03] border-white/[0.08] text-slate-500 hover:text-slate-300",
                  ].join(" ")}
                >
                  <span className="block">{label} ({type})</span>
                  <span className="block text-[10px] font-normal opacity-60 mt-0.5">{sub}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Custom price input */}
          {orderType === "LMT" && (
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wide text-slate-600 block mb-1.5">
                Close Price per Contract
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
                <input
                  type="number"
                  value={closePrice}
                  onChange={(e) => setClosePrice(e.target.value)}
                  placeholder="0.00"
                  step="0.01"
                  min="0.01"
                  autoFocus
                  className="w-full rounded-xl bg-white/[0.05] border border-white/10 text-slate-200 text-sm pl-7 pr-4 py-2.5 outline-none focus:border-blue-500/50 placeholder-slate-600"
                />
              </div>
            </div>
          )}

          {/* Estimated P&L for LMT */}
          {pnlEstimate != null && (
            <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3">
              <p className="text-[10px] text-slate-600 uppercase tracking-wide mb-1">Estimated Realized P&L</p>
              <p className={`text-lg font-black ${pnlEstimate >= 0 ? "text-emerald-400" : "text-red-400"}`}
                 style={{ fontFamily: "Epilogue, sans-serif" }}>
                {pnlEstimate >= 0 ? "+" : "−"}{fmt$(Math.abs(pnlEstimate))}
              </p>
            </div>
          )}

          {/* MKT info callout */}
          {orderType === "MKT" && (
            <div className="rounded-xl bg-blue-500/[0.07] border border-blue-500/20 px-4 py-3 text-xs text-blue-400">
              Position will close at the current Black-Scholes theoretical price fetched live from Finnhub.
            </div>
          )}

          {/* Error */}
          {mutation.isError && (
            <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-xs text-red-400">
              {mutation.error?.detail?.error || mutation.error?.message || "Failed to close position"}
            </div>
          )}
        </div>

        {/* Buttons */}
        <div className="flex gap-3 px-5 pb-5">
          <button type="button" onClick={onClose} disabled={mutation.isPending}
            className="flex-1 py-2.5 rounded-xl border border-white/10 bg-white/[0.04] text-xs font-semibold text-slate-400 hover:text-slate-200 transition-all cursor-pointer disabled:opacity-40">
            Cancel
          </button>
          <button type="button" onClick={() => mutation.mutate()} disabled={!canSubmit}
            className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-all cursor-pointer disabled:opacity-40">
            {mutation.isPending ? "Closing…" : "Close Position"}
          </button>
        </div>
      </div>
    </div>
  );
}
