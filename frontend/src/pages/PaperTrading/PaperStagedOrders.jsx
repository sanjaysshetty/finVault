import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../../api/client.js";
import EditLimitModal     from "./EditLimitModal.jsx";

const OPTION_STRATEGIES = new Set(["SELL_PUT", "BUY_PUT", "SELL_CALL", "BUY_CALL"]);

function fmt$(n, opts = {}) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2, ...opts })}`;
}
function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  catch { return iso; }
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}

function SectionHeader({ label, count, color = "amber" }) {
  const cls = color === "blue"
    ? "bg-blue-500/[0.15] text-blue-400 border-blue-500/[0.2]"
    : "bg-amber-500/[0.15] text-amber-400 border-amber-500/[0.2]";
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.06]">
      <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</span>
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-bold border ${cls}`}>
        {count}
      </span>
    </div>
  );
}

export default function PaperStagedOrders({ canWrite, submittedOrders = [], ordersLoading }) {
  const qc = useQueryClient();
  const [submitting,     setSubmitting]     = useState({});
  const [submitErrors,   setSubmitErrors]   = useState({});
  const [lastSubmitResult, setLastSubmitResult] = useState(null); // { ticker, status, fillPrice?, marketPrice? }
  const [checking,       setChecking]       = useState({});
  const [checkResults,   setCheckResults]   = useState({});
  const [editModal,      setEditModal]      = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.paperTradeStaged(),
    queryFn:  () => api.get("/paper-trade/staged"),
    refetchInterval: 10_000,
  });

  const stagedOrders = data?.orders || [];

  const discardMutation = useMutation({
    mutationFn: (tradeId) => api.delete(`/paper-trade/staged/${tradeId}`),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: queryKeys.paperTradeStaged() });
      qc.invalidateQueries({ queryKey: queryKeys.paperTradeOrders() });
    },
  });

  async function handleSubmit(tradeId, ticker) {
    setSubmitting((s) => ({ ...s, [tradeId]: true }));
    setSubmitErrors((e) => { const n = { ...e }; delete n[tradeId]; return n; });
    setLastSubmitResult(null);
    try {
      const res = await api.post(`/paper-trade/submit/${tradeId}`);
      setLastSubmitResult({ ticker, status: res.status, fillPrice: res.fillPrice, marketPrice: res.marketPrice });
      qc.invalidateQueries({ queryKey: queryKeys.paperTradeStaged() });
      qc.invalidateQueries({ queryKey: queryKeys.paperTradeOrders() });
    } catch (err) {
      const msg = err.detail?.error || err.message || "Submit failed";
      setSubmitErrors((e) => ({ ...e, [tradeId]: msg }));
    } finally {
      setSubmitting((s) => ({ ...s, [tradeId]: false }));
    }
  }

  async function handleCheckFill(tradeId) {
    setChecking((c) => ({ ...c, [tradeId]: true }));
    setCheckResults((r) => { const n = { ...r }; delete n[tradeId]; return n; });
    try {
      const res = await api.post(`/paper-trade/status/${tradeId}`);
      setCheckResults((r) => ({ ...r, [tradeId]: res }));
      qc.invalidateQueries({ queryKey: queryKeys.paperTradeOrders() });
    } catch (err) {
      setCheckResults((r) => ({ ...r, [tradeId]: { error: err.detail?.error || err.message } }));
    } finally {
      setChecking((c) => ({ ...c, [tradeId]: false }));
    }
  }

  const loading = isLoading || ordersLoading;
  if (loading && stagedOrders.length === 0 && submittedOrders.length === 0) return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-8 text-center text-slate-500 text-sm">
      Loading orders…
    </div>
  );
  if (stagedOrders.length === 0 && submittedOrders.length === 0) return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-8 text-center">
      <p className="text-sm text-slate-500">
        No staged or pending orders. Stage an order from a{" "}
        <span className="text-amber-400 font-semibold">PROCEED</span> recommendation above.
      </p>
    </div>
  );

  return (
    <>
      {lastSubmitResult && (
        <div className={`rounded-xl px-4 py-3 text-sm border flex items-start justify-between gap-3 ${
          lastSubmitResult.status === "FILLED"
            ? "bg-emerald-500/[0.10] border-emerald-500/20 text-emerald-300"
            : "bg-blue-500/[0.10] border-blue-500/20 text-blue-300"
        }`}>
          <span>
            {lastSubmitResult.status === "FILLED"
              ? <>
                  <span className="font-bold">{lastSubmitResult.ticker}</span>
                  {" "}filled immediately at{" "}
                  <span className="font-bold">{fmt$(lastSubmitResult.fillPrice)}</span>
                  {" "}— check the <span className="font-semibold">Positions</span> tab.
                </>
              : <>
                  <span className="font-bold">{lastSubmitResult.ticker}</span>
                  {" "}submitted — parked as pending. BS mark:{" "}
                  <span className="font-bold">{fmt$(lastSubmitResult.marketPrice)}</span>
                  {" "}· limit not yet reached. Use <span className="font-semibold">↻ Check Fill</span> below to poll.
                </>
            }
          </span>
          <button type="button" onClick={() => setLastSubmitResult(null)}
            className="text-slate-500 hover:text-slate-300 shrink-0 cursor-pointer">✕</button>
        </div>
      )}

      {editModal && (
        <EditLimitModal
          tradeId={editModal.tradeId}
          currentLimit={editModal.limitPrice}
          onClose={() => setEditModal(null)}
          onSaved={() => {
            setEditModal(null);
            qc.invalidateQueries({ queryKey: queryKeys.paperTradeStaged() });
            qc.invalidateQueries({ queryKey: queryKeys.paperTradeOrders() });
          }}
        />
      )}

      {/* STAGED */}
      {stagedOrders.length > 0 && (
        <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729]">
          <SectionHeader label="Staged — awaiting submission" count={stagedOrders.length} color="amber" />
          <div className="divide-y divide-white/[0.04]">
            {stagedOrders.map((order) => {
              const isSubmitting  = submitting[order.tradeId]   || false;
              const submitError   = submitErrors[order.tradeId]  || null;
              const isOption = OPTION_STRATEGIES.has(order.strategy);
              const collateral = isOption ? (order.strike || 0) * 100 * (order.quantity || 1) : null;
              return (
                <div key={order.tradeId} className="px-4 py-4 space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
                      {order.ticker}
                    </span>
                    <span className="inline-flex px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/[0.15] text-amber-400 border border-amber-500/25">
                      PAPER
                    </span>
                    <span className="text-xs text-slate-500">{order.strategy?.replace(/_/g, " ")}</span>
                    {order.orderType === "LMT" && order.limitPrice != null && (
                      <span className="text-xs text-slate-500">@ Limit {fmt$(order.limitPrice)}</span>
                    )}
                    {order.orderType === "MKT" && (
                      <span className="text-xs text-slate-500">MKT order</span>
                    )}
                    <span className="text-[10px] text-slate-600 font-mono ml-auto">{order.tradeId}</span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-xl bg-white/[0.03] border border-white/[0.05] px-4 py-3">
                    {isOption && (
                      <>
                        <div>
                          <p className="text-[10px] text-slate-600 uppercase tracking-wide">Strike</p>
                          <p className="text-sm font-bold text-slate-200">{fmt$(order.strike, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-slate-600 uppercase tracking-wide">Expiry</p>
                          <p className="text-sm font-bold text-slate-200">{fmtDate(order.expiry)}</p>
                        </div>
                      </>
                    )}
                    <div>
                      <p className="text-[10px] text-slate-600 uppercase tracking-wide">Quantity</p>
                      <p className="text-sm font-bold text-slate-200">{order.quantity}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-600 uppercase tracking-wide">
                        {order.orderType === "MKT" ? "Order Type" : "Limit Price"}
                      </p>
                      <p className="text-sm font-bold text-slate-200">
                        {order.limitPrice != null ? fmt$(order.limitPrice) : order.orderType}
                      </p>
                    </div>
                    {collateral != null && (
                      <div>
                        <p className="text-[10px] text-slate-600 uppercase tracking-wide">Collateral</p>
                        <p className="text-sm font-bold text-slate-200">
                          {fmt$(collateral, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                        </p>
                      </div>
                    )}
                    {order.notes && (
                      <div className="col-span-2">
                        <p className="text-[10px] text-slate-600 uppercase tracking-wide">Notes</p>
                        <p className="text-xs text-slate-400">{order.notes}</p>
                      </div>
                    )}
                  </div>

                  {submitError && (
                    <div className="rounded-lg bg-red-500/[0.10] border border-red-500/20 px-3 py-2 text-xs text-red-400">
                      {submitError}
                    </div>
                  )}

                  {canWrite && (
                    <div className="flex gap-2">
                      <button type="button"
                        onClick={() => discardMutation.mutate(order.tradeId)}
                        disabled={discardMutation.isPending || isSubmitting}
                        className="px-3 py-2 rounded-lg border border-white/10 bg-white/[0.04] text-xs font-semibold text-slate-400 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/[0.06] transition-all cursor-pointer disabled:opacity-40"
                      >
                        Discard
                      </button>
                      {order.orderType === "LMT" && (
                        <button type="button"
                          onClick={() => setEditModal({ tradeId: order.tradeId, limitPrice: order.limitPrice })}
                          className="px-3 py-2 rounded-lg border border-white/10 bg-white/[0.04] text-xs font-semibold text-slate-400 hover:text-blue-400 hover:border-blue-500/30 hover:bg-blue-500/[0.06] transition-all cursor-pointer"
                        >
                          Edit Limit
                        </button>
                      )}
                      <button type="button"
                        onClick={() => handleSubmit(order.tradeId, order.ticker)}
                        disabled={isSubmitting}
                        className={[
                          "flex-1 px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer",
                          isSubmitting
                            ? "bg-emerald-700/50 text-emerald-300 cursor-not-allowed"
                            : "bg-emerald-600 hover:bg-emerald-500 text-white",
                        ].join(" ")}
                      >
                        {isSubmitting ? "Submitting…" : "✓ Submit Order"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* SUBMITTED */}
      {submittedOrders.length > 0 && (
        <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729]">
          <SectionHeader label="Submitted — pending fill" count={submittedOrders.length} color="blue" />
          <div className="divide-y divide-white/[0.04]">
            {submittedOrders.map((order) => {
              const snap = order.lastSnapshot || order.fillSnapshot;
              const isChecking = checking[order.tradeId];
              const checkRes   = checkResults[order.tradeId];
              return (
                <div key={order.tradeId} className="px-4 py-4 space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
                      {order.ticker}
                    </span>
                    <span className="inline-flex px-2 py-0.5 rounded-md text-[10px] font-bold bg-blue-500/[0.15] text-blue-400 border border-blue-500/25">
                      SUBMITTED
                    </span>
                    <span className="text-xs text-slate-500">{order.strategy?.replace(/_/g, " ")}</span>
                    <span className="text-[10px] text-slate-600 font-mono ml-auto">{order.tradeId}</span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-xl bg-white/[0.03] border border-white/[0.05] px-4 py-3">
                    <div>
                      <p className="text-[10px] text-slate-600 uppercase tracking-wide">Limit Price</p>
                      <p className="text-sm font-bold text-slate-200">{fmt$(order.limitPrice)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-600 uppercase tracking-wide">BS Mark</p>
                      <p className="text-sm font-bold text-blue-300">
                        {snap?.marketPrice != null ? fmt$(snap.marketPrice) : "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-600 uppercase tracking-wide">Qty</p>
                      <p className="text-sm font-bold text-slate-200">{order.quantity}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-600 uppercase tracking-wide">Submitted</p>
                      <p className="text-sm font-bold text-slate-200">{fmtDateTime(order.submittedAt)}</p>
                    </div>
                    {order.expiry && (
                      <div>
                        <p className="text-[10px] text-slate-600 uppercase tracking-wide">Expiry</p>
                        <p className="text-sm font-bold text-slate-200">{fmtDate(order.expiry)}</p>
                      </div>
                    )}
                    {snap?.greeks && (
                      <div className="col-span-2">
                        <p className="text-[10px] text-slate-600 uppercase tracking-wide">Greeks</p>
                        <p className="text-xs text-slate-400 font-mono">
                          Δ {snap.greeks.delta} · Γ {snap.greeks.gamma} · Θ {snap.greeks.theta} · ν {snap.greeks.vega}
                        </p>
                      </div>
                    )}
                  </div>

                  {checkRes && (
                    <div className={`rounded-xl px-3 py-2.5 text-xs border ${
                      checkRes.error
                        ? "bg-red-500/[0.08] border-red-500/20 text-red-400"
                        : "bg-emerald-500/[0.08] border-emerald-500/20 text-emerald-400"
                    }`}>
                      {checkRes.error || (
                        checkRes.filled === false
                          ? `Pending — BS mark: ${fmt$(checkRes.currentPrice)} · Limit: ${fmt$(checkRes.limitPrice)}`
                          : `Filled at ${fmt$(checkRes.fillPrice)}`
                      )}
                    </div>
                  )}

                  {canWrite && (
                    <div className="flex gap-2">
                      {order.orderType === "LMT" && (
                        <button type="button"
                          onClick={() => setEditModal({ tradeId: order.tradeId, limitPrice: order.limitPrice })}
                          className="px-3 py-2 rounded-lg border border-white/10 bg-white/[0.04] text-xs font-semibold text-slate-400 hover:text-blue-400 hover:border-blue-500/30 hover:bg-blue-500/[0.06] transition-all cursor-pointer"
                        >
                          Edit Limit
                        </button>
                      )}
                      <button type="button"
                        onClick={() => handleCheckFill(order.tradeId)}
                        disabled={isChecking}
                        className="flex-1 px-4 py-2 rounded-lg border border-blue-500/30 bg-blue-500/[0.07] text-xs font-semibold text-blue-400 hover:bg-blue-500/[0.12] transition-all cursor-pointer disabled:opacity-40"
                      >
                        {isChecking ? "Checking…" : "↻ Check Fill"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
