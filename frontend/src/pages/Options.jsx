import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { MetricCard } from "../components/ui/MetricCard.jsx";
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

function formatMoney(n) {
  const x = safeNum(n, 0);
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
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
  if (typeU === "ASSIGNED") return (close - fill - fee / 100) * qty * 100;
  if (typeU === "SDI") return (close - fill) * qty - fee;
  return null;
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

function blankNewRow() {
  return {
    ticker: "SPY", type: "SELL", event: "", strikes: "",
    openDate: todayISO(), expiry: "", qty: "", fill: "",
    closePrice: "", fee: "", collateral: "", rollOver: "", closeDate: "", notes: "",
  };
}

function normalizeItem(it) {
  const id = it.txId || it.assetId || it.id;
  const rollOver = it.rollOver ?? it.rollover ?? it.roll_over ?? it.rollOverFlag ?? "";
  const notes = it.notes ?? it.note ?? it.memo ?? "";
  const closeDate = it.closeDate ?? it.close_date ?? "";
  const collateral = it.collateral ?? it.coll ?? it.margin ?? "";
  return { ...it, id, collateral, rollOver, closeDate, notes };
}

function toPayload(d) {
  const effectiveCollateral = getEffectiveCollateral(d);
  const payload = {
    ticker: String(d.ticker || "").toUpperCase().trim(),
    type: String(d.type || "").trim(),
    event: String(d.event || "").trim(),
    strikes: String(d.strikes || "").trim(),
    openDate: String(d.openDate || "").slice(0, 10),
    expiry: String(d.expiry || "").slice(0, 10),
    qty: d.qty === "" ? "" : Number(d.qty),
    fill: d.fill === "" ? "" : Number(d.fill),
    closePrice: d.closePrice === "" ? "" : Number(d.closePrice),
    fee: d.fee === "" ? "" : Number(d.fee),
    collateral: effectiveCollateral,
    coll: effectiveCollateral,
    rollOver: String(d.rollOver || "").trim(),
    rollover: String(d.rollOver || "").trim(),
    roll_over: String(d.rollOver || "").trim(),
    closeDate: String(d.closeDate || "").slice(0, 10),
    notes: String(d.notes || "").trim(),
  };
  if (!payload.ticker) throw new Error("Ticker is required");
  if (!payload.type) throw new Error("Type is required");
  if (!payload.openDate) throw new Error("Open Date is required");
  if (payload.qty === "" || !Number.isFinite(payload.qty) || payload.qty <= 0)
    throw new Error("Qty must be a positive number");
  if (payload.fill === "" || !Number.isFinite(payload.fill) || payload.fill <= 0)
    throw new Error("Fill must be a positive number");
  if (!Number.isFinite(payload.collateral) || payload.collateral <= 0)
    throw new Error("Collateral must be a positive number (strike × qty × 100 or override)");
  return payload;
}

/* ================================================================
   COMPONENT
================================================================ */

export default function Options() {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");

  const [expanded, setExpanded] = useState(() => new Set());
  const [newDraft, setNewDraft] = useState(blankNewRow());
  const [editId, setEditId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);

  const [fromDate, setFromDate] = useState(isoOneMonthAgoFromToday());
  const [toDate, setToDate] = useState(todayISO());

  const [showOpenOnly, setShowOpenOnly] = useState(false);
  const [tickerFilter, setTickerFilter] = useState("");
  const [sortMode, setSortMode] = useState("openDate_desc");

  const queryClient = useQueryClient();

  /* ---------- Data query ---------- */

  const { data: rawData, isLoading: loading } = useQuery({
    queryKey: queryKeys.optionsTx(),
    queryFn: () => api.get("/assets/options/transactions"),
  });

  const rows = useMemo(() => {
    const items = Array.isArray(rawData?.items) ? rawData.items : Array.isArray(rawData) ? rawData : [];
    return items.map(normalizeItem);
  }, [rawData]);

  /* ---------- Mutations ---------- */

  const addMut = useMutation({
    mutationFn: (payload) => api.post("/assets/options/transactions", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.optionsTx() });
      setNewDraft(blankNewRow());
    },
    onError: (e) => setError(e?.message || "Add failed"),
    onSettled: () => setBusyId(null),
  });

  const patchMut = useMutation({
    mutationFn: ({ id, payload }) =>
      api.patch(`/assets/options/transactions/${encodeURIComponent(id)}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.optionsTx() });
      cancelEdit();
    },
    onError: (e) => setError(e?.message || "Save failed"),
    onSettled: () => setBusyId(null),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => api.delete(`/assets/options/transactions/${encodeURIComponent(id)}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.optionsTx() });
      if (editId === id) cancelEdit();
      setExpanded((prev) => { const next = new Set(prev); next.delete(id); return next; });
    },
    onError: (e) => setError(e?.message || "Delete failed"),
    onSettled: () => setBusyId(null),
  });

  /* ---------- Date-picker CSS injection ---------- */

  useEffect(() => {
    const __dpId = "fv-date-picker-white";
    if (typeof document !== "undefined" && !document.getElementById(__dpId)) {
      const s = document.createElement("style");
      s.id = __dpId;
      s.textContent = 'input[type="date"]::-webkit-calendar-picker-indicator{filter:invert(1);opacity:0.9;}';
      document.head.appendChild(s);
    }
  }, []);

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

  const computedBase = useMemo(() => {
    return rows.map((r) => {
      const pl = calcPL(r);
      const days = r.closeDate ? daysBetweenISO(r.openDate, r.closeDate) : null;
      const collateral = getEffectiveCollateral(r);
      const roc = pl !== null && collateral > 0 ? pl / collateral : null;
      const anl = roc !== null && days ? (roc / days) * 365 : null;
      return { ...r, _calc: { pl, days, collateral, anl }, _isOpen: pl === null };
    });
  }, [rows]);

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

  function startEdit(row) {
    setError("");
    setEditId(row.id);
    setEditDraft({
      ticker: row.ticker ?? "", type: row.type ?? "", event: row.event ?? "",
      strikes: row.strikes ?? "", openDate: row.openDate ?? "", expiry: row.expiry ?? "",
      qty: row.qty ?? "", fill: row.fill ?? "", closePrice: row.closePrice ?? "",
      fee: row.fee ?? "", collateral: row.collateral ?? "", rollOver: row.rollOver ?? "",
      closeDate: row.closeDate ?? "", notes: row.notes ?? "",
    });
    setExpanded((prev) => new Set(prev).add(row.id));
  }

  function cancelEdit() { setEditId(null); setEditDraft(null); }

  function saveEdit(id) {
    setError("");
    let payload;
    try {
      payload = toPayload(editDraft);
    } catch (e) {
      setError(e?.message || "Validation failed");
      return;
    }
    setBusyId(id);
    patchMut.mutate({ id, payload });
  }

  function addRow() {
    setError("");
    let payload;
    try {
      payload = toPayload(newDraft);
    } catch (e) {
      setError(e?.message || "Validation failed");
      return;
    }
    setBusyId("__new__");
    addMut.mutate(payload);
  }

  function deleteRow(id) {
    if (!window.confirm("Delete this options transaction?")) return;
    setError("");
    setBusyId(id);
    deleteMut.mutate(id);
  }

  const anyBusy = loading || busyId !== null;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-2xl font-black text-slate-100 tracking-tight" style={{ fontFamily: "Epilogue, sans-serif" }}>
          Options
        </h1>
        <button
          type="button"
          onClick={() => queryClient.invalidateQueries({ queryKey: queryKeys.optionsTx() })}
          className={btnSmCls}
          disabled={anyBusy}
        >
          Refresh
        </button>
      </div>

      {/* Summary filter bar */}
      <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-3">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <div className="text-xs font-bold text-slate-500 mb-1.5">From</div>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
              className={`${inputCls} !w-44`} disabled={anyBusy} />
          </div>
          <div>
            <div className="text-xs font-bold text-slate-500 mb-1.5">To</div>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
              className={`${inputCls} !w-44`} disabled={anyBusy} />
          </div>
          <div>
            <div className="text-xs font-bold text-slate-500 mb-1.5">Ticker</div>
            <input type="text" value={tickerFilter} onChange={(e) => setTickerFilter(e.target.value)}
              placeholder="(all)" className={`${inputCls} !w-36 uppercase`} disabled={anyBusy} />
          </div>
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => { setFromDate(isoOneMonthAgoFromToday()); setToDate(todayISO()); }}
              className={btnSmCls}
              disabled={anyBusy}
            >
              Reset Dates
            </button>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <MetricCard
          label="Realized P/L"
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
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/[0.3] bg-red-500/[0.08] px-3 py-2.5">
          <div className="text-xs font-bold text-slate-100">Error</div>
          <div className="mt-1 text-xs text-slate-300">{error}</div>
        </div>
      )}

      {/* Main table panel */}
      <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <label className="flex gap-2 items-center text-xs font-bold text-slate-500 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={showOpenOnly}
              onChange={(e) => setShowOpenOnly(e.target.checked)}
              disabled={anyBusy}
              className="w-4 h-4"
            />
            Show Open Only
          </label>
        </div>

        <div className="overflow-x-auto">
          <table
            className="w-full"
            style={{ borderCollapse: "separate", borderSpacing: 0 }}
          >
            <thead>
              <tr>
                <Th style={{ width: 40 }} />
                <Th style={{ width: 110, position: "sticky", left: 0, zIndex: 6, background: "#0F1729", boxShadow: "inset -1px 0 0 rgba(148,163,184,0.16)" }}>
                  Ticker
                </Th>
                <Th style={{ width: 80 }}>Type</Th>
                <Th style={{ width: 80 }}>Event</Th>
                <Th style={{ width: 73 }}>Strike</Th>
                <Th style={{ width: 133 }}>
                  <div className="flex items-center gap-1.5">
                    <span>Open Dt</span>
                    <SortIcon active={sortSpec.field === "openDate"} dir={sortSpec.dir} onClick={() => toggleSort("openDate")} title="Sort by Open Date" />
                  </div>
                </Th>
                <Th style={{ width: 133 }}>
                  <div className="flex items-center gap-1.5">
                    <span>Close Dt</span>
                    <SortIcon active={sortSpec.field === "closeDate"} dir={sortSpec.dir} onClick={() => toggleSort("closeDate")} title="Sort by Close Date" />
                  </div>
                </Th>
                <Th style={{ width: 133 }}>
                  <div className="flex items-center gap-1.5">
                    <span>Expiry Dt</span>
                    <SortIcon active={sortSpec.field === "expiry"} dir={sortSpec.dir} onClick={() => toggleSort("expiry")} title="Sort by Expiry" />
                  </div>
                </Th>
                <Th style={{ width: 70 }}>Qty</Th>
                <Th style={{ width: 69 }}>Fill</Th>
                <Th style={{ width: 69 }}>Close</Th>
                <Th style={{ width: 80 }}>Fee</Th>
                <Th style={{ width: 95 }}>P/L</Th>
                <Th align="right" style={{ width: 120 }}>Actions</Th>
              </tr>
            </thead>

            <tbody>
              <Tier1Row
                expanded={expanded.has("__new__")}
                toggle={() => toggleExpanded("__new__")}
                row={newDraft}
                setRow={setNewDraft}
                busy={busyId !== null}
                onPrimary={addRow}
                primaryLabel={busyId === "__new__" ? "Adding…" : "Add"}
              />

              {loading ? (
                <tr className="border-t border-white/[0.06]">
                  <Td colSpan={14} className="text-slate-500">Loading…</Td>
                </tr>
              ) : listRows.length === 0 ? (
                <tr className="border-t border-white/[0.06]">
                  <Td colSpan={14} className="text-slate-500">No transactions match the current filters.</Td>
                </tr>
              ) : (
                listRows.map((r) => {
                  const isEditing = editId === r.id;
                  const isExpanded = expanded.has(r.id);
                  const rowBg = r._isOpen ? "rgba(251, 191, 36, 0.10)" : "transparent";
                  const stickyBg = r._isOpen ? "rgba(251, 191, 36, 0.10)" : "#0F1729";
                  return (
                    <FragmentRow
                      key={r.id}
                      row={r}
                      rowBg={rowBg}
                      stickyBg={stickyBg}
                      isExpanded={isExpanded}
                      onToggle={() => toggleExpanded(r.id)}
                      isEditing={isEditing}
                      editDraft={editDraft}
                      setEditDraft={setEditDraft}
                      onEdit={() => startEdit(r)}
                      onSave={() => saveEdit(r.id)}
                      onCancel={cancelEdit}
                      onDelete={() => deleteRow(r.id)}
                      busyId={busyId}
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

function Tier1Row({ expanded, toggle, row, setRow, busy, onPrimary, primaryLabel }) {
  const pl = calcPL(row);
  const panelBg = "#0F1729";

  return (
    <>
      <tr className="border-t border-white/[0.06]">
        <Td>
          <button type="button" onClick={toggle} className={chevCls} title={expanded ? "Collapse" : "Expand"}>
            {expanded ? "▾" : "▸"}
          </button>
        </Td>
        <Td style={{ position: "sticky", left: 0, zIndex: 5, background: panelBg, boxShadow: "inset -1px 0 0 rgba(148,163,184,0.12)" }}>
          <input value={row.ticker ?? ""} onChange={(e) => setRow((d) => ({ ...d, ticker: e.target.value.toUpperCase() }))}
            className={`${IC} w-24 font-black`} />
        </Td>
        <Td>
          <input value={row.type ?? ""} onChange={(e) => setRow((d) => ({ ...d, type: e.target.value.toUpperCase() }))}
            className={`${IC} w-[70px] font-black`} />
        </Td>
        <Td style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
          <input value={row.event ?? ""} onChange={(e) => setRow((d) => ({ ...d, event: e.target.value }))}
            className={`${IC} w-full`} />
        </Td>
        <Td style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
          <input value={row.strikes ?? ""} onChange={(e) => setRow((d) => ({ ...d, strikes: e.target.value }))}
            className={`${IC} w-full`} />
        </Td>
        <Td>
          <input type="date" value={row.openDate ?? ""} onChange={(e) => setRow((d) => ({ ...d, openDate: e.target.value }))}
            className={`${IC} w-32`} />
        </Td>
        <Td>
          <input type="date" value={row.closeDate ?? ""} onChange={(e) => setRow((d) => ({ ...d, closeDate: e.target.value }))}
            className={`${IC} w-32`} />
        </Td>
        <Td>
          <input type="date" value={row.expiry ?? ""} onChange={(e) => setRow((d) => ({ ...d, expiry: e.target.value }))}
            className={`${IC} w-32`} />
        </Td>
        <Td>
          <input value={row.qty ?? ""} onChange={(e) => setRow((d) => ({ ...d, qty: e.target.value }))}
            className={`${IC} w-16`} inputMode="decimal" />
        </Td>
        <Td>
          <input value={row.fill ?? ""} onChange={(e) => setRow((d) => ({ ...d, fill: e.target.value }))}
            className={`${IC} w-[70px]`} inputMode="decimal" />
        </Td>
        <Td>
          <input value={row.closePrice ?? ""} onChange={(e) => setRow((d) => ({ ...d, closePrice: e.target.value }))}
            className={`${IC} w-[70px]`} inputMode="decimal" />
        </Td>
        <Td>
          <input value={row.fee ?? ""} onChange={(e) => setRow((d) => ({ ...d, fee: e.target.value }))}
            className={`${IC} w-[70px]`} inputMode="decimal" />
        </Td>
        <Td>
          <span className="font-black text-xs" style={{ color: pl === null ? "#64748B" : plColor(pl) }}>
            {pl === null ? "OPEN" : formatMoney(pl)}
          </span>
        </Td>
        <Td align="right">
          <button type="button" onClick={onPrimary} className={btnPrimSmCls} disabled={busy}>
            {primaryLabel}
          </button>
        </Td>
      </tr>
      {expanded ? <Tier2DetailsRow row={row} setRow={setRow} /> : null}
    </>
  );
}

function FragmentRow({ row, rowBg, stickyBg, isExpanded, onToggle, isEditing, editDraft, setEditDraft, onEdit, onSave, onCancel, onDelete, busyId }) {
  const c = row._calc || {};
  const isBusy = busyId !== null;
  const displayed = isEditing ? editDraft : row;
  const setDisplayed = isEditing ? setEditDraft : null;
  const pl = isEditing ? calcPL(displayed) : c.pl;

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
          {isEditing ? (
            <input value={displayed.ticker ?? ""} onChange={(e) => setDisplayed((d) => ({ ...d, ticker: e.target.value.toUpperCase() }))}
              className={`${IC} w-24 font-black`} />
          ) : (
            <span className="font-black text-slate-100 text-sm">{row.ticker}</span>
          )}
        </Td>

        <Td>
          {isEditing ? (
            <input value={displayed.type ?? ""} onChange={(e) => setDisplayed((d) => ({ ...d, type: e.target.value.toUpperCase() }))}
              className={`${IC} w-[70px] font-black`} />
          ) : <Badge variant={String(row.type || "").toUpperCase() === "BUY" ? "buy" : String(row.type || "").toUpperCase() === "SELL" ? "sell" : "summary"}>{row.type}</Badge>}
        </Td>

        <Td style={{ whiteSpace: "normal", wordBreak: "break-word", lineHeight: 1.25 }}>
          {isEditing ? (
            <input value={displayed.event ?? ""} onChange={(e) => setDisplayed((d) => ({ ...d, event: e.target.value }))}
              className={`${IC} w-full`} />
          ) : row.event}
        </Td>

        <Td style={{ whiteSpace: "normal", wordBreak: "break-word", lineHeight: 1.25 }}>
          {isEditing ? (
            <input value={displayed.strikes ?? ""} onChange={(e) => setDisplayed((d) => ({ ...d, strikes: e.target.value }))}
              className={`${IC} w-full`} />
          ) : row.strikes}
        </Td>

        <Td>
          {isEditing ? (
            <input type="date" value={displayed.openDate ?? ""} onChange={(e) => setDisplayed((d) => ({ ...d, openDate: e.target.value }))}
              className={`${IC} w-32`} />
          ) : (row.openDate || "-")}
        </Td>

        <Td>
          {isEditing ? (
            <input type="date" value={displayed.closeDate ?? ""} onChange={(e) => setDisplayed((d) => ({ ...d, closeDate: e.target.value }))}
              className={`${IC} w-32`} />
          ) : (row.closeDate || "-")}
        </Td>

        <Td>
          {isEditing ? (
            <input type="date" value={displayed.expiry ?? ""} onChange={(e) => setDisplayed((d) => ({ ...d, expiry: e.target.value }))}
              className={`${IC} w-32`} />
          ) : (row.expiry || "-")}
        </Td>

        <Td>
          {isEditing ? (
            <input value={displayed.qty ?? ""} onChange={(e) => setDisplayed((d) => ({ ...d, qty: e.target.value }))}
              className={`${IC} w-16`} inputMode="decimal" />
          ) : row.qty}
        </Td>

        <Td>
          {isEditing ? (
            <input value={displayed.fill ?? ""} onChange={(e) => setDisplayed((d) => ({ ...d, fill: e.target.value }))}
              className={`${IC} w-[70px]`} inputMode="decimal" />
          ) : (row.fill === "" ? "" : formatMoney(row.fill))}
        </Td>

        <Td>
          {isEditing ? (
            <input value={displayed.closePrice ?? ""} onChange={(e) => setDisplayed((d) => ({ ...d, closePrice: e.target.value }))}
              className={`${IC} w-[70px]`} inputMode="decimal" />
          ) : (row.closePrice === "" ? "" : formatMoney(row.closePrice))}
        </Td>

        <Td>
          {isEditing ? (
            <input value={displayed.fee ?? ""} onChange={(e) => setDisplayed((d) => ({ ...d, fee: e.target.value }))}
              className={`${IC} w-[70px]`} inputMode="decimal" />
          ) : (row.fee === "" ? "" : formatMoney(row.fee))}
        </Td>

        <Td>
          <span className="font-black text-xs" style={{ color: pl === null ? "#64748B" : plColor(pl) }}>
            {pl === null ? "OPEN" : formatMoney(pl)}
          </span>
        </Td>

        <Td align="right">
          {isEditing ? (
            <div className="flex gap-1.5 justify-end flex-nowrap">
              <button type="button" onClick={onSave} className={btnPrimSmCls} disabled={isBusy}>
                {busyId === row.id ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={onCancel} className={btnSmSmCls} disabled={isBusy}>Cancel</button>
            </div>
          ) : (
            <div className="flex gap-1.5 justify-end flex-nowrap">
              <button type="button" onClick={onEdit} className={btnSmSmCls} disabled={isBusy}>Edit</button>
              <button type="button" onClick={onDelete} className={btnDanSmCls} disabled={isBusy}>
                {busyId === row.id ? "Deleting…" : "Delete"}
              </button>
            </div>
          )}
        </Td>
      </tr>

      {isExpanded ? (
        <Tier2DetailsRow row={isEditing ? editDraft : row} setRow={isEditing ? setEditDraft : null} />
      ) : null}
    </>
  );
}

function Tier2DetailsRow({ row, setRow }) {
  const isEditable = typeof setRow === "function";
  const pl = calcPL(row);
  const days = row.closeDate ? daysBetweenISO(row.openDate, row.closeDate) : null;
  const effectiveCollateral = getEffectiveCollateral(row);
  const roc = pl !== null && effectiveCollateral > 0 ? pl / effectiveCollateral : null;
  const anl = roc !== null && days ? (roc / days) * 365 : null;
  const defaultCollateral = calcDefaultCollateral(row);

  return (
    <tr className="border-t border-white/[0.06]">
      <Td colSpan={14} className="pt-2.5">
        <div className="rounded-xl border border-white/[0.06] bg-[#080D1A]/20 p-3">
          <div className="grid gap-3" style={{ gridTemplateColumns: "minmax(160px,1fr) minmax(220px,1.6fr) minmax(160px,1fr)" }}>
            <DetailField
              label={`Collateral (default: ${defaultCollateral || "—"})`}
              value={
                row.collateral !== "" && row.collateral !== null && row.collateral !== undefined && String(row.collateral).trim() !== ""
                  ? row.collateral
                  : defaultCollateral
              }
              onChange={isEditable ? (v) => setRow((d) => ({ ...d, collateral: v })) : null}
              inputMode="decimal"
              placeholder="Auto from strike×qty×100"
            />
            <DetailField
              label="Roll Over"
              value={row.rollOver ?? ""}
              onChange={isEditable ? (v) => setRow((d) => ({ ...d, rollOver: v })) : null}
              placeholder="Optional"
            />
            <DetailReadOnly
              label="Annual ROC"
              value={anl === null ? "—" : formatPct01(anl)}
              valueColor={anl === null ? "#64748B" : plColor(anl)}
            />
            <div style={{ gridColumn: "1 / -1" }}>
              <DetailField
                label="Notes"
                value={row.notes ?? ""}
                onChange={isEditable ? (v) => setRow((d) => ({ ...d, notes: v })) : null}
                placeholder="Optional"
                multiline
              />
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

function DetailField({ label, value, onChange, type = "text", placeholder, inputMode, multiline = false }) {
  const editable = typeof onChange === "function";
  return (
    <div>
      <div className="text-xs font-bold text-slate-500 mb-1.5">{label}</div>
      {editable ? (
        multiline ? (
          <textarea
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className={`${IC} min-h-[92px] resize-vertical w-full`}
          />
        ) : (
          <input
            type={type}
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            inputMode={inputMode}
            className={`${IC} w-full`}
          />
        )
      ) : (
        <div className="w-full px-2.5 py-2.5 rounded-lg border border-white/[0.08] bg-[#080D1A]/20 text-sm text-slate-200 whitespace-pre-wrap">
          {String(value || "—")}
        </div>
      )}
    </div>
  );
}

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

const inputCls = "w-full bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2.5 text-slate-200 text-sm outline-none focus:border-blue-500/[0.4] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
// Compact input for use inside table cells
const IC = "px-2 py-1.5 bg-[#080D1A] border border-white/[0.08] rounded-lg text-slate-200 text-xs outline-none focus:border-blue-500/[0.4] transition-colors";
const btnSmCls = "text-xs font-bold text-slate-400 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08] hover:text-slate-200 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
const chevCls = "w-7 h-7 rounded-lg border border-white/[0.08] bg-white/[0.04] text-slate-300 font-black cursor-pointer hover:bg-white/[0.08] text-xs inline-flex items-center justify-center";
const btnPrimSmCls = "text-xs font-bold text-slate-100 px-2.5 py-1.5 rounded-lg border border-blue-500/[0.3] bg-blue-500/[0.15] hover:bg-blue-500/[0.25] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
const btnSmSmCls = "text-xs font-bold text-slate-400 px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08] hover:text-slate-200 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";
const btnDanSmCls = "text-xs font-bold text-red-400 px-2.5 py-1.5 rounded-lg border border-red-500/[0.3] bg-red-500/[0.08] hover:bg-red-500/[0.15] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";
