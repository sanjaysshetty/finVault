import { useQuery, useQueries } from "@tanstack/react-query";
import { api, queryKeys } from "../../api/client.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt$(n) {
  if (n == null) return "—";
  const abs = Math.abs(Number(n));
  const s = abs.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return `${Number(n) < 0 ? "−" : ""}$${s}`;
}

function pct(n, total) {
  if (!total || !Number.isFinite(n / total)) return null;
  return ((n / total) * 100).toFixed(1);
}

// ── Budget math ────────────────────────────────────────────────────────────────
//
// Annual fixed expenses are counted in full in their due month, not spread ÷12.
// This means the savings target varies month-to-month:
//   - Normal month: income − (monthly fixed + loans + invest + cc budget)
//   - Annual-expense month: income − (monthly fixed + annual amount + loans + invest + cc budget)
//
// The full-year totals are identical either way; only per-month targets differ.

function computeBudgetTargets(incomeDef, budgetDef) {
  const monthlyIncome = (incomeDef?.sources || [])
    .filter(s => s.isActive)
    .reduce((s, x) => s + x.monthlyAmount, 0);

  const empty = { monthlyIncome, perMonthTarget: {}, perMonthPlanned: {}, fixedMonthlyBase: 0, fixedAnnualTotal: 0, loansMonthly: 0, investMonthly: 0, ccMonthly: 0, annualPlannedSpend: 0, annualTargetSavings: 0 };
  if (!budgetDef) {
    for (let m = 1; m <= 12; m++) { empty.perMonthTarget[m] = 0; empty.perMonthPlanned[m] = 0; }
    return empty;
  }

  const monthlyFixed = (budgetDef.fixedExpenses || []).filter(fe => fe.frequency !== "annual");
  const annualFixed  = (budgetDef.fixedExpenses || []).filter(fe => fe.frequency === "annual");

  const fixedMonthlyBase = monthlyFixed.reduce((s, fe) => s + (fe.amount ?? fe.monthlyAmount ?? 0), 0);
  const fixedAnnualTotal = annualFixed.reduce((s, fe) => s + (fe.amount ?? fe.monthlyAmount ?? 0), 0);
  const loansMonthly     = (budgetDef.loans || []).reduce((s, l) => s + (l.amount ?? l.monthlyAmount ?? 0), 0);
  const investMonthly    = (budgetDef.investments || []).reduce((s, iv) => s + (iv.amount ?? iv.monthlyAmount ?? 0), 0);
  const ccMonthly        = Object.values(budgetDef.creditCardBudgets || {}).reduce((s, v) => s + v, 0);

  // Per-month: planned non-CC outflow (for estimation) + savings target
  const perMonthPlanned = {};
  const perMonthTarget  = {};
  for (let m = 1; m <= 12; m++) {
    const annualThisMonth = annualFixed
      .filter(fe => (fe.dueMonth || 1) === m)
      .reduce((s, fe) => s + (fe.amount ?? fe.monthlyAmount ?? 0), 0);
    const nonCCPlanned     = fixedMonthlyBase + loansMonthly + investMonthly + annualThisMonth;
    perMonthPlanned[m]     = nonCCPlanned;
    perMonthTarget[m]      = monthlyIncome - nonCCPlanned - ccMonthly;
  }

  const annualPlannedSpend  = 12 * (fixedMonthlyBase + loansMonthly + investMonthly + ccMonthly) + fixedAnnualTotal;
  const annualTargetSavings = 12 * monthlyIncome - annualPlannedSpend;

  return { monthlyIncome, perMonthTarget, perMonthPlanned, fixedMonthlyBase, fixedAnnualTotal, loansMonthly, investMonthly, ccMonthly, annualPlannedSpend, annualTargetSavings };
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ value, max, color = "#3b82f6" }) {
  const p = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="h-2 rounded-full bg-white/[0.06] overflow-hidden">
      <div className="h-full rounded-full transition-all" style={{ width: `${p}%`, background: color }} />
    </div>
  );
}

// ── Monthly row ───────────────────────────────────────────────────────────────

