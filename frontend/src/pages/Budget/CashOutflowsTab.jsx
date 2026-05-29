import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../../api/client.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const CC_CATEGORIES = [
  "Groceries","Dining Out","Housing","Transport","Utilities",
  "Healthcare","Personal","Household","Investments","Education","Entertainment","Other",
];

const SECTION_META = {
  fixed:      { label: "Fixed Expenses", color: "#60a5fa" },
  loan:       { label: "Loans",          color: "#a78bfa" },
  investment: { label: "Investments",    color: "#34d399" },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt$(n) {
  if (n == null) return "—";
  const abs = Math.abs(Number(n));
  const s = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${Number(n) < 0 ? "−" : ""}$${s}`;
}

function ordinal(n) {
  const v = n % 10;
  return `${n}${["st","nd","rd"][v - 1] || "th"}`;
}

// ── Shared colgroup — identical widths across Fixed / Loans / Investments ─────
// table-fixed + this colgroup forces each section's columns to align visually
// even though they are separate <table> elements inside different cards.

const OUTFLOW_COLGROUP = (
  <colgroup>
    <col />                                {/* Name — fills remaining space */}
    <col style={{ width: "7.5rem" }} />    {/* Budgeted */}
    <col style={{ width: "11.5rem" }} />   {/* Actual */}
    <col style={{ width: "6rem" }} />      {/* Variance */}
    <col style={{ width: "5rem" }} />      {/* Due */}
  </colgroup>
);

const OUTFLOW_THEAD = (
  <thead>
    <tr className="border-b border-white/[0.04]">
      <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-600 text-left">Name</th>
      <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-600 text-left">Budgeted</th>
      <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-600 text-left">Actual ($)</th>
      <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-600 text-left">Variance</th>
      <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-600 text-left">Due</th>
    </tr>
  </thead>
);

// ── Collapsible section header ─────────────────────────────────────────────────

function SectionHeader({ label, color, count, totalLabel, isOpen, onToggle }) {
  return (
    <button type="button" onClick={onToggle}
      className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-all cursor-pointer">
      <div className="flex items-center gap-2.5">
        <span className="text-xs font-bold uppercase tracking-wide" style={{ color }}>{label}</span>
        {count > 0 && (
          <span className="text-[10px] text-slate-600 bg-white/[0.04] rounded-full px-2 py-0.5">
            {count} item{count !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {totalLabel && <span className="text-sm text-slate-400">{totalLabel}</span>}
        <svg className={`w-3.5 h-3.5 text-slate-600 transition-transform ${isOpen ? "rotate-180" : ""}`}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
    </button>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function CashOutflowsTab({ year }) {
  const qc = useQueryClient();
  const currentMonth = new Date().getMonth() + 1;
  const [month, setMonth]       = useState(currentMonth);
  const [collapsed, setCollapsed] = useState({ fixed: false, loan: false, investment: false, cc: false });
  const [actuals, setActuals]   = useState({});   // { [itemId]: string }
  const [saving, setSaving]     = useState(false);
  const [saveError, setSaveError] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.budgetOutflows(year, month),
    queryFn:  () => api.get(`/budget/outflows/${year}/${month}`),
    staleTime: 30_000,
  });

  const planned = data?.planned || [];
  const cc      = data?.cc      || [];
  const summary = data?.summary || {};

  // Baseline (server-loaded) values — recomputes whenever data changes
  const originalActuals = useMemo(() => {
    const p = data?.planned || [];
    return Object.fromEntries(
      p.map(item => [item.itemId, String(item.actualAmount ?? item.budgetedAmount ?? "")])
    );
  }, [data]);

  // Sync editable actuals when data loads (e.g. on month change or after save)
  useEffect(() => {
    const p = data?.planned || [];
    if (!p.length) return;
    setActuals(
      Object.fromEntries(
        p.map(item => [item.itemId, String(item.actualAmount ?? item.budgetedAmount ?? "")])
      )
    );
  }, [data]);

  // Which items have been edited
  const dirtyItems = planned.filter(item => actuals[item.itemId] !== originalActuals[item.itemId]);
  const isDirty    = dirtyItems.length > 0;

  // Group planned items by type
  const byType = useMemo(() => {
    const m = { fixed: [], loan: [], investment: [] };
    for (const item of planned) { if (m[item.type]) m[item.type].push(item); }
    return m;
  }, [planned]);

  // Total CC spend — sum ALL items directly, identical to GoalsTab, so nothing is ever excluded.
  const ccTotal = Math.round(cc.reduce((s, item) => s + Number(item.amount || 0), 0) * 100) / 100;

  // Aggregate by budget category for the row-by-row display.
  // Unrecognized budgetCategory falls into "Other" so all rows add up to ccTotal.
  const ccByCategory = useMemo(() => {
    const m = {};
    for (const item of cc) {
      const k = CC_CATEGORIES.includes(item.budgetCategory) ? item.budgetCategory : "Other";
      m[k] = (m[k] || 0) + Number(item.amount || 0);
    }
    return m;
  }, [cc]);

  const ccRows = CC_CATEGORIES.map(cat => ({ cat, total: ccByCategory[cat] || 0 })).filter(r => r.total > 0);

  // Live actual total — only count items whose due date has passed
  const liveActualsTotal = planned.reduce((s, item) => {
    if (!item.pastDue) return s;
    const v = parseFloat(actuals[item.itemId]);
    return s + (Number.isFinite(v) ? v : (item.budgetedAmount || 0));
  }, 0);

  function toggle(key) { setCollapsed(c => ({ ...c, [key]: !c[key] })); }

  function handleActualChange(itemId, val) { setSaveError(""); setActuals(a => ({ ...a, [itemId]: val })); }

  function handleReset(item) { handleActualChange(item.itemId, String(item.budgetedAmount ?? "")); }

  function handleDiscardChanges() { setActuals({ ...originalActuals }); setSaveError(""); }

  async function handleSave() {
    setSaving(true);
    setSaveError("");
    try {
      await Promise.all(dirtyItems.map(async item => {
        const val = parseFloat(actuals[item.itemId]);
        if (!Number.isFinite(val) || val < 0) throw new Error(`Invalid amount for "${item.name}"`);
        if (val === item.budgetedAmount) {
          // Typed back the budgeted amount — remove override if one exists
          if (item.hasOverride) {
            await api.delete(`/budget/outflow-override/${item.itemId}/${year}/${month}`);
          }
        } else {
          await api.put(`/budget/outflow-override/${item.itemId}/${year}/${month}`, { amount: val });
        }
      }));
      qc.invalidateQueries({ queryKey: queryKeys.budgetOutflows(year, month) });
    } catch (err) {
      setSaveError(err.detail?.error || err.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">

      {/* ── Month selector ── */}
      <div className="flex flex-wrap gap-1 rounded-xl border border-white/[0.06] bg-[#0F1729] p-1">
        {MONTHS.map((m, i) => (
          <button key={i + 1} type="button"
            onClick={() => { setMonth(i + 1); setSaveError(""); }}
            className="flex-1 min-w-[2.5rem] px-2 py-1.5 rounded-lg text-[11px] font-bold transition-all cursor-pointer text-center"
            style={month === i + 1 ? { background: "#334155", color: "#f1f5f9" } : { color: "#64748b" }}>
            {m.slice(0, 3)}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-10 text-center text-slate-500 text-sm">
          Loading…
        </div>
      ) : (
        <>
          {/* ── Summary strip ── */}
          {(summary.budgetedTotal > 0 || ccTotal > 0) && (() => {
            const totalActual = liveActualsTotal + ccTotal;
            const delta = totalActual - summary.budgetedTotal;
            const anyPastDue = planned.some(p => p.pastDue);
            return (
              <div className="rounded-xl border border-white/[0.06] bg-[#0F1729] px-5 py-3.5 flex flex-wrap items-center gap-6">
                <div>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Budgeted</p>
                  <p className="text-lg font-black text-slate-300" style={{ fontFamily: "Epilogue, sans-serif" }}>
                    {fmt$(summary.budgetedTotal)}
                  </p>
                </div>
                <div className="h-6 w-px bg-white/[0.06]" />
                <div>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Actual</p>
                  <p className="text-lg font-black text-slate-200" style={{ fontFamily: "Epilogue, sans-serif" }}>
                    {anyPastDue || ccTotal > 0 ? fmt$(totalActual) : "—"}
                  </p>
                </div>
                {summary.budgetedTotal > 0 && (anyPastDue || ccTotal > 0) && (
                  <>
                    <div className="h-6 w-px bg-white/[0.06]" />
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Variance</p>
                      <p className={`text-lg font-black ${delta > 0 ? "text-red-400" : "text-emerald-400"}`}
                        style={{ fontFamily: "Epilogue, sans-serif" }}>
                        {delta > 0 ? "+" : ""}{fmt$(delta)}
                      </p>
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          {/* ── Fixed / Loans / Investments ── */}
          {(["fixed", "loan", "investment"]).map(typeKey => {
            const items = byType[typeKey];
            if (!items.length) return null;
            const meta   = SECTION_META[typeKey];
            const isOpen = !collapsed[typeKey];

            // Per-section totals for the header label
            const sectionBudgeted = items.reduce((s, item) => s + (item.budgetedAmount || 0), 0);
            const sectionActual   = items.reduce((s, item) => {
              if (!item.pastDue) return s;
              const v = parseFloat(actuals[item.itemId]);
              return s + (Number.isFinite(v) ? v : (item.budgetedAmount || 0));
            }, 0);
            const anyPastDue = items.some(item => item.pastDue);
            const totalLabel = sectionBudgeted > 0
              ? anyPastDue
                ? `${fmt$(sectionActual)} actual · ${fmt$(sectionBudgeted)} budgeted`
                : `${fmt$(sectionBudgeted)} budgeted`
              : null;

            return (
              <div key={typeKey} className="rounded-2xl border border-white/[0.06] bg-[#0F1729] overflow-hidden">
                <SectionHeader
                  label={meta.label}
                  color={meta.color}
                  count={items.length}
                  totalLabel={totalLabel}
                  isOpen={isOpen}
                  onToggle={() => toggle(typeKey)}
                />
                {isOpen && (
                  <div className="border-t border-white/[0.06] overflow-x-auto">
                    <table className="w-full border-collapse table-fixed" style={{ minWidth: 520 }}>
                      {OUTFLOW_COLGROUP}
                      {OUTFLOW_THEAD}
                      <tbody className="divide-y divide-white/[0.03]">
                        {items.map(item => {
                          const pastDue    = item.pastDue;
                          const parsed     = parseFloat(actuals[item.itemId]);
                          const budgeted   = item.budgetedAmount || 0;
                          const actual     = Number.isFinite(parsed) ? parsed : budgeted;
                          const variance   = pastDue ? actual - budgeted : 0;
                          const isDirtyRow = actuals[item.itemId] !== originalActuals[item.itemId];
                          return (
                            <tr key={item.itemId} className="hover:bg-white/[0.01]">
                              {/* Name */}
                              <td className="px-4 py-2.5">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm text-slate-300">{item.name}</span>
                                  {!pastDue && (
                                    <span className="text-[9px] text-slate-500 bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-0.5">
                                      Pending
                                    </span>
                                  )}
                                  {pastDue && item.hasOverride && !isDirtyRow && (
                                    <span className="text-[9px] text-amber-400 bg-amber-500/[0.1] border border-amber-500/20 rounded px-1.5 py-0.5">
                                      edited
                                    </span>
                                  )}
                                </div>
                              </td>
                              {/* Budgeted */}
                              <td className="px-4 py-2.5 text-left text-sm text-slate-500 tabular-nums">
                                {fmt$(budgeted)}
                              </td>
                              {/* Actual */}
                              <td className="px-4 py-2.5 text-left">
                                {pastDue ? (
                                  <div className="flex items-center gap-2">
                                    {item.hasOverride && !isDirtyRow && (
                                      <button type="button" onClick={() => handleReset(item)}
                                        className="text-[10px] text-slate-600 hover:text-red-400 transition-all cursor-pointer">
                                        reset
                                      </button>
                                    )}
                                    <input
                                      type="number" step="0.01" min="0"
                                      value={actuals[item.itemId] ?? ""}
                                      onChange={e => handleActualChange(item.itemId, e.target.value)}
                                      className={`w-28 bg-white/[0.04] border rounded-lg px-2.5 py-1 text-sm text-left tabular-nums text-slate-200 focus:outline-none transition-all
                                        ${isDirtyRow ? "border-blue-500/50 bg-blue-500/[0.05]" : "border-white/[0.08]"}`}
                                    />
                                  </div>
                                ) : (
                                  <span className="text-sm text-slate-700 tabular-nums">$0.00</span>
                                )}
                              </td>
                              {/* Variance */}
                              <td className="px-4 py-2.5 text-left text-xs tabular-nums">
                                {pastDue && variance !== 0 ? (
                                  <span className={variance > 0 ? "text-red-400" : "text-emerald-400"}>
                                    {variance > 0 ? "+" : ""}{fmt$(variance)}
                                  </span>
                                ) : (
                                  <span className="text-slate-700">—</span>
                                )}
                              </td>
                              {/* Due */}
                              <td className="px-4 py-2.5 text-xs text-slate-600">
                                {item.frequency === "annual"
                                  ? <span className="text-amber-500">Annual</span>
                                  : item.dueDay ? ordinal(item.dueDay) : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}

          {/* ── Save / Discard actuals ── */}
          {isDirty && (
            <div className="flex items-center gap-3 flex-wrap">
              <button type="button" onClick={handleSave} disabled={saving}
                className="px-5 py-2 rounded-xl bg-blue-600 text-sm font-bold text-white hover:bg-blue-500 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
                {saving ? "Saving…" : `Save Actuals (${dirtyItems.length} changed)`}
              </button>
              <button type="button" onClick={handleDiscardChanges}
                className="px-4 py-2 rounded-xl border border-white/[0.1] bg-white/[0.04] text-sm font-semibold text-slate-400 hover:text-slate-200 transition-all cursor-pointer">
                Discard
              </button>
              {saveError && (
                <p className="text-xs text-red-400">{saveError}</p>
              )}
            </div>
          )}

          {/* ── Credit Cards (read-only, grouped by category) ── */}
          <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] overflow-hidden">
            <SectionHeader
              label="Credit Cards"
              color="#94a3b8"
              count={ccRows.length}
              totalLabel={ccTotal > 0 ? fmt$(ccTotal) : null}
              isOpen={!collapsed.cc}
              onToggle={() => toggle("cc")}
            />
            {!collapsed.cc && (
              <div className="border-t border-white/[0.06]">
                {ccRows.length === 0 ? (
                  <p className="px-4 py-6 text-center text-xs text-slate-600">
                    No CC transactions uploaded for {MONTHS[month - 1]}.
                  </p>
                ) : (
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-white/[0.04]">
                        <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-600 text-left">Category</th>
                        <th className="px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-600 text-right">Actual Spend</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.03]">
                      {ccRows.map(({ cat, total }) => (
                        <tr key={cat} className="hover:bg-white/[0.01]">
                          <td className="px-4 py-2.5 text-sm text-slate-300">{cat}</td>
                          <td className="px-4 py-2.5 text-right text-sm font-semibold text-slate-200 tabular-nums">
                            {fmt$(total)}
                          </td>
                        </tr>
                      ))}
                      <tr className="border-t border-white/[0.06]">
                        <td className="px-4 py-2 text-xs font-bold text-slate-500 uppercase tracking-wide">Total</td>
                        <td className="px-4 py-2 text-right text-sm font-bold text-slate-200 tabular-nums">
                          {fmt$(ccTotal)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
                <p className="px-4 py-2 text-[10px] text-slate-700">
                  CC spend is read-only — populated from uploaded transactions in the Spending tab.
                </p>
              </div>
            )}
          </div>

          {/* ── Empty state ── */}
          {!planned.length && !cc.length && (
            <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-6 py-10 text-center">
              <p className="text-slate-400 text-sm font-semibold mb-2">No outflows for {MONTHS[month - 1]}</p>
              <p className="text-slate-600 text-xs max-w-sm mx-auto">
                Set up your budget in the Setup tab to see planned outflows here.
                CC spending appears automatically when transactions are uploaded.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
