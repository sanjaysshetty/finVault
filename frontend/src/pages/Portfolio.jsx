import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { safeNum as _safeNum } from "../utils/format.js";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { EmptyState }  from "../components/ui/EmptyState.jsx";

/* ── shared aliases ──────────────────────────────────────── */
const safeNum = _safeNum;

function round2(n) { return Number(safeNum(n, 0).toFixed(2)); }
function formatPct(n) { const x = safeNum(n, 0); return `${x > 0 ? "+" : ""}${x.toFixed(2)}%`; }

function formatMoney(n) {
  return safeNum(n, 0).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function plColorClass(v) {
  return safeNum(v, 0) >= 0 ? "text-green-400" : "text-red-400";
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

/* ── Crypto spot parsing ─────────────────────────────────── */
function extractCryptoSpots(pricesResponse) {
  const crypto = pricesResponse?.crypto;
  if (!crypto) return {};
  const out = {};
  const writeSpot = (sym, val) => {
    const s = String(sym || "").toUpperCase().trim(); if (!s || !(val > 0)) return;
    const abs = Math.abs(val);
    const fixed = abs < 0.01 ? 10 : abs < 1 ? 6 : 2;
    out[s] = Number(val.toFixed(fixed));
  };
  // Dict format (Yahoo Finance): { "BTC-USD": { symbol, price, prevClose, timestamp } }
  if (!Array.isArray(crypto) && typeof crypto === "object") {
    for (const [sym, obj] of Object.entries(crypto)) {
      if (!obj) continue;
      const price = safeNum(obj?.price, 0);
      if (price > 0) { writeSpot(sym, price); continue; }
      const bid = safeNum(obj?.bid, NaN), ask = safeNum(obj?.ask, NaN);
      if (Number.isFinite(bid) && Number.isFinite(ask)) writeSpot(sym, (bid + ask) / 2);
      else if (Number.isFinite(ask)) writeSpot(sym, ask);
      else if (Number.isFinite(bid)) writeSpot(sym, bid);
    }
    return out;
  }
  // Array fallback
  const arr = Array.isArray(crypto) ? crypto : Array.isArray(crypto?.results) ? crypto.results : [];
  for (const obj of arr) {
    const sym = obj?.symbol || obj?.instrument_id || obj?.pair || ""; if (!sym) continue;
    const price = safeNum(obj?.price, 0);
    if (price > 0) { writeSpot(sym, price); continue; }
    const bid = safeNum(obj?.bid, NaN), ask = safeNum(obj?.ask, NaN);
    if (Number.isFinite(bid) && Number.isFinite(ask)) writeSpot(sym, (bid + ask) / 2);
    else if (Number.isFinite(ask)) writeSpot(sym, ask);
    else if (Number.isFinite(bid)) writeSpot(sym, bid);
  }
  return out;
}

/* ── Domain calcs (unchanged from original) ─────────────── */

function computeBullion(transactions, spot, pricesData) {
  const state = { GOLD: { qty: 0, cost: 0, avg: 0, realized: 0 }, SILVER: { qty: 0, cost: 0, avg: 0, realized: 0 } };
  const txs = [...transactions].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

  for (const t of txs) {
    const metal = String(t.metal || "GOLD").toUpperCase();
    const type  = String(t.type  || "BUY").toUpperCase();
    if (!state[metal]) continue;
    const qty = safeNum(t.quantityOz, 0), price = safeNum(t.unitPrice, 0), fees = safeNum(t.fees, 0);
    const s = state[metal];
    if (type === "BUY") {
      s.qty += qty; s.cost += qty * price + fees; s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    } else if (type === "SELL") {
      const sq = Math.min(qty, s.qty);
      s.realized += sq * price - fees - sq * (s.avg || 0);
      s.qty  -= sq; s.cost -= sq * (s.avg || 0); s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    }
  }

  const goldSpot   = safeNum(spot.GOLD,   0), silverSpot   = safeNum(spot.SILVER, 0);
  const goldPrev   = safeNum(pricesData?.gold?.prev_close_price,   0);
  const silverPrev = safeNum(pricesData?.silver?.prev_close_price, 0);
  const hasPrev    = goldPrev > 0 || silverPrev > 0;
  const dayGL      = hasPrev
    ? round2(state.GOLD.qty * (goldPrev > 0 ? goldSpot - goldPrev : 0) + state.SILVER.qty * (silverPrev > 0 ? silverSpot - silverPrev : 0))
    : null;
  const totalCost    = round2(state.GOLD.qty * (state.GOLD.avg || 0) + state.SILVER.qty * (state.SILVER.avg || 0));
  const prevDayValue = round2((goldPrev > 0 ? state.GOLD.qty * goldPrev : 0) + (silverPrev > 0 ? state.SILVER.qty * silverPrev : 0));
  return {
    holdingValue: round2(state.GOLD.qty * goldSpot + state.SILVER.qty * silverSpot),
    unrealized:   round2((goldSpot - state.GOLD.avg) * state.GOLD.qty + (silverSpot - state.SILVER.avg) * state.SILVER.qty),
    realized:     round2(state.GOLD.realized + state.SILVER.realized),
    dayGL, totalCost, prevDayValue,
  };
}

function computeStocks(transactions, quoteMap) {
  const bySym = {};
  const txs = [...transactions].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  for (const t of txs) {
    const sym = String(t.symbol || "").toUpperCase().trim(); if (!sym) continue;
    const type = String(t.type || "BUY").toUpperCase();
    const shares = safeNum(t.shares, 0), price = safeNum(t.price, 0), fees = safeNum(t.fees, 0);
    if (!bySym[sym]) bySym[sym] = { shares: 0, cost: 0, avg: 0, realized: 0 };
    const s = bySym[sym];
    if (type === "BUY") {
      s.shares += shares; s.cost += shares * price + fees; s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    } else if (type === "SELL") {
      const ss = Math.min(shares, s.shares);
      s.realized += ss * price - fees - ss * (s.avg || 0);
      s.shares -= ss; s.cost -= ss * (s.avg || 0); s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    }
  }
  let holdingValue = 0, unrealized = 0, realized = 0, dayGL = 0, hasDayGL = false, totalCost = 0, prevDayValue = 0;
  for (const [sym, s] of Object.entries(bySym)) {
    const spot      = safeNum(quoteMap[sym]?.price,    0);
    const change    = quoteMap[sym]?.change ?? null; // Finnhub: change = price − prevClose
    const prevClose = safeNum(quoteMap[sym]?.prevClose, 0);
    holdingValue += s.shares * spot; unrealized += (spot - s.avg) * s.shares; realized += s.realized;
    totalCost += s.shares * (s.avg || 0);
    if (change != null) { dayGL += s.shares * safeNum(change, 0); hasDayGL = true; }
    if (prevClose > 0) prevDayValue += s.shares * prevClose;
  }
  return { holdingValue: round2(holdingValue), unrealized: round2(unrealized), realized: round2(realized), dayGL: hasDayGL ? round2(dayGL) : null, totalCost: round2(totalCost), prevDayValue: round2(prevDayValue) };
}

function computeCrypto(transactions, spotMap, cryptoData) {
  const bySym = {};
  const txs = [...transactions].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  for (const t of txs) {
    let sym = String(t.symbol || "").toUpperCase().trim(); if (!sym) continue;
    if (!sym.includes("-")) sym = `${sym}-USD`;
    const type = String(t.type || "BUY").toUpperCase();
    const qty = safeNum(t.quantity, 0), px = safeNum(t.unitPrice, 0), fees = safeNum(t.fees, 0);
    if (!bySym[sym]) bySym[sym] = { qty: 0, cost: 0, avg: 0, realized: 0 };
    const s = bySym[sym];
    if (type === "BUY") {
      s.qty += qty; s.cost += qty * px + fees; s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    } else if (type === "SELL") {
      const sq = Math.min(qty, s.qty);
      s.realized += sq * px - fees - sq * (s.avg || 0);
      s.qty -= sq; s.cost -= sq * (s.avg || 0); s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    }
  }
  let holdingValue = 0, unrealized = 0, realized = 0, dayGL = 0, hasDayGL = false, totalCost = 0, prevDayValue = 0;
  for (const [sym, s] of Object.entries(bySym)) {
    const spot = safeNum(spotMap?.[sym], 0);
    holdingValue += s.qty * spot; unrealized += (spot - (s.avg || 0)) * s.qty; realized += s.realized;
    totalCost += s.qty * (s.avg || 0);
    // prevClose from Yahoo Finance dict (cryptoData = pricesRes?.crypto)
    const cryptoEntry = cryptoData?.[sym] ?? cryptoData?.[sym.replace("-USD", "")];
    const prevClose = safeNum(cryptoEntry?.prevClose, 0);
    if (prevClose > 0) { dayGL += s.qty * (spot - prevClose); hasDayGL = true; prevDayValue += s.qty * prevClose; }
  }
  return { holdingValue: round2(holdingValue), unrealized: round2(unrealized), realized: round2(realized), dayGL: hasDayGL ? round2(dayGL) : null, totalCost: round2(totalCost), prevDayValue: round2(prevDayValue) };
}

function computeFixedIncome(items) {
  let holdingValue = 0, unrealized = 0, dailyAccrual = 0, totalCost = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const it of items) {
    const principal = safeNum(it.principal, 0);
    holdingValue += safeNum(it.currentValue, 0);
    unrealized   += safeNum(it.currentValue, 0) - principal;
    totalCost    += principal;
    const isActive = it.maturityDate ? today <= it.maturityDate : true;
    if (isActive) dailyAccrual += principal * safeNum(it.annualRate, 0) / 365;
  }
  return { holdingValue: round2(holdingValue), unrealized: round2(unrealized), realized: 0, dayGL: round2(dailyAccrual), totalCost: round2(totalCost), prevDayValue: round2(totalCost) };
}

function computeOtherAssets(items) {
  let holdingValue = 0;
  for (const it of items) {
    const v = Number.isFinite(Number(it?.value)) ? Number(it.value) : safeNum(it?.assetValue, 0);
    holdingValue += safeNum(v, 0);
  }
  return { holdingValue: round2(holdingValue), unrealized: 0, realized: 0 };
}

/* ── Helpers ─────────────────────────────────────────────── */
function extractItems(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

/* ── Component ───────────────────────────────────────────── */
export default function Portfolio() {
  const { data: fiRes,     isLoading: loadingFI,     isFetching: fetchingFI,     refetch: refetchFI }     = useQuery({ queryKey: queryKeys.fixedIncome(),  queryFn: () => api.get("/assets/fixedincome") });
  const { data: bullRes,   isLoading: loadingBull,   isFetching: fetchingBull,   refetch: refetchBull }   = useQuery({ queryKey: queryKeys.bullionTx(),    queryFn: () => api.get("/assets/bullion/transactions") });
  const { data: stockRes,  isLoading: loadingStock,  isFetching: fetchingStock,  refetch: refetchStock }  = useQuery({ queryKey: queryKeys.stocksTx(),     queryFn: () => api.get("/assets/stocks/transactions") });
  const { data: cryptoRes, isLoading: loadingCrypto, isFetching: fetchingCrypto, refetch: refetchCrypto } = useQuery({ queryKey: queryKeys.cryptoTx(),     queryFn: () => api.get("/assets/crypto/transactions") });
  const { data: otherRes,  isLoading: loadingOther,  isFetching: fetchingOther,  refetch: refetchOther }  = useQuery({ queryKey: queryKeys.otherAssets(),  queryFn: () => api.get("/assets/otherassets") });

  const fixedIncome = useMemo(() => extractItems(fiRes),     [fiRes]);
  const bullionTx   = useMemo(() => extractItems(bullRes),   [bullRes]);
  const stockTx     = useMemo(() => extractItems(stockRes),  [stockRes]);
  const cryptoTx    = useMemo(() => extractItems(cryptoRes), [cryptoRes]);
  const otherAssets = useMemo(() => extractItems(otherRes),  [otherRes]);

  const loading      = loadingFI  || loadingBull  || loadingStock  || loadingCrypto  || loadingOther;
  const isRefreshing = fetchingFI || fetchingBull || fetchingStock || fetchingCrypto || fetchingOther;

  const stockSymbols = useMemo(() => {
    const set = new Set(stockTx.map((t) => String(t.symbol || "").toUpperCase().trim()).filter(Boolean));
    return Array.from(set).sort();
  }, [stockTx]);

  const cryptoSymbols = useMemo(() => {
    const set = new Set(
      cryptoTx
        .map((t) => String(t.symbol || "").toUpperCase().trim())
        .filter(Boolean)
        .map((s) => (s.includes("-") ? s : `${s}-USD`))
    );
    return Array.from(set).sort();
  }, [cryptoTx]);

  // Exclude Property from Other Assets
  const otherAssetsNoProperty = useMemo(() =>
    (otherAssets || []).filter((it) => {
      const cat    = String(it?.category    || "").trim().toUpperCase();
      const catKey = String(it?.categoryKey || "").trim().toUpperCase();
      return cat !== "PROPERTY" && catKey !== "PROPERTY";
    }),
    [otherAssets]
  );

  const pricesPath = useMemo(() => {
    const p = new URLSearchParams();
    if (stockSymbols.length)  p.set("stocks", stockSymbols.join(","));
    if (cryptoSymbols.length) p.set("crypto", cryptoSymbols.join(","));
    return `/prices${p.toString() ? `?${p}` : ""}`;
  }, [stockSymbols, cryptoSymbols]);

  const { data: pricesRes, refetch: refetchPrices } = useQuery({
    queryKey: queryKeys.prices(stockSymbols, cryptoSymbols),
    queryFn:  () => api.get(pricesPath),
    enabled:  !loading,
  });

  const spot = useMemo(() => ({
    GOLD:   round2(safeNum(pricesRes?.gold?.price,   0)),
    SILVER: round2(safeNum(pricesRes?.silver?.price, 0)),
  }), [pricesRes]);

  const quotes      = useMemo(() => pricesRes?.stocks || {}, [pricesRes]);
  const cryptoSpots = useMemo(() => extractCryptoSpots(pricesRes), [pricesRes]);

  function handleRefresh() {
    refetchFI();
    refetchBull();
    refetchStock();
    refetchCrypto();
    refetchOther();
    refetchPrices();
  }

  const rollups = useMemo(() => ({
    stocks:      computeStocks(stockTx, quotes),
    crypto:      computeCrypto(cryptoTx, cryptoSpots, pricesRes?.crypto),
    bullion:     computeBullion(bullionTx, spot, pricesRes),
    fixedIncome: computeFixedIncome(fixedIncome),
    otherAssets: computeOtherAssets(otherAssetsNoProperty),
    options:     { holdingValue: 0, realized: 0, unrealized: 0, dayGL: null },
  }), [fixedIncome, bullionTx, stockTx, cryptoTx, otherAssetsNoProperty, spot, quotes, cryptoSpots, pricesRes]);

  const totals = useMemo(() => {
    const dayGLParts = [rollups.stocks.dayGL, rollups.bullion.dayGL, rollups.crypto.dayGL, rollups.fixedIncome.dayGL];
    const hasDayGL = dayGLParts.some((v) => v != null);
    const totalCost    = round2((rollups.stocks.totalCost    ?? 0) + (rollups.bullion.totalCost    ?? 0) + (rollups.crypto.totalCost    ?? 0) + (rollups.fixedIncome.totalCost    ?? 0));
    const prevDayValue = round2((rollups.stocks.prevDayValue ?? 0) + (rollups.bullion.prevDayValue ?? 0) + (rollups.crypto.prevDayValue ?? 0) + (rollups.fixedIncome.prevDayValue ?? 0));
    return {
      holdingValue: round2(
        rollups.fixedIncome.holdingValue + rollups.bullion.holdingValue +
        rollups.stocks.holdingValue      + rollups.crypto.holdingValue  +
        rollups.options.holdingValue     + rollups.otherAssets.holdingValue
      ),
      unrealized: round2(
        rollups.fixedIncome.unrealized + rollups.bullion.unrealized +
        rollups.stocks.unrealized      + rollups.crypto.unrealized  + rollups.options.unrealized
      ),
      realized: round2(
        rollups.fixedIncome.realized + rollups.bullion.realized +
        rollups.stocks.realized      + rollups.crypto.realized  + rollups.options.realized
      ),
      dayGL: hasDayGL ? round2(dayGLParts.reduce((s, v) => s + (v ?? 0), 0)) : null,
      totalCost, prevDayValue,
    };
  }, [rollups]);

  const asOfDate = todayISO();

  const rows = useMemo(() => [
    { key: "stocks",      label: "Stocks",       hint: stockSymbols.length       ? `${stockSymbols.length} symbols`              : "", ...rollups.stocks },
    { key: "crypto",      label: "Crypto",        hint: cryptoSymbols.length      ? `${cryptoSymbols.length} symbols`             : "", ...rollups.crypto },
    { key: "bullion",     label: "Bullion",       hint: bullionTx.length          ? `${bullionTx.length} tx`                      : "", ...rollups.bullion },
    { key: "fixedIncome", label: "Fixed Income",  hint: fixedIncome.length        ? `${fixedIncome.length} positions`             : "", ...rollups.fixedIncome },
    { key: "otherAssets", label: "Other Assets",  hint: otherAssetsNoProperty.length ? `${otherAssetsNoProperty.length} items`    : "", ...rollups.otherAssets },
    { key: "options",     label: "Options",        hint: "placeholder",                                                                  ...rollups.options },
  ], [rollups, stockSymbols.length, cryptoSymbols.length, bullionTx.length, fixedIncome.length, otherAssetsNoProperty.length]);

  /* ── Render ───────────────────────────────────────────── */
  return (
    <div className="space-y-5">

      {/* Page header */}
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-slate-100 tracking-tight" style={{ fontFamily: "Epilogue, sans-serif" }}>
            Portfolio
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            As of <span className="text-slate-400 font-semibold">{asOfDate}</span>
          </p>
        </div>

        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading || isRefreshing}
          className="text-xs font-bold text-slate-400 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.07] hover:text-slate-200 transition-all disabled:opacity-50 cursor-pointer"
        >
          {loading ? "Loading…" : isRefreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Loading state */}
      {loading && <EmptyState type="loading" message="Loading your portfolio…" />}

      {!loading && (
        <>
          {/* Summary metric cards */}
          {(() => {
            const unrealizedPct = totals.totalCost > 0 ? formatPct((totals.unrealized / totals.totalCost) * 100) : null;
            const dayGLPct = totals.prevDayValue > 0 && totals.dayGL != null ? formatPct((totals.dayGL / totals.prevDayValue) * 100) : null;
            return (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <MetricCard
                  label="Total Holding Value"
                  value={formatMoney(totals.holdingValue)}
                  sub="All asset types combined"
                  accent
                />
                <MetricCard
                  label="Unrealized Gain / Loss"
                  value={formatMoney(totals.unrealized)}
                  pct={unrealizedPct}
                  sub="FI accrual + mark-to-market"
                  valueClass={plColorClass(totals.unrealized)}
                />
                <MetricCard
                  label="Day's Gain / Loss"
                  value={totals.dayGL != null ? formatMoney(totals.dayGL) : "—"}
                  pct={dayGLPct}
                  sub="Stocks + Crypto + Bullion + FI"
                  valueClass={totals.dayGL != null ? plColorClass(totals.dayGL) : "text-slate-500"}
                />
              </div>
            );
          })()}

          {/* Asset breakdown table */}
          <div className="rounded-2xl border border-[rgba(59,130,246,0.12)] bg-[#0F1729] overflow-hidden">
            {/* Table header */}
            <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between gap-3">
              <div>
                <p className="text-lg font-bold text-slate-200">Include Assets</p>
              </div>
              <span className="text-xs text-slate-600">
                Updated <span className="text-slate-500 font-semibold">{asOfDate}</span>
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[540px] table-fixed">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    <th className="w-1/3 px-5 py-3 text-left text-sm font-bold uppercase tracking-wide text-slate-400">Asset Type</th>
                    <th className="w-1/3 px-5 py-3 text-right text-sm font-bold uppercase tracking-wide text-slate-400">Latest Value</th>
                    <th className="w-1/3 px-5 py-3 text-right text-sm font-bold uppercase tracking-wide text-slate-400">Unrealized</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-white/[0.04]">
                  {rows.map((r) => {
                    const showPL = r.key !== "otherAssets";
                    return (
                      <tr key={r.key} className="hover:bg-white/[0.02] transition-colors">
                        <td className="w-1/3 px-5 py-3.5">
                          <p className="font-semibold text-slate-200 text-sm">{r.label}</p>
                          {r.hint && <p className="text-xs text-slate-600 mt-0.5">{r.hint}</p>}
                        </td>
                        <td className="w-1/3 px-5 py-3.5 text-right font-bold text-slate-200 text-sm numeric">
                          {formatMoney(r.holdingValue)}
                        </td>
                        <td className={`w-1/3 px-5 py-3.5 text-right font-bold text-sm numeric ${showPL ? plColorClass(r.unrealized) : "text-slate-700"}`}>
                          {showPL ? formatMoney(r.unrealized) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>

                {/* Totals row */}
                <tfoot>
                  <tr className="border-t border-white/[0.1] bg-white/[0.02]">
                    <td className="w-1/3 px-5 py-3.5 text-sm font-black text-slate-300">Total</td>
                    <td className="w-1/3 px-5 py-3.5 text-right text-sm font-black text-slate-100 numeric">
                      {formatMoney(totals.holdingValue)}
                    </td>
                    <td className={`w-1/3 px-5 py-3.5 text-right text-sm font-black numeric ${plColorClass(totals.unrealized)}`}>
                      {formatMoney(totals.unrealized)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Crypto price warning */}
            {cryptoSymbols.length > 0 && Object.keys(cryptoSpots || {}).length === 0 && (
              <div className="px-5 py-3 border-t border-white/[0.06] text-xs text-slate-600">
                Crypto prices unavailable — market value shown as $0.00
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
