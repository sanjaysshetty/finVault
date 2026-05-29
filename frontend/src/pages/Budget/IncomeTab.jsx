import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../../api/client.js";

function fmt$(n) {
  return `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function EmptyRow() {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-10 text-center text-slate-500 text-sm">
      No income sources defined yet. Add one below.
    </div>
  );
}

function SourceRow({ source, onEdit, onDelete, isDeleting }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-white/[0.06] bg-[#0F1729]">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-slate-100">{source.name}</p>
        <p className="text-xs text-slate-500 mt-0.5">
          {fmt$(source.monthlyAmount)}/mo · {fmt$(source.monthlyAmount * 12)}/yr
        </p>
      </div>
      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
        source.isActive
          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
          : "bg-slate-500/10 text-slate-500 border-slate-500/25"
      }`}>
        {source.isActive ? "Active" : "Inactive"}
      </span>
      <div className="flex gap-1.5 shrink-0">
        <button
          type="button" onClick={() => onEdit(source)}
          className="px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border border-white/[0.1] bg-white/[0.04] text-slate-400 hover:text-slate-200 hover:bg-white/[0.08] transition-all cursor-pointer"
        >
          Edit
        </button>
        <button
          type="button" onClick={() => onDelete(source.id)} disabled={isDeleting}
          className="px-2.5 py-1.5 text-[11px] font-bold rounded-lg border border-red-500/25 bg-red-500/[0.07] text-red-400 hover:bg-red-500/[0.14] transition-all cursor-pointer disabled:opacity-40"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

const EMPTY_FORM = { name: "", monthlyAmount: "", isActive: true };

export default function IncomeTab({ year }) {
  const qc = useQueryClient();
  const [form, setForm]         = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [formError, setFormError] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.budgetIncome(year),
    queryFn:  () => api.get(`/budget/income/${year}`),
    staleTime: 60_000,
  });

  const sources = data?.sources || [];
  const totalMonthly = sources.filter(s => s.isActive).reduce((s, x) => s + x.monthlyAmount, 0);

  const saveMutation = useMutation({
    mutationFn: (newSources) => api.put(`/budget/income/${year}`, { sources: newSources }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.budgetIncome(year) });
      setForm(EMPTY_FORM);
      setEditingId(null);
      setFormError("");
    },
    onError: (err) => setFormError(err.detail?.error || err.message),
  });

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }

  function handleEdit(source) {
    setEditingId(source.id);
    setForm({ name: source.name, monthlyAmount: String(source.monthlyAmount), isActive: source.isActive });
    setFormError("");
  }

  function handleCancel() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError("");
  }

  function handleSubmit(e) {
    e.preventDefault();
    const amount = parseFloat(form.monthlyAmount);
    if (!form.name.trim()) return setFormError("Name is required");
    if (!Number.isFinite(amount) || amount <= 0) return setFormError("Amount must be > 0");
    setFormError("");

    let newSources;
    if (editingId) {
      newSources = sources.map(s =>
        s.id === editingId
          ? { ...s, name: form.name.trim(), monthlyAmount: amount, isActive: form.isActive }
          : s
      );
    } else {
      newSources = [...sources, {
        id: crypto.randomUUID(),
        name: form.name.trim(),
        monthlyAmount: amount,
        isActive: form.isActive,
      }];
    }
    saveMutation.mutate(newSources);
  }

  function handleDelete(id) {
    saveMutation.mutate(sources.filter(s => s.id !== id));
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Summary strip */}
      {sources.length > 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-[#0F1729] px-5 py-3 flex items-center gap-6">
          <div>
            <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Monthly Income</p>
            <p className="text-xl font-black text-emerald-400" style={{ fontFamily: "Epilogue, sans-serif" }}>
              {fmt$(totalMonthly)}
            </p>
          </div>
          <div className="h-8 w-px bg-white/[0.06]" />
          <div>
            <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Annual Income</p>
            <p className="text-xl font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
              {fmt$(totalMonthly * 12)}
            </p>
          </div>
          <div className="h-8 w-px bg-white/[0.06]" />
          <div>
            <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Sources</p>
            <p className="text-xl font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
              {sources.filter(s => s.isActive).length}
            </p>
          </div>
        </div>
      )}

      {/* Source list */}
      {isLoading ? (
        <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-10 text-center text-slate-500 text-sm">
          Loading…
        </div>
      ) : sources.length === 0 ? (
        <EmptyRow />
      ) : (
        <div className="flex flex-col gap-2">
          {sources.map(s => (
            <SourceRow
              key={s.id}
              source={s}
              onEdit={handleEdit}
              onDelete={handleDelete}
              isDeleting={saveMutation.isPending}
            />
          ))}
        </div>
      )}

      {/* Add / Edit form */}
      <div className="rounded-2xl border border-white/[0.08] bg-[#0F1729] p-5">
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-4">
          {editingId ? "Edit Income Source" : "Add Income Source"}
        </p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Name</label>
              <input
                type="text" required placeholder="e.g. Salary, Rental Income"
                value={form.name} onChange={e => set("name", e.target.value)}
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Monthly Amount ($)</label>
              <input
                type="number" step="0.01" min="0.01" required placeholder="8000"
                value={form.monthlyAmount} onChange={e => set("monthlyAmount", e.target.value)}
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer w-fit">
            <input
              type="checkbox" checked={form.isActive}
              onChange={e => set("isActive", e.target.checked)}
              className="rounded"
            />
            <span className="text-sm text-slate-400">Active (counts toward monthly income)</span>
          </label>

          {form.monthlyAmount && !isNaN(parseFloat(form.monthlyAmount)) && (
            <p className="text-xs text-slate-500">
              Annual: {fmt$(parseFloat(form.monthlyAmount) * 12)}
            </p>
          )}

          {formError && (
            <p className="text-xs text-red-400 bg-red-500/[0.08] border border-red-500/20 rounded-lg px-3 py-2">
              {formError}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            {editingId && (
              <button
                type="button" onClick={handleCancel}
                className="px-4 py-2 rounded-xl border border-white/[0.1] bg-white/[0.04] text-sm font-semibold text-slate-400 hover:text-slate-200 transition-all cursor-pointer"
              >
                Cancel
              </button>
            )}
            <button
              type="submit" disabled={saveMutation.isPending}
              className="px-5 py-2 rounded-xl bg-blue-600 text-sm font-bold text-white hover:bg-blue-500 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saveMutation.isPending ? "Saving…" : editingId ? "Update Source" : "Add Source"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
