import { useState } from "react";

const STATUS_COLORS = {
  CLOSED:    "bg-slate-500/[0.12]  text-slate-300  border-slate-500/[0.2]",
  EXPIRED:   "bg-orange-500/[0.12] text-orange-400 border-orange-500/[0.2]",
  CANCELLED: "bg-slate-500/[0.08]  text-slate-500  border-slate-500/[0.15]",
};

const OPTION_STRATEGIES = new Set(["SELL_PUT", "BUY_PUT", "SELL_CALL", "BUY_CALL"]);

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
function pnlColor(n) { return n == null ? "text-slate-500" : n >= 0 ? "text-emerald-400" : "text-red-400"; }
function fmtDateTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}

function pnlStr(n) {
  if (n == null) return "—";
  return `${n >= 0 ? "+" : "−"}${fmt$(Math.abs(n))}`;
}

export default function PaperOrderHistory({ orders, isLoading, isError }) {
  const [expanded, setExpanded] = useState({});

  if (isLoading) return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-8 text-center text-slate-500 text-sm">
      Loading history…
    </div>
  );
  if (isError) return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-8 text-center text-red-400 text-sm">
      Failed to load history.
    </div>
  );
  if (orders.length === 0) return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-10 text-center text-slate-500 text-sm">
      No closed orders in the selected period.
    </div>
  );

  const totalRealized = orders
    .filter((o) => o.status === "CLOSED")
    .reduce((s, o) => s + (o.realizedPnl || 0), 0);

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729]">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
        <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Order History</span>
        <span className="inline-flex px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/[0.15] text-amber-400 border border-amber-500/20">
          PAPER
        </span>
        <span className="text-xs text-slate-600 ml-auto">
          {orders.length} order{orders.length !== 1 ? "s" : ""}
        </span>
        {orders.some((o) => o.status === "CLOSED") && (
          <span className={`text-sm font-black ml-2 ${pnlColor(totalRealized)}`} style={{ fontFamily: "Epilogue, sans-serif" }}>
            {pnlStr(totalRealized)}
          </span>
        )}
      </div>

      {/* Column headers */}
      <div
        className="hidden sm:grid px-4 py-2 border-b border-white/[0.04]"
        style={{ gridTemplateColumns: "80px 90px 96px 76px 76px 84px 84px 1fr" }}
      >
        {["Ticker", "Date", "Strategy", "Fill $", "Close $", "P&L", "Status", ""].map((h, i) => (
          <span key={i} className="text-[10px] font-bold uppercase tracking-wide text-slate-600">{h}</span>
        ))}
      </div>

      <div className="divide-y divide-white/[0.04] overflow-y-auto max-h-[60vh]">
        {orders.map((order) => {
          const isExp    = expanded[order.tradeId];
          const isOption = OPTION_STRATEGIES.has(order.strategy);
          const date     = order.closedAt || order.expiredAt || order.cancelledAt || order.updatedAt;
          const closeDisplay = order.status === "CLOSED"
            ? fmt$(order.closePrice)
            : order.status === "EXPIRED"
              ? (order.expiredResult || "—")
              : "—";

          return (
            <div key={order.tradeId}>
              {/* Row */}
              <div
                className="grid items-center px-4 py-3 cursor-pointer hover:bg-white/[0.02] gap-x-2 gap-y-1
                  [grid-template-columns:1fr_1fr]
                  sm:[grid-template-columns:80px_90px_96px_76px_76px_84px_84px_1fr]"
                onClick={() => setExpanded((e) => ({ ...e, [order.tradeId]: !e[order.tradeId] }))}
              >
                <span className="text-sm font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
                  {order.ticker}
                </span>
                <span className="text-xs text-slate-400">{fmtDateTime(date)}</span>
                <span className="hidden sm:block text-xs text-slate-400">{order.strategy?.replace(/_/g, " ")}</span>
                <span className="hidden sm:block text-xs text-slate-300">{fmt$(order.fillPrice)}</span>
                <span className={`hidden sm:block text-xs ${order.status === "EXPIRED" ? "text-orange-400 font-semibold" : "text-slate-300"}`}>
                  {closeDisplay}
                </span>
                <span className={`hidden sm:block text-xs font-bold ${pnlColor(order.realizedPnl)}`}>
                  {pnlStr(order.realizedPnl)}
                </span>
                <div className="hidden sm:flex">
                  <StatusBadge status={order.status} />
                </div>
                <div className="flex items-center justify-end">
                  <span className="text-slate-600 text-sm">{isExp ? "▲" : "▼"}</span>
                </div>
              </div>

              {/* Expanded detail */}
              {isExp && (
                <div className="px-4 pb-4 bg-white/[0.01] space-y-2">
                  {/* Mobile row */}
                  <div className="sm:hidden flex items-center gap-3 text-xs">
                    <StatusBadge status={order.status} />
                    <span className="text-slate-400">{order.strategy?.replace(/_/g, " ")}</span>
                    {order.realizedPnl != null && (
                      <span className={`font-bold ml-auto ${pnlColor(order.realizedPnl)}`}>
                        P&L: {pnlStr(order.realizedPnl)}
                      </span>
                    )}
                  </div>

                  {/* EXPIRED detail */}
                  {order.status === "EXPIRED" && (
                    <div className={`rounded-xl px-3 py-2.5 border text-xs ${
                      order.expiredResult === "ASSIGNED"
                        ? "bg-red-500/[0.08] border-red-500/20 text-red-400"
                        : "bg-slate-500/[0.08] border-slate-500/20 text-slate-400"
                    }`}>
                      Expired <span className="font-bold">{order.expiredResult || "UNKNOWN"}</span>
                      {order.stockPriceAtExpiry != null && (
                        <span className="ml-2">· stock at expiry: {fmt$(order.stockPriceAtExpiry)}</span>
                      )}
                      {order.expiry && <span className="ml-2">· option expiry: {order.expiry}</span>}
                    </div>
                  )}

                  {/* CLOSED detail */}
                  {order.status === "CLOSED" && (
                    <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-3 py-2.5 grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <div>
                        <p className="text-[10px] text-slate-600 uppercase tracking-wide">Close Type</p>
                        <p className="text-xs font-semibold text-slate-300">{order.closeOrderType || "—"}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-600 uppercase tracking-wide">Close Price</p>
                        <p className="text-xs font-semibold text-slate-300">{fmt$(order.closePrice)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-600 uppercase tracking-wide">Realized P&L</p>
                        <p className={`text-xs font-bold ${pnlColor(order.realizedPnl)}`}>
                          {pnlStr(order.realizedPnl)}
                        </p>
                      </div>
                      {order.closedAt && (
                        <div>
                          <p className="text-[10px] text-slate-600 uppercase tracking-wide">Closed At</p>
                          <p className="text-xs text-slate-400">{fmtDateTime(order.closedAt)}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Metadata */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] text-slate-600">
                    <span>ID: <span className="font-mono text-slate-500">{order.tradeId}</span></span>
                    {isOption && order.strike && (
                      <span>Strike: <span className="text-slate-500">{fmt$(order.strike, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span></span>
                    )}
                    {isOption && order.expiry && (
                      <span>Expiry: <span className="text-slate-500">{order.expiry}</span></span>
                    )}
                    {order.filledAt && (
                      <span>Filled: <span className="text-slate-500">{fmtDateTime(order.filledAt)}</span></span>
                    )}
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
