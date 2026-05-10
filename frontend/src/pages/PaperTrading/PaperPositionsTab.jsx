import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../../api/client.js";
import ClosePositionModal from "./ClosePositionModal.jsx";
import AssignModal        from "./AssignModal.jsx";
import RollModal          from "./RollModal.jsx";

const OPTION_STRATEGIES = new Set(["SELL_PUT", "BUY_PUT", "SELL_CALL", "BUY_CALL"]);

function fmt$(n, opts = {}) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2, ...opts })}`;
}
function pnlColor(n) { return n == null ? "text-slate-500" : n >= 0 ? "text-emerald-400" : "text-red-400"; }
function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  catch { return iso; }
}
function calcDTE(expiry) {
  if (!expiry) return null;
  const ms = new Date(expiry + "T21:00:00Z") - Date.now();
  return Math.max(Math.ceil(ms / 86400000), 0);
}
function estimatePnl(order, markPrice) {
  if (markPrice == null || order.fillPrice == null) return null;
  const qty    = order.quantity || 1;
  const mult   = OPTION_STRATEGIES.has(order.strategy) ? 100 : 1;
  const isSell = (order.strategy || "").startsWith("SELL");
  return Math.round(((isSell ? order.fillPrice - markPrice : markPrice - order.fillPrice) * qty * mult) * 100) / 100;
}

function Th({ children, right }) {
  return (
    <th className={`px-3 py-2.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 whitespace-nowrap ${right ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}
function Td({ children, right, className = "" }) {
  return (
    <td className={`px-3 py-3 text-sm ${right ? "text-right" : ""} ${className}`}>
      {children}
    </td>
  );
}

