import { useState, useRef, useEffect, useCallback } from "react";
import { api } from "../api/client.js";
import { PageHeader } from "../components/ui/PageHeader.jsx";
import { PageIcons } from "../components/ui/PageIcons.jsx";
import { useCanWrite } from "../hooks/useCanWrite.js";

/* ─────────────────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────────────────── */
const GOALS_KEY = "finvault.advisorGoals";
const CACHE_PREFIX = "compass.cache.";

const SUGGESTED_PROMPTS = [
  "Plan a cash-secured put on TSLA for this week — show full trade plan.",
  "Review my open options positions and flag any that need attention.",
  "Analyze the chart I've attached and suggest a Micro Futures trade setup.",
  "Am I at risk of hitting my weekly loss limit? Show the math.",
  "Which open position should I close first to free up margin?",
  "Suggest a covered call on my largest stock position.",
];

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
const inputCls  = "bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2 text-slate-200 text-sm w-full outline-none focus:border-blue-500/40 transition-colors";
const selectCls = "bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2 text-slate-200 text-sm w-full outline-none focus:border-blue-500/40 transition-colors";
const labelCls  = "text-xs font-semibold text-slate-500 mb-1.5 block";

/* ─────────────────────────────────────────────────────────────
   SESSION STORAGE HELPERS (for reply cache)
───────────────────────────────────────────────────────────── */
function cacheStore(cacheKey, reply) {
  try { sessionStorage.setItem(CACHE_PREFIX + cacheKey, reply); } catch { /* quota — ignore */ }
}
function cacheRead(cacheKey) {
  try { return sessionStorage.getItem(CACHE_PREFIX + cacheKey) || null; } catch { return null; }
}

/* ─────────────────────────────────────────────────────────────
   IMAGE UTILITIES
   Images are compressed to JPEG (max 1440px, 85% quality) before
   sending. This keeps payloads well under the Lambda 6MB limit and
   ensures Claude receives clean, readable chart images.
───────────────────────────────────────────────────────────── */
const MAX_DIM     = 1440;
const JPEG_QUALITY = 0.85;

function compressToBase64(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      let { naturalWidth: w, naturalHeight: h } = img;

      // Scale down if either dimension exceeds MAX_DIM
      if (w > MAX_DIM || h > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }

      const canvas = document.createElement("canvas");
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas 2D context unavailable")); return; }
      ctx.drawImage(img, 0, 0, w, h);

      const dataUrl   = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      const commaIdx  = dataUrl.indexOf(",");
      const data      = dataUrl.slice(commaIdx + 1);

      if (!data) { reject(new Error("Canvas produced empty data URL")); return; }
      resolve({ media_type: "image/jpeg", data, width: w, height: h });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not load image: ${file.name || "clipboard"}`));
    };

    img.src = url;
  });
}

/* PendingIndicator — same bouncing dots as TypingIndicator */
function PendingIndicator() {
  return <TypingIndicator />;
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
   IFRAME AUTO HEIGHT
   Uses ResizeObserver on the iframe's inner document body so the
   iframe grows as the full HTML content renders, rather than
   taking a single height snapshot at onLoad time.
───────────────────────────────────────────────────────────── */
function IframeAutoHeight({ srcDoc, onError }) {
  const ref = useRef(null);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;

    let observer = null;

    function attach() {
      try {
        const doc = iframe.contentDocument;
        if (!doc || !doc.body) return;

        // Set initial height
        iframe.style.height = doc.documentElement.scrollHeight + "px";

        // Watch for content height changes (e.g. images loading inside)
        observer = new ResizeObserver(() => {
          try {
            iframe.style.height = doc.documentElement.scrollHeight + "px";
          } catch { /* cross-origin guard */ }
        });
        observer.observe(doc.body);
      } catch {
        onError?.();
      }
    }

    iframe.addEventListener("load", attach);
    return () => {
      iframe.removeEventListener("load", attach);
      observer?.disconnect();
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={ref}
      srcDoc={srcDoc}
      sandbox="allow-same-origin"
      className="w-full rounded-xl border border-white/[0.06] bg-[#0A0F1E]"
      style={{ minHeight: "120px", height: "120px", display: "block" }}
      onError={onError}
    />
  );
}

/* ─────────────────────────────────────────────────────────────
   MESSAGE BUBBLE
   User messages: plain text. Assistant messages: HTML in iframe.
───────────────────────────────────────────────────────────── */
function AssistantBubble({ content, cacheKey }) {
  const [renderErr, setRenderErr] = useState(false);
  const [retrying,  setRetrying]  = useState(false);
  const [html,      setHtml]      = useState(content);

  const iframeSrc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #0A0F1E;
    color: #e2e8f0;
    font-size: 13px;
    line-height: 1.6;
    padding: 16px;
  }
  pre, code { font-family: 'Courier New', monospace; font-size: 12px; }
  a { color: #60a5fa; }
</style>
</head>
<body>${html}</body>
</html>`;

  async function retryFromCache() {
    setRetrying(true);
    setRenderErr(false);
    // Try sessionStorage first
    const stored = cacheRead(cacheKey);
    if (stored) {
      setHtml(stored);
      setRetrying(false);
      return;
    }
    // Fall back to DDB via API
    try {
      const res = await api.get(`/advisor/cache/${cacheKey}`, { accountId: null });
      if (res.reply) {
        cacheStore(cacheKey, res.reply);
        setHtml(res.reply);
      } else {
        setRenderErr(true);
      }
    } catch {
      setRenderErr(true);
    }
    setRetrying(false);
  }

  return (
    <div className="flex gap-3 justify-start">
      <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center shrink-0 mt-0.5">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-white">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
      </div>
      <div className="flex-1 max-w-[88%]">
        {renderErr ? (
          <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
            <p className="font-semibold mb-1">Render error</p>
            <p className="text-xs mb-3 text-red-300/80">The response was received but could not be displayed.</p>
            {cacheKey && (
              <button
                type="button"
                onClick={retryFromCache}
                disabled={retrying}
                className="text-xs px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 font-semibold transition-colors disabled:opacity-50 cursor-pointer"
              >
                {retrying ? "Retrieving…" : "Retry render"}
              </button>
            )}
          </div>
        ) : (
          <IframeAutoHeight
            srcDoc={iframeSrc}
            onError={() => setRenderErr(true)}
          />
        )}
      </div>
    </div>
  );
}

