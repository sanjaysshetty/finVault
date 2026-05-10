import { useState, useEffect } from "react";
import { api } from "../../api/client.js";

const OPTION_STRATEGIES = new Set(["SELL_PUT", "BUY_PUT", "SELL_CALL", "BUY_CALL"]);
const STOCK_STRATEGIES  = new Set(["BUY_STOCK", "SELL_STOCK"]);

const STRATEGY_GROUPS = [
  {
    label: "Options",
    items: [
      { value: "SELL_PUT",  label: "Sell Put — Cash-Secured (CSP)"  },
      { value: "SELL_CALL", label: "Sell Call — Covered (CC)"        },
      { value: "BUY_CALL",  label: "Buy Call"                        },
      { value: "BUY_PUT",   label: "Buy Put — Protective"            },
    ],
  },
  {
    label: "Stocks",
    items: [
      { value: "BUY_STOCK",  label: "Buy Stock"             },
      { value: "SELL_STOCK", label: "Sell / Short Stock"    },
    ],
  },
];

function Field({ label, children, hint, hintWarn }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{label}</label>
      {children}
      {hint     && <p className="text-[11px] text-slate-600">{hint}</p>}
      {hintWarn && <p className="text-[11px] text-amber-500">{hintWarn}</p>}
    </div>
  );
}

