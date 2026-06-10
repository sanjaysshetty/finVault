import { useState, useMemo } from "react";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../../api/client.js";
import { PageHeader } from "../../components/ui/PageHeader.jsx";
import { PageIcons } from "../../components/ui/PageIcons.jsx";
import { FormModal } from "../../components/ui/FormModal.jsx";
import { formatMoney } from "../../utils/format.js";
import { useCanWrite } from "../../hooks/useCanWrite.js";
import {
  toArr, calcStocks, calcCrypto, calcBullion, calcOptions, calcFutures, computeScheduleD,
} from "../../utils/capitalGains.js";

/* ─── Constants ─────────────────────────────────────────────── */
const CY = new Date().getFullYear();
const YEARS = [CY, CY - 1, CY - 2];

const FREQ_OPTIONS = [
  { value: "monthly",      label: "Monthly (12/yr)"      },
  { value: "semi-monthly", label: "Semi-monthly (24/yr)" },
  { value: "bi-weekly",    label: "Bi-weekly (26/yr)"    },
];
const FREQ_PERIODS = { monthly: 12, "semi-monthly": 24, "bi-weekly": 26 };
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Federal ordinary income brackets — MFJ
const FED_BRACKETS = {
  2024: [{r:0.10,u:23200},{r:0.12,u:94300},{r:0.22,u:201050},{r:0.24,u:383900},{r:0.32,u:487450},{r:0.35,u:731200},{r:0.37,u:Infinity}],
  2025: [{r:0.10,u:23850},{r:0.12,u:96950},{r:0.22,u:206700},{r:0.24,u:394600},{r:0.32,u:501050},{r:0.35,u:751600},{r:0.37,u:Infinity}],
  2026: [{r:0.10,u:24300},{r:0.12,u:98700},{r:0.22,u:210500},{r:0.24,u:402200},{r:0.32,u:511100},{r:0.35,u:766050},{r:0.37,u:Infinity}],
};
// LT cap gains brackets — MFJ (applied against taxable income)
const LT_BRACKETS = {
  2024: [{r:0.00,u:94050},{r:0.15,u:583750},{r:0.20,u:Infinity}],
  2025: [{r:0.00,u:96700},{r:0.15,u:600050},{r:0.20,u:Infinity}],
  2026: [{r:0.00,u:98500},{r:0.15,u:612000},{r:0.20,u:Infinity}],
};
// Standard deduction MFJ
const STD_DEDUCTION = { 2023:27700, 2024:29200, 2025:30000, 2026:30800 };
// NIIT threshold MFJ
const NIIT_THRESHOLD = 250000;
// IRA annual limit per person (2024+; ignores age 50+ catch-up for simplicity)
const IRA_LIMIT = 7000;
// CTC / ODC phase-out threshold MFJ
const CTC_THRESHOLD = 400000;

/* ─── Tax calculation helpers ───────────────────────────────── */
function r2(n) { return Math.round((n || 0) * 100) / 100; }
function sn(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }

function progressiveTax(income, brackets) {
  let tax = 0, prev = 0;
  for (const { r, u } of brackets) {
    if (income <= prev) break;
    tax += (Math.min(income, u) - prev) * r;
    prev = u;
  }
  return r2(tax);
}

// LT cap gains stacking: ordinary income fills bottom of brackets,
// preferential income (LT + qualified div) stacks on top.
function ltCapGainsTax(ordinaryTaxable, preferential, brackets) {
  let tax = 0, rem = Math.max(preferential, 0), base = ordinaryTaxable;
  for (const { r, u } of brackets) {
    if (rem <= 0) break;
    if (base >= u) continue;
    const space   = u - base;
    const taxable = Math.min(rem, space);
    tax  += taxable * r;
    rem  -= taxable;
    base  = Math.min(base + taxable, u);
  }
  return r2(tax);
}

function topBracketLabel(ordinaryIncome, year) {
  const brackets = FED_BRACKETS[year] || FED_BRACKETS[2025];
  let label = "10%", prev = 0;
  for (const { r, u } of brackets) {
    if (ordinaryIncome > prev) label = `${Math.round(r * 100)}%`;
    if (ordinaryIncome <= u) break;
    prev = u;
  }
  return label;
}

function computeTaxSummary(docs, config, schedD, year) {
  const freq       = config || {};
  const selfFreq   = freq.selfFrequency   || "semi-monthly";
  const spouseFreq = freq.spouseFrequency || "semi-monthly";
  const selfName   = freq.selfName   || "Self";
  const spouseName = freq.spouseName || "Spouse";

  /* ── Wages ── */
  const payslips = docs.filter(d => d.docType === "PAYSLIP");
  const w2s      = docs.filter(d => d.docType === "W2");

  function wagesFor(person, freqKey) {
    const w2 = w2s.find(d => d.person === person);
    if (w2) return { wages: sn(w2.data?.wages), withheld: sn(w2.data?.federalWithheld), source: "W-2" };
    const allSlips     = payslips.filter(d => d.person === person);
    const regularSlips = allSlips.filter(d => !d.data?.isBonus);
    const bonusSlips   = allSlips.filter(d =>  d.data?.isBonus);
    if (!regularSlips.length && !bonusSlips.length) return { wages: 0, withheld: 0, source: "none" };
    const totalPeriods = FREQ_PERIODS[freqKey] || 12;
    const avgGross     = regularSlips.length ? regularSlips.reduce((s, p) => s + sn(p.data?.grossPay),        0) / regularSlips.length : 0;
    const avgWith      = regularSlips.length ? regularSlips.reduce((s, p) => s + sn(p.data?.federalWithheld), 0) / regularSlips.length : 0;
    const bonusGross   = bonusSlips.reduce((s, p) => s + sn(p.data?.grossPay),        0);
    const bonusWith    = bonusSlips.reduce((s, p) => s + sn(p.data?.federalWithheld), 0);
    const bonusSuffix  = bonusSlips.length ? ` + ${bonusSlips.length} bonus` : "";
    return {
      wages:    r2(avgGross * totalPeriods + bonusGross),
      withheld: r2(avgWith  * totalPeriods + bonusWith),
      source:   `projected (${regularSlips.length}/${totalPeriods} stubs${bonusSuffix})`,
    };
  }

  const self   = wagesFor("self",   selfFreq);
  const spouse = wagesFor("spouse", spouseFreq);
  const totalWages    = r2(self.wages + spouse.wages);
  const totalWithheld = r2(self.withheld + spouse.withheld);

  /* ── Investment income ── */
  const interest = docs.filter(d => d.docType === "1099-INT").reduce((s, d) => s + sn(d.data?.interestIncome), 0);
  const ordDiv   = docs.filter(d => d.docType === "1099-DIV").reduce((s, d) => s + sn(d.data?.ordinaryDividends), 0);
  const qualDiv  = docs.filter(d => d.docType === "1099-DIV").reduce((s, d) => s + sn(d.data?.qualifiedDividends), 0);
  const brokWith = docs.filter(d => d.docType === "1099-INT" || d.docType === "1099-DIV").reduce((s, d) => s + sn(d.data?.federalWithheld), 0);

  const b1099s  = docs.filter(d => d.docType === "1099-B");
  const cgST    = b1099s.length ? b1099s.reduce((s, d) => s + sn(d.data?.shortTermGain), 0) : (schedD?.netST  || 0);
  const cgLT    = b1099s.length ? b1099s.reduce((s, d) => s + sn(d.data?.longTermGain),  0) : (schedD?.netRegLT || 0);
  const cgSource = b1099s.length ? "1099-B" : "finVault Capital Gains";
  // Net capital gain/loss. A net loss reduces ordinary income by up to $3,000 (§1211(b)).
  const netCG            = r2(cgST + cgLT);
  const capLossDeduction = netCG < 0 ? Math.min(Math.abs(netCG), 3000) : 0;
  // Amount that flows to Form 1040 line 7 (gains positive; capped loss negative).
  const netCGLine7       = netCG < 0 ? -capLossDeduction : netCG;

  /* ── HSA (above-the-line) ── */
  const hsa5498      = docs.filter(d => d.docType === "5498-SA");
  const hsaTotal     = hsa5498.reduce((s, d) => s + sn(d.data?.hsaContributions), 0);
  const hsaEmployer  = hsa5498.reduce((s, d) => s + sn(d.data?.employerContributions), 0);
  const hsaDeduction = Math.max(0, r2(hsaTotal - hsaEmployer));

  /* ── Traditional IRA (above-the-line, subject to phase-out) ── */
  const selfIra   = r2(Math.min(sn(config?.selfIraContribution),   IRA_LIMIT));
  const spouseIra = r2(Math.min(sn(config?.spouseIraContribution), IRA_LIMIT));
  const iraDeduction = r2(selfIra + spouseIra);

  /* ── Gross income & MAGI ── */
  // netCGLine7 is positive for gains, negative (capped at −$3,000) for losses.
  const grossIncome = r2(totalWages + interest + ordDiv + netCGLine7);
  const magi        = grossIncome;
  const agi         = r2(magi - hsaDeduction - iraDeduction);

  /* ── Itemized vs standard deduction ── */
  const mortgageInterest = r2(sn(config?.mortgageInterest));
  const saltCapped       = r2(Math.min(sn(config?.saltDeduction), 10000));
  const charitable       = r2(sn(config?.charitableDeductions));
  const itemizedTotal    = r2(mortgageInterest + saltCapped + charitable);
  const stdDed           = STD_DEDUCTION[year] || 29200;
  const useItemized      = !!(config?.itemize) && itemizedTotal > stdDed;
  const deduction        = useItemized ? itemizedTotal : stdDed;
  const taxableIncome    = Math.max(0, r2(agi - deduction));

  /* ── Tax on ordinary + preferential income ── */
  const preferential  = Math.max(qualDiv, 0) + Math.max(cgLT, 0);
  const nonQualOrdDiv = Math.max(0, ordDiv - qualDiv);
  // ordinaryBase excludes ST gains; they stack on top at ordinary rates as a separate row.
  // This prevents double-counting: ordinaryBase + cgST = taxableIncome - preferential.
  const ordinaryBase    = Math.max(0, taxableIncome - preferential - Math.max(cgST, 0));
  const ordinaryTaxable = ordinaryBase; // returned for display ("On $X · top bracket")
  const ordinaryIncomeFull = r2(totalWages + interest + nonQualOrdDiv - capLossDeduction);

  const fedBrackets = FED_BRACKETS[year] || FED_BRACKETS[2025];
  const ltBrackets  = LT_BRACKETS[year]  || LT_BRACKETS[2025];

  const ordTax = progressiveTax(ordinaryBase, fedBrackets);
  // ST gains taxed at ordinary rates, stacked above ordinaryBase.
  const stTax  = cgST > 0 ? r2(progressiveTax(ordinaryBase + cgST, fedBrackets) - ordTax) : 0;
  // LT preferential income stacks above all ordinary-rate income (ordinaryBase + ST gains).
  const ltTax  = ltCapGainsTax(ordinaryBase + Math.max(cgST, 0), preferential, ltBrackets);

  /* ── NIIT: 3.8% on lesser of net investment income or AGI over $250K (MFJ §1411) ── */
  // Net capital gains for NIIT are netted (ST + LT); a net loss reduces to 0.
  const netInvIncome = r2(interest + ordDiv + Math.max(netCG, 0));
  const niitBase     = agi > NIIT_THRESHOLD ? r2(Math.min(netInvIncome, agi - NIIT_THRESHOLD)) : 0;
  const niitTax      = r2(niitBase * 0.038);

  /* ── Additional Medicare Tax: 0.9% on wages over $250K (MFJ §3101) ── */
  // Separate from NIIT; applies to wages/SE income, not investment income.
  const AMT_WAGE_THRESHOLD = 250000;
  const addlMedicareTax = r2(Math.max(0, totalWages - AMT_WAGE_THRESHOLD) * 0.009);

  const taxBeforeCredits = r2(ordTax + stTax + ltTax + niitTax + addlMedicareTax);

  /* ── Credits ── */
  const numChildren = Math.max(0, Math.floor(sn(config?.numChildrenUnder17)));
  const numOtherDep = Math.max(0, Math.floor(sn(config?.numOtherDependents)));

  // Child Tax Credit ($2,000/child) + Other Dependent Credit ($500/dep)
  // Phase-out: $50 per $1,000 AGI over $400K (MFJ), CTC phases out before ODC
  const rawCTC       = numChildren * 2000;
  const rawODC       = numOtherDep * 500;
  const phaseoutAmt  = Math.ceil(Math.max(0, agi - CTC_THRESHOLD) / 1000) * 50;
  const childTaxCredit = r2(Math.max(0, rawCTC - Math.min(phaseoutAmt, rawCTC)));
  const otherDepCredit = r2(Math.max(0, rawODC - Math.max(0, phaseoutAmt - rawCTC)));

  // Dependent Care Credit (Form 2441 §21): tiered rate 35%→20% based on AGI.
  // Rate is 35% for AGI ≤ $15K, slides 1% per $2K to 20% floor at AGI ≥ $43K.
  // Max qualifying expenses: $3,000 (1 qualifying person), $6,000 (2+).
  // Enter net of employer FSA ($5K pre-tax already excluded from W-2).
  const totalDepsForCare = numChildren + numOtherDep;
  const dccMax  = totalDepsForCare >= 2 ? 6000 : totalDepsForCare === 1 ? 3000 : 0;
  const dccRate = agi >= 43000 ? 0.20 : agi <= 15000 ? 0.35
    : r2(0.35 - Math.floor((agi - 15000) / 2000) * 0.01);
  const dccExpenses = r2(Math.min(sn(config?.dependentCareExpenses), dccMax));
  const dependentCareCredit = r2(dccExpenses * dccRate);

  const totalCredits    = r2(childTaxCredit + otherDepCredit + dependentCareCredit);
  const taxAfterCredits = r2(Math.max(0, taxBeforeCredits - totalCredits));

  /* ── Withholding & balance ── */
  const totalWithheldAll = r2(totalWithheld + brokWith);
  const balanceDue       = r2(taxAfterCredits - totalWithheldAll);
  const topBracket       = topBracketLabel(ordinaryIncomeFull, year);

  return {
    selfName, spouseName,
    self, spouse,
    totalWages, totalWithheld,
    interest, ordDiv, qualDiv, nonQualOrdDiv,
    cgST, cgLT, cgSource, netCG, capLossDeduction,
    hsaDeduction, hsaTotal,
    selfIra, spouseIra, iraDeduction,
    mortgageInterest, saltCapped, charitable, itemizedTotal, useItemized, deduction, stdDed,
    grossIncome, magi, agi, taxableIncome,
    preferential, ordinaryTaxable,
    ordTax, stTax, ltTax, niitTax, niitBase, addlMedicareTax,
    taxBeforeCredits,
    numChildren, numOtherDep,
    childTaxCredit, otherDepCredit, dependentCareCredit, dccRate, totalCredits,
    taxAfterCredits,
    brokWith, totalWithheldAll, balanceDue,
    topBracket, netInvIncome,
    isProjected: self.source.includes("projected") || spouse.source.includes("projected"),
    has1099B: b1099s.length > 0,
  };
}

