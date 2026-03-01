import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { MetricCard } from "../components/ui/MetricCard.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";

/* ---------------- utils ---------------- */

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function round2(n) { return Math.round(safeNum(n, 0) * 100) / 100; }
function uid(prefix = "id") { return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`; }

/* ---------------- formatting ---------------- */

function formatMoney(n, currency = "USD") {
  const x = safeNum(n, 0);
  try {
    return x.toLocaleString(undefined, {
      style: "currency", currency,
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  } catch { return `$${x.toFixed(2)}`; }
}

/* ---------------- domain: extractors ---------------- */

function extractItems(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.items)) return res.items;
  return [];
}

function extractCryptoSpots(pricesRes) {
  const crypto = pricesRes?.crypto;
  if (!crypto) return {};
  const arr = Array.isArray(crypto)
    ? crypto
    : Array.isArray(crypto?.results)
    ? crypto.results
    : Array.isArray(crypto?.data)
    ? crypto.data
    : null;
  const out = {};
  const writeSpot = (sym, spot) => {
    const s = String(sym || "").toUpperCase().trim();
    if (!s) return;
    const val = safeNum(spot, 0);
    if (!(val > 0)) return;
    const abs = Math.abs(val);
    const fixed = abs > 0 && abs < 0.01 ? 10 : abs > 0 && abs < 1 ? 6 : 2;
    out[s] = Number(val.toFixed(fixed));
  };
  const readOne = (obj, fallbackSym = "") => {
    const sym = obj?.symbol || obj?.instrument_id || obj?.pair || fallbackSym || "";
    if (!sym) return;
    if (typeof obj === "number") { writeSpot(sym, obj); return; }
    const direct =
      (typeof obj?.price === "number" ? obj.price : NaN) ||
      (typeof obj?.last === "number" ? obj.last : NaN) ||
      (typeof obj?.mid === "number" ? obj.mid : NaN);
    if (Number.isFinite(direct) && direct > 0) { writeSpot(sym, direct); return; }
    const bid = safeNum(obj?.bid, NaN);
    const ask = safeNum(obj?.ask, NaN);
    const bid2 = safeNum(obj?.bid_inclusive_of_sell_spread, NaN);
    const ask2 = safeNum(obj?.ask_inclusive_of_buy_spread, NaN);
    const b = Number.isFinite(bid) ? bid : Number.isFinite(bid2) ? bid2 : NaN;
    const a = Number.isFinite(ask) ? ask : Number.isFinite(ask2) ? ask2 : NaN;
    let spot = 0;
    if (Number.isFinite(b) && Number.isFinite(a) && b > 0 && a > 0) spot = (b + a) / 2;
    else if (Number.isFinite(a) && a > 0) spot = a;
    else if (Number.isFinite(b) && b > 0) spot = b;
    writeSpot(sym, spot);
  };
  if (arr) { arr.forEach((obj) => readOne(obj)); return out; }
  if (typeof crypto === "object") {
    Object.entries(crypto).forEach(([sym, obj]) => {
      if (obj == null) return;
      if (typeof obj === "number") { writeSpot(sym, obj); return; }
      readOne(obj, sym);
    });
  }
  return out;
}

function getCryptoSpot(spotMap, sym) {
  if (!spotMap || !sym) return 0;
  const key = String(sym).toUpperCase().trim();
  const direct = safeNum(spotMap[key], NaN);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const noUsd = key.replace(/-USD$/i, "");
  const v1 = safeNum(spotMap[noUsd], NaN);
  if (Number.isFinite(v1) && v1 > 0) return v1;
  const withDash = noUsd.includes("-") ? noUsd : `${noUsd}-USD`;
  const v2 = safeNum(spotMap[withDash], NaN);
  if (Number.isFinite(v2) && v2 > 0) return v2;
  const noDash = key.replace(/-/g, "");
  const v3 = safeNum(spotMap[noDash], NaN);
  if (Number.isFinite(v3) && v3 > 0) return v3;
  return 0;
}

function computeBullionHolding(transactions, spot) {
  const state = { GOLD: { qty: 0, cost: 0, avg: 0 }, SILVER: { qty: 0, cost: 0, avg: 0 } };
  const txs = [...(transactions || [])].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  for (const t of txs) {
    const metal = String(t.metal || "GOLD").toUpperCase();
    const type = String(t.type || "BUY").toUpperCase();
    if (!state[metal]) continue;
    const qty = safeNum(t.quantityOz, 0);
    const price = safeNum(t.unitPrice, 0);
    const fees = safeNum(t.fees, 0);
    const s = state[metal];
    if (type === "BUY") {
      const addCost = qty * price + fees;
      s.qty += qty; s.cost += addCost; s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    } else if (type === "SELL") {
      const sellQty = Math.min(qty, s.qty);
      const basis = sellQty * (s.avg || 0);
      s.qty -= sellQty; s.cost -= basis; s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    }
  }
  const goldSpot = safeNum(spot?.GOLD, 0);
  const silverSpot = safeNum(spot?.SILVER, 0);
  return round2(state.GOLD.qty * goldSpot + state.SILVER.qty * silverSpot);
}

function computeStocksHolding(transactions, quoteMap) {
  const bySymbol = {};
  const txs = [...(transactions || [])].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  for (const t of txs) {
    const symbol = String(t.symbol || "").toUpperCase().trim();
    if (!symbol) continue;
    const type = String(t.type || "BUY").toUpperCase();
    const shares = safeNum(t.shares, 0);
    const price = safeNum(t.price, 0);
    const fees = safeNum(t.fees, 0);
    if (!bySymbol[symbol]) bySymbol[symbol] = { shares: 0, cost: 0, avg: 0 };
    const s = bySymbol[symbol];
    if (type === "BUY") {
      const addCost = shares * price + fees;
      s.shares += shares; s.cost += addCost; s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    } else if (type === "SELL") {
      const sellShares = Math.min(shares, s.shares);
      const basis = sellShares * (s.avg || 0);
      s.shares -= sellShares; s.cost -= basis; s.avg = s.shares > 0 ? s.cost / s.shares : 0;
    }
  }
  let holdingValue = 0;
  for (const [sym, s] of Object.entries(bySymbol)) {
    const spot = safeNum(quoteMap?.[sym]?.price, 0);
    holdingValue += s.shares * spot;
  }
  return round2(holdingValue);
}

function computeCryptoHolding(transactions, spotMap) {
  const bySym = {};
  const txs = [...(transactions || [])].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  for (const t of txs) {
    let sym = String(t.symbol || "").toUpperCase().trim();
    if (!sym) continue;
    if (!sym.includes("-")) sym = `${sym}-USD`;
    const type = String(t.type || "BUY").toUpperCase();
    const qty = safeNum(t.quantity, 0);
    const px = safeNum(t.unitPrice, 0);
    const fees = safeNum(t.fees, 0);
    if (!bySym[sym]) bySym[sym] = { qty: 0, cost: 0, avg: 0 };
    const s = bySym[sym];
    if (type === "BUY") {
      const addCost = qty * px + fees;
      s.qty += qty; s.cost += addCost; s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    } else if (type === "SELL") {
      const sellQty = Math.min(qty, s.qty);
      const basis = sellQty * (s.avg || 0);
      s.qty -= sellQty; s.cost -= basis; s.avg = s.qty > 0 ? s.cost / s.qty : 0;
    }
  }
  let holdingValue = 0;
  for (const [sym, s] of Object.entries(bySym)) {
    const spot = getCryptoSpot(spotMap, sym);
    holdingValue += s.qty * spot;
  }
  return round2(holdingValue);
}

function fixedIncomeValue(it) {
  const candidates = [it?.currentValue, it?.marketValue, it?.value, it?.amount, it?.balance, it?.principal, it?.faceValue];
  for (const v of candidates) { const n = Number(v); if (Number.isFinite(n)) return n; }
  return 0;
}

/* ---------------- Liabilities ---------------- */

function normalizeLiabilityItem(it) {
  const c = String(it?.country || "").trim().toUpperCase();
  const country = c === "INDIA" || c === "IN" ? "INDIA" : "USA";
  return {
    id: it?.liabilityId || it?.assetId || it?.id || uid("lb"),
    country,
    category: String(it?.category || "Other"),
    description: String(it?.description || ""),
    value: safeNum(it?.value, 0),
    remarks: String(it?.remarks || ""),
  };
}

function buildLiabilitiesSections(items, country) {
  const list = (items || []).filter((it) => pickCountry(it) === country);
  const map = new Map();
  for (const it of list) {
    const cat = String(it?.category || "Other").trim() || "Other";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(it);
  }
  return Array.from(map.entries())
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([title, arr]) => ({
      title,
      rows: arr.map((it) => ({
        id: it.id,
        label: it.description || "Liability",
        amount: safeNum(it.value, 0),
        remarks: it.remarks || "",
      })),
    }));
}

/* ---------------- Assets builder ---------------- */

const OTHER_SECTION_ORDER = [
  { key: "ROBO", title: "Robo Investment Account" },
  { key: "EDUCATION", title: "Education" },
  { key: "RETIREMENT", title: "Retirement" },
  { key: "PROPERTY", title: "Property" },
];

function pickCountry(item) {
  const c = String(item?.country || item?.region || "").trim().toUpperCase();
  if (c === "USA" || c === "US") return "USA";
  if (c === "INDIA" || c === "IN") return "INDIA";
  return "USA";
}

function buildAssetsRows({ stocksTotal, bullionTotal, cryptoTotal, fixedIncomeItems, otherAssetsItems, country }) {
  const rows = [];
  rows.push({ kind: "section", id: "sec_mkt", label: "Market Traded Assets" });
  rows.push({ kind: "row", id: "mkt_stocks", label: "Stocks", amount: stocksTotal, remarks: "" });
  rows.push({ kind: "row", id: "mkt_bullion", label: "Bullion", amount: bullionTotal, remarks: "" });
  rows.push({ kind: "row", id: "mkt_crypto", label: "Crypto", amount: cryptoTotal, remarks: "" });

  const otherForCountry = (otherAssetsItems || []).filter((it) => pickCountry(it) === country);
  const optionsItems = otherForCountry.filter((it) => {
    const assetType = String(it?.assetType || it?.assettype || it?.type || "OTHER_ASSET").trim().toUpperCase();
    const catKey = String(it?.categoryKey || it?.category || it?.category_name || "").trim().toUpperCase();
    return assetType === "OTHER_ASSET" && catKey === "OPTIONS";
  });
  const optionsTotal = round2(optionsItems.reduce((s, it) => s + safeNum(it?.value ?? it?.assetValue, 0), 0));
  rows.push({ kind: "row", id: "mkt_options", label: "Options", amount: optionsTotal, remarks: "" });

  const byCat = new Map();
  for (const it of otherForCountry) {
    const key = String(it?.categoryKey || it?.category || "").trim().toUpperCase();
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(it);
  }
  for (const sec of OTHER_SECTION_ORDER) {
    rows.push({ kind: "section", id: `sec_${sec.key}`, label: sec.title });
    const items = byCat.get(sec.key) || [];
    for (const it of items) {
      rows.push({
        kind: "row",
        id: it.assetId || it.id || uid("oa"),
        label: String(it.description || it.label || "Other Asset"),
        amount: safeNum(it.value ?? it.assetValue, 0),
        remarks: "",
      });
    }
  }
  const cashItems = byCat.get("CASH") || [];
  for (const it of cashItems) {
    rows.push({
      kind: "row",
      id: it.assetId || it.id || uid("cash"),
      label: String(it.description || it.label || "Cash"),
      amount: safeNum(it.value ?? it.assetValue, 0),
      remarks: "",
    });
  }
  rows.push({ kind: "section", id: "sec_fixed", label: "Fixed Income" });
  const fiForCountry = (fixedIncomeItems || []).filter((it) => pickCountry(it) === country);
  for (const it of fiForCountry) {
    rows.push({
      kind: "row",
      id: it.assetId || it.id || uid("fi"),
      label: String(it.description || it.label || it.name || "Fixed Income"),
      amount: fixedIncomeValue(it),
      remarks: String(it.remarks || ""),
    });
  }
  return rows;
}

function sumAssetRows(rows) {
  return round2((rows || []).filter((r) => r.kind === "row").reduce((s, r) => s + safeNum(r.amount, 0), 0));
}

/* ---------------- AssetsCard ---------------- */

function AssetsCard({ rows, currency }) {
  const sections = [];
  let current = null;
  for (const r of rows || []) {
    if (r.kind === "section") {
      if (current) sections.push(current);
      current = { title: r.label, rows: [] };
    } else {
      if (!current) current = { title: "Assets", rows: [] };
      current.rows.push(r);
    }
  }
  if (current) sections.push(current);
  const totalAssets = round2((rows || []).filter((r) => r.kind === "row").reduce((s, r) => s + safeNum(r.amount, 0), 0));

  return (
    <div className="rounded-2xl border border-green-500/[0.45] bg-[#0F1729] p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-black text-slate-100 text-base">Assets</span>
        <div className="flex-1" />
        <span className="font-black text-slate-100 text-base">{formatMoney(totalAssets, currency)}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <colgroup>
            <col style={{ width: "44%" }} />
            <col style={{ width: "26%" }} />
            <col style={{ width: "30%" }} />
          </colgroup>
          <tbody>
            {sections.map((sec) => {
              const secTotal = round2(sec.rows.reduce((s, r) => s + safeNum(r.amount, 0), 0));
              return (
                <Fragment key={sec.title}>
                  <tr>
                    <td colSpan={3} className="p-0 border-b border-green-500/[0.28]">
                      <div className="flex items-center gap-2 px-3 py-2 bg-green-500/[0.18] border border-green-500/[0.45] rounded-none font-black text-sm text-green-200">
                        <span className="flex-1">{sec.title}</span>
                        <span className="text-right whitespace-nowrap">{formatMoney(secTotal, currency)}</span>
                      </div>
                    </td>
                  </tr>
                  {sec.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2 text-sm text-slate-300 border-b border-green-500/[0.28] align-top">{r.label}</td>
                      <td className="px-3 py-2 text-sm text-slate-300 border-b border-green-500/[0.28] text-right whitespace-nowrap align-top">{formatMoney(r.amount, currency)}</td>
                      <td className="px-3 py-2 text-sm text-slate-300 border-b border-green-500/[0.28] align-top">{r.remarks || ""}</td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- LiabilitiesCard ---------------- */

function LiabilitiesCard({ items, currency, country }) {
  const sections = buildLiabilitiesSections(items, country);
  const totalLiabs = round2(
    (items || []).filter((it) => pickCountry(it) === country).reduce((s, it) => s + safeNum(it.value, 0), 0)
  );

  return (
    <div className="rounded-2xl border border-red-500/[0.38] bg-[#0F1729] p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-black text-slate-100 text-base">Liabilities</span>
        <div className="flex-1" />
        <span className="font-black text-slate-100 text-base">{formatMoney(totalLiabs, currency)}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <colgroup>
            <col style={{ width: "44%" }} />
            <col style={{ width: "26%" }} />
            <col style={{ width: "30%" }} />
          </colgroup>
          <tbody>
            {sections.length ? sections.map((sec) => {
              const secTotal = round2(sec.rows.reduce((s, r) => s + safeNum(r.amount, 0), 0));
              return (
                <Fragment key={sec.title}>
                  <tr>
                    <td colSpan={3} className="p-0 border-b border-red-500/[0.22]">
                      <div className="flex items-center gap-2 px-3 py-2 bg-red-500/[0.14] border border-red-500/[0.38] rounded-none font-black text-sm text-red-200">
                        <span className="flex-1">{sec.title}</span>
                        <span className="text-right whitespace-nowrap">{formatMoney(secTotal, currency)}</span>
                      </div>
                    </td>
                  </tr>
                  {sec.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2 text-sm text-slate-300 border-b border-red-500/[0.22] align-top">{r.label}</td>
                      <td className="px-3 py-2 text-sm text-slate-300 border-b border-red-500/[0.22] text-right whitespace-nowrap align-top">{formatMoney(r.amount, currency)}</td>
                      <td className="px-3 py-2 text-sm text-slate-300 border-b border-red-500/[0.22] align-top">{r.remarks || ""}</td>
                    </tr>
                  ))}
                </Fragment>
              );
            }) : (
              <tr>
                <td colSpan={3} className="px-3 py-3 text-xs text-slate-600">No liabilities found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Main NAV ---------------- */

export default function NAV() {
  const [filter, setFilter] = useState("ALL");

  const showUSA = filter === "ALL" || filter === "USA";
  const showINDIA = filter === "ALL" || filter === "INDIA";

  /* ---------- 6 parallel data queries ---------- */

  const { data: liabsData, isLoading: liabsLoading, error: liabsError } = useQuery({
    queryKey: queryKeys.liabilities(),
    queryFn: () => api.get("/liabilities"),
  });

  const { data: fiData, isLoading: fiLoading } = useQuery({
    queryKey: queryKeys.fixedIncome(),
    queryFn: () => api.get("/assets/fixedincome"),
  });

  const { data: oaData, isLoading: oaLoading } = useQuery({
    queryKey: queryKeys.otherAssets(),
    queryFn: () => api.get("/assets/otherassets"),
  });

  const { data: stocksData, isLoading: stocksLoading } = useQuery({
    queryKey: queryKeys.stocksTx(),
    queryFn: () => api.get("/assets/stocks/transactions"),
  });

  const { data: bullionData, isLoading: bullionLoading } = useQuery({
    queryKey: queryKeys.bullionTx(),
    queryFn: () => api.get("/assets/bullion/transactions"),
  });

  const { data: cryptoTxData, isLoading: cryptoLoading } = useQuery({
    queryKey: queryKeys.cryptoTx(),
    queryFn: () => api.get("/assets/crypto/transactions"),
  });

  /* ---------- Derived tx lists ---------- */

  const stockTx = useMemo(() => extractItems(stocksData), [stocksData]);
  const bullTx = useMemo(() => extractItems(bullionData), [bullionData]);
  const cryptoTx = useMemo(() => extractItems(cryptoTxData), [cryptoTxData]);

  const stockSymbols = useMemo(
    () =>
      Array.from(
        new Set(stockTx.map((t) => String(t.symbol || "").toUpperCase().trim()).filter(Boolean))
      ).sort(),
    [stockTx]
  );

  const cryptoSymbolsForQuery = useMemo(() => {
    const syms = Array.from(
      new Set(
        cryptoTx
          .map((t) => String(t.symbol || "").toUpperCase().trim())
          .filter(Boolean)
          .map((s) => (s.includes("-") ? s : `${s}-USD`))
      )
    ).sort();
    return syms.slice(0, 25);
  }, [cryptoTx]);

  /* ---------- Prices query (depends on tx data) ---------- */

  const txQueriesDone = !stocksLoading && !bullionLoading && !cryptoLoading;

  const { data: pricesData, isLoading: pricesLoading, error: pricesError } = useQuery({
    queryKey: queryKeys.prices(stockSymbols, cryptoSymbolsForQuery),
    queryFn: () => {
      const parts = [];
      if (stockSymbols.length) parts.push(`stocks=${encodeURIComponent(stockSymbols.join(","))}`);
      if (cryptoSymbolsForQuery.length) parts.push(`crypto=${encodeURIComponent(cryptoSymbolsForQuery.join(","))}`);
      const qs = parts.length ? `?${parts.join("&")}` : "";
      return api.get(`/prices${qs}`);
    },
    enabled: txQueriesDone,
  });

  /* ---------- Derived asset data ---------- */

  const liabilitiesItems = useMemo(
    () => extractItems(liabsData).map(normalizeLiabilityItem),
    [liabsData]
  );

  const fixedIncomeItems = useMemo(
    () => (Array.isArray(fiData) ? fiData : fiData?.items || []),
    [fiData]
  );

  const otherAssetsItems = useMemo(
    () => (Array.isArray(oaData) ? oaData : oaData?.items || []),
    [oaData]
  );

  const spot = useMemo(
    () => ({
      GOLD: round2(safeNum(pricesData?.gold?.price, 0)),
      SILVER: round2(safeNum(pricesData?.silver?.price, 0)),
    }),
    [pricesData]
  );

  const quoteMap = useMemo(
    () =>
      pricesData?.stocks && typeof pricesData.stocks === "object" ? pricesData.stocks : {},
    [pricesData]
  );

  const cryptoSpots = useMemo(() => extractCryptoSpots(pricesData), [pricesData]);

  const stocksTotal = useMemo(() => computeStocksHolding(stockTx, quoteMap), [stockTx, quoteMap]);
  const bullionTotal = useMemo(() => computeBullionHolding(bullTx, spot), [bullTx, spot]);
  const cryptoTotal = useMemo(() => computeCryptoHolding(cryptoTx, cryptoSpots), [cryptoTx, cryptoSpots]);

  /* ---------- Asset / liability summaries ---------- */

  const usaAssetsRows = useMemo(
    () => buildAssetsRows({ stocksTotal, bullionTotal, cryptoTotal, fixedIncomeItems, otherAssetsItems, country: "USA" }),
    [stocksTotal, bullionTotal, cryptoTotal, fixedIncomeItems, otherAssetsItems]
  );
  const indiaAssetsRows = useMemo(
    () => buildAssetsRows({ stocksTotal: 0, bullionTotal: 0, cryptoTotal: 0, fixedIncomeItems, otherAssetsItems, country: "INDIA" }),
    [fixedIncomeItems, otherAssetsItems]
  );

  const usaAssetsTotal = useMemo(() => sumAssetRows(usaAssetsRows), [usaAssetsRows]);
  const indiaAssetsTotal = useMemo(() => sumAssetRows(indiaAssetsRows), [indiaAssetsRows]);
  const usaLiabsTotal = useMemo(
    () => round2(liabilitiesItems.filter((it) => pickCountry(it) === "USA").reduce((s, it) => s + safeNum(it.value, 0), 0)),
    [liabilitiesItems]
  );
  const indiaLiabsTotal = useMemo(
    () => round2(liabilitiesItems.filter((it) => pickCountry(it) === "INDIA").reduce((s, it) => s + safeNum(it.value, 0), 0)),
    [liabilitiesItems]
  );
  const usaNet = round2(usaAssetsTotal - usaLiabsTotal);
  const indiaNet = round2(indiaAssetsTotal - indiaLiabsTotal);

  const loading = liabsLoading || fiLoading || oaLoading || stocksLoading || bullionLoading || cryptoLoading || pricesLoading;
  const fetchError = liabsError || pricesError;

  function Region({ currency, assetsRows, country, liabilitiesItems: liabItems }) {
    return (
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
        <AssetsCard rows={assetsRows} currency={currency} />
        <LiabilitiesCard items={liabItems} currency={currency} country={country} />
      </div>
    );
  }

  return (
    <div className="p-4 text-slate-300">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-2xl font-black text-slate-100 tracking-tight">Net Asset Value</h1>
        <div className="flex-1" />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="bg-[#080D1A] border border-white/[0.08] rounded-xl px-3 py-2 text-slate-200 text-sm outline-none focus:border-blue-500/[0.4] transition-colors"
        >
          <option value="ALL">All</option>
          <option value="USA">USA</option>
          <option value="INDIA">India</option>
        </select>
      </div>

      {loading && <EmptyState type="loading" message="Calculating your net worth…" />}

      {!loading && fetchError && (
        <div className="rounded-xl border border-red-500/[0.3] bg-red-500/[0.08] px-3 py-2 mb-4 text-xs text-slate-300">
          {fetchError.message || "Failed to load"}
        </div>
      )}

      {!loading && showUSA && (
        <>
          <MetricCard
            label="Total USA Networth"
            value={formatMoney(usaNet, "USD")}
            sub={`Assets ${formatMoney(usaAssetsTotal, "USD")} • Liabilities ${formatMoney(usaLiabsTotal, "USD")}`}
            valueClass={usaNet >= 0 ? "text-green-400" : "text-red-400"}
            accent
          />
          <Region currency="USD" assetsRows={usaAssetsRows} country="USA" liabilitiesItems={liabilitiesItems} />
        </>
      )}

      {!loading && showINDIA && (
        <div className="mt-6">
          <MetricCard
            label="Total India Networth"
            value={formatMoney(indiaNet, "USD")}
            sub={`Assets ${formatMoney(indiaAssetsTotal, "USD")} • Liabilities ${formatMoney(indiaLiabsTotal, "USD")}`}
            valueClass={indiaNet >= 0 ? "text-green-400" : "text-red-400"}
            accent
          />
          <Region currency="USD" assetsRows={indiaAssetsRows} country="INDIA" liabilitiesItems={liabilitiesItems} />
        </div>
      )}
    </div>
  );
}
