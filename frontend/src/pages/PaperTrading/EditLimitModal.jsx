import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../api/client.js";

function fmt$(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function EditLimitModal({ tradeId, currentLimit, onClose, onSaved }) {
  const [limitPrice, setLimitPrice] = useState(currentLimit != null ? String(currentLimit) : "");

  const mutation = useMutation({
    mutationFn: () => api.patch(`/paper-trade/staged/${tradeId}`, { limitPrice: Number(limitPrice) }),
    onSuccess: onSaved,
  });

  const rawVal  = Number(limitPrice);
  const canSave = !mutation.isPending && rawVal > 0 && !isNaN(rawVal);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0F1729] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <div>
            <h2 className="text-sm font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
              Edit Limit Price
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">Current: {fmt$(currentLimit)}</p>
          </div>
          <button type="button" onClick={onClose}
            className="text-slate-600 hover:text-slate-300 text-xl leading-none cursor-pointer">
            ✕
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="text-[10px] font-bold uppercase tracking-wide text-slate-600 block mb-1.5">
              New Limit Price
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
              <input
                type="number"
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                placeholder="0.00"
                step="0.01"
                min="0.01"
                autoFocus
                className="w-full rounded-xl bg-white/[0.05] border border-white/10 text-slate-200 text-sm pl-7 pr-4 py-2.5 outline-none focus:border-blue-500/50 placeholder-slate-600"
              />
            </div>
          </div>

          {mutation.isError && (
            <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-xs text-red-400">
              {mutation.error?.detail?.error || mutation.error?.message || "Update failed"}
            </div>
          )}
        </div>

        <div className="flex gap-3 px-5 pb-5">
          <button type="button" onClick={onClose} disabled={mutation.isPending}
            className="flex-1 py-2.5 rounded-xl border border-white/10 bg-white/[0.04] text-xs font-semibold text-slate-400 hover:text-slate-200 transition-all cursor-pointer disabled:opacity-40">
            Cancel
          </button>
          <button type="button" onClick={() => mutation.mutate()} disabled={!canSave}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-all cursor-pointer disabled:opacity-40">
            {mutation.isPending ? "Saving…" : "Update Limit"}
          </button>
        </div>
      </div>
    </div>
  );
}