/* ─── Pay period helpers ─────────────────────────────────────── */
function buildPeriods(year, frequency) {
  const periods = [];
  if (frequency === "monthly") {
    for (let m = 0; m < 12; m++)
      periods.push({ id: `${year}-${String(m+1).padStart(2,"0")}`, label: MONTHS[m], month: m });
  } else if (frequency === "semi-monthly") {
    for (let m = 0; m < 12; m++) {
      periods.push({ id: `${year}-${String(m+1).padStart(2,"0")}-A`, label: `${MONTHS[m]} 1–15`, month: m });
      periods.push({ id: `${year}-${String(m+1).padStart(2,"0")}-B`, label: `${MONTHS[m]} 16–31`, month: m });
    }
  } else {
    for (let w = 1; w <= 26; w++)
      periods.push({ id: `${year}-W${String(w).padStart(2,"0")}`, label: `Wk ${w}`, month: Math.floor((w-1)*12/26) });
  }
  return periods;
}

function isPast(periodId, year) {
  const today = new Date();
  if (today.getFullYear() > year) return true;
  if (today.getFullYear() < year) return false;
  const mo = today.getMonth();
  if (periodId.includes("-W")) {
    const w = parseInt(periodId.split("-W")[1]);
    const todayWeek = Math.ceil((today - new Date(year, 0, 1)) / (7 * 86400000));
    return w <= todayWeek;
  }
  const parts = periodId.split("-");
  const m = parseInt(parts[1]) - 1;
  const half = parts[2];
  if (half === "A") return mo > m || (mo === m && today.getDate() > 15);
  if (half === "B") return mo > m;
  return mo >= m;
}

/* ─── Shared UI primitives ───────────────────────────────────── */
function SectionCard({ title, children, action }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] overflow-hidden" style={{ background: "var(--fv-card)" }}>
      <div className="px-5 py-3 border-b border-white/[0.06] flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-500">{title}</span>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function TaxRow({ label, value, sub, bold, indent, positive, negative, highlight }) {
  const cls = positive ? "text-emerald-400" : negative ? "text-red-400" : highlight ? "text-amber-400" : "text-slate-200";
  return (
    <div className={`flex items-center justify-between py-1.5 ${indent ? "pl-4" : ""}`}>
      <div>
        <span className={`text-sm ${bold ? "font-semibold text-slate-200" : "text-slate-400"}`}>{label}</span>
        {sub && <div className="text-[11px] text-slate-600 mt-0.5">{sub}</div>}
      </div>
      <span className={`text-sm font-semibold tabular-nums ${cls}`} style={bold ? { fontFamily: "Epilogue, sans-serif" } : {}}>
        {value}
      </span>
    </div>
  );
}

function Divider() { return <div className="my-2 h-px bg-white/[0.05]" />; }

function AddButton({ label, onClick }) {
  return (
    <button onClick={onClick}
      className="flex items-center gap-1.5 text-xs font-semibold text-blue-400 hover:text-blue-300 transition-colors cursor-pointer">
      <span className="text-base leading-none">+</span>{label}
    </button>
  );
}

function EditButton({ label = "Edit", onClick }) {
  return (
    <button onClick={onClick}
      className="text-xs font-semibold text-slate-500 hover:text-slate-300 transition-colors cursor-pointer">
      {label}
    </button>
  );
}

function DocCard({ label, sub, value, onEdit, onDelete, hasFile, onView, status }) {
  const isExtracted  = status === "extracted";
  const isExtracting = hasFile && status === "manual";
  return (
    <div className="flex items-center justify-between px-3 py-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] mb-2">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-200 font-medium">{label}</span>
          {isExtracted && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/[0.12] text-emerald-400 border border-emerald-500/20">
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
              AI
            </span>
          )}
          {isExtracting && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/[0.10] text-amber-500 border border-amber-500/20">
              Extracting…
            </span>
          )}
        </div>
        {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
      </div>
      <div className="flex items-center gap-3">
        {value !== undefined && <span className="text-sm font-semibold text-emerald-400 tabular-nums">{value}</span>}
        {hasFile && (
          <button onClick={onView}
            className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 cursor-pointer">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
            PDF
          </button>
        )}
        <button onClick={onEdit}   className="text-[11px] text-blue-400 hover:text-blue-300 cursor-pointer">Edit</button>
        <button onClick={onDelete} className="text-[11px] text-red-400 hover:text-red-300 cursor-pointer">Del</button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", prefix, note }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{label}</label>
      {note && <span className="text-[10px] text-slate-600">{note}</span>}
      <div className="relative">
        {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">{prefix}</span>}
        <input
          type={type} value={value ?? ""} onChange={e => onChange(e.target.value)}
          className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50"
          style={prefix ? { paddingLeft: 24 } : {}}
        />
      </div>
    </div>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50 cursor-pointer">
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function CheckField({ label, checked, onChange, note }) {
  return (
    <div className="flex items-start gap-2">
      <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)}
        className="mt-0.5 rounded border-white/[0.08] text-blue-500 cursor-pointer" />
      <div>
        <label className="text-sm text-slate-300 cursor-pointer">{label}</label>
        {note && <div className="text-[10px] text-slate-600 mt-0.5">{note}</div>}
      </div>
    </div>
  );
}

