import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { PageHeader } from "../components/ui/PageHeader.jsx";
import { PageIcons } from "../components/ui/PageIcons.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { Badge } from "../components/ui/Badge.jsx";
import { DeleteConfirmModal } from "../components/ui/DeleteConfirmModal.jsx";

/**
 * Opportunity Engine — scheduled + on-demand market scan.
 *
 * Replaces the old Wheel Scan page. Shows the last 10 scan runs
 * (GET /research/opportunities/scans); selecting one loads that scan's
 * own candidates (GET /research/opportunities/scans/{scanId}) rather
 * than one flat all-time list -- each run's shortlist is a distinct,
 * comparable snapshot, not one ever-growing pile. Lets you fire an
 * on-demand scan (POST /research/opportunities/trigger — async, minutes
 * not seconds, so this just confirms the trigger rather than waiting on
 * a result), and hands off to Deep Dive & Scenarios for anything you
 * want to dig into (?recommendationId=<id>).
 *
 * Recommendations from scans run before this feature shipped have no
 * scanId and won't appear under any entry in the history list below --
 * expected, not a bug (see the scan-history plan's stated caveat).
 */

const STATUS_BADGE_VARIANT = {
  NEW: "info",
  REVIEWING: "warning",
  SCENARIO_RUN: "warning",
  APPROVED: "gain",
  DISMISSED: "neutral",
  EXPIRED: "neutral",
  SCREENED_ONLY: "neutral",
};

const SCAN_STATUS_BADGE_VARIANT = {
  IN_PROGRESS: "warning",
  COMPLETE: "gain",
  FAILED: "loss",
};

function formatRecDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

function formatScanDateTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function ScanHistoryRow({ scan, selected, onSelect }) {
  const cost = scan.totalActualCostUsd != null ? `$${Number(scan.totalActualCostUsd).toFixed(2)}` : null;
  return (
    <button
      type="button"
      onClick={() => onSelect(scan.scanId)}
      className={[
        "w-full text-left rounded-xl border px-3.5 py-3 transition-colors cursor-pointer",
        selected
          ? "bg-emerald-500/[0.1] border-emerald-500/30"
          : "bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-bold text-white">{formatScanDateTime(scan.startedAt)}</span>
        <Badge variant={SCAN_STATUS_BADGE_VARIANT[scan.status] || "neutral"}>{scan.status}</Badge>
      </div>
      {scan.status === "COMPLETE" && (
        <p className="text-[11px] text-slate-500 mt-1">
          {scan.deepDivedCount ?? 0} deep-dived · {scan.screenedOnlyCount ?? 0} screened{cost ? ` · ${cost}` : ""}
        </p>
      )}
      {scan.status === "FAILED" && scan.error && (
        <p className="text-[11px] text-red-400/80 mt-1 line-clamp-1">{scan.error}</p>
      )}
    </button>
  );
}

function RecommendationCard({ rec, onDeepDive }) {
  const pct = rec.probabilityOfProfit != null ? Math.round(rec.probabilityOfProfit * 100) : null;

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-lg font-black text-white" style={{ fontFamily: "Epilogue, sans-serif" }}>
              {rec.ticker}
            </h3>
            <Badge variant={STATUS_BADGE_VARIANT[rec.status] || "neutral"}>{rec.status}</Badge>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">{rec.strategyType}</p>
        </div>
        <div className="flex gap-4 text-right shrink-0">
          {rec.rankScore != null && (
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wide">Rank</div>
              <div className="text-sm font-bold text-white">{rec.rankScore}</div>
            </div>
          )}
          {pct != null && (
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wide">Prob. profit</div>
              <div className="text-sm font-bold text-emerald-400">{pct}%</div>
            </div>
          )}
        </div>
      </div>

      {rec.rationale && <p className="text-sm text-slate-400 leading-relaxed line-clamp-3">{rec.rationale}</p>}

      <div className="flex items-center justify-between mt-1">
        <span className="text-[11px] text-slate-600">{formatRecDate(rec.createdAt)}</span>
        <button
          type="button"
          onClick={() => onDeepDive(rec.recommendationId)}
          className="text-xs font-bold px-3 py-1.5 rounded-full bg-emerald-600/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-600/25 transition-colors cursor-pointer"
        >
          Deep dive →
        </button>
      </div>
    </div>
  );
}

export default function OpportunityEngine() {
  const navigate = useNavigate();
  const [triggering, setTriggering] = useState(false);
  const [triggerMessage, setTriggerMessage] = useState("");
  // Holds the server's "needs_confirmation" response while the confirm
  // modal is open -- a scan completed within the last 7 days and the
  // user hasn't yet said whether to run another one anyway.
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [selectedScanId, setSelectedScanId] = useState(null);

  const {
    data: scansData,
    isLoading: scansLoading,
    isError: scansError,
    refetch: refetchScans,
  } = useQuery({
    queryKey: queryKeys.opportunityScans(),
    queryFn: () => api.get("/research/opportunities/scans"),
  });

  const scans = scansData?.scans || [];

  // Default to the most recent run once the history loads, so the page
  // doesn't open on an empty candidate panel -- but only if nothing's
  // been explicitly selected yet, so a later refetch (e.g. after
  // triggering a new scan) doesn't yank the user back to the top.
  const mostRecentScanId = scans[0]?.scanId || null;
  useEffect(() => {
    if (!selectedScanId && mostRecentScanId) {
      setSelectedScanId(mostRecentScanId);
    }
  }, [mostRecentScanId, selectedScanId]);

  const {
    data: scanDetailData,
    isLoading: scanDetailLoading,
    isError: scanDetailError,
  } = useQuery({
    queryKey: queryKeys.opportunityScanDetail(selectedScanId),
    queryFn: () => api.get(`/research/opportunities/scans/${encodeURIComponent(selectedScanId)}`),
    enabled: !!selectedScanId,
  });

  const recommendations = scanDetailData?.recommendations || [];
  const selectedScan = scans.find((s) => s.scanId === selectedScanId) || null;

  const handleTrigger = async (force = false) => {
    setTriggering(true);
    setTriggerMessage("");
    try {
      const res = await api.post("/research/opportunities/trigger", { force });
      if (res?.status === "needs_confirmation") {
        setPendingConfirmation(res);
        return; // not triggered yet -- wait for the user's yes/no
      }
      setPendingConfirmation(null);
      setTriggerMessage(res?.message || "Scan triggered. Check back in a few minutes.");
      refetchScans();
    } catch (e) {
      setTriggerMessage(e?.detail?.message || "Failed to trigger scan. Please try again.");
    } finally {
      setTriggering(false);
    }
  };

  const handleConfirmRunAnyway = () => {
    setPendingConfirmation(null);
    handleTrigger(true);
  };

  const handleDeepDive = (recommendationId) => {
    navigate(`/research/deep-dive?recommendationId=${recommendationId}`);
  };

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Opportunity Engine"
        icon={PageIcons.opportunityEngine}
        subtitle="Scans the market for long, short, and options setups ranked against your portfolio and risk profile."
      >
        <button
          type="button"
          onClick={() => handleTrigger(false)}
          disabled={triggering}
          className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold transition-colors cursor-pointer"
        >
          {triggering ? "Triggering…" : "Run scan now"}
        </button>
      </PageHeader>

      {pendingConfirmation && (
        <DeleteConfirmModal
          title="Recent scan found"
          message={pendingConfirmation.message}
          confirmLabel="Run anyway"
          deleting={triggering}
          onConfirm={handleConfirmRunAnyway}
          onClose={() => setPendingConfirmation(null)}
        />
      )}

      {triggerMessage && (
        <div className="text-xs text-emerald-300 bg-emerald-500/[0.08] border border-emerald-500/[0.2] rounded-xl px-4 py-2.5">
          {triggerMessage}
        </div>
      )}

      {scansLoading && <EmptyState type="loading" message="Loading scan history…" />}

      {scansError && <EmptyState type="error" onRetry={refetchScans} />}

      {!scansLoading && !scansError && scans.length === 0 && (
        <EmptyState
          type="empty"
          message="No scans yet. Run a scan to get ranked opportunities, or check back after the next scheduled weekly scan."
        />
      )}

      {!scansLoading && !scansError && scans.length > 0 && (
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="lg:w-72 shrink-0 flex flex-col gap-2">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wide px-1">
              Scan history
            </h3>
            {scans.map((scan) => (
              <ScanHistoryRow
                key={scan.scanId}
                scan={scan}
                selected={scan.scanId === selectedScanId}
                onSelect={setSelectedScanId}
              />
            ))}
          </div>

          <div className="flex-1 min-w-0">
            {selectedScan?.status === "IN_PROGRESS" && (
              <EmptyState type="loading" message="This scan is still running — check back shortly." />
            )}

            {selectedScan?.status === "FAILED" && (
              <EmptyState type="error" message={selectedScan.error || "This scan failed to complete."} />
            )}

            {selectedScan?.status === "COMPLETE" && scanDetailLoading && (
              <EmptyState type="loading" message="Loading candidates…" />
            )}

            {selectedScan?.status === "COMPLETE" && scanDetailError && <EmptyState type="error" />}

            {selectedScan?.status === "COMPLETE" && !scanDetailLoading && !scanDetailError && recommendations.length === 0 && (
              <EmptyState type="empty" message="This scan didn't produce any candidates." />
            )}

            {selectedScan?.status === "COMPLETE" && !scanDetailLoading && !scanDetailError && recommendations.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {recommendations.map((rec) => (
                  <RecommendationCard key={rec.recommendationId} rec={rec} onDeepDive={handleDeepDive} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
