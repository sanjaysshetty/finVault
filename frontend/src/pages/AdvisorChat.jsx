import { useState, useRef, useEffect, useCallback } from "react";
import { api } from "../api/client.js";
import { PageHeader } from "../components/ui/PageHeader.jsx";
import { PageIcons } from "../components/ui/PageIcons.jsx";
import { useCanWrite } from "../hooks/useCanWrite.js";

/* ─────────────────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────────────────── */
const GOALS_KEY = "finvault.advisorGoals";

const RISK_OPTIONS = [
  { value: "Conservative",    label: "Conservative",    desc: "Capital preservation, minimal volatility" },
  { value: "Moderate",        label: "Moderate",        desc: "Balanced growth with managed risk" },
  { value: "Aggressive",      label: "Aggressive",      desc: "High growth, comfortable with drawdowns" },
  { value: "Very Aggressive", label: "Very Aggressive", desc: "Maximum growth, high risk tolerance" },
];

const OBJECTIVE_OPTIONS = [
  { value: "Capital Preservation", label: "Capital Preservation" },
  { value: "Income Generation",    label: "Income Generation" },
  { value: "Balanced Growth",      label: "Balanced Growth" },
  { value: "Aggressive Growth",    label: "Aggressive Growth" },
  { value: "Speculation",          label: "Speculation" },
];

const HORIZON_OPTIONS = [
  { value: "< 1 year",    label: "< 1 year" },
  { value: "1–3 years",   label: "1–3 years" },
  { value: "3–5 years",   label: "3–5 years" },
  { value: "5–10 years",  label: "5–10 years" },
  { value: "10+ years",   label: "10+ years" },
];

const SUGGESTED_PROMPTS = [
  "Review my portfolio and identify the top 3 risks I should address right now.",
  "Given my risk profile and holdings, where am I overconcentrated?",
  "What options strategies would best complement my current stock positions?",
  "How should I position my portfolio given the current macro environment?",
  "Suggest a rebalancing plan to better align with my investment objectives.",
  "Which of my holdings are most exposed to interest rate risk?",
  "What's the ideal cash allocation for my risk profile right now?",
];

const defaultGoals = () => ({
  riskTolerance: "Moderate",
  objective: "Balanced Growth",
  timeHorizon: "5–10 years",
  targetReturn: "",
  monthlyContribution: "",
  notes: "",
});

/* ─────────────────────────────────────────────────────────────
   STYLE CONSTANTS
───────────────────────────────────────────────────────────── */
const inputCls = "bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2 text-slate-200 text-sm w-full outline-none focus:border-blue-500/40 transition-colors";
const selectCls = "bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2 text-slate-200 text-sm w-full outline-none focus:border-blue-500/40 transition-colors";
const labelCls = "text-xs font-semibold text-slate-500 mb-1.5 block";

