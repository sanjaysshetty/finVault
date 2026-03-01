import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";

const COUNTRY_OPTIONS = ["USA", "India"];
const INSURANCE_TYPE_OPTIONS = [
  "Health", "Life", "Auto", "Home", "Renters", "Travel",
  "Disability", "Umbrella", "Pet", "Other",
];
const DEFAULT_FORM = {
  country: "USA",
  insuranceType: "Health",
  insuranceTypeOther: "",
  provider: "",
  coveredAmount: "",
  remarks: "",
};

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

export default function Insurance() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [countryFilter, setCountryFilter] = useState("ALL");
  const [sortKey, setSortKey] = useState("provider");
  const [sortDir, setSortDir] = useState("asc");

  const queryClient = useQueryClient();

  const { data: rawData, isLoading: loading, error: fetchError } = useQuery({
    queryKey: queryKeys.insurance(),
    queryFn: () => api.get("/assets/insurance"),
  });

  const rows = useMemo(() => {
    const list = Array.isArray(rawData?.items) ? rawData.items : Array.isArray(rawData) ? rawData : [];
    return list.map(normalizeApiRow);
  }, [rawData]);

  const saveMut = useMutation({
    mutationFn: ({ id, payload }) =>
      id ? api.patch(`/assets/insurance/${encodeURIComponent(id)}`, payload) : api.post("/assets/insurance", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.insurance() });
      resetForm({ hide: true });
    },
    onError: (e) => setError(e?.message || "Save failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => api.delete(`/assets/insurance/${encodeURIComponent(id)}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.insurance() });
      if (editingId === id) resetForm({ hide: true });
    },
    onError: (e) => setError(e?.message || "Delete failed"),
  });

  const saving = saveMut.isPending || deleteMut.isPending;

  const summary = useMemo(() => {
    const totalCovered = rows.reduce((acc, r) => acc + safeNum(r.coveredAmount, 0), 0);
    const usaCovered = rows
      .filter((r) => String(r.country || "").toUpperCase() !== "INDIA")
      .reduce((acc, r) => acc + safeNum(r.coveredAmount, 0), 0);
    const indiaCovered = rows
      .filter((r) => String(r.country || "").toUpperCase() === "INDIA")
      .reduce((acc, r) => acc + safeNum(r.coveredAmount, 0), 0);
    return { count: rows.length, totalCovered, usaCovered, indiaCovered };
  }, [rows]);

  const filteredSortedRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = rows.filter((r) => {
      if (countryFilter !== "ALL") {
        const isIndia = String(r.country || "").toUpperCase() === "INDIA";
        if (countryFilter === "USA" && isIndia) return false;
        if (countryFilter === "India" && !isIndia) return false;
      }
      if (!q) return true;
      const hay = [r.insuranceType, r.provider, r.remarks, String(r.coveredAmount ?? ""), String(r.country ?? "")]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      if (sortKey === "coveredAmount") return (safeNum(a.coveredAmount, 0) - safeNum(b.coveredAmount, 0)) * dir;
      const sa = String(a?.[sortKey] ?? "").toLowerCase();
      const sb = String(b?.[sortKey] ?? "").toLowerCase();
      if (sa < sb) return -1 * dir;
      if (sa > sb) return 1 * dir;
      return 0;
    });
    return list;
  }, [rows, search, countryFilter, sortKey, sortDir]);

  function openCreateForm() {
    setEditingId(null); setForm(DEFAULT_FORM); setError(""); setShowForm(true);
  }
  function resetForm({ hide } = {}) {
    setEditingId(null); setForm(DEFAULT_FORM); setError("");
    if (hide) setShowForm(false);
  }
  function startEdit(r) {
    setError(); setEditingId(r.id);
    const typeIsKnown = INSURANCE_TYPE_OPTIONS.includes(r.insuranceType);
    setForm({
      country: String(r.country || "").toUpperCase() === "INDIA" ? "India" : "USA",
      insuranceType: typeIsKnown ? r.insuranceType : "Other",
      insuranceTypeOther: typeIsKnown ? "" : String(r.insuranceType || ""),
      provider: String(r.provider || ""),
      coveredAmount: r.coveredAmount ?? "",
      remarks: String(r.remarks || ""),
    });
    setShowForm(true);
  }
  function getEffectiveInsuranceType(f) {
    if (f.insuranceType === "Other") return String(f.insuranceTypeOther || "").trim();
    return String(f.insuranceType || "").trim();
  }
  function validateFrontEnd(f) {
    const insuranceType = getEffectiveInsuranceType(f);
    if (!insuranceType) throw new Error("Insurance Type is required");
    if (!String(f.provider || "").trim()) throw new Error("Insurance Provider is required");
    const amt = Number(f.coveredAmount);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error("Covered Amount must be a number > 0");
  }
  function onSubmit(e) {
    e.preventDefault(); setError("");
    try { validateFrontEnd(form); } catch (err) { setError(err?.message || "Save failed"); return; }
    const payload = {
      country: form.country,
      insuranceType: getEffectiveInsuranceType(form),
      provider: String(form.provider || "").trim(),
      coveredAmount: Number(form.coveredAmount),
      remarks: String(form.remarks || "").trim(),
    };
    saveMut.mutate({ id: editingId, payload });
  }
  function onDelete(id) {
    setError("");
    if (!window.confirm("Delete this insurance record?")) return;
    deleteMut.mutate(id);
  }
  function onToggleSort(key) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  return (
    <div className="p-4 text-slate-300">
      <h1 className="text-2xl font-black text-slate-100 tracking-tight mb-4">Insurance</h1>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <MetricCard label="Policies" value={String(summary.count)} />
        <MetricCard label="Total Covered" value={formatMoney(summary.totalCovered)} />
        <MetricCard label="USA Covered" value={formatMoney(summary.usaCovered)} />
        <MetricCard label="India Covered" value={formatMoney(summary.indiaCovered)} />
      </div>

      {showForm && (
        <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] p-4 mb-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <span className="text-sm font-black text-slate-100">
              {editingId ? "Edit Insurance" : "Add Insurance"}
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
              <FLabel label="Country">
                <select value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))} className={inputCls} disabled={saving}>
                  {COUNTRY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </FLabel>
              <FLabel label="Insurance Type">
                <select value={form.insuranceType} onChange={(e) => setForm((f) => ({ ...f, insuranceType: e.target.value }))} className={inputCls} disabled={saving}>
                  {INSURANCE_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </FLabel>
              <FLabel label="Insurance Provider">
                <input value={form.provider} onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))} placeholder="e.g., Blue Cross / Geico / LIC" className={inputCls} disabled={saving} />
              </FLabel>
              <FLabel label="Covered Amount (USD)">
                <input value={form.coveredAmount} onChange={(e) => setForm((f) => ({ ...f, coveredAmount: e.target.value }))} placeholder="250000" inputMode="decimal" className={inputCls} disabled={saving} />
              </FLabel>
            </div>

            {form.insuranceType === "Other" && (
              <div>
                <FLabel label="Other Type">
                  <input value={form.insuranceTypeOther} onChange={(e) => setForm((f) => ({ ...f, insuranceTypeOther: e.target.value }))} placeholder="Enter insurance type" className={inputCls} disabled={saving} />
                </FLabel>
              </div>
            )}

            <div>
              <FLabel label="Remarks (optional)">
                <input value={form.remarks} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} placeholder="e.g., Policy #, coverage notes, renewal reminders" className={inputCls} disabled={saving} />
              </FLabel>
            </div>

            <div className="flex gap-2 justify-end mt-1">
              <Btn type="button" onClick={() => setForm(DEFAULT_FORM)} disabled={saving}>Reset</Btn>
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
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className={`${inputCls} !w-52`} disabled={loading} />
            <select value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)} className={`${inputCls} !w-32`} disabled={loading}>
              <option value="ALL">All</option>
              <option value="USA">USA</option>
              <option value="India">India</option>
            </select>
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} className={`${inputCls} !w-44`} disabled={loading}>
              <option value="provider">Sort: Provider</option>
              <option value="insuranceType">Sort: Type</option>
              <option value="country">Sort: Country</option>
              <option value="coveredAmount">Sort: Covered Amount</option>
            </select>
            <Btn onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))} disabled={loading}>
              {sortDir === "asc" ? "Asc" : "Desc"}
            </Btn>
            <BtnPrimary onClick={openCreateForm} disabled={saving}>+ Add Insurance Record</BtnPrimary>
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
          <EmptyState type="empty" message='No insurance records yet. Click "Add Insurance Record" to create one.' />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th onClick={() => onToggleSort("insuranceType")} active={sortKey === "insuranceType"}>Insurance Type</Th>
                  <Th onClick={() => onToggleSort("provider")} active={sortKey === "provider"}>Provider</Th>
                  <Th onClick={() => onToggleSort("country")} active={sortKey === "country"}>Country</Th>
                  <Th onClick={() => onToggleSort("coveredAmount")} active={sortKey === "coveredAmount"}>Covered Amount</Th>
                  <Th>Remarks</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filteredSortedRows.map((r) => (
                  <tr key={r.id} className="border-t border-white/[0.06]">
                    <Td><span className="font-black text-slate-100">{r.insuranceType}</span></Td>
                    <Td>{r.provider}</Td>
                    <Td>{String(r.country || "").toUpperCase() === "INDIA" ? "India" : "USA"}</Td>
                    <Td><span className="font-black text-slate-100">{formatMoney(r.coveredAmount)}</span></Td>
                    <Td>
                      <span className="text-xs text-slate-500 max-w-xs block truncate">{r.remarks || "—"}</span>
                    </Td>
                    <Td align="right">
                      <div className="flex gap-2 justify-end pr-2">
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
