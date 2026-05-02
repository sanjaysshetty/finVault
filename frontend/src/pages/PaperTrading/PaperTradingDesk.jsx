import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../../api/client.js";
import { PageHeader }         from "../../components/ui/PageHeader.jsx";
import { PageIcons }          from "../../components/ui/PageIcons.jsx";
import { useCanWrite }        from "../../hooks/useCanWrite.js";
import PaperProceedQueue      from "./PaperProceedQueue.jsx";
import PaperStagedOrders      from "./PaperStagedOrders.jsx";
import PaperOrderHistory      from "./PaperOrderHistory.jsx";
import PaperStageOrderModal   from "./PaperStageOrderModal.jsx";

const IBKR_ACCOUNT_ID = import.meta.env.VITE_IBKR_PAPER_ACCOUNT_ID || "";

/**
 * PaperTradingDesk — main page for /research/paper-trading.
 *
 * Human-in-the-loop flow:
 *   1. PROCEED QUEUE   — pulls PROCEED recs from wheel scan; user clicks "Stage Order"
 *   2. STAGE MODAL     — user reviews/edits the pre-filled order, clicks "Stage for Review"
 *                        → POST /paper-trade/staged (DynamoDB only, no IBKR call yet)
 *   3. STAGED ORDERS   — user sees pending cards; clicks "Confirm & Submit to IBKR"
 *                        → POST /paper-trade/submit/{id} (resolves conId + places order)
 *   4. ORDER HISTORY   — shows SUBMITTED/FILLED/CANCELLED with IBKR audit trail
 *
 * The PAPER badge is shown everywhere — header, modal, every order card —
 * so there is never ambiguity between paper and (future) live trading.
 */
export default function PaperTradingDesk() {
  const canWrite    = useCanWrite("paperTrading");
  const queryClient = useQueryClient();
  const [modalRec, setModalRec] = useState(null);   // the PROCEED rec being staged

  const stageMutation = useMutation({
    mutationFn: (order) => api.post("/paper-trade/staged", order),
    onSuccess: () => {
      setModalRec(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.paperTradeStaged() });
    },
  });

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      {/* Stage Order modal */}
      {modalRec && (
        <PaperStageOrderModal
          rec={modalRec}
          onConfirm={(order) => stageMutation.mutate(order)}
          onCancel={() => { setModalRec(null); stageMutation.reset(); }}
          isPending={stageMutation.isPending}
        />
      )}

      {/* Staging error toast */}
      {stageMutation.isError && (
        <div className="rounded-xl bg-red-500/[0.12] border border-red-500/[0.2] px-4 py-3 text-sm text-red-400">
          Failed to stage order: {stageMutation.error?.detail?.error || stageMutation.error?.message || "Unknown error"}
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="Trading Desk"
          subtitle="Wheel scan recommendations → human review → IBKR paper order"
          icon={PageIcons.paperTrading}
        />
        {/* Persistent PAPER badge + account indicator */}
        <div className="flex items-center gap-2 shrink-0 pt-1">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-amber-500/[0.3] bg-amber-500/[0.08]">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-xs font-bold text-amber-400 uppercase tracking-wide">Paper Account</span>
          </div>
          {IBKR_ACCOUNT_ID && (
            <span className="text-xs text-slate-600 font-mono">{IBKR_ACCOUNT_ID}</span>
          )}
        </div>
      </div>

      {/* Flow indicator */}
      <div className="flex items-center gap-2 text-[11px] text-slate-600 flex-wrap">
        <span className="px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.06] text-slate-400">1 · PROCEED Queue</span>
        <span>→</span>
        <span className="px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.06] text-slate-400">2 · Stage Order</span>
        <span>→</span>
        <span className="px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.06] text-slate-400">3 · Review &amp; Confirm</span>
        <span>→</span>
        <span className="px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.06] text-amber-400/70">4 · IBKR Paper Order</span>
      </div>

      {/* Panel 1: PROCEED Queue */}
      {canWrite ? (
        <PaperProceedQueue onStage={(rec) => { stageMutation.reset(); setModalRec(rec); }} />
      ) : (
        <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-8 text-center text-slate-500 text-sm">
          You have read-only access to this page.
        </div>
      )}

      {/* Panel 2: Staged Orders */}
      <PaperStagedOrders canWrite={canWrite} />

      {/* Panel 3: Order History */}
      <PaperOrderHistory />
    </div>
  );
}
