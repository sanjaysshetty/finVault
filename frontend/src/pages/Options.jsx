import { useEffect, useMemo, useState } from "react";

/* ---------------- Theme (FinVault-like) ---------------- */

const THEME = {
  pageText: "#CBD5F5",
  title: "#F9FAFB",
  muted: "#94A3B8",
  panelBg: "rgba(15, 23, 42, 0.65)",
  panelBorder: "rgba(148, 163, 184, 0.16)",
  rowBorder: "rgba(148, 163, 184, 0.12)",
  inputBg: "rgba(2, 6, 23, 0.45)",
  inputBorder: "rgba(148, 163, 184, 0.18)",
  primaryBg: "rgba(99, 102, 241, 0.18)",
  primaryBorder: "rgba(99, 102, 241, 0.45)",
  dangerBg: "rgba(239, 68, 68, 0.12)",
  dangerBorder: "rgba(239, 68, 68, 0.35)",
  openRowBg: "rgba(251, 191, 36, 0.10)",
  openRowBorder: "rgba(251, 191, 36, 0.22)",
};

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

  // Set to first of month to avoid overflow, then restore day clamp
  const temp = new Date(year, month, 1);
  temp.setMonth(temp.getMonth() - 1);
  const lastDayOfTargetMonth = new Date(temp.getFullYear(), temp.getMonth() + 1, 0).getDate();
  temp.setDate(Math.min(day, lastDayOfTargetMonth));

  // Convert to ISO date in UTC representation (ok for filtering YYYY-MM-DD strings)
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

/**
 * Extract a numeric strike from the Strike cell.
 * Accepts "650", "650.00", "650C", "650/645" (takes first number).
 */
