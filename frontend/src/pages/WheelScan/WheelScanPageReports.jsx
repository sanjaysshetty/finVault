import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../../api/client.js";
import { PageHeader } from "../../components/ui/PageHeader.jsx";
import { PageIcons }  from "../../components/ui/PageIcons.jsx";

function formatDate(isoDate) {
  if (!isoDate) return "—";
  try {
    return new Date(isoDate + "T12:00:00Z").toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch {
    return isoDate;
  }
}

function parseDateInput(val) {
  return val ? new Date(val + "T00:00:00Z") : null;
}

function Badge({ label, color }) {
  const colorMap = {
    green:  "bg-emerald-500/[0.15] text-emerald-400 border border-emerald-500/[0.25]",
    yellow: "bg-amber-500/[0.15] text-amber-400 border border-amber-500/[0.25]",
    red:    "bg-red-500/[0.15] text-red-400 border border-red-500/[0.25]",
    blue:   "bg-blue-500/[0.15] text-blue-400 border border-blue-500/[0.25]",
    slate:  "bg-slate-500/[0.15] text-slate-400 border border-slate-500/[0.25]",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold ${colorMap[color] || colorMap.slate}`}>
      {label}
    </span>
  );
}

export default function WheelScanPageReports() {
  const navigate     = useNavigate();
  const queryClient  = useQueryClient();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo,   setDateTo]   = useState("");
  const [confirmScan, setConfirmScan] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.wheelHistory(),
    queryFn:  () => api.get("/wheel/scan/history"),
    staleTime: 5 * 60 * 1000,
  });

  const triggerMutation = useMutation({
    mutationFn: () => api.post("/wheel/scan/trigger"),
    onSuccess: () => {
      setTimeout(() => queryClient.invalidateQueries({ queryKey: queryKeys.wheelHistory() }), 3000);
    },
  });

  const allScans = data?.scans || [];

  const filtered = allScans.filter((s) => {
    const d = new Date(s.scan_date + "T12:00:00Z");
    if (dateFrom && d < parseDateInput(dateFrom)) return false;
    if (dateTo   && d > parseDateInput(dateTo))   return false;
    return true;
  });

  // Default: show latest 7 if no date filter applied
  const scans = (dateFrom || dateTo) ? filtered : filtered.slice(0, 7);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto">
      <PageHeader
        title="Wheel Strategy Scans"
        subtitle="Daily options scan — Cash-Secured Puts & Covered Calls"
        icon={PageIcons.wheelScan}
      />

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 whitespace-nowrap">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 whitespace-nowrap">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50"
          />
        </div>
        {(dateFrom || dateTo) && (
          <button
            type="button"
            onClick={() => { setDateFrom(""); setDateTo(""); }}
            className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1.5 rounded-lg hover:bg-white/[0.04] transition-colors cursor-pointer"
          >
            Clear
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {confirmScan ? (
            <>
              <span className="text-xs text-slate-400">Run a new scan?</span>
              <button
                type="button"
                onClick={() => { setConfirmScan(false); triggerMutation.mutate(); }}
                disabled={triggerMutation.isPending}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors cursor-pointer"
              >
                Yes, run it
              </button>
              <button
                type="button"
                onClick={() => setConfirmScan(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/[0.06] hover:bg-white/[0.1] text-slate-300 transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmScan(true)}
              disabled={triggerMutation.isPending}
              className={[
                "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all cursor-pointer",
                triggerMutation.isPending
                  ? "bg-blue-600/50 text-blue-300 cursor-not-allowed"
                  : "bg-blue-600 hover:bg-blue-500 text-white",
              ].join(" ")}
            >
              {triggerMutation.isPending ? "Triggering..." : "Run Scan Now"}
            </button>
          )}
        </div>
      </div>

      {/* Trigger feedback */}
      {triggerMutation.isSuccess && (
        <div className="rounded-xl bg-emerald-500/[0.12] border border-emerald-500/[0.2] px-4 py-3 text-sm text-emerald-400">
          Scan triggered. Results will appear in 5–10 minutes.
        </div>
      )}
      {triggerMutation.isError && (
        <div className="rounded-xl bg-red-500/[0.12] border border-red-500/[0.2] px-4 py-3 text-sm text-red-400">
          Failed to trigger scan. Please try again.
        </div>
      )}

      {/* Table */}
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
        {/* Header */}
        <div
          className="grid items-center px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]"
          style={{ gridTemplateColumns: "140px 1fr 80px 80px 80px 100px 90px" }}
        >
          {["Scan Date", "Summary", "Proceed", "Watch", "Skip", "Duration", ""].map((h) => (
            <span key={h} className="text-xs font-bold uppercase tracking-wide text-slate-500">{h}</span>
          ))}
        </div>

        {isLoading && (
          <div className="px-4 py-10 text-center text-slate-500 text-sm">Loading scans…</div>
        )}
        {isError && (
          <div className="px-4 py-10 text-center text-red-400 text-sm">Failed to load scan history.</div>
        )}
        {!isLoading && !isError && scans.length === 0 && (
          <div className="px-4 py-10 text-center text-slate-500 text-sm">
            No scans found. Run a scan to get started.
          </div>
        )}

        {scans.map((scan, idx) => (
          <div
            key={scan.scan_id}
            onClick={() => navigate(`/research/wheel-scan/${scan.scan_id}`)}
            className={[
              "grid items-center px-4 py-3.5 cursor-pointer transition-colors",
              "hover:bg-white/[0.04]",
              idx < scans.length - 1 ? "border-b border-white/[0.04]" : "",
            ].join(" ")}
            style={{ gridTemplateColumns: "140px 1fr 80px 80px 80px 100px 90px" }}
          >
            {/* Date */}
            <span className="text-sm font-semibold text-slate-200">{formatDate(scan.scan_date)}</span>

            {/* Summary bar */}
            <div className="flex items-center gap-1.5 min-w-0 pr-4">
              <div className="flex-1 h-2 rounded-full bg-white/[0.06] overflow-hidden flex">
                {scan.proceed_count > 0 && (
                  <div
                    className="h-full bg-emerald-500"
                    style={{ width: `${(scan.proceed_count / (scan.universe_size || 1)) * 100}%` }}
                  />
                )}
                {scan.watch_count > 0 && (
                  <div
                    className="h-full bg-amber-500"
                    style={{ width: `${(scan.watch_count / (scan.universe_size || 1)) * 100}%` }}
                  />
                )}
              </div>
              <span className="text-xs text-slate-500 whitespace-nowrap">{scan.universe_size} stocks</span>
            </div>

            {/* Proceed */}
            <Badge label={scan.proceed_count} color="green" />

            {/* Watch */}
            <Badge label={scan.watch_count} color="yellow" />

            {/* Skip */}
            <span className="text-sm text-slate-500">{scan.skip_count}</span>

            {/* Duration */}
            <span className="text-xs text-slate-500">
              {scan.duration_s ? `${Math.round(scan.duration_s / 60)}m ${scan.duration_s % 60}s` : "—"}
            </span>

            {/* Arrow */}
            <span className="text-slate-600 text-lg">›</span>
          </div>
        ))}
      </div>

      {!dateFrom && !dateTo && allScans.length > 7 && (
        <p className="text-xs text-slate-500 text-center">
          Showing latest 7 scans. Use date filters to view older scans.
        </p>
      )}
    </div>
  );
}
