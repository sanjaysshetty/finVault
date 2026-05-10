import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys }       from "../../api/client.js";
import { PageHeader }           from "../../components/ui/PageHeader.jsx";
import { PageIcons }            from "../../components/ui/PageIcons.jsx";
import { useCanWrite }          from "../../hooks/useCanWrite.js";
import PaperProceedQueue        from "./PaperProceedQueue.jsx";
import PaperStagedOrders        from "./PaperStagedOrders.jsx";
import PaperPositionsTab        from "./PaperPositionsTab.jsx";
import PaperOrderHistory        from "./PaperOrderHistory.jsx";
import PaperStageOrderModal     from "./PaperStageOrderModal.jsx";

const TABS    = ["Orders", "Positions", "History"];
const PERIODS = ["1M", "3M", "6M", "1Y", "Custom"];

function periodStart(p, from) {
  const now = new Date();
  if (p === "1M") return new Date(now.getFullYear(), now.getMonth() - 1,  now.getDate());
  if (p === "3M") return new Date(now.getFullYear(), now.getMonth() - 3,  now.getDate());
  if (p === "6M") return new Date(now.getFullYear(), now.getMonth() - 6,  now.getDate());
  if (p === "1Y") return new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  if (p === "Custom" && from) return new Date(from);
  return null;
}

