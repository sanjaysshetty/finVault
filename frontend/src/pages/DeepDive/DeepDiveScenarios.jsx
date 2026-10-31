import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client.js";
import { PageHeader } from "../../components/ui/PageHeader.jsx";
import { PageIcons } from "../../components/ui/PageIcons.jsx";
import { Badge } from "../../components/ui/Badge.jsx";

/**
 * Deep Dive & Scenarios — chat + scenario simulation surface.
 *
 * Replaces Asset Hub and Compass AI / Advisor. Two entry paths:
 *   - standalone (no params): freeform chat, name any ticker/strategy yourself
 *   - pre-seeded: /research/deep-dive?recommendationId=<id>, context pre-loaded
 *     from an Opportunity Engine card (fetched via the existing
 *     GET /research/opportunities/{id} route — no new backend route needed
 *     just to display it)
 *
 * Recency gate (mirrors Opportunity Engine's "already scanned, run again
 * anyway?" fix, scoped here to pre-seeded entries only — see 2026-10-28
 * feedback): a freeform chat message has no reliable, cost-free way to
 * tell whether it's "redo this ticker's analysis" vs. an unrelated
 * question, so this only gates the one case with a known ticker and
 * existing stored analysis — arriving via ?recommendationId=<id>. If that
 * recommendation already has real Tower-2 content (status !== SCREENED_ONLY)
 * from within the last 7 days, show it directly instead of defaulting into
 * a fresh (paid) chat turn; the user must explicitly ask to start a new
 * analysis to reach the chat input.
 *
 * Unlike AdvisorChat, replies render as plain text, not HTML-in-iframe —
 * this prompt was never designed to emit HTML, and plain text via React's
 * default escaping carries no injection surface to sandbox against in the
 * first place.
 */

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 4 * 60 * 1000;
const RECENCY_GATE_WINDOW_DAYS = 7;

function daysSince(iso) {
  if (!iso) return Infinity;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function formatGateDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

function TypingIndicator() {
  return (
    <div className="flex gap-3 justify-start">
      <div className="w-8 h-8 rounded-full bg-emerald-600 flex items-center justify-center shrink-0">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-white">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm3.5 6.5-2 6-6 2 2-6 6-2z" />
        </svg>
      </div>
      <div className="bg-white/[0.04] border border-white/[0.06] rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className="w-2 h-2 rounded-full bg-emerald-400 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
    </div>
  );
}

function UserBubble({ content }) {
  return (
    <div className="flex gap-3 justify-end">
      <div className="max-w-[80%] bg-blue-600/20 border border-blue-500/20 text-slate-200 rounded-2xl rounded-tr-sm px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
        {content}
      </div>
      <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center shrink-0 mt-0.5">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-slate-300">
          <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      </div>
    </div>
  );
}

function AssistantBubble({ content }) {
  return (
    <div className="flex gap-3 justify-start">
      <div className="w-8 h-8 rounded-full bg-emerald-600 flex items-center justify-center shrink-0">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-white">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm3.5 6.5-2 6-6 2 2-6 6-2z" />
        </svg>
      </div>
      <div className="max-w-[80%] bg-white/[0.04] border border-white/[0.06] text-slate-200 rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
        {content}
      </div>
    </div>
  );
}

function RecommendationBanner({ recommendation }) {
  if (!recommendation) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-emerald-500/[0.08] border border-emerald-500/[0.2] px-4 py-2.5 mb-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" className="w-4 h-4 shrink-0 text-emerald-400">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
        </svg>
        <span className="text-xs text-emerald-300 font-medium truncate">
          Continuing recommendation for <b>{recommendation.ticker}</b> ({recommendation.strategyType}) —{" "}
          <span className="text-emerald-500/70">{recommendation.status}</span>
        </span>
      </div>
    </div>
  );
}

const STATUS_BADGE_VARIANT = {
  NEW: "info",
  REVIEWING: "warning",
  SCENARIO_RUN: "warning",
  APPROVED: "gain",
  DISMISSED: "neutral",
  EXPIRED: "neutral",
};