function MonthRow({ monthNum, monthlyTarget, actualSpend, plannedSpend, ccSpend, monthlyIncome, isFuture, isCurrent, isEstimated }) {
  const actualSavings   = monthlyIncome - actualSpend;
  const savingsVsTarget = actualSavings - monthlyTarget;
  const hasData         = actualSpend > 0 || isEstimated;

  // A planned-deficit month is one where budgeted outflows > income (target < 0).
  // Negative actual savings here is expected and not alarming — show amber, not red.
  // Only go red if actual savings is worse than even the negative target.
  const isPlannedDeficit = monthlyTarget < 0;
  const savingsColor = !hasData || isFuture
    ? ""
    : isPlannedDeficit
      ? actualSavings >= monthlyTarget ? "text-amber-400" : "text-red-400"
      : actualSavings >= monthlyTarget ? "text-emerald-400" : "text-red-400";

  return (
    <tr className={`border-b border-white/[0.03] ${isCurrent ? "bg-blue-500/[0.03]" : ""}`}>
      {/* Month */}
      <td className="px-4 py-2.5 whitespace-nowrap">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-300 w-7">{MONTH_SHORT[monthNum - 1]}</span>
          {isCurrent && <span className="text-[9px] font-bold text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded px-1.5 py-0.5">Now</span>}
          {isEstimated && !isFuture && (
            <span className="text-[9px] text-slate-600 bg-white/[0.03] border border-white/[0.05] rounded px-1.5 py-0.5"
              title="No transactions found — showing planned budget spend as estimate">Est.</span>
          )}
          {isPlannedDeficit && !isFuture && (
            <span className="text-[9px] text-amber-600 bg-amber-500/[0.08] border border-amber-500/20 rounded px-1.5 py-0.5"
              title="Budgeted outflows exceed income this month — planned deficit">Deficit mo.</span>
          )}
        </div>
      </td>
      {/* Target savings — negative when an annual expense exceeds income this month */}
      <td className="px-4 py-2.5 text-right text-sm tabular-nums">
        <span className={isPlannedDeficit ? "text-amber-500" : "text-slate-400"}>{fmt$(monthlyTarget)}</span>
      </td>
      {/* Actual spend */}
      <td className="px-4 py-2.5 text-right text-sm tabular-nums">
        {isFuture ? <span className="text-slate-600">—</span> : (
          hasData
            ? (
              <div>
                <span className="text-slate-200">{fmt$(actualSpend)}</span>
                {!isEstimated && (ccSpend > 0 || plannedSpend > 0) && (
                  <div className="text-[9px] text-slate-600 leading-tight mt-0.5">
                    {plannedSpend > 0 && <span>Fixed {fmt$(plannedSpend)}</span>}
                    {ccSpend > 0 && plannedSpend > 0 && <span> · </span>}
                    {ccSpend > 0 && <span>CC {fmt$(ccSpend)}</span>}
                  </div>
                )}
              </div>
            )
            : <span className="text-slate-600">No data</span>
        )}
      </td>
      {/* Actual savings */}
      <td className="px-4 py-2.5 text-right text-sm tabular-nums">
        {isFuture || !hasData ? <span className="text-slate-600">—</span> : (
          <span className={savingsColor}>{fmt$(actualSavings)}</span>
        )}
      </td>
      {/* vs Target */}
      <td className="px-4 py-2.5 text-right text-xs tabular-nums">
        {!isFuture && hasData && (
          savingsVsTarget >= 0
            ? <span className="text-emerald-400">+{fmt$(savingsVsTarget)}</span>
            : <span className="text-red-400">{fmt$(savingsVsTarget)}</span>
        )}
      </td>
    </tr>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function GoalsTab({ year }) {
  const calYear  = new Date().getFullYear();
  const calMonth = new Date().getMonth() + 1;

  const lastMonth          = year < calYear ? 12 : year > calYear ? 0 : calMonth;
  const currentMonthMarker = year === calYear ? calMonth : -1;

  const incomeQ = useQuery({
    queryKey: queryKeys.budgetIncome(year),
    queryFn:  () => api.get(`/budget/income/${year}`),
    staleTime: 60_000,
  });

  const budgetQ = useQuery({
    queryKey: queryKeys.budgetDefinition(year),
    queryFn:  () => api.get(`/budget/definition/${year}`),
    staleTime: 60_000,
  });

  // Use the same per-month outflows endpoint as Cash Outflows tab — guarantees
  // identical CC data and planned actuals in both tabs. React Query caches each
  // month's result, so months already viewed in Cash Outflows cost no extra fetch.
  const outflowQueries = useQueries({
    queries: Array.from({ length: Math.max(lastMonth, 0) }, (_, i) => ({
      queryKey: queryKeys.budgetOutflows(year, i + 1),
      queryFn:  () => api.get(`/budget/outflows/${year}/${i + 1}`),
      staleTime: 120_000,
    })),
  });

  const isSpendLoading = outflowQueries.some(q => q.isLoading);

  if (incomeQ.isLoading || budgetQ.isLoading || isSpendLoading) {
    return (
      <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-4 py-10 text-center text-slate-500 text-sm">
        Loading…
      </div>
    );
  }

  const targets = computeBudgetTargets(incomeQ.data, budgetQ.data);
  const { monthlyIncome, perMonthTarget, perMonthPlanned,
          fixedMonthlyBase, fixedAnnualTotal,
          loansMonthly, investMonthly, ccMonthly,
          annualPlannedSpend, annualTargetSavings } = targets;

  // Build byMonth from outflows data — same calculation as Cash Outflows liveActualsTotal.
  // planned = sum of past-due items' actual (override) or budgeted amounts.
  // cc = summary.ccTotal from the same endpoint.
  const byMonth = {};
  outflowQueries.forEach((q, i) => {
    if (!q.data) return;
    const m = i + 1;
    const planned = (q.data.planned || []).reduce((s, item) => {
      if (!item.pastDue) return s;
      return s + (item.actualAmount ?? item.budgetedAmount ?? 0);
    }, 0);
    // Sum directly from cc array — same source Cash Outflows uses, not summary field
    const cc = (q.data.cc || []).reduce((s, item) => s + (item.amount || 0), 0);
    if (planned > 0 || cc > 0) {
      byMonth[m] = {
        planned: Math.round(planned * 100) / 100,
        cc:      Math.round(cc * 100) / 100,
        total:   Math.round((planned + cc) * 100) / 100,
      };
    }
  });

  // For months with no transaction data, estimate using the per-month planned
  // non-CC outflow (accounts for annual items landing in their due month).
  function getMonthData(m) {
    if (byMonth[m]) return {
      spend:        byMonth[m].total,
      plannedSpend: byMonth[m].planned || 0,
      ccSpend:      byMonth[m].cc      || 0,
      estimated:    false,
    };
    const est = perMonthPlanned[m] || 0;
    if (est > 0) return { spend: est, plannedSpend: est, ccSpend: 0, estimated: true };
    return { spend: 0, plannedSpend: 0, ccSpend: 0, estimated: false };
  }

  const allMonths       = Array.from({ length: lastMonth }, (_, i) => i + 1);
  const monthData       = allMonths.map(m => ({ m, ...getMonthData(m) }));
  const trackedMonths   = monthData.filter(d => d.spend > 0 || !d.estimated);
  const estimatedMonths = monthData.filter(d => d.estimated);

  // YTD — sum per-month targets so annual-expense months count correctly
  const ytdActualSpend   = trackedMonths.reduce((s, d) => s + d.spend, 0);
  const ytdTargetSavings = trackedMonths.reduce((s, d) => s + perMonthTarget[d.m], 0);
  const ytdActualSavings = trackedMonths.length * monthlyIncome - ytdActualSpend;
  const ytdSavingsDrift  = ytdActualSavings - ytdTargetSavings;
  const driftPct         = ytdTargetSavings > 0 ? Math.abs(ytdSavingsDrift / ytdTargetSavings) * 100 : 0;

  // Primary concern: YTD savings has gone negative — spending exceeds income so far this year.
  // This is the real alert even if individual planned-deficit months explain some of it.
  const isYtdNegative = ytdActualSavings < 0;
  // Secondary: behind plan but YTD savings still positive (pace warning, not crisis).
  const isDriftWarning = !isYtdNegative && ytdSavingsDrift < 0 && driftPct > 10;
  const isOnTrack      = ytdActualSavings > 0 && ytdSavingsDrift >= -ytdTargetSavings * 0.1;

  const annualIncome     = monthlyIncome * 12;
  const savingsRatePct   = annualIncome > 0 ? pct(annualTargetSavings, annualIncome) : null;

  const periodLabel = year < calYear ? `Full Year ${year}` : `Year-to-Date — ${MONTH_SHORT[calMonth - 1]} ${year}`;
  const monthsLabel = `${trackedMonths.length} month${trackedMonths.length !== 1 ? "s" : ""}${estimatedMonths.length > 0 ? ` · ${estimatedMonths.length} est.` : ""}`;

  // Budget breakdown items for the summary card
  const breakdownItems = [
    ...(fixedMonthlyBase > 0 ? [{ label: "Fixed/mo",     val: fixedMonthlyBase, suffix: "/mo" }] : []),
    ...(fixedAnnualTotal > 0 ? [{ label: "Annual Fixed",  val: fixedAnnualTotal, suffix: "/yr" }] : []),
    ...(loansMonthly     > 0 ? [{ label: "Loans/mo",      val: loansMonthly,     suffix: "/mo" }] : []),
    ...(investMonthly    > 0 ? [{ label: "Invest/mo",     val: investMonthly,    suffix: "/mo" }] : []),
    ...(ccMonthly        > 0 ? [{ label: "CC Budget/mo",  val: ccMonthly,        suffix: "/mo" }] : []),
  ];

  return (
    <div className="flex flex-col gap-5">

      {/* ── Annual target card ── */}
      <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] p-5">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-4">
          {year} Savings Target — from Budget
        </p>

        {monthlyIncome === 0 ? (
          <p className="text-sm text-slate-500">Set up Income first to compute a savings target.</p>
        ) : (
          <>
            {/* Top metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
              <div>
                <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Annual Income</p>
                <p className="text-xl font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
                  {fmt$(annualIncome)}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Annual Budget</p>
                <p className="text-xl font-black text-red-400" style={{ fontFamily: "Epilogue, sans-serif" }}>
                  {fmt$(annualPlannedSpend)}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Target Savings</p>
                <p className={`text-xl font-black ${annualTargetSavings >= 0 ? "text-emerald-400" : "text-red-400"}`}
                  style={{ fontFamily: "Epilogue, sans-serif" }}>
                  {fmt$(annualTargetSavings)}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Savings Rate</p>
                <p className={`text-xl font-black ${(parseFloat(savingsRatePct) || 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}
                  style={{ fontFamily: "Epilogue, sans-serif" }}>
                  {savingsRatePct !== null ? `${savingsRatePct}%` : "—"}
                </p>
              </div>
            </div>

            {/* Budget breakdown */}
            {breakdownItems.length > 0 && (
              <div className="border-t border-white/[0.06] pt-4">
                <div className="flex flex-wrap gap-x-6 gap-y-3">
                  {breakdownItems.map(({ label, val, suffix }) => (
                    <div key={label} className="flex flex-col gap-0.5 min-w-[5rem]">
                      <span className="text-slate-600 uppercase tracking-wide text-[10px]">{label}</span>
                      <span className="text-slate-300 font-semibold text-sm">
                        {fmt$(val)}<span className="text-slate-600 text-[10px] ml-0.5">{suffix}</span>
                      </span>
                    </div>
                  ))}
                </div>
                {fixedAnnualTotal > 0 && (
                  <p className="text-[10px] text-slate-700 mt-2">
                    Annual fixed expenses count in full in their due month — per-month savings targets vary accordingly.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Future year: no data yet ── */}
      {lastMonth === 0 && (
        <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-6 py-10 text-center">
          <p className="text-slate-400 text-sm font-semibold mb-2">No data yet for {year}</p>
          <p className="text-slate-600 text-xs max-w-sm mx-auto">
            Set up your income and budget for {year}, then track actuals as the year progresses.
          </p>
        </div>
      )}

      {/* ── YTD tracking card ── */}
      {lastMonth > 0 && monthlyIncome > 0 && (
        <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] p-5">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-4">
            {periodLabel} ({monthsLabel})
          </p>

          {/* Red alert — YTD actual savings has gone negative (spending exceeds income so far) */}
          {isYtdNegative && trackedMonths.length > 0 && (
            <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/[0.07] px-4 py-3 flex items-start gap-3">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-red-400 shrink-0 mt-0.5">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <div>
                <p className="text-sm font-semibold text-red-300">YTD savings is negative</p>
                <p className="text-xs text-red-400/80 mt-0.5">
                  Spending has exceeded income by {fmt$(Math.abs(ytdActualSavings))} across {trackedMonths.length} months. Review your outflows.
                </p>
              </div>
            </div>
          )}

          {/* Amber warning — YTD savings still positive but pace is behind plan by > 10% */}
          {isDriftWarning && (
            <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 flex items-start gap-3">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-amber-400 shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <div>
                <p className="text-sm font-semibold text-amber-300">Savings pace behind plan by {driftPct.toFixed(1)}%</p>
                <p className="text-xs text-amber-400/80 mt-0.5">
                  {fmt$(Math.abs(ytdSavingsDrift))} below target — YTD savings still positive at {fmt$(ytdActualSavings)}.
                </p>
              </div>
            </div>
          )}

          {/* Green nudge — on track */}
          {isOnTrack && trackedMonths.length > 0 && (
            <div className="mb-4 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] px-4 py-3 flex items-center gap-3">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-emerald-400 shrink-0">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <p className="text-sm text-emerald-300">
                On track — {fmt$(ytdActualSavings)} saved year-to-date
                {ytdSavingsDrift >= 0 ? `, ${fmt$(ytdSavingsDrift)} ahead of plan` : ""}.
              </p>
            </div>
          )}

          {trackedMonths.length > 0 ? (
            <>
              {/* YTD summary metrics */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-5">
                <div>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">YTD Target Savings</p>
                  <p className="text-xl font-black text-slate-300" style={{ fontFamily: "Epilogue, sans-serif" }}>
                    {fmt$(ytdTargetSavings)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">YTD Actual Savings</p>
                  <p className={`text-xl font-black ${ytdActualSavings >= ytdTargetSavings ? "text-emerald-400" : "text-red-400"}`}
                    style={{ fontFamily: "Epilogue, sans-serif" }}>
                    {fmt$(ytdActualSavings)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Variance</p>
                  <p className={`text-xl font-black ${ytdSavingsDrift >= 0 ? "text-emerald-400" : "text-red-400"}`}
                    style={{ fontFamily: "Epilogue, sans-serif" }}>
                    {ytdSavingsDrift >= 0 ? "+" : ""}{fmt$(ytdSavingsDrift)}
                  </p>
                </div>
              </div>

              {ytdTargetSavings > 0 && ytdActualSavings > 0 && (
                <div className="mb-5">
                  <div className="flex justify-between text-[10px] text-slate-600 mb-1">
                    <span>Actual savings vs target ({trackedMonths.length} months)</span>
                    <span>{pct(ytdActualSavings, ytdTargetSavings)}%</span>
                  </div>
                  <ProgressBar
                    value={ytdActualSavings}
                    max={ytdTargetSavings}
                    color={ytdActualSavings >= ytdTargetSavings ? "#34d399" : "#f87171"}
                  />
                </div>
              )}
            </>
          ) : (
            <div className="mb-5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-4 text-center">
              <p className="text-xs text-slate-500">
                No transaction data yet. Upload CC transactions or set actuals in Cash Outflows.
              </p>
            </div>
          )}

          {/* Month-by-month table */}
          <div className="rounded-xl border border-white/[0.06] overflow-hidden">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  {["Month", "Target Savings", "Actual Spend", "Actual Savings", "vs Target"].map((h, i) => (
                    <th key={h} className={`px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-500 ${i === 0 ? "text-left" : "text-right"}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monthData.map(({ m, spend, plannedSpend, ccSpend, estimated }) => (
                  <MonthRow
                    key={m}
                    monthNum={m}
                    monthlyTarget={perMonthTarget[m]}
                    actualSpend={spend}
                    plannedSpend={plannedSpend}
                    ccSpend={ccSpend}
                    monthlyIncome={monthlyIncome}
                    isFuture={false}
                    isCurrent={m === currentMonthMarker}
                    isEstimated={estimated}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-2 px-1 flex flex-col gap-0.5">
            {estimatedMonths.length > 0 && (
              <p className="text-[10px] text-slate-600">
                <span className="text-slate-700">Est.</span> = no transactions found — showing planned fixed/loan/investment spend as estimate.
              </p>
            )}
            <p className="text-[10px] text-slate-600">
              Actual spend = CC transactions + Cash Outflow actuals set in the Outflows tab.
            </p>
            {fixedAnnualTotal > 0 && (
              <p className="text-[10px] text-slate-600">
                Target Savings varies by month: annual expenses appear in full in their due month.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── No data at all ── */}
      {lastMonth > 0 && monthData.every(d => d.spend === 0 && !d.estimated) && (
        <div className="rounded-2xl border border-white/[0.06] bg-[#0F1729] px-6 py-10 text-center">
          <p className="text-slate-400 text-sm font-semibold mb-2">No spending data for {year}</p>
          <p className="text-slate-600 text-xs max-w-sm mx-auto">
            Upload CC transactions in the Spending tab, or set actuals in Cash Outflows to start tracking.
          </p>
        </div>
      )}
    </div>
  );
}
