import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../../api/client.js";

function fmt$(n, opts = {}) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2, ...opts })}`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  catch { return iso; }
}

/**
 * PaperStagedOrders — the human-in-the-loop confirmation step.
 *
 * Each staged order card shows the full order summary and three actions:
 *   Discard — removes from DynamoDB (no IBKR call)
 *   Edit     — not yet implemented (future: re-open modal with prefill)
 *   Confirm & Submit → triggers POST /paper-trade/submit/{id}
 *                      which resolves conId + places order on IBKR paper account.
 *
 * The submission flow surfaces IBKR audit steps on error so the user knows
 * exactly which step failed (e.g. secdef_search vs place_order).
 */
export default function PaperStagedOrders({ canWrite }) {
  const queryClient = useQueryClient();
  const [submitErrors, setSubmitErrors] = useState({});   // tradeId → error info
  const [submitting,   setSubmitting]   = useState({});   // tradeId → bool

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.paperTradeStaged(),
    queryFn:  () => api.get("/paper-trade/staged"),
    refetchInterval: 10_000,   // poll every 10s so newly staged orders appear
  });

  const orders = data?.orders || [];

  const discardMutation = useMutation({
    mutationFn: (tradeId) => api.delete(`/paper-trade/staged/${tradeId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.paperTradeStaged() });
      queryClient.invalidateQueries({ queryKey: queryKeys.paperTradeOrders() });
    },
  });

  async function handleSubmit(tradeId) {
    setSubmitting((s) => ({ ...s, [tradeId]: true }));
    setSubmitErrors((e) => { const n = { ...e }; delete n[tradeId]; return n; });
    try {
      await api.post(`/paper-trade/submit/${tradeId}`);
      queryClient.invalidateQueries({ queryKey: queryKeys.paperTradeStaged() });
      queryClient.invalidateQueries({ queryKey: queryKeys.paperTradeOrders() });
    } catch (err) {
      const detail = err.detail || {};
      setSubmitErrors((e) => ({
        ...e,
        [tradeId]: {
          message:    detail.error    || err.message || "Submission failed",
          ibkrStep:   detail.ibkrStep || null,
          auditSteps: detail.auditSteps || [],
        },
      }));
    } finally {
      setSubmitting((s) => ({ ...s, [tradeId]: false }));
    }
  }

  if (isLoading) return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-8 text-center text-slate-500 text-sm">
      Loading staged orders…
    </div>
  );

  if (orders.length === 0) return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-8 text-center">
      <p className="text-sm text-slate-500">No staged orders. Click <span className="text-amber-400 font-semibold">Stage Order</span> on a PROCEED recommendation above.</p>
    </div>
  );

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729]">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Staged Orders</span>
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/[0.15] text-amber-400 border border-amber-500/[0.2]">
          {orders.length} awaiting confirmation
        </span>
      </div>

      <div className="divide-y divide-white/[0.04]">
        {orders.map((order) => {
          const err        = submitErrors[order.tradeId];
          const isSubmitting = submitting[order.tradeId] || false;
          const collateral = order.strike * 100 * order.quantity;
          const netPremium = order.limitPrice != null ? order.limitPrice * 100 * order.quantity : null;

          return (
            <div key={order.tradeId} className="px-4 py-4 space-y-3">
              {/* Top row: ticker + badges + strategy */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-base font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
                  {order.ticker}
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/[0.15] text-amber-400 border border-amber-500/[0.25]">
                  PAPER
                </span>
                <span className="text-xs text-slate-500">{order.strategy?.replace("_", " ")}</span>
                <span className="text-xs text-slate-600 ml-auto font-mono">{order.tradeId}</span>
              </div>

              {/* Order details grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-xl bg-white/[0.03] border border-white/[0.05] px-4 py-3">
                <div>
                  <p className="text-[10px] text-slate-600 uppercase tracking-wide">Strike</p>
                  <p className="text-sm font-bold text-slate-200">{fmt$(order.strike, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-600 uppercase tracking-wide">Expiry</p>
                  <p className="text-sm font-bold text-slate-200">{fmtDate(order.expiry)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-600 uppercase tracking-wide">Qty / Type</p>
                  <p className="text-sm font-bold text-slate-200">
                    {order.quantity} × {order.orderType}
                    {order.orderType === "LMT" && order.limitPrice != null && ` @ ${fmt$(order.limitPrice)}`}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-600 uppercase tracking-wide">Collateral</p>
                  <p className="text-sm font-bold text-slate-200">{collateral > 0 ? fmt$(collateral, { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : "—"}</p>
                </div>
                {netPremium != null && (
                  <div>
                    <p className="text-[10px] text-slate-600 uppercase tracking-wide">Net Premium</p>
                    <p className="text-sm font-bold text-emerald-400">{fmt$(netPremium, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</p>
                  </div>
                )}
                {order.scanId && (
                  <div>
                    <p className="text-[10px] text-slate-600 uppercase tracking-wide">Source Scan</p>
                    <p className="text-xs text-slate-400">{order.scanId}</p>
                  </div>
                )}
                {order.notes && (
                  <div className="col-span-2">
                    <p className="text-[10px] text-slate-600 uppercase tracking-wide">Notes</p>
                    <p className="text-xs text-slate-400">{order.notes}</p>
                  </div>
                )}
              </div>

              {/* Last submit error — with IBKR audit step details */}
              {(err || order.lastSubmitError) && (
                <div className="rounded-xl bg-red-500/[0.08] border border-red-500/[0.2] px-4 py-3 space-y-1.5">
                  <p className="text-xs font-semibold text-red-400">
                    {err?.message || order.lastSubmitError?.message || "Previous submission failed"}
                  </p>
                  {(err?.ibkrStep || order.lastSubmitError?.ibkrStep) && (
                    <p className="text-[11px] text-red-400/70">
                      Failed at IBKR step: <span className="font-mono">{err?.ibkrStep || order.lastSubmitError?.ibkrStep}</span>
                    </p>
                  )}
                  {err?.auditSteps?.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {err.auditSteps.map((s, i) => (
                        <div key={i} className="flex items-center gap-2 text-[10px]">
                          <span className={s.success ? "text-emerald-500" : "text-red-400"}>
                            {s.success ? "✓" : "✗"}
                          </span>
                          <span className="font-mono text-slate-500">{s.step}</span>
                          {s.httpStatus && <span className="text-slate-600">HTTP {s.httpStatus}</span>}
                          <span className="text-slate-600">{s.durationMs}ms</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Action buttons */}
              {canWrite && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => discardMutation.mutate(order.tradeId)}
                    disabled={discardMutation.isPending || isSubmitting}
                    className="px-3 py-2 rounded-lg border border-white/[0.1] bg-white/[0.04] text-xs font-semibold text-slate-400 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/[0.06] transition-all cursor-pointer disabled:opacity-40"
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSubmit(order.tradeId)}
                    disabled={isSubmitting}
                    className={[
                      "flex-1 px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer",
                      isSubmitting
                        ? "bg-emerald-700/50 text-emerald-300 cursor-not-allowed"
                        : "bg-emerald-600 hover:bg-emerald-500 text-white",
                    ].join(" ")}
                  >
                    {isSubmitting ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                          <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                        </svg>
                        Submitting to IBKR…
                      </span>
                    ) : "✓ Confirm & Submit to IBKR"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
