import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { safeNum } from "../utils/format.js";

/* ──────────────────────────────────────────────────────────────
   Helper: extract array from various API response shapes
   ────────────────────────────────────────────────────────────── */
function extractItems(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

/* ──────────────────────────────────────────────────────────────
   Formatting helpers (local — PricesBar-specific display)
   ────────────────────────────────────────────────────────────── */
function fmtUSD(x) {
  const n = typeof x === "string" ? Number(x) : x;
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

function fmtNumber(x) {
  if (!Number.isFinite(x)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(x);
}

function fmtPct(price, prevClose) {
  const p  = Number(price);
  const pc = Number(prevClose);
  if (!Number.isFinite(p) || !Number.isFinite(pc) || pc === 0) return "";
  const pct = ((p - pc) / pc) * 100;
  if (!Number.isFinite(pct)) return "";
  return ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
}

function priceColor(price, prevClose) {
  const p  = Number(price);
  const pc = Number(prevClose);
  if (!Number.isFinite(p) || !Number.isFinite(pc)) return "#E5E7EB";
  if (p > pc) return "#22C55E";
  if (p < pc) return "#EF4444";
  return "#E5E7EB";
}

/* ──────────────────────────────────────────────────────────────
   Crypto parsing (Robinhood bid/ask — Phase 3 will simplify)
   ────────────────────────────────────────────────────────────── */
function extractList(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.results))       return payload.results;
  if (Array.isArray(payload.best_bid_asks)) return payload.best_bid_asks;
  if (Array.isArray(payload.data))          return payload.data;
  if (Array.isArray(payload.items))         return payload.items;
  return null;
}

function findBySymbol(payload, symbol) {
  // Phase 3: crypto becomes a dict { "BTC-USD": { price, prevClose } }
  if (payload && !Array.isArray(payload) && typeof payload === "object") {
    const entry = payload[symbol] ?? payload[symbol.replace("-USD", "")];
    if (entry?.price != null) return entry;
  }
  const list = extractList(payload);
  if (!list) return null;
  return list.find((x) => String(x?.symbol || "").toUpperCase() === symbol) ?? null;
}

function pickBidAsk(row) {
  if (!row) return { bid: null, ask: null };
  // Phase 3 (Yahoo dict format): price is direct
  if (row.price != null) return { bid: row.price, ask: row.price };
  const bid = row.bid_price ?? row.best_bid_price ?? row.bid ?? row.bidPrice ?? null;
  const ask = row.ask_price ?? row.best_ask_price ?? row.ask ?? row.askPrice ?? null;
  return { bid, ask };
}

function midFromBidAsk(bid, ask) {
  const b = Number(bid);
  const a = Number(ask);
  if (!Number.isFinite(b) || !Number.isFinite(a)) return null;
  return (b + a) / 2;
}

function extractCryptoSpots(crypto) {
  const out = {};
  // Phase 3 dict format
  if (crypto && !Array.isArray(crypto) && typeof crypto === "object") {
    for (const [sym, v] of Object.entries(crypto)) {
      const price = safeNum(v?.price, 0);
      if (price > 0) out[sym.toUpperCase()] = price;
    }
    return out;
  }
  // Legacy Robinhood array format
  const list = extractList(crypto);
  if (!list) return out;
  for (const row of list) {
    const sym = String(row?.symbol || "").toUpperCase().trim();
    if (!sym) continue;
    const { bid, ask } = pickBidAsk(row);
    const mid = midFromBidAsk(bid, ask);
    const spot = Number.isFinite(mid) ? mid : safeNum(row?.price, 0);
    if (spot > 0) out[sym] = spot;
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────
   Portfolio value computation
   ────────────────────────────────────────────────────────────── */
function isPropertyOtherAsset(it) {
  const cat = String(it?.category    || "").trim().toUpperCase();
  const key = String(it?.categoryKey || "").trim().toUpperCase();
  return cat === "PROPERTY" || key === "PROPERTY";
}

function computePortfolioValue({ fiItems, bullionTx, stockTx, cryptoTx, otherItems, pricesData }) {
  if (!pricesData) return null;

  const spot = {
    GOLD:   safeNum(pricesData.gold?.price,   0),
    SILVER: safeNum(pricesData.silver?.price, 0),
  };
  const stockQuotes = pricesData.stocks     || {};
  const cryptoSpots = extractCryptoSpots(pricesData.crypto);

  // Fixed Income
  let total = 0;
  for (const it of fiItems)   total += safeNum(it.currentValue, 0);

  // Bullion
  const metalState = { GOLD: 0, SILVER: 0 };
  for (const t of [...bullionTx].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))) {
    const m = String(t.metal || "").toUpperCase();
    const qty = safeNum(t.quantityOz, 0);
    if (String(t.type || "").toUpperCase() === "BUY")  metalState[m] = (metalState[m] || 0) + qty;
    if (String(t.type || "").toUpperCase() === "SELL") metalState[m] = Math.max(0, (metalState[m] || 0) - qty);
  }
  total += metalState.GOLD * spot.GOLD + metalState.SILVER * spot.SILVER;

  // Stocks
  const stockShares = {};
  for (const t of [...stockTx].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))) {
    const sym = String(t.symbol || "").toUpperCase().trim();
    if (!sym) continue;
    const shares = safeNum(t.shares, 0);
    stockShares[sym] = (stockShares[sym] || 0) + (String(t.type || "BUY").toUpperCase() === "BUY" ? shares : -Math.min(shares, stockShares[sym] || 0));
  }
  for (const [sym, shares] of Object.entries(stockShares)) total += shares * safeNum(stockQuotes[sym]?.price, 0);

  // Crypto
  const cryptoQty = {};
  for (const t of [...cryptoTx].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))) {
    let sym = String(t.symbol || "").toUpperCase().trim();
    if (!sym) continue;
    if (!sym.includes("-")) sym = `${sym}-USD`;
    const qty = safeNum(t.quantity, 0);
    cryptoQty[sym] = (cryptoQty[sym] || 0) + (String(t.type || "BUY").toUpperCase() === "BUY" ? qty : -Math.min(qty, cryptoQty[sym] || 0));
  }
  for (const [sym, qty] of Object.entries(cryptoQty)) total += qty * safeNum(cryptoSpots[sym], 0);

  // Other Assets (exclude Property)
  for (const it of otherItems) {
    if (isPropertyOtherAsset(it)) continue;
    total += safeNum(it?.value ?? it?.assetValue, 0);
  }

  return Number.isFinite(total) ? total : null;
}

