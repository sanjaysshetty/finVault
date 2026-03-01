import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";

const COUNTRY_OPTIONS = ["USA", "India"];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function safeNum(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function formatMoney(n) {
  const x = safeNum(n, 0);
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatPct(n) {
  const x = safeNum(n, 0);
  return `${x > 0 ? "+" : ""}${x.toFixed(2)}%`;
}

function addMonths(dateISO, months) {
  const d = new Date(dateISO);
  const m = Number(months || 0);
  const originalDay = d.getDate();
  d.setMonth(d.getMonth() + m);
  if (d.getDate() !== originalDay) d.setDate(0);
  return d.toISOString().slice(0, 10);
}

function yearsBetween(startISO, endISO) {
  const start = new Date(startISO);
  const end = new Date(endISO);
  const ms = end - start;
  const days = ms / (1000 * 60 * 60 * 24);
  return Math.max(0, days / 365.25);
}

function freqToN(freq) {
  switch ((freq || "YEARLY").toUpperCase()) {
    case "DAILY": return 365;
    case "MONTHLY": return 12;
    case "QUARTERLY": return 4;
    case "YEARLY":
    default: return 1;
  }
}

function computeValue({ principal, annualRate, startDate, asOfDate, interestType, compoundFrequency }) {
  const P = safeNum(principal, 0);
  const r = safeNum(annualRate, 0);
  if (!startDate) return { value: P, interest: 0 };
  const t = yearsBetween(startDate, asOfDate);
  const type = (interestType || "SIMPLE").toUpperCase();
  let value = P;
  if (type === "COMPOUND") {
    const n = freqToN(compoundFrequency);
    value = P * Math.pow(1 + r / n, n * t);
  } else {
    value = P * (1 + r * t);
  }
  return { value, interest: value - P };
}

const DEFAULT_FORM = {
  country: "USA",
  name: "",
  principal: "",
  annualRatePct: "",
  startDate: todayISO(),
  termMonths: 12,
  interestType: "COMPOUND",
  compoundFrequency: "MONTHLY",
  notes: "",
};


function normalizeApiRow(item) {
  const c = String(item?.country || "").trim();
  const country = c ? (c.toUpperCase() === "INDIA" ? "INDIA" : "USA") : "USA";
  return { ...item, country, id: item.assetId || item.id };
}

/* ================================================================
   COMPONENT
================================================================ */

export default function FixedIncome() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [countryFilter, setCountryFilter] = useState("ALL");
  const [sortKey, setSortKey] = useState("startDate");
  const [sortDir, setSortDir] = useState("desc");

  const queryClient = useQueryClient();

  const { data: rawData, isLoading: loading, error: fetchError } = useQuery({
    queryKey: queryKeys.fixedIncome(),
    queryFn: () => api.get("/assets/fixedincome"),
  });

  const rows = useMemo(() => {
    const list = Array.isArray(rawData?.items) ? rawData.items : Array.isArray(rawData) ? rawData : [];
    return list.map(normalizeApiRow);
  }, [rawData]);

  const saveMut = useMutation({
    mutationFn: ({ id, payload }) =>
      id ? api.patch(`/assets/fixedincome/${encodeURIComponent(id)}`, payload) : api.post("/assets/fixedincome", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.fixedIncome() });
      resetForm({ hide: true });
    },
    onError: (e) => setError(e?.message || "Save failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => api.delete(`/assets/fixedincome/${encodeURIComponent(id)}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.fixedIncome() });
      if (editingId === id) resetForm({ hide: true });
    },
    onError: (e) => setError(e?.message || "Delete failed"),
  });

  const saving = saveMut.isPending || deleteMut.isPending;

  const asOfDate = todayISO();

  const enrichedRows = useMemo(() => {
    return rows.map((r) => {
      const hasBackend =
        Number.isFinite(Number(r.currentValue)) && Number.isFinite(Number(r.interestEarnedToDate));
      let currentValue, interestEarnedToDate;
      if (hasBackend) {
        currentValue = Number(Number(r.currentValue).toFixed(2));
        interestEarnedToDate = Number(Number(r.interestEarnedToDate).toFixed(2));
      } else {
        const calc = computeValue({
          principal: r.principal, annualRate: r.annualRate, startDate: r.startDate,
          asOfDate, interestType: r.interestType, compoundFrequency: r.compoundFrequency,
        });
        currentValue = Number(calc.value.toFixed(2));
        interestEarnedToDate = Number(calc.interest.toFixed(2));
      }
      const isActive = r.maturityDate ? asOfDate <= r.maturityDate : true;
      const dailyAccrual = isActive
        ? Number((safeNum(r.principal, 0) * safeNum(r.annualRate, 0) / 365).toFixed(2))
        : 0;
      return { ...r, currentValue, interestEarnedToDate, dailyAccrual };
    });
  }, [rows, asOfDate]);

  const filteredSortedRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = enrichedRows;
    if (countryFilter !== "ALL") {
      const want = countryFilter === "India" ? "INDIA" : "USA";
      list = list.filter((r) => String(r.country || "").toUpperCase() === want);
    }
    if (q) list = list.filter((r) =>
      `${r.country || ""} ${r.name || ""} ${r.notes || ""}`.toLowerCase().includes(q)
    );
    const dir = sortDir === "asc" ? 1 : -1;
    const getVal = (r) => {
      switch (sortKey) {
        case "country": return String(r.country || "");
        case "principal": return safeNum(r.principal, 0);
        case "currentValue": return safeNum(r.currentValue, 0);
        case "maturityDate": return r.maturityDate || "";
        case "startDate":
        default: return r.startDate || "";
      }
    };
    return [...list].sort((a, b) => {
      const va = getVal(a), vb = getVal(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [enrichedRows, search, countryFilter, sortKey, sortDir]);

  const summary = useMemo(() => {
    const base = countryFilter === "ALL"
      ? enrichedRows
      : enrichedRows.filter((r) =>
          String(r.country || "").toUpperCase() === (countryFilter === "India" ? "INDIA" : "USA")
        );
    return {
      invested: base.reduce((s, r) => s + safeNum(r.principal, 0), 0),
      current: base.reduce((s, r) => s + safeNum(r.currentValue, 0), 0),
      interest: base.reduce((s, r) => s + safeNum(r.interestEarnedToDate, 0), 0),
      maturity: base.reduce((s, r) => s + safeNum(r.maturityAmount, 0), 0),
      dailyAccrual: base.reduce((s, r) => s + safeNum(r.dailyAccrual, 0), 0),
    };
  }, [enrichedRows, countryFilter]);

  const currentGainPct = summary.invested > 0
    ? formatPct(((summary.current - summary.invested) / summary.invested) * 100)
    : null;
  const maturityGainPct = summary.invested > 0
    ? formatPct(((summary.maturity - summary.invested) / summary.invested) * 100)
    : null;
  const dailyAccrualPct = summary.current > 0
    ? formatPct((summary.dailyAccrual / summary.current) * 100)
    : null;

  function resetForm({ hide } = {}) {
    setForm(DEFAULT_FORM);
    setEditingId(null);
    setError("");
    if (hide) setShowForm(false);
  }

  function openCreateForm() {
    setError("");
    setEditingId(null);
    setForm(DEFAULT_FORM);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeForm() { resetForm({ hide: true }); }

  function startEdit(r) {
    setError("");
    setEditingId(r.id);
    const c = String(r.country || "").trim().toUpperCase();
    setForm({
      country: c === "INDIA" ? "India" : "USA",
      name: r.name || "",
      principal: String(r.principal ?? ""),
      annualRatePct: String(((safeNum(r.annualRate, 0) * 100) || 0).toFixed(4)).replace(/\.?0+$/, ""),
      startDate: r.startDate || todayISO(),
      termMonths: r.termMonths ?? 12,
      interestType: r.interestType || "SIMPLE",
      compoundFrequency: r.compoundFrequency || "YEARLY",
      notes: r.notes || "",
    });
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function buildPayloadFromForm() {
    const country = String(form.country || "").trim();
    const principal = safeNum(form.principal, NaN);
    const annualRatePct = safeNum(form.annualRatePct, NaN);
    if (!country || !COUNTRY_OPTIONS.includes(country)) throw new Error("Country is required");
    if (!form.name.trim()) throw new Error("Name is required");
    if (!form.startDate) throw new Error("Start date is required");
    if (!Number.isFinite(principal) || principal <= 0) throw new Error("Principal must be a positive number");
    if (!Number.isFinite(annualRatePct) || annualRatePct < 0) throw new Error("Annual rate must be valid (percent)");
    const termMonths = clamp(parseInt(form.termMonths, 10) || 0, 1, 600);
    const annualRate = annualRatePct / 100;
    return {
      country: country === "India" ? "INDIA" : "USA",
      name: form.name.trim(),
      principal: Number(principal.toFixed(2)),
      annualRate: Number(annualRate.toFixed(8)),
      interestType: form.interestType,
      compoundFrequency: form.compoundFrequency,
      startDate: form.startDate,
      termMonths,
      notes: form.notes?.trim() || "",
    };
  }

  function onSubmit(e) {
    e.preventDefault();
    setError("");
    let payload;
    try { payload = buildPayloadFromForm(); }
    catch (err) { setError(err?.message || "Save failed"); return; }
    saveMut.mutate({ id: editingId, payload });
  }

  function onDelete(id) {
    setError("");
    if (!window.confirm("Delete this fixed income record?")) return;
    deleteMut.mutate(id);
  }

  function onToggleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-baseline justify-between gap-3">
        <h1
          className="text-2xl font-black text-slate-100 tracking-tight"
          style={{ fontFamily: "Epilogue, sans-serif" }}
        >
          Fixed Income
        </h1>
        <span className="text-xs text-slate-500">
          As of <strong className="text-slate-300 font-semibold">{asOfDate}</strong>
        </span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <MetricCard label="Invested Amount" value={formatMoney(summary.invested)} />
        <MetricCard label="Current Value" value={formatMoney(summary.current)} pct={currentGainPct} sub="Computed at runtime" />
        <MetricCard label="Interest Earned" value={formatMoney(summary.interest)} sub="To date" />
        <MetricCard label="Maturity Amount" value={formatMoney(summary.maturity)} pct={maturityGainPct} sub="Stored on create/update" />
        <MetricCard label="Today's Accrual" value={formatMoney(summary.dailyAccrual)} pct={dailyAccrualPct} sub="Daily interest (active)" valueClass="text-green-400" />
      </div>

      {/* Form panel */}
      {showForm && (
        <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-4">
          <div className="flex items-center justify-between gap-3">
            <h2
              className="text-sm font-black text-slate-100"
              style={{ fontFamily: "Epilogue, sans-serif" }}
            >
              {editingId ? "Edit Fixed Income" : "Add Fixed Income"}
            </h2>
            <div className="flex gap-2">
              {editingId && (
                <Btn onClick={() => resetForm({ hide: true })} disabled={saving}>Cancel</Btn>
              )}
              <Btn onClick={closeForm} disabled={saving}>Close</Btn>
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded-xl border border-red-500/[0.3] bg-red-500/[0.08] px-3 py-2.5">
              <div className="text-xs font-bold text-slate-100">Error</div>
              <div className="mt-1 text-xs text-slate-300">{error}</div>
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-4 grid gap-3">
            {/* Row 1: Name (2fr) · Country · Principal · Rate */}
            <div className="grid gap-3" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr" }}>
              <FLabel label="Name">
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g., CD - Chase 12M"
                  className={inputCls}
                  disabled={saving}
                />
              </FLabel>
              <FLabel label="Country">
                <select
                  value={form.country}
                  onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
                  className={inputCls}
                  disabled={saving}
                >
                  {COUNTRY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </FLabel>
              <FLabel label="Principal (USD)">
                <input
                  value={form.principal}
                  onChange={(e) => setForm((f) => ({ ...f, principal: e.target.value }))}
                  placeholder="10000"
                  inputMode="decimal"
                  className={inputCls}
                  disabled={saving}
                />
              </FLabel>
              <FLabel label="Annual Rate (%)">
                <input
                  value={form.annualRatePct}
                  onChange={(e) => setForm((f) => ({ ...f, annualRatePct: e.target.value }))}
                  placeholder="5.25"
                  inputMode="decimal"
                  className={inputCls}
                  disabled={saving}
                />
              </FLabel>
            </div>

            {/* Row 2: Start Date · Term · Interest Type · Compound Freq */}
            <div className="grid grid-cols-4 gap-3">
              <FLabel label="Start Date">
                <input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                  className={inputCls}
                  disabled={saving}
                />
              </FLabel>
              <FLabel label="Term (Months)">
                <input
                  value={form.termMonths}
                  onChange={(e) => setForm((f) => ({ ...f, termMonths: e.target.value }))}
                  inputMode="numeric"
                  className={inputCls}
                  disabled={saving}
                />
              </FLabel>
              <FLabel label="Interest Type">
                <select
                  value={form.interestType}
                  onChange={(e) => setForm((f) => ({ ...f, interestType: e.target.value }))}
                  className={inputCls}
                  disabled={saving}
                >
                  <option value="SIMPLE">Simple</option>
                  <option value="COMPOUND">Compound</option>
                </select>
              </FLabel>
              <FLabel label="Compound Frequency">
                <select
                  value={form.compoundFrequency}
                  onChange={(e) => setForm((f) => ({ ...f, compoundFrequency: e.target.value }))}
                  className={`${inputCls} ${form.interestType !== "COMPOUND" ? "opacity-40" : ""}`}
                  disabled={saving || form.interestType !== "COMPOUND"}
                >
                  <option value="YEARLY">Yearly</option>
                  <option value="QUARTERLY">Quarterly</option>
                  <option value="MONTHLY">Monthly</option>
                  <option value="DAILY">Daily</option>
                </select>
              </FLabel>
            </div>

            {/* Row 3: Notes (3fr) · Preview panel (1fr) */}
            <div className="grid gap-3" style={{ gridTemplateColumns: "3fr 1fr" }}>
              <FLabel label="Notes (optional)">
                <input
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="e.g., auto-renew off"
                  className={inputCls}
                  disabled={saving}
                />
              </FLabel>
              <div className="rounded-xl border border-white/[0.06] bg-[#080D1A]/40 p-3">
                <div className="text-xs font-bold text-slate-500 mb-2">Preview</div>
                <div className="space-y-1.5">
                  <MiniRow
                    label="Maturity Date"
                    value={
                      form.startDate
                        ? addMonths(form.startDate, clamp(parseInt(form.termMonths, 10) || 0, 1, 600))
                        : "-"
                    }
                  />
                  <MiniRow
                    label="Stored Maturity"
                    value={() => {
                      const p = safeNum(form.principal, NaN);
                      const r = safeNum(form.annualRatePct, NaN) / 100;
                      const t = clamp(parseInt(form.termMonths, 10) || 0, 1, 600);
                      if (!Number.isFinite(p) || !Number.isFinite(r) || !form.startDate) return "-";
                      const md = addMonths(form.startDate, t);
                      const calc = computeValue({
                        principal: p, annualRate: r, startDate: form.startDate,
                        asOfDate: md, interestType: form.interestType, compoundFrequency: form.compoundFrequency,
                      });
                      return formatMoney(calc.value);
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Submit row */}
            <div className="flex justify-end gap-2 mt-1">
              <Btn type="button" onClick={() => resetForm()} disabled={saving}>Reset</Btn>
              <BtnPrimary type="submit" disabled={saving} style={{ opacity: saving ? 0.75 : 1 }}>
                {saving ? "Saving…" : editingId ? "Save Changes" : "Add Record"}
              </BtnPrimary>
            </div>
          </form>
        </div>
      )}

      {/* Records table */}
      <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729]">
        <div className="flex items-center justify-between gap-3 flex-wrap px-4 pt-4 pb-3">
          <h2 className="text-sm font-black text-slate-100">All Records</h2>
          <div className="flex gap-2 flex-wrap items-center">
            <BtnPrimary type="button" onClick={openCreateForm} disabled={saving}>
              + Add Fixed Income
            </BtnPrimary>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search country/name/notes…"
              className={`${inputCls} !w-52`}
              disabled={loading}
            />
            <select
              value={countryFilter}
              onChange={(e) => setCountryFilter(e.target.value)}
              className={`${inputCls} !w-36`}
              disabled={loading}
            >
              <option value="ALL">All Countries</option>
              <option value="USA">USA</option>
              <option value="India">India</option>
            </select>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value)}
              className={`${inputCls} !w-44`}
              disabled={loading}
            >
              <option value="startDate">Sort: Start Date</option>
              <option value="country">Sort: Country</option>
              <option value="maturityDate">Sort: Maturity Date</option>
              <option value="principal">Sort: Principal</option>
              <option value="currentValue">Sort: Current Value</option>
            </select>
            <Btn
              type="button"
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              disabled={loading}
            >
              {sortDir === "asc" ? "Asc ↑" : "Desc ↓"}
            </Btn>
          </div>
        </div>

        {(fetchError || error) && (
          <div className="mx-4 mb-3 rounded-xl border border-red-500/[0.3] bg-red-500/[0.08] px-3 py-2.5">
            <div className="text-xs font-bold text-slate-100">Error</div>
            <div className="mt-1 text-xs text-slate-300">{fetchError?.message || error}</div>
          </div>
        )}

        <div className="border-t border-white/[0.06]" />

        {loading ? (
          <EmptyState type="loading" message="Loading fixed income records…" />
        ) : filteredSortedRows.length === 0 ? (
          <EmptyState type="empty" message='No fixed income records yet. Click "+ Add Fixed Income" to create one.' />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th onClick={() => onToggleSort("startDate")} active={sortKey === "startDate"}>Name</Th>
                  <Th onClick={() => onToggleSort("country")} active={sortKey === "country"}>Country</Th>
                  <Th onClick={() => onToggleSort("principal")} active={sortKey === "principal"}>Principal</Th>
                  <Th>Rate</Th>
                  <Th>Start</Th>
                  <Th onClick={() => onToggleSort("maturityDate")} active={sortKey === "maturityDate"}>Maturity</Th>
                  <Th onClick={() => onToggleSort("currentValue")} active={sortKey === "currentValue"}>Current Value</Th>
                  <Th>Stored Maturity</Th>
                  <Th>Accrual/Day</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filteredSortedRows.map((r) => (
                  <tr key={r.id} className="border-t border-white/[0.06] hover:bg-white/[0.015] transition-colors">
                    <Td>
                      <div className="font-bold text-slate-100">{r.name}</div>
                      {r.notes && <div className="mt-0.5 text-xs text-slate-500">{r.notes}</div>}
                      <div className="mt-1.5 flex gap-1.5 flex-wrap">
                        <Pill text={r.interestType === "COMPOUND" ? `Compound · ${r.compoundFrequency}` : "Simple"} />
                        <Pill text={`${r.termMonths} months`} />
                      </div>
                    </Td>
                    <Td>{String(r.country || "").toUpperCase() === "INDIA" ? "India" : "USA"}</Td>
                    <Td className="numeric">{formatMoney(r.principal)}</Td>
                    <Td className="numeric">{(safeNum(r.annualRate, 0) * 100).toFixed(2)}%</Td>
                    <Td>{r.startDate}</Td>
                    <Td>{r.maturityDate}</Td>
                    <Td>
                      <div className="font-bold text-slate-100 numeric">{formatMoney(r.currentValue)}</div>
                      <div className="text-xs text-slate-500 numeric">Interest: {formatMoney(r.interestEarnedToDate)}</div>
                    </Td>
                    <Td className="numeric">{formatMoney(r.maturityAmount)}</Td>
                    <Td className={`numeric ${r.dailyAccrual > 0 ? "text-green-400 font-bold" : "text-slate-600"}`}>{r.dailyAccrual > 0 ? formatMoney(r.dailyAccrual) : "—"}</Td>
                    <Td align="right">
                      <div className="flex gap-1.5 justify-end">
                        <Btn onClick={() => startEdit(r)} disabled={saving}>Edit</Btn>
                        <BtnDanger onClick={() => onDelete(r.id)} disabled={saving}>Delete</BtnDanger>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="h-3" />
      </div>
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────────────────── */

function FLabel({ label, children }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-bold text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function Th({ children, align, onClick, active }) {
  return (
    <th
      onClick={onClick}
      className={[
        "text-xs font-bold uppercase tracking-widest px-3 py-2.5 whitespace-nowrap border-b border-white/[0.06] select-none",
        onClick ? "cursor-pointer hover:text-slate-300" : "cursor-default",
        active ? "text-slate-200" : "text-slate-500",
        align === "right" ? "text-right" : "text-left",
      ].join(" ")}
    >
      {children}
    </th>
  );
}

function Td({ children, align, colSpan, className }) {
  return (
    <td
      className={`text-sm text-slate-300 px-3 py-3 align-top ${align === "right" ? "text-right" : ""} ${className || ""}`}
      colSpan={colSpan}
    >
      {children}
    </td>
  );
}

function Pill({ text }) {
  return (
    <span className="text-[10px] font-bold text-slate-400 border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 rounded-full">
      {text}
    </span>
  );
}

function MiniRow({ label, value }) {
  const v = typeof value === "function" ? value() : value;
  return (
    <div className="flex justify-between gap-2">
      <span className="text-xs text-slate-500 font-bold">{label}</span>
      <span className="text-xs text-slate-300 font-bold">{v}</span>
    </div>
  );
}

function Btn({ children, ...p }) {
  return <button type="button" className={btnSmCls} {...p}>{children}</button>;
}

function BtnPrimary({ children, ...p }) {
  return <button className={btnPrimCls} {...p}>{children}</button>;
}

function BtnDanger({ children, ...p }) {
  return <button type="button" className={btnDanCls} {...p}>{children}</button>;
}

const inputCls = "w-full bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2.5 text-slate-200 text-sm outline-none focus:border-blue-500/[0.4] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const btnPrimCls = "text-xs font-bold text-slate-100 px-3 py-1.5 rounded-lg border border-blue-500/[0.3] bg-blue-500/[0.15] hover:bg-blue-500/[0.25] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
const btnSmCls = "text-xs font-bold text-slate-400 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08] hover:text-slate-200 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
const btnDanCls = "text-xs font-bold text-red-400 px-3 py-1.5 rounded-lg border border-red-500/[0.3] bg-red-500/[0.08] hover:bg-red-500/[0.15] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
