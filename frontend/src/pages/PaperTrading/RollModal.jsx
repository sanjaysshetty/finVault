import { useState } from "react";
import { api } from "../../api/client.js";

function fmt$(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Field({ label, children, hint }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-slate-600">{hint}</p>}
    </div>
  );
}

function Input(props) {
  return (
    <input
      {...props}
      className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/50 w-full"
    />
  );
}

function calcClosePnl(order, closePrice) {
  if (closePrice == null || order.fillPrice == null) return null;
  const qty    = order.quantity || 1;
  const isSell = order.strategy.startsWith("SELL");
  return Math.round(((isSell ? order.fillPrice - closePrice : closePrice - order.fillPrice) * qty * 100) * 100) / 100;
}

export default function RollModal({ order, onClose, onRolled }) {
  const [step,  setStep]  = useState(1);
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState("");

  // Step 1: close the current leg
  const [closePrice, setClosePrice] = useState("");

  // Step 2: new leg
  const [newStrike,     setNewStrike]     = useState("");
  const [newExpiry,     setNewExpiry]     = useState("");
  const [newLimitPrice, setNewLimitPrice] = useState("");
  const [newQty,        setNewQty]        = useState(String(order.quantity || 1));

  const closePriceNum = parseFloat(closePrice);
  const closePnl      = !isNaN(closePriceNum) ? calcClosePnl(order, closePriceNum) : null;
  const newLimitNum   = parseFloat(newLimitPrice);
  const netCredit     = (!isNaN(closePriceNum) && !isNaN(newLimitNum))
    ? Math.round((newLimitNum - closePriceNum) * (parseInt(newQty, 10) || 1) * 100 * 100) / 100
    : null;

  function handleStep1(e) {
    e.preventDefault();
    setError("");
    if (isNaN(closePriceNum) || closePriceNum < 0) return setError("Enter a valid buy-to-close price (≥ 0)");
    setStep(2);
  }

  async function handleStep2(e) {
    e.preventDefault();
    setError("");
    const qty = parseInt(newQty, 10);
    if (!newStrike || isNaN(parseFloat(newStrike))) return setError("New strike is required");
    if (!newExpiry)                                  return setError("New expiry is required");
    if (isNaN(newLimitNum) || newLimitNum <= 0)      return setError("New limit price is required");
    if (!qty || qty < 1)                             return setError("Quantity must be at least 1");

    setBusy(true);
    try {
      // 1. Close the current leg
      await api.post(`/paper-trade/close/${order.tradeId}`, {
        orderType:   "LMT",
        closePrice:  closePriceNum,
        closeAction: "ROLL",
        notes:       `Rolled → $${newStrike} exp ${newExpiry}`,
      });

      // 2. Stage the new leg
      await api.post("/paper-trade/staged", {
        ticker:     order.ticker,
        strategy:   order.strategy,
        strike:     parseFloat(newStrike),
        expiry:     newExpiry,
        quantity:   qty,
        orderType:  "LMT",
        limitPrice: newLimitNum,
        notes:      `Rolled from $${order.strike} exp ${order.expiry}`,
        source:     "roll",
      });

      onRolled();
    } catch (err) {
      setError(err.detail?.error || err.message || "Roll failed");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-white/[0.1] bg-[#0F1729] shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-white/[0.06] shrink-0">
          <div>
            <h2 className="text-sm font-black text-slate-100" style={{ fontFamily: "Epilogue, sans-serif" }}>
              Roll Position — {order.ticker}
            </h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {order.strategy?.replace(/_/g, " ")} · {order.quantity} contract{order.quantity !== 1 ? "s" : ""} · strike {fmt$(order.strike)} · exp {order.expiry}
            </p>
          </div>
          <button type="button" onClick={onClose}
            className="text-slate-500 hover:text-slate-300 p-1 rounded-lg hover:bg-white/[0.05] cursor-pointer ml-4 shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex px-5 pt-3 pb-1 gap-2 shrink-0">
          {["Close current leg", "Open new leg"].map((label, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                step === i + 1
                  ? "bg-cyan-500 text-black"
                  : step > i + 1
                    ? "bg-emerald-600 text-white"
                    : "bg-white/[0.08] text-slate-500"
              }`}>{step > i + 1 ? "✓" : i + 1}</span>
              <span className={`text-[11px] font-semibold ${step === i + 1 ? "text-slate-200" : "text-slate-600"}`}>{label}</span>
              {i === 0 && <span className="text-slate-700 mx-1">→</span>}
            </div>
          ))}
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4">

          {/* Step 1 */}
          {step === 1 && (
            <form onSubmit={handleStep1} className="space-y-4">
              <Field label="Buy-to-Close Price ($/contract)"
                hint={`Current fill was ${fmt$(order.fillPrice)} — enter what you'd pay to close now`}>
                <Input
                  type="number" step="0.01" min="0" required autoFocus
                  value={closePrice} onChange={(e) => setClosePrice(e.target.value)}
                  placeholder="e.g. 0.50"
                />
              </Field>

              {closePnl != null && (
                <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">P&L on close leg</p>
                  <p className={`text-lg font-black ${closePnl >= 0 ? "text-emerald-400" : "text-red-400"}`}
                    style={{ fontFamily: "Epilogue, sans-serif" }}>
                    {closePnl >= 0 ? "+" : "−"}{fmt$(Math.abs(closePnl))}
                  </p>
                </div>
              )}

              {error && <p className="text-xs text-red-400 bg-red-500/[0.08] border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}

              <div className="flex gap-2 pt-1">
                <button type="button" onClick={onClose}
                  className="flex-1 rounded-xl border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-slate-400 hover:bg-white/[0.07] hover:text-slate-200 transition-all cursor-pointer">
                  Cancel
                </button>
                <button type="submit"
                  className="flex-1 rounded-xl bg-cyan-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-600 transition-all cursor-pointer">
                  Next →
                </button>
              </div>
            </form>
          )}

          {/* Step 2 */}
          {step === 2 && (
            <form onSubmit={handleStep2} className="space-y-3.5">
              <div className="grid grid-cols-2 gap-3">
                <Field label="New Strike ($)">
                  <Input
                    type="number" step="0.5" min="0" required autoFocus
                    value={newStrike} onChange={(e) => setNewStrike(e.target.value)}
                  />
                </Field>
                <Field label="New Expiry">
                  <input
                    type="date" required
                    value={newExpiry} onChange={(e) => setNewExpiry(e.target.value)}
                    className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50 w-full"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Contracts">
                  <Input
                    type="number" step="1" min="1" required
                    value={newQty} onChange={(e) => setNewQty(e.target.value)}
                  />
                </Field>
                <Field label="New Limit Price ($/contract)"
                  hint="Premium to collect / pay">
                  <Input
                    type="number" step="0.01" min="0.01" required
                    value={newLimitPrice} onChange={(e) => setNewLimitPrice(e.target.value)}
                    placeholder="e.g. 1.20"
                  />
                </Field>
              </div>

              {netCredit != null && (
                <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3 grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Close leg P&L</p>
                    <p className={`text-sm font-bold ${closePnl != null && closePnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {closePnl != null ? `${closePnl >= 0 ? "+" : "−"}${fmt$(Math.abs(closePnl))}` : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">Net Credit (roll)</p>
                    <p className={`text-sm font-bold ${netCredit >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {netCredit >= 0 ? "+" : "−"}{fmt$(Math.abs(netCredit))}
                    </p>
                  </div>
                </div>
              )}

              {error && <p className="text-xs text-red-400 bg-red-500/[0.08] border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}

              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => { setStep(1); setError(""); }}
                  className="px-4 py-2.5 rounded-xl border border-white/[0.1] bg-white/[0.04] text-sm font-semibold text-slate-400 hover:bg-white/[0.07] hover:text-slate-200 transition-all cursor-pointer">
                  ← Back
                </button>
                <button type="submit" disabled={busy}
                  className="flex-1 rounded-xl bg-cyan-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-cyan-600 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
                  {busy ? "Rolling…" : "Close & Stage New Leg →"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