function fmt$(n) {
  if (n == null) return "—";
  return `$${Math.abs(Number(n)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pnlColor(n) { return n >= 0 ? "text-emerald-400" : "text-red-400"; }

function historyDate(order) {
  return order.closedAt || order.expiredAt || order.cancelledAt || order.updatedAt;
}

const OPTION_STRATEGIES = new Set(["SELL_PUT", "BUY_PUT", "SELL_CALL", "BUY_CALL"]);

function estimateUnrealizedPnl(order) {
  const snap = order.lastSnapshot || order.fillSnapshot;
  const mark = snap?.marketPrice;
  if (mark == null || order.fillPrice == null) return 0;
  const qty    = order.quantity || 1;
  const mult   = OPTION_STRATEGIES.has(order.strategy) ? 100 : 1;
  const isSell = (order.strategy || "").startsWith("SELL");
  return (isSell ? order.fillPrice - mark : mark - order.fillPrice) * qty * mult;
}

export default function PaperTradingDesk() {
  const canWrite = useCanWrite("paperTrading");
  const qc       = useQueryClient();

  const [tab,        setTab]        = useState("Orders");
  const [period,     setPeriod]     = useState("3M");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo,   setCustomTo]   = useState("");
  const [modalRec,   setModalRec]   = useState(null);

  const stageMutation = useMutation({
    mutationFn: (order) => api.post("/paper-trade/staged", order),
    onSuccess:  () => {
      setModalRec(null);
      qc.invalidateQueries({ queryKey: queryKeys.paperTradeStaged() });
    },
  });

  const { data: ordersData, isLoading, isError } = useQuery({
    queryKey: queryKeys.paperTradeOrders(),
    queryFn:  () => api.get("/paper-trade/orders"),
    staleTime: 30_000,
  });

  const allOrders = useMemo(() => ordersData?.orders || [], [ordersData]);

  const pStart = useMemo(() => periodStart(period, customFrom), [period, customFrom]);
  const pEnd   = useMemo(() => {
    if (period === "Custom" && customTo) return new Date(customTo + "T23:59:59Z");
    return null;
  }, [period, customTo]);

  function filterByDate(orders, getDate) {
    return orders.filter((o) => {
      const d = getDate(o) ? new Date(getDate(o)) : null;
      if (!d) return true;
      if (pStart && d < pStart) return false;
      if (pEnd   && d > pEnd)   return false;
      return true;
    });
  }

  const submittedOrders = useMemo(
    () => allOrders.filter((o) => o.status === "SUBMITTED"),
    [allOrders]
  );
  const filledOrders = useMemo(
    () => filterByDate(allOrders.filter((o) => o.status === "FILLED"), (o) => o.filledAt),
    [allOrders, pStart, pEnd]  // eslint-disable-line
  );
  const closedOrders = useMemo(
    () => filterByDate(
      allOrders.filter((o) => ["CLOSED", "EXPIRED", "CANCELLED"].includes(o.status)),
      historyDate
    ),
    [allOrders, pStart, pEnd]  // eslint-disable-line
  );

  // Metrics are always all-time — independent of the period filter
  const unrealizedPnl = useMemo(
    () => allOrders
      .filter((o) => o.status === "FILLED")
      .reduce((s, o) => s + estimateUnrealizedPnl(o), 0),
    [allOrders]
  );
  const realizedPnl = useMemo(
    () => allOrders
      .filter((o) => o.status === "CLOSED")
      .reduce((s, o) => s + (o.realizedPnl || 0), 0),
    [allOrders]
  );
  const closedCount = useMemo(
    () => allOrders.filter((o) => o.status === "CLOSED").length,
    [allOrders]
  );

  return (
    <div className="flex flex-col gap-5 p-6 max-w-6xl mx-auto">
      {modalRec && (
        <PaperStageOrderModal
          rec={modalRec}
          onConfirm={(o) => stageMutation.mutate(o)}
          onCancel={() => { setModalRec(null); stageMutation.reset(); }}
          isPending={stageMutation.isPending}
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="Paper Trading Desk"
          subtitle="Internal Black-Scholes engine · Finnhub data · No broker required"
          icon={PageIcons.paperTrading}
        />
        <div className="flex items-center gap-1.5 shrink-0 pt-1 px-3 py-1.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.08]">
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-xs font-bold text-amber-400 uppercase tracking-wide">Paper Mode</span>
        </div>
      </div>

      {stageMutation.isError && (
        <div className="rounded-xl bg-red-500/[0.12] border border-red-500/20 px-4 py-3 text-sm text-red-400">
          Failed to stage order: {stageMutation.error?.detail?.error || stageMutation.error?.message}
        </div>
      )}

      {/* P&L summary strip — always visible across all tabs */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-white/[0.06] bg-[#0F1729] px-4 py-3">
          <p className="text-[10px] text-slate-600 uppercase tracking-wide mb-1">Unrealized P&L</p>
          <p className={`text-xl font-black ${pnlColor(unrealizedPnl)}`} style={{ fontFamily: "Epilogue, sans-serif" }}>
            {unrealizedPnl >= 0 ? "+" : "−"}{fmt$(unrealizedPnl)}
          </p>
          <p className="text-[10px] text-slate-600 mt-0.5">
            {allOrders.filter((o) => o.status === "FILLED").length} open position{allOrders.filter((o) => o.status === "FILLED").length !== 1 ? "s" : ""} · est.
          </p>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-[#0F1729] px-4 py-3">
          <p className="text-[10px] text-slate-600 uppercase tracking-wide mb-1">Realized P&L</p>
          <p className={`text-xl font-black ${pnlColor(realizedPnl)}`} style={{ fontFamily: "Epilogue, sans-serif" }}>
            {realizedPnl >= 0 ? "+" : "−"}{fmt$(realizedPnl)}
          </p>
          <p className="text-[10px] text-slate-600 mt-0.5">{closedCount} closed · all time</p>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-[#0F1729] px-4 py-3">
          <p className="text-[10px] text-slate-600 uppercase tracking-wide mb-1">Closed Positions</p>
          <p className="text-xl font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
            {closedCount}
          </p>
          <p className="text-[10px] text-slate-600 mt-0.5">all time</p>
        </div>
      </div>

      {/* Tabs + period filter */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div
          className="flex gap-1 rounded-xl border p-1"
          style={{ background: "var(--fv-chip-bg)", borderColor: "var(--fv-border)" }}
        >
          {TABS.map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className="relative px-4 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer"
              style={tab === t
                ? { background: "#2563eb", color: "#ffffff" }
                : { color: "var(--fv-text-secondary)" }
              }
            >
              {t}
              {t === "Orders" && submittedOrders.length > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center rounded-full bg-amber-500 text-[9px] font-black text-black">
                  {submittedOrders.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab !== "Orders" && (
          <div className="flex items-center gap-2 flex-wrap">
            <div
              className="flex gap-0.5 rounded-xl border p-1"
              style={{ background: "var(--fv-chip-bg)", borderColor: "var(--fv-border)" }}
            >
              {PERIODS.map((p) => (
                <button key={p} type="button" onClick={() => setPeriod(p)}
                  className="px-3 py-1 rounded-lg text-[11px] font-bold transition-all cursor-pointer"
                  style={period === p
                    ? { background: "#334155", color: "#f1f5f9" }
                    : { color: "var(--fv-text-secondary)" }
                  }
                >
                  {p}
                </button>
              ))}
            </div>
            {period === "Custom" && (
              <div className="flex items-center gap-1.5">
                <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                  className="rounded-lg bg-white/[0.04] border border-white/10 text-slate-300 text-[11px] px-2 py-1 outline-none focus:border-blue-500/50" />
                <span className="text-slate-600 text-xs">→</span>
                <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                  className="rounded-lg bg-white/[0.04] border border-white/10 text-slate-300 text-[11px] px-2 py-1 outline-none focus:border-blue-500/50" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tab content */}
      {tab === "Orders" && (
        <div className="flex flex-col gap-5">
          {canWrite
            ? <PaperProceedQueue onStage={(rec) => { stageMutation.reset(); setModalRec(rec); }} />
            : <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-8 text-center text-slate-500 text-sm">Read-only access.</div>
          }
          <PaperStagedOrders
            canWrite={canWrite}
            submittedOrders={submittedOrders}
            ordersLoading={isLoading}
          />
        </div>
      )}

      {tab === "Positions" && (
        <PaperPositionsTab
          orders={filledOrders}
          isLoading={isLoading}
          isError={isError}
          canWrite={canWrite}
          onWriteCC={(stockOrder) => {
            stageMutation.reset();
            setModalRec({
              ticker:           stockOrder.ticker,
              name:             stockOrder.ticker,
              _lockedStrategy:  "SELL_CALL",
              _maxContracts:    Math.floor((stockOrder.quantity || 100) / 100),
              _fromPosition:    stockOrder.tradeId,
            });
          }}
        />
      )}

      {tab === "History" && (
        <PaperOrderHistory
          orders={closedOrders}
          isLoading={isLoading}
          isError={isError}
        />
      )}
    </div>
  );
}