export default function PaperPositionsTab({ orders, isLoading, isError, canWrite, onWriteCC }) {
  const qc = useQueryClient();
  const [closeModal,  setCloseModal]  = useState(null);
  const [assignModal, setAssignModal] = useState(null);
  const [rollModal,   setRollModal]   = useState(null);
  const [refreshing,  setRefreshing]  = useState({});
  const [liveSnaps,   setLiveSnaps]   = useState({});
  const [expandedRow, setExpandedRow] = useState(null);

  async function handleRefresh(order) {
    setRefreshing((r) => ({ ...r, [order.tradeId]: true }));
    try {
      const res = await api.get(`/paper-trade/snapshot/${order.tradeId}`);
      setLiveSnaps((s) => ({ ...s, [order.tradeId]: res.snapshot }));
    } catch (err) {
      console.error("Snapshot refresh failed", err.message);
    } finally {
      setRefreshing((r) => ({ ...r, [order.tradeId]: false }));
    }
  }

  if (isLoading) return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-8 text-center text-slate-500 text-sm">
      Loading positions…
    </div>
  );
  if (isError) return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-8 text-center text-red-400 text-sm">
      Failed to load positions.
    </div>
  );
  if (orders.length === 0) return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-10 text-center text-slate-500 text-sm">
      No open positions in the selected period.
    </div>
  );

  return (
    <>
      {closeModal && (
        <ClosePositionModal
          order={closeModal}
          onClose={() => setCloseModal(null)}
          onClosed={() => {
            setCloseModal(null);
            qc.invalidateQueries({ queryKey: queryKeys.paperTradeOrders() });
          }}
        />
      )}
      {assignModal && (
        <AssignModal
          order={assignModal}
          onClose={() => setAssignModal(null)}
          onAssigned={() => {
            setAssignModal(null);
            qc.invalidateQueries({ queryKey: queryKeys.paperTradeOrders() });
          }}
        />
      )}
      {rollModal && (
        <RollModal
          order={rollModal}
          onClose={() => setRollModal(null)}
          onRolled={() => {
            setRollModal(null);
            qc.invalidateQueries({ queryKey: queryKeys.paperTradeOrders() });
            qc.invalidateQueries({ queryKey: queryKeys.paperTradeStaged() });
          }}
        />
      )}

      <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-white/[0.06]">
                <Th>Ticker</Th>
                <Th>Strategy</Th>
                <Th right>Qty</Th>
                <Th right>Fill Price</Th>
                <Th right>BS Mark</Th>
                <Th right>Strike</Th>
                <Th right>Expiry</Th>
                <Th right>DTE</Th>
                <Th right>Unreal. P&L</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {orders.map((order) => {
                const live       = liveSnaps[order.tradeId];
                const snap       = live || order.lastSnapshot || order.fillSnapshot;
                const mark       = snap?.marketPrice;
                const greeks     = snap?.greeks;
                const isOption   = OPTION_STRATEGIES.has(order.strategy);
                const dte        = isOption ? calcDTE(order.expiry) : null;
                const isRefreshing = refreshing[order.tradeId];
                const unrealized   = estimatePnl(order, mark);
                const isExpanded   = expandedRow === order.tradeId;

                return (
                  <>
                    <tr
                      key={order.tradeId}
                      className="hover:bg-white/[0.02] transition-colors"
                    >
                      {/* Ticker */}
                      <Td>
                        <span className="font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
                          {order.ticker}
                        </span>
                      </Td>

                      {/* Strategy */}
                      <Td>
                        <span className="text-xs text-slate-400">{order.strategy?.replace(/_/g, " ")}</span>
                      </Td>

                      {/* Qty */}
                      <Td right>
                        <span className="text-slate-200 font-semibold">{order.quantity}</span>
                      </Td>

                      {/* Fill Price */}
                      <Td right>
                        <span className="text-slate-200">{fmt$(order.fillPrice)}</span>
                      </Td>

                      {/* BS Mark */}
                      <Td right>
                        {mark != null ? (
                          <span className={live ? "text-blue-300 font-semibold" : "text-slate-400"}>
                            {fmt$(mark)}
                            <span className={`block text-[9px] font-normal ${live ? "text-blue-500/70" : "text-slate-600"}`}>
                              {live ? "live" : "stale"}
                            </span>
                          </span>
                        ) : "—"}
                      </Td>

                      {/* Strike */}
                      <Td right>
                        <span className="text-slate-300">
                          {isOption ? fmt$(order.strike, { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : "—"}
                        </span>
                      </Td>

                      {/* Expiry */}
                      <Td right>
                        <span className="text-slate-300">{isOption ? fmtDate(order.expiry) : "—"}</span>
                      </Td>

                      {/* DTE */}
                      <Td right>
                        {dte != null ? (
                          <span className={dte <= 7 ? "text-red-400 font-bold" : "text-slate-300"}>
                            {dte}d
                          </span>
                        ) : "—"}
                      </Td>

                      {/* Unrealized P&L */}
                      <Td right>
                        {unrealized != null ? (
                          <span className={`font-bold ${pnlColor(unrealized)}`} style={{ fontFamily: "Epilogue, sans-serif" }}>
                            {unrealized >= 0 ? "+" : "−"}{fmt$(Math.abs(unrealized))}
                          </span>
                        ) : "—"}
                      </Td>

                      {/* Actions */}
                      <Td>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {greeks && (
                            <button type="button"
                              onClick={() => setExpandedRow(isExpanded ? null : order.tradeId)}
                              className="px-2 py-1.5 rounded-lg border border-white/10 bg-white/[0.04] text-[10px] font-semibold text-slate-400 hover:text-slate-200 hover:bg-white/[0.07] transition-all cursor-pointer"
                              title="Toggle Greeks"
                            >
                              Δ
                            </button>
                          )}
                          <button type="button"
                            onClick={() => handleRefresh(order)}
                            disabled={isRefreshing}
                            className="px-2 py-1.5 rounded-lg border border-white/10 bg-white/[0.04] text-[10px] font-semibold text-slate-400 hover:text-blue-400 hover:border-blue-500/30 hover:bg-blue-500/[0.06] transition-all cursor-pointer disabled:opacity-40"
                            title="Refresh BS price"
                          >
                            {isRefreshing ? "…" : "↻"}
                          </button>
                          {canWrite && isOption && (
                            <>
                              <button type="button"
                                onClick={() => setAssignModal(order)}
                                className="px-2.5 py-1.5 rounded-lg border border-purple-500/30 bg-purple-500/[0.07] text-[10px] font-bold text-purple-400 hover:bg-purple-500/[0.14] transition-all cursor-pointer whitespace-nowrap"
                                title="Record assignment / exercise"
                              >
                                Assign
                              </button>
                              <button type="button"
                                onClick={() => setRollModal(order)}
                                className="px-2.5 py-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/[0.07] text-[10px] font-bold text-cyan-400 hover:bg-cyan-500/[0.14] transition-all cursor-pointer whitespace-nowrap"
                                title="Roll to new strike / expiry"
                              >
                                Roll
                              </button>
                            </>
                          )}
                          {canWrite && order.strategy === "BUY_STOCK" && onWriteCC && (
                            <button type="button"
                              onClick={() => onWriteCC(order)}
                              className="px-2.5 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.07] text-[10px] font-bold text-emerald-400 hover:bg-emerald-500/[0.14] transition-all cursor-pointer whitespace-nowrap"
                              title="Write a Covered Call against this stock position"
                            >
                              Write CC
                            </button>
                          )}
                          {canWrite && (
                            <button type="button"
                              onClick={() => setCloseModal(order)}
                              className="px-2.5 py-1.5 rounded-lg border border-red-500/30 bg-red-500/[0.07] text-[10px] font-bold text-red-400 hover:bg-red-500/[0.14] transition-all cursor-pointer whitespace-nowrap"
                            >
                              Close
                            </button>
                          )}
                        </div>
                      </Td>
                    </tr>

                    {/* Greeks sub-row */}
                    {isExpanded && greeks && (
                      <tr key={`${order.tradeId}-greeks`} className="bg-blue-500/[0.03]">
                        <td colSpan={10} className="px-6 py-2.5">
                          <div className="flex items-center gap-6 text-xs">
                            <span className="text-slate-500 uppercase tracking-wide text-[10px] font-bold">Greeks</span>
                            {[["Δ Delta", greeks.delta], ["Γ Gamma", greeks.gamma], ["Θ Theta", greeks.theta], ["ν Vega", greeks.vega]].map(([label, val]) => (
                              <span key={label} className="text-slate-400">
                                {label}: <span className="font-mono text-slate-200">{val ?? "—"}</span>
                              </span>
                            ))}
                            {live && <span className="text-blue-400/70 text-[10px]">· live snapshot</span>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
