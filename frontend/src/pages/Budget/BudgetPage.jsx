import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client.js";
import { PageHeader } from "../../components/ui/PageHeader.jsx";
import IncomeTab       from "./IncomeTab.jsx";
import BudgetSetupTab  from "./BudgetSetupTab.jsx";
import CashOutflowsTab from "./CashOutflowsTab.jsx";
import GoalsTab        from "./GoalsTab.jsx";

const TABS = [
  { key: "income",   label: "Income"        },
  { key: "budget",   label: "Budget Setup"  },
  { key: "outflows", label: "Cash Outflows" },
  { key: "goals",    label: "Goals"         },
];

const CURRENT_YEAR = new Date().getFullYear();

const BudgetIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
    <path d="M20 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" />
    <path d="M16 13h.01" />
    <path d="M2 7l10-4 10 4" />
  </svg>
);

export default function BudgetPage() {
  const qc = useQueryClient();
  const [tab,      setTab]     = useState("income");
  const [year,     setYear]    = useState(CURRENT_YEAR);
  const [copying,  setCopying] = useState(false);
  const [copyMsg,  setCopyMsg] = useState("");

  const isPastYear   = year < CURRENT_YEAR;
  const isFutureYear = year > CURRENT_YEAR;

  function changeYear(delta) {
    setYear(y => y + delta);
    setCopyMsg("");
  }

  async function handleCopyFromPrevYear() {
    const fromYear = year - 1;
    setCopying(true);
    setCopyMsg("");
    try {
      const [income, budget] = await Promise.all([
        api.get(`/budget/income/${fromYear}`),
        api.get(`/budget/definition/${fromYear}`),
      ]);

      const puts = [];
      if (income?.sources?.length) {
        puts.push(api.put(`/budget/income/${year}`, { sources: income.sources }));
      }
      if (budget && budget.exists !== false) {
        puts.push(api.put(`/budget/definition/${year}`, {
          fixedExpenses:     budget.fixedExpenses     || [],
          loans:             budget.loans             || [],
          investments:       budget.investments       || [],
          creditCardBudgets: budget.creditCardBudgets || {},
        }));
      }

      if (!puts.length) {
        setCopyMsg(`No income or budget found for ${fromYear}.`);
        return;
      }

      await Promise.all(puts);
      qc.invalidateQueries({ queryKey: ["budget"] });
      setCopyMsg(`Copied income & budget from ${fromYear} to ${year}.`);
      setTimeout(() => setCopyMsg(""), 5000);
    } catch (err) {
      setCopyMsg(`Copy failed: ${err.detail?.error || err.message}`);
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="flex flex-col gap-5 p-6 max-w-5xl mx-auto">

      {/* ── Header row ── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Budget & Goals"
          subtitle={`${year} — income, spending limits, cash outflows, financial goals`}
          icon={BudgetIcon}
        />

        {/* Year navigator */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          <div className="flex items-center gap-0 rounded-xl border border-white/[0.06] bg-[#0F1729] overflow-hidden">
            <button type="button" onClick={() => changeYear(-1)}
              className="px-3 py-2 text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition-all cursor-pointer text-lg leading-none">
              ‹
            </button>
            <span className="px-4 py-2 text-sm font-bold text-slate-200 min-w-[4rem] text-center border-x border-white/[0.06]">
              {year}
            </span>
            <button type="button" onClick={() => changeYear(+1)}
              className="px-3 py-2 text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition-all cursor-pointer text-lg leading-none">
              ›
            </button>
          </div>

          {/* Copy from previous year — available for current + future years */}
          {!isPastYear && (
            <button type="button" onClick={handleCopyFromPrevYear} disabled={copying}
              className="text-[11px] text-blue-400 hover:text-blue-300 underline cursor-pointer disabled:opacity-50 transition-all">
              {copying ? "Copying…" : `Copy income & budget from ${year - 1}`}
            </button>
          )}
          {copyMsg && (
            <p className={`text-[11px] ${copyMsg.startsWith("Copy failed") || copyMsg.startsWith("No ") ? "text-red-400" : "text-emerald-400"}`}>
              {copyMsg}
            </p>
          )}
        </div>
      </div>

      {/* ── Past year banner ── */}
      {isPastYear && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.07] px-4 py-2.5 flex items-center gap-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-amber-400 shrink-0">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <p className="text-xs text-amber-400">
            Viewing <strong>{year}</strong> — past year snapshot. All data is editable if needed.
          </p>
        </div>
      )}

      {/* ── Tab bar ── */}
      <div className="flex gap-1 rounded-xl border p-1 self-start"
        style={{ background: "var(--fv-chip-bg)", borderColor: "var(--fv-border)" }}>
        {TABS.map(t => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className="px-4 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer"
            style={tab === t.key
              ? { background: "#2563eb", color: "#ffffff" }
              : { color: "var(--fv-text-secondary)" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      {tab === "income"   && <IncomeTab       year={year} />}
      {tab === "budget"   && <BudgetSetupTab  year={year} />}
      {tab === "outflows" && <CashOutflowsTab year={year} />}
      {tab === "goals"    && <GoalsTab        year={year} />}
    </div>
  );
}
