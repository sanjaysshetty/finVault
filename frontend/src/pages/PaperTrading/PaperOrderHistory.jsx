import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../../api/client.js";

const STATUS_COLORS = {
  SUBMITTED:  "bg-blue-500/[0.15]    text-blue-400    border-blue-500/[0.25]",
  FILLED:     "bg-emerald-500/[0.15] text-emerald-400 border-emerald-500/[0.25]",
  CANCELLED:  "bg-slate-500/[0.12]   text-slate-400   border-slate-500/[0.2]",
  REJECTED:   "bg-red-500/[0.15]     text-red-400     border-red-500/[0.25]",
  SUBMITTING: "bg-amber-500/[0.15]   text-amber-400   border-amber-500/[0.25]",
};

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold border ${STATUS_COLORS[status] || STATUS_COLORS.CANCELLED}`}>
      {status}
    </span>
  );
}

function fmt$(n, opts = {}) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2, ...opts })}`;
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

/**
 * PaperOrderHistory — shows SUBMITTED, FILLED, CANCELLED, REJECTED orders.
 *
 * Each SUBMITTED row has a "Refresh Status" button that hits
 * POST /paper-trade/status/{id} → polls IBKR for fill updates.
 * The full IBKR response is shown in an expandable audit row.
 */
export default function PaperOrderHistory() {
  const queryClient   = useQueryClient();
  const [expanded,    setExpanded]    = useState({});    // tradeId → bool
  const [polling,     setPolling]     = useState({});    // tradeId → bool
  const [pollResults, setPollResults] = useState({});    // tradeId → { status, fillPrice, error }

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.paperTradeOrders(),
    queryFn:  () => api.get("/paper-trade/orders"),
    staleTime: 30_000,
  });

  const orders = data?.orders || [];

  async function handlePollStatus(tradeId) {
    setPolling((p) => ({ ...p, [tradeId]: true }));
    setPollResults((r) => { const n = { ...r }; delete n[tradeId]; return n; });
    try {
      const res = await api.post(`/paper-trade/status/${tradeId}`);
      setPollResults((r) => ({ ...r, [tradeId]: { status: res.status, fillPrice: res.fillPrice, ibkrStatus: res.ibkrStatus } }));
      queryClient.invalidateQueries({ queryKey: queryKeys.paperTradeOrders() });
    } catch (err) {
      const msg = err.detail?.error || err.message || "Status poll failed";
      setPollResults((r) => ({ ...r, [tradeId]: { error: msg } }));
    } finally {
      setPolling((p) => ({ ...p, [tradeId]: false }));
    }
  }

  if (isLoading) return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-8 text-center text-slate-500 text-sm">
      Loading order history…
    </div>
  );
  if (isError) return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-8 text-center text-red-400 text-sm">
      Failed to load order history.
    </div>
  );

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729]">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Order History</span>
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/[0.15] text-amber-400 border border-amber-500/[0.2]">
          PAPER
        </span>
        {orders.length > 0 && (
          <span className="text-xs text-slate-600 ml-auto">{orders.length} order{orders.length !== 1 ? "s" : ""}</span>
        )}
      </div>

      {orders.length === 0 && (
        <div className="px-4 py-10 text-center text-slate-500 text-sm">
          No submitted orders yet. Stage and confirm an order to see it here.
        </div>
      )}

      {/* Column headers */}
      {orders.length > 0 && (
        <div className="hidden sm:grid px-4 py-2 border-b border-white/[0.04] [grid-template-columns:64px_80px_60px_70px_80px_72px_80px_minmax(0,1fr)_100px]">
          {["Ticker", "Date", "Strategy", "Strike", "Expiry", "Fill $", "Status", "IBKR Order ID", ""].map((h, i) => (
            <span key={i} className="text-[10px] font-bold uppercase tracking-wide text-slate-600">{h}</span>
          ))}
        </div>
      )}

      <div className="divide-y divide-white/[0.04] overflow-y-auto max-h-[50vh]">
        {orders.map((order) => {
          const isExpanded  = expanded[order.tradeId];
          const pollResult  = pollResults[order.tradeId];
          const isPolling   = polling[order.tradeId];

          return (
            <div key={order.tradeId}>
              {/* Main row */}
              <div
                className="grid items-center px-4 py-3 cursor-pointer hover:bg-white/[0.02] gap-2
                  [grid-template-columns:1fr_1fr]
                  sm:[grid-template-columns:64px_80px_60px_70px_80px_72px_80px_minmax(0,1fr)_100px]"
                onClick={() => setExpanded((e) => ({ ...e, [order.tradeId]: !e[order.tradeId] }))}
              >
                <span className="text-sm font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
                  {order.ticker}
                </span>
                <span className="text-xs text-slate-400">{fmtDateTime(order.submittedAt || order.createdAt)}</span>
                <span className="hidden sm:block text-xs text-slate-400">{order.strategy?.replace("_", " ")}</span>
                <span className="hidden sm:block text-xs text-slate-300">{fmt$(order.strike, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
                <span className="hidden sm:block text-xs text-slate-400">{order.expiry || "—"}</span>
                <span className="hidden sm:block text-xs font-semibold text-emerald-400">
                  {order.fillPrice != null ? fmt$(order.fillPrice) : "—"}
                </span>
                <div className="hidden sm:block">
                  <StatusBadge status={order.status} />
                </div>
                <span className="hidden sm:block text-[10px] text-slate-600 font-mono truncate">
                  {order.ibkrOrderId || "—"}
                </span>
                <div className="flex items-center justify-end gap-2">
                  {order.status === "SUBMITTED" && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handlePollStatus(order.tradeId); }}
                      disabled={isPolling}
                      className="px-2 py-1 rounded-lg border border-blue-500/30 bg-blue-500/[0.07] text-[10px] font-semibold text-blue-400 hover:bg-blue-500/[0.12] transition-all cursor-pointer disabled:opacity-40 whitespace-nowrap"
                    >
                      {isPolling ? "Polling…" : "↻ Refresh"}
                    </button>
                  )}
                  <span className="text-slate-600 text-sm">{isExpanded ? "▲" : "▼"}</span>
                </div>
              </div>

              {/* Expanded audit trail */}
              {isExpanded && (
                <div className="px-4 pb-4 space-y-2 bg-white/[0.01]">
                  {/* Poll result feedback */}
                  {pollResult && !pollResult.error && (
                    <div className="rounded-lg bg-emerald-500/[0.08] border border-emerald-500/[0.2] px-3 py-2 text-xs text-emerald-400">
                      IBKR status: <span className="font-semibold">{pollResult.status}</span>
                      {pollResult.fillPrice != null && ` · Fill price: ${fmt$(pollResult.fillPrice)}`}
                      {pollResult.ibkrStatus && ` · Raw: ${pollResult.ibkrStatus}`}
                    </div>
                  )}
                  {pollResult?.error && (
                    <div className="rounded-lg bg-red-500/[0.08] border border-red-500/[0.2] px-3 py-2 text-xs text-red-400">
                      {pollResult.error}
                    </div>
                  )}

                  {/* IBKR audit log */}
                  {order.ibkrAuditLog?.length > 0 && (
                    <div className="rounded-xl border border-white/[0.06] bg-[#080D1A] px-3 py-2.5 space-y-2">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-600">IBKR Audit Log</p>
                      {order.ibkrAuditLog.map((entry, i) => (
                        <div key={i} className="space-y-1">
                          <div className="flex items-center gap-2 text-[10px]">
                            <span className={entry.success ? "text-emerald-500" : "text-red-400"}>
                              {entry.success ? "✓" : "✗"}
                            </span>
                            <span className="font-mono font-semibold text-slate-400">{entry.step}</span>
                            <span className="text-slate-600">{entry.method}</span>
                            {entry.httpStatus && (
                              <span className={entry.success ? "text-slate-600" : "text-red-400"}>
                                HTTP {entry.httpStatus}
                              </span>
                            )}
                            <span className="text-slate-700">{entry.durationMs}ms</span>
                            <span className="text-slate-700 truncate">{entry.ts?.slice(11, 19)}</span>
                          </div>
                          {entry.error && (
                            <p className="text-[10px] text-red-400/80 pl-4 font-mono">
                              {entry.error.message}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Order metadata */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] text-slate-600">
                    <span>Trade ID: <span className="font-mono text-slate-500">{order.tradeId}</span></span>
                    {order.ibkrConId  && <span>Con ID: <span className="font-mono text-slate-500">{order.ibkrConId}</span></span>}
                    {order.scanId     && <span>Scan: <span className="text-slate-500">{order.scanId}</span></span>}
                    {order.submittedAt && <span>Submitted: <span className="text-slate-500">{fmtDateTime(order.submittedAt)}</span></span>}
                    {order.filledAt   && <span>Filled: <span className="text-slate-500">{fmtDateTime(order.filledAt)}</span></span>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
