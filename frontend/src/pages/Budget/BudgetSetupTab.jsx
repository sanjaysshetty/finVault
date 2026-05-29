import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../../api/client.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];

const CC_CATEGORIES = [
  { key: "Groceries",     label: "Groceries"       },
  { key: "Dining Out",    label: "Dining Out"       },
  { key: "Housing",       label: "Housing"          },
  { key: "Transport",     label: "Transportation"   },
  { key: "Utilities",     label: "Utilities"        },
  { key: "Healthcare",    label: "Healthcare"       },
  { key: "Personal",      label: "Personal Care"    },
  { key: "Household",     label: "Household"        },
  { key: "Investments",   label: "Investments"      },
  { key: "Education",     label: "Education"        },
  { key: "Entertainment", label: "Entertainment"    },
  { key: "Other",         label: "Other"            },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt$(n) {
  if (n == null || n === "") return "—";
  return `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Monthly-equivalent for a fixed expense (annual ÷ 12)
function monthlyEquiv(row) {
  const amt = parseFloat(row.amount) || 0;
  return row.frequency === "annual" ? amt / 12 : amt;
}

function sumMonthlyEquiv(items) {
  return items.reduce((s, r) => s + monthlyEquiv(r), 0);
}

function sumAmount(items) {
  return items.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
}

function defaultSections() {
  return {
    fixedExpenses:     [],
    loans:             [],
    investments:       [],
    creditCardBudgets: Object.fromEntries(CC_CATEGORIES.map(c => [c.key, ""])),
  };
}

function apiToSections(data) {
  if (!data) return defaultSections();
  return {
    fixedExpenses: (data.fixedExpenses || []).map(r => ({
      ...r,
      amount:    (r.amount ?? r.monthlyAmount ?? 0) > 0 ? String(r.amount ?? r.monthlyAmount) : "",
      dueDay:    r.dueDay  ? String(r.dueDay)  : "",
      dueMonth:  r.dueMonth ? String(r.dueMonth) : "1",
      frequency: r.frequency || "monthly",
    })),
    loans: (data.loans || []).map(r => ({
      ...r,
      amount: (r.amount ?? r.monthlyAmount ?? 0) > 0 ? String(r.amount ?? r.monthlyAmount) : "",
      dueDay: r.dueDay ? String(r.dueDay) : "",
    })),
    investments: (data.investments || []).map(r => ({
      ...r,
      amount: (r.amount ?? r.monthlyAmount ?? 0) > 0 ? String(r.amount ?? r.monthlyAmount) : "",
      dueDay: r.dueDay ? String(r.dueDay) : "",
    })),
    creditCardBudgets: Object.fromEntries(
      CC_CATEGORIES.map(({ key }) => [key, ((data.creditCardBudgets?.[key] || 0) > 0) ? String(data.creditCardBudgets[key]) : ""])
    ),
  };
}

function sectionsToPayload(sections) {
  const cleanRow = (r) => ({
    ...(r.id && !r.id.startsWith("tmp_") ? { id: r.id } : {}),
    name:   String(r.name || "").trim(),
    amount: parseFloat(r.amount) || 0,
    dueDay: parseInt(r.dueDay, 10) || null,
  });

  return {
    fixedExpenses: sections.fixedExpenses
      .filter(r => String(r.name || "").trim())
      .map(r => ({
        ...cleanRow(r),
        frequency: r.frequency || "monthly",
        ...(r.frequency === "annual" ? { dueMonth: parseInt(r.dueMonth, 10) || 1 } : {}),
      })),
    loans: sections.loans
      .filter(r => String(r.name || "").trim())
      .map(cleanRow),
    investments: sections.investments
      .filter(r => String(r.name || "").trim())
      .map(cleanRow),
    creditCardBudgets: Object.fromEntries(
      CC_CATEGORIES.map(({ key }) => [key, parseFloat(sections.creditCardBudgets[key]) || 0])
    ),
  };
}

// ── Section header ─────────────────────────────────────────────────────────────

function SectionHeader({ label, totalLabel, open, onToggle }) {
  return (
    <button type="button" onClick={onToggle}
      className="w-full flex items-center justify-between px-4 py-3 cursor-pointer">
      <span className="text-sm font-bold text-slate-200">{label}</span>
      <div className="flex items-center gap-3">
        {totalLabel && <span className="text-sm text-slate-400">{totalLabel}</span>}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          className={`w-4 h-4 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
    </button>
  );
}

// ── Shared budget item table (Fixed Expenses, Loans, Investments) ─────────────
// All three use identical colgroup widths so columns align across sections.

const INPUT  = "w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50";
const SELECT = "bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50 cursor-pointer";

const DELETE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