function ExistingAnalysisGate({ recommendation, daysAgo, onRunNewAnalysis }) {
  const pct = recommendation.probabilityOfProfit != null ? Math.round(recommendation.probabilityOfProfit * 100) : null;
  const ageLabel = daysAgo <= 0 ? "earlier today" : `${daysAgo} day${daysAgo === 1 ? "" : "s"} ago`;

  return (
    <div className="flex-1 rounded-2xl border border-white/[0.06] bg-[#0F1729] overflow-y-auto p-6">
      <div className="flex items-center justify-between gap-3 rounded-xl bg-emerald-500/[0.08] border border-emerald-500/[0.2] px-4 py-2.5 mb-5">
        <span className="text-xs text-emerald-300 font-medium">
          This ticker was already deep-dived {ageLabel}. Showing the existing analysis instead of running a new one.
        </span>
      </div>

      <div className="flex items-center gap-2.5 flex-wrap mb-2">
        <h3 className="text-xl font-black text-white" style={{ fontFamily: "Epilogue, sans-serif" }}>
          {recommendation.ticker}
        </h3>
        <Badge variant={STATUS_BADGE_VARIANT[recommendation.status] || "neutral"}>{recommendation.status}</Badge>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        {recommendation.strategyType} · analyzed {formatGateDate(recommendation.createdAt)}
      </p>

      <div className="flex gap-6 mb-4">
        {recommendation.rankScore != null && (
          <div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wide">Rank</div>
            <div className="text-sm font-bold text-white">{recommendation.rankScore}</div>
          </div>
        )}
        {pct != null && (
          <div>
            <div className="text-[10px] text-slate-500 uppercase tracking-wide">Prob. profit</div>
            <div className="text-sm font-bold text-emerald-400">{pct}%</div>
          </div>
        )}
      </div>

      {recommendation.rationale && (
        <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap mb-6">{recommendation.rationale}</p>
      )}

      <button
        type="button"
        onClick={onRunNewAnalysis}
        className="text-xs font-bold px-4 py-2 rounded-full bg-white/[0.06] text-slate-300 border border-white/[0.1] hover:bg-white/[0.1] transition-colors cursor-pointer"
      >
        Run a new analysis anyway →
      </button>
    </div>
  );
}