/* ─────────────────────────────────────────────────────────────
   MESSAGE BUBBLE
───────────────────────────────────────────────────────────── */
function MessageBubble({ msg }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center shrink-0 mt-0.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-white">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
        </div>
      )}
      <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
        isUser
          ? "bg-blue-600/20 border border-blue-500/20 text-slate-200 rounded-tr-sm"
          : "bg-white/[0.04] border border-white/[0.06] text-slate-200 rounded-tl-sm"
      }`}>
        {msg.content}
      </div>
      {isUser && (
        <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center shrink-0 mt-0.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-slate-300">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   TYPING INDICATOR
───────────────────────────────────────────────────────────── */
function TypingIndicator() {
  return (
    <div className="flex gap-3 justify-start">
      <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-white">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
      </div>
      <div className="bg-white/[0.04] border border-white/[0.06] rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1.5">
        {[0, 1, 2].map(i => (
          <span
            key={i}
            className="w-2 h-2 rounded-full bg-blue-400 animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   GOALS PANEL
───────────────────────────────────────────────────────────── */
function GoalsPanel({ goals, setGoals, onSave, saved }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-white" style={{ fontFamily: "Epilogue, sans-serif" }}>
            Investment Profile
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">Your advisor tailors every response to these settings</p>
        </div>
        <button
          type="button"
          onClick={onSave}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-all cursor-pointer"
        >
          {saved ? (
            <>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Saved
            </>
          ) : "Save Profile"}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Risk Tolerance */}
        <div>
          <label className={labelCls}>Risk Tolerance</label>
          <select value={goals.riskTolerance} onChange={e => setGoals(g => ({ ...g, riskTolerance: e.target.value }))} className={selectCls}>
            {RISK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p className="text-[11px] text-slate-600 mt-1">
            {RISK_OPTIONS.find(o => o.value === goals.riskTolerance)?.desc}
          </p>
        </div>

        {/* Objective */}
        <div>
          <label className={labelCls}>Investment Objective</label>
          <select value={goals.objective} onChange={e => setGoals(g => ({ ...g, objective: e.target.value }))} className={selectCls}>
            {OBJECTIVE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        {/* Time Horizon */}
        <div>
          <label className={labelCls}>Time Horizon</label>
          <select value={goals.timeHorizon} onChange={e => setGoals(g => ({ ...g, timeHorizon: e.target.value }))} className={selectCls}>
            {HORIZON_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        {/* Target Return */}
        <div>
          <label className={labelCls}>Target Annual Return (%)</label>
          <input
            type="number"
            value={goals.targetReturn}
            onChange={e => setGoals(g => ({ ...g, targetReturn: e.target.value }))}
            className={inputCls}
            placeholder="e.g. 15"
            min="0" max="100" step="0.5"
          />
        </div>

        {/* Monthly Contribution */}
        <div>
          <label className={labelCls}>Monthly Contribution ($)</label>
          <input
            type="number"
            value={goals.monthlyContribution}
            onChange={e => setGoals(g => ({ ...g, monthlyContribution: e.target.value }))}
            className={inputCls}
            placeholder="e.g. 2000"
            min="0"
          />
        </div>
      </div>

      {/* Notes */}
      <div>
        <label className={labelCls}>Special Considerations & Constraints</label>
        <textarea
          value={goals.notes}
          onChange={e => setGoals(g => ({ ...g, notes: e.target.value }))}
          className={`${inputCls} min-h-[72px] resize-none`}
          placeholder="e.g. Avoid tobacco and fossil fuel stocks. Concentrated in tech — looking to diversify. Planning a home purchase in 2 years..."
        />
      </div>

      {/* Profile summary chips */}
      <div className="flex flex-wrap gap-2 pt-1">
        {[
          { label: goals.riskTolerance, color: goals.riskTolerance === "Conservative" ? "text-blue-400 bg-blue-500/10 border-blue-500/20" : goals.riskTolerance === "Aggressive" || goals.riskTolerance === "Very Aggressive" ? "text-orange-400 bg-orange-500/10 border-orange-500/20" : "text-green-400 bg-green-500/10 border-green-500/20" },
          { label: goals.objective, color: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20" },
          { label: goals.timeHorizon, color: "text-purple-400 bg-purple-500/10 border-purple-500/20" },
          ...(goals.targetReturn ? [{ label: `${goals.targetReturn}% target`, color: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20" }] : []),
        ].map((chip, i) => (
          <span key={i} className={`text-xs px-2.5 py-1 rounded-full border font-medium ${chip.color}`}>
            {chip.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   MAIN COMPONENT
───────────────────────────────────────────────────────────── */
export default function AdvisorChat() {
  const canWrite = useCanWrite("advisor");

  const [goals, setGoals] = useState(() => {
    try { return { ...defaultGoals(), ...JSON.parse(localStorage.getItem(GOALS_KEY) || "{}") }; }
    catch { return defaultGoals(); }
  });
  const [profileSaved, setProfileSaved] = useState(false);
  const [showProfile, setShowProfile] = useState(false);

  // Close the profile panel if permissions drop to read-only after an account switch.
  useEffect(() => {
    if (!canWrite) setShowProfile(false);
  }, [canWrite]);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const saveProfile = useCallback(() => {
    localStorage.setItem(GOALS_KEY, JSON.stringify(goals));
    setProfileSaved(true);
    setTimeout(() => {
      setProfileSaved(false);
      setShowProfile(false);
    }, 800);
  }, [goals]);

  const sendMessage = useCallback(async (text) => {
    const msg = (text || input).trim();
    if (!msg || loading) return;

    setInput("");
    setError("");
    const userMsg = { role: "user", content: msg };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      // Only send the last 10 messages as history to keep context manageable
      const history = messages.slice(-10);
      const { reply } = await api.post("/advisor/chat", {
        message: msg,
        history,
        goals,
      });
      setMessages(prev => [...prev, { role: "assistant", content: reply }]);
    } catch (e) {
      setError(e?.message || "Failed to get a response. Please try again.");
      setMessages(prev => prev.slice(0, -1)); // remove the user message on error
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [input, loading, messages, goals]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages([]);
    setError("");
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="flex flex-col gap-5 h-full">

      {/* ── Header ───────────────────────────────────────────── */}
      <PageHeader title="Compass" icon={PageIcons.compass}>
        {canWrite && (
          <button
            type="button"
            onClick={() => setShowProfile(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${
              showProfile
                ? "bg-blue-600/20 border-blue-500/30 text-blue-400"
                : "border-white/10 text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]"
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Investment Profile
          </button>
        )}
        {messages.length > 0 && (
          <button
            type="button"
            onClick={clearChat}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/10 text-slate-500 hover:text-slate-300 hover:bg-white/[0.05] text-xs font-semibold transition-all cursor-pointer"
          >
            New Chat
          </button>
        )}
      </PageHeader>

      {/* ── Investment Profile Panel ─────────────────────────── */}
      {showProfile && (
        <GoalsPanel
          goals={goals}
          setGoals={setGoals}
          onSave={saveProfile}
          saved={profileSaved}
        />
      )}

      {/* ── Chat Area ────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 rounded-2xl border border-white/[0.06] bg-[#0F1729] overflow-hidden min-h-[500px]">

        {/* Message list */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {isEmpty && !loading && (
            <div className="flex flex-col items-center justify-center h-full py-12 text-center">
              {/* Compass icon */}
              <div className="w-16 h-16 rounded-2xl bg-blue-600/10 border border-blue-500/20 flex items-center justify-center mb-4">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-8 h-8 text-blue-400">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 20.25l.879-2.636A4.502 4.502 0 0112 17.25c.865 0 1.676.244 2.371.664" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1.5M12 3a9 9 0 100 18A9 9 0 0012 3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.243 7.757l-2.829 4.95-4.95 2.829 2.829-4.95 4.95-2.829z" />
                </svg>
              </div>
              <h3 className="text-base font-bold text-white mb-1" style={{ fontFamily: "Epilogue, sans-serif" }}>
                Your AI Financial Advisor
              </h3>
              <p className="text-sm text-slate-500 max-w-md mb-6">
                Ask anything about your portfolio, market conditions, investment strategies, or financial planning.
                Every response is tailored to your profile and real holdings.
              </p>

              {/* Profile chips */}
              <div className="flex flex-wrap gap-2 justify-center mb-8">
                {[goals.riskTolerance, goals.objective, goals.timeHorizon].map((v, i) => (
                  <span key={i} className="text-xs px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.04] text-slate-400 font-medium">
                    {v}
                  </span>
                ))}
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => setShowProfile(true)}
                    className="text-xs px-3 py-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 text-blue-400 font-medium cursor-pointer hover:bg-blue-500/20 transition-colors"
                  >
                    Edit Profile →
                  </button>
                )}
              </div>

              {/* Suggested prompts */}
              <div className="w-full max-w-2xl">
                <p className="text-xs text-slate-600 mb-3 font-semibold uppercase tracking-wide">Suggested questions</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {SUGGESTED_PROMPTS.map((prompt, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => sendMessage(prompt)}
                      className="text-left text-xs text-slate-400 px-3.5 py-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.06] hover:text-slate-200 hover:border-white/[0.10] transition-all cursor-pointer"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <MessageBubble key={i} msg={msg} />
          ))}

          {loading && <TypingIndicator />}

          {error && (
            <div className="flex justify-center">
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5 max-w-sm text-center">
                {error}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div className="border-t border-white/[0.06] p-4">
          <div className="flex gap-3 items-end">
            <div className="flex-1 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about your portfolio, market trends, strategy recommendations…"
                disabled={loading}
                rows={1}
                className="w-full bg-[#080D1A] border border-white/[0.08] rounded-xl px-4 py-3 text-slate-200 text-sm outline-none focus:border-blue-500/40 transition-colors resize-none leading-relaxed disabled:opacity-50 pr-12"
                style={{ minHeight: "46px", maxHeight: "160px", overflowY: "auto" }}
                onInput={e => {
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
                }}
              />
            </div>
            <button
              type="button"
              onClick={() => sendMessage()}
              disabled={loading || !input.trim()}
              className="w-11 h-11 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center shrink-0 transition-all cursor-pointer"
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
          <p className="text-[11px] text-slate-700 mt-2 text-center">
            Press Enter to send · Shift+Enter for new line · Responses include live portfolio context
          </p>
        </div>
      </div>
    </div>
  );
}