function UserBubble({ content, attachments = [] }) {
  return (
    <div className="flex gap-3 justify-end">
      <div className="max-w-[80%] space-y-2">
        {attachments.length > 0 && (
          <div className="flex gap-2 flex-wrap justify-end">
            {attachments.map((a, i) => (
              <img
                key={i}
                src={`data:${a.media_type};base64,${a.data}`}
                alt="attachment"
                className="h-16 w-16 object-cover rounded-lg border border-white/10"
              />
            ))}
          </div>
        )}
        <div className="bg-blue-600/20 border border-blue-500/20 text-slate-200 rounded-2xl rounded-tr-sm px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
          {content}
        </div>
      </div>
      <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center shrink-0 mt-0.5">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-slate-300">
          <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   ATTACHMENT PREVIEW STRIP
───────────────────────────────────────────────────────────── */
function AttachmentStrip({ attachments, onRemove }) {
  if (!attachments.length) return null;
  return (
    <div className="flex gap-2 flex-wrap px-4 pt-3">
      {attachments.map((a, i) => {
        const kb = Math.round((a.data.length * 0.75) / 1024); // approx original bytes
        return (
          <div key={i} className="relative group">
            <img
              src={`data:${a.media_type};base64,${a.data}`}
              alt={`attachment ${i + 1}`}
              className="h-14 w-14 object-cover rounded-lg border border-white/10"
            />
            {/* size badge — confirms image is real data, not empty */}
            <span className="absolute bottom-0.5 left-0.5 text-[9px] bg-black/70 text-white/70 px-1 rounded">
              {kb > 999 ? `${(kb / 1024).toFixed(1)}MB` : `${kb}KB`}
            </span>
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-slate-700 border border-white/20 text-slate-300 hover:bg-red-600 hover:text-white text-[10px] font-bold flex items-center justify-center transition-colors cursor-pointer"
            >
              ×
            </button>
          </div>
        );
      })}
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
        <div>
          <label className={labelCls}>Risk Tolerance</label>
          <select value={goals.riskTolerance} onChange={e => setGoals(g => ({ ...g, riskTolerance: e.target.value }))} className={selectCls}>
            {RISK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p className="text-[11px] text-slate-600 mt-1">{RISK_OPTIONS.find(o => o.value === goals.riskTolerance)?.desc}</p>
        </div>
        <div>
          <label className={labelCls}>Investment Objective</label>
          <select value={goals.objective} onChange={e => setGoals(g => ({ ...g, objective: e.target.value }))} className={selectCls}>
            {OBJECTIVE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Time Horizon</label>
          <select value={goals.timeHorizon} onChange={e => setGoals(g => ({ ...g, timeHorizon: e.target.value }))} className={selectCls}>
            {HORIZON_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Target Annual Return (%)</label>
          <input type="number" value={goals.targetReturn} onChange={e => setGoals(g => ({ ...g, targetReturn: e.target.value }))} className={inputCls} placeholder="e.g. 15" min="0" max="100" step="0.5" />
        </div>
        <div>
          <label className={labelCls}>Monthly Contribution ($)</label>
          <input type="number" value={goals.monthlyContribution} onChange={e => setGoals(g => ({ ...g, monthlyContribution: e.target.value }))} className={inputCls} placeholder="e.g. 2000" min="0" />
        </div>
      </div>

      <div>
        <label className={labelCls}>Special Considerations & Constraints</label>
        <textarea
          value={goals.notes}
          onChange={e => setGoals(g => ({ ...g, notes: e.target.value }))}
          className={`${inputCls} min-h-[72px] resize-none`}
          placeholder="e.g. Avoid tobacco and fossil fuel stocks. Concentrated in tech — looking to diversify..."
        />
      </div>

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
   MARGIN DATA PANEL (optional — floats above input bar)
───────────────────────────────────────────────────────────── */
function MarginPanel({ marginData, setMarginData, onClose }) {
  const f = (field, val) => setMarginData(m => ({ ...m, [field]: val }));
  return (
    <div className="border-t border-white/[0.06] bg-[#080D1A] px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-slate-400">Margin Data (optional)</span>
        <button type="button" onClick={onClose} className="text-slate-600 hover:text-slate-400 text-xs cursor-pointer">Hide</button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {[
          { key: "totalMargin",  placeholder: "Total margin $" },
          { key: "marginUsed",   placeholder: "Margin used $" },
          { key: "freeCash",     placeholder: "Free cash $" },
          { key: "todayPnl",     placeholder: "Today P&L $" },
          { key: "weekPnl",      placeholder: "Week P&L $" },
        ].map(({ key, placeholder }) => (
          <input
            key={key}
            type="number"
            value={marginData[key] ?? ""}
            onChange={e => f(key, e.target.value === "" ? undefined : Number(e.target.value))}
            placeholder={placeholder}
            className="bg-[#0F1729] border border-white/[0.08] rounded-lg px-2 py-1.5 text-slate-200 text-xs outline-none focus:border-blue-500/40 transition-colors"
          />
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
  const [showProfile,  setShowProfile]  = useState(false);
  const [showMargin,   setShowMargin]   = useState(false);
  const [marginData,   setMarginData]   = useState({});

  useEffect(() => { if (!canWrite) setShowProfile(false); }, [canWrite]);

  // messages: { role, content, attachments?, cacheKey? }
  const [messages,    setMessages]    = useState([]);
  const [input,       setInput]       = useState("");
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState("");
  const [attachments, setAttachments] = useState([]); // { media_type, data }[]
  const [pendingJob,  setPendingJob]  = useState(null); // { jobId } while polling

  const bottomRef  = useRef(null);
  const inputRef   = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Poll for async worker result every 3 seconds
  useEffect(() => {
    if (!pendingJob) return;
    let stopped = false;

    const interval = setInterval(async () => {
      try {
        const res = await api.get(`/advisor/cache/${pendingJob.jobId}`, { accountId: null });
        if (stopped) return;
        if (res.reply) {
          cacheStore(pendingJob.jobId, res.reply);
          setMessages(prev => [...prev, { role: "assistant", content: res.reply, cacheKey: pendingJob.jobId }]);
          setPendingJob(null);
          setLoading(false);
        }
      } catch (e) {
        if (stopped) return;
        if (e.status === 404) return; // still pending — keep polling
        // Worker wrote an error or unexpected failure
        const detail = e?.detail || {};
        setError({ message: detail.message || "Trade plan generation failed. Please try again." });
        setPendingJob(null);
        setLoading(false);
        setMessages(prev => prev.slice(0, -1)); // remove the user message
      }
    }, 3000);

    // Timeout after 4 minutes
    const timeout = setTimeout(() => {
      if (stopped) return;
      clearInterval(interval);
      setError({ message: "Trade plan is taking longer than expected. Please try again." });
      setPendingJob(null);
      setLoading(false);
      setMessages(prev => prev.slice(0, -1));
    }, 4 * 60 * 1000);

    return () => {
      stopped = true;
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [pendingJob]);

  const saveProfile = useCallback(() => {
    localStorage.setItem(GOALS_KEY, JSON.stringify(goals));
    setProfileSaved(true);
    setTimeout(() => { setProfileSaved(false); setShowProfile(false); }, 800);
  }, [goals]);

  /* ── Attachment handlers ── */
  const addFiles = useCallback(async (files) => {
    // Accept any image/* type; also accept files with empty type (some clipboard items)
    const filtered = Array.from(files).filter(
      f => f.type.startsWith("image/") || f.type === ""
    );
    if (!filtered.length) return;
    try {
      const converted = await Promise.all(filtered.map(compressToBase64));
      const valid = converted.filter(img => img.data.length > 0);
      if (valid.length) setAttachments(prev => [...prev, ...valid]);
    } catch (err) {
      console.warn("[Compass] Image compression failed:", err.message);
    }
  }, []);

  const handleFileChange = useCallback(e => {
    addFiles(e.target.files);
    e.target.value = "";
  }, [addFiles]);

  const handlePaste = useCallback(e => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter(it => it.type.startsWith("image/")).map(it => it.getAsFile()).filter(Boolean);
    if (imageItems.length) addFiles(imageItems);
  }, [addFiles]);

  const removeAttachment = useCallback(idx => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  }, []);

  /* ── Send message ── */
  const sendMessage = useCallback(async (text) => {
    const msg = (text || input).trim();
    if (!msg || loading) return;

    const imgs = [...attachments];
    setInput("");
    setAttachments([]);
    setError("");

    const userMsg = { role: "user", content: msg, attachments: imgs };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    let async = false;
    try {
      const history = messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
      const hasMargin = Object.values(marginData).some(v => v != null && v !== "");
      const res = await api.post("/advisor/chat", {
        message: msg,
        history,
        images: imgs,
        ...(hasMargin ? { marginData } : {}),
      });

      if (res.status === "pending" && res.jobId) {
        // Worker is running async — keep loading=true, polling will clear it
        async = true;
        setPendingJob({ jobId: res.jobId });
        return;
      }

      // Cache hit — reply returned synchronously
      if (res.cacheKey && res.reply) cacheStore(res.cacheKey, res.reply);
      setMessages(prev => [...prev, { role: "assistant", content: res.reply, cacheKey: res.cacheKey }]);
    } catch (e) {
      const detail = e?.detail || {};
      const stage = detail.stage || "unknown";
      const ck = detail.cacheKey;
      let errMsg = detail.message || e?.message || "Failed to get a response. Please try again.";
      if (stage === "framework_load") errMsg = "Trade framework unavailable — check S3 config.";
      if (stage === "anthropic_call") errMsg = "Claude API error — check the Anthropic API key.";
      if (stage === "portfolio_build") errMsg = "Portfolio data error — could not load your holdings.";
      setError({ message: errMsg, cacheKey: ck });
      setMessages(prev => prev.slice(0, -1));
    } finally {
      if (!async) setLoading(false);
      inputRef.current?.focus();
    }
  }, [input, loading, messages, attachments, marginData]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  /* ── Recover from cached response after error ── */
  async function recoverFromCache(cacheKey) {
    setError("");
    setLoading(true);
    try {
      const stored = cacheRead(cacheKey);
      if (stored) {
        setMessages(prev => [...prev, { role: "assistant", content: stored, cacheKey }]);
        setLoading(false);
        return;
      }
      const res = await api.get(`/advisor/cache/${cacheKey}`, { accountId: null });
      if (res.reply) {
        cacheStore(cacheKey, res.reply);
        setMessages(prev => [...prev, { role: "assistant", content: res.reply, cacheKey }]);
      } else {
        setError({ message: "Cached response expired. Please resend your message." });
      }
    } catch {
      setError({ message: "Could not retrieve cached response. Please resend your message." });
    }
    setLoading(false);
  }

  const clearChat = () => { setMessages([]); setError(""); };

  const isEmpty = messages.length === 0;

  return (
    <div className="flex flex-col gap-5 h-full">

      {/* ── Header ───────────────────────────────────────────── */}
      <PageHeader title="Compass AI" icon={PageIcons.compass}>
        {/* Trade framework badge */}
        <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-green-500/30 bg-green-500/10 text-green-400 text-[11px] font-semibold">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
          </svg>
          TRADE FRAMEWORK ACTIVE
        </span>

        {canWrite && (
          <button
            type="button"
            onClick={() => setShowProfile(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${
              showProfile ? "bg-blue-600/20 border-blue-500/30 text-blue-400" : "border-white/10 text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]"
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Profile
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
        <GoalsPanel goals={goals} setGoals={setGoals} onSave={saveProfile} saved={profileSaved} />
      )}

      {/* ── Chat Area ────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 rounded-2xl border border-white/[0.06] bg-[#0F1729] overflow-hidden min-h-[500px]">

        {/* Message list */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {isEmpty && !loading && (
            <div className="flex flex-col items-center justify-center h-full py-12 text-center">
              <div className="w-16 h-16 rounded-2xl bg-blue-600/10 border border-blue-500/20 flex items-center justify-center mb-4">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-8 h-8 text-blue-400">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3a9 9 0 100 18A9 9 0 0012 3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.243 7.757l-2.829 4.95-4.95 2.829 2.829-4.95 4.95-2.829z" />
                </svg>
              </div>
              <h3 className="text-base font-bold text-white mb-1" style={{ fontFamily: "Epilogue, sans-serif" }}>
                Compass — Trade Plan Advisor
              </h3>
              <p className="text-sm text-slate-500 max-w-md mb-2">
                Powered by your trade framework. Attach a chart image or paste one, then ask for a full trade plan.
              </p>
              <p className="text-xs text-slate-600 max-w-sm mb-6">
                Margin data is optional — add it above the input bar if you want margin-aware recommendations.
              </p>

              <div className="flex flex-wrap gap-2 justify-center mb-8">
                {[goals.riskTolerance, goals.objective, goals.timeHorizon].map((v, i) => (
                  <span key={i} className="text-xs px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.04] text-slate-400 font-medium">{v}</span>
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

              <div className="w-full max-w-2xl">
                <p className="text-xs text-slate-600 mb-3 font-semibold uppercase tracking-wide">Suggested trade plan requests</p>
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

          {messages.map((msg, i) =>
            msg.role === "user"
              ? <UserBubble key={i} content={msg.content} attachments={msg.attachments} />
              : <AssistantBubble key={i} content={msg.content} cacheKey={msg.cacheKey} />
          )}

          {loading && (
            pendingJob
              ? <PendingIndicator />
              : <TypingIndicator />
          )}

          {error && (
            <div className="flex justify-center">
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 max-w-sm text-center space-y-2">
                <p>{typeof error === "string" ? error : error.message}</p>
                {error?.cacheKey && (
                  <button
                    type="button"
                    onClick={() => recoverFromCache(error.cacheKey)}
                    className="text-xs px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 font-semibold transition-colors cursor-pointer"
                  >
                    Retrieve cached response
                  </button>
                )}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Margin data panel (optional) */}
        {showMargin && (
          <MarginPanel
            marginData={marginData}
            setMarginData={setMarginData}
            onClose={() => setShowMargin(false)}
          />
        )}

        {/* Attachment preview */}
        <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />

        {/* Input bar */}
        <div className="border-t border-white/[0.06] p-4">
          <div className="flex gap-2 items-end">

            {/* Paperclip */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              title="Attach chart image"
              className="w-10 h-10 rounded-xl border border-white/10 text-slate-500 hover:text-slate-300 hover:bg-white/[0.05] flex items-center justify-center shrink-0 transition-all disabled:opacity-40 cursor-pointer"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleFileChange}
            />

            {/* Margin toggle */}
            <button
              type="button"
              onClick={() => setShowMargin(v => !v)}
              disabled={loading}
              title="Add margin data"
              className={`w-10 h-10 rounded-xl border text-xs font-bold flex items-center justify-center shrink-0 transition-all disabled:opacity-40 cursor-pointer ${
                showMargin ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-400" : "border-white/10 text-slate-500 hover:text-slate-300 hover:bg-white/[0.05]"
              }`}
            >
              M$
            </button>

            {/* Textarea */}
            <div className="flex-1">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="Ask for a trade plan, attach a chart, or ask about your open positions…"
                disabled={loading}
                rows={1}
                className="w-full bg-[#080D1A] border border-white/[0.08] rounded-xl px-4 py-3 text-slate-200 text-sm outline-none focus:border-blue-500/40 transition-colors resize-none leading-relaxed disabled:opacity-50"
                style={{ minHeight: "46px", maxHeight: "160px", overflowY: "auto" }}
                onInput={e => {
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
                }}
              />
            </div>

            {/* Send */}
            <button
              type="button"
              onClick={() => sendMessage()}
              disabled={loading || (!input.trim() && !attachments.length)}
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
            Enter to send · Shift+Enter for new line · Paste chart images directly · Margin data is optional
          </p>
        </div>
      </div>
    </div>
  );
}