// type: "fixed" | "loan" | "investment"
function BudgetItemTable({ type, rows, onChange, onAdd, onRemove }) {
  const isFixed = type === "fixed";
  const addLabel = type === "fixed" ? "Add fixed expense" : type === "loan" ? "Add loan" : "Add investment";

  return (
    <div className="px-4 pb-4 flex flex-col gap-2">
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          {/* table-fixed + colgroup enforces identical column widths for all three sections */}
          <table className="w-full border-collapse table-fixed" style={{ minWidth: 460 }}>
            <colgroup>
              <col />                                   {/* Name — fills remaining space */}
              <col style={{ width: "7.5rem" }} />       {/* Amount */}
              <col style={{ width: "12.5rem" }} />      {/* Schedule */}
              <col style={{ width: "2.25rem" }} />      {/* Remove */}
            </colgroup>
            <thead>
              <tr>
                <th className="pb-2 pr-2 text-left text-[10px] font-bold uppercase tracking-wide text-slate-600">Name</th>
                <th className="pb-2 pr-2 text-left text-[10px] font-bold uppercase tracking-wide text-slate-600">
                  {isFixed ? "Amount" : "Monthly ($)"}
                </th>
                <th className="pb-2 pr-2 text-left text-[10px] font-bold uppercase tracking-wide text-slate-600">
                  {isFixed ? "Frequency & Due" : "Due Day"}
                </th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.03]">
              {rows.map(row => (
                <tr key={row.id}>
                  {/* Name */}
                  <td className="py-1.5 pr-2">
                    <input type="text"
                      placeholder={isFixed ? "e.g. Mortgage" : "Name"}
                      value={row.name || ""}
                      onChange={e => onChange(row.id, "name", e.target.value)}
                      className={INPUT}
                    />
                  </td>

                  {/* Amount */}
                  <td className="py-1.5 pr-2">
                    <input type="number" step="1" min="0"
                      placeholder={isFixed && row.frequency === "annual" ? "Annual $" : "Monthly $"}
                      value={row.amount || ""}
                      onChange={e => onChange(row.id, "amount", e.target.value)}
                      className={INPUT}
                    />
                  </td>

                  {/* Schedule */}
                  <td className="py-1.5 pr-2">
                    {isFixed ? (
                      <div className="flex items-center gap-1.5">
                        <select value={row.frequency || "monthly"}
                          onChange={e => onChange(row.id, "frequency", e.target.value)}
                          className={`${SELECT} flex-1`}>
                          <option value="monthly">Monthly</option>
                          <option value="annual">Annual</option>
                        </select>
                        {row.frequency === "annual" ? (
                          <select value={row.dueMonth || "1"}
                            onChange={e => onChange(row.id, "dueMonth", e.target.value)}
                            className={`${SELECT} flex-1 min-w-0`}>
                            {MONTH_NAMES.map((m, i) => (
                              <option key={i + 1} value={i + 1}>{m}</option>
                            ))}
                          </select>
                        ) : (
                          <input type="number" step="1" min="1" max="31" placeholder="Day"
                            value={row.dueDay || ""}
                            onChange={e => onChange(row.id, "dueDay", e.target.value)}
                            className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50"
                          />
                        )}
                      </div>
                    ) : (
                      <input type="number" step="1" min="1" max="31" placeholder="Day"
                        value={row.dueDay || ""}
                        onChange={e => onChange(row.id, "dueDay", e.target.value)}
                        className="w-20 bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50"
                      />
                    )}
                  </td>

                  {/* Remove */}
                  <td className="py-1.5">
                    <button type="button" onClick={() => onRemove(row.id)}
                      className="text-slate-600 hover:text-red-400 transition-colors p-1 cursor-pointer">
                      {DELETE_ICON}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" onClick={onAdd}
        className="self-start flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors cursor-pointer mt-1">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        {addLabel}
      </button>
    </div>
  );
}

// kept as a stub so old code below doesn't break before we update call sites
function LineItemTable({ rows, onChange, onAdd, onRemove, addLabel }) {
  const type = addLabel === "Add loan" ? "loan" : "investment";
  return <BudgetItemTable type={type} rows={rows} onChange={onChange} onAdd={onAdd} onRemove={onRemove} />;
}


// ── Main component ─────────────────────────────────────────────────────────────

export default function BudgetSetupTab({ year }) {
  const qc = useQueryClient();
  const currentMonth = new Date().getMonth() + 1;

  const [sections, setSections]   = useState(defaultSections);
  const [isDirty,  setIsDirty]    = useState(false);
  const [saveMsg,  setSaveMsg]    = useState("");
  const [collapsed, setCollapsed] = useState({ fixed: false, loans: false, investments: false, cc: false });

  const defQ = useQuery({
    queryKey: queryKeys.budgetDefinition(year),
    queryFn:  () => api.get(`/budget/definition/${year}`),
    staleTime: 60_000,
  });

  const incomeQ = useQuery({
    queryKey: queryKeys.budgetIncome(year),
    queryFn:  () => api.get(`/budget/income/${year}`),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (defQ.data && !isDirty) setSections(apiToSections(defQ.data));
  }, [defQ.data]);

  const saveMutation = useMutation({
    mutationFn: (payload) => api.put(`/budget/definition/${year}`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.budgetDefinition(year) });
      // Invalidate outflows cache so the planned section refreshes
      qc.invalidateQueries({ queryKey: ["budget", "outflows"] });
      setIsDirty(false);
      setSaveMsg("Budget saved.");
      setTimeout(() => setSaveMsg(""), 3000);
    },
    onError: (err) => setSaveMsg(`Error: ${err.detail?.error || err.message}`),
  });

  const markDirty = useCallback(() => { setIsDirty(true); setSaveMsg(""); }, []);

  function addRow(section) {
    const base = { id: `tmp_${Date.now()}`, name: "", amount: "", dueDay: "" };
    const extra = section === "fixedExpenses" ? { frequency: "monthly", dueMonth: "1" } : {};
    setSections(prev => ({ ...prev, [section]: [...prev[section], { ...base, ...extra }] }));
    markDirty();
  }

  function removeRow(section, id) {
    setSections(prev => ({ ...prev, [section]: prev[section].filter(r => r.id !== id) }));
    markDirty();
  }

  function editRow(section, id, field, value) {
    setSections(prev => ({
      ...prev,
      [section]: prev[section].map(r => r.id === id ? { ...r, [field]: value } : r),
    }));
    markDirty();
  }

  function setCCBudget(key, value) {
    setSections(prev => ({ ...prev, creditCardBudgets: { ...prev.creditCardBudgets, [key]: value } }));
    markDirty();
  }

  function handleSave(e) {
    e.preventDefault();
    saveMutation.mutate(sectionsToPayload(sections));
  }

  // ── Derived totals ──
  const fixedMonthly = sumMonthlyEquiv(sections.fixedExpenses);
  const fixedAnnual  = sections.fixedExpenses
    .filter(r => r.frequency === "annual")
    .reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const fixedMonthlyOnly = sections.fixedExpenses
    .filter(r => r.frequency !== "annual")
    .reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);

  const loansTotal  = sumAmount(sections.loans);
  const investTotal = sumAmount(sections.investments);
  const ccBudget    = CC_CATEGORIES.reduce((s, { key }) => s + (parseFloat(sections.creditCardBudgets[key]) || 0), 0);
  const totalOutMonthly = fixedMonthly + loansTotal + investTotal + ccBudget;

  const monthlyIncome = (incomeQ.data?.sources || []).filter(s => s.isActive).reduce((s, x) => s + x.monthlyAmount, 0);
  const buffer = monthlyIncome - totalOutMonthly;
  const savingsRate = monthlyIncome > 0 ? ((buffer / monthlyIncome) * 100).toFixed(1) : null;

  const toggle = (key) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));

  if (defQ.isLoading) {
    return (
      <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-10 text-center text-slate-500 text-sm">
        Loading…
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="flex flex-col gap-4">

      {/* ── Fixed Expenses ── */}
      <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] overflow-hidden">
        <SectionHeader
          label="Fixed Expenses"
          totalLabel={
            (fixedMonthlyOnly > 0 || fixedAnnual > 0)
              ? [
                  fixedMonthlyOnly > 0 ? `${fmt$(fixedMonthlyOnly)}/mo` : null,
                  fixedAnnual > 0      ? `${fmt$(fixedAnnual)}/yr`      : null,
                ].filter(Boolean).join(" · ")
              : null
          }
          open={!collapsed.fixed}
          onToggle={() => toggle("fixed")}
        />
        {!collapsed.fixed && (
          <>
            <div className="border-t border-white/[0.06]" />
            <BudgetItemTable
              type="fixed"
              rows={sections.fixedExpenses}
              onChange={(id, f, v) => editRow("fixedExpenses", id, f, v)}
              onAdd={() => addRow("fixedExpenses")}
              onRemove={(id) => removeRow("fixedExpenses", id)}
            />
          </>
        )}
      </div>

      {/* ── Loans ── */}
      <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] overflow-hidden">
        <SectionHeader
          label="Loans"
          totalLabel={loansTotal > 0 ? `${fmt$(loansTotal)}/mo` : null}
          open={!collapsed.loans}
          onToggle={() => toggle("loans")}
        />
        {!collapsed.loans && (
          <>
            <div className="border-t border-white/[0.06]" />
            <LineItemTable
              rows={sections.loans}
              onChange={(id, f, v) => editRow("loans", id, f, v)}
              onAdd={() => addRow("loans")}
              onRemove={(id) => removeRow("loans", id)}
              addLabel="Add loan"
            />
          </>
        )}
      </div>

      {/* ── Investments ── */}
      <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] overflow-hidden">
        <SectionHeader
          label="Investments"
          totalLabel={investTotal > 0 ? `${fmt$(investTotal)}/mo` : null}
          open={!collapsed.investments}
          onToggle={() => toggle("investments")}
        />
        {!collapsed.investments && (
          <>
            <div className="border-t border-white/[0.06]" />
            <LineItemTable
              rows={sections.investments}
              onChange={(id, f, v) => editRow("investments", id, f, v)}
              onAdd={() => addRow("investments")}
              onRemove={(id) => removeRow("investments", id)}
              addLabel="Add investment"
            />
          </>
        )}
      </div>

      {/* ── Credit Cards ── */}
      <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] overflow-hidden">
        <SectionHeader
          label="Credit Cards"
          totalLabel={ccBudget > 0 ? `${fmt$(ccBudget)}/mo` : null}
          open={!collapsed.cc}
          onToggle={() => toggle("cc")}
        />
        {!collapsed.cc && (
          <>
            <div className="border-t border-white/[0.06]" />
            <p className="px-4 pt-3 pb-1 text-[10px] text-slate-600">
              Monthly budget per category — applies until changed.
            </p>
            <div className="px-4 pb-4">
              <table className="w-full border-collapse mt-1">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="pb-2 text-left text-[10px] font-bold uppercase tracking-wide text-slate-500">Category</th>
                    <th className="pb-2 text-right text-[10px] font-bold uppercase tracking-wide text-slate-500 w-36">Monthly Budget ($)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.03]">
                  {CC_CATEGORIES.map(({ key, label }) => (
                    <tr key={key} className="hover:bg-white/[0.01]">
                      <td className="py-1.5 pr-3 text-sm text-slate-300">{label}</td>
                      <td className="py-1.5">
                        <input type="number" step="1" min="0" placeholder="0"
                          value={sections.creditCardBudgets[key] || ""}
                          onChange={e => setCCBudget(key, e.target.value)}
                          className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50 text-right"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-white/[0.06]">
                  <tr>
                    <td className="pt-2 text-xs font-bold text-slate-400">Total</td>
                    <td className="pt-2 text-right text-sm font-bold text-slate-200">{fmt$(ccBudget)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ── Summary strip ── */}
      <div className="rounded-xl border border-white/[0.06] bg-[#0F1729] px-5 py-3 flex flex-wrap items-center gap-6">
        {monthlyIncome > 0 && (
          <>
            <div>
              <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Income</p>
              <p className="text-lg font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
                {fmt$(monthlyIncome)}
              </p>
            </div>
            <div className="h-6 w-px bg-white/[0.06]" />
          </>
        )}
        {[
          { label: "Fixed/mo", val: fixedMonthly },
          { label: "Loans",    val: loansTotal   },
          { label: "CC Budget",val: ccBudget      },
          { label: "Invest",   val: investTotal   },
        ].map(({ label, val }) => (
          <div key={label}>
            <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">{label}</p>
            <p className="text-lg font-black text-slate-300" style={{ fontFamily: "Epilogue, sans-serif" }}>
              {fmt$(val)}
            </p>
          </div>
        ))}
        {monthlyIncome > 0 && (
          <>
            <div className="h-6 w-px bg-white/[0.06]" />
            <div>
              <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">
                {buffer >= 0 ? "Buffer" : "Deficit"}
              </p>
              <p className={`text-lg font-black ${buffer >= 0 ? "text-emerald-400" : "text-red-400"}`}
                style={{ fontFamily: "Epilogue, sans-serif" }}>
                {buffer < 0 ? "−" : ""}{fmt$(Math.abs(buffer))}
                {savingsRate && <span className="text-xs font-normal ml-1.5 text-slate-500">{savingsRate}%</span>}
              </p>
            </div>
          </>
        )}
      </div>

      {saveMsg && (
        <p className={`text-xs rounded-lg px-3 py-2 border ${
          saveMsg.startsWith("Error")
            ? "text-red-400 bg-red-500/[0.08] border-red-500/20"
            : "text-emerald-400 bg-emerald-500/[0.08] border-emerald-500/20"
        }`}>{saveMsg}</p>
      )}

      <button type="submit" disabled={saveMutation.isPending || !isDirty}
        className="self-start px-6 py-2.5 rounded-xl bg-blue-600 text-sm font-bold text-white hover:bg-blue-500 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
        {saveMutation.isPending ? "Saving…" : `Save Budget for ${year}`}
      </button>
    </form>
  );
}
