import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";

const CATEGORY_OPTIONS = ["Education", "Retirement", "Robo", "Cash", "Options", "Property"];
const COUNTRY_OPTIONS = ["USA", "India"];
const DEFAULT_FORM = { country: "USA", category: "Education", description: "", value: "" };

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function safeNum(v, fallback = 0) { const x = Number(v); return Number.isFinite(x) ? x : fallback; }
function formatMoney(n) {
  const x = safeNum(n, 0);
  return x.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function normalizeApiRow(item) {
  const c = String(item?.country || "").trim();
  const country = c ? (c.toUpperCase() === "INDIA" ? "INDIA" : "USA") : "USA";
  return { ...item, country, id: item.assetId || item.id };
}

export default function OtherAssets() {
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
    queryKey: queryKeys.otherAssets(),
    queryFn: () => api.get("/assets/otherassets"),
  });

  const rows = useMemo(() => {
    const list = Array.isArray(rawData?.items) ? rawData.items : Array.isArray(rawData) ? rawData : [];
    return list.map(normalizeApiRow);
  }, [rawData]);

  const saveMut = useMutation({
    mutationFn: ({ id, payload }) =>
      id ? api.patch(`/assets/otherassets/${encodeURIComponent(id)}`, payload) : api.post("/assets/otherassets", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.otherAssets() });
      resetForm({ hide: true });
    },
    onError: (e) => setError(e?.message || "Save failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => api.delete(`/assets/otherassets/${encodeURIComponent(id)}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.otherAssets() });
      if (editingId === id) resetForm({ hide: true });
    },
    onError: (e) => setError(e?.message || "Delete failed"),
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
        const hay = `${r.country || ""} ${r.category || ""} ${r.description || ""}`.toLowerCase();
        return hay.includes(q);
      });
    }
    const dir = sortDir === "asc" ? 1 : -1;
    const getVal = (r) => {
      switch (sortKey) {
        case "country": return String(r.country || "");
        case "category": return r.category || "";
        case "value": return safeNum(r.value, 0);
        case "description": return r.description || "";
        case "updatedAt": default: return r.updatedAt || r.createdAt || "";
      }
    };
    return [...list].sort((a, b) => {
      const va = getVal(a), vb = getVal(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [rows, search, countryFilter, sortKey, sortDir]);

  const totalValue = useMemo(() => {
    const base = countryFilter === "ALL"
      ? rows
      : rows.filter((r) => String(r.country || "").toUpperCase() === (countryFilter === "India" ? "INDIA" : "USA"));
    return base.reduce((s, r) => s + safeNum(r.value, 0), 0);
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
      country: c === "INDIA" ? "India" : "USA",
      category: CATEGORY_OPTIONS.includes(r.category) ? r.category : "Education",
      description: r.description || "",
      value: String(r.value ?? ""),
    });
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function buildPayloadFromForm() {
    const country = String(form.country || "").trim();
    const category = String(form.category || "").trim();
    const description = String(form.description || "").trim();
    const value = safeNum(form.value, NaN);
    if (!country || !COUNTRY_OPTIONS.includes(country)) throw new Error("Country is required");
    if (!category || !CATEGORY_OPTIONS.includes(category)) throw new Error("Asset Category is required");
    if (!description) throw new Error("Asset Description is required");
    if (!Number.isFinite(value)) throw new Error("Asset Value must be a valid number");
    return {
      country: country === "India" ? "INDIA" : "USA",
      category, description,
      value: Number(clamp(value, -1e15, 1e15).toFixed(2)),
    };
  }
  function onSubmit(e) {
    e.preventDefault(); setError("");
    let payload;
    try { payload = buildPayloadFromForm(); }
    catch (err) { setError(err?.message || "Save failed"); return; }
    saveMut.mutate({ id: editingId, payload });
  }
  function onDelete(id) {
    setError("");
    if (!window.confirm("Delete this other asset record?")) return;
    deleteMut.mutate(id);
  }
  function onToggleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  return (
    <div className="p-4 text-slate-300">
      <h1 className="text-2xl font-black text-slate-100 tracking-tight mb-4">Other Assets</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <MetricCard label="Total Other Assets" value={formatMoney(totalValue)} sub="Sum of all listed records" />
      </div>

      {showForm && (
        <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-4 mb-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <span className="text-sm font-black text-slate-100">
              {editingId ? "Edit Other Asset" : "Add Other Asset"}
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
              <FLabel label="Asset Category">
                <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} className={inputCls} disabled={saving}>
                  {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </FLabel>
              <FLabel label="Country">
                <select value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))} className={inputCls} disabled={saving}>
                  {COUNTRY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </FLabel>
              <FLabel label="Asset Description">
                <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="e.g., Robinhood Cash Sweep" className={inputCls} disabled={saving} />
              </FLabel>
              <FLabel label="Latest Asset Value (USD)">
                <input value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} placeholder="1000.00" inputMode="decimal" className={inputCls} disabled={saving} />
              </FLabel>
            </div>
            <div className="flex gap-2 justify-end mt-1">
              <Btn type="button" onClick={() => resetForm()} disabled={saving}>Reset</Btn>
              <BtnPrimary type="submit" disabled={saving}>
                {saving ? "Saving…" : editingId ? "Save Changes" : "Add Record"}
              </BtnPrimary>
            </div>
          </form>
        </div>
      )}

      <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-4">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
          <span className="text-sm font-black text-slate-100">All Records</span>
          <div className="flex gap-2 items-center flex-wrap">
            <BtnPrimary onClick={openCreateForm} disabled={saving}>Add Other Asset</BtnPrimary>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className={`${inputCls} !w-48`} disabled={loading} />
            <select value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)} className={`${inputCls} !w-32`} disabled={loading}>
              <option value="ALL">All</option>
              <option value="USA">USA</option>
              <option value="India">India</option>
            </select>
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} className={`${inputCls} !w-40`} disabled={loading}>
              <option value="updatedAt">Sort: Updated</option>
              <option value="country">Sort: Country</option>
              <option value="category">Sort: Category</option>
              <option value="description">Sort: Description</option>
              <option value="value">Sort: Value</option>
            </select>
            <Btn onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))} disabled={loading}>
              {sortDir === "asc" ? "Asc" : "Desc"}
            </Btn>
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
          <EmptyState type="empty" message='No other assets yet. Click "Add Other Asset" to create one.' />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th onClick={() => onToggleSort("category")} active={sortKey === "category"}>Asset Category</Th>
                  <Th onClick={() => onToggleSort("description")} active={sortKey === "description"}>Asset Description</Th>
                  <Th onClick={() => onToggleSort("country")} active={sortKey === "country"}>Country</Th>
                  <Th onClick={() => onToggleSort("value")} active={sortKey === "value"}>Latest Asset Value</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filteredSortedRows.map((r) => (
                  <tr key={r.id} className="border-t border-white/[0.06]">
                    <Td><span className="font-black text-slate-100">{r.category}</span></Td>
                    <Td><span className="font-black text-slate-100">{r.description}</span></Td>
                    <Td><span className="font-black text-slate-100">{String(r.country || "").toUpperCase() === "INDIA" ? "India" : "USA"}</span></Td>
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
                  <Td colSpan={3}><span className="font-black text-slate-100">Total</span></Td>
                  <Td><span className="font-black text-slate-100">{formatMoney(totalValue)}</span></Td>
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
