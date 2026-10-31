import { useState } from "react";
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
 * Replaces the old Wheel Scan page. Lists ranked AgentRecommendations
 * (GET /research/opportunities), lets you fire an on-demand scan
 * (POST /research/opportunities/trigger — async, minutes not seconds, so
 * this just confirms the trigger rather than waiting on a result), and
 * hands off to Deep Dive & Scenarios for anything you want to dig into
 * (?recommendationId=<id>).
 */

const STATUS_BADGE_VARIANT = {
  NEW: "info",
  REVIEWING: "warning",
  SCENARIO_RUN: "warning",
  APPROVED: "gain",
  DISMISSED: "neutral",
  EXPIRED: "neutral",
};

function formatRecDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
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

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.opportunities(),
    queryFn: () => api.get("/research/opportunities"),
  });

  const recommendations = data?.recommendations || [];

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

      {isLoading && <EmptyState type="loading" message="Loading recommendations…" />}

      {isError && <EmptyState type="error" onRetry={refetch} />}

      {!isLoading && !isError && recommendations.length === 0 && (
        <EmptyState
          type="empty"
          message="No recommendations yet. Run a scan to get ranked opportunities, or check back after the next scheduled weekly scan."
        />
      )}

      {!isLoading && !isError && recommendations.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {recommendations.map((rec) => (
            <RecommendationCard key={rec.recommendationId} rec={rec} onDeepDive={handleDeepDive} />
          ))}
        </div>
      )}
    </div>
  );
}
