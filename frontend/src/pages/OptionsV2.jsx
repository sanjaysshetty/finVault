import { useEffect, useMemo, useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { PageHeader } from "../components/ui/PageHeader.jsx";
import { PageIcons } from "../components/ui/PageIcons.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";
import { useCanWrite } from "../hooks/useCanWrite.js";

/* ─────────────────────────────────────────────────────────────
   UTILITIES
───────────────────────────────────────────────────────────── */
function todayISO() { return new Date().toISOString().slice(0, 10); }
function safeNum(v, fallback = 0) { const x = Number(v); return Number.isFinite(x) ? x : fallback; }
function round2(n) { return Math.round(safeNum(n) * 100) / 100; }
function genPosId() { return `pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

const COUNTRY_CURRENCY = { USA: "USD", INDIA: "INR" };
const LOCALE_FOR_CURRENCY = { USD: "en-US", INR: "en-IN" };

function fmtMoney(n, cur = "USD") {
  const locale = LOCALE_FOR_CURRENCY[cur] ?? "en-US";
  return safeNum(n, 0).toLocaleString(locale, { style: "currency", currency: cur, minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtMoneyFull(n, cur = "USD") {
  const locale = LOCALE_FOR_CURRENCY[cur] ?? "en-US";
  return safeNum(n, 0).toLocaleString(locale, { style: "currency", currency: cur });
}
function fmtPct(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return `${Number(n) >= 0 ? "+" : ""}${Number(n).toFixed(2)}%`;
}
function plClass(v) { return safeNum(v, 0) >= 0 ? "text-green-400" : "text-red-400"; }

function parseISODate(d) {
  if (!d) return null;
  const dt = new Date(`${d}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}
function daysBetween(a, b) {
  const da = parseISODate(a), db = parseISODate(b);
  if (!da || !db) return null;
  const d = Math.floor((db - da) / 86_400_000);
  return d < 1 ? 1 : d;
}
function daysUntil(expiryISO) {
  const e = parseISODate(expiryISO);
  if (!e) return null;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.floor((e - now) / 86_400_000);
}
function calcAutoCollateral(strike, qty) {
  const s = Number(strike), q = Number(qty);
  if (!Number.isFinite(s) || !Number.isFinite(q) || q <= 0 || s <= 0) return 0;
  return round2(s * q * 100);
}
function inRange(dateISO, from, to) {
  if (!dateISO) return false;
  if (from && dateISO < from) return false;
  if (to && dateISO > to) return false;
  return true;
}
function markKey(r) {
  return `${r.ticker}_${r.strikes}_${r.expiry}_${String(r.event || "").toLowerCase()}`;
}

/* ─────────────────────────────────────────────────────────────
   DOMAIN — normalize / group / status / metrics
───────────────────────────────────────────────────────────── */
function normalizeRow(it) {
  const id = it.txId || it.assetId || it.id;
  return {
    ...it,
    id,
    ticker: String(it.ticker || "").toUpperCase(),
    type: String(it.type || "SELL").toUpperCase(),
    leg: String(it.leg || "OPEN").toUpperCase(),
    positionId: String(it.positionId || id), // legacy: own id as positionId
    event: String(it.event || "").toLowerCase(),
    country: String(it.country || "USA").toUpperCase(),
  };
}

function isLegacyClosed(r) {
  // A legacy single-row that has both fill and closePrice set
  const cp = r.closePrice;
  return cp !== "" && cp !== null && cp !== undefined && Number.isFinite(Number(cp));
}

function positionStatus(legs) {
  const OPEN_LEGS = new Set(["OPEN", "ROLL_OPEN"]);
  const CLOSE_LEGS = new Set(["CLOSE", "ROLL_CLOSE"]);

  const openLeg = legs.find(l => OPEN_LEGS.has(l.leg));
  const closeLeg = legs.find(l => CLOSE_LEGS.has(l.leg));

  // Legacy single-row handling
  if (legs.length === 1 && !legs[0].positionId?.startsWith("pos_")) {
    const r = legs[0];
    if (isLegacyClosed(r)) {
      return safeNum(r.closePrice, 0) > 0 ? "CLOSED" : "EXPIRED";
    }
    const dte = daysUntil(r.expiry);
    if (dte !== null && dte < 0) return "EXPIRED";
    return "OPEN";
  }

  if (closeLeg) {
    if (closeLeg.leg === "ROLL_CLOSE") return "ROLLED";
    // fill > 0 means bought/sold back at a price → CLOSED; fill = 0 → expired worthless
    return safeNum(closeLeg.fill, 0) > 0 ? "CLOSED" : "EXPIRED";
  }
  if (openLeg) {
    const dte = daysUntil(openLeg.expiry);
    if (dte !== null && dte < 0) return "EXPIRED";
    return "OPEN";
  }
  return "OPEN";
}

function calcPositionMetrics(legs, marks) {
  const OPEN_LEGS = new Set(["OPEN", "ROLL_OPEN"]);
  const CLOSE_LEGS = new Set(["CLOSE", "ROLL_CLOSE"]);

  const openLeg = legs.find(l => OPEN_LEGS.has(l.leg)) || legs[0];
  const closeLeg = legs.find(l => CLOSE_LEGS.has(l.leg));
  const isLegacy = legs.length === 1 && !legs[0].positionId?.startsWith("pos_");

  const openType = String(openLeg?.type || "SELL").toUpperCase();
  const openFill = safeNum(openLeg?.fill, 0);
  const openQty  = safeNum(openLeg?.qty, 0);
  const openFee  = safeNum(openLeg?.fee, 0);
  const collateral = safeNum(
    openLeg?.collateral || openLeg?.coll ||
    calcAutoCollateral(openLeg?.strikes, openLeg?.qty), 0
  );

  // Net premium at open (positive = credit, negative = debit)
  let netPremium = 0;
  if (openType === "SELL") netPremium = openFill * openQty * 100 - openFee;
  else if (openType === "BUY") netPremium = -(openFill * openQty * 100) - openFee;

  // Realized P/L
  let realizedPL = null;
  let closeDate  = null;

  if (isLegacy && isLegacyClosed(legs[0])) {
    const r = legs[0];
    const closeFill = safeNum(r.closePrice, 0);
    const fee = safeNum(r.fee, 0);
    closeDate = r.closeDate || todayISO();
    // Match Options.jsx formula: (fill - close - fee/100) * qty * 100 = P/L - fee*qty
    // fee is stored as per-contract, so total fee deduction = fee * qty
    if (openType === "SELL") realizedPL = (openFill - closeFill) * openQty * 100 - fee * openQty;
    else if (openType === "BUY") realizedPL = (closeFill - openFill) * openQty * 100 - fee * openQty;
    else if (openType === "ASS") realizedPL = (closeFill - openFill) * openQty * 100 - fee * openQty;
    // For legacy, netPremium = realized
    netPremium = realizedPL ?? netPremium;
  } else if (closeLeg) {
    const closeFill = safeNum(closeLeg.fill || closeLeg.closePrice, 0);
    const closeQty  = safeNum(closeLeg.qty || openQty, 0);
    const closeFee  = safeNum(closeLeg.fee, 0);
    closeDate = closeLeg.openDate || closeLeg.closeDate; // CLOSE leg stores its date in openDate
    if (openType === "SELL") realizedPL = (openFill - closeFill) * closeQty * 100 - openFee - closeFee;
    else if (openType === "BUY") realizedPL = (closeFill - openFill) * closeQty * 100 - openFee - closeFee;
    // Adjust netPremium to reflect net after close
    if (openType === "SELL") netPremium = openFill * openQty * 100 - closeFill * closeQty * 100 - openFee - closeFee;
    else netPremium = closeFill * closeQty * 100 - openFill * openQty * 100 - openFee - closeFee;
  }

  const openDate = openLeg?.openDate || null;
  const days = closeDate ? daysBetween(openDate, closeDate) : null;

  // Use stored roc if present on closeLeg, otherwise calculate
  let roc = null;
  if (closeLeg?.roc !== undefined && closeLeg?.roc !== null && closeLeg?.roc !== "" && Number.isFinite(Number(closeLeg.roc))) {
    roc = Number(closeLeg.roc);
  } else if (isLegacy && legs[0]?.roc !== undefined && Number.isFinite(Number(legs[0].roc))) {
    roc = Number(legs[0].roc);
  } else if (realizedPL !== null && collateral > 0) {
    roc = round2((realizedPL / collateral) * 100);
  }

  const annRoc = roc !== null && days ? round2((roc / 100 / days) * 365 * 100) : null;

  // Unrealized P/L (open positions only, with mark prices)
  let unrealizedPL = null;
  if (!closeLeg && !(isLegacy && isLegacyClosed(legs[0]))) {
    const mark = marks?.[markKey(openLeg)];
    if (mark !== null && mark !== undefined && Number.isFinite(Number(mark))) {
      const m = Number(mark);
      if (openType === "SELL") unrealizedPL = (openFill - m) * openQty * 100;
      else if (openType === "BUY") unrealizedPL = (m - openFill) * openQty * 100;
    }
  }

  return { netPremium, realizedPL, unrealizedPL, collateral, roc, annRoc, days, openDate, closeDate };
}

function groupPositions(rows) {
  const map = {};
  for (const r of rows) {
    const pid = r.positionId;
    if (!map[pid]) map[pid] = [];
    map[pid].push(r);
  }
  return Object.values(map).map(legs => {
    legs.sort((a, b) => String(a.openDate || "").localeCompare(String(b.openDate || "")));
    const OPEN_LEGS = new Set(["OPEN", "ROLL_OPEN"]);
    const openLeg = legs.find(l => OPEN_LEGS.has(l.leg)) || legs[0];
    const status  = positionStatus(legs);
    return { positionId: legs[0].positionId, legs, openLeg, status };
  });
}

/* ─────────────────────────────────────────────────────────────
   FORM DEFAULTS
───────────────────────────────────────────────────────────── */
function blankOpenDraft(country = "USA") {
  return { ticker: "SPY", event: "put", type: "SELL", strikes: "", expiry: "", openDate: todayISO(), qty: "", fill: "", fee: "", collateral: "", notes: "", country };
}

function blankCloseDraft(pos) {
  const o = pos?.openLeg;
  return {
    ticker: o?.ticker || "", event: o?.event || "", strikes: o?.strikes || "",
    expiry: o?.expiry || "", qty: safeNum(o?.qty, ""),
    fill: "", fee: "", closeDate: todayISO(),
    positionId: pos?.positionId || "",
    openFill: safeNum(o?.fill, 0), openFee: safeNum(o?.fee, 0),
    openQty: safeNum(o?.qty, 0), openType: String(o?.type || "SELL").toUpperCase(),
    collateral: safeNum(o?.collateral || o?.coll || calcAutoCollateral(o?.strikes, o?.qty), 0),
    country: o?.country || "USA", openId: o?.id || "",
    openDate: o?.openDate || "",
  };
}

function blankRollDraft(pos) {
  const o = pos?.openLeg;
  return {
    // Step 1
    closeFill: "", closeFee: "", closeDate: todayISO(),
    // Step 2
    newStrikes: "", newExpiry: "", newFill: "", newFee: "", newQty: safeNum(o?.qty, ""),
    // Carry forward
    ticker: o?.ticker || "", event: o?.event || "",
    strikes: o?.strikes || "", expiry: o?.expiry || "",
    openFill: safeNum(o?.fill, 0), openFee: safeNum(o?.fee, 0),
    openQty: safeNum(o?.qty, 0), openType: String(o?.type || "SELL").toUpperCase(),
    collateral: safeNum(o?.collateral || o?.coll || calcAutoCollateral(o?.strikes, o?.qty), 0),
    positionId: pos?.positionId || "", country: o?.country || "USA",
  };
}

/* ─────────────────────────────────────────────────────────────
   STYLE CONSTANTS
───────────────────────────────────────────────────────────── */
const inputCls  = "bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2 text-slate-200 text-sm w-full outline-none focus:border-blue-500/40 transition-colors";
const labelCls  = "text-xs font-bold text-slate-500 mb-1.5 block";
const btnPrimary   = "flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer";
const btnSecondary = "flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-slate-400 hover:text-slate-200 hover:bg-white/[0.05] text-xs font-medium transition-all disabled:opacity-50 cursor-pointer";
const btnDanger    = "flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-500/20 text-red-400 hover:bg-red-500/10 text-xs font-medium transition-all disabled:opacity-50 cursor-pointer";

const STATUS_CLS = {
  OPEN:    "bg-green-500/15 text-green-400 border border-green-500/20",
  CLOSED:  "bg-slate-700/50 text-slate-400 border border-white/10",
  EXPIRED: "bg-orange-500/15 text-orange-400 border border-orange-500/20",
  ROLLED:  "bg-cyan-500/15 text-cyan-400 border border-cyan-500/20",
};

const LEG_CLS = {
  OPEN:       "bg-blue-500/15 text-blue-400",
  CLOSE:      "bg-slate-600/40 text-slate-400",
  ROLL_OPEN:  "bg-cyan-500/15 text-cyan-400",
  ROLL_CLOSE: "bg-amber-500/15 text-amber-400",
};

/* ─────────────────────────────────────────────────────────────
   SMALL COMPONENTS
───────────────────────────────────────────────────────────── */
function Field({ label, children }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  );
}

