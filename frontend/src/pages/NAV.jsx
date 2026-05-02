import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { PageIcons } from "../components/ui/PageIcons.jsx";
import { PageHeader } from "../components/ui/PageHeader.jsx";
import { EmptyState } from "../components/ui/EmptyState.jsx";

/* ── utils ── */
function safeNum(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function round2(n) { return Math.round(safeNum(n, 0) * 100) / 100; }
function uid(p = "id") { return `${p}_${Math.random().toString(16).slice(2)}`; }

/* ── formatting ── */
function formatMoney(n, currency = "USD") {
  const x = safeNum(n, 0);
  const locale = currency === "INR" ? "en-IN" : "en-US";
  try {
    return x.toLocaleString(locale, { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 0 });
  } catch { return `$${Math.round(x).toLocaleString()}`; }
}

function formatCompact(n, currency = "USD") {
  const x = safeNum(n, 0);
  const abs = Math.abs(x);
  if (currency === "INR") {
    if (abs >= 1e7) return `₹${(x / 1e7).toFixed(2)}Cr`;
    if (abs >= 1e5) return `₹${(x / 1e5).toFixed(1)}L`;
    return `₹${Math.round(x).toLocaleString("en-IN")}`;
  }
  if (abs >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${Math.round(x / 1e3)}K`;
  return `$${Math.round(x).toLocaleString()}`;
}

const INR_TO_USD_FALLBACK = 84;

/* ── extractors ── */
function extractItems(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.items)) return res.items;
  return [];
}

function extractCryptoSpots(pricesRes) {
  const crypto = pricesRes?.crypto;
  if (!crypto) return {};
  const out = {};
  const writeSpot = (sym, spot) => {
    const s = String(sym || "").toUpperCase().trim();
    if (!s) return;
    const val = safeNum(spot, 0);
    if (!(val > 0)) return;
    const abs = Math.abs(val);
    const fixed = abs < 0.01 ? 10 : abs < 1 ? 6 : 2;
    out[s] = Number(val.toFixed(fixed));
  };
  const readOne = (obj, fallbackSym = "") => {
    const sym = obj?.symbol || obj?.instrument_id || obj?.pair || fallbackSym || "";
    if (!sym) return;
    if (typeof obj === "number") { writeSpot(sym, obj); return; }
    const direct = (typeof obj?.price === "number" ? obj.price : NaN) || (typeof obj?.last === "number" ? obj.last : NaN);
    if (Number.isFinite(direct) && direct > 0) { writeSpot(sym, direct); return; }
    const bid = safeNum(obj?.bid, NaN), ask = safeNum(obj?.ask, NaN);
    let spot = 0;
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) spot = (bid + ask) / 2;
    else if (Number.isFinite(ask) && ask > 0) spot = ask;
    else if (Number.isFinite(bid) && bid > 0) spot = bid;
    writeSpot(sym, spot);
  };
  const arr = Array.isArray(crypto) ? crypto : Array.isArray(crypto?.results) ? crypto.results : null;
  if (arr) { arr.forEach(o => readOne(o)); return out; }
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
  return 0;
}

/* ── holdings computation ── */
function computeBullionHolding(transactions, spot) {
  const state = { GOLD: { qty: 0, cost: 0, avg: 0 }, SILVER: { qty: 0, cost: 0, avg: 0 } };
  const txs = [...(transactions || [])].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  for (const t of txs) {
    const metal = String(t.metal || "GOLD").toUpperCase();
    const type = String(t.type || "BUY").toUpperCase();
    if (!state[metal]) continue;
    const qty = safeNum(t.quantityOz, 0), price = safeNum(t.unitPrice, 0), fees = safeNum(t.fees, 0);
    const s = state[metal];
    if (type === "BUY") { const c = qty * price + fees; s.qty += qty; s.cost += c; s.avg = s.qty > 0 ? s.cost / s.qty : 0; }
    else if (type === "SELL") { const sq = Math.min(qty, s.qty); s.qty -= sq; s.cost -= sq * (s.avg || 0); s.avg = s.qty > 0 ? s.cost / s.qty : 0; }
  }
  return round2(state.GOLD.qty * safeNum(spot?.GOLD, 0) + state.SILVER.qty * safeNum(spot?.SILVER, 0));
}

function computeStocksHolding(transactions, quoteMap) {
  const bySymbol = {};
  const txs = [...(transactions || [])].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  for (const t of txs) {
    const sym = String(t.symbol || "").toUpperCase().trim();
    if (!sym) continue;
    const type = String(t.type || "BUY").toUpperCase();
    const shares = safeNum(t.shares, 0), price = safeNum(t.price, 0), fees = safeNum(t.fees, 0);
    if (!bySymbol[sym]) bySymbol[sym] = { shares: 0, cost: 0, avg: 0 };
    const s = bySymbol[sym];
    if (type === "BUY") { s.shares += shares; s.cost += shares * price + fees; s.avg = s.shares > 0 ? s.cost / s.shares : 0; }
    else if (type === "SELL") { const ss = Math.min(shares, s.shares); s.shares -= ss; s.cost -= ss * (s.avg || 0); s.avg = s.shares > 0 ? s.cost / s.shares : 0; }
  }
  return round2(Object.entries(bySymbol).reduce((sum, [sym, s]) => sum + s.shares * safeNum(quoteMap?.[sym]?.price, 0), 0));
}

function computeCryptoHolding(transactions, spotMap) {
  const bySym = {};
  const txs = [...(transactions || [])].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  for (const t of txs) {
    let sym = String(t.symbol || "").toUpperCase().trim();
    if (!sym) continue;
    if (!sym.includes("-")) sym = `${sym}-USD`;
    const type = String(t.type || "BUY").toUpperCase();
    const qty = safeNum(t.quantity, 0), px = safeNum(t.unitPrice, 0), fees = safeNum(t.fees, 0);
    if (!bySym[sym]) bySym[sym] = { qty: 0, cost: 0, avg: 0 };
    const s = bySym[sym];
    if (type === "BUY") { s.qty += qty; s.cost += qty * px + fees; s.avg = s.qty > 0 ? s.cost / s.qty : 0; }
    else if (type === "SELL") { const sq = Math.min(qty, s.qty); s.qty -= sq; s.cost -= sq * (s.avg || 0); s.avg = s.qty > 0 ? s.cost / s.qty : 0; }
  }
  return round2(Object.entries(bySym).reduce((sum, [sym, s]) => sum + s.qty * getCryptoSpot(spotMap, sym), 0));
}

function fixedIncomeValue(it) {
  for (const v of [it?.currentValue, it?.marketValue, it?.value, it?.amount, it?.balance, it?.principal, it?.faceValue]) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/* ── country helper ── */
function pickCountry(item) {
  const c = String(item?.country || item?.region || "").trim().toUpperCase();
  if (c === "INDIA" || c === "IN") return "INDIA";
  return "USA";
}

/* ── asset sections builder ── */
function buildAssetSections({ stocksTotal, bullionTotal, cryptoTotal, fixedIncomeItems, otherAssetsItems, country }) {
  const sections = [];
  const otherForCountry = (otherAssetsItems || []).filter(it => pickCountry(it) === country);

  // Market Traded
  const optionsTotal = round2(
    otherForCountry
      .filter(it => String(it?.categoryKey || it?.category || "").trim().toUpperCase() === "OPTIONS")
      .reduce((s, it) => s + safeNum(it?.value ?? it?.assetValue, 0), 0)
  );
  const mktRows = [
    { id: "mkt_stocks", label: "Stocks", amount: stocksTotal },
    { id: "mkt_crypto", label: "Crypto", amount: cryptoTotal },
    { id: "mkt_bullion", label: "Bullion", amount: bullionTotal },
    ...(optionsTotal > 0 ? [{ id: "mkt_options", label: "Options", amount: optionsTotal }] : []),
  ].filter(r => r.amount > 0 || r.id === "mkt_stocks");
  sections.push({
    id: "sec_mkt", title: "Market Traded",
    total: round2(mktRows.reduce((s, r) => s + r.amount, 0)),
    rows: mktRows,
  });

  // Fixed Income
  const fiForCountry = (fixedIncomeItems || []).filter(it => pickCountry(it) === country);
  if (fiForCountry.length > 0) {
    const fiRows = fiForCountry.map(it => ({
      id: it.assetId || it.id || uid("fi"),
      label: String(it.description || it.name || "Fixed Income"),
      amount: fixedIncomeValue(it),
    }));
    sections.push({ id: "sec_fi", title: "Fixed Income", total: round2(fiRows.reduce((s, r) => s + r.amount, 0)), rows: fiRows });
  }

  // Other Assets
  const otherRows = otherForCountry
    .filter(it => String(it?.categoryKey || it?.category || "").trim().toUpperCase() !== "OPTIONS")
    .map(it => ({
      id: it.assetId || it.id || uid("oa"),
      label: String(it.description || it.label || "Asset"),
      amount: safeNum(it.value ?? it.assetValue, 0),
    }));
  if (otherRows.length > 0) {
    sections.push({ id: "sec_oa", title: "Other Assets", total: round2(otherRows.reduce((s, r) => s + r.amount, 0)), rows: otherRows });
  }

  return sections;
}

function sumSections(secs) { return round2(secs.reduce((s, sec) => s + sec.total, 0)); }

/* ── liabilities builder ── */
function normalizeLiabilityItem(it) {
  const c = String(it?.country || "").trim().toUpperCase();
  return {
    id: it?.liabilityId || it?.assetId || it?.id || uid("lb"),
    country: c === "INDIA" || c === "IN" ? "INDIA" : "USA",
    category: String(it?.category || "Other"),
    description: String(it?.description || ""),
    value: safeNum(it?.value, 0),
  };
}

function buildLiabSections(items, country) {
  const list = (items || []).filter(it => it.country === country);
  const map = new Map();
  for (const it of list) {
    const cat = String(it?.category || "Other").trim() || "Other";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(it);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([title, arr]) => ({
      id: `liab_${title}`,
      title,
      total: round2(arr.reduce((s, it) => s + it.value, 0)),
      rows: arr.map(it => ({ id: it.id, label: it.description || "Liability", amount: it.value })),
    }));
}

/* ── AssetsPanel ── */
function AssetsPanel({ sections, currency }) {
  const total = sumSections(sections);
  const divStyle = { borderBottom: "1px solid var(--fv-border)" };
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "var(--fv-card)", border: "1px solid var(--fv-border)" }}>
      <div className="flex items-center justify-between px-4 py-3" style={divStyle}>
        <span className="font-bold text-base" style={{ color: "var(--fv-text)" }}>Assets</span>
        <span className="font-bold text-base text-green-400">{formatMoney(total, currency)}</span>
      </div>
      {sections.map(sec => (
        <Fragment key={sec.id}>
          <div className="flex items-center justify-between px-4 py-2" style={divStyle}>
            <span className="text-xs font-bold uppercase tracking-widest text-green-400">{sec.title}</span>
            <span className="text-xs font-bold text-green-400">{formatMoney(sec.total, currency)}</span>
          </div>
          {sec.rows.map((r, i) => (
            <div key={r.id} className="flex items-center justify-between pl-8 pr-4 py-2.5"
              style={i < sec.rows.length - 1 ? divStyle : {}}>
              <span className="text-sm" style={{ color: "var(--fv-text-secondary)" }}>{r.label}</span>
              <span className="text-sm" style={{ color: "var(--fv-text-secondary)" }}>{formatMoney(r.amount, currency)}</span>
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

/* ── LiabilitiesPanel ── */
function LiabilitiesPanel({ sections, currency, total }) {
  const divStyle = { borderBottom: "1px solid var(--fv-border)" };
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "var(--fv-card)", border: "1px solid var(--fv-border)" }}>
      <div className="flex items-center justify-between px-4 py-3" style={divStyle}>
        <span className="font-bold text-base" style={{ color: "var(--fv-text)" }}>Liabilities</span>
        <span className="font-bold text-base text-red-400">{formatMoney(total, currency)}</span>
      </div>
      {sections.length === 0 ? (
        <div className="px-4 py-4 text-sm" style={{ color: "var(--fv-dim)" }}>No liabilities.</div>
      ) : sections.map(sec => (
        <Fragment key={sec.id}>
          <div className="flex items-center justify-between px-4 py-2" style={divStyle}>
            <span className="text-xs font-bold uppercase tracking-widest text-red-400">{sec.title}</span>
            <span className="text-xs font-bold text-red-400">{formatMoney(sec.total, currency)}</span>
          </div>
          {sec.rows.map((r, i) => (
            <div key={r.id} className="flex items-center justify-between pl-8 pr-4 py-2.5"
              style={i < sec.rows.length - 1 ? divStyle : {}}>
              <span className="text-sm" style={{ color: "var(--fv-text-secondary)" }}>{r.label}</span>
              <span className="text-sm" style={{ color: "var(--fv-text-secondary)" }}>{formatMoney(r.amount, currency)}</span>
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

/* ── MetricTopCard ── */
function MetricTopCard({ label, value, sub, accent = false }) {
  if (accent) {
    return (
      <div className="nav-metric-card rounded-2xl p-5 flex flex-col justify-between min-h-[110px]"
        style={{ background: "linear-gradient(135deg, #0e4d35 0%, #0e6c4a 50%, #1a9e65 100%)" }}>
        <div className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: "rgba(255,255,255,0.65)" }}>
          {label}
        </div>
        <div>
          <div className="text-3xl font-black mb-1" style={{ color: "#ffffff", fontFamily: "'Epilogue', sans-serif", letterSpacing: "-0.5px" }}>
            {value}
          </div>
          <div className="text-xs" style={{ color: "rgba(255,255,255,0.6)" }}>{sub}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="nav-metric-card rounded-2xl p-5 flex flex-col justify-between min-h-[110px]"
      style={{ background: "var(--fv-card)", border: "1px solid var(--fv-border)" }}>
      <div className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: "var(--fv-dim)" }}>
        {label}
      </div>
      <div>
        <div className="text-3xl font-black mb-1"
          style={{ color: "var(--fv-text)", fontFamily: "'Epilogue', sans-serif", letterSpacing: "-0.5px" }}>
          {value}
        </div>
        <div className="text-xs" style={{ color: "var(--fv-dim)" }}>{sub}</div>
      </div>
    </div>
  );
}

/* ── CountrySection ── */
function CountrySection({ name, netUSD, netFormatted, currency, assetSections, liabSections, liabTotal }) {
  const netPositive = netUSD >= 0;
  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
        <span className="font-bold text-base" style={{ color: "var(--fv-text)" }}>{name}</span>
        <span className="text-sm font-semibold ml-1" style={{ color: netPositive ? "var(--fv-gain, #3DD68C)" : "var(--fv-loss, #F87171)" }}>
          Net: {netFormatted}
        </span>
      </div>
      <div className="nav-country-grid grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
        <AssetsPanel sections={assetSections} currency={currency} />
        <LiabilitiesPanel sections={liabSections} currency={currency} total={liabTotal} />
      </div>
    </div>
  );
}

/* ── InsurancePrintSection (print-only) ── */
function InsuranceCountryTable({ items, currency, country }) {
  const total = items.reduce((s, it) => s + it.coveredAmount, 0);
  const fmtCovered = (n) => formatMoney(n, currency);
  const borderStyle = { borderBottom: "1px solid rgba(0,0,0,0.12)" };
  return (
    <div className="nav-ins-block" style={{ marginBottom: 14, border: "1px solid rgba(0,0,0,0.18)", borderRadius: 8, overflow: "hidden" }}>
      {/* Country header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "8px 14px", background: "#f0faf5",
        borderBottom: "1px solid rgba(0,0,0,0.12)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#1a9e65", display: "inline-block" }} />
          <span style={{ fontWeight: 700, fontSize: 14, color: "#111" }}>{country === "INDIA" ? "India" : "United States"}</span>
        </div>
        <span style={{ fontWeight: 700, fontSize: 14, color: "#16a34a" }}>
          Total Covered: {fmtCovered(total)}
        </span>
      </div>
      {/* Table — no outer border; container div owns it */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "#f8f8f8" }}>
            <th style={{ padding: "7px 12px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "#666", textTransform: "uppercase", letterSpacing: "0.06em", ...borderStyle }}>Provider</th>
            <th style={{ padding: "7px 12px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "#666", textTransform: "uppercase", letterSpacing: "0.06em", ...borderStyle }}>Type</th>
            <th style={{ padding: "7px 12px", textAlign: "right", fontSize: 11, fontWeight: 700, color: "#666", textTransform: "uppercase", letterSpacing: "0.06em", ...borderStyle }}>Covered Amount</th>
            <th style={{ padding: "7px 12px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "#666", textTransform: "uppercase", letterSpacing: "0.06em", ...borderStyle }}>Remarks</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={4} style={{ padding: "10px 12px", fontSize: 13, color: "#888", textAlign: "center" }}>No insurance records.</td>
            </tr>
          ) : items.map((it, i) => (
            <tr key={it.id} style={i < items.length - 1 ? borderStyle : {}}>
              <td style={{ padding: "8px 12px", fontSize: 13, color: "#111", fontWeight: 600 }}>{it.provider}</td>
              <td style={{ padding: "8px 12px", fontSize: 13, color: "#444" }}>{it.insuranceType}</td>
              <td style={{ padding: "8px 12px", fontSize: 13, color: "#16a34a", fontWeight: 600, textAlign: "right" }}>{fmtCovered(it.coveredAmount)}</td>
              <td style={{ padding: "8px 12px", fontSize: 13, color: "#444" }}>{it.remarks || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InsurancePrintSection({ items }) {
  const usaItems   = items.filter(it => it.country === "USA");
  const indiaItems = items.filter(it => it.country === "INDIA");
  return (
    <div className="nav-insurance-print" style={{ display: "none" }}>
      {/* Section heading */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        borderBottom: "2px solid #0e6c4a", paddingBottom: 6, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#0e6c4a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0 1 12 2.944a11.955 11.955 0 0 1-8.618 3.04A12.02 12.02 0 0 0 3 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          <span style={{ fontWeight: 900, fontSize: 17, color: "#111", fontFamily: "'Epilogue', sans-serif" }}>Insurance</span>
        </div>
        <span style={{ fontSize: 11, color: "#666" }}>Coverage summary</span>
      </div>
      {usaItems.length > 0   && <InsuranceCountryTable items={usaItems}   currency="USD" country="USA"   />}
      {indiaItems.length > 0 && <InsuranceCountryTable items={indiaItems} currency="INR" country="INDIA" />}
    </div>
  );
}

/* ── Main NAV ── */
export default function NAV() {
  const [filter, setFilter] = useState("ALL");
  const showUSA = filter === "ALL" || filter === "USA";
  const showINDIA = filter === "ALL" || filter === "INDIA";

  /* queries */
  const { data: insuranceData } = useQuery({ queryKey: queryKeys.insurance(), queryFn: () => api.get("/assets/insurance") });
  const { data: liabsData, isLoading: liabsLoading, error: liabsError } = useQuery({ queryKey: queryKeys.liabilities(), queryFn: () => api.get("/liabilities") });
  const { data: fiData, isLoading: fiLoading } = useQuery({ queryKey: queryKeys.fixedIncome(), queryFn: () => api.get("/assets/fixedincome") });
  const { data: oaData, isLoading: oaLoading } = useQuery({ queryKey: queryKeys.otherAssets(), queryFn: () => api.get("/assets/otherassets") });
  const { data: stocksData, isLoading: stocksLoading } = useQuery({ queryKey: queryKeys.stocksTx(), queryFn: () => api.get("/assets/stocks/transactions") });
  const { data: bullionData, isLoading: bullionLoading } = useQuery({ queryKey: queryKeys.bullionTx(), queryFn: () => api.get("/assets/bullion/transactions") });
  const { data: cryptoTxData, isLoading: cryptoLoading } = useQuery({ queryKey: queryKeys.cryptoTx(), queryFn: () => api.get("/assets/crypto/transactions") });

  const stockTx = useMemo(() => extractItems(stocksData), [stocksData]);
  const bullTx = useMemo(() => extractItems(bullionData), [bullionData]);
  const cryptoTx = useMemo(() => extractItems(cryptoTxData), [cryptoTxData]);

  const stockSymbols = useMemo(() =>
    Array.from(new Set(stockTx.map(t => String(t.symbol || "").toUpperCase().trim()).filter(Boolean))).sort(),
    [stockTx]
  );
  const cryptoSymbolsForQuery = useMemo(() => {
    const syms = Array.from(new Set(cryptoTx.map(t => {
      let s = String(t.symbol || "").toUpperCase().trim();
      return s && !s.includes("-") ? `${s}-USD` : s;
    }).filter(Boolean))).sort();
    return syms.slice(0, 25);
  }, [cryptoTx]);

  const txQueriesDone = !stocksLoading && !bullionLoading && !cryptoLoading;
  const { data: pricesData, isLoading: pricesLoading, error: pricesError } = useQuery({
    queryKey: queryKeys.prices(stockSymbols, cryptoSymbolsForQuery),
    queryFn: () => {
      const parts = [];
      if (stockSymbols.length) parts.push(`stocks=${encodeURIComponent(stockSymbols.join(","))}`);
      if (cryptoSymbolsForQuery.length) parts.push(`crypto=${encodeURIComponent(cryptoSymbolsForQuery.join(","))}`);
      return api.get(`/prices${parts.length ? `?${parts.join("&")}` : ""}`);
    },
    enabled: txQueriesDone,
  });

  const insuranceItems = useMemo(() => {
    const list = Array.isArray(insuranceData?.items) ? insuranceData.items : Array.isArray(insuranceData) ? insuranceData : [];
    return list.map(it => ({
      id: it.assetId || it.id,
      country: String(it?.country || "").toUpperCase() === "INDIA" ? "INDIA" : "USA",
      provider: String(it?.provider || "—"),
      insuranceType: String(it?.insuranceType || ""),
      coveredAmount: safeNum(it?.coveredAmount, 0),
      remarks: String(it?.remarks || ""),
    }));
  }, [insuranceData]);

  const liabilitiesItems = useMemo(() => extractItems(liabsData).map(normalizeLiabilityItem), [liabsData]);
  const fixedIncomeItems = useMemo(() => Array.isArray(fiData) ? fiData : fiData?.items || [], [fiData]);
  const otherAssetsItems = useMemo(() => Array.isArray(oaData) ? oaData : oaData?.items || [], [oaData]);
  const spot = useMemo(() => ({ GOLD: round2(safeNum(pricesData?.gold?.price, 0)), SILVER: round2(safeNum(pricesData?.silver?.price, 0)) }), [pricesData]);
  const quoteMap = useMemo(() => pricesData?.stocks && typeof pricesData.stocks === "object" ? pricesData.stocks : {}, [pricesData]);
  const cryptoSpots = useMemo(() => extractCryptoSpots(pricesData), [pricesData]);
  const inrToUsd = useMemo(() => {
    const rate = pricesData?.forex?.["INR=X"]?.price;
    return rate && rate > 50 ? rate : INR_TO_USD_FALLBACK;
  }, [pricesData]);

  const stocksTotal = useMemo(() => computeStocksHolding(stockTx, quoteMap), [stockTx, quoteMap]);
  const bullionTotal = useMemo(() => computeBullionHolding(bullTx, spot), [bullTx, spot]);
  const cryptoTotal = useMemo(() => computeCryptoHolding(cryptoTx, cryptoSpots), [cryptoTx, cryptoSpots]);

  const usaAssetSections = useMemo(
    () => buildAssetSections({ stocksTotal, bullionTotal, cryptoTotal, fixedIncomeItems, otherAssetsItems, country: "USA" }),
    [stocksTotal, bullionTotal, cryptoTotal, fixedIncomeItems, otherAssetsItems]
  );
  const indiaAssetSections = useMemo(
    () => buildAssetSections({ stocksTotal: 0, bullionTotal: 0, cryptoTotal: 0, fixedIncomeItems, otherAssetsItems, country: "INDIA" }),
    [fixedIncomeItems, otherAssetsItems]
  );

  const usaAssetsTotal = useMemo(() => sumSections(usaAssetSections), [usaAssetSections]);
  const indiaAssetsTotal = useMemo(() => sumSections(indiaAssetSections), [indiaAssetSections]);
  const usaLiabSections = useMemo(() => buildLiabSections(liabilitiesItems, "USA"), [liabilitiesItems]);
  const indiaLiabSections = useMemo(() => buildLiabSections(liabilitiesItems, "INDIA"), [liabilitiesItems]);
  const usaLiabsTotal = useMemo(() => round2(usaLiabSections.reduce((s, sec) => s + sec.total, 0)), [usaLiabSections]);
  const indiaLiabsTotal = useMemo(() => round2(indiaLiabSections.reduce((s, sec) => s + sec.total, 0)), [indiaLiabSections]);

  const usaNet = round2(usaAssetsTotal - usaLiabsTotal);
  const indiaNet = round2(indiaAssetsTotal - indiaLiabsTotal);
  const indiaNetUSD = round2(indiaNet / inrToUsd);
  const combinedUSD = round2(usaNet + indiaNetUSD);

  const loading = liabsLoading || fiLoading || oaLoading || stocksLoading || bullionLoading || cryptoLoading || pricesLoading;
  const fetchError = liabsError || pricesError;

  /* filter pill button */
  const FilterBtn = ({ label, value }) => {
    const active = filter === value;
    return (
      <button
        type="button"
        onClick={() => setFilter(value)}
        className="px-4 py-1.5 rounded-full text-sm font-bold transition-all cursor-pointer"
        style={active
          ? { background: "#0e6c4a", color: "#ffffff", border: "1px solid #1a9e65" }
          : { background: "transparent", color: "var(--fv-muted)", border: "1px solid var(--fv-border)" }}
      >
        {label}
      </button>
    );
  };

  const printDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  return (
    <div id="nav-print-area" className="p-4 pb-8" style={{ color: "var(--fv-text)" }}>

      {/* ── Print-only report header (hidden on screen) ── */}
      <div className="nav-print-only items-center justify-between pb-3 mb-4"
        style={{ display: "none", borderBottom: "2px solid #0e6c4a" }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 900, color: "#0e6c4a", fontFamily: "'Epilogue', sans-serif", letterSpacing: "-0.3px" }}>
            fin<span style={{ color: "#1a9e65" }}>Vault</span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>Net Asset Value Report</div>
        </div>
        <div style={{ fontSize: 11, color: "#666" }}>{printDate}</div>
      </div>

      {/* ── Page header ── */}
      <div className="mb-5">
        <PageHeader title="Net Asset Value" icon={PageIcons.nav} subtitle="Combined wealth across all jurisdictions">
          <div className="nav-no-print flex items-center gap-1.5">
            <FilterBtn label="ALL" value="ALL" />
            <FilterBtn label="USA" value="USA" />
            <FilterBtn label="INDIA" value="INDIA" />
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            className="nav-no-print fv-btn-secondary px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1.5"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 6 2 18 2 18 9" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" />
            </svg>
            Print
          </button>
        </PageHeader>
      </div>

      {/* ── 3 metric cards ── */}
      <div className="nav-metrics-grid grid grid-cols-1 sm:grid-cols-3 gap-4 mb-2">
        <MetricTopCard
          label="USA Net Worth"
          value={formatCompact(usaNet, "USD")}
          sub={`Assets ${formatMoney(usaAssetsTotal, "USD")} · Liabs ${formatMoney(usaLiabsTotal, "USD")}`}
        />
        <MetricTopCard
          label="India Net Worth"
          value={formatCompact(indiaNet, "INR")}
          sub={`≈${formatCompact(indiaNetUSD, "USD")} USD`}
        />
        <MetricTopCard
          label="Combined Net Worth"
          value={formatCompact(combinedUSD, "USD")}
          sub="Across all jurisdictions"
          accent
        />
      </div>

      {/* ── Loading / Error ── */}
      {loading && <div className="mt-6"><EmptyState type="loading" message="Calculating your net worth…" /></div>}
      {!loading && fetchError && (
        <div className="rounded-xl border border-red-500/[0.3] bg-red-500/[0.08] px-3 py-2 mt-4 text-xs" style={{ color: "var(--fv-text-secondary)" }}>
          {fetchError.message || "Failed to load"}
        </div>
      )}

      {/* ── Country sections (always rendered; screen visibility controlled by filter) ── */}
      {!loading && (
        <>
          <div className="nav-print-section nav-usa-section" style={showUSA ? {} : { display: "none" }}>
            <CountrySection
              name="United States"
              netUSD={usaNet}
              netFormatted={formatMoney(usaNet, "USD")}
              currency="USD"
              assetSections={usaAssetSections}
              liabSections={usaLiabSections}
              liabTotal={usaLiabsTotal}
            />
          </div>
          <div className="nav-print-section nav-india-section" style={showINDIA ? {} : { display: "none" }}>
            <CountrySection
              name="India"
              netUSD={indiaNet}
              netFormatted={formatCompact(indiaNet, "INR")}
              currency="INR"
              assetSections={indiaAssetSections}
              liabSections={indiaLiabSections}
              liabTotal={indiaLiabsTotal}
            />
          </div>
          <InsurancePrintSection items={insuranceItems} />
        </>
      )}
    </div>
  );
}
