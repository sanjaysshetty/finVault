import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "../../api/client.js";

function fmt$(n) {
  return n == null ? "—" : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(n) { return n == null ? "—" : `${Number(n).toFixed(1)}%`; }

/**
 * PaperProceedQueue
 *
 * Fetches the latest wheel scan and surfaces all PROCEED recommendations.
 * Each row has a "Stage Order" button that opens the modal in PaperTradingDesk.
 * Clicking the row itself navigates to the full scan report.
 */
export default function PaperProceedQueue({ onStage }) {
  const navigate  = useNavigate();
  const [scanId, setScanId] = useState(null);  // null = use latest

  // Fetch scan history to let user pick which scan to pull from
  const historyQ = useQuery({
    queryKey: queryKeys.wheelHistory(),
    queryFn:  () => api.get("/wheel/scan/history"),
    staleTime: 5 * 60 * 1000,
  });

  const scans = historyQ.data?.scans || [];
  const activeScanId = scanId || scans[0]?.scan_id || null;

  const scanQ = useQuery({
    queryKey: queryKeys.wheelScan(activeScanId),
    queryFn:  () => api.get(`/wheel/scan/${activeScanId}`),
    enabled:  !!activeScanId,
    staleTime: 10 * 60 * 1000,
  });

  const proceeds = (scanQ.data?.stocks || []).filter((s) => s.recommendation === "PROCEED");

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729]">
      {/* Panel header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Proceed Queue</span>
          {proceeds.length > 0 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500/[0.15] text-emerald-400 border border-emerald-500/[0.2]">
              {proceeds.length}
            </span>
          )}
        </div>

        {/* Scan selector */}
        {scans.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-slate-500">From scan:</span>
            <select
              value={activeScanId || ""}
              onChange={(e) => setScanId(e.target.value || null)}
              className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-blue-500/50"
            >
              {scans.map((s) => (
                <option key={s.scan_id} value={s.scan_id}>{s.scan_date}</option>
              ))}
            </select>
            {activeScanId && (
              <button
                type="button"
                onClick={() => navigate(`/research/wheel-scan/${activeScanId}`)}
                className="text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2 cursor-pointer whitespace-nowrap"
              >
                View Report →
              </button>
            )}
          </div>
        )}
      </div>

      {/* Loading / empty states */}
      {(historyQ.isLoading || scanQ.isLoading) && (
        <div className="px-4 py-8 text-center text-slate-500 text-sm">Loading scan data…</div>
      )}
      {!historyQ.isLoading && scans.length === 0 && (
        <div className="px-4 py-8 text-center text-slate-500 text-sm">
          No wheel scans found. Run a scan first from the{" "}
          <button
            onClick={() => navigate("/research/wheel-scan")}
            className="text-blue-400 hover:text-blue-300 underline underline-offset-2 cursor-pointer"
          >Wheel Scan</button> page.
        </div>
      )}
      {!scanQ.isLoading && activeScanId && proceeds.length === 0 && (
        <div className="px-4 py-8 text-center text-slate-500 text-sm">
          No PROCEED recommendations in this scan.
        </div>
      )}

      {/* Column headers */}
      {proceeds.length > 0 && (
        <div className="grid px-4 py-2 border-b border-white/[0.04] [grid-template-columns:64px_minmax(0,1fr)_60px_72px_80px_80px_100px]">
          {["Ticker", "Name / Sector", "Score", "Strike", "Expiry", "Ann. Yield", ""].map((h, i) => (
            <span key={i} className="text-[10px] font-bold uppercase tracking-wide text-slate-600">{h}</span>
          ))}
        </div>
      )}

      {/* Rows */}
      {proceeds.map((stock) => {
        const opt = stock.option || {};
        return (
          <div
            key={stock.ticker}
            className="grid items-center px-4 py-3 border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.03] [grid-template-columns:64px_minmax(0,1fr)_60px_72px_80px_80px_100px] gap-1"
          >
            <span className="text-sm font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
              {stock.ticker}
            </span>
            <div className="min-w-0">
              <p className="text-xs text-slate-300 truncate">{stock.name}</p>
              <p className="text-[10px] text-slate-600 truncate">{stock.sector}</p>
            </div>
            <span className="text-sm font-bold text-emerald-400">{stock.adj_score}</span>
            <span className="text-sm text-slate-300">{fmt$(opt.strike)}</span>
            <span className="text-xs text-slate-400">{opt.expiry || "—"}</span>
            <span className="text-sm font-semibold text-emerald-400">{fmtPct(opt.ann_yield)}</span>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => onStage({ ...stock, scanId: activeScanId })}
                className="px-3 py-1.5 rounded-lg bg-amber-600/90 hover:bg-amber-500 text-xs font-semibold text-white transition-all cursor-pointer whitespace-nowrap"
              >
                Stage Order
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