/* File attachment input inside modals */
function FileAttach({ file, onFileChange, hasExisting }) {
  return (
    <div className="pt-3 border-t border-white/[0.06]">
      <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">
        Attach PDF (optional)
      </label>
      {hasExisting && !file && (
        <div className="text-[10px] text-emerald-500 mb-1">PDF already attached — upload a new file to replace it.</div>
      )}
      <input
        type="file" accept=".pdf,image/jpeg,image/png,image/jpg"
        onChange={e => onFileChange(e.target.files?.[0] || null)}
        className="w-full text-xs text-slate-400 cursor-pointer
          file:mr-3 file:py-1 file:px-2.5 file:rounded-lg
          file:border file:border-white/[0.08] file:bg-white/[0.04]
          file:text-slate-300 file:text-xs file:cursor-pointer
          hover:file:bg-white/[0.08]"
      />
      {file && (
        <div className="text-[10px] text-blue-400 mt-1">{file.name} · {(file.size/1024).toFixed(0)} KB</div>
      )}
    </div>
  );
}

/* ─── Modals ─────────────────────────────────────────────────── */
function PayslipModal({ period, person, existing, doc, isBonus: initialIsBonus, onSave, onClose }) {
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({
    employer:         existing?.employer         ?? "",
    grossPay:         existing?.grossPay         ?? "",
    federalWithheld:  existing?.federalWithheld  ?? "",
    ssWithheld:       existing?.ssWithheld       ?? "",
    medicareWithheld: existing?.medicareWithheld ?? "",
    isBonus:          existing?.isBonus          ?? initialIsBonus ?? false,
  });
  const set = k => v => setForm(f => ({ ...f, [k]: v }));
  const title = form.isBonus ? "Bonus / One-Time Pay Stub" : `Pay Stub — ${period?.label || ""}`;
  return (
    <FormModal title={title} onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        <Field label="Employer"               value={form.employer}         onChange={set("employer")} />
        <Field label="Gross Pay"              value={form.grossPay}         onChange={set("grossPay")}         type="number" prefix="$" />
        <Field label="Federal Tax Withheld"   value={form.federalWithheld}  onChange={set("federalWithheld")}  type="number" prefix="$" />
        <Field label="Social Security Withheld" value={form.ssWithheld}    onChange={set("ssWithheld")}        type="number" prefix="$" />
        <Field label="Medicare Withheld"      value={form.medicareWithheld} onChange={set("medicareWithheld")} type="number" prefix="$" />
        <FileAttach file={file} onFileChange={setFile} hasExisting={!!doc?.data?.s3Key} />
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-white/[0.08] py-2 text-sm text-slate-400 hover:text-slate-200 cursor-pointer">Cancel</button>
          <button onClick={() => onSave({ ...form, _file: file })} className="flex-1 rounded-lg bg-blue-600 hover:bg-blue-500 py-2 text-sm font-semibold text-white cursor-pointer">Save</button>
        </div>
      </div>
    </FormModal>
  );
}

function W2Modal({ person, existing, doc, onSave, onClose }) {
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({
    employer:         existing?.employer         ?? "",
    wages:            existing?.wages            ?? "",
    federalWithheld:  existing?.federalWithheld  ?? "",
    ssWages:          existing?.ssWages          ?? "",
    ssWithheld:       existing?.ssWithheld       ?? "",
    medicareWages:    existing?.medicareWages    ?? "",
    medicareWithheld: existing?.medicareWithheld ?? "",
  });
  const set = k => v => setForm(f => ({ ...f, [k]: v }));
  return (
    <FormModal title={`W-2 — ${person === "self" ? "Self" : "Spouse"}`} onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        <Field label="Employer"                  value={form.employer}         onChange={set("employer")} />
        <Field label="Box 1 — Wages"             value={form.wages}            onChange={set("wages")}            type="number" prefix="$" />
        <Field label="Box 2 — Federal Withheld"  value={form.federalWithheld}  onChange={set("federalWithheld")}  type="number" prefix="$" />
        <Field label="Box 3 — SS Wages"          value={form.ssWages}          onChange={set("ssWages")}          type="number" prefix="$" />
        <Field label="Box 4 — SS Tax Withheld"   value={form.ssWithheld}       onChange={set("ssWithheld")}       type="number" prefix="$" />
        <Field label="Box 5 — Medicare Wages"    value={form.medicareWages}    onChange={set("medicareWages")}    type="number" prefix="$" />
        <Field label="Box 6 — Medicare Withheld" value={form.medicareWithheld} onChange={set("medicareWithheld")} type="number" prefix="$" />
        <FileAttach file={file} onFileChange={setFile} hasExisting={!!doc?.data?.s3Key} />
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-white/[0.08] py-2 text-sm text-slate-400 hover:text-slate-200 cursor-pointer">Cancel</button>
          <button onClick={() => onSave({ ...form, _file: file })} className="flex-1 rounded-lg bg-blue-600 hover:bg-blue-500 py-2 text-sm font-semibold text-white cursor-pointer">Save</button>
        </div>
      </div>
    </FormModal>
  );
}

function IntModal({ existing, doc, onSave, onClose }) {
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({
    payer:           existing?.payer           ?? "",
    interestIncome:  existing?.interestIncome  ?? "",
    federalWithheld: existing?.federalWithheld ?? "",
  });
  const set = k => v => setForm(f => ({ ...f, [k]: v }));
  return (
    <FormModal title="1099-INT — Interest Income" onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        <Field label="Payer (Bank / Institution)" value={form.payer}           onChange={set("payer")} />
        <Field label="Box 1 — Interest Income"    value={form.interestIncome}  onChange={set("interestIncome")}  type="number" prefix="$" />
        <Field label="Box 4 — Federal Withheld"   value={form.federalWithheld} onChange={set("federalWithheld")} type="number" prefix="$" note="Usually $0" />
        <FileAttach file={file} onFileChange={setFile} hasExisting={!!doc?.data?.s3Key} />
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-white/[0.08] py-2 text-sm text-slate-400 hover:text-slate-200 cursor-pointer">Cancel</button>
          <button onClick={() => onSave({ ...form, _file: file })} className="flex-1 rounded-lg bg-blue-600 hover:bg-blue-500 py-2 text-sm font-semibold text-white cursor-pointer">Save</button>
        </div>
      </div>
    </FormModal>
  );
}

function DivModal({ existing, doc, onSave, onClose }) {
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({
    payer:             existing?.payer             ?? "",
    ordinaryDividends: existing?.ordinaryDividends ?? "",
    qualifiedDividends:existing?.qualifiedDividends?? "",
    federalWithheld:   existing?.federalWithheld   ?? "",
  });
  const set = k => v => setForm(f => ({ ...f, [k]: v }));
  return (
    <FormModal title="1099-DIV — Dividends" onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        <Field label="Payer (Brokerage / Fund)"         value={form.payer}              onChange={set("payer")} />
        <Field label="Box 1a — Ordinary Dividends"      value={form.ordinaryDividends}  onChange={set("ordinaryDividends")}  type="number" prefix="$" />
        <Field label="Box 1b — Qualified Dividends"     value={form.qualifiedDividends} onChange={set("qualifiedDividends")} type="number" prefix="$" note="Must be ≤ ordinary dividends" />
        <Field label="Box 4 — Federal Tax Withheld"     value={form.federalWithheld}    onChange={set("federalWithheld")}    type="number" prefix="$" />
        <FileAttach file={file} onFileChange={setFile} hasExisting={!!doc?.data?.s3Key} />
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-white/[0.08] py-2 text-sm text-slate-400 hover:text-slate-200 cursor-pointer">Cancel</button>
          <button onClick={() => onSave({ ...form, _file: file })} className="flex-1 rounded-lg bg-blue-600 hover:bg-blue-500 py-2 text-sm font-semibold text-white cursor-pointer">Save</button>
        </div>
      </div>
    </FormModal>
  );
}