function parseStrikeNumber(strikes) {
  if (strikes === null || strikes === undefined) return null;
  const s = String(strikes).trim();
  const m = s.match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Default collateral = strike * qty * 100
 */
function calcDefaultCollateral(row) {
  const strike = parseStrikeNumber(row.strikes);
  const qty = safeNum(row.qty, NaN);
  if (!Number.isFinite(strike) || !Number.isFinite(qty) || qty <= 0) return "";
  return String(Math.round(strike * qty * 100 * 100) / 100);
}

/**
 * If user has entered collateral, use it; else use default computed collateral.
 */
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

/**
 * P/L (Excel-like)
 * If Close blank -> null (OPEN)
 */
function calcPL(row) {
  const typeU = String(row.type || "").trim().toUpperCase();
  const qty = safeNum(row.qty, 0);
  const fill = safeNum(row.fill, 0);

  const closeBlank =
    row.closePrice === "" || row.closePrice === null || row.closePrice === undefined;
  const close = closeBlank ? null : safeNum(row.closePrice, NaN);

  const fee = safeNum(row.fee, 0);
  if (close === null || !Number.isFinite(close)) return null;

  // Keeping your previous fee handling (fee/100) so numbers don't jump unexpectedly
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

/* ---------------- API helpers ---------------- */

function getApiBase() {
  const envBase = (import.meta.env.VITE_API_BASE_URL || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const winBase = (window.__FINVAULT_API_BASE_URL || "").trim?.() || "";
  if (winBase) return winBase.replace(/\/+$/, "");
  return "";
}

function getAccessToken() {
  return (
    sessionStorage.getItem("finvault.accessToken") ||
    sessionStorage.getItem("access_token") ||
    ""
  );
}

async function apiFetch(path, { method = "GET", body } = {}) {
  const base = getApiBase();
  if (!base) throw new Error("Missing API base. Set VITE_API_BASE_URL in .env");

  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const token = getAccessToken();

  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const text = await res.text().catch(() => "");
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`API returned non-JSON (${res.status})`);
  }

  if (!res.ok) throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
  return data;
}

/* ---------------- model ---------------- */

function blankNewRow() {
  return {
    ticker: "SPY",
    type: "SELL",
    event: "",
    strikes: "",
    openDate: todayISO(),
    expiry: "",
    qty: "",
    fill: "",
    closePrice: "",
    fee: "",
    // tier 2
    collateral: "",
    rollOver: "",
    closeDate: "",
    notes: "",
  };
}

function normalizeItem(it) {
  const id = it.txId || it.assetId || it.id;
  return {
    ...it,
    id,
    // Normalize common backend variants
    collateral: it.collateral ?? it.coll ?? "",
    rollOver: it.rollOver ?? it.rollover ?? it.roll_over ?? "",
    notes: it.notes ?? it.note ?? it.memo ?? "",
  };
}

function toPayload(d) {
  // collateral: if user hasn't typed, we send the computed default
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
    coll: effectiveCollateral, // backward compat

    rollOver: String(d.rollOver || "").trim(),

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
    throw new Error("Collateral must be a positive number (strike * qty * 100 or override)");

  return payload;
}

/* ---------------- sticky ticker col ---------------- */

const stickyTickerTh = {
  position: "sticky",
  left: 0,
  zIndex: 6,
  background: THEME.panelBg,
  boxShadow: "inset -1px 0 0 rgba(148,163,184,0.16)",
};

function stickyTickerTd(bg) {
  return {
    position: "sticky",
    left: 0,
    zIndex: 5,
    background: bg,
    boxShadow: "inset -1px 0 0 rgba(148,163,184,0.12)",
  };
}

/* ---------------- component ---------------- */

export default function Options() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const [expanded, setExpanded] = useState(() => new Set());

  const [newDraft, setNewDraft] = useState(blankNewRow());

  const [editId, setEditId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);

  // Summary date filters (default last 1 month)
  const [fromDate, setFromDate] = useState(isoOneMonthAgoFromToday());
  const [toDate, setToDate] = useState(todayISO());

  // List filters/sort
  const [showOpenOnly, setShowOpenOnly] = useState(false);
  const [tickerFilter, setTickerFilter] = useState("");
  // openDate_desc (default) | openFirst (OPEN rows appear first)
  const [sortMode, setSortMode] = useState("openDate_desc");

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

  async function load() {
    setLoading(true);
    setError("");
    setStatus("");
    try {
      const res = await apiFetch("/assets/options/transactions");
      const items = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
      setRows(items.map(normalizeItem));
      //setStatus("Up to date.");
    } catch (e) {
      setError(e?.message || "Failed to load options transactions");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // Make date picker icon white (Chromium/WebKit)
    const __dpId = "fv-date-picker-white";
    if (typeof document !== "undefined" && !document.getElementById(__dpId)) {
      const s = document.createElement("style");
      s.id = __dpId;
      s.textContent =
        'input[type="date"]::-webkit-calendar-picker-indicator{filter:invert(1);opacity:0.9;}';
      document.head.appendChild(s);
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const computedBase = useMemo(() => {
    // Compute per-row derived values once
    return rows.map((r) => {
      const pl = calcPL(r);
      const days = r.closeDate ? daysBetweenISO(r.openDate, r.closeDate) : null;

      const collateral = getEffectiveCollateral(r);
      const roc = pl !== null && collateral > 0 ? pl / collateral : null;
      const anl = roc !== null && days ? (roc / days) * 365 : null;

      const isOpen = pl === null;
      return { ...r, _calc: { pl, days, collateral, anl }, _isOpen: isOpen };
    });
  }, [rows]);

  const summary = useMemo(() => {
    const tf = String(tickerFilter || "").toUpperCase().trim();
    const tickerMatch = (r) =>
      !tf || String(r.ticker || "").toUpperCase().includes(tf);

    // Realized P/L filtered by Close Date (and optional Ticker)
    const realizedSet = computedBase.filter(
      (r) => tickerMatch(r) && r._calc.pl !== null && inRangeISO(r.closeDate, fromDate, toDate)
    );
    const realizedPL = realizedSet.reduce((acc, r) => acc + (r._calc.pl ?? 0), 0);

    // Cash Collected filtered by Open Date
    const openDateSet = computedBase.filter((r) => tickerMatch(r) && inRangeISO(r.openDate, fromDate, toDate));
    const realizedPL_openDate = openDateSet.reduce(
      (acc, r) => acc + (r._calc.pl === null ? 0 : r._calc.pl),
      0
    );
    const openCash_openDate = openDateSet.reduce((acc, r) => acc + calcOpenCashFlow(r), 0);
    const cashCollected = realizedPL_openDate + openCash_openDate;

    // Summary Annual ROC: same dataset as realized (Close Date filtered)
    // AnnualROC = ( ΣPL / Σ(collateral * days) ) * 365
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

    // Filter: open only
    if (showOpenOnly) out = out.filter((r) => r._isOpen);

    // Filter: ticker (list-only)
    const tf = String(tickerFilter || "").toUpperCase().trim();
    if (tf) out = out.filter((r) => String(r.ticker || "").toUpperCase().includes(tf));

    // Sort
if (sortMode === "openFirst") {
  out.sort((a, b) => {
    const ao = a._isOpen ? 0 : 1;
    const bo = b._isOpen ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return String(b.openDate || "").localeCompare(String(a.openDate || ""));
  });
} else {
  const { field, dir } = sortSpec;
  out.sort((a, b) => {
    const aRaw = String(a?.[field] || "");
    const bRaw = String(b?.[field] || "");
    const sentinel = dir === "asc" ? "9999-12-31" : "0000-00-00"; // keep blanks at bottom
    const aVal = aRaw || sentinel;
    const bVal = bRaw || sentinel;
    return dir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
  });
}

    return out;
  }, [computedBase, showOpenOnly, tickerFilter, sortMode]);

  function toggleExpanded(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startEdit(row) {
    setError("");
    setEditId(row.id);
    setEditDraft({
      ticker: row.ticker ?? "",
      type: row.type ?? "",
      event: row.event ?? "",
      strikes: row.strikes ?? "",
      openDate: row.openDate ?? "",
      expiry: row.expiry ?? "",
      qty: row.qty ?? "",
      fill: row.fill ?? "",
      closePrice: row.closePrice ?? "",
      fee: row.fee ?? "",
      collateral: row.collateral ?? "",
      rollOver: row.rollOver ?? "",
      closeDate: row.closeDate ?? "",
      notes: row.notes ?? "",
    });
    setExpanded((prev) => new Set(prev).add(row.id));
  }

  function cancelEdit() {
    setEditId(null);
    setEditDraft(null);
  }

  async function saveEdit(id) {
    setError("");
    setBusyId(id);
    try {
      const payload = toPayload(editDraft);
      await apiFetch(`/assets/options/transactions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: payload,
      });
      await load();
      cancelEdit();
    } catch (e) {
      setError(e?.message || "Save failed");
    } finally {
      setBusyId(null);
    }
  }

  async function addRow() {
    setError("");
    setBusyId("__new__");
    try {
      const payload = toPayload(newDraft);
      await apiFetch("/assets/options/transactions", { method: "POST", body: payload });
      setNewDraft(blankNewRow());
      await load();
    } catch (e) {
      setError(e?.message || "Add failed");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteRow(id) {
    if (!window.confirm("Delete this options transaction?")) return;
    setError("");
    setBusyId(id);
    try {
      await apiFetch(`/assets/options/transactions/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
      if (editId === id) cancelEdit();
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (e) {
      setError(e?.message || "Delete failed");
    } finally {
      setBusyId(null);
    }
  }

  const anyBusy = loading || busyId !== null;

  return (
    <div style={{ padding: 16, color: THEME.pageText }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 900, color: THEME.title }}>Options</div>

        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button type="button" onClick={load} style={btnSecondary} disabled={anyBusy}>
            Refresh
          </button>
        </div>
      </div>

      {/* Summary filters + list controls */}
      <div style={{ ...panel, marginTop: 14, padding: 12 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <div style={fieldLabel}>From</div>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              style={{ ...detailsInput, width: 170 }}
              disabled={anyBusy}
            />
          </div>
          <div>
            <div style={fieldLabel}>To</div>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              style={{ ...detailsInput, width: 170 }}
              disabled={anyBusy}
            />
          </div>
          <div>
            <div style={fieldLabel}>Ticker</div>
            <input
              type="text"
              value={tickerFilter}
              onChange={(e) => setTickerFilter(e.target.value)}
              placeholder="(all)"
              style={{ ...detailsInput, width: 140, textTransform: "uppercase" }}
              disabled={anyBusy}
            />
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => {
                setFromDate(isoOneMonthAgoFromToday());
                setToDate(todayISO());
              }}
              style={btnSecondarySmall}
              disabled={anyBusy}
              title="Reset to last 1 month"
            >
              Reset Dates
            </button>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div
        style={{
          marginTop: 12,
          display: "grid",
          gridTemplateColumns: "minmax(160px, 1fr) minmax(220px, 1.6fr) minmax(160px, 1fr)",
          gap: 12,
        }}
      >
        <SummaryCard
          title="Realized P/L"
          value={formatMoney(summary.realizedPL)}
          hint="Filtered by Close Date (From–To) + Ticker"
          valueColor={plColor(summary.realizedPL)}
        />
        <SummaryCard
          title="Cash Collected"
          value={formatMoney(summary.cashCollected)}
          hint="Filtered by Open Date (From–To) + Ticker"
          valueColor={plColor(summary.cashCollected)}
        />
        <SummaryCard
          title="Annual ROC"
          value={formatPct01(summary.annualRocSummary)}
          hint="Weighted annual ROC (Close Date filtered)"
          valueColor={
            summary.annualRocSummary === null ? THEME.muted : plColor(summary.annualRocSummary)
          }
        />
      </div>

      {status ? <div style={{ marginTop: 10, color: THEME.muted, fontSize: 12 }}>{status}</div> : null}

      {error ? (
        <div style={{ marginTop: 12, ...callout }}>
          <div style={{ fontWeight: 900, color: THEME.title }}>Error</div>
          <div style={{ marginTop: 4 }}>{error}</div>
        </div>
      ) : null}

      <div style={{ ...panel, marginTop: 14 }}>
        {/* List-only controls (kept with the table, not the summary filters) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "2px 2px 10px 2px",
          }}
        >
          <label
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              fontSize: 12,
              color: THEME.muted,
              fontWeight: 900,
              userSelect: "none",
            }}
            title="Filter the list to only show OPEN trades"
          >
            <input
              type="checkbox"
              checked={showOpenOnly}
              onChange={(e) => setShowOpenOnly(e.target.checked)}
              disabled={anyBusy}
              style={{ width: 16, height: 16 }}
            />
            Show Open Only
          </label>
          <div />
        </div>

        <div style={{ overflowX: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, tableLayout: "fixed" }}>
            <thead>
              <tr>
                <Th style={{ width: 40 }} />
                <Th style={{ ...stickyTickerTh, width: 110 }}>Ticker</Th>
                <Th style={{ width: 80 }}>Type</Th>
                <Th style={{ width: 80 }}>Event</Th>
                <Th style={{ width: 73 }}>Strike</Th>
                <Th style={{ width: 133 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span>Open Dt</span>
                    <SortIcon
                      active={sortSpec.field === "openDate"}
                      dir={sortSpec.dir}
                      onClick={() => toggleSort("openDate")}
                      title="Sort by Open Date"
                    />
                  </div>
                </Th>
                <Th style={{ width: 133 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span>Close Dt</span>
                    <SortIcon
                      active={sortSpec.field === "closeDate"}
                      dir={sortSpec.dir}
                      onClick={() => toggleSort("closeDate")}
                      title="Sort by Close Date"
                    />
                  </div>
                </Th>
                <Th style={{ width: 133 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span>Expiry Dt</span>
                    <SortIcon
                      active={sortSpec.field === "expiry"}
                      dir={sortSpec.dir}
                      onClick={() => toggleSort("expiry")}
                      title="Sort by Expiry"
                    />
                  </div>
                </Th>
                <Th style={{ width: 70 }}>Qty</Th>
                <Th style={{ width: 69 }}>Fill</Th>
                <Th style={{ width: 69 }}>Close</Th>
                <Th style={{ width: 80 }}>Fee</Th>
                <Th style={{ width: 95, padding: "10px 6px" }}>P/L</Th>
                <Th align="right" style={{ width: 120, padding: "10px 6px" }}>
                  Actions
                </Th>
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
                <tr style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                  <Td colSpan={14} style={{ color: THEME.muted }}>
                    Loading…
                  </Td>
                </tr>
              ) : listRows.length === 0 ? (
                <tr style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
                  <Td colSpan={14} style={{ color: THEME.muted }}>
                    No transactions match the current filters.
                  </Td>
                </tr>
              ) : (
                listRows.map((r) => {
                  const isEditing = editId === r.id;
                  const isExpanded = expanded.has(r.id);
                  const rowBg = r._isOpen ? THEME.openRowBg : "transparent";

                  return (
                    <FragmentRow
                      key={r.id}
                      row={r}
                      rowBg={rowBg}
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

/* ---------------- Row components ---------------- */

function Tier1Row({ expanded, toggle, row, setRow, busy, onPrimary, primaryLabel }) {
  const pl = calcPL(row);

  return (
    <>
      <tr style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
        <Td>
          <button type="button" onClick={toggle} style={chevBtn} title={expanded ? "Collapse" : "Expand"}>
            {expanded ? "▾" : "▸"}
          </button>
        </Td>

        <Td style={stickyTickerTd(THEME.panelBg)}>
          <input
            value={row.ticker ?? ""}
            onChange={(e) => setRow((d) => ({ ...d, ticker: e.target.value.toUpperCase() }))}
            style={{ ...inputCell, width: 100, fontWeight: 900 }}
          />
        </Td>

        <Td>
          <input
            value={row.type ?? ""}
            onChange={(e) => setRow((d) => ({ ...d, type: e.target.value.toUpperCase() }))}
            style={{ ...inputCell, width: 70, fontWeight: 900 }}
          />
        </Td>

        <Td style={wrapCell}>
          <input
            value={row.event ?? ""}
            onChange={(e) => setRow((d) => ({ ...d, event: e.target.value }))}
            style={{ ...inputCell, width: "100%" }}
          />
        </Td>

        <Td style={wrapCell}>
          <input
            value={row.strikes ?? ""}
            onChange={(e) => setRow((d) => ({ ...d, strikes: e.target.value }))}
            style={{ ...inputCell, width: "100%" }}
          />
        </Td>

        <Td>
          <input
            type="date"
            value={row.openDate ?? ""}
            onChange={(e) => setRow((d) => ({ ...d, openDate: e.target.value }))}
            style={{ ...inputCell, width: 127 }}
          />
        </Td>

        <Td>
          <input
            type="date"
            value={row.closeDate ?? ""}
            onChange={(e) => setRow((d) => ({ ...d, closeDate: e.target.value }))}
            style={{ ...inputCell, width: 127 }}
          />
        </Td>

        <Td>
          <input
            type="date"
            value={row.expiry ?? ""}
            onChange={(e) => setRow((d) => ({ ...d, expiry: e.target.value }))}
            style={{ ...inputCell, width: 127 }}
          />
        </Td>

        <Td>
          <input
            value={row.qty ?? ""}
            onChange={(e) => setRow((d) => ({ ...d, qty: e.target.value }))}
            style={{ ...inputCell, width: 60 }}
            inputMode="decimal"
          />
        </Td>

        <Td>
          <input
            value={row.fill ?? ""}
            onChange={(e) => setRow((d) => ({ ...d, fill: e.target.value }))}
            style={{ ...inputCell, width: 70 }}
            inputMode="decimal"
          />
        </Td>

        <Td>
          <input
            value={row.closePrice ?? ""}
            onChange={(e) => setRow((d) => ({ ...d, closePrice: e.target.value }))}
            style={{ ...inputCell, width: 70 }}
            inputMode="decimal"
          />
        </Td>

        <Td>
          <input
            value={row.fee ?? ""}
            onChange={(e) => setRow((d) => ({ ...d, fee: e.target.value }))}
            style={{ ...inputCell, width: 70 }}
            inputMode="decimal"
          />
        </Td>

        <Td
          style={{
            fontWeight: 900,
            color: pl === null ? THEME.muted : plColor(pl),
            padding: "10px 6px",
          }}
        >
          {pl === null ? "OPEN" : formatMoney(pl)}
        </Td>

        <Td align="right" style={{ padding: "10px 6px" }}>
          <button type="button" onClick={onPrimary} style={btnPrimarySmall} disabled={busy}>
            {primaryLabel}
          </button>
        </Td>
      </tr>

      {expanded ? <Tier2DetailsRow row={row} setRow={setRow} /> : null}
    </>
  );
}

function FragmentRow({
  row,
  rowBg,
  isExpanded,
  onToggle,
  isEditing,
  editDraft,
  setEditDraft,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  busyId,
}) {
  const c = row._calc || {};
  const isBusy = busyId !== null;

  const displayed = isEditing ? editDraft : row;
  const setDisplayed = isEditing ? setEditDraft : null;

  const pl = isEditing ? calcPL(displayed) : c.pl;

  return (
    <>
      <tr
        style={{
          borderTop: `1px solid ${THEME.rowBorder}`,
          background: rowBg,
          boxShadow: row._isOpen ? `inset 0 0 0 1px ${THEME.openRowBorder}` : "none",
        }}
      >
        <Td>
          <button type="button" onClick={onToggle} style={chevBtn} title={isExpanded ? "Collapse" : "Expand"}>
            {isExpanded ? "▾" : "▸"}
          </button>
        </Td>

        <Td style={stickyTickerTd(rowBg)}>
          {isEditing ? (
            <input
              value={displayed.ticker ?? ""}
              onChange={(e) => setDisplayed((d) => ({ ...d, ticker: e.target.value.toUpperCase() }))}
              style={{ ...inputCell, width: 100, fontWeight: 900 }}
            />
          ) : (
            <span style={{ fontWeight: 900, color: THEME.title }}>{row.ticker}</span>
          )}
        </Td>

        <Td>
          {isEditing ? (
            <input
              value={displayed.type ?? ""}
              onChange={(e) => setDisplayed((d) => ({ ...d, type: e.target.value.toUpperCase() }))}
              style={{ ...inputCell, width: 70, fontWeight: 900 }}
            />
          ) : (
            row.type
          )}
        </Td>

        <Td style={wrapCell}>
          {isEditing ? (
            <input
              value={displayed.event ?? ""}
              onChange={(e) => setDisplayed((d) => ({ ...d, event: e.target.value }))}
              style={{ ...inputCell, width: "100%" }}
            />
          ) : (
            row.event
          )}
        </Td>

        <Td style={wrapCell}>
          {isEditing ? (
            <input
              value={displayed.strikes ?? ""}
              onChange={(e) => setDisplayed((d) => ({ ...d, strikes: e.target.value }))}
              style={{ ...inputCell, width: "100%" }}
            />
          ) : (
            row.strikes
          )}
        </Td>

        <Td>
          {isEditing ? (
            <input
              type="date"
              value={displayed.openDate ?? ""}
              onChange={(e) => setDisplayed((d) => ({ ...d, openDate: e.target.value }))}
              style={{ ...inputCell, width: 127 }}
            />
          ) : (
            row.openDate || "-"
          )}
        </Td>

        <Td>
          {isEditing ? (
            <input
              type="date"
              value={displayed.closeDate ?? ""}
              onChange={(e) => setDisplayed((d) => ({ ...d, closeDate: e.target.value }))}
              style={{ ...inputCell, width: 127 }}
            />
          ) : (
            row.closeDate || "-"
          )}
        </Td>

        <Td>
          {isEditing ? (
            <input
              type="date"
              value={displayed.expiry ?? ""}
              onChange={(e) => setDisplayed((d) => ({ ...d, expiry: e.target.value }))}
              style={{ ...inputCell, width: 127 }}
            />
          ) : (
            row.expiry || "-"
          )}
        </Td>

        <Td>
          {isEditing ? (
            <input
              value={displayed.qty ?? ""}
              onChange={(e) => setDisplayed((d) => ({ ...d, qty: e.target.value }))}
              style={{ ...inputCell, width: 60 }}
              inputMode="decimal"
            />
          ) : (
            row.qty
          )}
        </Td>

        <Td>
          {isEditing ? (
            <input
              value={displayed.fill ?? ""}
              onChange={(e) => setDisplayed((d) => ({ ...d, fill: e.target.value }))}
              style={{ ...inputCell, width: 70 }}
              inputMode="decimal"
            />
          ) : (
            row.fill === "" ? "" : formatMoney(row.fill)
          )}
        </Td>

        <Td>
          {isEditing ? (
            <input
              value={displayed.closePrice ?? ""}
              onChange={(e) => setDisplayed((d) => ({ ...d, closePrice: e.target.value }))}
              style={{ ...inputCell, width: 70 }}
              inputMode="decimal"
            />
          ) : (
            row.closePrice === "" ? "" : formatMoney(row.closePrice)
          )}
        </Td>

        <Td>
          {isEditing ? (
            <input
              value={displayed.fee ?? ""}
              onChange={(e) => setDisplayed((d) => ({ ...d, fee: e.target.value }))}
              style={{ ...inputCell, width: 70 }}
              inputMode="decimal"
            />
          ) : (
            row.fee === "" ? "" : formatMoney(row.fee)
          )}
        </Td>

        <Td
          style={{
            fontWeight: 900,
            color: pl === null ? THEME.muted : plColor(pl),
            padding: "10px 6px",
          }}
        >
          {pl === null ? "OPEN" : formatMoney(pl)}
        </Td>

        <Td align="right" style={{ padding: "10px 6px" }}>
          {isEditing ? (
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "nowrap", alignItems: "center", whiteSpace: "nowrap" }}>
              <button type="button" onClick={onSave} style={btnPrimarySmall} disabled={isBusy}>
                {busyId === row.id ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={onCancel} style={btnSecondarySmall} disabled={isBusy}>
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "nowrap", alignItems: "center", whiteSpace: "nowrap" }}>
              <button type="button" onClick={onEdit} style={btnSecondarySmall} disabled={isBusy}>
                Edit
              </button>
              <button type="button" onClick={onDelete} style={btnDangerSmall} disabled={isBusy}>
                {busyId === row.id ? "Deleting…" : "Delete"}
              </button>
            </div>
          )}
        </Td>
      </tr>

      {isExpanded ? <Tier2DetailsRow row={isEditing ? editDraft : row} setRow={isEditing ? setEditDraft : null} /> : null}
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
    <tr style={{ borderTop: `1px solid ${THEME.rowBorder}` }}>
      <Td colSpan={14} style={{ paddingTop: 10 }}>
        <div style={detailsPanel}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 1fr) minmax(220px, 1.6fr) minmax(160px, 1fr)", gap: 12 }}>
            <Field
              label={`Collateral (default: ${defaultCollateral || "—"})`}
              value={
                row.collateral !== "" &&
                row.collateral !== null &&
                row.collateral !== undefined &&
                String(row.collateral).trim() !== ""
                  ? row.collateral
                  : defaultCollateral
              }
              onChange={
                isEditable
                  ? (v) => {
                      // user override; saved on Save/Add
                      setRow((d) => ({ ...d, collateral: v }));
                    }
                  : null
              }
              inputMode="decimal"
              placeholder="Auto from strike×qty×100"
            />
<Field
                label="Roll Over"
                value={row.rollOver ?? ""}
                onChange={isEditable ? (v) => setRow((d) => ({ ...d, rollOver: v })) : null}
                placeholder="Optional"
              />

              <ReadOnlyField
                label="Annual ROC"
                value={anl === null ? "—" : formatPct01(anl)}
                valueColor={anl === null ? THEME.muted : plColor(anl)}
              />

            <div style={{ gridColumn: "1 / -1" }}>
              <Field
                label="Notes"
              value={row.notes ?? ""}
              onChange={isEditable ? (v) => setRow((d) => ({ ...d, notes: v })) : null}
              placeholder="Optional"
              multiline
            />
          
            </div></div>

          <div style={{ marginTop: 10, fontSize: 12, color: THEME.muted }}>
            Annual ROC uses: (P/L ÷ Collateral) annualized over days held.
          </div>
        </div>
      </Td>
    </tr>
  );
}

/* ---------------- UI pieces ---------------- */

function Field({ label, value, onChange, type = "text", placeholder, inputMode, multiline = false }) {
  const editable = typeof onChange === "function";
  return (
    <div>
      <div style={fieldLabel}>{label}</div>
      {editable ? (
        multiline ? (
          <textarea
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            style={{ ...detailsInput, minHeight: 92, resize: "vertical" }}
          />
        ) : (
          <input
            type={type}
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            inputMode={inputMode}
            style={detailsInput}
          />
        )
      ) : (
        <div style={{ ...detailsReadOnly, whiteSpace: "pre-wrap" }}>{String(value || "—")}</div>
      )}
    </div>
  );
}

function ReadOnlyField({ label, value, valueColor }) {
  return (
    <div>
      <div style={fieldLabel}>{label}</div>
      <div style={{ ...detailsReadOnly, color: valueColor || THEME.title, fontWeight: 900 }}>
        {value}
      </div>
    </div>
  );
}

function SummaryCard({ title, value, hint, valueColor }) {
  return (
    <div style={panel}>
      <div style={{ fontSize: 12, color: THEME.muted, fontWeight: 800 }}>{title}</div>
      <div style={{ marginTop: 6, fontSize: 18, fontWeight: 900, color: valueColor || THEME.title }}>
        {value}
      </div>
      {hint ? <div style={{ marginTop: 6, fontSize: 12, color: THEME.muted }}>{hint}</div> : null}
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
      style={{
        border: `1px solid ${THEME.inputBorder}`,
        background: active ? THEME.primaryBg : "transparent",
        color: active ? THEME.title : THEME.muted,
        borderRadius: 8,
        padding: "2px 6px",
        fontSize: 12,
        lineHeight: "16px",
        cursor: "pointer",
        fontWeight: 900,
      }}
    >
      {arrow}
    </button>
  );
}

function Th({ children, align, style, ...rest }) {
  return (
    <th
      style={{
        padding: "10px 10px",
        fontSize: 12,
        color: THEME.muted,
        fontWeight: 900,
        textAlign: align || "left",
        whiteSpace: "nowrap",
        borderBottom: `1px solid ${THEME.rowBorder}`,
        ...style,
      }}
      {...rest}
    >
      {children}
    </th>
  );
}

function Td({ children, colSpan, align, style, ...rest }) {
  return (
    <td
      style={{
        padding: "10px 10px",
        fontSize: 13,
        color: THEME.pageText,
        textAlign: align || "left",
        verticalAlign: "top",
        overflow: "hidden",
        ...style,
      }}
      colSpan={colSpan}
      {...rest}
    >
      {children}
    </td>
  );
}

/* ---------------- styles ---------------- */

const panel = {
  background: THEME.panelBg,
  border: `1px solid ${THEME.panelBorder}`,
  borderRadius: 14,
  padding: 14,
  boxShadow: "0 10px 26px rgba(0,0,0,0.22)",
  backdropFilter: "blur(10px)",
};

const callout = {
  background: "rgba(239, 68, 68, 0.12)",
  border: `1px solid rgba(239, 68, 68, 0.28)`,
  borderRadius: 12,
  padding: 12,
};

const inputCell = {
  padding: "8px 10px",
  borderRadius: 10,
  outline: "none",
  border: `1px solid ${THEME.inputBorder}`,
  background: THEME.inputBg,
  color: THEME.pageText,
  fontSize: 13,
};

const wrapCell = {
  whiteSpace: "normal",
  wordBreak: "break-word",
  lineHeight: 1.25,
};

const btnPrimarySmall = {
  padding: "6px 8px",
  borderRadius: 10,
  border: `1px solid ${THEME.primaryBorder}`,
  background: THEME.primaryBg,
  color: THEME.title,
  fontWeight: 900,
  cursor: "pointer",
  fontSize: 12,
};

const btnSecondarySmall = {
  padding: "6px 8px",
  borderRadius: 10,
  border: `1px solid ${THEME.inputBorder}`,
  background: "rgba(2, 6, 23, 0.2)",
  color: THEME.title,
  fontWeight: 900,
  cursor: "pointer",
  fontSize: 12,
};

const btnDangerSmall = {
  padding: "6px 8px",
  borderRadius: 10,
  border: `1px solid ${THEME.dangerBorder}`,
  background: THEME.dangerBg,
  color: THEME.title,
  fontWeight: 900,
  cursor: "pointer",
  fontSize: 12,
};

const btnSecondary = {
  padding: "10px 12px",
  borderRadius: 12,
  border: `1px solid ${THEME.inputBorder}`,
  background: "rgba(2, 6, 23, 0.2)",
  color: THEME.title,
  fontWeight: 900,
  cursor: "pointer",
};

const chevBtn = {
  width: 30,
  height: 30,
  borderRadius: 10,
  border: `1px solid ${THEME.inputBorder}`,
  background: "rgba(2, 6, 23, 0.25)",
  color: THEME.title,
  fontWeight: 900,
  cursor: "pointer",
};

const detailsPanel = {
  background: "rgba(2, 6, 23, 0.20)",
  border: `1px solid ${THEME.panelBorder}`,
  borderRadius: 12,
  padding: 12,
};

const fieldLabel = {
  fontSize: 12,
  color: THEME.muted,
  fontWeight: 800,
  marginBottom: 6,
};

const detailsInput = {
  width: "100%",
  padding: "10px 10px",
  borderRadius: 10,
  outline: "none",
  border: `1px solid ${THEME.inputBorder}`,
  background: THEME.inputBg,
  color: THEME.pageText,
  fontSize: 13,
};

const detailsReadOnly = {
  width: "100%",
  padding: "10px 10px",
  borderRadius: 10,
  border: `1px solid ${THEME.inputBorder}`,
  background: "rgba(2, 6, 23, 0.20)",
  color: THEME.title,
  fontSize: 13,
};
