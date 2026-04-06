import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { PageHeader } from "../components/ui/PageHeader.jsx";
import { PageIcons }  from "../components/ui/PageIcons.jsx";
import { Badge } from "../components/ui/Badge.jsx";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function isoOneMonthAgoFromToday() {
  const d = new Date();
  const year = d.getFullYear();
  const month = d.getMonth();
  const day = d.getDate();
  const temp = new Date(year, month, 1);
  temp.setMonth(temp.getMonth() - 1);
  const lastDayOfTargetMonth = new Date(temp.getFullYear(), temp.getMonth() + 1, 0).getDate();
  temp.setDate(Math.min(day, lastDayOfTargetMonth));
  return isoDate(temp);
}

function safeNum(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

const COUNTRY_CURRENCY = { USA: "USD", INDIA: "INR" };
const LOCALE_FOR_CURRENCY = { USD: "en-US", INR: "en-IN" };
function _fmtMoney(n, cur = "USD") {
  const locale = LOCALE_FOR_CURRENCY[cur] ?? "en-US";
  return safeNum(n, 0).toLocaleString(locale, { style: "currency", currency: cur });
}

function formatPct01(n01) {
  if (n01 === null || n01 === undefined || !Number.isFinite(Number(n01))) return "—";
  return `${(Number(n01) * 100).toFixed(2)}%`;
}

function plColor(v) {
  return safeNum(v, 0) < 0 ? "rgba(248,113,113,0.95)" : "rgba(134,239,172,0.95)";
}

function parseISODate(d) {
  if (!d) return null;
  const dt = new Date(`${d}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function daysBetweenISO(openISO, closeISO) {
  const o = parseISODate(openISO);
  const c = parseISODate(closeISO);
  if (!o || !c) return null;
  const ms = c.getTime() - o.getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  return days < 1 ? 1 : days;
}

function inRangeISO(dateISO, fromISO, toISO) {
  if (!dateISO) return false;
  if (fromISO && dateISO < fromISO) return false;
  if (toISO && dateISO > toISO) return false;
  return true;
}

function parseStrikeNumber(strikes) {
  if (strikes === null || strikes === undefined) return null;
  const s = String(strikes).trim();
  const m = s.match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function calcDefaultCollateral(row) {
  const strike = parseStrikeNumber(row.strikes);
  const qty = safeNum(row.qty, NaN);
  if (!Number.isFinite(strike) || !Number.isFinite(qty) || qty <= 0) return "";
  return String(Math.round(strike * qty * 100 * 100) / 100);
}

function getEffectiveCollateral(row) {
  const raw = row.collateral;
  const hasUserValue =
    raw !== "" && raw !== null && raw !== undefined && String(raw).trim() !== "";
  if (hasUserValue) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  const def = calcDefaultCollateral(row);
  const n = Number(def);
  return Number.isFinite(n) ? n : 0;
}

function calcPL(row) {
  const typeU = String(row.type || "").trim().toUpperCase();
  const qty = safeNum(row.qty, 0);
  const fill = safeNum(row.fill, 0);
  const closeBlank =
    row.closePrice === "" || row.closePrice === null || row.closePrice === undefined;
  const close = closeBlank ? null : safeNum(row.closePrice, NaN);
  const fee = safeNum(row.fee, 0);
  if (close === null || !Number.isFinite(close)) return null;
  if (typeU === "SELL") return (fill - close - fee / 100) * qty * 100;
  if (typeU === "BUY") return (close - fill - fee / 100) * qty * 100;
  if (typeU === "ASS") return (close - fill - fee / 100) * qty * 100;
  if (typeU === "SDI") return (close - fill) * qty - fee;
  return null;
}

function calcUnrealizedPL(row, markPrice) {
  const isOpen = !row.closeDate || String(row.closeDate).trim() === "";
  if (!isOpen) return null;
  if (markPrice === null || markPrice === undefined) return null;
  const typeU = String(row.type || "").trim().toUpperCase();
  const qty = safeNum(row.qty, 0);
  const fill = safeNum(row.fill, 0);
  const mark = Number(markPrice);
  if (!Number.isFinite(mark) || mark <= 0) return null;
  if (typeU === "SELL") return (fill - mark) * qty * 100;
  if (typeU === "BUY")  return (mark - fill) * qty * 100;
  if (typeU === "ASS")  return (mark - fill) * qty * 100;
  return null;
}

function markKey(row) {
  const optType = String(row.event || "").toLowerCase();
  return `${row.ticker}_${row.strikes}_${row.expiry}_${optType}`;
}

function calcOpenCashFlow(row) {
  const typeU = String(row.type || "").trim().toUpperCase();
  const closeBlank =
    row.closePrice === "" || row.closePrice === null || row.closePrice === undefined;
  if (!closeBlank) return 0;
  const qty = safeNum(row.qty, 0);
  const fill = safeNum(row.fill, 0);
  if (typeU === "SELL") return fill * qty * 100;
  if (typeU === "BUY") return fill * qty * -100;
  return 0;
}

function normalizeItem(it) {
  const id = it.txId || it.assetId || it.id;
  const rollOver = it.rollOver ?? it.rollover ?? it.roll_over ?? it.rollOverFlag ?? "";
  const notes = it.notes ?? it.note ?? it.memo ?? "";
  const closeDate = it.closeDate ?? it.close_date ?? "";
  const collateral = it.collateral ?? it.coll ?? it.margin ?? "";
  return { ...it, id, collateral, rollOver, closeDate, notes };
}


/* ================================================================
   COMPONENT
================================================================ */

export default function Options() {
  const [country, setCountry] = useState("USA");
  const currency = COUNTRY_CURRENCY[country] ?? "USD";
  const formatMoney = (n) => _fmtMoney(n, currency);

  const [expanded, setExpanded] = useState(() => new Set());
  const [fromDate, setFromDate] = useState(isoOneMonthAgoFromToday());
  const [toDate, setToDate] = useState(todayISO());
  const [showOpenOnly, setShowOpenOnly] = useState(false);
  const [tickerFilter, setTickerFilter] = useState("");
  const [sortMode, setSortMode] = useState("openDate_desc");

  /* ---------- Data query ---------- */

  const { data: rawData, isLoading: loading } = useQuery({
    queryKey: queryKeys.optionsTx(),
    queryFn: () => api.get("/assets/options/transactions"),
  });

  const rows = useMemo(() => {
    const items = Array.isArray(rawData?.items) ? rawData.items : Array.isArray(rawData) ? rawData : [];
    const normalized = items.map(normalizeItem);

    // V2 positions: merge CLOSE/ROLL_CLOSE legs onto their OPEN leg so Options.jsx
    // single-row logic (closePrice / closeDate) works correctly.
    const CLOSE_LEGS = new Set(["CLOSE", "ROLL_CLOSE"]);
    const OPEN_LEGS  = new Set(["OPEN", "ROLL_OPEN"]);

    // Build a map: positionId → close leg
    const closeByPos = {};
    for (const r of normalized) {
      const leg = String(r.leg || "").toUpperCase();
      if (CLOSE_LEGS.has(leg) && r.positionId) {
        closeByPos[r.positionId] = r;
      }
    }

    const result = [];
    for (const r of normalized) {
      const leg = String(r.leg || "").toUpperCase();
      // Skip standalone CLOSE/ROLL_CLOSE rows — their data is merged into the OPEN row
      if (CLOSE_LEGS.has(leg) && r.positionId) continue;
      // For OPEN/ROLL_OPEN rows that have a matching close leg, backfill closePrice + closeDate
      if ((OPEN_LEGS.has(leg) || leg === "") && r.positionId && closeByPos[r.positionId]) {
        const cl = closeByPos[r.positionId];
        result.push({
          ...r,
          closePrice: cl.fill ?? cl.closePrice ?? 0,
          closeDate: cl.openDate || cl.closeDate || r.closeDate || "",
          notes: r.notes || cl.notes || "",
        });
      } else {
        result.push(r);
      }
    }
    return result;
  }, [rawData]);

  /* ---------- Live option marks (unrealized P/L) ---------- */

  const [marks, setMarks] = useState({});

  useEffect(() => {
    if (!rows.length) return;
    const positions = rows
      .filter(r => {
        const isOpen = !r.closeDate || String(r.closeDate).trim() === "";
        const optType = String(r.event || "").toLowerCase();
        return isOpen && r.ticker && r.strikes && r.expiry && (optType === "call" || optType === "put");
      })
      .map(r => ({
        key: markKey(r),
        ticker: r.ticker,
        strike: Number(r.strikes),
        expiry: r.expiry,
        optionType: String(r.event || "").toLowerCase(),
      }));
    if (!positions.length) return;
    api.post("/assets/options/marks", { positions })
      .then(data => setMarks(data.marks || {}))
      .catch(err => console.warn("Option marks fetch failed:", err));
  }, [rows]);


  /* ---------- Date-picker CSS injection ---------- */


  /* ---------- Derived / computed ---------- */

  const sortSpec = useMemo(() => {
    if (sortMode === "openFirst") return { field: "openDate", dir: "desc", openFirst: true };
    const parts = String(sortMode || "").split("_");
    const field = parts[0] || "openDate";
    const dir = parts[1] === "asc" ? "asc" : "desc";
    return { field, dir, openFirst: false };
  }, [sortMode]);

  function toggleSort(field) {
    setSortMode((prev) => {
      if (prev === "openFirst") return `${field}_desc`;
      const [pf, pd] = String(prev || "").split("_");
      if (pf !== field) return `${field}_desc`;
      return `${field}_${pd === "desc" ? "asc" : "desc"}`;
    });
  }

  const rowsByCountry = useMemo(
    () => rows.filter((r) => String(r.country || "USA").toUpperCase() === country),
    [rows, country]
  );

  const computedBase = useMemo(() => {
    return rowsByCountry.map((r) => {
      const pl = calcPL(r);
      const days = r.closeDate ? daysBetweenISO(r.openDate, r.closeDate) : null;
      const collateral = getEffectiveCollateral(r);
      const roc = pl !== null && collateral > 0 ? pl / collateral : null;
      const anl = roc !== null && days ? (roc / days) * 365 : null;
      return { ...r, _calc: { pl, days, collateral, anl }, _isOpen: pl === null };
    });
  }, [rowsByCountry]);

  const summary = useMemo(() => {
    const tf = String(tickerFilter || "").toUpperCase().trim();
    const tickerMatch = (r) => !tf || String(r.ticker || "").toUpperCase().includes(tf);

    const realizedSet = computedBase.filter(
      (r) => tickerMatch(r) && r._calc.pl !== null && inRangeISO(r.closeDate, fromDate, toDate)
    );
    const realizedPL = realizedSet.reduce((acc, r) => acc + (r._calc.pl ?? 0), 0);

    const openDateSet = computedBase.filter((r) => tickerMatch(r) && inRangeISO(r.openDate, fromDate, toDate));
    const realizedPL_openDate = openDateSet.reduce((acc, r) => acc + (r._calc.pl === null ? 0 : r._calc.pl), 0);
    const openCash_openDate = openDateSet.reduce((acc, r) => acc + calcOpenCashFlow(r), 0);
    const cashCollected = realizedPL_openDate + openCash_openDate;

    let denom = 0;
    for (const r of realizedSet) {
      const days = r._calc.days ?? (r.closeDate ? daysBetweenISO(r.openDate, r.closeDate) : null);
      const coll = r._calc.collateral ?? getEffectiveCollateral(r);
      if (days && coll && coll > 0) denom += coll * days;
    }
    const annualRocSummary = denom > 0 ? (realizedPL / denom) * 365 : null;

    return { realizedPL, cashCollected, annualRocSummary };
  }, [computedBase, fromDate, toDate, tickerFilter]);

  const totalUnrealizedPL = useMemo(() => {
    let total = 0;
    let hasAny = false;
    for (const r of computedBase) {
      const mark = (marks || {})[markKey(r)];
      const unpl = calcUnrealizedPL(r, mark);
      if (unpl !== null) { total += unpl; hasAny = true; }
    }
    return hasAny ? total : null;
  }, [computedBase, marks]);

  const listRows = useMemo(() => {
    let out = computedBase.slice();
    if (showOpenOnly) out = out.filter((r) => r._isOpen);
    const tf = String(tickerFilter || "").toUpperCase().trim();
    if (tf) out = out.filter((r) => String(r.ticker || "").toUpperCase().includes(tf));

    if (sortMode === "openFirst") {
      out.sort((a, b) => {
        const ao = a._isOpen ? 0 : 1, bo = b._isOpen ? 0 : 1;
        if (ao !== bo) return ao - bo;
        return String(b.openDate || "").localeCompare(String(a.openDate || ""));
      });
    } else {
      const { field, dir } = sortSpec;
      out.sort((a, b) => {
        const sentinel = dir === "asc" ? "9999-12-31" : "0000-00-00";
        const aVal = String(a?.[field] || "") || sentinel;
        const bVal = String(b?.[field] || "") || sentinel;
        return dir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      });
    }
    return out;
  }, [computedBase, showOpenOnly, tickerFilter, sortMode]);

  /* ---------- Actions ---------- */

  function toggleExpanded(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <PageHeader title="Options" icon={PageIcons.options}>
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2 text-slate-200 text-sm outline-none focus:border-blue-500/[0.4] transition-colors"
        >
          <option value="USA">USA</option>
          <option value="INDIA">India</option>
        </select>
      </PageHeader>

      {/* Summary filter bar */}
      <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-3">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <div className="text-xs font-bold text-slate-500 mb-1.5">From</div>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
              className={`${inputCls} !w-44`} />
          </div>
          <div>
            <div className="text-xs font-bold text-slate-500 mb-1.5">To</div>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
              className={`${inputCls} !w-44`} />
          </div>
          <div>
            <div className="text-xs font-bold text-slate-500 mb-1.5">Ticker</div>
            <input type="text" value={tickerFilter} onChange={(e) => setTickerFilter(e.target.value)}
              placeholder="(all)" className={`${inputCls} !w-36 uppercase`} />
          </div>
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => { setFromDate(isoOneMonthAgoFromToday()); setToDate(todayISO()); }}
              className={btnSmCls}
            >
              Reset Dates
            </button>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard
          label="YTD Realized P/L"
          value={formatMoney(summary.realizedPL)}
          sub="Filtered by Close Date + Ticker"
          valueClass={summary.realizedPL < 0 ? "text-red-400" : "text-green-400"}
        />
        <MetricCard
          label="Cash Collected"
          value={formatMoney(summary.cashCollected)}
          sub="Filtered by Open Date + Ticker"
          valueClass={summary.cashCollected < 0 ? "text-red-400" : "text-green-400"}
        />
        <MetricCard
          label="Annual ROC"
          value={formatPct01(summary.annualRocSummary)}
          sub="Weighted annual ROC (Close Date filtered)"
          valueClass={summary.annualRocSummary === null ? "text-slate-500" : summary.annualRocSummary < 0 ? "text-red-400" : "text-green-400"}
        />
        <MetricCard
          label="Unrealized P/L"
          value={totalUnrealizedPL === null ? "—" : formatMoney(totalUnrealizedPL)}
          sub="Open positions with live marks"
          valueClass={totalUnrealizedPL === null ? "text-slate-500" : totalUnrealizedPL < 0 ? "text-red-400" : "text-green-400"}
        />
      </div>

      {/* Main table panel */}
      <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <label className="flex gap-2 items-center text-xs font-bold text-slate-500 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={showOpenOnly}
              onChange={(e) => setShowOpenOnly(e.target.checked)}
              className="w-4 h-4"
            />
            Show Open Only
          </label>
        </div>

        <div className="overflow-x-auto">
          <table
            style={{ borderCollapse: "separate", borderSpacing: 0, width: "max-content", minWidth: "100%", tableLayout: "fixed" }}
          >
            <thead>
              <tr>
                <Th style={{ width: 40 }} />
                <Th style={{ width: 66, position: "sticky", left: 0, zIndex: 6, background: "var(--fv-card)", boxShadow: "inset -1px 0 0 rgba(148,163,184,0.16)" }}>
                  Ticker
                </Th>
                <Th style={{ width: 70 }}>Type</Th>
                <Th style={{ width: 88 }}>Event</Th>
                <Th style={{ width: 73 }}>Strike</Th>
                <Th style={{ width: 81 }}>
                  <div className="flex items-center gap-1.5">
                    <span>Open Dt</span>
                    <SortIcon active={sortSpec.field === "openDate"} dir={sortSpec.dir} onClick={() => toggleSort("openDate")} title="Sort by Open Date" />
                  </div>
                </Th>
                <Th style={{ width: 81 }}>
                  <div className="flex items-center gap-1.5">
                    <span>Close Dt</span>
                    <SortIcon active={sortSpec.field === "closeDate"} dir={sortSpec.dir} onClick={() => toggleSort("closeDate")} title="Sort by Close Date" />
                  </div>
                </Th>
                <Th style={{ width: 81 }}>
                  <div className="flex items-center gap-1.5">
                    <span>Expiry Dt</span>
                    <SortIcon active={sortSpec.field === "expiry"} dir={sortSpec.dir} onClick={() => toggleSort("expiry")} title="Sort by Expiry" />
                  </div>
                </Th>
                <Th style={{ width: 52 }}>Qty</Th>
                <Th style={{ width: 59 }}>Fill</Th>
                <Th style={{ width: 59 }}>Close</Th>
                <Th style={{ width: 95 }}>P/L</Th>
                <Th style={{ width: 81 }}>UN.P/L</Th>
              </tr>
            </thead>

            <tbody>
              {loading ? (
                <tr className="border-t border-white/[0.06]">
                  <Td colSpan={13} className="text-slate-500">Loading…</Td>
                </tr>
              ) : listRows.length === 0 ? (
                <tr className="border-t border-white/[0.06]">
                  <Td colSpan={13} className="text-slate-500">No transactions match the current filters.</Td>
                </tr>
              ) : (
                listRows.map((r) => {
                  const isExpanded = expanded.has(r.id);
                  const rowBg = r._isOpen ? "rgba(251, 191, 36, 0.10)" : "transparent";
                  const stickyBg = r._isOpen ? "rgba(251, 191, 36, 0.10)" : "var(--fv-card)";
                  return (
                    <FragmentRow
                      key={r.id}
                      row={r}
                      rowBg={rowBg}
                      stickyBg={stickyBg}
                      isExpanded={isExpanded}
                      onToggle={() => toggleExpanded(r.id)}
                      formatMoney={formatMoney}
                      marks={marks}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ── Row components ─────────────────────────────────────────── */

function FragmentRow({ row, rowBg, stickyBg, isExpanded, onToggle, formatMoney, marks }) {
  const c = row._calc || {};
  const pl = c.pl;
  const markPrice = (marks || {})[markKey(row)];
  const unpl = calcUnrealizedPL(row, markPrice);

  return (
    <>
      <tr
        className="border-t border-white/[0.06]"
        style={{
          background: rowBg,
          boxShadow: row._isOpen ? "inset 0 0 0 1px rgba(251, 191, 36, 0.22)" : "none",
        }}
      >
        <Td>
          <button type="button" onClick={onToggle} className={chevCls} title={isExpanded ? "Collapse" : "Expand"}>
            {isExpanded ? "▾" : "▸"}
          </button>
        </Td>
        <Td style={{ position: "sticky", left: 0, zIndex: 5, background: stickyBg, boxShadow: "inset -1px 0 0 rgba(148,163,184,0.12)" }}>
          <span className="font-black text-sm" style={{ color: row._isOpen ? undefined : "var(--fv-text)" }}>{row.ticker}</span>
        </Td>
        <Td>
          <Badge variant={String(row.type || "").toUpperCase() === "BUY" ? "buy" : String(row.type || "").toUpperCase() === "SELL" ? "sell" : "summary"}>{row.type}</Badge>
        </Td>
        <Td style={{ whiteSpace: "nowrap" }}>
          {(() => { const e = String(row.event || ""); return e.charAt(0).toUpperCase() + e.slice(1).toLowerCase(); })()}
        </Td>
        <Td style={{ whiteSpace: "normal", wordBreak: "break-word", lineHeight: 1.25 }}>{row.strikes}</Td>
        <Td>{row.openDate || "-"}</Td>
        <Td>{row.closeDate || "-"}</Td>
        <Td>{row.expiry || "-"}</Td>
        <Td>{row.qty}</Td>
        <Td>{row.fill === "" ? "" : formatMoney(row.fill)}</Td>
        <Td>{row.closePrice === "" ? "" : formatMoney(row.closePrice)}</Td>
        <Td>
          <span className="font-black text-xs" style={{ color: pl === null ? "#64748B" : plColor(pl) }}>
            {pl === null ? "OPEN" : formatMoney(pl)}
          </span>
        </Td>
        <Td>
          <span className="font-black text-xs" style={{ color: unpl === null ? "#64748B" : plColor(unpl) }}>
            {unpl === null ? "-" : formatMoney(unpl)}
          </span>
        </Td>
      </tr>

      {isExpanded ? <Tier2DetailsRow row={row} /> : null}
    </>
  );
}

function Tier2DetailsRow({ row }) {
  const pl = calcPL(row);
  const days = row.closeDate ? daysBetweenISO(row.openDate, row.closeDate) : null;
  const effectiveCollateral = getEffectiveCollateral(row);
  const roc = pl !== null && effectiveCollateral > 0 ? pl / effectiveCollateral : null;
  const anl = roc !== null && days ? (roc / days) * 365 : null;
  const defaultCollateral = calcDefaultCollateral(row);
  const collateralDisplay = (row.collateral !== "" && row.collateral !== null && row.collateral !== undefined && String(row.collateral).trim() !== "")
    ? row.collateral : defaultCollateral;

  return (
    <tr className="border-t border-white/[0.06]">
      <Td colSpan={13} className="pt-2.5">
        <div className="rounded-xl border border-white/[0.06] bg-[#080D1A]/20 p-3">
          <div className="grid gap-3" style={{ gridTemplateColumns: "minmax(160px,1fr) minmax(220px,1.6fr) minmax(160px,1fr)" }}>
            <DetailReadOnly label={`Collateral (default: ${defaultCollateral || "—"})`} value={collateralDisplay || "—"} />
            <DetailReadOnly label="Roll Over" value={row.rollOver || "—"} />
            <DetailReadOnly
              label="Annual ROC"
              value={anl === null ? "—" : formatPct01(anl)}
              valueColor={anl === null ? "#64748B" : plColor(anl)}
            />
            <DetailReadOnly label="Country" value={row.country || "USA"} />
            <div style={{ gridColumn: "1 / -1" }}>
              <DetailReadOnly label="Notes" value={row.notes || "—"} />
            </div>
          </div>
          <div className="mt-2.5 text-xs text-slate-500">
            Annual ROC uses: (P/L ÷ Collateral) annualized over days held.
          </div>
        </div>
      </Td>
    </tr>
  );
}

/* ── UI helpers ─────────────────────────────────────────────── */


function DetailReadOnly({ label, value, valueColor }) {
  return (
    <div>
      <div className="text-xs font-bold text-slate-500 mb-1.5">{label}</div>
      <div
        className="w-full px-2.5 py-2.5 rounded-lg border border-white/[0.08] bg-[#080D1A]/20 text-sm font-black"
        style={{ color: valueColor || "#F9FAFB" }}
      >
        {value}
      </div>
    </div>
  );
}

function SortIcon({ active, dir, onClick, title }) {
  const arrow = !active ? "⇅" : dir === "asc" ? "↑" : "↓";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={[
        "border rounded-lg px-1.5 py-0.5 text-[11px] font-black leading-none cursor-pointer transition-colors",
        active
          ? "border-blue-500/[0.4] bg-blue-500/[0.15] text-slate-200"
          : "border-white/[0.08] bg-transparent text-slate-500 hover:text-slate-300",
      ].join(" ")}
    >
      {arrow}
    </button>
  );
}

function Th({ children, align, style, className }) {
  return (
    <th
      className={`text-xs font-bold uppercase tracking-widest text-slate-500 px-2.5 py-2.5 whitespace-nowrap border-b border-white/[0.06] ${align === "right" ? "text-right" : "text-left"} ${className || ""}`}
      style={style}
    >
      {children}
    </th>
  );
}

function Td({ children, colSpan, align, className, style }) {
  return (
    <td
      className={`text-sm text-slate-300 px-2.5 py-2.5 align-top overflow-hidden ${align === "right" ? "text-right" : ""} ${className || ""}`}
      colSpan={colSpan}
      style={style}
    >
      {children}
    </td>
  );
}

/* ── Constants ───────────────────────────────────────────────── */

const inputCls = "w-full bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2.5 text-slate-200 text-sm outline-none focus:border-blue-500/[0.4] transition-colors";
const chevCls = "w-7 h-7 rounded-lg border border-white/[0.08] bg-white/[0.04] text-slate-300 font-black cursor-pointer hover:bg-white/[0.08] text-xs inline-flex items-center justify-center";
const btnSmCls = "text-xs font-bold text-slate-400 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08] hover:text-slate-200 transition-all cursor-pointer whitespace-nowrap";
