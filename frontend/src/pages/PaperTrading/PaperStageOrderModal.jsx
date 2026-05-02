import { useState, useEffect } from "react";

const STRATEGIES = [
  { value: "SELL_PUT", label: "Sell Cash-Secured Put (CSP)" },
];

function Field({ label, children, hint }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-slate-600">{hint}</p>}
    </div>
  );
}

function Input({ ...props }) {
  return (
    <input
      {...props}
      className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50 w-full"
    />
  );
}

function Select({ children, ...props }) {
  return (
    <select
      {...props}
      className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50 w-full"
    >
      {children}
    </select>
  );
}

/**
 * PaperStageOrderModal
 *
 * Pre-fills from a Wheel Scan PROCEED recommendation.
 * User can override any field before staging.
 * Does NOT submit to IBKR — only writes to DynamoDB via POST /paper-trade/staged.
 * IBKR submission is a separate explicit confirm step in PaperStagedOrders.
 */
export default function PaperStageOrderModal({ rec, onConfirm, onCancel, isPending }) {
  const opt = rec?.option || {};

  const [form, setForm] = useState({
    strategy:   "SELL_PUT",
    strike:     opt.strike   ? String(opt.strike)     : "",
    expiry:     opt.expiry   || "",
    quantity:   "1",
    orderType:  "LMT",
    limitPrice: opt.mid      ? String(opt.mid)        : "",
    notes:      "",
  });

  // Recalculate derived metrics when key fields change
  const strike     = parseFloat(form.strike)     || 0;
  const qty        = parseInt(form.quantity, 10)  || 0;
  const limitPrice = parseFloat(form.limitPrice) || 0;
  const collateral = strike * 100 * qty;
  const netPremium = limitPrice * 100 * qty;
  const annYield   = collateral > 0 && opt.dte > 0
    ? ((netPremium / collateral) * (365 / opt.dte) * 100).toFixed(1)
    : null;

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  function handleSubmit(e) {
    e.preventDefault();
    onConfirm({
      ticker:     rec.ticker,
      strategy:   form.strategy,
      strike:     Number(form.strike),
      expiry:     form.expiry,
      quantity:   Number(form.quantity),
      orderType:  form.orderType,
      limitPrice: form.orderType === "LMT" ? Number(form.limitPrice) : null,
      notes:      form.notes || null,
      scanId:     rec.scanId || null,
      source:     "wheel-scan",
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-full max-w-md rounded-2xl border border-white/[0.1] bg-[#0F1729] shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
              Stage Order — {rec.ticker}
            </span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/[0.15] text-amber-400 border border-amber-500/[0.25] shrink-0">
              PAPER
            </span>
          </div>
          <button
            type="button" onClick={onCancel}
            className="ml-auto text-slate-500 hover:text-slate-300 p-1 rounded-lg hover:bg-white/[0.05] cursor-pointer shrink-0"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scan context strip */}
        <div className="mx-5 mt-3 rounded-xl bg-emerald-500/[0.07] border border-emerald-500/[0.15] px-3 py-2.5 shrink-0">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <span className="text-xs text-slate-400">
              <span className="font-semibold text-slate-200">{rec.name || rec.ticker}</span>
              {" · "}
              <span className="text-slate-400">{rec.sector}</span>
            </span>
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <span>Price <span className="text-slate-200 font-semibold">${rec.price?.toLocaleString()}</span></span>
              <span>Score <span className="text-emerald-400 font-semibold">{rec.adj_score}</span></span>
              {opt.ann_yield != null && <span>Ann. Yield <span className="text-emerald-400 font-semibold">{opt.ann_yield}%</span></span>}
            </div>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="overflow-y-auto flex-1 px-5 py-4 space-y-3.5">
          <Field label="Strategy">
            <Select value={form.strategy} onChange={(e) => set("strategy", e.target.value)}>
              {STRATEGIES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Strike ($)" hint="Pre-filled from scan">
              <Input
                type="number" step="0.5" min="0" required
                value={form.strike} onChange={(e) => set("strike", e.target.value)}
              />
            </Field>
            <Field label="Expiry" hint="Pre-filled from scan">
              <Input
                type="date" required
                value={form.expiry} onChange={(e) => set("expiry", e.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Contracts (Qty)">
              <Input
                type="number" step="1" min="1" required
                value={form.quantity} onChange={(e) => set("quantity", e.target.value)}
              />
            </Field>
            <Field label="Order Type">
              <Select value={form.orderType} onChange={(e) => set("orderType", e.target.value)}>
                <option value="LMT">Limit</option>
                <option value="MKT">Market</option>
              </Select>
            </Field>
          </div>

          {form.orderType === "LMT" && (
            <Field label="Limit Price ($/contract)" hint="Pre-filled from mid price">
              <Input
                type="number" step="0.01" min="0" required
                value={form.limitPrice} onChange={(e) => set("limitPrice", e.target.value)}
              />
            </Field>
          )}

          <Field label="Notes (optional)">
            <Input
              type="text" placeholder="e.g. Wheel entry on IV spike"
              value={form.notes} onChange={(e) => set("notes", e.target.value)}
            />
          </Field>

          {/* Derived metrics */}
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3 grid grid-cols-3 gap-3">
            <div className="text-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Collateral</p>
              <p className="text-sm font-bold text-slate-200" style={{ fontFamily: "Epilogue, sans-serif" }}>
                {collateral > 0 ? `$${collateral.toLocaleString()}` : "—"}
              </p>
            </div>
            <div className="text-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Net Premium</p>
              <p className="text-sm font-bold text-emerald-400" style={{ fontFamily: "Epilogue, sans-serif" }}>
                {netPremium > 0 ? `$${netPremium.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : "—"}
              </p>
            </div>
            <div className="text-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Ann. Yield</p>
              <p className="text-sm font-bold text-emerald-400" style={{ fontFamily: "Epilogue, sans-serif" }}>
                {annYield ? `${annYield}%` : "—"}
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              type="button" onClick={onCancel}
              className="flex-1 rounded-xl border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-slate-400 hover:bg-white/[0.07] hover:text-slate-200 transition-all cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="flex-1 rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-500 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPending ? "Staging…" : "Stage for Review →"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