function Input({ className: _cls, ...props }) {
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

export default function PaperStageOrderModal({ rec, onConfirm, onCancel, isPending }) {
  const opt            = rec?.option || {};
  const lockedStrategy = rec?._lockedStrategy || null;   // e.g. "SELL_CALL" when writing CC from a stock position
  const maxContracts   = rec?._maxContracts   || null;   // cap qty when derived from a stock position

  // Live price fetch
  const [livePrice,    setLivePrice]    = useState(null);
  const [priceLoading, setPriceLoading] = useState(true);

  useEffect(() => {
    if (!rec?.ticker) return;
    setPriceLoading(true);
    setLivePrice(null);
    api.get(`/paper-trade/quote/${encodeURIComponent(rec.ticker)}`)
      .then((res) => setLivePrice(res.price))
      .catch(() => {})
      .finally(() => setPriceLoading(false));
  }, [rec?.ticker]);

  const initialStrategy = lockedStrategy || "SELL_PUT";

  const [form, setForm] = useState({
    strategy:   initialStrategy,
    strike:     opt.strike ? String(opt.strike) : "",
    expiry:     opt.expiry || "",
    quantity:   "1",
    orderType:  "LMT",
    limitPrice: opt.mid    ? String(opt.mid)    : "",
    notes:      "",
  });

  const isOption = OPTION_STRATEGIES.has(form.strategy);
  const isStock  = STOCK_STRATEGIES.has(form.strategy);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  function handleStrategyChange(newStrategy) {
    const wasOption = OPTION_STRATEGIES.has(form.strategy);
    const nowOption = OPTION_STRATEGIES.has(newStrategy);
    const nowStock  = STOCK_STRATEGIES.has(newStrategy);

    setForm((f) => {
      const patch = { strategy: newStrategy };
      if (wasOption && nowStock) {
        // Option → Stock: clear option-specific fields, suggest live share price
        patch.strike     = "";
        patch.expiry     = "";
        patch.limitPrice = livePrice != null ? livePrice.toFixed(2) : "";
      } else if (!wasOption && nowOption) {
        // Stock → Option: restore scan values
        patch.strike     = opt.strike ? String(opt.strike) : "";
        patch.expiry     = opt.expiry || "";
        patch.limitPrice = opt.mid    ? String(opt.mid)    : "";
      }
      // Option↔Option or Stock↔Stock: keep existing values
      return { ...f, ...patch };
    });
  }

  // Derived metrics
  const strike     = parseFloat(form.strike)    || 0;
  const qty        = parseInt(form.quantity, 10) || 0;
  const limitPrice = parseFloat(form.limitPrice) || 0;
  const collateral = isOption ? strike * 100 * qty  : limitPrice * qty;
  const netPremium = isOption ? limitPrice * 100 * qty : null;
  const annYield   = isOption && collateral > 0 && opt.dte > 0
    ? ((netPremium / collateral) * (365 / opt.dte) * 100).toFixed(1)
    : null;

  const expiryExpired = form.expiry && new Date(form.expiry + "T23:59:59") < new Date();

  function handleSubmit(e) {
    e.preventDefault();
    onConfirm({
      ticker:     rec.ticker,
      strategy:   form.strategy,
      ...(isOption ? { strike: Number(form.strike), expiry: form.expiry } : {}),
      quantity:   Number(form.quantity),
      orderType:  form.orderType,
      limitPrice: form.orderType === "LMT" ? Number(form.limitPrice) : null,
      notes:      form.notes || null,
      scanId:     rec.scanId || null,
      source:     isStock ? "manual" : "wheel-scan",
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
              {lockedStrategy === "SELL_CALL" ? "Write Covered Call" : "Stage Order"} — {rec.ticker}
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

        {/* Stock context strip */}
        <div className="mx-5 mt-3 rounded-xl bg-emerald-500/[0.07] border border-emerald-500/[0.15] px-3 py-2.5 shrink-0">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <span className="text-xs text-slate-400">
              <span className="font-semibold text-slate-200">{rec.name || rec.ticker}</span>
              {rec.sector && <><span className="mx-1">·</span><span>{rec.sector}</span></>}
            </span>
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <span>
                Price{" "}
                {priceLoading ? (
                  <span className="text-slate-500 font-semibold">fetching…</span>
                ) : livePrice != null ? (
                  <span className="text-emerald-400 font-semibold">
                    ${livePrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    <span className="text-[10px] text-emerald-600 ml-1">live</span>
                  </span>
                ) : (
                  <span className="text-slate-200 font-semibold">
                    ${rec.price?.toLocaleString()}
                    <span className="text-[10px] text-slate-600 ml-1">scan</span>
                  </span>
                )}
              </span>
              {rec.adj_score != null && (
                <span>Score <span className="text-emerald-400 font-semibold">{rec.adj_score}</span></span>
              )}
              {opt.ann_yield != null && isOption && (
                <span>Yield <span className="text-emerald-400 font-semibold">{opt.ann_yield}%</span></span>
              )}
            </div>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="overflow-y-auto flex-1 px-5 py-4 space-y-3.5">

          {/* Strategy — read-only pill when locked (e.g. writing CC from a stock position) */}
          <Field label="Strategy">
            {lockedStrategy ? (
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200">
                  {STRATEGY_GROUPS.flatMap(g => g.items).find(i => i.value === lockedStrategy)?.label || lockedStrategy}
                </div>
                <span className="text-[10px] text-slate-500 bg-white/[0.04] border border-white/[0.06] rounded-md px-2 py-1 shrink-0">locked</span>
              </div>
            ) : (
              <Select value={form.strategy} onChange={(e) => handleStrategyChange(e.target.value)}>
                {STRATEGY_GROUPS.map((group) => (
                  <optgroup key={group.label} label={`── ${group.label} ──`}>
                    {group.items.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>

          {/* Strike + Expiry — options only */}
          {isOption && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Strike ($)" hint={lockedStrategy ? "Enter your desired strike price" : "From scan — verify with broker"}>
                <Input
                  type="number" step="0.5" min="0" required
                  value={form.strike} onChange={(e) => set("strike", e.target.value)}
                />
              </Field>
              <Field
                label="Expiry"
                hint={!expiryExpired ? "From scan" : undefined}
                hintWarn={expiryExpired ? "⚠ Date is in the past" : undefined}
              >
                <input
                  type="date" required
                  value={form.expiry}
                  onChange={(e) => set("expiry", e.target.value)}
                  className={`rounded-lg px-3 py-2 text-sm focus:outline-none w-full ${
                    expiryExpired
                      ? "bg-red-500/[0.08] border border-red-500/40 text-red-300"
                      : "bg-white/[0.04] border border-white/[0.08] text-slate-200 focus:border-blue-500/50"
                  }`}
                />
              </Field>
            </div>
          )}

          {/* Qty + Order Type */}
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={isStock ? "Shares" : "Contracts"}
              hint={maxContracts ? `Max ${maxContracts} contract${maxContracts !== 1 ? "s" : ""} based on your stock position` : undefined}
            >
              <Input
                type="number" step="1" min="1" max={maxContracts || undefined} required
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

          {/* Limit price */}
          {form.orderType === "LMT" && (
            <Field
              label={isStock ? "Limit Price ($/share)" : "Limit Price ($/contract)"}
              hint={isStock
                ? (livePrice != null ? `Live price: $${livePrice.toFixed(2)} — adjust as needed` : "Enter target price per share")
                : "Verify option mid with your broker before staging"
              }
            >
              <Input
                type="number" step="0.01" min="0.01" required
                value={form.limitPrice} onChange={(e) => set("limitPrice", e.target.value)}
              />
            </Field>
          )}

          {/* Notes */}
          <Field label="Notes (optional)">
            <Input
              type="text" placeholder="e.g. Wheel entry, IV spike play…"
              value={form.notes} onChange={(e) => set("notes", e.target.value)}
            />
          </Field>

          {/* Derived metrics */}
          <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3 grid grid-cols-3 gap-3">
            <div className="text-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">
                {isStock ? "Cost Basis" : "Collateral"}
              </p>
              <p className="text-sm font-bold text-slate-200" style={{ fontFamily: "Epilogue, sans-serif" }}>
                {collateral > 0 ? `$${collateral.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}
              </p>
            </div>
            <div className="text-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">
                {isStock ? "Shares" : "Net Premium"}
              </p>
              <p className="text-sm font-bold text-emerald-400" style={{ fontFamily: "Epilogue, sans-serif" }}>
                {isStock
                  ? (qty > 0 ? qty : "—")
                  : (netPremium > 0 ? `$${netPremium.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—")
                }
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
              type="submit" disabled={isPending}
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