export default function DeepDiveScenarios() {
  const [searchParams] = useSearchParams();
  const recommendationId = searchParams.get("recommendationId");

  const { data: recommendationData } = useQuery({
    queryKey: ["deepDiveRecommendation", recommendationId],
    queryFn: () => api.get(`/research/opportunities/${recommendationId}`),
    enabled: !!recommendationId,
  });

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pendingJob, setPendingJob] = useState(null);
  const [linkedRecommendationId, setLinkedRecommendationId] = useState(recommendationId || null);
  // User explicitly asked to bypass the recency gate below and start a
  // fresh (paid) analysis anyway -- once true, the gate never re-shows
  // for this page visit, even if messages are still empty.
  const [freshAnalysisRequested, setFreshAnalysisRequested] = useState(false);

  const recommendation = recommendationData?.recommendation || null;
  const hasStoredAnalysis = !!recommendation && recommendation.status !== "SCREENED_ONLY";
  const daysSinceAnalysis = hasStoredAnalysis ? daysSince(recommendation.createdAt) : null;
  const showRecencyGate =
    !!recommendationId &&
    hasStoredAnalysis &&
    daysSinceAnalysis < RECENCY_GATE_WINDOW_DAYS &&
    !freshAnalysisRequested &&
    messages.length === 0;

  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    if (!pendingJob) return;
    let stopped = false;

    const interval = setInterval(async () => {
      try {
        const res = await api.get(`/research/deep-dive/result/${pendingJob.jobId}`);
        if (stopped) return;
        if (res.reply) {
          setMessages((prev) => [...prev, { role: "assistant", content: res.reply }]);
          if (res.recommendationId) setLinkedRecommendationId(res.recommendationId);
          setPendingJob(null);
          setLoading(false);
        }
      } catch (e) {
        if (stopped) return;
        if (e.status === 404) return; // still pending
        const detail = e?.detail || {};
        setError(detail.message || "Something went wrong. Please try again.");
        setPendingJob(null);
        setLoading(false);
        setMessages((prev) => prev.slice(0, -1));
      }
    }, POLL_INTERVAL_MS);

    const timeout = setTimeout(() => {
      if (stopped) return;
      clearInterval(interval);
      setError("This is taking longer than expected. Please try again.");
      setPendingJob(null);
      setLoading(false);
      setMessages((prev) => prev.slice(0, -1));
    }, POLL_TIMEOUT_MS);

    return () => {
      stopped = true;
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [pendingJob]);

  const sendMessage = useCallback(
    async (text) => {
      const msg = (text ?? input).trim();
      if (!msg || loading) return;

      setInput("");
      setError("");
      setMessages((prev) => [...prev, { role: "user", content: msg }]);
      setLoading(true);

      try {
        const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
        const res = await api.post("/research/deep-dive/chat", {
          message: msg,
          history,
          recommendationId: linkedRecommendationId || undefined,
        });

        if (res.status === "pending" && res.jobId) {
          setPendingJob({ jobId: res.jobId });
          return;
        }

        if (res.recommendationId) setLinkedRecommendationId(res.recommendationId);
        setMessages((prev) => [...prev, { role: "assistant", content: res.reply }]);
        setLoading(false);
      } catch (e) {
        const detail = e?.detail || {};
        setError(detail.message || "Something went wrong. Please try again.");
        setMessages((prev) => prev.slice(0, -1));
        setLoading(false);
      }
    },
    [input, loading, messages, linkedRecommendationId]
  );

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="flex flex-col gap-4 p-6 max-w-5xl mx-auto h-[calc(100vh-48px)]">
      <PageHeader
        title="Deep Dive & Scenarios"
        icon={PageIcons.deepDive}
        subtitle="Ask about any position or ticker, or dig into a recommendation — run scenarios and see the probability-weighted outcome before deciding."
      />

      <RecommendationBanner recommendation={recommendation} />

      {showRecencyGate ? (
        <ExistingAnalysisGate
          recommendation={recommendation}
          daysAgo={daysSinceAnalysis}
          onRunNewAnalysis={() => setFreshAnalysisRequested(true)}
        />
      ) : (
      <div className="flex flex-col flex-1 rounded-2xl border border-white/[0.06] bg-[#0F1729] overflow-hidden min-h-[500px]">
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {isEmpty && !loading && (
            <div className="flex flex-col items-center justify-center h-full py-12 text-center">
              <div className="w-16 h-16 rounded-2xl bg-emerald-600/10 border border-emerald-500/20 flex items-center justify-center mb-4">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-8 h-8 text-emerald-400">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm3.5 6.5-2 6-6 2 2-6 6-2z" />
                </svg>
              </div>
              <h3 className="text-base font-bold text-white mb-1" style={{ fontFamily: "Epilogue, sans-serif" }}>
                Ask about any ticker or strategy
              </h3>
              <p className="text-sm text-slate-500 max-w-md">
                {recommendationId
                  ? "Loading context for your recommendation…"
                  : "Research a ticker, run a scenario, or ask what your portfolio looks like right now — all grounded against your real positions."}
              </p>
            </div>
          )}

          {messages.map((msg, i) =>
            msg.role === "user" ? <UserBubble key={i} content={msg.content} /> : <AssistantBubble key={i} content={msg.content} />
          )}

          {loading && <TypingIndicator />}

          {error && (
            <div className="flex justify-center">
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 max-w-sm text-center">
                {error}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <div className="border-t border-white/[0.06] p-4">
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about a ticker, run a scenario, or continue this recommendation…"
                disabled={loading}
                rows={1}
                className="w-full bg-[#080D1A] border border-white/[0.08] rounded-xl px-4 py-3 text-slate-200 text-sm outline-none focus:border-emerald-500/40 transition-colors resize-none leading-relaxed disabled:opacity-50"
                style={{ minHeight: "46px", maxHeight: "160px", overflowY: "auto" }}
                onInput={(e) => {
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
                }}
              />
            </div>
            <button
              type="button"
              onClick={() => sendMessage()}
              disabled={loading || !input.trim()}
              className="w-11 h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center shrink-0 transition-all cursor-pointer"
            >
              {loading ? (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              )}
            </button>
          </div>
          <p className="text-[11px] text-slate-700 mt-2 text-center">Enter to send · Shift+Enter for new line</p>
        </div>
      </div>
      )}
    </div>
  );
}
