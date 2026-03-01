import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";

const COUNTRY_OPTIONS = ["USA", "India"];
const CATEGORY_OPTIONS = [
  "Credit Card",
  "Auto Loan",
  "Mortgage",
  "Personal Loan",
  "Student Loan",
  "Margin / Broker Loan",
  "Other",
];
const DEFAULT_FORM = { category: "Credit Card", country: "USA", description: "", remarks: "", value: "" };

function safeNum(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function round2(n) { return Math.round(safeNum(n, 0) * 100) / 100; }
function formatMoney(n, currency = "USD") {
  const x = safeNum(n, 0);
  try {
    return x.toLocaleString(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch { return `$${x.toFixed(2)}`; }
}

function normalizeApiRow(item) {
  const c = String(item?.country || "").trim();
  const country = c ? (c.toUpperCase() === "INDIA" ? "INDIA" : "USA") : "USA";
  return { ...item, country, id: item.liabilityId || item.assetId || item.id };
}

export default function Liabilities() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [countryFilter, setCountryFilter] = useState("ALL");
  const [sortKey, setSortKey] = useState("updatedAt");
  const [sortDir, setSortDir] = useState("desc");

  const queryClient = useQueryClient();

  const { data: rawData, isLoading: loading, error: fetchError } = useQuery({
    queryKey: queryKeys.liabilities(),
    queryFn: () => api.get("/liabilities"),
  });

  const rows = useMemo(() => {
    const list = Array.isArray(rawData?.items) ? rawData.items : Array.isArray(rawData) ? rawData : [];
    return list.map(normalizeApiRow);
  }, [rawData]);

  const saveMut = useMutation({
    mutationFn: ({ id, payload }) =>
      id ? api.patch(`/liabilities/${encodeURIComponent(id)}`, payload) : api.post("/liabilities", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.liabilities() });
      resetForm({ hide: true });
    },
    onError: (e) => setError(e.message || "Save failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => api.delete(`/liabilities/${encodeURIComponent(id)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.liabilities() }),
    onError: (e) => setError(e.message || "Delete failed"),
  });

  const saving = saveMut.isPending || deleteMut.isPending;

  const filteredSortedRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = rows;
    if (countryFilter !== "ALL") {
      const want = countryFilter === "India" ? "INDIA" : "USA";
      list = list.filter((r) => String(r.country || "").toUpperCase() === want);
    }
    if (q) {
      list = list.filter((r) => {
        const hay = `${r.category || ""} ${r.country || ""} ${r.description || ""} ${r.remarks || ""}`.toLowerCase();
        return hay.includes(q);
      });
    }
    const dir = sortDir === "asc" ? 1 : -1;
    const getVal = (r) => {
      switch (sortKey) {
        case "country": return String(r.country || "");
        case "category": return String(r.category || "");
        case "description": return String(r.description || "");
        case "remarks": return String(r.remarks || "");
        case "value": return safeNum(r.value, 0);
        case "updatedAt": default: return r.updatedAt || r.createdAt || "";
      }
    };
    return [...list].sort((a, b) => {
      const va = getVal(a), vb = getVal(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [rows, search, countryFilter, sortKey, sortDir]);

  const totalLiabilities = useMemo(() => {
    const base = countryFilter === "ALL"
      ? rows
      : rows.filter((r) => String(r.country || "").toUpperCase() === (countryFilter === "India" ? "INDIA" : "USA"));
    return round2(base.reduce((s, r) => s + safeNum(r.value, 0), 0));
  }, [rows, countryFilter]);

  function resetForm({ hide } = {}) {
    setForm(DEFAULT_FORM); setEditingId(null); setError("");
    if (hide) setShowForm(false);
  }
  function openCreateForm() {
    setError(""); setEditingId(null); setForm(DEFAULT_FORM); setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function startEdit(r) {
    setError(""); setEditingId(r.id);
    const c = String(r.country || "").trim().toUpperCase();
    setForm({
      category: CATEGORY_OPTIONS.includes(r.category) ? r.category : "Other",
      country: c === "INDIA" ? "India" : "USA",
      description: r.description || "",
      remarks: r.remarks || "",
      value: String(r.value ?? ""),
    });
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function buildPayloadFromForm() {
    const category = String(form.category || "").trim();
    const country = String(form.country || "").trim();
    const description = String(form.description || "").trim();
    const remarks = String(form.remarks || "").trim();
    const value = safeNum(form.value, NaN);
    if (!category) throw new Error("Liability Category is required");
    if (!COUNTRY_OPTIONS.includes(country)) throw new Error("Country is required");
    if (!description) throw new Error("Liability Description is required");
    if (!Number.isFinite(value)) throw new Error("Liability Value must be a valid number");
    return {
      category, country: country === "India" ? "INDIA" : "USA",
      description, remarks,
      value: Number(clamp(value, -1e15, 1e15).toFixed(2)),
    };
  }
  function onSubmit(e) {
    e.preventDefault(); setError("");
    let payload;
    try { payload = buildPayloadFromForm(); }
    catch (err) { setError(err.message || "Save failed"); return; }
    saveMut.mutate({ id: editingId, payload });
  }
  function onDelete(id) {
    if (!id) return;
    if (!window.confirm("Delete this record?")) return;
    setError("");
    deleteMut.mutate(id);
  }
  function onToggleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  return (
    <div className="p-4 text-slate-300">
      <h1 className="text-2xl font-black text-slate-100 tracking-tight mb-4">Liabilities</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <MetricCard label="Total Liabilities" value={formatMoney(totalLiabilities)} sub="Sum of all listed records" valueClass="text-red-400" />
      </div>

      {showForm && (
        <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-4 mb-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <span className="text-sm font-black text-slate-100">
              {editingId ? "Edit Liability" : "Add Liability"}
            </span>
            <div className="flex gap-2">
              {editingId && <Btn onClick={() => resetForm({ hide: true })} disabled={saving}>Cancel</Btn>}
              <Btn onClick={() => resetForm({ hide: true })} disabled={saving}>Close</Btn>
            </div>
          </div>
          {error && (
            <div className="rounded-xl border border-red-500/[0.3] bg-red-500/[0.08] px-3 py-2 mb-3">
              <span className="text-xs font-black text-slate-100">Error</span>
              <p className="text-xs text-slate-300 mt-1">{error}</p>
            </div>
          )}
          <form onSubmit={onSubmit} className="grid gap-3">
            <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr 2fr 1fr" }}>
              <FLabel label="Liability Category">
                <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} className={inputCls} disabled={saving}>
                  {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </FLabel>
              <FLabel label="Country">
                <select value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))} className={inputCls} disabled={saving}>
                  {COUNTRY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </FLabel>
              <FLabel label="Liability Description">
                <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="e.g., Chase Sapphire balance" className={inputCls} disabled={saving} />
              </FLabel>
              <FLabel label="Liability Value (USD)">
                <input value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} placeholder="5000.00" inputMode="decimal" className={inputCls} disabled={saving} />
              </FLabel>
            </div>
            <div>
              <FLabel label="Remarks">
                <input value={form.remarks} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} placeholder="Optional notes…" className={inputCls} disabled={saving} />
              </FLabel>
            </div>
            <div className="flex gap-2 justify-end mt-1">
              <Btn type="button" onClick={() => resetForm()} disabled={saving}>Reset</Btn>
              <BtnPrimary type="submit" disabled={saving}>
                {saving ? "Saving…" : editingId ? "Save Changes" : "Create"}
              </BtnPrimary>
            </div>
          </form>
        </div>
      )}

      <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-4">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
          <span className="text-sm font-black text-slate-100">All Records</span>
          <div className="flex gap-2 items-center flex-wrap">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className={`${inputCls} !w-52`} disabled={loading} />
            <select value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)} className={`${inputCls} !w-32`} disabled={loading}>
              <option value="ALL">All</option>
              <option value="USA">USA</option>
              <option value="India">India</option>
            </select>
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} className={`${inputCls} !w-40`} disabled={loading}>
              <option value="updatedAt">Sort: Updated</option>
              <option value="category">Sort: Category</option>
              <option value="country">Sort: Country</option>
              <option value="description">Sort: Description</option>
              <option value="remarks">Sort: Remarks</option>
              <option value="value">Sort: Value</option>
            </select>
            <Btn onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))} disabled={loading}>
              {sortDir === "asc" ? "Asc" : "Desc"}
            </Btn>
            <BtnPrimary onClick={openCreateForm} disabled={saving}>+ Add Liability</BtnPrimary>
          </div>
        </div>

        {(fetchError || error) && (
          <div className="rounded-xl border border-red-500/[0.3] bg-red-500/[0.08] px-3 py-2 mb-3">
            <span className="text-xs font-black text-slate-100">Error</span>
            <p className="text-xs text-slate-300 mt-1">{fetchError?.message || error}</p>
          </div>
        )}

        <div className="border-t border-white/[0.06]" />

        {loading ? (
          <EmptyState type="loading" />
        ) : filteredSortedRows.length === 0 ? (
          <EmptyState type="empty" message='No liabilities yet. Click "Add Liability" to create one.' />
        ) : (
          <div className="overflow-x-auto mt-1">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th onClick={() => onToggleSort("category")} active={sortKey === "category"}>Liability Category</Th>
                  <Th onClick={() => onToggleSort("country")} active={sortKey === "country"}>Country</Th>
                  <Th onClick={() => onToggleSort("description")} active={sortKey === "description"}>Description</Th>
                  <Th onClick={() => onToggleSort("remarks")} active={sortKey === "remarks"}>Remarks</Th>
                  <Th onClick={() => onToggleSort("value")} active={sortKey === "value"}>Liability Value</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filteredSortedRows.map((r) => (
                  <tr key={r.id} className="border-t border-white/[0.06]">
                    <Td><span className="font-black text-slate-100">{r.category}</span></Td>
                    <Td><span className="font-black text-slate-100">{String(r.country || "").toUpperCase() === "INDIA" ? "India" : "USA"}</span></Td>
                    <Td><span className="font-black text-slate-100">{r.description}</span></Td>
                    <Td>
                      {r.remarks
                        ? <span className="text-slate-300">{r.remarks}</span>
                        : <span className="text-slate-600">—</span>}
                    </Td>
                    <Td><span className="font-black text-slate-100">{formatMoney(r.value)}</span></Td>
                    <Td align="right">
                      <div className="flex gap-2 justify-end pr-2">
                        <Btn onClick={() => startEdit(r)} disabled={saving}>Edit</Btn>
                        <BtnDanger onClick={() => onDelete(r.id)} disabled={saving}>Delete</BtnDanger>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-white/[0.06]">
                  <Td colSpan={4}><span className="font-black text-slate-100">Total</span></Td>
                  <Td><span className="font-black text-slate-100">{formatMoney(totalLiabilities)}</span></Td>
                  <Td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */

function FLabel({ label, children }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-bold uppercase tracking-widest text-slate-500">{label}</span>
      {children}
    </label>
  );
}
function Btn({ children, onClick, disabled, type = "button" }) {
  return <button type={type} onClick={onClick} disabled={disabled} className={btnSmCls}>{children}</button>;
}
function BtnPrimary({ children, onClick, disabled, type = "button" }) {
  return <button type={type} onClick={onClick} disabled={disabled} className={btnPrimCls}>{children}</button>;
}
function BtnDanger({ children, onClick, disabled, type = "button" }) {
  return <button type={type} onClick={onClick} disabled={disabled} className={btnDanCls}>{children}</button>;
}
function Th({ children, onClick, active, align }) {
  return (
    <th
      onClick={onClick}
      title={onClick ? "Click to sort" : undefined}
      className={[
        "text-xs font-bold uppercase tracking-widest px-3 py-2.5 whitespace-nowrap border-b border-white/[0.06] select-none",
        onClick ? "cursor-pointer" : "",
        active ? "text-slate-300" : "text-slate-500",
        align === "right" ? "text-right" : "text-left",
      ].join(" ")}
    >
      {children}
    </th>
  );
}
function Td({ children, align, colSpan }) {
  return (
    <td
      colSpan={colSpan}
      className={`text-sm text-slate-300 px-3 py-3 align-top ${align === "right" ? "text-right" : "text-left"}`}
    >
      {children}
    </td>
  );
}

const inputCls = "w-full bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2.5 text-slate-200 text-sm outline-none focus:border-blue-500/[0.4] transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
const btnPrimCls = "text-xs font-bold text-slate-100 px-3 py-1.5 rounded-lg border border-blue-500/[0.3] bg-blue-500/[0.15] hover:bg-blue-500/[0.25] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
const btnSmCls = "text-xs font-bold text-slate-400 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08] hover:text-slate-200 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
const btnDanCls = "text-xs font-bold text-red-400 px-3 py-1.5 rounded-lg border border-red-500/[0.3] bg-red-500/[0.08] hover:bg-red-500/[0.15] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap";