function Modal({ title, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.72)" }}>
      <div className={`bg-[#0F1729] border border-white/[0.08] rounded-2xl w-full shadow-2xl max-h-[90vh] flex flex-col ${wide ? "max-w-xl" : "max-w-lg"}`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06] shrink-0">
          <h3 className="text-base font-bold text-white" style={{ fontFamily: "Epilogue, sans-serif" }}>{title}</h3>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1 rounded-lg hover:bg-white/[0.05] cursor-pointer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-3">{children}</div>
      </div>
    </div>
  );
}

function PnlPreviewBox({ pl, roc, annRoc, collateral, currency }) {
  if (pl === null || !Number.isFinite(pl)) return null;
  const positive = pl >= 0;
  return (
    <div className={`p-3 rounded-xl border text-sm ${positive ? "bg-green-500/10 border-green-500/20" : "bg-red-500/10 border-red-500/20"}`}>
      <div className="flex justify-between">
        <span className="text-slate-400">Realized P&amp;L</span>
        <span className={`font-bold ${plClass(pl)}`} style={{ fontFamily: "Epilogue, sans-serif" }}>
          {fmtMoneyFull(pl, currency)}
        </span>
      </div>
      {collateral != null && Number.isFinite(collateral) && collateral > 0 && (
        <div className="flex justify-between mt-1">
          <span className="text-slate-400">Collateral</span>
          <span className="text-slate-300 font-medium">{fmtMoneyFull(collateral, currency)}</span>
        </div>
      )}
      {roc !== null && Number.isFinite(roc) && (
        <div className="flex justify-between mt-1">
          <span className="text-slate-400">ROC</span>
          <span className={`font-semibold ${plClass(roc)}`}>{fmtPct(roc)}</span>
        </div>
      )}
      {annRoc !== null && Number.isFinite(annRoc) && (
        <div className="flex justify-between mt-1">
          <span className="text-slate-400">Ann. ROC</span>
          <span className={`font-semibold ${plClass(annRoc)}`}>{fmtPct(annRoc)}</span>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   POSITION ROW — one <tr> per position, used inside a shared
   <table> so every column aligns across all rows
───────────────────────────────────────────────────────────── */
function PositionRow({ pos, metrics, formatMoney, canWrite, onClose, onRoll, onDelete }) {
  const { openLeg, status, legs } = pos;
  const isOpen   = status === "OPEN";
  const optType  = String(openLeg?.event || "").toUpperCase();
  const dte      = daysUntil(openLeg?.expiry);

  const CLOSE_LEGS = new Set(["CLOSE", "ROLL_CLOSE"]);
  const closeLeg   = legs.find(l => CLOSE_LEGS.has(l.leg));
  const legacyClosed = legs.length === 1 && isLegacyClosed(legs[0]);

  const closeFill = closeLeg
    ? (closeLeg.fill ?? closeLeg.closePrice)
    : legacyClosed ? legs[0].closePrice : null;
  const closeDate = closeLeg
    ? (closeLeg.openDate || "—")
    : legacyClosed ? (legs[0].closeDate || "—") : "—";

  const plValue = metrics.realizedPL !== null ? metrics.realizedPL : metrics.unrealizedPL;
  const isUnrealized = metrics.realizedPL === null;

  // Table display: cap at 2 decimals, strip trailing zeros
  const fmt2 = (v) => {
    const n = Number(v);
    return (v != null && v !== "" && Number.isFinite(n)) ? parseFloat(n.toFixed(2)).toString() : null;
  };
  const fv  = (v) => { const s = fmt2(v); return s != null ? `$${s}` : "—"; };
  const fvn = (v) => fmt2(v) ?? "—"; // no $ prefix (for qty, strike)

  const tdBase  = "px-3 py-2 whitespace-nowrap";
  const tdRight = `${tdBase} text-right`;

  return (
    <tr className={`border-t border-white/[0.05] hover:bg-white/[0.02] transition-colors ${!isOpen ? "opacity-80" : ""}`}>

      {/* Ticker */}
      <td className={`${tdBase} font-bold text-white text-base`} style={{ fontFamily: "Epilogue, sans-serif" }}>
        {openLeg?.ticker}
      </td>

      {/* Strike */}
      <td className={`${tdBase} text-slate-200 text-base font-semibold`}>
        {fvn(openLeg?.strikes)}
      </td>

      {/* Type badge */}
      <td className={tdBase}>
        {optType && (
          <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${optType === "PUT" ? "bg-red-500/15 text-red-400" : "bg-green-500/15 text-green-400"}`}>
            {optType}
          </span>
        )}
      </td>

      {/* Status badge */}
      <td className={tdBase}>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_CLS[status] || STATUS_CLS.OPEN}`}>
          {status}
        </span>
      </td>

      {/* DTE / Held */}
      <td className={tdRight}>
        {isOpen && dte !== null ? (
          <span className={`text-sm font-semibold ${dte < 7 ? "text-orange-400" : dte < 21 ? "text-amber-400" : "text-slate-300"}`}>
            {dte}d
          </span>
        ) : metrics.days != null ? (
          <span className="text-sm text-slate-500">{metrics.days}d</span>
        ) : (
          <span className="text-slate-600">—</span>
        )}
      </td>

      {/* Open Date */}
      <td className={`${tdBase} text-sm text-slate-400`}>{openLeg?.openDate || "—"}</td>

      {/* Expiry */}
      <td className={`${tdBase} text-sm text-slate-400`}>{openLeg?.expiry || "—"}</td>

      {/* Qty */}
      <td className={`${tdRight} text-sm text-slate-300`}>{fvn(openLeg?.qty)}</td>

      {/* Fill */}
      <td className={`${tdRight} text-sm text-slate-300`}>{fv(openLeg?.fill)}</td>

      {/* Close Fill */}
      <td className={`${tdRight} text-sm text-slate-300`}>{fv(closeFill)}</td>

      {/* Close Date */}
      <td className={`${tdBase} text-sm text-slate-400`}>{closeDate}</td>

      {/* Net Premium */}
      <td className={tdRight}>
        <span className={`text-base font-bold ${plClass(metrics.netPremium)}`} style={{ fontFamily: "Epilogue, sans-serif" }}>
          {formatMoney(metrics.netPremium)}
        </span>
      </td>

      {/* P/L */}
      <td className={tdRight}>
        <span className={`text-base font-bold ${plValue === null ? "text-slate-500" : plClass(plValue)}`} style={{ fontFamily: "Epilogue, sans-serif" }}>
          {plValue === null ? "—" : formatMoney(plValue)}
        </span>
      </td>

      {/* ROC — always show annualized */}
      <td className={tdRight}>
        <span className={`text-base font-bold ${metrics.annRoc === null ? "text-slate-500" : plClass(metrics.annRoc)}`} style={{ fontFamily: "Epilogue, sans-serif" }}>
          {metrics.annRoc === null ? "—" : fmtPct(metrics.annRoc)}
        </span>
      </td>

      {/* Actions */}
      <td className={`${tdBase} text-right`}>
        <div className="flex items-center gap-1 justify-end">
          {canWrite && isOpen && (
            <>
              <button type="button" onClick={() => onClose(pos)} className={btnSecondary}>Close</button>
              <button type="button" onClick={() => onRoll(pos)} className={`${btnSecondary} !text-cyan-400 !border-cyan-500/20`}>Roll</button>
            </>
          )}
          {canWrite && (
            <button type="button" onClick={() => onDelete(pos)} className={btnDanger} title="Delete">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </td>

    </tr>
  );
}

/* ─────────────────────────────────────────────────────────────
   MAIN COMPONENT
───────────────────────────────────────────────────────────── */
export default function OptionsV2() {
  const canWrite = useCanWrite("options");

  const [country, setCountry] = useState("USA");
  const currency = COUNTRY_CURRENCY[country] ?? "USD";
  const formatMoney = useCallback((n) => fmtMoney(n, currency), [currency]);

  // (Transactions tab removed — position cards already show all legs in the expand section)
  const [openModal, setOpenModal]   = useState(null); // "open" | "close" | "roll"
  const [rollStep, setRollStep]     = useState(1);
  const [error, setError]           = useState("");
  const [busy, setBusy]             = useState(false);

  // Filters
  const [fromDate, setFromDate]         = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d.toISOString().slice(0, 10); });
  const [toDate, setToDate]             = useState(todayISO);
  const [tickerFilter, setTickerFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Form drafts
  const [openDraft, setOpenDraft]     = useState(() => blankOpenDraft());
  const [closeDraft, setCloseDraft]   = useState(null);
  const [rollDraft, setRollDraft]     = useState(null);
  const [deleteDraft, setDeleteDraft] = useState(null);

  // Live marks
  const [marks, setMarks] = useState({});

  // Sync country → open draft
  useEffect(() => { setOpenDraft(d => ({ ...d, country })); }, [country]);

  const queryClient = useQueryClient();

  /* ── Data ─────────────────────────────────────────────── */
  const { data: rawData, isLoading } = useQuery({
    queryKey: queryKeys.optionsTx(),
    queryFn: () => api.get("/assets/options/transactions"),
  });

  const rows = useMemo(() => {
    const items = Array.isArray(rawData?.items) ? rawData.items : Array.isArray(rawData) ? rawData : [];
    return items
      .map(normalizeRow)
      .filter(r => r.country === country);
  }, [rawData, country]);

  /* ── Live marks ─────────────────────────────────────────── */
  useEffect(() => {
    if (!rows.length) return;
    const OPEN_LEGS = new Set(["OPEN", "ROLL_OPEN"]);
    const positions = rows
      .filter(r => {
        const isOpen = OPEN_LEGS.has(r.leg) && (!r.closeDate || String(r.closeDate).trim() === "");
        const evt = String(r.event || "").toLowerCase();
        return isOpen && r.ticker && r.strikes && r.expiry && (evt === "call" || evt === "put");
      })
      .map(r => ({
        key: markKey(r),
        ticker: r.ticker, strike: Number(r.strikes), expiry: r.expiry,
        optionType: String(r.event || "").toLowerCase(),
      }));
    if (!positions.length) return;
    api.post("/assets/options/marks", { positions })
      .then(data => setMarks(data.marks || {}))
      .catch(() => {});
  }, [rows]);

  /* ── Group into positions ────────────────────────────────── */
  const allPositions = useMemo(() => groupPositions(rows), [rows]);

  /* ── Metrics per position ────────────────────────────────── */
  const positionsWithMetrics = useMemo(() =>
    allPositions.map(pos => ({ ...pos, metrics: calcPositionMetrics(pos.legs, marks) })),
    [allPositions, marks]
  );

  /* ── Filtered + sorted positions ─────────────────────────── */
  const filteredPositions = useMemo(() => {
    const tf = tickerFilter.toUpperCase().trim();
    let out = positionsWithMetrics;
    if (tf) out = out.filter(p => String(p.openLeg?.ticker || "").includes(tf));
    if (statusFilter === "open")   out = out.filter(p => p.status === "OPEN" || p.status === "EXPIRED");
    if (statusFilter === "closed") out = out.filter(p => ["CLOSED", "ROLLED", "EXPIRED"].includes(p.status));
    // Open first, then newest
    return [...out].sort((a, b) => {
      const ao = a.status === "OPEN" ? 0 : 1, bo = b.status === "OPEN" ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return String(b.openLeg?.openDate || "").localeCompare(String(a.openLeg?.openDate || ""));
    });
  }, [positionsWithMetrics, tickerFilter, statusFilter]);

  /* ── Summary cards (date-range filtered) ─────────────────── */
  // Mirrors Options.jsx exactly:
  //   realizedPL   → filter by closeDate  (same as Options.jsx "YTD Realized P/L")
  //   cashCollected → filter by openDate  (same as Options.jsx "Cash Collected")
  //     closed positions contribute realizedPL; open positions contribute gross premium (no fee)
  const summary = useMemo(() => {
    const tf = tickerFilter.toUpperCase().trim();
    let totalRealized = 0, cashCollected = 0, totalUnrealized = 0, hasUnrealized = false;
    let rocNumer = 0, rocDenom = 0;

    for (const p of positionsWithMetrics) {
      if (tf && !String(p.openLeg?.ticker || "").includes(tf)) continue;
      const m = p.metrics;

      // Realized P/L: filter by closeDate
      if (m.realizedPL !== null && m.closeDate && inRange(m.closeDate, fromDate, toDate)) {
        totalRealized += m.realizedPL;
        if (m.days && m.collateral > 0) { rocNumer += m.realizedPL; rocDenom += m.collateral * m.days; }
      }

      // Cash Collected: filter by openDate
      if (inRange(m.openDate, fromDate, toDate)) {
        if (m.realizedPL !== null) {
          // Closed: add realized P/L (matches Options.jsx realizedPL_openDate)
          cashCollected += m.realizedPL;
        } else {
          // Open: gross premium only, no fee (matches Options.jsx calcOpenCashFlow)
          const ot   = String(p.openLeg?.type || "SELL").toUpperCase();
          const fill = safeNum(p.openLeg?.fill, 0);
          const qty  = safeNum(p.openLeg?.qty, 0);
          if (ot === "SELL") cashCollected += fill * qty * 100;
          else if (ot === "BUY") cashCollected -= fill * qty * 100;
        }
      }

      if (m.unrealizedPL !== null) { totalUnrealized += m.unrealizedPL; hasUnrealized = true; }
    }
    const annRoc = rocDenom > 0 ? round2((rocNumer / rocDenom) * 365 * 100) : null;
    return { totalRealized, cashCollected, totalUnrealized: hasUnrealized ? totalUnrealized : null, annRoc };
  }, [positionsWithMetrics, fromDate, toDate, tickerFilter]);

  /* ── Mutations ───────────────────────────────────────────── */
  const addMut = useMutation({
    mutationFn: (payload) => api.post("/assets/options/transactions", payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.optionsTx() }),
    onError: (e) => { setError(e?.message || "Failed"); setBusy(false); },
  });

  const deleteMut = useMutation({
    mutationFn: (id) => api.delete(`/assets/options/transactions/${encodeURIComponent(id)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.optionsTx() }),
    onError: (e) => setError(e?.message || "Delete failed"),
  });

  const stockAddMut = useMutation({
    mutationFn: (payload) => api.post("/assets/stocks/transactions", payload),
    onError: (e) => setError(`Options closed but stock transaction failed: ${e?.message || "unknown error"}`),
  });

  function closeModal() {
    setOpenModal(null); setCloseDraft(null); setRollDraft(null);
    setDeleteDraft(null); setRollStep(1); setError(""); setBusy(false);
  }

  /* ── Open position ────────────────────────────────────────── */
  function handleOpenPosition() {
    setError("");
    const d = openDraft;
    const positionId = genPosId();
    const autoCollateral = calcAutoCollateral(d.strikes, d.qty);
    const collateral = d.collateral !== "" && Number.isFinite(Number(d.collateral)) && Number(d.collateral) > 0
      ? Number(d.collateral) : autoCollateral;

    if (!d.ticker.trim())                                           return setError("Ticker is required");
    if (!d.openDate)                                                return setError("Open date is required");
    if (!d.expiry)                                                  return setError("Expiry is required");
    if (!Number.isFinite(Number(d.qty)) || Number(d.qty) <= 0)     return setError("Qty must be a positive number");
    if (!Number.isFinite(Number(d.fill)) || Number(d.fill) <= 0)   return setError("Fill must be a positive number");
    if (!collateral || collateral <= 0)                             return setError("Invalid collateral");

    const fee = d.fee !== "" && Number.isFinite(Number(d.fee)) ? Number(d.fee) : "";

    const payload = {
      ticker: d.ticker.toUpperCase().trim(),
      type: d.type, event: d.event,
      strikes: d.strikes, expiry: d.expiry,
      openDate: d.openDate, qty: Number(d.qty), fill: Number(d.fill),
      fee, collateral, coll: collateral,
      rollOver: "", closeDate: "", closePrice: "",
      notes: d.notes.trim(), country: d.country,
      positionId, leg: "OPEN",
    };

    setBusy(true);
    addMut.mutate(payload, {
      onSuccess: () => { closeModal(); setOpenDraft(blankOpenDraft(country)); },
      onSettled: () => setBusy(false),
    });
  }

  /* ── Close position ───────────────────────────────────────── */
  function handleClosePosition() {
    setError("");
    const d = closeDraft;
    if (!d.closeDate)                                               return setError("Close date is required");
    if (!Number.isFinite(Number(d.fill)) || Number(d.fill) < 0)    return setError("Close price required (≥ 0)");

    const closeFill = Number(d.fill);
    const closeQty  = safeNum(d.qty || d.openQty, 0);
    const closeFee  = d.fee !== "" && Number.isFinite(Number(d.fee)) ? Number(d.fee) : 0;
    const openFee   = safeNum(d.openFee, 0);
    const openFill  = safeNum(d.openFill, 0);
    const coll      = safeNum(d.collateral, 0);

    let pl;
    if (d.openType === "SELL") pl = (openFill - closeFill) * closeQty * 100 - openFee - closeFee;
    else pl = (closeFill - openFill) * closeQty * 100 - openFee - closeFee;
    const roc = coll > 0 ? round2((pl / coll) * 100) : 0;

    const closeType = d.openType === "SELL" ? "BUY" : "SELL";
    const fee = closeFee === 0 ? "" : closeFee;

    const payload = {
      ticker: d.ticker, type: closeType, event: d.event,
      strikes: d.strikes, expiry: d.expiry,
      openDate: d.closeDate, // CLOSE leg stores close date in openDate for GSI sort
      qty: closeQty, fill: closeFill, fee,
      collateral: coll, coll,
      rollOver: "", closeDate: "", closePrice: "",
      notes: `Closed at ${closeFill}`,
      country: d.country,
      positionId: d.positionId, leg: "CLOSE", roc,
    };

    setBusy(true);
    addMut.mutate(payload, {
      onSuccess: () => closeModal(),
      onSettled: () => setBusy(false),
    });
  }

  /* ── Assign / Exercise position ─────────────────────────── */
  function handleAssign() {
    setError("");
    const d = closeDraft;
    if (!d.closeDate) return setError("Date is required");

    const qty      = safeNum(d.qty || d.openQty, 0);
    const strike   = safeNum(d.strikes, 0);
    const coll     = safeNum(d.collateral, 0);
    const openFee  = safeNum(d.openFee, 0);
    const isSeller = d.openType === "SELL";
    const optEvent = String(d.event || "").toLowerCase();
    const isPut    = optEvent === "put";

    if (strike <= 0) return setError("Strike price is required");

    // Option closes at 0 — assigned/exercised options carry no premium on close
    const closeFill = 0;
    let pl;
    if (isSeller) pl = (safeNum(d.openFill, 0) - closeFill) * qty * 100 - openFee;
    else          pl = (closeFill - safeNum(d.openFill, 0)) * qty * 100 - openFee;
    const roc = coll > 0 ? round2((pl / coll) * 100) : 0;

    const closeType = isSeller ? "BUY" : "SELL";
    const actionLabel = isSeller ? "Assigned" : "Exercised";

    // Stock transaction direction:
    //   Seller + PUT  (short put assigned)   → must BUY  shares at strike
    //   Seller + CALL (short call assigned)  → must SELL shares at strike
    //   Buyer  + CALL (long call exercised)  → receives BUY  shares at strike
    //   Buyer  + PUT  (long put exercised)   → delivers SELL shares at strike
    const stockType = (isSeller === isPut) ? "BUY" : "SELL";

    const optPayload = {
      ticker: d.ticker, type: closeType, event: d.event,
      strikes: d.strikes, expiry: d.expiry,
      openDate: d.closeDate,
      qty, fill: closeFill, fee: "",
      collateral: coll, coll,
      rollOver: "", closeDate: "", closePrice: "",
      notes: actionLabel,
      country: d.country,
      positionId: d.positionId, leg: "CLOSE", roc,
    };

    const stockPayload = {
      type: stockType,
      symbol: d.ticker,
      date: d.closeDate,
      shares: qty * 100,
      price: strike,
      fees: 0,
      notes: actionLabel,
      country: d.country,
    };

    setBusy(true);
    addMut.mutate(optPayload, {
      onSuccess: () => {
        stockAddMut.mutate(stockPayload, {
          onSettled: () => { setBusy(false); closeModal(); },
        });
      },
      onError: (e) => { setError(e?.message || "Failed"); setBusy(false); },
    });
  }

  /* ── Roll position ────────────────────────────────────────── */
  function handleRoll() {
    setError("");
    const d = rollDraft;

    if (rollStep === 1) {
      if (!d.closeDate)                                               return setError("Close date required");
      if (!Number.isFinite(Number(d.closeFill)) || Number(d.closeFill) < 0) return setError("Buy-to-close price required");
      setRollStep(2);
      return;
    }

    // Step 2
    if (!d.newStrikes.trim())                                         return setError("New strike required");
    if (!d.newExpiry)                                                 return setError("New expiry required");
    if (!Number.isFinite(Number(d.newFill)) || Number(d.newFill) <= 0) return setError("New fill required");

    const closeFill = Number(d.closeFill);
    const openFill  = safeNum(d.openFill, 0);
    const closeQty  = safeNum(d.openQty, 0);
    const newQty    = d.newQty !== "" && Number.isFinite(Number(d.newQty)) ? Number(d.newQty) : closeQty;
    const closeFee  = d.closeFee !== "" && Number.isFinite(Number(d.closeFee)) ? Number(d.closeFee) : 0;
    const newFee    = d.newFee !== "" && Number.isFinite(Number(d.newFee)) ? Number(d.newFee) : 0;
    const openFee   = safeNum(d.openFee, 0);
    const coll      = safeNum(d.collateral, 0);
    const newColl   = calcAutoCollateral(d.newStrikes, newQty);

    let pl;
    if (d.openType === "SELL") pl = (openFill - closeFill) * closeQty * 100 - openFee - closeFee;
    else pl = (closeFill - openFill) * closeQty * 100 - openFee - closeFee;
    const roc = coll > 0 ? round2((pl / coll) * 100) : 0;

    const closeType = d.openType === "SELL" ? "BUY" : "SELL";
    const newPosId  = genPosId();

    const rollCloseLeg = {
      ticker: d.ticker, type: closeType, event: d.event,
      strikes: d.strikes, expiry: d.expiry,
      openDate: d.closeDate, qty: closeQty, fill: closeFill,
      fee: closeFee === 0 ? "" : closeFee,
      collateral: coll, coll,
      rollOver: "", closeDate: "", closePrice: "",
      notes: `Rolled → ${d.newStrikes} exp ${d.newExpiry}`,
      country: d.country,
      positionId: d.positionId, leg: "ROLL_CLOSE", roc,
    };

    const rollOpenLeg = {
      ticker: d.ticker, type: d.openType, event: d.event,
      strikes: d.newStrikes, expiry: d.newExpiry,
      openDate: d.closeDate, qty: newQty, fill: Number(d.newFill),
      fee: newFee === 0 ? "" : newFee,
      collateral: newColl, coll: newColl,
      rollOver: "", closeDate: "", closePrice: "",
      notes: `Rolled from ${d.strikes} exp ${d.expiry}`,
      country: d.country,
      positionId: newPosId, linkedPositionId: d.positionId, leg: "ROLL_OPEN",
    };

    setBusy(true);
    addMut.mutate(rollCloseLeg, {
      onSuccess: () => {
        addMut.mutate(rollOpenLeg, {
          onSuccess: () => closeModal(),
          onSettled: () => setBusy(false),
        });
      },
      onError: (e) => { setError(e?.message || "Roll failed"); setBusy(false); },
    });
  }

  /* ── Delete position ──────────────────────────────────────── */
  function handleDelete(pos) {
    setDeleteDraft(pos);
    setOpenModal("delete");
    setError("");
  }

  function confirmDelete() {
    if (!deleteDraft) return;
    const legs = [...deleteDraft.legs];
    setBusy(true);
    function deleteNext(i) {
      if (i >= legs.length) { setBusy(false); closeModal(); return; }
      deleteMut.mutate(legs[i].id, { onSettled: () => deleteNext(i + 1) });
    }
    deleteNext(0);
  }

  /* ── P&L previews ─────────────────────────────────────────── */
  const closePnlPreview = useMemo(() => {
    if (!closeDraft) return null;
    const fill = Number(closeDraft.fill);
    if (!Number.isFinite(fill)) return null;
    const qty       = safeNum(closeDraft.qty || closeDraft.openQty, 0);
    const closeFee  = safeNum(closeDraft.fee, 0);
    const openFee   = safeNum(closeDraft.openFee, 0);
    const openFill  = safeNum(closeDraft.openFill, 0);
    const coll      = safeNum(closeDraft.collateral, 0);
    let pl;
    if (closeDraft.openType === "SELL") pl = (openFill - fill) * qty * 100 - openFee - closeFee;
    else pl = (fill - openFill) * qty * 100 - openFee - closeFee;
    const roc    = coll > 0 ? round2((pl / coll) * 100) : null;
    const days   = daysBetween(closeDraft.openDate, closeDraft.closeDate);
    const annRoc = roc !== null && days && days > 0 ? round2((roc / 100 / days) * 365 * 100) : null;
    return { pl, roc, annRoc, collateral: coll };
  }, [closeDraft]);

  const rollCreditPreview = useMemo(() => {
    if (!rollDraft || rollStep < 2) return null;
    const closeFill = Number(rollDraft.closeFill);
    const newFill   = Number(rollDraft.newFill);
    if (!Number.isFinite(closeFill) || !Number.isFinite(newFill)) return null;
    const qty = safeNum(rollDraft.openQty, 0);
    // Net = new premium - close cost (for sell: sell-to-open - buy-to-close)
    const net = rollDraft.openType === "SELL"
      ? (Number(rollDraft.newFill) - closeFill) * qty * 100
      : (closeFill - Number(rollDraft.newFill)) * qty * 100;
    return { net };
  }, [rollDraft, rollStep]);

  /* ─────────────────────────────────────────────────────────────
     RENDER
  ───────────────────────────────────────────────────────────── */
  return (
    <div className="space-y-5">

      {/* ══ OPEN POSITION MODAL ══════════════════════════════════ */}
      {openModal === "open" && (
        <Modal title="Open Position" onClose={closeModal}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Ticker">
              <input value={openDraft.ticker}
                onChange={e => setOpenDraft(d => ({ ...d, ticker: e.target.value.toUpperCase() }))}
                className={inputCls} placeholder="SPY" />
            </Field>
            <Field label="Option Type">
              <select value={openDraft.event}
                onChange={e => setOpenDraft(d => ({ ...d, event: e.target.value }))}
                className={inputCls}>
                <option value="put">Put</option>
                <option value="call">Call</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Strike">
              <input type="number" value={openDraft.strikes}
                onChange={e => setOpenDraft(d => ({ ...d, strikes: e.target.value }))}
                className={inputCls} placeholder="500" />
            </Field>
            <Field label="Expiry">
              <input type="date" value={openDraft.expiry}
                onChange={e => setOpenDraft(d => ({ ...d, expiry: e.target.value }))}
                className={inputCls} />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Action">
              <select value={openDraft.type}
                onChange={e => setOpenDraft(d => ({ ...d, type: e.target.value }))}
                className={inputCls}>
                <option value="SELL">Sell (Write)</option>
                <option value="BUY">Buy (Long)</option>
              </select>
            </Field>
            <Field label="Open Date">
              <input type="date" value={openDraft.openDate}
                onChange={e => setOpenDraft(d => ({ ...d, openDate: e.target.value }))}
                className={inputCls} />
            </Field>
            <Field label="Qty (contracts)">
              <input type="number" value={openDraft.qty}
                onChange={e => setOpenDraft(d => ({ ...d, qty: e.target.value }))}
                className={inputCls} placeholder="1" min="1" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fill (premium / share)">
              <input type="number" value={openDraft.fill}
                onChange={e => setOpenDraft(d => ({ ...d, fill: e.target.value }))}
                className={inputCls} placeholder="2.40" step="0.01" />
            </Field>
            <Field label="Fee ($)">
              <input type="number" value={openDraft.fee}
                onChange={e => setOpenDraft(d => ({ ...d, fee: e.target.value }))}
                className={inputCls} placeholder="0.00" step="0.01" />
            </Field>
          </div>
          <Field label={`Collateral — auto: ${fmtMoney(calcAutoCollateral(openDraft.strikes, openDraft.qty), currency)} (override optional)`}>
            <input type="number" value={openDraft.collateral}
              onChange={e => setOpenDraft(d => ({ ...d, collateral: e.target.value }))}
              placeholder={String(calcAutoCollateral(openDraft.strikes, openDraft.qty) || "")}
              className={inputCls} step="100" />
          </Field>
          <Field label="Notes">
            <input value={openDraft.notes}
              onChange={e => setOpenDraft(d => ({ ...d, notes: e.target.value }))}
              className={inputCls} placeholder="Optional" />
          </Field>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={handleOpenPosition} disabled={busy} className={`${btnPrimary} flex-1`}>
              {busy ? "Saving…" : "Open Position"}
            </button>
            <button type="button" onClick={closeModal} className={btnSecondary}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* ══ CLOSE POSITION MODAL ═════════════════════════════════ */}
      {openModal === "close" && closeDraft && (
        <Modal
          title={`Close — ${closeDraft.ticker} ${closeDraft.strikes} ${String(closeDraft.event || "").toUpperCase()}`}
          onClose={closeModal}
        >
          <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06] text-xs text-slate-400">
            Opened {closeDraft.strikes} @ ${closeDraft.openFill} × {closeDraft.openQty} contracts &nbsp;·&nbsp; Expiry {closeDraft.expiry}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Close Date">
              <input type="date" value={closeDraft.closeDate}
                onChange={e => setCloseDraft(d => ({ ...d, closeDate: e.target.value }))}
                className={inputCls} />
            </Field>
            <Field label="Qty (contracts)">
              <input type="number" value={closeDraft.qty}
                onChange={e => setCloseDraft(d => ({ ...d, qty: e.target.value }))}
                className={inputCls} min="1" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Close Price (BTC / STC per share)">
              <input type="number" value={closeDraft.fill}
                onChange={e => setCloseDraft(d => ({ ...d, fill: e.target.value }))}
                className={inputCls} placeholder="0.50" step="0.01" autoFocus />
            </Field>
            <Field label="Fee ($)">
              <input type="number" value={closeDraft.fee}
                onChange={e => setCloseDraft(d => ({ ...d, fee: e.target.value }))}
                className={inputCls} placeholder="0.00" step="0.01" />
            </Field>
          </div>
          <PnlPreviewBox
            pl={closePnlPreview?.pl ?? null}
            roc={closePnlPreview?.roc ?? null}
            annRoc={closePnlPreview?.annRoc ?? null}
            collateral={closePnlPreview?.collateral ?? null}
            currency={currency}
          />
          {error && <p className="text-red-400 text-xs">{error}</p>}
          {closeDraft && (() => {
            const isSeller = String(closeDraft.openType || "SELL").toUpperCase() === "SELL";
            const isPut    = String(closeDraft.event || "").toLowerCase() === "put";
            const btnLabel = isSeller ? "Assign" : "Exercise";
            const stockDir = (isSeller === isPut) ? "Buy" : "Sell";
            const hint     = isSeller
              ? isPut
                ? `Short put assigned → Buy ${safeNum(closeDraft.qty,0)*100} shares of ${closeDraft.ticker} @ $${closeDraft.strikes}`
                : `Short call assigned → Sell ${safeNum(closeDraft.qty,0)*100} shares of ${closeDraft.ticker} @ $${closeDraft.strikes}`
              : isPut
                ? `Long put exercised → Sell ${safeNum(closeDraft.qty,0)*100} shares of ${closeDraft.ticker} @ $${closeDraft.strikes}`
                : `Long call exercised → Buy ${safeNum(closeDraft.qty,0)*100} shares of ${closeDraft.ticker} @ $${closeDraft.strikes}`;
            return (
              <>
                <div className="flex gap-2 pt-1">
                  <button type="button" onClick={handleClosePosition} disabled={busy} className={`${btnPrimary} flex-1`}>
                    {busy ? "Saving…" : "Confirm Close"}
                  </button>
                  <button
                    type="button"
                    onClick={handleAssign}
                    disabled={busy}
                    title={hint}
                    className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {btnLabel}
                  </button>
                  <button type="button" onClick={closeModal} className={btnSecondary}>Cancel</button>
                </div>
                <p className="text-[11px] text-slate-600 pt-0.5">
                  <span className="text-slate-500 font-medium">{btnLabel}</span> — closes option at $0 and creates a{" "}
                  <span className="text-slate-500">{stockDir}</span> stock transaction for{" "}
                  {safeNum(closeDraft.qty, 0) * 100} shares of {closeDraft.ticker} @ ${closeDraft.strikes} (strike).
                </p>
              </>
            );
          })()}
        </Modal>
      )}

      {/* ══ ROLL POSITION MODAL ══════════════════════════════════ */}
      {openModal === "roll" && rollDraft && (
        <Modal
          title={`Roll — ${rollDraft.ticker} ${rollDraft.strikes} ${String(rollDraft.event || "").toUpperCase()} (Step ${rollStep}/2)`}
          onClose={closeModal}
        >
          {/* Step indicator */}
          <div className="flex gap-2 text-xs mb-1">
            {["Close current leg", "Open new leg"].map((label, i) => (
              <div key={i} className={`flex items-center gap-1.5 ${i === rollStep - 1 ? "text-blue-400" : "text-slate-600"}`}>
                <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold ${i === rollStep - 1 ? "bg-blue-600 text-white" : "bg-white/[0.08] text-slate-500"}`}>
                  {i + 1}
                </span>
                {label}
                {i === 0 && <span className="text-slate-700">→</span>}
              </div>
            ))}
          </div>

          {rollStep === 1 ? (
            <>
              <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06] text-xs text-slate-400">
                <strong className="text-slate-300">Buy to close:</strong> {rollDraft.strikes} @ ${rollDraft.openFill} × {rollDraft.openQty} contracts &nbsp;·&nbsp; Exp {rollDraft.expiry}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Close Date">
                  <input type="date" value={rollDraft.closeDate}
                    onChange={e => setRollDraft(d => ({ ...d, closeDate: e.target.value }))}
                    className={inputCls} />
                </Field>
                <Field label="Buy-to-Close Price (per share)">
                  <input type="number" value={rollDraft.closeFill}
                    onChange={e => setRollDraft(d => ({ ...d, closeFill: e.target.value }))}
                    className={inputCls} placeholder="0.50" step="0.01" autoFocus />
                </Field>
              </div>
              <Field label="Close Fee ($)">
                <input type="number" value={rollDraft.closeFee}
                  onChange={e => setRollDraft(d => ({ ...d, closeFee: e.target.value }))}
                  className={inputCls} placeholder="0.00" step="0.01" />
              </Field>
            </>
          ) : (
            <>
              <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06] text-xs text-slate-400">
                <strong className="text-slate-300">Sell to open new leg</strong>
                {rollCreditPreview && (
                  <span className={`ml-2 font-semibold ${rollCreditPreview.net >= 0 ? "text-green-400" : "text-red-400"}`}>
                    &nbsp;Net {rollCreditPreview.net >= 0 ? "Credit" : "Debit"}: {fmtMoneyFull(Math.abs(rollCreditPreview.net), currency)}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="New Strike">
                  <input type="number" value={rollDraft.newStrikes}
                    onChange={e => setRollDraft(d => ({ ...d, newStrikes: e.target.value }))}
                    className={inputCls} placeholder="495" autoFocus />
                </Field>
                <Field label="New Expiry">
                  <input type="date" value={rollDraft.newExpiry}
                    onChange={e => setRollDraft(d => ({ ...d, newExpiry: e.target.value }))}
                    className={inputCls} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="New Fill (premium / share)">
                  <input type="number" value={rollDraft.newFill}
                    onChange={e => setRollDraft(d => ({ ...d, newFill: e.target.value }))}
                    className={inputCls} placeholder="1.80" step="0.01" />
                </Field>
                <Field label="Qty (contracts)">
                  <input type="number" value={rollDraft.newQty}
                    onChange={e => setRollDraft(d => ({ ...d, newQty: e.target.value }))}
                    className={inputCls} />
                </Field>
              </div>
              <Field label="Open Fee ($)">
                <input type="number" value={rollDraft.newFee}
                  onChange={e => setRollDraft(d => ({ ...d, newFee: e.target.value }))}
                  className={inputCls} placeholder="0.00" step="0.01" />
              </Field>
            </>
          )}

          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex gap-2 pt-1">
            {rollStep === 2 && (
              <button type="button" onClick={() => { setRollStep(1); setError(""); }} className={btnSecondary}>← Back</button>
            )}
            <button type="button" onClick={handleRoll} disabled={busy} className={`${btnPrimary} flex-1`}>
              {busy ? "Saving…" : rollStep === 1 ? "Next →" : "Confirm Roll"}
            </button>
            <button type="button" onClick={closeModal} className={btnSecondary}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* ══ DELETE POSITION MODAL ════════════════════════════════ */}
      {openModal === "delete" && deleteDraft && (
        <Modal
          title={`Delete — ${deleteDraft.openLeg?.ticker} ${deleteDraft.openLeg?.strikes} ${String(deleteDraft.openLeg?.event || "").toUpperCase()}`}
          onClose={closeModal}
        >
          <div className="p-3 rounded-xl bg-red-500/[0.07] border border-red-500/20 text-sm text-slate-300 space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-400">Status</span>
              <span className="font-medium">{deleteDraft.status}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Open Date</span>
              <span>{deleteDraft.openLeg?.openDate || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Expiry</span>
              <span>{deleteDraft.openLeg?.expiry || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Transactions</span>
              <span>{deleteDraft.legs.length} leg{deleteDraft.legs.length !== 1 ? "s" : ""}</span>
            </div>
          </div>
          <p className="text-xs text-red-400">
            This will permanently delete all {deleteDraft.legs.length} transaction{deleteDraft.legs.length !== 1 ? "s" : ""} for this position. This cannot be undone.
          </p>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={confirmDelete}
              disabled={busy}
              className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer flex-1"
            >
              {busy ? "Deleting…" : "Delete Position"}
            </button>
            <button type="button" onClick={closeModal} className={btnSecondary}>Cancel</button>
          </div>
        </Modal>
      )}

      {/* ══ PAGE HEADER ══════════════════════════════════════════ */}
      <PageHeader title="Options Pro" icon={PageIcons.options}>
        <select value={country} onChange={e => setCountry(e.target.value)}
          className="bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2 text-slate-200 text-sm outline-none focus:border-blue-500/40 transition-colors">
          <option value="USA">USA</option>
          <option value="INDIA">India</option>
        </select>
        <button type="button"
          onClick={() => queryClient.invalidateQueries({ queryKey: queryKeys.optionsTx() })}
          className={btnSecondary} disabled={isLoading || busy}>
          Refresh
        </button>
        {canWrite && (
          <button type="button"
            onClick={() => { setOpenModal("open"); setError(""); }}
            className={btnPrimary} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3.5 h-3.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
            Open Position
          </button>
        )}
      </PageHeader>

      {/* ══ FILTERS ═════════════════════════════════════════════ */}
      <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-3">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <div className={labelCls}>From</div>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className={`${inputCls} !w-40`} />
          </div>
          <div>
            <div className={labelCls}>To</div>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className={`${inputCls} !w-40`} />
          </div>
          <div>
            <div className={labelCls}>Ticker</div>
            <input type="text" value={tickerFilter} onChange={e => setTickerFilter(e.target.value)}
              placeholder="(all)" className={`${inputCls} !w-28 uppercase`} />
          </div>
          <div>
            <div className={labelCls}>Status</div>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className={`${inputCls} !w-28`}>
              <option value="all">All</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </div>
          <div className="ml-auto">
            <button type="button"
              onClick={() => { const d = new Date(); d.setMonth(d.getMonth() - 3); setFromDate(d.toISOString().slice(0, 10)); setToDate(todayISO()); }}
              className={btnSecondary}>
              Reset Dates
            </button>
          </div>
        </div>
      </div>

      {/* ══ SUMMARY CARDS ════════════════════════════════════════ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard label="Cash Collected" value={formatMoney(summary.cashCollected)}
          sub="Filtered by Open Date + Ticker"
          valueClass={summary.cashCollected >= 0 ? "text-green-400" : "text-red-400"} />
        <MetricCard label="Realized P&L" value={formatMoney(summary.totalRealized)}
          sub="Filtered by Close Date + Ticker"
          valueClass={summary.totalRealized >= 0 ? "text-green-400" : "text-red-400"} />
        <MetricCard
          label="Unrealized P&L"
          value={summary.totalUnrealized === null ? "—" : formatMoney(summary.totalUnrealized)}
          sub="Open positions at mark"
          valueClass={summary.totalUnrealized === null ? "text-slate-500" : summary.totalUnrealized >= 0 ? "text-green-400" : "text-red-400"} />
        <MetricCard
          label="Ann. ROC"
          value={summary.annRoc === null ? "—" : fmtPct(summary.annRoc)}
          sub="Weighted annualized ROC"
          valueClass={summary.annRoc === null ? "text-slate-500" : summary.annRoc >= 0 ? "text-green-400" : "text-red-400"} />
      </div>

      {/* ══ POSITIONS ════════════════════════════════════════════ */}
      <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] overflow-x-auto">
        {isLoading ? (
          <EmptyState state="loading" message="Loading positions…" />
        ) : filteredPositions.length === 0 ? (
          <EmptyState state="empty" message="No positions — click Open Position to add one" />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/[0.06]">
                {[
                  { label: "Ticker",     align: "left",  w: "w-[80px]"  },
                  { label: "Strike",     align: "left",  w: "w-[70px]"  },
                  { label: "Type",       align: "left",  w: "w-[58px]"  },
                  { label: "Status",     align: "left",  w: "w-[80px]"  },
                  { label: "DTE/Held",   align: "right", w: "w-[52px]"  },
                  { label: "Open Date",  align: "left",  w: "w-[90px]"  },
                  { label: "Expiry",     align: "left",  w: "w-[90px]"  },
                  { label: "Qty",        align: "right", w: "w-[32px]"  },
                  { label: "Fill",       align: "right", w: "w-[60px]"  },
                  { label: "Close Fill", align: "right", w: "w-[74px]"  },
                  { label: "Close Date", align: "left",  w: "w-[90px]"  },
                  { label: "Net Prem",   align: "right", w: "w-[80px]"  },
                  { label: "P/L",        align: "right", w: "w-[80px]"  },
                  { label: "ROC",        align: "right", w: "w-[74px]"  },
                  { label: "",           align: "right", w: "w-[90px]"  },
                ].map(({ label, align, w }, i) => (
                  <th
                    key={i}
                    className={`${w} px-3 py-2.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap text-${align}`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="fv-options-tbody">
              {filteredPositions.map(pos => (
                <PositionRow
                  key={pos.positionId}
                  pos={pos}
                  metrics={pos.metrics}
                  formatMoney={formatMoney}
                  currency={currency}
                  canWrite={canWrite}
                  onClose={(p) => { setCloseDraft(blankCloseDraft(p)); setOpenModal("close"); setError(""); }}
                  onRoll={(p)  => { setRollDraft(blankRollDraft(p)); setRollStep(1); setOpenModal("roll"); setError(""); }}
                  onDelete={handleDelete}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