function BModal({ existing, doc, onSave, onClose }) {
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({
    payer:             existing?.payer             ?? "",
    shortTermProceeds: existing?.shortTermProceeds ?? "",
    shortTermBasis:    existing?.shortTermBasis    ?? "",
    shortTermGain:     existing?.shortTermGain     ?? "",
    longTermProceeds:  existing?.longTermProceeds  ?? "",
    longTermBasis:     existing?.longTermBasis     ?? "",
    longTermGain:      existing?.longTermGain      ?? "",
  });
  const set = k => v => setForm(f => ({ ...f, [k]: v }));
  return (
    <FormModal title="1099-B — Proceeds from Brokerage" onClose={onClose} wide>
      <div className="flex flex-col gap-4 p-4">
        {/* Payer — label + input on same line */}
        <div className="grid grid-cols-[130px_1fr] items-center gap-3">
          <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Payer (Brokerage)</label>
          <input
            type="text" value={form.payer ?? ""} onChange={e => set("payer")(e.target.value)}
            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50"
          />
        </div>

        {/* ST / LT grid — column headers + aligned rows */}
        <div className="grid grid-cols-[80px_1fr_1fr_1fr] items-center gap-x-3 gap-y-2">
          {/* Column headers */}
          <div />
          {["Proceeds", "Cost Basis", "Net Gain / Loss"].map(h => (
            <span key={h} className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide text-center">{h}</span>
          ))}
          {/* Short-Term row */}
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Short-Term</span>
          {[["shortTermProceeds", form.shortTermProceeds], ["shortTermBasis", form.shortTermBasis], ["shortTermGain", form.shortTermGain]].map(([k, v]) => (
            <div key={k} className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
              <input type="number" value={v ?? ""} onChange={e => set(k)(e.target.value)}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50"
                style={{ paddingLeft: 24, paddingRight: 8 }} />
            </div>
          ))}
          {/* Long-Term row */}
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Long-Term</span>
          {[["longTermProceeds", form.longTermProceeds], ["longTermBasis", form.longTermBasis], ["longTermGain", form.longTermGain]].map(([k, v]) => (
            <div key={k} className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
              <input type="number" value={v ?? ""} onChange={e => set(k)(e.target.value)}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50"
                style={{ paddingLeft: 24, paddingRight: 8 }} />
            </div>
          ))}
        </div>
        <p className="text-[10px] text-slate-600 -mt-2">Net Gain / Loss: enter a negative value for a loss.</p>

        <FileAttach file={file} onFileChange={setFile} hasExisting={!!doc?.data?.s3Key} />
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-white/[0.08] py-2 text-sm text-slate-400 hover:text-slate-200 cursor-pointer">Cancel</button>
          <button onClick={() => onSave({ ...form, _file: file })} className="flex-1 rounded-lg bg-blue-600 hover:bg-blue-500 py-2 text-sm font-semibold text-white cursor-pointer">Save</button>
        </div>
      </div>
    </FormModal>
  );
}

function HSAModal({ docType, existing, doc, onSave, onClose }) {
  const [file, setFile] = useState(null);
  const is5498 = docType === "5498-SA";
  const [form, setForm] = useState(is5498
    ? { payer: existing?.payer ?? "", hsaContributions: existing?.hsaContributions ?? "", employerContributions: existing?.employerContributions ?? "" }
    : { payer: existing?.payer ?? "", distributions: existing?.distributions ?? "", qualifiedDistributions: existing?.qualifiedDistributions ?? "" }
  );
  const set = k => v => setForm(f => ({ ...f, [k]: v }));
  return (
    <FormModal title={is5498 ? "5498-SA — HSA Contributions" : "1099-SA — HSA Distributions"} onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        <Field label="HSA Provider" value={form.payer} onChange={set("payer")} />
        {is5498 ? (
          <>
            <Field label="Total HSA Contributions (Box 2)"  value={form.hsaContributions}    onChange={set("hsaContributions")}    type="number" prefix="$" note="Employee + employer combined" />
            <Field label="Employer Contributions"           value={form.employerContributions} onChange={set("employerContributions")} type="number" prefix="$" note="From Box 9 / employer records" />
          </>
        ) : (
          <>
            <Field label="Total Distributions (Box 1)"      value={form.distributions}         onChange={set("distributions")}         type="number" prefix="$" />
            <Field label="Qualified Distributions"          value={form.qualifiedDistributions} onChange={set("qualifiedDistributions")} type="number" prefix="$" note="Medical expenses — not taxable" />
          </>
        )}
        <FileAttach file={file} onFileChange={setFile} hasExisting={!!doc?.data?.s3Key} />
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-white/[0.08] py-2 text-sm text-slate-400 hover:text-slate-200 cursor-pointer">Cancel</button>
          <button onClick={() => onSave({ ...form, _file: file })} className="flex-1 rounded-lg bg-blue-600 hover:bg-blue-500 py-2 text-sm font-semibold text-white cursor-pointer">Save</button>
        </div>
      </div>
    </FormModal>
  );
}

function ConfigModal({ config, year, onSave, onClose }) {
  const [form, setForm] = useState({
    selfFrequency:   config?.selfFrequency   || "semi-monthly",
    spouseFrequency: config?.spouseFrequency || "semi-monthly",
    selfName:        config?.selfName        || "Self",
    spouseName:      config?.spouseName      || "Spouse",
  });
  const set = k => v => setForm(f => ({ ...f, [k]: v }));
  return (
    <FormModal title="Payslip Settings" onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        <Field label="Your Name"        value={form.selfName}        onChange={set("selfName")} />
        <SelectField label="Your Pay Frequency"    value={form.selfFrequency}   onChange={set("selfFrequency")}   options={FREQ_OPTIONS} />
        <Field label="Spouse Name"      value={form.spouseName}      onChange={set("spouseName")} />
        <SelectField label="Spouse Pay Frequency"  value={form.spouseFrequency} onChange={set("spouseFrequency")} options={FREQ_OPTIONS} />
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-white/[0.08] py-2 text-sm text-slate-400 hover:text-slate-200 cursor-pointer">Cancel</button>
          <button onClick={() => onSave({ ...form, year })} className="flex-1 rounded-lg bg-blue-600 hover:bg-blue-500 py-2 text-sm font-semibold text-white cursor-pointer">Save</button>
        </div>
      </div>
    </FormModal>
  );
}