/* ──────────────────────────────────────────────────────────────
   MiniCard UI
   ────────────────────────────────────────────────────────────── */
function MiniCard({ label, value, accent, title }) {
  return (
    <div
      style={{
        minWidth: 126, height: 44, borderRadius: 12, padding: "7px 10px",
        background: "rgba(2, 6, 23, 0.35)", border: "1px solid rgba(255,255,255,0.10)",
        display: "flex", flexDirection: "column", justifyContent: "center",
        backdropFilter: "blur(6px)", flex: "0 0 auto",
      }}
      title={title || value}
    >
      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.65)", fontWeight: 800, lineHeight: 1 }}>{label}</div>
      <div style={{ marginTop: 3, fontSize: 13, fontWeight: 900, color: accent, lineHeight: 1.05, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {value}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Main component
   ────────────────────────────────────────────────────────────── */
export default function PricesBar() {
  // ── Asset queries (shared cache with Portfolio + individual pages)
  const { data: fiRes }      = useQuery({ queryKey: queryKeys.fixedIncome(),  queryFn: () => api.get("/assets/fixedincome") });
  const { data: bullRes }    = useQuery({ queryKey: queryKeys.bullionTx(),    queryFn: () => api.get("/assets/bullion/transactions") });
  const { data: stockRes }   = useQuery({ queryKey: queryKeys.stocksTx(),     queryFn: () => api.get("/assets/stocks/transactions") });
  const { data: cryptoRes }  = useQuery({ queryKey: queryKeys.cryptoTx(),     queryFn: () => api.get("/assets/crypto/transactions") });
  const { data: otherRes }   = useQuery({ queryKey: queryKeys.otherAssets(),  queryFn: () => api.get("/assets/otherassets") });

  const fiItems    = useMemo(() => extractItems(fiRes),     [fiRes]);
  const bullionTx  = useMemo(() => extractItems(bullRes),   [bullRes]);
  const stockTx    = useMemo(() => extractItems(stockRes),  [stockRes]);
  const cryptoTx   = useMemo(() => extractItems(cryptoRes), [cryptoRes]);
  const otherItems = useMemo(() => extractItems(otherRes),  [otherRes]);

  // ── Derive symbols for the /prices call
  const stockSymbols = useMemo(() => {
    const s = new Set();
    for (const t of stockTx) { const sym = String(t.symbol || "").toUpperCase().trim(); if (sym) s.add(sym); }
    return Array.from(s).slice(0, 25);
  }, [stockTx]);

  const cryptoSymbols = useMemo(() => {
    const s = new Set();
    for (const t of cryptoTx) { let sym = String(t.symbol || "").toUpperCase().trim(); if (!sym) continue; if (!sym.includes("-")) sym += "-USD"; s.add(sym); }
    return Array.from(s).slice(0, 25);
  }, [cryptoTx]);

  // ── Prices query — always fetch (metals + indices always included)
  const pricesPath = useMemo(() => {
    const p = new URLSearchParams();
    if (stockSymbols.length)  p.set("stocks", stockSymbols.join(","));
    if (cryptoSymbols.length) p.set("crypto", cryptoSymbols.join(","));
    return `/prices${p.toString() ? `?${p}` : ""}`;
  }, [stockSymbols, cryptoSymbols]);

  const { data: pricesData, isFetching: pricesLoading, refetch: refetchPrices } = useQuery({
    queryKey: queryKeys.prices(stockSymbols, cryptoSymbols),
    queryFn:  () => api.get(pricesPath),
  });

  // ── Portfolio value
  const portfolioValue = useMemo(() =>
    computePortfolioValue({ fiItems, bullionTx, stockTx, cryptoTx, otherItems, pricesData }),
    [fiItems, bullionTx, stockTx, cryptoTx, otherItems, pricesData]
  );

  // ── Display values
  const loading = pricesLoading || !pricesData;

  const spx  = pricesData?.sp500;
  const ixic = pricesData?.nasdaq;
  const gold   = pricesData?.gold;
  const silver = pricesData?.silver;

  const btcRow = findBySymbol(pricesData?.crypto, "BTC-USD");
  const ethRow = findBySymbol(pricesData?.crypto, "ETH-USD");
  const { bid: btcBid, ask: btcAsk } = pickBidAsk(btcRow);
  const { bid: ethBid, ask: ethAsk } = pickBidAsk(ethRow);
  const btcMid = midFromBidAsk(btcBid, btcAsk);
  const ethMid = midFromBidAsk(ethBid, ethAsk);

  const spxValue  = loading ? "…" : spx?.price  != null ? `${fmtNumber(spx.price)}${fmtPct(spx.price, spx.prevClose)}`   : "—";
  const ixicValue = loading ? "…" : ixic?.price != null ? `${fmtNumber(ixic.price)}${fmtPct(ixic.price, ixic.prevClose)}` : "—";
  const goldValue   = loading ? "…" : gold?.price   != null ? `${fmtUSD(gold.price)}${fmtPct(gold.price, gold.prev_close_price ?? gold.prevClose)}`     : "—";
  const silverValue = loading ? "…" : silver?.price != null ? `${fmtUSD(silver.price)}${fmtPct(silver.price, silver.prev_close_price ?? silver.prevClose)}` : "—";

  function handleRefresh() {
    refetchPrices();
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap", overflowX: "auto", overflowY: "hidden", maxWidth: "100%", minWidth: 0, paddingBottom: 2, WebkitOverflowScrolling: "touch" }}>
      <MiniCard
        label="Portfolio"
        value={!fiRes && !stockRes ? "…" : fmtUSD(portfolioValue)}
        accent="#FFFFFF"
        title="Total holding value (Fixed Income + Stocks + Crypto + Bullion + Other Assets; excluding Property)"
      />
      <MiniCard label="S&P 500" value={spxValue}    accent={priceColor(spx?.price,    spx?.prevClose)} />
      <MiniCard label="Nasdaq"  value={ixicValue}   accent={priceColor(ixic?.price,   ixic?.prevClose)} />
      <MiniCard label="Gold"    value={goldValue}   accent={priceColor(gold?.price,   gold?.prev_close_price ?? gold?.prevClose)} />
      <MiniCard label="Silver"  value={silverValue} accent={priceColor(silver?.price, silver?.prev_close_price ?? silver?.prevClose)} />
      <MiniCard label="BTC" value={loading ? "…" : btcMid != null ? `${fmtUSD(btcMid)}${fmtPct(btcMid, btcRow?.prevClose)}` : "—"} accent={priceColor(btcMid, btcRow?.prevClose)} />
      <MiniCard label="ETH" value={loading ? "…" : ethMid != null ? `${fmtUSD(ethMid)}${fmtPct(ethMid, ethRow?.prevClose)}` : "—"} accent={priceColor(ethMid, ethRow?.prevClose)} />

      <button
        onClick={handleRefresh}
        style={{ height: 44, padding: "0 10px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.14)", background: "rgba(2, 6, 23, 0.35)", color: "#FFFFFF", fontWeight: 900, cursor: "pointer", backdropFilter: "blur(6px)", flex: "0 0 auto", whiteSpace: "nowrap" }}
        title="Refresh"
      >
        Refresh
      </button>
    </div>
  );
}