function CreditsModal({ config, selfName, spouseName, year, onSave, onClose }) {
  const [form, setForm] = useState({
    numChildrenUnder17:    config?.numChildrenUnder17    ?? "",
    numOtherDependents:    config?.numOtherDependents    ?? "",
    selfIraContribution:   config?.selfIraContribution   ?? "",
    spouseIraContribution: config?.spouseIraContribution ?? "",
    itemize:               config?.itemize               ?? false,
    mortgageInterest:      config?.mortgageInterest      ?? "",
    saltDeduction:         config?.saltDeduction         ?? "",
    charitableDeductions:  config?.charitableDeductions  ?? "",
    dependentCareExpenses: config?.dependentCareExpenses ?? "",
  });
  const set = k => v => setForm(f => ({ ...f, [k]: v }));

  function HRow({ label, note, prefix, value, onChange, type = "number" }) {
    return (
      <div className="grid grid-cols-[200px_1fr] items-start gap-3">
        <div className="pt-2">
          <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide leading-tight">{label}</div>
          {note && <div className="text-[10px] text-slate-600 mt-1 leading-snug">{note}</div>}
        </div>
        <div className="relative">
          {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">{prefix}</span>}
          <input type={type} value={value ?? ""} onChange={e => onChange(e.target.value)}
            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50"
            style={{ paddingLeft: prefix ? 24 : 12, paddingRight: 8 }} />
        </div>
      </div>
    );
  }

  return (
    <FormModal title="Credits & Deductions" onClose={onClose} wide>
      <div className="flex flex-col gap-5 p-4 max-h-[70vh] overflow-y-auto">

        {/* Dependents */}
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-3">Dependents</div>
          <div className="flex flex-col gap-2">
            <HRow label="Children under 17"
              note={`CTC: $2,000/child. Phase-out above $${(CTC_THRESHOLD/1000).toFixed(0)}K MAGI.`}
              value={form.numChildrenUnder17} onChange={set("numChildrenUnder17")} />
            <HRow label="Other dependents"
              note="ODC: $500/qualifying relative."
              value={form.numOtherDependents} onChange={set("numOtherDependents")} />
          </div>
        </div>

        {/* Dependent Care */}
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">Dependent Care (Form 2441)</div>
          <div className="text-[11px] text-slate-600 mb-2">
            Credit = 20% of expenses (max $3,000 for 1 dep, $6,000 for 2+). Enter net after any employer FSA.
          </div>
          <HRow label="Net care expenses"
            note="Childcare, after-school, day camp, elder care."
            prefix="$" value={form.dependentCareExpenses} onChange={set("dependentCareExpenses")} />
        </div>

        {/* Traditional IRA */}
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">Traditional IRA Deduction</div>
          <div className="text-[11px] text-slate-600 mb-2">
            Above-the-line, up to $7,000/person. Phase-out applies if covered by a 401k.
          </div>
          <div className="flex flex-col gap-2">
            <HRow label={`${selfName} IRA contribution`}   note="Max $7,000/yr"
              prefix="$" value={form.selfIraContribution}   onChange={set("selfIraContribution")} />
            <HRow label={`${spouseName} IRA contribution`} note="Max $7,000/yr"
              prefix="$" value={form.spouseIraContribution} onChange={set("spouseIraContribution")} />
          </div>
        </div>

        {/* Itemized vs Standard */}
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Itemized Deductions</div>
          <CheckField
            label="Itemize deductions (instead of standard deduction)"
            checked={form.itemize}
            onChange={v => set("itemize")(v)}
            note="Only beneficial if total itemized > standard deduction. The system always takes the higher." />
          {form.itemize && (
            <div className="flex flex-col gap-2 mt-3 pl-2">
              <HRow label="Mortgage Interest"   prefix="$" value={form.mortgageInterest}     onChange={set("mortgageInterest")} />
              <HRow label="Property Tax (SALT)" prefix="$" value={form.saltDeduction}        onChange={set("saltDeduction")}        note="Capped at $10,000" />
              <HRow label="Charitable Gifts"    prefix="$" value={form.charitableDeductions} onChange={set("charitableDeductions")} />
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 rounded-lg border border-white/[0.08] py-2 text-sm text-slate-400 hover:text-slate-200 cursor-pointer">Cancel</button>
          <button onClick={() => onSave(form)} className="flex-1 rounded-lg bg-blue-600 hover:bg-blue-500 py-2 text-sm font-semibold text-white cursor-pointer">Save</button>
        </div>
      </div>
    </FormModal>
  );
}

/* ─── Payslip grid ───────────────────────────────────────────── */
function PayslipGrid({ year, frequency, person, docs, onPeriodClick }) {
  const periods  = useMemo(() => buildPeriods(year, frequency), [year, frequency]);
  const uploaded = useMemo(() => {
    const m = {};
    docs.filter(d => d.docType === "PAYSLIP" && d.person === person && !d.data?.isBonus).forEach(d => { m[d.period] = d; });
    return m;
  }, [docs, person]);

  if (frequency === "monthly" || frequency === "bi-weekly") {
    return (
      <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
        {periods.map(p => {
          const doc         = uploaded[p.id];
          const past        = isPast(p.id, year);
          const isExtracted = doc?.status === "extracted";
          const isPending   = doc?.data?.s3Key && doc?.status !== "extracted";
          return (
            <button key={p.id} onClick={() => onPeriodClick(p, doc)}
              className={`rounded-lg px-2 py-2 text-xs font-medium border transition-colors cursor-pointer text-left ${
                doc ? "border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-400"
                    : past ? "border-amber-500/30 bg-amber-500/[0.04] text-amber-600 hover:border-amber-500/50"
                    : "border-white/[0.06] bg-white/[0.02] text-slate-600 hover:border-white/[0.12]"
              }`}>
              <div>{p.label}</div>
              {doc && <div className="text-[10px] mt-0.5">{formatMoney(sn(doc.data?.grossPay))}</div>}
              {isExtracted && <div className="text-[9px] mt-0.5 text-emerald-300">AI ✓</div>}
              {isPending   && <div className="text-[9px] mt-0.5 text-amber-500">…</div>}
              {!doc && past && <div className="text-[10px] mt-0.5">missing</div>}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="grid gap-1">
      {MONTHS.map((mo, mi) => {
        const pA = periods.find(p => p.month === mi && p.id.endsWith("-A"));
        const pB = periods.find(p => p.month === mi && p.id.endsWith("-B"));
        return (
          <div key={mi} className="grid grid-cols-[60px_1fr_1fr] gap-1.5 items-center">
            <span className="text-xs text-slate-600 font-medium">{mo}</span>
            {[pA, pB].map(p => {
              if (!p) return null;
              const doc         = uploaded[p.id];
              const past        = isPast(p.id, year);
              const isExtracted = doc?.status === "extracted";
              const isPending   = doc?.data?.s3Key && doc?.status !== "extracted";
              return (
                <button key={p.id} onClick={() => onPeriodClick(p, doc)}
                  className={`rounded-lg px-2 py-1.5 text-xs font-medium border transition-colors cursor-pointer text-left ${
                    doc ? "border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-400"
                        : past ? "border-amber-500/30 bg-amber-500/[0.04] text-amber-600 hover:border-amber-500/50"
                        : "border-white/[0.06] bg-white/[0.02] text-slate-600 hover:border-white/[0.12]"
                  }`}>
                  <span className="text-[10px] text-slate-500">{p.id.endsWith("-A") ? "1–15" : "16–31"}</span>
                  {doc && <div className="mt-0.5">{formatMoney(sn(doc.data?.grossPay))}</div>}
                  {isExtracted && <div className="text-[9px] text-emerald-300">AI ✓</div>}
                  {isPending   && <div className="text-[9px] text-amber-500">…</div>}
                  {!doc && past && <div className="text-[10px] mt-0.5 text-amber-700">missing</div>}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* ─── Tabs ───────────────────────────────────────────────────── */
const TABS = ["Income", "1099 Forms", "HSA", "Tax Summary"];

/* ─── Main page ──────────────────────────────────────────────── */
export default function TaxReturn() {
  const [year, setYear]     = useState(CY);
  const [tab,  setTab]      = useState(0);
  const [modal, setModal]   = useState(null);
  const [isSaving, setSaving] = useState(false);
  const canWrite = useCanWrite("taxReturn");
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.taxReturn(year),
    queryFn:  () => api.get(`/tax-return?year=${year}`),
    staleTime: 2 * 60 * 1000,
    // Poll every 5s while any document has a PDF uploaded but not yet AI-extracted
    refetchInterval: (query) => {
      const items = Array.isArray(query.state.data?.items) ? query.state.data.items : [];
      return items.some(d => d.data?.s3Key && d.status !== "extracted") ? 5000 : false;
    },
  });

  const docs   = useMemo(() => Array.isArray(data?.items) ? data.items : [], [data]);
  const config = data?.config || null;

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.taxReturn(year) });

  const createMut = useMutation({ mutationFn: body => api.post("/tax-return/documents", body),                                         onSuccess: invalidate });
  const updateMut = useMutation({ mutationFn: ({ docId, ...body }) => api.put(`/tax-return/documents/${docId}`, body),                 onSuccess: invalidate });
  const deleteMut = useMutation({ mutationFn: ({ docId }) => api.delete(`/tax-return/documents/${docId}?year=${year}`),               onSuccess: invalidate });
  const configMut = useMutation({ mutationFn: body => api.post("/tax-return/config", body),                                           onSuccess: invalidate });

  /* ── Upload file to S3 then save document record ── */
  async function saveDoc(docType, person, data, label, period, existing) {
    const { _file, ...cleanData } = data;
    setSaving(true);
    try {
      let s3Key    = existing?.data?.s3Key;
      let newDocId = undefined;  // only used when creating a new doc with a file
      if (_file) {
        // Pass existing.docId on updates so the S3 key contains the same docId as the DDB record.
        // On creates, omit docId — the backend generates one and returns it in res.docId.
        // We then pass res.docId to createDocument so both the S3 key and DDB record share the same id,
        // allowing the S3-triggered extractor to look up the correct DDB record.
        const res = await api.post("/tax-return/documents/upload-url", {
          year,
          docId:       existing?.docId,
          fileName:    _file.name,
          contentType: _file.type || "application/pdf",
        });
        await fetch(res.uploadUrl, {
          method:  "PUT",
          body:    _file,
          headers: { "Content-Type": _file.type || "application/pdf" },
        });
        s3Key    = res.s3Key;
        newDocId = existing?.docId ? undefined : res.docId;
      }
      const finalData = s3Key ? { ...cleanData, s3Key } : cleanData;
      const payload   = { docType, taxYear: year, person, data: finalData, label };
      if (period)   payload.period = period;
      if (newDocId) payload.docId  = newDocId;
      if (existing?.docId) await updateMut.mutateAsync({ docId: existing.docId, taxYear: year, data: finalData, label });
      else                  await createMut.mutateAsync(payload);
    } catch (err) {
      console.error("saveDoc failed", err);
    } finally {
      setSaving(false);
      setModal(null);
    }
  }

  function deleteDoc(doc) { deleteMut.mutate({ docId: doc.docId }); }

  /* ── Open presigned download URL for attached PDF ── */
  async function viewDocFile(doc) {
    try {
      const res = await api.get(`/tax-return/documents/${doc.docId}/download-url?year=${year}`);
      window.open(res.downloadUrl, "_blank");
    } catch (err) {
      console.error("download-url failed", err);
    }
  }

  function onPeriodClick(period, existing, person = "self") {
    if (!canWrite) return;
    setModal({ type: "payslip", period, existing: existing?.data, doc: existing, person });
  }

  /* ── Capital gains — same FIFO logic as CapitalGains page ── */
  const txResults = useQueries({
    queries: [
      { queryKey: queryKeys.stocksTx(),  queryFn: () => api.get("/assets/stocks/transactions"),  staleTime: 5 * 60 * 1000 },
      { queryKey: queryKeys.cryptoTx(),  queryFn: () => api.get("/assets/crypto/transactions"),  staleTime: 5 * 60 * 1000 },
      { queryKey: queryKeys.bullionTx(), queryFn: () => api.get("/assets/bullion/transactions"), staleTime: 5 * 60 * 1000 },
      { queryKey: queryKeys.optionsTx(), queryFn: () => api.get("/assets/options/transactions"), staleTime: 5 * 60 * 1000 },
      { queryKey: queryKeys.futuresTx(), queryFn: () => api.get("/assets/futures/transactions"), staleTime: 5 * 60 * 1000 },
    ],
  });
  const txLoading = txResults.some(r => r.isLoading);

  const schedD = useMemo(() => {
    if (txLoading) return null;
    const [sTx, cTx, bTx, oTx, fTx] = txResults.map(r => toArr(r.data));
    return computeScheduleD(
      calcStocks(sTx, year),
      calcCrypto(cTx, year),
      calcBullion(bTx, year),
      calcOptions(oTx, year),
      calcFutures(fTx, year),
    );
  }, [txLoading, txResults, year]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(() => computeTaxSummary(docs, config, schedD, year), [docs, config, schedD, year]);

  /* ── Completeness ── */
  const completeness = useMemo(() => {
    let total = 0, done = 0;
    const freq = FREQ_PERIODS[config?.selfFrequency || "semi-monthly"];
    total += freq * 2;
    done  += docs.filter(d => d.docType === "PAYSLIP" && !d.data?.isBonus).length;
    total += 2;
    done  += docs.filter(d => d.docType === "W2").length;
    total += 3;
    done  += Math.min(docs.filter(d => d.docType === "1099-INT").length, 1);
    done  += Math.min(docs.filter(d => d.docType === "1099-DIV").length, 1);
    done  += Math.min(docs.filter(d => d.docType === "1099-B").length, 1);
    return Math.min(100, Math.round((done / total) * 100));
  }, [docs, config]);

  const selfFreq   = config?.selfFrequency   || "semi-monthly";
  const spouseFreq = config?.spouseFrequency || "semi-monthly";
  const selfName   = config?.selfName        || "Self";
  const spouseName = config?.spouseName      || "Spouse";
  const docsOf           = type => docs.filter(d => d.docType === type);
  const regularSelfStubs   = docsOf("PAYSLIP").filter(d => d.person === "self"   && !d.data?.isBonus);
  const bonusSelfStubs     = docsOf("PAYSLIP").filter(d => d.person === "self"   &&  d.data?.isBonus);
  const regularSpouseStubs = docsOf("PAYSLIP").filter(d => d.person === "spouse" && !d.data?.isBonus);
  const bonusSpouseStubs   = docsOf("PAYSLIP").filter(d => d.person === "spouse" &&  d.data?.isBonus);

  /* ── Merge existing config with new credits fields when saving credits ── */
  function saveCredits(form) {
    configMut.mutate({
      year,
      selfFrequency:   config?.selfFrequency   || "semi-monthly",
      spouseFrequency: config?.spouseFrequency || "semi-monthly",
      selfName:        config?.selfName        || "Self",
      spouseName:      config?.spouseName      || "Spouse",
      filingStatus:    config?.filingStatus    || "mfj",
      ...form,
    });
    setModal(null);
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title="Tax Return" subtitle={`${year} · MFJ · Federal estimate`} icon={PageIcons.taxReturn} />
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-24 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${completeness}%` }} />
            </div>
            <span className="text-xs text-slate-500">{completeness}% complete</span>
          </div>
          <select value={year} onChange={e => setYear(Number(e.target.value))}
            className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50 cursor-pointer">
            {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl border border-white/[0.06]" style={{ background: "var(--fv-card)" }}>
        {TABS.map((t, i) => (
          <button key={t} onClick={() => setTab(i)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
              tab === i ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"
            }`}>
            {t}
          </button>
        ))}
      </div>

      {isLoading && <div className="text-center text-slate-500 text-sm py-12">Loading…</div>}
      {isSaving  && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="rounded-2xl px-8 py-5 text-sm text-slate-300" style={{ background: "var(--fv-card)" }}>
            Uploading document…
          </div>
        </div>
      )}

      {!isLoading && (
        <>
          {/* ── TAB 0: INCOME ── */}
          {tab === 0 && (
            <div className="flex flex-col gap-4">
              <SectionCard title="Payslip Settings"
                action={canWrite && <AddButton label="Edit Settings" onClick={() => setModal({ type: "config" })} />}>
                <div className="grid grid-cols-2 gap-4 text-sm text-slate-400">
                  <div><span className="text-slate-500 text-xs uppercase tracking-wide">Self</span><div className="mt-1 text-slate-200">{selfName} — {FREQ_OPTIONS.find(f=>f.value===selfFreq)?.label}</div></div>
                  <div><span className="text-slate-500 text-xs uppercase tracking-wide">Spouse</span><div className="mt-1 text-slate-200">{spouseName} — {FREQ_OPTIONS.find(f=>f.value===spouseFreq)?.label}</div></div>
                </div>
              </SectionCard>

              {/* Self payslips */}
              <SectionCard title={`${selfName} — Pay Stubs`}>
                <div className="mb-3 flex items-center gap-4 text-xs text-slate-500">
                  <span>{regularSelfStubs.length} of {FREQ_PERIODS[selfFreq]} uploaded</span>
                  {summary.self.source !== "none" && summary.self.source !== "W-2" && (
                    <span className="text-amber-500">Projected annual: <strong className="text-amber-400">{formatMoney(summary.self.wages)}</strong></span>
                  )}
                </div>
                <PayslipGrid year={year} frequency={selfFreq} person="self" docs={docs}
                  onPeriodClick={(p, d) => onPeriodClick(p, d, "self")} />

                {/* Bonus / one-time pay */}
                <div className="mt-4 pt-3 border-t border-white/[0.06]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Bonus / One-Time Pay</span>
                    {canWrite && <AddButton label="Add Bonus" onClick={() => setModal({ type:"payslip", period:null, existing:null, doc:null, person:"self", isBonus:true })} />}
                  </div>
                  {bonusSelfStubs.map(doc => (
                    <DocCard key={doc.docId}
                      label={doc.data?.employer || "Bonus"} sub="One-time · not extrapolated"
                      value={formatMoney(sn(doc.data?.grossPay))} status={doc.status}
                      hasFile={!!doc.data?.s3Key} onView={() => viewDocFile(doc)}
                      onEdit={() => setModal({ type:"payslip", period:null, existing:doc.data, doc, person:"self", isBonus:true })}
                      onDelete={() => deleteDoc(doc)} />
                  ))}
                  {!bonusSelfStubs.length && (
                    <p className="text-xs text-slate-600">None — add if you received a signing bonus, year-end bonus, or other one-time payment.</p>
                  )}
                </div>
              </SectionCard>

              {/* Self W-2 */}
              <SectionCard title={`${selfName} — W-2 (Year-End)`}
                action={canWrite && <AddButton label={docsOf("W2").find(d=>d.person==="self") ? "Edit" : "Enter W-2"} onClick={() => setModal({ type:"w2", person:"self", existing: docsOf("W2").find(d=>d.person==="self")?.data, doc: docsOf("W2").find(d=>d.person==="self") })} />}>
                {docsOf("W2").filter(d=>d.person==="self").map(doc => (
                  <DocCard key={doc.docId} label={doc.data?.employer || "W-2"} sub="Overrides payslip projection"
                    value={formatMoney(sn(doc.data?.wages))} status={doc.status}
                    hasFile={!!doc.data?.s3Key} onView={() => viewDocFile(doc)}
                    onEdit={() => setModal({ type:"w2", person:"self", existing:doc.data, doc })}
                    onDelete={() => deleteDoc(doc)} />
                ))}
                {!docsOf("W2").find(d=>d.person==="self") && <p className="text-xs text-slate-600">Not yet entered — payslips used for projection.</p>}
              </SectionCard>

              {/* Spouse payslips */}
              <SectionCard title={`${spouseName} — Pay Stubs`}>
                <div className="mb-3 flex items-center gap-4 text-xs text-slate-500">
                  <span>{regularSpouseStubs.length} of {FREQ_PERIODS[spouseFreq]} uploaded</span>
                  {summary.spouse.source !== "none" && summary.spouse.source !== "W-2" && (
                    <span className="text-amber-500">Projected annual: <strong className="text-amber-400">{formatMoney(summary.spouse.wages)}</strong></span>
                  )}
                </div>
                <PayslipGrid year={year} frequency={spouseFreq} person="spouse" docs={docs}
                  onPeriodClick={(p, d) => onPeriodClick(p, d, "spouse")} />

                {/* Bonus / one-time pay */}
                <div className="mt-4 pt-3 border-t border-white/[0.06]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Bonus / One-Time Pay</span>
                    {canWrite && <AddButton label="Add Bonus" onClick={() => setModal({ type:"payslip", period:null, existing:null, doc:null, person:"spouse", isBonus:true })} />}
                  </div>
                  {bonusSpouseStubs.map(doc => (
                    <DocCard key={doc.docId}
                      label={doc.data?.employer || "Bonus"} sub="One-time · not extrapolated"
                      value={formatMoney(sn(doc.data?.grossPay))} status={doc.status}
                      hasFile={!!doc.data?.s3Key} onView={() => viewDocFile(doc)}
                      onEdit={() => setModal({ type:"payslip", period:null, existing:doc.data, doc, person:"spouse", isBonus:true })}
                      onDelete={() => deleteDoc(doc)} />
                  ))}
                  {!bonusSpouseStubs.length && (
                    <p className="text-xs text-slate-600">None — add if your spouse received a signing bonus, year-end bonus, or other one-time payment.</p>
                  )}
                </div>
              </SectionCard>

              {/* Spouse W-2 */}
              <SectionCard title={`${spouseName} — W-2 (Year-End)`}
                action={canWrite && <AddButton label={docsOf("W2").find(d=>d.person==="spouse") ? "Edit" : "Enter W-2"} onClick={() => setModal({ type:"w2", person:"spouse", existing: docsOf("W2").find(d=>d.person==="spouse")?.data, doc: docsOf("W2").find(d=>d.person==="spouse") })} />}>
                {docsOf("W2").filter(d=>d.person==="spouse").map(doc => (
                  <DocCard key={doc.docId} label={doc.data?.employer || "W-2"} sub="Overrides payslip projection"
                    value={formatMoney(sn(doc.data?.wages))} status={doc.status}
                    hasFile={!!doc.data?.s3Key} onView={() => viewDocFile(doc)}
                    onEdit={() => setModal({ type:"w2", person:"spouse", existing:doc.data, doc })}
                    onDelete={() => deleteDoc(doc)} />
                ))}
                {!docsOf("W2").find(d=>d.person==="spouse") && <p className="text-xs text-slate-600">Not yet entered — payslips used for projection.</p>}
              </SectionCard>
            </div>
          )}

          {/* ── TAB 1: 1099 FORMS ── */}
          {tab === 1 && (
            <div className="flex flex-col gap-4">
              <SectionCard title="1099-INT — Interest Income"
                action={canWrite && <AddButton label="Add 1099-INT" onClick={() => setModal({ type:"1099-int" })} />}>
                {docsOf("1099-INT").map(doc => (
                  <DocCard key={doc.docId} label={doc.data?.payer || "Bank"} sub="Interest income"
                    value={formatMoney(sn(doc.data?.interestIncome))} status={doc.status}
                    hasFile={!!doc.data?.s3Key} onView={() => viewDocFile(doc)}
                    onEdit={() => setModal({ type:"1099-int", existing:doc.data, doc })}
                    onDelete={() => deleteDoc(doc)} />
                ))}
                {!docsOf("1099-INT").length && <p className="text-xs text-slate-600">No interest forms entered yet.</p>}
              </SectionCard>

              <SectionCard title="1099-DIV — Dividends"
                action={canWrite && <AddButton label="Add 1099-DIV" onClick={() => setModal({ type:"1099-div" })} />}>
                {docsOf("1099-DIV").map(doc => (
                  <DocCard key={doc.docId} label={doc.data?.payer || "Brokerage"}
                    sub={`Ordinary: ${formatMoney(sn(doc.data?.ordinaryDividends))} · Qualified: ${formatMoney(sn(doc.data?.qualifiedDividends))}`}
                    status={doc.status} hasFile={!!doc.data?.s3Key} onView={() => viewDocFile(doc)}
                    onEdit={() => setModal({ type:"1099-div", existing:doc.data, doc })}
                    onDelete={() => deleteDoc(doc)} />
                ))}
                {!docsOf("1099-DIV").length && <p className="text-xs text-slate-600">No dividend forms entered yet.</p>}
              </SectionCard>

              <SectionCard title="1099-B — Capital Gains (Brokerage Year-End)"
                action={canWrite && <AddButton label="Add 1099-B" onClick={() => setModal({ type:"1099-b" })} />}>
                {docsOf("1099-B").length > 0 && (
                  <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/[0.08] border border-emerald-500/20">
                    <svg className="w-4 h-4 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    <span className="text-xs text-emerald-400">1099-B entered — using brokerage figures instead of finVault Capital Gains.</span>
                  </div>
                )}
                {docsOf("1099-B").map(doc => (
                  <DocCard key={doc.docId} label={doc.data?.payer || "Brokerage"}
                    sub={`ST: ${formatMoney(sn(doc.data?.shortTermGain))} · LT: ${formatMoney(sn(doc.data?.longTermGain))}`}
                    status={doc.status} hasFile={!!doc.data?.s3Key} onView={() => viewDocFile(doc)}
                    onEdit={() => setModal({ type:"1099-b", existing:doc.data, doc })}
                    onDelete={() => deleteDoc(doc)} />
                ))}
                {!docsOf("1099-B").length && (
                  <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-blue-500/[0.06] border border-blue-500/[0.15]">
                    <svg className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <div className="flex flex-col gap-0.5">
                      <p className="text-xs text-blue-300">No 1099-B entered yet. Tax Summary uses <strong>finVault Capital Gains</strong> figures. Enter your 1099-B when received to reconcile.</p>
                      {schedD && (schedD.netST !== 0 || schedD.netRegLT !== 0 || schedD.rawCollLT !== 0) && (
                        <p className="text-xs text-slate-500 mt-0.5">
                          Computed from transactions: ST {formatMoney(schedD.netST)} · LT regular {formatMoney(schedD.netRegLT)} · LT collectibles {formatMoney(schedD.rawCollLT)}
                        </p>
                      )}
                      {txLoading && <p className="text-xs text-slate-600 mt-0.5">Loading transactions…</p>}
                    </div>
                  </div>
                )}
                {docsOf("1099-B").length > 0 && (
                  <div className="mt-4 rounded-xl border border-white/[0.06] overflow-hidden">
                    <div className="px-4 py-2 bg-white/[0.02] border-b border-white/[0.06]">
                      <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Capital Gains Reconciliation</span>
                    </div>
                    <div className="grid grid-cols-3 gap-0 text-xs">
                      <div className="px-4 py-2 text-slate-600 font-semibold" />
                      <div className="px-4 py-2 text-slate-500 font-semibold text-right">finVault</div>
                      <div className="px-4 py-2 text-slate-500 font-semibold text-right">1099-B</div>
                      {[["Short-Term", summary.cgST, docsOf("1099-B").reduce((s,d)=>s+sn(d.data?.shortTermGain),0)],
                        ["Long-Term",  summary.cgLT, docsOf("1099-B").reduce((s,d)=>s+sn(d.data?.longTermGain), 0)]].map(([label, fv, b]) => (
                        <div key={label} className="contents">
                          <div className="px-4 py-2 text-slate-400 border-t border-white/[0.04]">{label}</div>
                          <div className="px-4 py-2 text-right border-t border-white/[0.04] text-slate-300">{formatMoney(fv)}</div>
                          <div className={`px-4 py-2 text-right border-t border-white/[0.04] font-semibold ${Math.abs(fv - b) > 10 ? "text-amber-400" : "text-slate-300"}`}>{formatMoney(b)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </SectionCard>
            </div>
          )}

          {/* ── TAB 2: HSA ── */}
          {tab === 2 && (
            <div className="flex flex-col gap-4">
              <SectionCard title="5498-SA — HSA Contributions"
                action={canWrite && <AddButton label="Add 5498-SA" onClick={() => setModal({ type:"hsa", docType:"5498-SA" })} />}>
                {docsOf("5498-SA").map(doc => (
                  <DocCard key={doc.docId} label={doc.data?.payer || "HSA Provider"}
                    sub={`Employee deduction: ${formatMoney(Math.max(0, sn(doc.data?.hsaContributions) - sn(doc.data?.employerContributions)))}`}
                    value={formatMoney(sn(doc.data?.hsaContributions))} status={doc.status}
                    hasFile={!!doc.data?.s3Key} onView={() => viewDocFile(doc)}
                    onEdit={() => setModal({ type:"hsa", docType:"5498-SA", existing:doc.data, doc })}
                    onDelete={() => deleteDoc(doc)} />
                ))}
                {!docsOf("5498-SA").length && <p className="text-xs text-slate-600">No HSA contribution form entered yet.</p>}
                <div className="mt-3 text-xs text-slate-600">Employee HSA contributions are an above-the-line deduction that reduces AGI.</div>
              </SectionCard>

              <SectionCard title="1099-SA — HSA Distributions"
                action={canWrite && <AddButton label="Add 1099-SA" onClick={() => setModal({ type:"hsa", docType:"1099-SA" })} />}>
                {docsOf("1099-SA").map(doc => (
                  <DocCard key={doc.docId} label={doc.data?.payer || "HSA Provider"}
                    sub={`Qualified (non-taxable): ${formatMoney(sn(doc.data?.qualifiedDistributions))}`}
                    value={formatMoney(sn(doc.data?.distributions))} status={doc.status}
                    hasFile={!!doc.data?.s3Key} onView={() => viewDocFile(doc)}
                    onEdit={() => setModal({ type:"hsa", docType:"1099-SA", existing:doc.data, doc })}
                    onDelete={() => deleteDoc(doc)} />
                ))}
                {!docsOf("1099-SA").length && <p className="text-xs text-slate-600">No HSA distribution form entered yet.</p>}
                <div className="mt-3 text-xs text-slate-600">Non-qualified distributions are taxed as ordinary income + 20% penalty.</div>
              </SectionCard>
            </div>
          )}

          {/* ── TAB 3: TAX SUMMARY ── */}
          {tab === 3 && (
            <div className="flex flex-col gap-4">
              {/* Banners */}
              {summary.isProjected && (
                <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-amber-500/20 bg-amber-500/[0.06]">
                  <svg className="w-4 h-4 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
                  <span className="text-xs text-amber-400">Wages are <strong>projected</strong> from pay stubs uploaded so far. Enter W-2 forms for exact figures.</span>
                </div>
              )}
              {!summary.has1099B && (
                <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-blue-500/20 bg-blue-500/[0.06]">
                  <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  <span className="text-xs text-blue-300">
                    Capital gains from <strong>finVault Capital Gains</strong> (FIFO){schedD ? `: ST ${formatMoney(schedD.netST)} · LT ${formatMoney(schedD.netRegLT + schedD.rawCollLT)}` : ""}.
                    {" "}Enter 1099-B on the Forms tab to override with brokerage figures.
                  </span>
                </div>
              )}

              {/* Credits & Deductions config card */}
              <SectionCard title="Credits & Deductions"
                action={canWrite && <EditButton label="Edit" onClick={() => setModal({ type:"credits" })} />}>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <div className="text-slate-500 uppercase tracking-wide mb-1">Children (under 17)</div>
                    <div className="text-slate-200 font-semibold">{sn(config?.numChildrenUnder17) || "—"}</div>
                  </div>
                  <div>
                    <div className="text-slate-500 uppercase tracking-wide mb-1">Other Dependents</div>
                    <div className="text-slate-200 font-semibold">{sn(config?.numOtherDependents) || "—"}</div>
                  </div>
                  <div>
                    <div className="text-slate-500 uppercase tracking-wide mb-1">Traditional IRA</div>
                    <div className="text-slate-200 font-semibold">{summary.iraDeduction > 0 ? formatMoney(summary.iraDeduction) : "—"}</div>
                  </div>
                  <div>
                    <div className="text-slate-500 uppercase tracking-wide mb-1">Deduction Type</div>
                    <div className="text-slate-200 font-semibold">{summary.useItemized ? `Itemized (${formatMoney(summary.deduction)})` : `Standard (${formatMoney(summary.stdDed)})`}</div>
                  </div>
                </div>
              </SectionCard>

              {/* Income */}
              <SectionCard title="Gross Income">
                <TaxRow label={`${summary.selfName} wages`}   value={formatMoney(summary.self.wages)}   sub={summary.self.source} />
                <TaxRow label={`${summary.spouseName} wages`} value={formatMoney(summary.spouse.wages)} sub={summary.spouse.source} />
                {summary.interest > 0 && <TaxRow label="Interest income"     value={formatMoney(summary.interest)} indent />}
                {summary.ordDiv   > 0 && (
                  <>
                    <TaxRow label="Ordinary dividends" value={formatMoney(summary.ordDiv)} indent />
                    {summary.qualDiv > 0 && <TaxRow label="  — of which qualified" value={formatMoney(summary.qualDiv)} indent sub="Taxed at LT cap gains rate" />}
                  </>
                )}
                {summary.cgST !== 0 && <TaxRow label="Short-term capital gains" value={formatMoney(summary.cgST)} sub={summary.cgSource} indent positive={summary.cgST > 0} negative={summary.cgST < 0} />}
                {summary.cgLT !== 0 && <TaxRow label="Long-term capital gains"  value={formatMoney(summary.cgLT)} sub={summary.cgSource} indent positive={summary.cgLT > 0} negative={summary.cgLT < 0} />}
                {summary.capLossDeduction > 0 && (
                  <TaxRow label="Capital loss deduction"
                    value={`−${formatMoney(summary.capLossDeduction)}`}
                    sub={summary.netCG < -3000
                      ? `$3,000 limit applied · ${formatMoney(Math.abs(summary.netCG) - 3000)} excess loss carried forward`
                      : "Net capital loss deducted against ordinary income (§1211(b))"}
                    negative indent />
                )}
                <Divider />
                <TaxRow label="Gross Income / MAGI" value={formatMoney(summary.magi)} bold />
              </SectionCard>

              {/* Deductions */}
              <SectionCard title="Deductions (Above-the-line → AGI → Taxable Income)">
                {summary.hsaDeduction > 0 && <TaxRow label="HSA employee contributions" value={`−${formatMoney(summary.hsaDeduction)}`} sub="Above-the-line (reduces MAGI)" negative indent />}
                {summary.iraDeduction > 0 && <TaxRow label="Traditional IRA deduction"  value={`−${formatMoney(summary.iraDeduction)}`} sub="Above-the-line (reduces MAGI)" negative indent />}
                {(summary.hsaDeduction > 0 || summary.iraDeduction > 0) && (
                  <TaxRow label="Adjusted Gross Income (AGI)" value={formatMoney(summary.agi)} bold />
                )}
                <Divider />
                {summary.useItemized ? (
                  <>
                    <TaxRow label="Itemized deduction" value={`−${formatMoney(summary.deduction)}`} negative />
                    {summary.mortgageInterest > 0 && <TaxRow label="  Mortgage interest"       value={formatMoney(summary.mortgageInterest)}     indent sub="Schedule A" />}
                    {summary.saltCapped       > 0 && <TaxRow label="  Property tax (SALT)"      value={formatMoney(summary.saltCapped)}           indent sub="Capped at $10,000" />}
                    {summary.charitable       > 0 && <TaxRow label="  Charitable contributions" value={formatMoney(summary.charitable)}           indent />}
                  </>
                ) : (
                  <TaxRow label={`Standard deduction (MFJ ${year})`} value={`−${formatMoney(summary.stdDed)}`} negative />
                )}
                <Divider />
                <TaxRow label="Taxable Income" value={formatMoney(summary.taxableIncome)} bold />
              </SectionCard>

              {/* Federal Tax (before credits) */}
              <SectionCard title="Federal Tax (Before Credits)">
                <TaxRow label="Ordinary income tax"        value={formatMoney(summary.ordTax)} sub={`On ${formatMoney(summary.ordinaryTaxable)} · top bracket ${summary.topBracket}`} />
                {summary.stTax > 0 && <TaxRow label="Short-term gains tax"          value={formatMoney(summary.stTax)}  sub={`On ${formatMoney(Math.max(summary.cgST,0))} · taxed as ordinary income`} />}
                {summary.ltTax > 0 && <TaxRow label="LT gains + qualified div. tax" value={formatMoney(summary.ltTax)}  sub={`On ${formatMoney(summary.preferential)} · 0 / 15 / 20% rate`} />}
                {summary.niitBase > 0 && (
                  <TaxRow label="Net Investment Income Tax (3.8%)" value={formatMoney(summary.niitTax)}
                    sub={`On ${formatMoney(summary.niitBase)} · AGI ${formatMoney(summary.agi)} > $250K threshold`} />
                )}
                {summary.addlMedicareTax > 0 && (
                  <TaxRow label="Additional Medicare Tax (0.9%)" value={formatMoney(summary.addlMedicareTax)}
                    sub={`On wages ${formatMoney(summary.totalWages)} over $250K MFJ threshold (§3101)`} />
                )}
                <Divider />
                <TaxRow label="Tax Before Credits" value={formatMoney(summary.taxBeforeCredits)} bold />
              </SectionCard>

              {/* Credits */}
              {(summary.childTaxCredit > 0 || summary.otherDepCredit > 0 || summary.dependentCareCredit > 0) ? (
                <SectionCard title="Non-Refundable Credits">
                  {summary.childTaxCredit > 0 && (
                    <TaxRow label={`Child Tax Credit (${summary.numChildren} × $2,000)`}
                      value={`−${formatMoney(summary.childTaxCredit)}`} positive
                      sub={summary.agi > CTC_THRESHOLD ? `Phase-out applied (AGI ${formatMoney(summary.agi)} > $400K)` : "Full credit — income below phase-out"} />
                  )}
                  {summary.otherDepCredit > 0 && (
                    <TaxRow label={`Other Dependent Credit (${summary.numOtherDep} × $500)`}
                      value={`−${formatMoney(summary.otherDepCredit)}`} positive />
                  )}
                  {summary.dependentCareCredit > 0 && (
                    <TaxRow label="Child & Dependent Care Credit (Form 2441)"
                      value={`−${formatMoney(summary.dependentCareCredit)}`} positive
                      sub={`${Math.round(summary.dccRate * 100)}% of ${formatMoney(sn(config?.dependentCareExpenses))} qualifying expenses (§21)`} />
                  )}
                  <Divider />
                  <TaxRow label="Total Credits Applied" value={`−${formatMoney(summary.totalCredits)}`} bold positive />
                </SectionCard>
              ) : (
                canWrite && (
                  <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-white/[0.05] bg-white/[0.01]">
                    <svg className="w-4 h-4 text-slate-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                    <span className="text-xs text-slate-600">No credits configured. </span>
                    <button onClick={() => setModal({ type:"credits" })} className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer">Add credits →</button>
                  </div>
                )
              )}

              {/* Refund / Balance Due */}
              <SectionCard title="Refund / Balance Due">
                <TaxRow label="Tax before credits"    value={formatMoney(summary.taxBeforeCredits)} />
                {summary.totalCredits > 0 && <TaxRow label="Non-refundable credits" value={`−${formatMoney(summary.totalCredits)}`} positive />}
                <TaxRow label="Total federal tax"     value={formatMoney(summary.taxAfterCredits)} bold />
                <Divider />
                <TaxRow label="Federal already withheld" value={`−${formatMoney(summary.totalWithheldAll)}`} negative
                  sub={summary.brokWith > 0 ? `Payroll: ${formatMoney(summary.totalWithheld)} + brokerage: ${formatMoney(summary.brokWith)}` : "From payroll"} />
                <Divider />
                <TaxRow
                  label={summary.balanceDue >= 0 ? "Balance Due" : "Estimated Refund"}
                  value={formatMoney(Math.abs(summary.balanceDue))}
                  bold
                  positive={summary.balanceDue < 0}
                  negative={summary.balanceDue > 0}
                />
              </SectionCard>

              <div className="rounded-xl border border-white/[0.05] bg-white/[0.01] px-4 py-3">
                <p className="text-xs text-slate-600 leading-relaxed">
                  <span className="text-slate-500 font-semibold">Estimate only — MFJ, Texas (no state income tax).</span>{" "}
                  Federal tax only. Includes ordinary income tax, ST/LT capital gains tax, NIIT (3.8%), and Additional
                  Medicare Tax (0.9% on wages over $250K). Wages projected from pay stubs until W-2 is entered.
                  Capital gains from finVault until 1099-B is entered. Credits are non-refundable (ACTC refundable
                  portion not modeled). IRA deduction assumed fully deductible — verify eligibility if covered by a
                  401k. Does not model AMT, QBI deduction (§199A), or non-qualified HSA distributions.
                  {year >= 2026 && " 2026 brackets are estimates pending official IRS guidance."}
                  {" "}Consult a CPA for your actual return.
                </p>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Modals ── */}
      {modal?.type === "config" && (
        <ConfigModal config={config} year={year}
          onSave={form => { configMut.mutate(form); setModal(null); }}
          onClose={() => setModal(null)} />
      )}
      {modal?.type === "credits" && (
        <CreditsModal config={config} selfName={selfName} spouseName={spouseName} year={year}
          onSave={saveCredits}
          onClose={() => setModal(null)} />
      )}
      {modal?.type === "payslip" && (
        <PayslipModal period={modal.period} person={modal.person || "self"} existing={modal.existing} doc={modal.doc}
          isBonus={modal.isBonus}
          onSave={form => saveDoc("PAYSLIP", modal.person || "self", form,
            form.isBonus ? "Bonus pay stub" : `${modal.period?.label} pay stub`,
            form.isBonus ? null : modal.period?.id,
            modal.doc)}
          onClose={() => setModal(null)} />
      )}
      {modal?.type === "w2" && (
        <W2Modal person={modal.person} existing={modal.existing} doc={modal.doc}
          onSave={form => saveDoc("W2", modal.person, form, `W-2 ${year}`, null, modal.doc)}
          onClose={() => setModal(null)} />
      )}
      {modal?.type === "1099-int" && (
        <IntModal existing={modal.existing} doc={modal.doc}
          onSave={form => saveDoc("1099-INT", "joint", form, form.payer || "1099-INT", null, modal.doc)}
          onClose={() => setModal(null)} />
      )}
      {modal?.type === "1099-div" && (
        <DivModal existing={modal.existing} doc={modal.doc}
          onSave={form => saveDoc("1099-DIV", "joint", form, form.payer || "1099-DIV", null, modal.doc)}
          onClose={() => setModal(null)} />
      )}
      {modal?.type === "1099-b" && (
        <BModal existing={modal.existing} doc={modal.doc}
          onSave={form => saveDoc("1099-B", "joint", form, form.payer || "1099-B", null, modal.doc)}
          onClose={() => setModal(null)} />
      )}
      {modal?.type === "hsa" && (
        <HSAModal docType={modal.docType} existing={modal.existing} doc={modal.doc}
          onSave={form => saveDoc(modal.docType, "joint", form, form.payer || modal.docType, null, modal.doc)}
          onClose={() => setModal(null)} />
      )}
    </div>
  );
}
